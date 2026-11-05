// Windows implementation of the platform interface (ported from jsrunner).
// The process table comes from a single PowerShell/CIM call per sample.
import { spawn, execFile, spawnSync } from 'node:child_process';
import type { ProcessRecord, SpawnOptions } from './types.js';

const FIELDS = [
  'p=$_.ProcessId',
  'pp=$_.ParentProcessId',
  'n=$_.Name',
  't=[int64]($_.KernelModeTime + $_.UserModeTime)',
  'w=[int64]$_.WorkingSetSize',
];

export const SHELL_IMAGES = new Set(['cmd.exe', 'conhost.exe']);

/**
 * Spawn through cmd.exe: npm/yarn/pnpm are .cmd shims spawn() cannot resolve.
 * windowsVerbatimArguments + one outer quote pair (stripped by /s) keeps quoted
 * commands intact — without it Node escapes inner quotes MSVCRT-style and
 * cmd.exe reads them literally.
 */
export function spawnShell(command: string, { cwd, env, stdio }: SpawnOptions) {
  return spawn('cmd.exe', ['/d', '/s', '/c', `"${command}"`], {
    cwd,
    env,
    stdio,
    windowsHide: true,
    windowsVerbatimArguments: true,
    // Not detached: DETACHED_PROCESS leaves console programs without std
    // handles, so their output would never reach the capture files. Services
    // survive a daemon restart anyway, because they write to files, not pipes.
  });
}

function taskkill(pid: number, force: boolean) {
  const args = ['/pid', String(pid), '/T'];
  if (force) args.push('/F');
  spawnSync('taskkill', args, { windowsHide: true, stdio: 'ignore', timeout: 10_000 });
}

/**
 * Console programs ignore a non-forced taskkill (there is no window to send
 * WM_CLOSE to), so this mostly helps windowed children. Services that need a
 * clean shutdown (docker compose) declare a stop.command instead.
 */
export function signalTree(pid: number) {
  taskkill(pid, false);
}

export function killTree(pid: number) {
  taskkill(pid, true);
}

function buildScript(withCommandLine: boolean) {
  const fields = withCommandLine ? [...FIELDS, 'c=$_.CommandLine'] : FIELDS;
  return (
    '@(Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ ' +
    fields.join('; ') +
    ' } }) | ConvertTo-Json -Compress'
  );
}

/** Parse the CIM JSON payload. Exported for tests. */
export function parseProcessJson(stdout: string): Map<number, ProcessRecord> {
  const map = new Map<number, ProcessRecord>();
  let rows: any;
  try {
    rows = JSON.parse(stdout);
  } catch {
    return map;
  }
  if (!Array.isArray(rows)) rows = [rows];
  for (const r of rows) {
    if (typeof r?.p !== 'number') continue;
    map.set(r.p, {
      pid: r.p,
      ppid: typeof r.pp === 'number' ? r.pp : 0,
      name: r.n || '',
      cpuMs: (Number(r.t) || 0) / 10_000, // CIM reports 100ns units
      mem: Number(r.w) || 0,
      cmd: r.c || '',
    });
  }
  return map;
}

export function listProcesses({ withCommandLine = false, timeout = 10_000 } = {}): Promise<Map<number, ProcessRecord>> {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', buildScript(withCommandLine)],
      { timeout, windowsHide: true, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout) => resolve(err || !stdout ? new Map() : parseProcessJson(stdout)),
    );
  });
}

/** Parse `netstat -ano` output into port -> pid. Exported for tests. */
export function parseNetstat(stdout: string): Map<number, number> {
  const map = new Map<number, number>();
  for (const line of stdout.split('\n')) {
    const m = line.match(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i);
    if (!m) continue;
    const port = parseInt(m[1], 10);
    if (!map.has(port)) map.set(port, parseInt(m[2], 10));
  }
  return map;
}

export function findListeningPids({ timeout = 8000 } = {}): Promise<Map<number, number>> {
  return new Promise((resolve) => {
    // No `-p TCP`: that filter is IPv4-only and hides servers bound to ::1.
    execFile('netstat', ['-ano'], { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) =>
      resolve(err || !stdout ? new Map() : parseNetstat(stdout)),
    );
  });
}
