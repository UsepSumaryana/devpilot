// Client for the daemon, used by the CLI and the plugin hooks.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { paths } from '../core/paths.js';

export interface DaemonInfo {
  pid: number;
  port: number;
  token: string;
  startedAt: number;
  version: string;
}

export function readDaemonInfo(): DaemonInfo | null {
  try {
    return JSON.parse(fs.readFileSync(paths.daemonInfo, 'utf8'));
  } catch {
    return null;
  }
}

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public body?: any,
  ) {
    super(message);
  }
}

async function ping(info: DaemonInfo, timeoutMs = 800): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${info.port}/api/ping`, { signal: AbortSignal.timeout(timeoutMs) });
    return r.ok;
  } catch {
    return false;
  }
}

/** The daemon if it answers, else null. Never starts one. */
export async function findDaemon(): Promise<DaemonInfo | null> {
  const info = readDaemonInfo();
  return info && (await ping(info)) ? info : null;
}

/** dist/daemon.js next to this bundle (every entry point is bundled into the same dist/). */
export function daemonScript(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, 'daemon.js');
}

/** Start the daemon detached if it is not running; resolves once it answers. */
export async function ensureDaemon({ quiet = true } = {}): Promise<DaemonInfo> {
  const running = await findDaemon();
  if (running) return running;
  const script = daemonScript();
  if (!fs.existsSync(script)) throw new Error(`daemon bundle not found at ${script} — run npm run build`);
  fs.mkdirSync(paths.home, { recursive: true });
  const out = fs.openSync(paths.daemonLog, 'a');
  const child = spawn(process.execPath, [script], { detached: true, stdio: ['ignore', out, out], windowsHide: true, env: process.env });
  child.unref();
  if (!quiet) process.stderr.write('Starting devpilot daemon…\n');
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 150));
    const info = readDaemonInfo();
    if (info && info.pid === child.pid && (await ping(info))) return info;
  }
  throw new Error(`daemon did not start within 10s — see ${paths.daemonLog}`);
}

export class Client {
  constructor(private info: DaemonInfo) {}

  get baseUrl() {
    return `http://127.0.0.1:${this.info.port}`;
  }

  async req<T = any>(method: string, url: string, body?: unknown, timeoutMs = 180_000): Promise<T> {
    const r = await fetch(this.baseUrl + url, {
      method,
      headers: { authorization: `Bearer ${this.info.token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await r.text();
    let data: any = text;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      /* plain text */
    }
    if (!r.ok) throw new ApiError(data?.error || `HTTP ${r.status}`, r.status, data);
    return data as T;
  }

  get = <T = any>(url: string) => this.req<T>('GET', url);
  post = <T = any>(url: string, body: unknown = {}, timeoutMs?: number) => this.req<T>('POST', url, body, timeoutMs);
  del = <T = any>(url: string) => this.req<T>('DELETE', url);

  /** Server-sent events as an async iterator of { event, data }. */
  async *events(query = ''): AsyncGenerator<{ event: string; data: any }> {
    const r = await fetch(`${this.baseUrl}/api/events${query}`, { headers: { authorization: `Bearer ${this.info.token}`, accept: 'text/event-stream' } });
    if (!r.ok || !r.body) throw new ApiError(`events: HTTP ${r.status}`, r.status);
    const decoder = new TextDecoder();
    let buf = '';
    for await (const chunk of r.body as any as AsyncIterable<Uint8Array>) {
      buf += decoder.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) !== -1) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        let event = 'message';
        const data: string[] = [];
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
        }
        if (!data.length) continue;
        try {
          yield { event, data: JSON.parse(data.join('\n')) };
        } catch {
          /* skip malformed */
        }
      }
    }
  }
}

export async function connect(opts: { start?: boolean } = { start: true }): Promise<Client> {
  const info = opts.start === false ? await findDaemon() : await ensureDaemon();
  if (!info) throw new ApiError('devpilot daemon is not running (start it with `devpilot daemon start`)', 503);
  return new Client(info);
}
