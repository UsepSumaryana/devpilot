// HTTP API + SSE + dashboard, served on 127.0.0.1 only.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { getCookie, setCookie } from 'hono/cookie';
import type { DaemonEvent, Summary } from '../shared/types.js';
import type { Supervisor } from '../core/supervisor.js';
import { diagnose } from '../core/diagnose.js';
import { detectServices, draftYaml } from '../core/detect.js';
import { CONFIG_FILES } from '../core/config.js';
import { findListeningPids, killTree, listProcesses } from '../core/platform/index.js';
import { createGuard, tokenMatches } from './guard.js';

declare const __DEVPILOT_VERSION__: string;
export const VERSION = typeof __DEVPILOT_VERSION__ === 'string' ? __DEVPILOT_VERSION__ : 'dev';

const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.map': 'application/json', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const SECRET_KEY = /pass|secret|token|key|credential|private|auth/i;

export interface AppDeps {
  sup: Supervisor;
  token: string;
  startedAt: number;
  dashboardDir: string;
  shutdown: (keepServices: boolean) => void;
}

export function createApp({ sup, token, startedAt, dashboardDir, shutdown }: AppDeps) {
  const app = new Hono();
  const guard = createGuard();
  const codes = new Map<string, number>(); // one-time dashboard login codes

  app.onError((err, c) => c.json({ error: err.message }, (err as any).status || 400));

  app.use('*', async (c, next) => {
    const g = guard({ host: c.req.header('host'), origin: c.req.header('origin'), secFetchSite: c.req.header('sec-fetch-site'), path: c.req.path });
    if (!g.ok) return c.json({ error: g.error, detail: g.detail, code: 'FORBIDDEN_ORIGIN' }, 403);
    if (c.req.path.startsWith('/api/') && c.req.path !== '/api/ping') {
      const bearer = c.req.header('authorization')?.replace(/^Bearer\s+/i, '');
      if (!tokenMatches(bearer, token) && !tokenMatches(getCookie(c, 'dp_session'), token)) {
        return c.json({ error: 'unauthorized', detail: 'Open the dashboard with `devpilot open`.' }, 401);
      }
    }
    await next();
  });

  // ------------------------------------------------------------ misc

  app.get('/api/ping', (c) => c.json({ ok: true, version: VERSION, pid: process.pid }));

  app.post('/api/auth/code', (c) => {
    const code = crypto.randomBytes(16).toString('hex');
    codes.set(code, Date.now() + 5 * 60_000); // one-time; long enough to paste into another browser
    return c.json({ code });
  });

  app.get('/auth', (c) => {
    const code = c.req.query('code') || '';
    const exp = codes.get(code);
    codes.delete(code);
    if (!exp || exp < Date.now()) return c.text('Login link expired — run `devpilot open` again.', 401);
    // Persistent (30 days) so a browser stays logged in across restarts.
    setCookie(c, 'dp_session', token, { httpOnly: true, sameSite: 'Strict', path: '/', maxAge: 30 * 24 * 3600 });
    const to = c.req.query('to');
    return c.redirect(to && to.startsWith('/') && !to.startsWith('//') ? to : '/');
  });

  app.post('/api/daemon/shutdown', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    setTimeout(() => shutdown(!!body.keepServices), 50);
    return c.json({ ok: true });
  });

  app.get('/api/summary', (c) => {
    const ws = c.req.query('ws') || undefined;
    const summary: Summary = { version: VERSION, pid: process.pid, startedAt, workspaces: sup.workspaceViews(ws), incidents: sup.incidents.query({ workspace: ws, open: true, limit: 20 }) };
    return c.json(summary);
  });

  /** Resolve "api", "ws/api" or a folder to a service key / workspace id. */
  app.get('/api/resolve', (c) => {
    const ref = c.req.query('ref');
    const cwd = c.req.query('cwd');
    const ws = cwd ? sup.workspaceFor(cwd) : undefined;
    if (!ref) return c.json({ workspace: ws ?? null });
    return c.json({ key: sup.resolveKey(ref, ws), workspace: ws ?? null });
  });

  // ------------------------------------------------------- workspaces

  app.get('/api/workspaces', (c) => c.json(sup.workspaceViews()));

  app.post('/api/workspaces', async (c) => {
    const { path: p, envProfile } = await c.req.json();
    const w = sup.addWorkspace(p, { envProfile });
    return c.json({ id: w.id, configPath: w.configPath, error: w.error ?? null });
  });

  app.delete('/api/workspaces/:ws', async (c) => {
    await sup.removeWorkspace(c.req.param('ws'));
    return c.json({ ok: true });
  });

  app.post('/api/workspaces/:ws/reload', (c) => {
    sup.reloadWorkspace(c.req.param('ws'));
    return c.json(sup.workspaceViews(c.req.param('ws'))[0]);
  });

  app.post('/api/workspaces/:ws/env', async (c) => {
    const { profile, restart } = await c.req.json();
    const id = c.req.param('ws');
    sup.setEnvProfile(id, profile);
    const restarted: string[] = [];
    if (restart) {
      for (const s of sup.workspaceViews(id)[0].services) {
        if (['running', 'starting', 'unhealthy'].includes(s.status)) {
          await sup.restart(s.key);
          restarted.push(s.name);
        }
      }
    }
    return c.json({ ok: true, envProfile: profile || null, restarted });
  });

  app.post('/api/workspaces/:ws/up', async (c) => {
    const { profile, services, wait, background, mode } = await c.req.json().catch(() => ({}));
    const id = c.req.param('ws');
    if (mode) sup.setMode(id, mode);
    if (background && !services?.length) {
      sup.startProfile(id, profile || 'default', { wait: false }).catch(() => undefined);
      return c.json({ ok: true, workspace: id, background: true });
    }
    if (services?.length) {
      const keys = services.map((s: string) => sup.resolveKey(s, id));
      const failed = await sup.launchGraph(keys, { waitTarget: !!wait });
      return c.json(keys.map((k: string) => failed.get(k) || { ok: true, key: k, status: sup.view(k).status }));
    }
    return c.json(await sup.startProfile(id, profile || 'default', { wait: !!wait }));
  });

  app.post('/api/workspaces/:ws/down', async (c) => c.json(await sup.stopWorkspace(c.req.param('ws'))));

  /** Switch the workspace (or some services) to a mode; optionally restart what is live. */
  app.post('/api/workspaces/:ws/mode', async (c) => {
    const { mode, services, restart } = await c.req.json();
    const id = c.req.param('ws');
    const r = sup.setMode(id, mode, services);
    const restarted: string[] = [];
    if (restart) {
      for (const key of r.live) {
        restarted.push(key);
        void sup.restart(key).catch(() => undefined);
      }
    }
    return c.json({ ok: true, mode, changed: r.changed, needsRestart: restart ? [] : r.live, restarted });
  });

  app.get('/api/workspaces/:ws/tasks', (c) => c.json(sup.taskInfo(c.req.param('ws'))));

  /** Run a task: `{ task, service? }`, or `{ task, all: true }` for every service that defines it. */
  app.post('/api/workspaces/:ws/tasks', async (c) => {
    const { task, service, all, wait } = await c.req.json();
    const id = c.req.param('ws');
    if (all) {
      const info = sup.taskInfo(id);
      const targets = Object.entries(info.services).filter(([, ts]) => ts.some((t) => t.name === task)).map(([s]) => s);
      if (!targets.length) return c.json({ error: `no service defines task "${task}"` }, 400);
      // One after another: parallel installs fight over the same caches.
      const job = (async () => {
        const runs = [];
        for (const s of targets) runs.push(await sup.runTask(id, s, task, { wait: true }));
        return runs;
      })();
      if (wait) return c.json(await job);
      job.catch(() => undefined);
      return c.json({ ok: true, services: targets, background: true });
    }
    const run = await sup.runTask(id, service, task, { wait: !!wait });
    const { _done, ...plain } = run as any;
    void _done;
    return c.json(plain);
  });

  app.get('/api/tasks/:id', (c) => {
    const run = sup.taskRun(c.req.param('id'));
    if (!run) return c.json({ error: 'not found' }, 404);
    const { _done, ...plain } = run as any;
    void _done;
    return c.json(plain);
  });

  app.post('/api/tasks/:id/cancel', (c) => {
    const { _done, ...plain } = sup.cancelTask(c.req.param('id')) as any;
    void _done;
    return c.json(plain);
  });

  // ---------------------------------------------------------- services

  const key = (c: Context) => `${c.req.param('ws')}/${c.req.param('svc')}`;

  app.get('/api/services/:ws/:svc', (c) => c.json(sup.view(key(c))));

  app.post('/api/services/:ws/:svc/start', async (c) => {
    const b = await c.req.json().catch(() => ({}));
    if (b.mode) sup.setMode(c.req.param('ws'), b.mode, [c.req.param('svc')]);
    const job = sup.start(key(c), { deps: b.deps !== false, wait: !!b.wait, timeoutMs: b.timeoutMs });
    if (b.background) {
      job.catch(() => undefined);
      return c.json({ ok: true, key: key(c), status: 'starting', background: true });
    }
    return c.json(await job);
  });
  app.post('/api/services/:ws/:svc/stop', async (c) => c.json(await sup.stop(key(c))));
  app.post('/api/services/:ws/:svc/restart', async (c) => {
    const b = await c.req.json().catch(() => ({}));
    const job = sup.restart(key(c), { wait: !!b.wait, timeoutMs: b.timeoutMs });
    if (b.background) {
      job.catch(() => undefined);
      return c.json({ ok: true, key: key(c), status: 'starting', background: true });
    }
    return c.json(await job);
  });

  app.get('/api/services/:ws/:svc/logs', (c) => {
    const q = c.req.query();
    const num = (v?: string) => (v === undefined || v === '' ? undefined : Number(v));
    return c.json(
      sup.logs.query(key(c), {
        tail: num(q.tail) ?? (q.after || q.since ? undefined : 200),
        after: num(q.after),
        since: num(q.since),
        grep: q.grep || undefined,
        stream: (q.stream as any) || undefined,
        ansi: q.ansi === '1',
      }),
    );
  });
  app.delete('/api/services/:ws/:svc/logs', (c) => {
    sup.logs.clear(key(c));
    return c.json({ ok: true });
  });

  app.get('/api/services/:ws/:svc/metrics', (c) => {
    const range = (c.req.query('range') as '15m' | '1h' | '24h') || '1h';
    return c.json({ range, points: sup.history(key(c), range) });
  });

  app.get('/api/services/:ws/:svc/diagnose', async (c) => c.json(await diagnose(sup, key(c))));

  app.get('/api/services/:ws/:svc/env', (c) => {
    const env = sup.envFor(key(c));
    const spec = sup.spec(key(c));
    const own = new Set(Object.keys(spec.env));
    const reveal = c.req.query('reveal') === '1';
    const rows = Object.entries(env)
      .filter(([k]) => own.has(k) || !(k in process.env) || process.env[k] !== env[k])
      .map(([k, v]) => ({ key: k, value: !reveal && SECRET_KEY.test(k) ? '••••' : v }));
    return c.json({ envFiles: spec.envFiles.map((f) => ({ path: f, exists: fs.existsSync(f) })), vars: rows });
  });

  // ---------------------------------------------------------- incidents

  app.get('/api/incidents', (c) => {
    const q = c.req.query();
    return c.json(sup.incidents.query({ workspace: q.ws, key: q.key, since: q.since ? Number(q.since) : undefined, open: q.open === '1', limit: q.limit ? Number(q.limit) : 50 }));
  });
  app.post('/api/incidents/resolve', async (c) => {
    const { ws, key } = await c.req.json().catch(() => ({}));
    let resolved: number;
    if (key) {
      const before = sup.incidents.openCount(key);
      sup.incidents.resolve(key);
      resolved = before;
    } else resolved = sup.incidents.resolveAll(ws);
    for (const w of sup.workspaceViews(ws)) for (const s of w.services) if (!key || s.key === key) sup.touch(s.key);
    return c.json({ ok: true, resolved });
  });

  app.get('/api/incidents/:id', (c) => {
    const i = sup.incidents.get(c.req.param('id'));
    return i ? c.json(i) : c.json({ error: 'not found' }, 404);
  });

  app.post('/api/incidents/:id/resolve', (c) => {
    const i = sup.incidents.resolveId(c.req.param('id'));
    if (!i) return c.json({ error: 'not found' }, 404);
    sup.touch(i.key);
    return c.json(i);
  });

  // -------------------------------------------------------------- ports

  app.get('/api/ports', async (c) => {
    const [listeners, snap] = await Promise.all([findListeningPids(), listProcesses({ withCommandLine: true })]);
    const services = sup.workspaceViews().flatMap((w) => w.services);
    const ownerOf = (pid: number) => {
      for (let p = snap.get(pid); p; p = snap.get(p.ppid)) {
        const s = services.find((sv) => sv.pid === p!.pid);
        if (s) return s.key;
        if (p.ppid === p.pid) break;
      }
      return null;
    };
    const rows = [...listeners.entries()]
      .map(([port, pid]) => ({ port, pid, name: snap.get(pid)?.name || '', cmd: (snap.get(pid)?.cmd || '').slice(0, 300), service: ownerOf(pid), configuredBy: services.filter((s) => s.port === port).map((s) => s.key) }))
      .sort((a, b) => a.port - b.port);
    return c.json(rows);
  });

  app.post('/api/ports/:port/kill', async (c) => {
    const { force } = await c.req.json().catch(() => ({}));
    const port = Number(c.req.param('port'));
    const pid = (await findListeningPids()).get(port);
    if (!pid) return c.json({ error: `nothing listens on port ${port}` }, 404);
    if (pid === process.pid) return c.json({ error: 'that is the devpilot daemon itself' }, 400);
    const proc = (await listProcesses({ withCommandLine: true })).get(pid);
    if (!force) return c.json({ error: 'refusing without force: true', pid, name: proc?.name, cmd: proc?.cmd }, 409);
    killTree(pid);
    return c.json({ ok: true, pid, name: proc?.name });
  });

  // ------------------------------------------------------------- detect

  app.post('/api/detect', async (c) => {
    const { path: root } = await c.req.json();
    if (!root || !fs.existsSync(root)) return c.json({ error: `folder not found: ${root}` }, 400);
    const services = detectServices(root);
    const existing = CONFIG_FILES.map((f) => path.join(root, f)).find((f) => fs.existsSync(f)) || null;
    return c.json({ services, yaml: draftYaml(root, services), existing });
  });

  // ---------------------------------------------------------------- SSE

  app.get('/api/events', (c) => {
    const ws = c.req.query('ws');
    const kinds = new Set((c.req.query('types') || 'status,incident,metrics,log,workspaces,task').split(','));
    return streamSSE(c, async (stream) => {
      const queue: DaemonEvent[] = [];
      let wake: (() => void) | undefined;
      const off = sup.on((e) => {
        if (!kinds.has(e.type)) return;
        if (ws) {
          const k =
            e.type === 'status' ? e.service.key : e.type === 'incident' ? e.incident.key : e.type === 'workspaces' ? `${ws}/` : e.type === 'task' ? `${e.run.workspace}/` : e.key;
          if (!k.startsWith(`${ws}/`)) return;
        }
        if (queue.length > 5000) queue.shift();
        queue.push(e);
        wake?.();
      });
      let open = true;
      stream.onAbort(() => {
        open = false;
        off();
        wake?.();
      });
      await stream.writeSSE({ event: 'hello', data: JSON.stringify({ version: VERSION, pid: process.pid }) });
      while (open) {
        if (!queue.length) {
          await new Promise<void>((r) => {
            wake = r;
            setTimeout(r, 20_000); // keepalive
          });
          wake = undefined;
          if (!queue.length && open) await stream.write(': keepalive\n\n');
          continue;
        }
        const e = queue.shift()!;
        await stream.writeSSE({ event: e.type, data: JSON.stringify(e) });
      }
    });
  });

  // ---------------------------------------------------------- dashboard

  app.get('*', (c) => {
    if (c.req.path.startsWith('/api/')) return c.json({ error: 'not found' }, 404);
    const rel = c.req.path === '/' ? 'index.html' : c.req.path.slice(1);
    let file = path.resolve(dashboardDir, rel);
    if (!file.startsWith(path.resolve(dashboardDir)) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(dashboardDir, 'index.html');
    if (!fs.existsSync(file)) return c.text('Dashboard not built — run npm run build', 404);
    return c.body(fs.readFileSync(file), 200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
  });

  return app;
}
