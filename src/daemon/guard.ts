// Request guard (ported from jsrunner server/guard.mjs) + bearer-token auth.
//
// Starting a service runs an arbitrary shell command, so every /api route is a
// code-execution primitive. Defences, in order:
//  1. Host check — blocks DNS rebinding (the Host header names the attacker's
//     domain, never localhost). Address literals cannot be rebound, so allowed.
//  2. Origin / Sec-Fetch-Site — blocks CSRF from other pages in the browser.
//  3. Token — the daemon is shared by every local program; only holders of
//     ~/.devpilot/daemon.json (or the dashboard cookie it minted) may act.
import net from 'node:net';
import { timingSafeEqual } from 'node:crypto';

export function splitHostPort(value: string | undefined | null): { host: string; port: string } | null {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (!s) return null;
  if (s.startsWith('[')) {
    const end = s.indexOf(']');
    if (end === -1) return null;
    const rest = s.slice(end + 1);
    if (rest && !rest.startsWith(':')) return null;
    return { host: s.slice(1, end).toLowerCase(), port: rest.slice(1) };
  }
  if ((s.match(/:/g) || []).length > 1) return { host: s.toLowerCase(), port: '' };
  const idx = s.indexOf(':');
  if (idx === -1) return { host: s.toLowerCase(), port: '' };
  const port = s.slice(idx + 1);
  if (!/^\d+$/.test(port)) return null;
  return { host: s.slice(0, idx).toLowerCase(), port };
}

export const isAddressLiteral = (host: string) => net.isIP(host) !== 0;

export interface GuardInput {
  host?: string;
  origin?: string;
  secFetchSite?: string;
  path: string;
}

export type GuardResult = { ok: true } | { ok: false; error: string; detail: string };

export function createGuard({ allowHosts = [] as string[] } = {}) {
  const allowed = new Set(allowHosts.map((h) => h.trim().toLowerCase()).filter(Boolean));

  const hostAllowed = (host: string) => host === 'localhost' || isAddressLiteral(host) || allowed.has(host);

  function originAllowed(origin: string, hostHeader: string | undefined) {
    if (origin === 'null') return false;
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      return false;
    }
    const originHost = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (allowed.has(originHost)) return true;
    const target = splitHostPort(hostHeader);
    if (!target) return false;
    const originPort = url.port || (url.protocol === 'https:' ? '443' : '80');
    return originHost === target.host && originPort === (target.port || '80');
  }

  return function check({ host, origin, secFetchSite, path }: GuardInput): GuardResult {
    const parsed = splitHostPort(host);
    if (!parsed || !hostAllowed(parsed.host)) {
      return { ok: false, error: `Host "${host}" is not allowed`, detail: 'Only localhost and address literals are served (DNS-rebinding guard).' };
    }
    if (!path.startsWith('/api/')) return { ok: true };
    if (origin !== undefined && !originAllowed(origin, host)) {
      return { ok: false, error: `Origin "${origin}" is not allowed`, detail: 'Only the dashboard served by this daemon may call the API.' };
    }
    if (secFetchSite !== undefined && secFetchSite !== 'same-origin' && secFetchSite !== 'none') {
      return { ok: false, error: 'Cross-site requests are not allowed', detail: `Sec-Fetch-Site: ${secFetchSite}` };
    }
    return { ok: true };
  };
}

export function tokenMatches(given: string | undefined | null, expected: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
