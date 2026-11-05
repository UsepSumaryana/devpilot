// Bundles every entry point into plugins/devpilot/dist so the plugin runs with
// plain `node` and no `npm install` on the user's machine.
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const dist = path.join(root, 'plugins/devpilot/dist');
const watch = process.argv.includes('--watch');

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(path.join(dist, 'dashboard'), { recursive: true });

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

const node = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  sourcemap: 'linked',
  minify: !watch,
  logLevel: 'info',
  define: { __DEVPILOT_VERSION__: JSON.stringify(pkg.version) },
  // Some CJS deps call require() at runtime; give the ESM bundle one.
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
};

const builds = [
  { ...node, entryPoints: {
      daemon: 'src/daemon/main.ts',
      cli: 'src/cli/index.ts',
      'session-start': 'src/hooks/session-start.ts',
    }, outdir: dist },
  { bundle: true, platform: 'browser', format: 'esm', target: 'es2022', minify: !watch,
    sourcemap: true, logLevel: 'info', jsx: 'automatic', jsxImportSource: 'preact',
    entryPoints: { app: 'src/dashboard/main.tsx' }, outdir: path.join(dist, 'dashboard'),
    loader: { '.css': 'css' } },
];

fs.copyFileSync(path.join(root, 'src/dashboard/index.html'), path.join(dist, 'dashboard/index.html'));

if (watch) {
  for (const b of builds) (await esbuild.context(b)).watch();
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)));
  // The CLI is also the package's bin.
  const cli = path.join(dist, 'cli.js');
  fs.writeFileSync(cli, '#!/usr/bin/env node\n' + fs.readFileSync(cli, 'utf8'));
}
