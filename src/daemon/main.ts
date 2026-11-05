// devpilotd — one per user. Detached from whoever started it, so services
// outlive Claude sessions and terminals. State lives in ~/.devpilot.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { Supervisor } from '../core/supervisor.js';
import { paths, writeJsonAtomic } from '../core/paths.js';
import { pidAlive } from '../core/platform/index.js';
import { readDaemonInfo } from '../shared/client.js';
import { createApp, VERSION } from './app.js';
import { isPortFree } from '../core/health.js';

const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);

async function pickPort(): Promise<number> {
  const wanted = Number(process.env.DEVPILOT_PORT) || 47800;
  for (let p = wanted; p < wanted + 20; p++) if (await isPortFree(p)) return p;
  throw new Error(`no free port in ${wanted}-${wanted + 19}`);
}

async function main() {
  fs.mkdirSync(paths.home, { recursive: true });
  const existing = readDaemonInfo();
  if (existing && existing.pid !== process.pid && pidAlive(existing.pid)) {
    try {
      const r = await fetch(`http://127.0.0.1:${existing.port}/api/ping`, { signal: AbortSignal.timeout(800) });
      if (r.ok) {
        log(`daemon already running (pid ${existing.pid}, port ${existing.port})`);
        process.exit(0);
      }
    } catch {
      /* stale file */
    }
  }

  const token = crypto.randomBytes(24).toString('hex');
  const startedAt = Date.now();
  const sup = new Supervisor();
  const port = await pickPort();
  const dashboardDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dashboard');

  let closing = false;
  const shutdown = async (keepServices: boolean) => {
    if (closing) return;
    closing = true;
    log(`shutting down (${keepServices ? 'keeping' : 'stopping'} services)`);
    await sup.shutdown({ stopServices: !keepServices });
    try {
      if (readDaemonInfo()?.pid === process.pid) fs.rmSync(paths.daemonInfo);
    } catch {
      /* ignore */
    }
    process.exit(0);
  };

  const app = createApp({ sup, token, startedAt, dashboardDir, shutdown: (k) => void shutdown(k) });
  await sup.boot();
  serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, () => {
    writeJsonAtomic(paths.daemonInfo, { pid: process.pid, port, token, startedAt, version: VERSION });
    try {
      fs.chmodSync(paths.daemonInfo, 0o600);
    } catch {
      /* windows */
    }
    log(`devpilot ${VERSION} daemon pid ${process.pid} listening on http://127.0.0.1:${port}`);
  });

  process.on('SIGINT', () => void shutdown(false));
  process.on('SIGTERM', () => void shutdown(false));
  process.on('uncaughtException', (e) => log('uncaught', e));
  process.on('unhandledRejection', (e) => log('unhandled rejection', e));
}

main().catch((e) => {
  log('fatal', e);
  process.exit(1);
});
