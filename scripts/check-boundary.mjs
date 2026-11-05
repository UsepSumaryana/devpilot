// OS primitives (shells, taskkill, netstat, ps, ...) may only appear inside
// src/core/platform/. Anything else must go through that module's interface.
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../src');
const allowed = path.join(root, 'core', 'platform');
const banned = /\b(cmd\.exe|taskkill|netstat|powershell|Get-CimInstance|lsof|getconf|\/proc\/)\b|['"]ss['"]|['"]ps['"]/;
const bad = [];

function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (p !== allowed) walk(p); continue; }
    if (!/\.(ts|tsx)$/.test(e.name)) continue;
    fs.readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
      if (banned.test(line)) bad.push(`${path.relative(root, p)}:${i + 1}: ${line.trim()}`);
    });
  }
}
walk(root);
if (bad.length) {
  console.error('OS primitives outside src/core/platform/:\n' + bad.join('\n'));
  process.exit(1);
}
console.log('boundary ok');
