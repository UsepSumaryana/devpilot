import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyMode, parseConfig } from '../src/core/config.js';

describe('config: modes and tasks', () => {
  const yaml = `
tasks:
  install: yarn install
services:
  api:
    cwd: backend
    run: yarn start:dev
    port: 3000
    env: { A: base }
    tasks:
      build: { run: yarn build, timeout: 2m }
      fresh: { run: yarn install --force, stop_service: true }
    modes:
      build:
        run: node dist/main.js
        env: { A: built }
        before: [install, build]
        ready: { log: "listening" }
`;
  const cfg = parseConfig(yaml, '/repo/devpilot.yaml');
  const api = cfg.services[0];

  test('parses tasks at both levels with cwd and options', () => {
    expect(cfg.tasks.install).toMatchObject({ run: 'yarn install', cwd: path.resolve('/repo') });
    expect(api.tasks.build).toMatchObject({ run: 'yarn build', cwd: path.resolve('/repo/backend'), timeoutMs: 120_000, stopService: false });
    expect(api.tasks.fresh.stopService).toBe(true);
    expect(cfg.modes).toEqual(['default', 'build']);
  });

  test('applyMode overlays run/env/ready/before and falls back to the plain config', () => {
    const b = applyMode(api, 'build');
    expect(b).toMatchObject({ mode: 'build', run: 'node dist/main.js', before: ['install', 'build'] });
    expect(b.env.A).toBe('built');
    expect(b.readyLog?.source).toBe('listening');
    expect(b.port).toBe(3000);
    expect(applyMode(api, 'default')).toMatchObject({ mode: 'default', run: 'yarn start:dev', before: [] });
    expect(applyMode(api, 'nope').mode).toBe('default');
  });

  test('rejects a before-task that does not exist, and redefining "default"', () => {
    expect(() => parseConfig('services: { a: { run: x, modes: { b: { before: [nope] } } } }', '/r/devpilot.yaml')).toThrow(/unknown task "nope"/);
    expect(() => parseConfig('services: { a: { run: x, modes: { default: { run: y } } } }', '/r/devpilot.yaml')).toThrow(/cannot be redefined/);
  });
});

// Integration: a real supervisor running a task and a mode with before-tasks.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'devpilot-modes-'));
process.env.DEVPILOT_HOME = HOME;
const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'devpilot-modes-ws-'));
const { Supervisor } = await import('../src/core/supervisor.js');
let sup: InstanceType<typeof Supervisor>;
let id: string;

beforeAll(async () => {
  fs.writeFileSync(path.join(WS, 'build.mjs'), "import fs from 'node:fs'; fs.mkdirSync('dist',{recursive:true}); fs.writeFileSync('dist/app.mjs', \"console.log('BUILT READY'); setInterval(()=>{},1000)\"); console.log('built');");
  fs.writeFileSync(path.join(WS, 'dev.mjs'), "console.log('DEV READY'); setInterval(()=>{},1000)");
  fs.writeFileSync(path.join(WS, 'fail.mjs'), "console.error('boom'); process.exit(3)");
  fs.writeFileSync(
    path.join(WS, 'devpilot.yaml'),
    `services:
  app:
    run: node dev.mjs
    ready: { log: "DEV READY" }
    tasks:
      build: node build.mjs
      broken: node fail.mjs
    modes:
      built:
        run: node dist/app.mjs
        ready: { log: "BUILT READY" }
        before: [build]
      bad:
        before: [broken]
`,
  );
  sup = new Supervisor();
  await sup.boot();
  id = sup.addWorkspace(WS).id;
});

afterAll(async () => {
  await sup.shutdown({ stopServices: true });
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.rmSync(WS, { recursive: true, force: true });
});

test('a task runs to completion and its output reaches the service log', async () => {
  const run = await sup.runTask(id, 'app', 'build', { wait: true });
  expect(run.status).toBe('ok');
  expect(fs.existsSync(path.join(WS, 'dist/app.mjs'))).toBe(true);
  expect(sup.logs.recent(`${id}/app`, 10).join('\n')).toContain('built');
}, 30_000);

test('a mode runs its before-tasks, then its own command', async () => {
  fs.rmSync(path.join(WS, 'dist'), { recursive: true, force: true });
  sup.setMode(id, 'built', ['app']);
  const r = await sup.start(`${id}/app`, { wait: true, timeoutMs: 20_000 });
  expect(r.ok).toBe(true);
  expect(sup.view(`${id}/app`)).toMatchObject({ mode: 'built', run: 'node dist/app.mjs', status: 'running' });
  await sup.stop(`${id}/app`);
}, 30_000);

test('a failing before-task fails the start with the task named', async () => {
  sup.setMode(id, 'bad', ['app']);
  const r = await sup.start(`${id}/app`, { wait: true, timeoutMs: 20_000 });
  expect(r.ok).toBe(false);
  expect(r.reason).toContain('task "broken" failed (exit code 3)');
  expect(sup.incidents.query({ key: `${id}/app` }).some((i) => i.kind === 'task-failed')).toBe(true);
  sup.setMode(id, 'default', ['app']);
}, 30_000);
