// Per-service log store: in-memory ring buffer for fast queries, plus an
// append-only file under ~/.devpilot/logs/<workspace>/<service>.log with rotation.
import fs from 'node:fs';
import path from 'node:path';
import type { LogLine } from '../shared/types.js';
import { ensureDir, paths } from './paths.js';

const RING = 5000;
const ROTATE_BYTES = 5 * 1024 * 1024;
const HYDRATE_BYTES = 256 * 1024;

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g;
export const stripAnsi = (s: string) => s.replace(ANSI, '');

export interface LogQuery {
  tail?: number;
  after?: number; // seq
  since?: number; // epoch ms
  grep?: string; // regex, case-insensitive, matched on ANSI-stripped text
  stream?: 'out' | 'err' | 'sys';
  ansi?: boolean; // keep colour codes (dashboard); default strips
}

interface Buffer_ {
  lines: LogLine[];
  seq: number;
  partial: { out: string; err: string };
  file: string;
  hydrated: boolean;
}

export class LogStore {
  private buffers = new Map<string, Buffer_>();
  private listeners = new Set<(key: string, lines: LogLine[]) => void>();

  onLines(fn: (key: string, lines: LogLine[]) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private buf(key: string): Buffer_ {
    let b = this.buffers.get(key);
    if (!b) {
      const [ws, svc] = key.split('/');
      b = { lines: [], seq: 0, partial: { out: '', err: '' }, file: path.join(paths.logsDir(ws), `${svc}.log`), hydrated: false };
      this.buffers.set(key, b);
      this.hydrate(b);
    }
    return b;
  }

  /** After a daemon restart, recover recent history from disk. */
  private hydrate(b: Buffer_) {
    b.hydrated = true;
    try {
      const st = fs.statSync(b.file);
      const start = Math.max(0, st.size - HYDRATE_BYTES);
      const fd = fs.openSync(b.file, 'r');
      const chunk = Buffer.alloc(st.size - start);
      fs.readSync(fd, chunk, 0, chunk.length, start);
      fs.closeSync(fd);
      const rows = chunk.toString('utf8').split('\n');
      if (start > 0) rows.shift();
      for (const row of rows) {
        const m = row.match(/^(\d{13}) (out|err|sys) (.*)$/);
        if (!m) continue;
        b.lines.push({ seq: ++b.seq, t: Number(m[1]), stream: m[2] as LogLine['stream'], text: m[3] });
      }
      if (b.lines.length > RING) b.lines.splice(0, b.lines.length - RING);
    } catch {
      /* no history */
    }
  }

  /** Feed raw output; splits into lines, keeps a trailing partial line. */
  write(key: string, stream: 'out' | 'err', chunk: string) {
    const b = this.buf(key);
    const text = b.partial[stream] + chunk.replace(/\r\n/g, '\n');
    const parts = text.split('\n');
    b.partial[stream] = parts.pop() || '';
    // Progress bars rewrite with \r: keep only the final state of each line.
    const lines = parts.map((p) => p.split('\r').filter(Boolean).pop() || '');
    if (b.partial[stream].length > 8192) {
      lines.push(b.partial[stream]);
      b.partial[stream] = '';
    }
    this.append(key, stream, lines);
  }

  flush(key: string) {
    const b = this.buffers.get(key);
    if (!b) return;
    for (const s of ['out', 'err'] as const) {
      if (b.partial[s]) {
        this.append(key, s, [b.partial[s]]);
        b.partial[s] = '';
      }
    }
  }

  system(key: string, text: string) {
    this.append(key, 'sys', [text]);
  }

  private append(key: string, stream: LogLine['stream'], texts: string[]) {
    if (!texts.length) return;
    const b = this.buf(key);
    const now = Date.now();
    const out: LogLine[] = texts.map((text) => ({ seq: ++b.seq, t: now, stream, text }));
    b.lines.push(...out);
    if (b.lines.length > RING) b.lines.splice(0, b.lines.length - RING);
    this.persist(b, out);
    for (const fn of this.listeners) fn(key, out);
  }

  private persist(b: Buffer_, lines: LogLine[]) {
    try {
      ensureDir(path.dirname(b.file));
      try {
        if (fs.statSync(b.file).size > ROTATE_BYTES) fs.renameSync(b.file, b.file + '.1');
      } catch {
        /* new file */
      }
      fs.appendFileSync(b.file, lines.map((l) => `${l.t} ${l.stream} ${stripAnsi(l.text)}\n`).join(''));
    } catch {
      /* disk trouble must never take the service down */
    }
  }

  query(key: string, q: LogQuery = {}): { lines: LogLine[]; lastSeq: number } {
    const b = this.buf(key);
    let re: RegExp | undefined;
    if (q.grep) {
      try {
        re = new RegExp(q.grep, 'i');
      } catch {
        re = new RegExp(q.grep.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      }
    }
    let lines = b.lines.filter(
      (l) =>
        (q.after === undefined || l.seq > q.after) &&
        (q.since === undefined || l.t >= q.since) &&
        (!q.stream || l.stream === q.stream) &&
        (!re || re.test(stripAnsi(l.text))),
    );
    if (q.tail !== undefined) lines = lines.slice(-q.tail);
    if (!q.ansi) lines = lines.map((l) => ({ ...l, text: stripAnsi(l.text) }));
    return { lines, lastSeq: b.seq };
  }

  recent(key: string, n: number): string[] {
    return this.query(key, { tail: n }).lines.map((l) => (l.stream === 'err' ? `! ${l.text}` : l.text));
  }

  clear(key: string) {
    const b = this.buf(key);
    b.lines = [];
    try {
      fs.truncateSync(b.file, 0);
    } catch {
      /* none */
    }
  }
}
