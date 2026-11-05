import type { ChildProcess, StdioOptions } from 'node:child_process';

/** Normalised across platforms. cpuMs is cumulative CPU time; mem is resident bytes. */
export interface ProcessRecord {
  pid: number;
  ppid: number;
  name: string;
  cpuMs: number;
  mem: number;
  /** '' unless listProcesses was called with { withCommandLine: true } */
  cmd: string;
}

export interface SpawnOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdio: StdioOptions;
}

export interface PlatformImpl {
  spawnShell(command: string, opts: SpawnOptions): ChildProcess;
  /** Ask the tree to exit (SIGTERM / taskkill without /F). Never throws. */
  signalTree(pid: number): void;
  /** Kill the tree unconditionally. Never throws. */
  killTree(pid: number): void;
  listProcesses(opts?: { withCommandLine?: boolean; timeout?: number }): Promise<Map<number, ProcessRecord>>;
  findListeningPids(opts?: { timeout?: number }): Promise<Map<number, number>>;
  /** Shell wrappers whose child is the real service (skipped when naming an image). */
  SHELL_IMAGES: Set<string>;
}
