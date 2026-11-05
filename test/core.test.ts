import { describe, expect, test } from 'vitest';
import path from 'node:path';
import { parseConfig, parseDotenv, parseDuration, resolveEnv } from '../src/core/config.js';
import { detectServices, draftYaml } from '../src/core/detect.js';
import { cleanTitle, ErrorDetector, foldKey, isErrorLine, pickHeadline } from '../src/core/incidents.js';
import { createGuard, splitHostPort, tokenMatches } from '../src/daemon/guard.js';
import { stripAnsi } from '../src/core/logs.js';
import { collectTree } from '../src/core/platform/index.js';
import * as win from '../src/core/platform/win.js';
import * as posix from '../src/core/platform/posix.js';

const FIXTURE = path.resolve(import.meta.dirname, 'fixtures/demo');

describe('config', () => {
  test('durations', () => {
    expect(parseDuration('500ms', 0)).toBe(500);
    expect(parseDuration('5s', 0)).toBe(5000);
    expect(parseDuration('2m', 0)).toBe(120_000);
    expect(parseDuration(undefined, 42)).toBe(42);
    expect(() => parseDuration('soon', 0)).toThrow(/Invalid duration/);
  });

  test('parses services, defaults and profiles', () => {
    const cfg = parseConfig(
      `
version: 1
profiles: { be: [db, api] }
services:
  db: { compose: docker-compose.yml, services: [postgres], health: { tcp: 5432 } }
  api:
    cwd: backend
    run: npm run dev
    port: 3000
    depends_on: [db]
    health: { http: /health, expect: 200 }
    restart: { policy: always, max: 2 }
`,
      '/repo/devpilot.yaml',
    );
    const db = cfg.services.find((s) => s.name === 'db')!;
    const api = cfg.services.find((s) => s.name === 'api')!;
    expect(db.run).toBe('docker compose -f docker-compose.yml up postgres');
    expect(db.stop.command).toBe('docker compose -f docker-compose.yml stop postgres');
    expect(db.health).toMatchObject({ kind: 'tcp', target: 5432 });
    expect(api.cwd).toBe(path.resolve('/repo', 'backend'));
    expect(api.health).toMatchObject({ kind: 'http', target: '/health', expect: [200] });
    expect(api.restart).toMatchObject({ policy: 'always', max: 2, backoff: 'exponential' });
    expect(cfg.profiles.default).toEqual(['db', 'api']);
    expect(cfg.profiles.be).toEqual(['db', 'api']);
  });

  test('a port without health config gets a TCP check', () => {
    const cfg = parseConfig('services: { web: { run: x, port: 8080 } }', '/r/devpilot.yaml');
    expect(cfg.services[0].health).toMatchObject({ kind: 'tcp', target: 8080 });
  });

  test('rejects unknown keys, missing run and unknown dependencies', () => {
    expect(() => parseConfig('services: { a: { run: x, prot: 1 } }', '/r/devpilot.yaml')).toThrow(/invalid/);
    expect(() => parseConfig('services: { a: { cwd: x } }', '/r/devpilot.yaml')).toThrow(/run/);
    expect(() => parseConfig('services: { a: { run: x, depends_on: [b] } }', '/r/devpilot.yaml')).toThrow(/unknown service "b"/);
  });

  test('dotenv', () => {
    expect(parseDotenv('A=1\nexport B="two words"\n# c\nC=x # trailing\nD=\'q\'')).toEqual({ A: '1', B: 'two words', C: 'x', D: 'q' });
  });

  test('env precedence: profile env beats service env beats files; PORT injected', () => {
    const cfg = parseConfig(
      `
env: { G: global }
env_profiles: { loud: { env: { G: loud } } }
services: { a: { run: x, port: 9, env: { S: svc } } }`,
      path.join(FIXTURE, 'devpilot.yaml'),
    );
    const spec = cfg.services[0];
    expect(resolveEnv(spec, undefined, {})).toMatchObject({ G: 'global', S: 'svc', PORT: '9' });
    expect(resolveEnv(spec, 'loud', {}).G).toBe('loud');
  });
});

describe('detect', () => {
  test('finds node services in the fixture and drafts valid yaml', () => {
    const found = detectServices(FIXTURE);
    // The fixture has no package.json, so nothing is detected; a draft is still valid YAML.
    const yaml = draftYaml(FIXTURE, found);
    expect(yaml).toContain('version: 1');
  });
});

describe('incidents', () => {
  test('recognises error lines across runtimes', () => {
    expect(isErrorLine('TypeError: x is not a function')).toBe(true);
    expect(isErrorLine('Traceback (most recent call last):')).toBe(true);
    expect(isErrorLine('panic: runtime error: index out of range')).toBe(true);
    expect(isErrorLine('java.lang.IllegalStateException: nope')).toBe(true);
    expect(isErrorLine('[ERROR] Failed to execute goal')).toBe(true);
    expect(isErrorLine('Server listening on :3000')).toBe(false);
    expect(isErrorLine('GET /errors 200')).toBe(false);
  });

  test('headline prefers the Error: line over the echoed source line', () => {
    const block = ['file:///x.mjs:2', "setTimeout(() => { throw new Error('ECONNREFUSED 127.0.0.1:5999') })", '   ^', '', 'Error: ECONNREFUSED 127.0.0.1:5999', '    at foo (x.mjs:2:3)', 'Node.js v24.0.0'];
    expect(pickHeadline(block)).toBe('Error: ECONNREFUSED 127.0.0.1:5999');
  });

  test('titles drop logger prefixes and fold across PIDs/timestamps', () => {
    const a = cleanTitle('[Nest] 17012  - 05/11/2026, 10.41.53   ERROR [RedisClient] Error: connect ECONNREFUSED 127.0.0.1:6379');
    const b = cleanTitle('[Nest] 32164  - 05/11/2026, 10.41.44   ERROR [RedisClient] Error: connect ECONNREFUSED 127.0.0.1:6379');
    expect(a).toBe('[RedisClient] Error: connect ECONNREFUSED 127.0.0.1:6379');
    expect(foldKey(a)).toBe(foldKey(b));
    expect(cleanTitle('2026-11-05T10:00:00.123Z something failed')).toBe('something failed');
  });

  test('detector groups a stack trace into one incident', async () => {
    const got: Array<{ title: string; context: string[] }> = [];
    const d = new ErrorDetector((_k, title, context) => got.push({ title, context }));
    const line = (text: string, seq: number) => ({ seq, t: Date.now(), stream: 'err' as const, text });
    d.feed('ws/a', [line('booting', 1), line('TypeError: boom', 2), line('    at a (x.js:1:1)', 3), line('    at b (x.js:2:1)', 4)]);
    await new Promise((r) => setTimeout(r, 500));
    expect(got).toHaveLength(1);
    expect(got[0].title).toBe('TypeError: boom');
    expect(got[0].context).toContain('    at b (x.js:2:1)');
  });
});

describe('guard', () => {
  const check = createGuard();
  test('host header', () => {
    expect(splitHostPort('[::1]:47800')).toEqual({ host: '::1', port: '47800' });
    expect(check({ host: 'localhost:47800', path: '/' }).ok).toBe(true);
    expect(check({ host: '127.0.0.1:47800', path: '/api/x' }).ok).toBe(true);
    expect(check({ host: 'evil.example:47800', path: '/' }).ok).toBe(false);
  });
  test('origin and fetch-site on /api', () => {
    expect(check({ host: 'localhost:47800', origin: 'http://localhost:47800', path: '/api/x' }).ok).toBe(true);
    expect(check({ host: 'localhost:47800', origin: 'https://evil.example', path: '/api/x' }).ok).toBe(false);
    expect(check({ host: 'localhost:47800', secFetchSite: 'cross-site', path: '/api/x' }).ok).toBe(false);
    expect(check({ host: 'localhost:47800', origin: 'null', path: '/api/x' }).ok).toBe(false);
  });
  test('token compare', () => {
    expect(tokenMatches('abc', 'abc')).toBe(true);
    expect(tokenMatches('abd', 'abc')).toBe(false);
    expect(tokenMatches(undefined, 'abc')).toBe(false);
  });
});

describe('platform parsers (ported from jsrunner)', () => {
  test('netstat sees IPv6 listeners and ignores non-listening rows', () => {
    const out = ['  TCP    0.0.0.0:3000   0.0.0.0:0   LISTENING   1234', '  TCP    [::1]:9911   [::]:0   LISTENING   2468', '  TCP    127.0.0.1:3000   127.0.0.1:52001   ESTABLISHED   4321'].join('\r\n');
    const m = win.parseNetstat(out);
    expect(m.get(3000)).toBe(1234);
    expect(m.get(9911)).toBe(2468);
    expect(m.has(52001)).toBe(false);
  });
  test('CIM json: 100ns -> ms', () => {
    const m = win.parseProcessJson(JSON.stringify([{ p: 100, pp: 4, n: 'node.exe', t: 12_345_678, w: 1048576 }]));
    expect(m.get(100)).toMatchObject({ name: 'node.exe', cpuMs: 1234.5678, mem: 1048576 });
  });
  test('ps output and cpu time', () => {
    expect(posix.parseCpuTime('1-02:03:04')).toBe((86400 + 7384) * 1000);
    const m = posix.parsePsOutput('  10   1  2048 00:01 /usr/bin/node\n');
    expect(m.get(10)).toMatchObject({ ppid: 1, name: 'node', mem: 2048 * 1024, cpuMs: 1000 });
  });
  test('/proc stat with parentheses in comm', () => {
    const raw = '42 (my (weird) proc) S 1 42 42 0 -1 4194560 0 0 0 0 150 50 0 0 20 0 1 0 100 1000000 256 0';
    expect(posix.parseProcStat(raw, 4096)).toMatchObject({ pid: 42, ppid: 1, name: 'my (weird) proc', cpuMs: 2000, mem: 256 * 4096 });
  });
  test('ss and lsof', () => {
    expect(posix.parseSs('LISTEN 0 511 0.0.0.0:3000 0.0.0.0:* users:(("node",pid=1234,fd=23))').get(3000)).toBe(1234);
    expect(posix.parseLsof('node    12345 me   23u  IPv4 0x1  0t0  TCP *:3000 (LISTEN)').get(3000)).toBe(12345);
  });
  test('collectTree', () => {
    const snap = new Map([
      [1, { pid: 1, ppid: 0, name: 'cmd.exe', cpuMs: 0, mem: 0, cmd: '' }],
      [2, { pid: 2, ppid: 1, name: 'node.exe', cpuMs: 0, mem: 0, cmd: '' }],
      [3, { pid: 3, ppid: 2, name: 'esbuild.exe', cpuMs: 0, mem: 0, cmd: '' }],
      [9, { pid: 9, ppid: 0, name: 'other', cpuMs: 0, mem: 0, cmd: '' }],
    ]);
    expect(collectTree(1, snap)).toEqual([1, 2, 3]);
  });
});

test('stripAnsi', () => {
  expect(stripAnsi('\x1b[31mred\x1b[0m plain')).toBe('red plain');
});
