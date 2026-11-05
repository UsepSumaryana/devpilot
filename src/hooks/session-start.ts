// SessionStart hook: tells Claude, factually and briefly, which services of
// this project DevPilot knows about and what state they are in. Never starts
// the daemon and never blocks the session for long.
import path from 'node:path';
import { findConfig } from '../core/find-config.js';
import { Client, findDaemon } from '../shared/client.js';
import type { Summary } from '../shared/types.js';

async function readStdin(): Promise<any> {
  if (process.stdin.isTTY) return {};
  let raw = '';
  for await (const c of process.stdin) raw += c;
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function out(context: string) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context.slice(0, 1500) } }));
}

async function main() {
  const input = await Promise.race([readStdin(), new Promise((r) => setTimeout(() => r({}), 500))]);
  const cwd = path.resolve((input as any)?.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd());
  const config = findConfig(cwd);
  const info = await findDaemon();
  if (!config && !info) return; // nothing DevPilot-related here: stay silent

  const hint = 'Control with the `devpilot` CLI (add --json): status, up, logs, diagnose, incidents.';
  if (!info) {
    out(`DevPilot: this project has ${path.basename(config!)} but the devpilot daemon is not running, so no services are supervised. ${hint}`);
    return;
  }
  const api = new Client(info);
  const r = await api.get<{ workspace: string | null }>(`/api/resolve?cwd=${encodeURIComponent(cwd)}`);
  if (!r.workspace) {
    if (config) out(`DevPilot: ${path.basename(config)} exists here but is not registered yet (any devpilot command registers it). ${hint}`);
    return;
  }
  const sum = await api.get<Summary>(`/api/summary?ws=${r.workspace}`);
  const ws = sum.workspaces[0];
  if (!ws) return;
  const lines = ws.services.map((s) => {
    const extra = [s.port ? `:${s.port}` : '', s.health.state === 'failing' ? 'health failing' : '', s.restarts ? `${s.restarts} restarts` : '', ['crashed', 'backoff', 'unhealthy'].includes(s.status) && s.lastError ? `last error: ${s.lastError.slice(0, 120)}` : '']
      .filter(Boolean)
      .join(', ');
    return `- ${s.name}: ${s.status}${extra ? ` (${extra})` : ''}`;
  });
  const open = sum.incidents.length ? ` ${sum.incidents.length} open incident(s); see \`devpilot incidents --json\`.` : '';
  out(`DevPilot workspace "${ws.name}" (${ws.id})${ws.envProfile ? `, env profile ${ws.envProfile}` : ''}:\n${lines.join('\n')}\n${open} ${hint}`.trim());
}

const timer = setTimeout(() => process.exit(0), 4000);
main()
  .catch(() => undefined)
  .finally(() => {
    clearTimeout(timer);
    process.exit(0);
  });
