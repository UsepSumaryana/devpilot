// Readiness and health probes.
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';

function probeOne(port: number, host: string, timeout: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeout);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, host);
  });
}

/**
 * TCP probe on both loopbacks. Node binds 'localhost' to ::1 on modern
 * Windows, so an IPv4-only probe (jsrunner's) never saw those servers ready.
 */
export async function probeTcp(port: number, timeout = 1000): Promise<{ ok: boolean; latencyMs: number }> {
  const t0 = performance.now();
  const results = await Promise.all([probeOne(port, '127.0.0.1', timeout), probeOne(port, '::1', timeout)]);
  return { ok: results.some(Boolean), latencyMs: Math.round(performance.now() - t0) };
}

export interface HttpProbeResult {
  ok: boolean;
  status?: number;
  latencyMs: number;
  error?: string;
}

function httpOnce(url: string, timeout: number): Promise<HttpProbeResult> {
  const t0 = performance.now();
  return new Promise((resolve) => {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return resolve({ ok: false, latencyMs: 0, error: `bad URL ${url}` });
    }
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(u, { method: 'GET', timeout, rejectUnauthorized: false, headers: { 'user-agent': 'devpilot-health' } }, (res) => {
      res.resume();
      res.on('end', () => resolve({ ok: true, status: res.statusCode, latencyMs: Math.round(performance.now() - t0) }));
    });
    req.on('timeout', () => req.destroy(new Error(`timeout after ${timeout}ms`)));
    req.on('error', (e) => resolve({ ok: false, latencyMs: Math.round(performance.now() - t0), error: e.message }));
    req.end();
  });
}

/**
 * HTTP probe. `target` is a path ("/health", resolved against the service
 * port on localhost — tried on 127.0.0.1 then [::1]) or a full URL.
 * `expect` empty means any status below 500.
 */
export async function probeHttp(target: string, port: number | undefined, expect: number[], timeout = 2000): Promise<HttpProbeResult> {
  const urls = /^https?:\/\//.test(target)
    ? [target]
    : port
      ? [`http://127.0.0.1:${port}${target.startsWith('/') ? '' : '/'}${target}`, `http://[::1]:${port}${target.startsWith('/') ? '' : '/'}${target}`]
      : [];
  if (!urls.length) return { ok: false, latencyMs: 0, error: 'health.http is a path but the service has no port' };
  let last: HttpProbeResult = { ok: false, latencyMs: 0 };
  for (const url of urls) {
    const r = await httpOnce(url, timeout);
    if (r.status !== undefined) {
      const good = expect.length ? expect.includes(r.status) : r.status < 500;
      return good ? r : { ...r, ok: false, error: `HTTP ${r.status}` };
    }
    last = r;
  }
  return last;
}

export function isPortFree(port: number): Promise<boolean> {
  const tryBind = (host: string) =>
    new Promise<boolean>((resolve) => {
      const srv = net.createServer();
      srv.once('error', (e: any) => resolve(e.code === 'EADDRNOTAVAIL' || e.code === 'EAFNOSUPPORT'));
      srv.listen({ port, host, exclusive: true }, () => srv.close(() => resolve(true)));
    });
  return Promise.all([tryBind('127.0.0.1'), tryBind('::1')]).then((r) => r.every(Boolean));
}

export async function findFreePort(from: number, attempts = 50): Promise<number | null> {
  for (let p = from; p < from + attempts && p < 65536; p++) if (await isPortFree(p)) return p;
  return null;
}
