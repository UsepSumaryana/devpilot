// POSIX (macOS / Linux) implementation of the platform interface (ported from jsrunner).
// Trees are killed through their process group, so every spawn is detached.
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { ProcessRecord, SpawnOptions } from './types.js';

export const SHELL_IMAGES = new Set(['sh', 'bash', 'zsh', 'dash', 'fish']);

const isLinux = process.platform === 'linux';
const CLK_TCK = 100;

export function spawnShell(command: string, { cwd, env, stdio }: SpawnOptions) {
  return spawn(command, { cwd, env, stdio, shell: true, detached: true });
}

function signalGroup(pid: number, sig: NodeJS.Signals) {
  try {
    process.kill(-pid, sig);
  } catch {
    try {
      process.kill(pid, sig);
    } catch {
      /* already gone */
    }
  }
}

export function signalTree(pid: number) {
  signalGroup(pid, 'SIGTERM');
}

export function killTree(pid: number) {
  signalGroup(pid, 'SIGKILL');
}

/** `MM:SS`, `MM:SS.cc`, `HH:MM:SS`, `DD-HH:MM:SS` -> ms. */
export function parseCpuTime(value: string): number {
  if (!value) return 0;
  const dash = value.indexOf('-');
  const days = dash === -1 ? 0 : Number(value.slice(0, dash));
  const rest = dash === -1 ? value : value.slice(dash + 1);
  let seconds = 0;
  for (const part of rest.split(':')) {
    const n = Number(part);
    if (!Number.isFinite(n)) return 0;
    seconds = seconds * 60 + n;
  }
  if (!Number.isFinite(days)) return 0;
  return (seconds + days * 86400) * 1000;
}

export function parsePsOutput(stdout: string, { withCommandLine = false } = {}): Map<number, ProcessRecord> {
  const map = new Map<number, ProcessRecord>();
  for (const line of stdout.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    const tail = m[5].trim();
    if (!tail) continue;
    const name = path.basename(withCommandLine ? tail.split(/\s+/)[0] : tail);
    map.set(Number(m[1]), {
      pid: Number(m[1]),
      ppid: Number(m[2]),
      name,
      cpuMs: parseCpuTime(m[4]),
      mem: Number(m[3]) * 1024,
      cmd: withCommandLine ? tail : '',
    });
  }
  return map;
}

/** One /proc/<pid>/stat line. comm may contain ')' so fields start at the LAST ')'. */
export function parseProcStat(raw: string, pageSize: number): ProcessRecord | null {
  const open = raw.indexOf('(');
  const close = raw.lastIndexOf(')');
  if (open === -1 || close === -1 || close < open) return null;
  const pid = Number(raw.slice(0, open).trim());
  if (!Number.isInteger(pid)) return null;
  const name = raw.slice(open + 1, close);
  const f = raw.slice(close + 2).trim().split(/\s+/);
  if (f.length < 22) return null;
  const utime = Number(f[11]);
  const stime = Number(f[12]);
  const rss = Number(f[21]);
  return {
    pid,
    ppid: Number(f[1]) || 0,
    name,
    cpuMs: ((utime || 0) + (stime || 0)) * (1000 / CLK_TCK),
    mem: (rss || 0) * pageSize,
    cmd: '',
  };
}

let pageSizePromise: Promise<number> | null = null;
function getPageSize() {
  pageSizePromise ||= new Promise((resolve) => {
    execFile('getconf', ['PAGESIZE'], { timeout: 3000 }, (err, stdout) => {
      const n = parseInt(String(stdout).trim(), 10);
      resolve(err || !Number.isInteger(n) || n <= 0 ? 4096 : n);
    });
  });
  return pageSizePromise;
}

async function listProcessesProc(withCommandLine: boolean) {
  const pageSize = await getPageSize();
  let entries: string[];
  try {
    entries = await fs.promises.readdir('/proc');
  } catch {
    return null;
  }
  const map = new Map<number, ProcessRecord>();
  await Promise.all(
    entries
      .filter((n) => /^\d+$/.test(n))
      .map(async (pid) => {
        try {
          const proc = parseProcStat(await fs.promises.readFile(`/proc/${pid}/stat`, 'utf-8'), pageSize);
          if (!proc) return;
          if (withCommandLine) {
            try {
              const argv = (await fs.promises.readFile(`/proc/${pid}/cmdline`, 'utf-8')).replace(/\0+$/, '').split('\0');
              proc.cmd = argv.join(' ');
              // /proc comm is the thread name ("MainThread" on Node 24); argv[0] is the image.
              if (argv[0]) proc.name = path.basename(argv[0]);
            } catch {
              /* kernel thread or exited */
            }
          }
          map.set(proc.pid, proc);
        } catch {
          /* exited between readdir and read */
        }
      }),
  );
  return map;
}

function listProcessesPs(withCommandLine: boolean, timeout: number): Promise<Map<number, ProcessRecord>> {
  const format = `pid=,ppid=,rss=,time=,${withCommandLine ? 'args=' : 'comm='}`;
  return new Promise((resolve) => {
    execFile('ps', ['axo', format], { timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) =>
      resolve(err || !stdout ? new Map() : parsePsOutput(stdout, { withCommandLine })),
    );
  });
}

export async function listProcesses({ withCommandLine = false, timeout = 10_000 } = {}) {
  if (isLinux) {
    const fromProc = await listProcessesProc(withCommandLine);
    if (fromProc && fromProc.size > 0) return fromProc;
  }
  return listProcessesPs(withCommandLine, timeout);
}

export function parseSs(stdout: string): Map<number, number> {
  const map = new Map<number, number>();
  for (const line of stdout.split('\n')) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 4) continue;
    const addr = fields[3].match(/:(\d+)$/);
    if (!addr) continue;
    const pid = line.match(/pid=(\d+)/);
    if (!pid) continue;
    const port = Number(addr[1]);
    if (!map.has(port)) map.set(port, Number(pid[1]));
  }
  return map;
}

export function parseLsof(stdout: string): Map<number, number> {
  const map = new Map<number, number>();
  for (const line of stdout.split('\n')) {
    const m = line.match(/^\S+\s+(\d+)\s+.*\s\S*?:(\d+)\s+\(LISTEN\)/);
    if (!m) continue;
    const port = Number(m[2]);
    if (!map.has(port)) map.set(port, Number(m[1]));
  }
  return map;
}

function run(cmd: string, args: string[], timeout: number): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (_err, stdout) => resolve(stdout || null));
  });
}

const PORT_PROBES = [
  { cmd: 'ss', args: ['-tlnp'], parse: parseSs },
  { cmd: 'lsof', args: ['-nP', '-iTCP', '-sTCP:LISTEN'], parse: parseLsof },
];

export async function findListeningPids({ timeout = 8000 } = {}) {
  const probes = isLinux ? PORT_PROBES : [...PORT_PROBES].reverse();
  for (const { cmd, args, parse } of probes) {
    const stdout = await run(cmd, args, timeout);
    if (!stdout) continue;
    const map = parse(stdout);
    if (map.size > 0) return map;
  }
  return new Map<number, number>();
}
