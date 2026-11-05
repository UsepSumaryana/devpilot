// Incidents: crashes, failed starts, health failures, memory alarms, port
// conflicts and error bursts in the logs. Each one carries enough context
// (exit code, surrounding log lines) for a human or Claude to start triage.
import fs from 'node:fs';
import crypto from 'node:crypto';
import type { Incident, IncidentKind, LogLine } from '../shared/types.js';
import { ensureDir, paths } from './paths.js';
import path from 'node:path';
import { stripAnsi } from './logs.js';

const MAX = 1000;

/** Lines that start an error block, across the runtimes we run. */
export const DEFAULT_ERROR_PATTERNS: RegExp[] = [
  /\b(Uncaught|Unhandled)\w*\b/i,
  /^\s*(\w+\.)*\w*(Error|Exception)\b[:\s]/, // TypeError: / java.lang.IllegalStateException:
  /^Traceback \(most recent call last\)/,
  /^panic: /,
  /^fatal error: /,
  /\bEADDRINUSE\b|\bECONNREFUSED\b|\bERR_MODULE_NOT_FOUND\b|Cannot find module/,
  /^\s*\[?(ERROR|FATAL|CRITICAL)\]?[\s:]/,
  /\blevel[=":]+\s*"?(error|fatal)\b/i,
  /APPLICATION FAILED TO START/,
];

/** Continuation lines of a stack trace belong to the same block. */
const CONTINUATION = /^\s+(at |File "|\.\.\. \d+ more|Caused by)|^\s{2,}\S|^goroutine \d+|^Caused by:/;

/** The line that names the error (not the source line a runtime echoes above it). */
const HEADLINE = /^\s*(Uncaught )?(\w+\.)*\w*(Error|Exception)\b:|^panic: |^fatal error: |^\s*\[?(ERROR|FATAL|CRITICAL)\]?[\s:]|APPLICATION FAILED TO START|\bEADDRINUSE\b.*:|Cannot find module/;

/**
 * Drop logger prefixes (timestamps, PIDs, levels) so the title reads like the
 * error itself: "[Nest] 17012 - 05/11/2026 ERROR [Redis] Error: x" -> "[Redis] Error: x".
 */
export function cleanTitle(line: string): string {
  const m = line.match(/(\[[\w.-]+\]\s*)?(\w+\.)*\w*(Error|Exception)\b:.*$/);
  if (m && m.index! > 0) return m[0].trim();
  return line.replace(/^\s*\[?\d{4}-\d{2}-\d{2}[T ][\d:.,]+Z?\]?\s*/, '').trim();
}

/** Same problem, different PID / port / timestamp: fold into one incident. */
export const foldKey = (title: string) => title.replace(/\d+/g, '#').replace(/\s+/g, ' ').toLowerCase();

export function pickHeadline(lines: string[]): string | undefined {
  const clean = lines.map((l) => stripAnsi(l).replace(/^! /, '').trim()).filter(Boolean);
  return clean.find((l) => HEADLINE.test(l)) || clean.find((l) => isErrorLine(l) && !/^\s*at |^\s*\^|^Node\.js v/.test(l));
}

export function isErrorLine(text: string, extra: RegExp[] = []): boolean {
  const t = stripAnsi(text);
  return [...DEFAULT_ERROR_PATTERNS, ...extra].some((re) => re.test(t));
}

export class IncidentStore {
  private list: Incident[] = [];
  private listeners = new Set<(i: Incident) => void>();

  constructor(private file = paths.incidents) {
    try {
      const rows = fs.readFileSync(this.file, 'utf8').trim().split('\n').slice(-MAX);
      for (const r of rows) {
        try {
          this.list.push(JSON.parse(r));
        } catch {
          /* skip */
        }
      }
    } catch {
      /* none yet */
    }
  }

  onIncident(fn: (i: Incident) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  add(input: Omit<Incident, 'id' | 'at' | 'count' | 'workspace' | 'service'> & { at?: number }): Incident {
    const [workspace, service] = input.key.split('/');
    // Fold a repeat of the same open problem into the existing incident.
    const fk = foldKey(input.title);
    const open = this.list.find((i) => !i.resolvedAt && i.key === input.key && i.kind === input.kind && foldKey(i.title) === fk && Date.now() - i.at < 30 * 60_000);
    if (open) {
      open.count++;
      open.context = input.context.length ? input.context : open.context;
      open.exitCode = input.exitCode ?? open.exitCode;
      open.restart = input.restart ?? open.restart;
      this.rewrite();
      for (const fn of this.listeners) fn(open);
      return open;
    }
    const inc: Incident = { id: crypto.randomBytes(5).toString('hex'), at: Date.now(), count: 1, workspace, service, ...input };
    this.list.push(inc);
    if (this.list.length > MAX) this.list.splice(0, this.list.length - MAX);
    try {
      ensureDir(path.dirname(this.file));
      fs.appendFileSync(this.file, JSON.stringify(inc) + '\n');
    } catch {
      /* best effort */
    }
    for (const fn of this.listeners) fn(inc);
    return inc;
  }

  /** Mark the open incidents of a service (optionally of some kinds) resolved. */
  resolve(key: string, kinds?: IncidentKind[]) {
    let changed = false;
    for (const i of this.list) {
      if (i.key === key && !i.resolvedAt && (!kinds || kinds.includes(i.kind))) {
        i.resolvedAt = Date.now();
        changed = true;
      }
    }
    if (changed) this.rewrite();
  }

  /** Resolve every open incident of a workspace (or of all workspaces). Returns how many. */
  resolveAll(workspace?: string): number {
    let n = 0;
    for (const i of this.list) {
      if (!i.resolvedAt && (!workspace || i.workspace === workspace)) {
        i.resolvedAt = Date.now();
        n++;
      }
    }
    if (n) this.rewrite();
    return n;
  }

  private rewrite() {
    try {
      fs.writeFileSync(this.file, this.list.map((i) => JSON.stringify(i)).join('\n') + '\n');
    } catch {
      /* best effort */
    }
  }

  query(f: { workspace?: string; key?: string; since?: number; open?: boolean; limit?: number } = {}): Incident[] {
    return this.list
      .filter((i) => (!f.workspace || i.workspace === f.workspace) && (!f.key || i.key === f.key) && (!f.since || i.at >= f.since) && (!f.open || !i.resolvedAt))
      .sort((a, b) => b.at - a.at)
      .slice(0, f.limit ?? 50);
  }

  openCount(key: string) {
    return this.list.filter((i) => i.key === key && !i.resolvedAt).length;
  }

  get(id: string) {
    return this.list.find((i) => i.id === id);
  }
}

/**
 * Watches a service's log stream and turns error blocks into incidents:
 * the matching line plus its stack-trace continuation, with a few lines of
 * lead-in. Rate-limited so a log storm becomes one incident with a count.
 */
export class ErrorDetector {
  private pending = new Map<string, { lines: string[]; title: string; timer: NodeJS.Timeout; lead: string[] }>();
  private lastFired = new Map<string, number>();
  private recent = new Map<string, string[]>();

  constructor(
    private emit: (key: string, title: string, context: string[]) => void,
    private patternsFor: (key: string) => RegExp[] = () => [],
  ) {}

  feed(key: string, lines: LogLine[]) {
    for (const l of lines) {
      if (l.stream === 'sys') continue;
      const text = stripAnsi(l.text);
      const p = this.pending.get(key);
      if (p) {
        // A crash prints its whole report at once: everything within the
        // 400ms window (or that looks like a stack frame) belongs to the block.
        if (p.lines.length < 40) p.lines.push(text);
      } else if (isErrorLine(text, this.patternsFor(key))) {
        const lead = (this.recent.get(key) || []).slice(-5);
        const timer = setTimeout(() => this.fire(key), 400);
        this.pending.set(key, { lines: [text], title: text.trim().slice(0, 160), timer, lead });
      }
      const r = this.recent.get(key) || [];
      r.push(text);
      if (r.length > 10) r.shift();
      this.recent.set(key, r);
    }
  }

  private fire(key: string) {
    const p = this.pending.get(key);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(key);
    const now = Date.now();
    // One new incident per service per 15s; the store folds identical titles anyway.
    if (now - (this.lastFired.get(key) || 0) < 15_000) return;
    this.lastFired.set(key, now);
    this.emit(key, cleanTitle(pickHeadline(p.lines) || p.title).slice(0, 160), [...p.lead, ...p.lines]);
  }
}
