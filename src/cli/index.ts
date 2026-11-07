// devpilot CLI — the one interface for humans and for Claude (every command
// takes --json). Talks to the daemon, starting it on demand.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect, findDaemon, ApiError, type Client, readDaemonInfo } from '../shared/client.js';
import type { Incident, ServiceView, Summary, WorkspaceView } from '../shared/types.js';
import { findConfig, CONFIG_FILES } from '../core/find-config.js';
import { openUrl } from '../core/platform/index.js';
import { paths } from '../core/paths.js';
import { importJsrunner } from './import-jsrunner.js';
import { HELP, CONFIG_HELP, COMMANDS } from './help.js';
import { ago, bytes, color, healthText, incidentLine, parseSince, STATUS_ICON, table, workspaceTable } from './format.js';

declare const __DEVPILOT_VERSION__: string;
const VERSION = typeof __DEVPILOT_VERSION__ === 'string' ? __DEVPILOT_VERSION__ : 'dev';

// ------------------------------------------------------------- arg parsing

interface Args {
  _: string[];
  flags: Record<string, string | boolean>;
}

const SHORT: Record<string, string> = { n: 'tail', f: 'follow', g: 'grep', w: 'wait', p: 'profile', h: 'help', j: 'json', a: 'all' };
const BOOL = new Set(['json', 'follow', 'wait', 'all', 'force', 'write', 'help', 'open', 'no-deps', 'no-browser', 'restart', 'keep-services', 'reveal', 'quiet', 'version']);

function parseArgs(argv: string[]): Args {
  const out: Args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      out._.push(...argv.slice(i + 1));
      break;
    }
    const m = a.match(/^--?([^=]+)(?:=(.*))?$/);
    if (!m || /^-\d/.test(a)) {
      out._.push(a);
      continue;
    }
    let name = m[1];
    if (!a.startsWith('--')) name = SHORT[name] || name;
    if (m[2] !== undefined) out.flags[name] = m[2];
    else if (BOOL.has(name) || i + 1 >= argv.length || argv[i + 1].startsWith('-')) out.flags[name] = true;
    else out.flags[name] = argv[++i];
  }
  return out;
}

const str = (v: string | boolean | undefined) => (typeof v === 'string' ? v : undefined);
const num = (v: string | boolean | undefined) => (typeof v === 'string' && v !== '' ? Number(v) : undefined);

function duration(v: string | boolean | undefined): number | undefined {
  const s = str(v);
  if (!s) return undefined;
  const m = s.match(/^(\d+)(ms|s|m)?$/);
  return m ? Number(m[1]) * ({ ms: 1, s: 1000, m: 60000 }[m[2] || 's'] as number) : undefined;
}

// ------------------------------------------------------------------ output

let JSON_MODE = false;
const print = (human: string | (() => string), data: unknown) => {
  if (JSON_MODE) process.stdout.write(JSON.stringify(data, null, 2) + '\n');
  else process.stdout.write((typeof human === 'function' ? human() : human) + '\n');
};
class CliError extends Error {
  constructor(
    message: string,
    public code = 1,
    public data?: unknown,
  ) {
    super(message);
  }
}

// --------------------------------------------------------------- resolving

const cwd = () => path.resolve(process.env.DEVPILOT_CWD || process.cwd());

/** The workspace for the current folder, registering its devpilot.yaml on first use. */
async function currentWorkspace(api: Client, args: Args, required = true): Promise<string | undefined> {
  const explicit = str(args.flags.ws) || str(args.flags.workspace);
  if (explicit) return explicit;
  const r = await api.get(`/api/resolve?cwd=${encodeURIComponent(cwd())}`);
  if (r.workspace) return r.workspace;
  const cfg = findConfig(cwd());
  if (cfg) {
    const w = await api.post('/api/workspaces', { path: cfg });
    if (!JSON_MODE) process.stderr.write(color.dim(`registered workspace ${w.id} (${cfg})\n`));
    return w.id;
  }
  if (required) throw new CliError(`No devpilot.yaml in ${cwd()} or its parents. Run \`devpilot init\` to create one, or pass --ws <workspace>.`, 2);
  return undefined;
}

async function resolveKey(api: Client, ref: string | undefined, args: Args): Promise<string> {
  if (!ref) throw new CliError('Which service? Pass a service name (see `devpilot status`).', 2);
  const ws = await currentWorkspace(api, args, false);
  const r = await api.get(`/api/resolve?ref=${encodeURIComponent(ref)}&cwd=${encodeURIComponent(cwd())}${ws ? '' : ''}`);
  return r.key as string;
}

const svcUrl = (key: string) => `/api/services/${key}`;

// ---------------------------------------------------------------- commands

type Handler = (args: Args) => Promise<void>;

function startLine(r: any): string {
  const name = r.key.split('/')[1];
  if (r.ok) return `${STATUS_ICON[r.status as keyof typeof STATUS_ICON] || ''} ${name} ${r.status}`;
  let s = `${color.red('✖')} ${name} ${r.status}: ${r.reason || 'failed'}`;
  if (r.suggestion) s += `\n    ${color.cyan('→')} ${r.suggestion}`;
  if (r.logs?.length) s += `\n${color.dim(r.logs.slice(-12).map((l: string) => '    │ ' + l).join('\n'))}\n    ${color.cyan('→')} devpilot diagnose ${name}`;
  return s;
}

const commands: Record<string, Handler> = {
  async init(args) {
    const dir = path.resolve(args._[1] || cwd());
    const api = await connect();
    const r = await api.post('/api/detect', { path: dir });
    if (!args.flags.write) {
      print(
        () =>
          `${r.existing ? color.yellow(`Note: ${path.basename(r.existing)} already exists — use --write --force to overwrite.\n`) : ''}` +
          `${color.dim(`Detected ${r.services.length} service(s) in ${dir}:`)}\n\n${r.yaml}\n${color.dim('Write it with: devpilot init --write')}`,
        r,
      );
      return;
    }
    if (r.existing && !args.flags.force) throw new CliError(`${r.existing} already exists (use --force to overwrite)`, 2);
    if (!r.services.length) throw new CliError('Nothing runnable detected; write devpilot.yaml by hand (see `devpilot help config`).', 2);
    const target = r.existing || path.join(dir, 'devpilot.yaml');
    fs.writeFileSync(target, r.yaml);
    const w = await api.post('/api/workspaces', { path: target });
    print(`${color.green('✔')} wrote ${target}\n${color.green('✔')} registered workspace ${w.id}${w.error ? `\n${color.red(w.error)}` : ''}\nNext: devpilot up`, { path: target, workspace: w.id, error: w.error, services: r.services });
  },

  async register(args) {
    const api = await connect();
    const w = await api.post('/api/workspaces', { path: path.resolve(args._[1] || cwd()), envProfile: str(args.flags.env) });
    if (w.error) throw new CliError(`registered ${w.id}, but the config is invalid:\n${w.error}`, 1, w);
    print(`${color.green('✔')} workspace ${w.id} (${w.configPath})`, w);
  },

  async unregister(args) {
    const api = await connect();
    const ws = args._[1] || (await currentWorkspace(api, args));
    await api.del(`/api/workspaces/${ws}`);
    print(`${color.green('✔')} stopped and removed ${ws}`, { ok: true, workspace: ws });
  },

  async up(args) {
    const api = await connect();
    const ws = await currentWorkspace(api, args);
    const view: WorkspaceView = (await api.get(`/api/summary?ws=${ws}`)).workspaces[0];
    let profile = str(args.flags.profile);
    let services: string[] | undefined;
    for (const a of args._.slice(1)) {
      if (view.profiles[a] && !profile && !services) profile = a;
      else (services ||= []).push(a);
    }
    const res = await api.post(`/api/workspaces/${ws}/up`, { profile, services, wait: !!args.flags.wait, mode: str(args.flags.mode) }, 15 * 60_000);
    const failed = res.filter((r: any) => !r.ok);
    print(() => res.map(startLine).join('\n') + (args.flags.wait || failed.length ? '' : color.dim('\n(started; readiness continues in the background — `devpilot status` or add --wait)')), res);
    if (failed.length) process.exitCode = 1;
  },

  async down(args) {
    const api = await connect({ start: false });
    const ws = await currentWorkspace(api, args);
    if (args._.length > 1) {
      const out: any[] = [];
      for (const ref of args._.slice(1)) out.push(await api.post(`${svcUrl(await resolveKey(api, ref, args))}/stop`));
      print(out.map((r) => `${STATUS_ICON[r.status as 'stopped']} ${r.key.split('/')[1]} ${r.status}${r.note ? color.dim(` (${r.note})`) : ''}`).join('\n'), out);
      return;
    }
    const out = await api.post(`/api/workspaces/${ws}/down`);
    print(out.length ? out.map((r: any) => `${STATUS_ICON[r.status as 'stopped']} ${r.key.split('/')[1]} ${r.status}`).join('\n') : 'nothing to stop', out);
  },

  async start(args) {
    const api = await connect();
    const out: any[] = [];
    for (const ref of args._.slice(1).length ? args._.slice(1) : [undefined]) {
      const key = await resolveKey(api, ref, args);
      out.push(await api.post(`${svcUrl(key)}/start`, { wait: !!args.flags.wait, deps: !args.flags['no-deps'], timeoutMs: duration(args.flags.timeout), mode: str(args.flags.mode) }, 15 * 60_000));
    }
    print(() => out.map(startLine).join('\n'), out.length === 1 ? out[0] : out);
    if (out.some((r) => !r.ok)) process.exitCode = 1;
  },

  async stop(args) {
    const api = await connect({ start: false });
    const out: any[] = [];
    for (const ref of args._.slice(1).length ? args._.slice(1) : [undefined]) out.push(await api.post(`${svcUrl(await resolveKey(api, ref, args))}/stop`));
    print(out.map((r) => `${STATUS_ICON[r.status as 'stopped']} ${r.key.split('/')[1]} ${r.status}${r.note ? color.dim(` (${r.note})`) : ''}`).join('\n'), out.length === 1 ? out[0] : out);
  },

  async restart(args) {
    const api = await connect();
    const out: any[] = [];
    for (const ref of args._.slice(1).length ? args._.slice(1) : [undefined]) {
      out.push(await api.post(`${svcUrl(await resolveKey(api, ref, args))}/restart`, { wait: !!args.flags.wait, timeoutMs: duration(args.flags.timeout) }, 15 * 60_000));
    }
    print(() => out.map(startLine).join('\n'), out.length === 1 ? out[0] : out);
    if (out.some((r) => !r.ok)) process.exitCode = 1;
  },

  async status(args) {
    const info = await findDaemon();
    if (!info) {
      print('devpilot daemon is not running — nothing is supervised. (`devpilot up` starts it.)', { daemon: false, workspaces: [] });
      return;
    }
    const api = await connect({ start: false });
    if (args._[1]) {
      const s: ServiceView = await api.get(svcUrl(await resolveKey(api, args._[1], args)));
      print(
        () =>
          [
            `${STATUS_ICON[s.status]} ${color.bold(s.name)} ${s.status}  ${color.dim(s.key)}`,
            `  run      ${s.run}`,
            `  mode     ${s.mode}${s.modes.length > 1 ? color.dim(`  (available: ${s.modes.join(', ')})`) : ''}`,
            s.tasks.length ? `  tasks    ${s.tasks.join(', ')}${s.task ? color.cyan(`  — running: ${s.task}`) : ''}` : '',
            `  cwd      ${s.cwd}`,
            s.port ? `  port     ${s.port}${s.url ? `  ${s.url}` : ''}` : '',
            `  health   ${healthText(s)}${s.health.lastError ? color.dim(` (${s.health.lastError})`) : ''}`,
            s.pid ? `  pid      ${s.pid}${s.image ? ` (${s.image})` : ''}${s.adopted ? ' adopted' : ''}  up ${ago(s.startedAt)}  cpu ${s.cpu ?? '-'}%  mem ${bytes(s.mem)}` : '',
            `  restarts ${s.restarts}${s.exitCode !== undefined && s.exitCode !== null ? `  last exit ${s.exitCode}` : ''}`,
            s.dependsOn.length ? `  deps     ${s.dependsOn.join(', ')}` : '',
            s.lastError ? `  error    ${color.red(s.lastError)}` : '',
            s.openIncidents ? `  ${color.yellow(`${s.openIncidents} open incident(s)`)} — devpilot incidents ${s.name}` : '',
          ]
            .filter(Boolean)
            .join('\n'),
        s,
      );
      return;
    }
    const ws = args.flags.all ? undefined : await currentWorkspace(api, args, false);
    const sum: Summary = await api.get(`/api/summary${ws ? `?ws=${ws}` : ''}`);
    print(() => {
      if (!sum.workspaces.length) return 'No workspaces registered. Run `devpilot init` in a project.';
      let out = sum.workspaces.map(workspaceTable).join('\n\n');
      if (sum.incidents.length) out += `\n\n${color.bold('Open incidents')}\n` + sum.incidents.slice(0, 8).map((i) => '  ' + incidentLine(i)).join('\n');
      return out + color.dim(`\n\ndaemon ${sum.version} pid ${sum.pid}, up ${ago(sum.startedAt)} — dashboard: devpilot open`);
    }, sum);
  },

  async ls(args) {
    args.flags.all = true;
    return commands.status(args);
  },

  async logs(args) {
    const api = await connect({ start: false });
    const key = await resolveKey(api, args._[1], args);
    const q = new URLSearchParams();
    const tail = num(args.flags.tail) ?? 100;
    q.set('tail', String(tail));
    if (str(args.flags.grep)) q.set('grep', str(args.flags.grep)!);
    if (str(args.flags.stream)) q.set('stream', str(args.flags.stream)!);
    const since = parseSince(str(args.flags.since));
    if (since) q.set('since', String(since));
    const r = await api.get(`${svcUrl(key)}/logs?${q}`);
    const fmt = (l: any) => (l.stream === 'err' ? color.red('│ ') : l.stream === 'sys' ? color.cyan('│ ') : color.dim('│ ')) + (args.flags.time ? color.dim(new Date(l.t).toLocaleTimeString() + ' ') : '') + l.text;
    if (!args.flags.follow) {
      print(() => (r.lines.length ? r.lines.map(fmt).join('\n') : color.dim('(no matching log lines)')), r);
      return;
    }
    if (!JSON_MODE) r.lines.forEach((l: any) => console.log(fmt(l)));
    let after = r.lastSeq;
    const grep = str(args.flags.grep);
    for (;;) {
      await new Promise((res) => setTimeout(res, 700));
      const n = await api.get(`${svcUrl(key)}/logs?after=${after}${grep ? `&grep=${encodeURIComponent(grep)}` : ''}`);
      after = n.lastSeq;
      for (const l of n.lines) console.log(JSON_MODE ? JSON.stringify(l) : fmt(l));
    }
  },

  async incidents(args) {
    const api = await connect({ start: false });
    if (args._[1] === 'clear') {
      const body = args._[2] ? { key: await resolveKey(api, args._[2], args) } : { ws: args.flags.all ? undefined : await currentWorkspace(api, args, false) };
      const r = await api.post('/api/incidents/resolve', body);
      print(`${color.green('✔')} resolved ${r.resolved} incident(s)`, r);
      return;
    }
    const q = new URLSearchParams();
    if (args._[1]) q.set('key', await resolveKey(api, args._[1], args));
    else if (!args.flags.all) {
      const ws = await currentWorkspace(api, args, false);
      if (ws) q.set('ws', ws);
    }
    if (args.flags.open) q.set('open', '1');
    const since = parseSince(str(args.flags.since));
    if (since) q.set('since', String(since));
    q.set('limit', String(num(args.flags.limit) ?? 20));
    const list: Incident[] = await api.get(`/api/incidents?${q}`);
    const verbose = !!args.flags.verbose || !!args._[1];
    print(() => (list.length ? list.map((i) => incidentLine(i) + (verbose && i.context.length ? '\n' + color.dim(i.context.slice(-15).map((l) => '    │ ' + l).join('\n')) : '')).join('\n') : 'No incidents.'), list);
  },

  async diagnose(args) {
    const api = await connect({ start: false });
    const key = await resolveKey(api, args._[1], args);
    const d = await api.get(`${svcUrl(key)}/diagnose`);
    print(() => {
      const lvl = { error: color.red('✖'), warning: color.yellow('⚠'), info: color.blue('ℹ') } as const;
      const lines = [`${STATUS_ICON[d.service.status as 'running']} ${color.bold(d.service.name)} ${d.service.status} — ${d.verdict}`, ''];
      for (const f of d.findings) {
        lines.push(`${lvl[f.level as 'error']} ${f.title}`);
        if (f.detail) lines.push(color.dim(`    ${f.detail}`));
        if (f.suggestion) lines.push(`    ${color.cyan('→')} ${f.suggestion}`);
      }
      if (d.errorBlock.length) lines.push('', color.bold('Error block'), ...d.errorBlock.slice(-25).map((l: string) => color.dim('  │ ') + l));
      else if (d.recentLogs.length) lines.push('', color.bold('Recent logs'), ...d.recentLogs.slice(-15).map((l: string) => color.dim('  │ ') + l));
      return lines.join('\n');
    }, d);
  },

  async metrics(args) {
    const api = await connect({ start: false });
    const key = await resolveKey(api, args._[1], args);
    const range = str(args.flags.range) || '15m';
    const r = await api.get(`${svcUrl(key)}/metrics?range=${range}`);
    print(() => {
      const pts = r.points as Array<{ cpu: number; mem: number; latency?: number }>;
      if (!pts.length) return 'No samples yet (the service must be running).';
      const spark = (vals: number[]) => {
        const max = Math.max(...vals, 1e-9);
        const bars = '▁▂▃▄▅▆▇█';
        const step = Math.max(1, Math.floor(vals.length / 60));
        return vals.filter((_, i) => i % step === 0).map((v) => bars[Math.min(7, Math.floor((v / max) * 7.99))]).join('');
      };
      const cpu = pts.map((p) => p.cpu);
      const mem = pts.map((p) => p.mem);
      const lat = pts.map((p) => p.latency).filter((x): x is number => x !== undefined);
      const avg = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
      return [
        `${color.bold(key)} last ${range} (${pts.length} samples)`,
        `cpu  ${spark(cpu)}  avg ${avg(cpu).toFixed(1)}%  max ${Math.max(...cpu).toFixed(1)}%`,
        `mem  ${spark(mem)}  now ${bytes(mem[mem.length - 1])}  max ${bytes(Math.max(...mem))}`,
        lat.length ? `lat  ${spark(lat)}  avg ${avg(lat).toFixed(0)}ms  max ${Math.max(...lat)}ms` : '',
      ]
        .filter(Boolean)
        .join('\n');
    }, r);
  },

  async env(args) {
    const api = await connect();
    if (args._[1] === 'use') {
      const ws = await currentWorkspace(api, args);
      const profile = args._[2] === 'none' || args._[2] === 'default' ? undefined : args._[2];
      const r = await api.post(`/api/workspaces/${ws}/env`, { profile, restart: !!args.flags.restart });
      print(`${color.green('✔')} env profile: ${profile || '(none)'}${r.restarted.length ? ` — restarted ${r.restarted.join(', ')}` : args.flags.restart ? '' : color.dim(' — running services keep their old env until restarted (add --restart)')}`, r);
      return;
    }
    if (!args._[1]) {
      const ws = await currentWorkspace(api, args);
      const v: WorkspaceView = (await api.get(`/api/summary?ws=${ws}`)).workspaces[0];
      print(`active env profile: ${v.envProfile || '(none)'}\navailable: ${v.envProfiles.join(', ') || '(none defined in devpilot.yaml)'}\nswitch: devpilot env use <profile> [--restart]`, { active: v.envProfile ?? null, available: v.envProfiles });
      return;
    }
    const key = await resolveKey(api, args._[1], args);
    const r = await api.get(`${svcUrl(key)}/env${args.flags.reveal ? '?reveal=1' : ''}`);
    print(() => [...r.envFiles.map((f: any) => `${f.exists ? color.green('✔') : color.red('✖ missing')} ${f.path}`), '', ...r.vars.map((v: any) => `${v.key}=${v.value}`)].join('\n'), r);
  },

  async ports(args) {
    const api = await connect();
    if (args._[1] === 'kill') {
      const port = Number(args._[2]);
      if (!port) throw new CliError('usage: devpilot ports kill <port> --force', 2);
      try {
        const r = await api.post(`/api/ports/${port}/kill`, { force: !!args.flags.force });
        print(`${color.green('✔')} killed PID ${r.pid} (${r.name}) on port ${port}`, r);
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) throw new CliError(`Port ${port} is held by PID ${e.body.pid} (${e.body.name}): ${e.body.cmd}\nRe-run with --force to kill it.`, 3, e.body);
        throw e;
      }
      return;
    }
    const rows: any[] = await api.get('/api/ports');
    const filtered = args.flags.all ? rows : rows.filter((r) => r.port >= 1024 && r.port < 49152);
    print(() => table([[color.dim('PORT'), color.dim('PID'), color.dim('PROCESS'), color.dim('SERVICE'), color.dim('COMMAND')], ...filtered.map((r) => [String(r.port), String(r.pid), r.name, r.service ? color.green(r.service) : r.configuredBy.length ? color.red(`conflicts with ${r.configuredBy.join(',')}`) : '', color.dim(r.cmd.slice(0, 80))])]), filtered);
  },

  async open(args) {
    const api = await connect();
    const { code } = await api.post('/api/auth/code');
    let to = '/';
    if (args._[1]) to = `/#/service/${await resolveKey(api, args._[1], args)}`;
    const url = `${api.baseUrl}/auth?code=${code}&to=${encodeURIComponent(to)}`;
    const opened = !args.flags['no-browser'] && openUrl(url);
    print(`${opened ? 'Opened' : 'Open'} the dashboard: ${url}${opened ? '' : ''}\n${color.dim('(one-time link, valid 5 minutes; the browser then stays logged in for 30 days)')}`, { url, opened });
  },

  async watch(args) {
    // Used by the plugin monitor: one line per event Claude should know about.
    // Never starts the daemon; waits for it instead.
    const scopeAll = !!args.flags.all;
    const lastErrorLog = new Map<string, number>();
    const emit = (line: string, data: unknown) => {
      process.stdout.write((JSON_MODE ? JSON.stringify(data) : line) + '\n');
    };
    let announcedWaiting = false;
    for (;;) {
      const info = await findDaemon();
      if (!info) {
        if (!announcedWaiting && !args.flags.quiet) emit('[devpilot] daemon not running — watching will begin once it starts', { type: 'waiting' });
        announcedWaiting = true;
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }
      announcedWaiting = false;
      try {
        const api = await connect({ start: false });
        const ws = scopeAll ? undefined : await currentWorkspace(api, args, false);
        const prev = new Map<string, string>();
        const seen = new Set<string>();
        for (const w of (await api.get<Summary>(`/api/summary${ws ? `?ws=${ws}` : ''}`)).workspaces) for (const s of w.services) prev.set(s.key, s.status);
        for await (const ev of api.events(`?types=incident,status${ws ? `&ws=${ws}` : ''}`)) {
          if (ev.event === 'incident') {
            const i: Incident = ev.data.incident;
            if (i.resolvedAt) continue;
            // Repeats are folded into the same incident: report it once, plus
            // when it escalates (e.g. "gave up after N restarts").
            const sig = `${i.id}:${i.title}`;
            if (seen.has(sig)) continue;
            seen.add(sig);
            if (i.kind === 'error-log') {
              const last = lastErrorLog.get(i.key) || 0;
              if (Date.now() - last < 60_000) continue;
              lastErrorLog.set(i.key, Date.now());
            }
            const ctx = i.context
              .map((l) => l.replace(/^! /, '').trim())
              .filter((l) => l && !/^at (node:|process\.|listOnTimeout|Module\.|new Promise)|^Node\.js v\d|^\^+$|^\(Use `node --trace/.test(l))
              .slice(-8)
              .join(' ⏎ ')
              .slice(0, 700);
            emit(
              `[devpilot] ${i.severity === 'error' ? 'ERROR' : 'WARN'} ${i.key}: ${i.title}${i.count > 1 ? ` (×${i.count})` : ''}${ctx ? ` | ${ctx}` : ''} | details: mcp__devpilot-panel__diagnose (service ${i.key})`,
              { type: 'incident', incident: i },
            );
          } else if (ev.event === 'status') {
            const s: ServiceView = ev.data.service;
            const before = prev.get(s.key);
            prev.set(s.key, s.status);
            if (s.status === 'running' && before && ['crashed', 'backoff', 'unhealthy'].includes(before)) emit(`[devpilot] OK ${s.key} recovered (${before} → running)`, { type: 'recovered', service: s });
          }
        }
      } catch {
        /* daemon went away: loop and wait */
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  },

  async daemon(args) {
    const sub = args._[1] || 'status';
    if (sub === 'start') {
      const api = await connect();
      print(`daemon running on ${api.baseUrl}`, readDaemonInfo());
    } else if (sub === 'stop' || sub === 'restart') {
      const info = await findDaemon();
      if (info) {
        const api = await connect({ start: false });
        await api.post('/api/daemon/shutdown', { keepServices: !!args.flags['keep-services'] || sub === 'restart' });
        const deadline = Date.now() + 60_000;
        while ((await findDaemon()) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
      }
      if (sub === 'restart') {
        const api = await connect();
        print(`daemon restarted on ${api.baseUrl} (services kept running and were re-attached)`, readDaemonInfo());
      } else print(info ? `daemon stopped${args.flags['keep-services'] ? ' (services left running)' : ' (services stopped)'}` : 'daemon was not running', { ok: true });
    } else {
      const info = await findDaemon();
      print(info ? `running: pid ${info.pid}, http://127.0.0.1:${info.port}, version ${info.version}, up ${ago(info.startedAt)}\nlog: ${paths.daemonLog}` : `not running\nlog: ${paths.daemonLog}`, { running: !!info, ...(info ? { pid: info.pid, port: info.port, version: info.version, startedAt: info.startedAt } : {}) });
    }
  },

  async 'import-jsrunner'(args) {
    const res = importJsrunner({ source: str(args.flags.from), write: !!args.flags.write, force: !!args.flags.force });
    if (args.flags.write) {
      const api = await connect();
      for (const f of res.files.filter((f) => f.written)) await api.post('/api/workspaces', { path: f.path }).catch(() => undefined);
    }
    print(() => res.files.map((f) => `${f.written ? color.green('✔ wrote') : f.skipped ? color.yellow('• skipped') : color.dim('• would write')} ${f.path} (${f.services} services)${f.skipped ? color.dim(` — ${f.skipped}`) : ''}`).join('\n') + (args.flags.write ? '' : color.dim('\nDry run. Add --write to create the files.')), res);
  },

  async mode(args) {
    const api = await connect();
    const ws = await currentWorkspace(api, args);
    const sub = args._[1];
    if (sub === 'use' || sub === 'reset') {
      const mode = sub === 'reset' ? 'default' : args._[2];
      if (!mode) throw new CliError('usage: devpilot mode use <mode> [service...] [--restart]', 2);
      const services = args._.slice(sub === 'reset' ? 2 : 3);
      const r = await api.post(`/api/workspaces/${ws}/mode`, { mode, services: services.length ? services : undefined, restart: !!args.flags.restart });
      const name = (k: string) => k.split('/')[1];
      print(
        () =>
          `${color.green('✔')} mode ${color.bold(mode)}${services.length ? ` for ${services.join(', ')}` : ' for the workspace'}` +
          (r.changed.length ? `\n  changed: ${r.changed.map(name).join(', ')}` : color.dim('\n  (no service changed mode)')) +
          (r.restarted.length ? `\n  restarting: ${r.restarted.map(name).join(', ')}` : '') +
          (r.needsRestart.length ? color.yellow(`\n  running with the old mode until restarted: ${r.needsRestart.map(name).join(', ')} (add --restart)`) : ''),
        r,
      );
      return;
    }
    const view: WorkspaceView = (await api.get(`/api/summary?ws=${ws}`)).workspaces[0];
    print(
      () =>
        [
          `workspace mode: ${color.bold(view.mode)}   available: ${view.modes.join(', ')}`,
          '',
          table([[color.dim('SERVICE'), color.dim('MODE'), color.dim('MODES')], ...view.services.map((s) => [s.name, s.mode === 'default' ? color.dim(s.mode) : color.cyan(s.mode), color.dim(s.modes.join(', '))])]),
          '',
          color.dim('switch: devpilot mode use <mode> [service...] [--restart]   ·   back: devpilot mode reset [service...]'),
        ].join('\n'),
      { mode: view.mode, modes: view.modes, services: view.services.map((s) => ({ name: s.name, mode: s.mode, modes: s.modes })) },
    );
  },

  async task(args) {
    const api = await connect();
    const ws = await currentWorkspace(api, args);
    const sub = args._[1];
    if (!sub || sub === 'list' || sub === 'ls') {
      const info = await api.get(`/api/workspaces/${ws}/tasks`);
      print(() => {
        const lines: string[] = [];
        if (info.workspace.length) lines.push(color.bold('Workspace tasks'), ...info.workspace.map((t: any) => `  ${t.name.padEnd(14)} ${color.dim(t.run)}`));
        for (const [svc, ts] of Object.entries(info.services) as [string, any[]][]) lines.push(color.bold(svc), ...ts.map((t) => `  ${t.name.padEnd(14)} ${color.dim(t.run)}${t.stopService ? color.dim(' (stops the service)') : ''}`));
        if (!lines.length) lines.push('No tasks defined. Add `tasks:` to devpilot.yaml (see `devpilot help config`).');
        if (info.runs.length) {
          lines.push('', color.bold('Recent runs'));
          for (const r of info.runs.slice(0, 10)) {
            const st = r.status === 'ok' ? color.green('✔') : r.status === 'running' ? color.cyan('◌') : r.status === 'cancelled' ? color.dim('■') : color.red('✖');
            lines.push(`  ${st} ${r.task}${r.service ? ` (${r.service})` : ''} ${color.dim(`${ago(r.startedAt)} ago${r.endedAt ? `, ${((r.endedAt - r.startedAt) / 1000).toFixed(1)}s` : ''}`)} ${color.dim(`[${r.id}]`)}`);
          }
        }
        return lines.join('\n');
      }, info);
      return;
    }
    if (sub === 'cancel') {
      const r = await api.post(`/api/tasks/${args._[2]}/cancel`);
      print(`■ ${r.task} ${r.status}`, r);
      return;
    }
    // devpilot task run <task> [service] | devpilot task <task> [service]
    const name = sub === 'run' ? args._[2] : sub;
    const service = sub === 'run' ? args._[3] : args._[2];
    if (!name) throw new CliError('usage: devpilot task run <task> [service] [--all] [--detach]', 2);
    if (args.flags.all) {
      const r = await api.post(`/api/workspaces/${ws}/tasks`, { task: name, all: true, wait: !args.flags.detach }, 60 * 60_000);
      print(() => (Array.isArray(r) ? r.map((x: any) => `${x.status === 'ok' ? color.green('✔') : color.red('✖')} ${name} (${x.service})`).join('\n') : `started ${name} for ${r.services.join(', ')}`), r);
      if (Array.isArray(r) && r.some((x: any) => x.status !== 'ok')) process.exitCode = 1;
      return;
    }
    // Where its output will land, so following starts exactly at this run.
    const logKey = service ? `${ws}/${service}` : `${ws}/tasks`;
    let after: number | undefined = (await api.get(`/api/services/${logKey}/logs?tail=1`)).lastSeq;
    const run = await api.post(`/api/workspaces/${ws}/tasks`, { task: name, service });
    if (args.flags.detach) {
      print(`started task ${name} [${run.id}] — logs: devpilot logs ${run.logKey}`, run);
      return;
    }
    let cur: any = run;
    for (;;) {
      const logs: any = await api.get(`/api/services/${run.logKey}/logs?after=${after ?? 0}`);
      after = logs.lastSeq;
      if (!JSON_MODE) for (const l of logs.lines) console.log((l.stream === 'err' ? color.red('│ ') : l.stream === 'sys' ? color.cyan('│ ') : color.dim('│ ')) + l.text);
      if (cur.status !== 'running') break;
      await new Promise((r) => setTimeout(r, 500));
      cur = await api.get(`/api/tasks/${run.id}`);
    }
    if (JSON_MODE) print('', cur);
    if (cur.status !== 'ok') process.exitCode = typeof cur.exitCode === 'number' && cur.exitCode > 0 ? cur.exitCode : 1;
  },

  async help(args) {
    if (args._[1] === 'config') return print(CONFIG_HELP, { config: CONFIG_HELP });
    print(HELP, { version: VERSION, commands: COMMANDS });
  },

  async version() {
    print(`devpilot ${VERSION}`, { version: VERSION });
  },
};

const ALIASES: Record<string, string> = { ps: 'status', st: 'status', log: 'logs', diag: 'diagnose', doctor: 'diagnose', '--version': 'version', '-v': 'version' };

/** Lets the desktop panel (which cannot locate this plugin) start the daemon. */
function recordInstall() {
  try {
    const file = path.join(paths.home, 'install.json');
    const info = { node: process.execPath, cli: fileURLToPath(import.meta.url), version: VERSION };
    const cur = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    if (cur !== JSON.stringify(info)) {
      fs.mkdirSync(paths.home, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(info));
    }
  } catch {
    /* best effort */
  }
}

async function main() {
  recordInstall();
  const args = parseArgs(process.argv.slice(2));
  JSON_MODE = !!args.flags.json;
  if (args.flags.version) args._.unshift('version');
  let cmd = args._[0] || (args.flags.help ? 'help' : 'status');
  cmd = ALIASES[cmd] || cmd;
  if (args.flags.help && cmd !== 'help') {
    args._ = ['help', cmd];
    cmd = 'help';
  }
  const handler = commands[cmd];
  if (!handler) throw new CliError(`Unknown command "${cmd}". Run \`devpilot help\`.`, 2);
  await handler(args);
}

main().catch((e) => {
  const code = e instanceof CliError ? e.code : 1;
  if (JSON_MODE) process.stdout.write(JSON.stringify({ error: e.message, ...(e.data || e.body ? { data: e.data || e.body } : {}) }, null, 2) + '\n');
  else process.stderr.write(`${color.red('error:')} ${e.message}\n`);
  process.exit(code);
});

export { CONFIG_FILES };
