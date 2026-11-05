// Integration: a real Supervisor spawning real processes, isolated in a temp DEVPILOT_HOME.
import { afterAll, beforeAll, expect, test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'devpilot-test-'));
process.env.DEVPILOT_HOME = HOME;
const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'devpilot-ws-'));

const { Supervisor } = await import('../src/core/supervisor.js');
let sup: InstanceType<typeof Supervisor>;
let id: string;

beforeAll(async () => {
  fs.writeFileSync(path.join(WS, 'ok.mjs'), "console.log('starting'); setTimeout(() => console.log('READY now'), 300); setInterval(() => {}, 1000);");
  fs.writeFileSync(path.join(WS, 'boom.mjs'), "console.log('hi'); setTimeout(() => { throw new TypeError('kaboom') }, 200);");
  fs.writeFileSync(
    path.join(WS, 'devpilot.yaml'),
    `services:
  base: { run: node ok.mjs, ready: { log: "READY" } }
  app: { run: node ok.mjs, ready: { log: "READY" }, depends_on: [base] }
  boom: { run: node boom.mjs, restart: { max: 1, delay: 100ms } }
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

test('starts dependencies first and waits for the ready log', async () => {
  const r = await sup.start(`${id}/app`, { wait: true, timeoutMs: 15_000 });
  expect(r.ok).toBe(true);
  expect(sup.view(`${id}/base`).status).toBe('running');
  expect(sup.view(`${id}/app`).status).toBe('running');
  const base = sup.view(`${id}/base`);
  const app = sup.view(`${id}/app`);
  expect(base.readyAt! <= app.startedAt!).toBe(true);
  // Output is captured from the files the service writes to.
  await new Promise((r) => setTimeout(r, 400));
  expect(sup.logs.recent(`${id}/app`, 20).join('\n')).toContain('READY now');
}, 30_000);

test('a crashing service is restarted per policy, then gives up with an incident', async () => {
  const r = await sup.start(`${id}/boom`, { wait: true, timeoutMs: 15_000 });
  expect(r.ok).toBe(false);
  expect(r.reason).toContain('TypeError: kaboom');
  const v = sup.view(`${id}/boom`);
  expect(v.status).toBe('crashed');
  expect(v.restarts).toBe(1);
  const incidents = sup.incidents.query({ key: `${id}/boom` });
  expect(incidents.some((i) => i.kind === 'start-failed' || i.kind === 'crash')).toBe(true);
}, 30_000);

test('stop leaves no process behind', async () => {
  const pid = sup.view(`${id}/app`).pid!;
  await sup.stop(`${id}/app`);
  expect(sup.view(`${id}/app`).status).toBe('stopped');
  let alive = true;
  try {
    process.kill(pid, 0);
  } catch {
    alive = false;
  }
  expect(alive).toBe(false);
}, 30_000);
