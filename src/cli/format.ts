import type { Incident, ServiceStatus, ServiceView, WorkspaceView } from '../shared/types.js';

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code: number) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
export const color = { red: c(31), green: c(32), yellow: c(33), blue: c(34), magenta: c(35), cyan: c(36), dim: c(2), bold: c(1) };

export const STATUS_ICON: Record<ServiceStatus, string> = {
  running: color.green('●'),
  starting: color.yellow('◐'),
  unhealthy: color.yellow('▲'),
  backoff: color.magenta('↻'),
  crashed: color.red('✖'),
  stopping: color.dim('◌'),
  stopped: color.dim('○'),
  exited: color.dim('○'),
};

export function ago(t?: number): string {
  if (!t) return '-';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d`;
}

export const bytes = (n?: number) => (n === undefined ? '-' : n > 1 << 30 ? `${(n / (1 << 30)).toFixed(1)}G` : `${Math.round(n / (1 << 20))}M`);

const visible = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '').length;
const pad = (s: string, n: number) => s + ' '.repeat(Math.max(0, n - visible(s)));

export function table(rows: string[][]): string {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => visible(r[i] || ''))));
  return rows.map((r) => r.map((cell, i) => (i === r.length - 1 ? cell : pad(cell, widths[i]))).join('  ').trimEnd()).join('\n');
}

export function healthText(s: ServiceView): string {
  const h = s.health;
  if (h.kind === 'none' || h.state === 'none') return color.dim('-');
  if (h.state === 'ok') return color.green(`${h.kind} ok${h.latencyMs !== undefined ? ` ${h.latencyMs}ms` : ''}`);
  if (h.state === 'failing') return color.red(`${h.kind} fail×${h.consecutiveFailures}`);
  return color.dim(`${h.kind} ?`);
}

export function workspaceTable(ws: WorkspaceView): string {
  const head = `${color.bold(ws.name)} ${color.dim(`(${ws.id})`)}${ws.envProfile ? color.cyan(` env:${ws.envProfile}`) : ''}  ${color.dim(ws.root)}`;
  if (ws.configError) return `${head}\n  ${color.red('config error:')} ${ws.configError}`;
  const rows = [[color.dim('SERVICE'), color.dim('STATUS'), color.dim('HEALTH'), color.dim('PORT'), color.dim('CPU'), color.dim('MEM'), color.dim('UP'), color.dim('↻'), color.dim('PID'), color.dim('NOTE')]];
  for (const s of ws.services) {
    const live = ['running', 'starting', 'unhealthy'].includes(s.status);
    rows.push([
      s.name,
      `${STATUS_ICON[s.status]} ${s.status}`,
      healthText(s),
      s.port ? String(s.port) : '-',
      live && s.cpu !== undefined ? `${s.cpu}%` : '-',
      live ? bytes(s.mem) : '-',
      live ? ago(s.startedAt) : '-',
      s.restarts ? color.magenta(String(s.restarts)) : '0',
      s.pid ? String(s.pid) : '-',
      s.status === 'crashed' || s.status === 'backoff' || s.status === 'unhealthy' ? color.red((s.lastError || '').slice(0, 70)) : s.openIncidents ? color.yellow(`${s.openIncidents} open incident(s)`) : '',
    ]);
  }
  return `${head}\n${table(rows).replace(/^/gm, '  ')}`;
}

export function incidentLine(i: Incident): string {
  const icon = i.severity === 'error' ? color.red('✖') : color.yellow('⚠');
  const when = new Date(i.at).toLocaleTimeString();
  return `${icon} ${color.dim(when)} ${color.bold(i.service)} ${i.title}${i.count > 1 ? color.dim(` ×${i.count}`) : ''}${i.resolvedAt ? color.green(' (resolved)') : ''} ${color.dim(`[${i.id}]`)}`;
}

export function parseSince(v?: string): number | undefined {
  if (!v) return undefined;
  const m = v.match(/^(\d+)\s*(s|m|h|d)$/);
  if (m) return Date.now() - Number(m[1]) * { s: 1e3, m: 6e4, h: 36e5, d: 864e5 }[m[2] as 's']!;
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : t;
}
