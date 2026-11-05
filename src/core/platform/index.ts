// The OS boundary. Everything that touches processes or ports goes through this
// module; scripts/check-boundary.mjs fails CI if OS commands appear elsewhere.
import { spawn } from 'node:child_process';
import * as win from './win.js';
import * as posix from './posix.js';
import type { PlatformImpl, ProcessRecord } from './types.js';

export type { ProcessRecord } from './types.js';

export const isWindows = process.platform === 'win32';
const impl: PlatformImpl = isWindows ? win : posix;

export const { spawnShell, signalTree, killTree, listProcesses, findListeningPids, SHELL_IMAGES } = impl;

/** EPERM means the PID exists but belongs to someone else. */
export function pidAlive(pid: number | undefined | null): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err.code === 'EPERM';
  }
}

/** All PIDs in the tree rooted at rootPid (inclusive). Pure. */
export function collectTree(rootPid: number, snapshot: Map<number, ProcessRecord>): number[] {
  const children = new Map<number, number[]>();
  for (const proc of snapshot.values()) {
    if (!children.has(proc.ppid)) children.set(proc.ppid, []);
    children.get(proc.ppid)!.push(proc.pid);
  }
  const tree: number[] = [];
  const seen = new Set<number>();
  const queue = [rootPid];
  while (queue.length > 0) {
    const pid = queue.shift()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    if (!snapshot.has(pid)) continue;
    tree.push(pid);
    for (const child of children.get(pid) || []) queue.push(child);
  }
  return tree;
}

/**
 * The first non-shell image in the tree — what to show as "the process"
 * (node.exe, python, java, docker...) and what adoption matches on.
 */
export function mainImage(rootPid: number, snapshot: Map<number, ProcessRecord>): ProcessRecord | undefined {
  for (const pid of collectTree(rootPid, snapshot)) {
    const rec = snapshot.get(pid)!;
    if (!SHELL_IMAGES.has(rec.name.toLowerCase())) return rec;
  }
  return snapshot.get(rootPid);
}

/** Open a URL in the user's default browser. Best effort. */
export function openUrl(url: string) {
  const { cmd, args } = isWindows
    ? { cmd: 'cmd.exe', args: ['/d', '/s', '/c', `start "" "${url}"`] }
    : process.platform === 'darwin'
      ? { cmd: 'open', args: [url] }
      : { cmd: 'xdg-open', args: [url] };
  try {
    spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: isWindows }).unref();
    return true;
  } catch {
    return false;
  }
}

/** Run a one-shot shell command to completion (used for stop.command). */
export function runShell(command: string, cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number) {
  return new Promise<{ code: number | null; output: string }>((resolve) => {
    const child = impl.spawnShell(command, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const onData = (b: Buffer) => {
      if (output.length < 64_000) output += b.toString();
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    const timer = setTimeout(() => child.pid && impl.killTree(child.pid), timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: null, output: output + String(e) });
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}
