// Dependency-free config lookup, so the CLI and hooks stay light.
import fs from 'node:fs';
import path from 'node:path';

export const CONFIG_FILES = ['devpilot.yaml', 'devpilot.yml', '.devpilot.yaml'];

export function findConfig(dir: string): string | null {
  let cur = path.resolve(dir);
  for (;;) {
    for (const f of CONFIG_FILES) {
      const p = path.join(cur, f);
      if (fs.existsSync(p)) return p;
    }
    const up = path.dirname(cur);
    if (up === cur) return null;
    cur = up;
  }
}
