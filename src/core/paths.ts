import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

/** Everything DevPilot persists lives here, shared by daemon, CLI, hooks and the panel. */
export function homeDir(): string {
  return process.env.DEVPILOT_HOME || path.join(os.homedir(), '.devpilot');
}

export const paths = {
  get home() {
    return homeDir();
  },
  get daemonInfo() {
    return path.join(homeDir(), 'daemon.json');
  },
  get daemonLog() {
    return path.join(homeDir(), 'daemon.log');
  },
  get registry() {
    return path.join(homeDir(), 'registry.json');
  },
  get state() {
    return path.join(homeDir(), 'state.json');
  },
  get incidents() {
    return path.join(homeDir(), 'incidents.jsonl');
  },
  logsDir(workspace: string) {
    return path.join(homeDir(), 'logs', workspace);
  },
};

export function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

/** tmp + rename so a crash mid-write never leaves a half file. */
export function writeJsonAtomic(file: string, data: unknown) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}
