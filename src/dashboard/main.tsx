import { render } from 'preact';
import type { ComponentChildren } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import './styles.css';
import type { Incident, LogLine, MetricPoint, ServiceView, WorkspaceView } from '../shared/types.js';
import { api, go, store, useHashRoute, useStore } from './store.js';
import { Badge, Button, copyText, Empty, IC, Icon, Input, Spinner, Stat, StatGrid, Tabs, ago, fmtCpu, healthText, isBusy, isFailing, isLive, mb, niceMax, seriesPaths, statusMeta, type Tone } from './ui.js';

// ------------------------------------------------------------------ toasts

type Toast = { id: number; text: string; ok: boolean };
let toastSeq = 0;
let toastList: Toast[] = [];
const toastSubs = new Set<() => void>();
function toast(text: string, ok = true) {
  const t = { id: ++toastSeq, text, ok };
  toastList = [...toastList, t].slice(-4);
  toastSubs.forEach((f) => f());
  setTimeout(() => {
    toastList = toastList.filter((x) => x.id !== t.id);
    toastSubs.forEach((f) => f());
  }, ok ? 3200 : 7000);
}
function Toasts() {
  const [, set] = useState(0);
  useEffect(() => {
    const f = () => set((n) => n + 1);
    toastSubs.add(f);
    return () => toastSubs.delete(f);
  }, []);
  return (
    <div class="toasts" aria-live="polite">
      {toastList.map((t) => (
        <div class="toast" key={t.id}>
          <span class="ti" style={{ background: t.ok ? 'var(--green-500)' : 'var(--red-500)' }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d={t.ok ? IC.check : IC.x} />
            </svg>
          </span>
          <span>{t.text}</span>
        </div>
      ))}
    </div>
  );
}

/** Run an API action; toast the outcome (failures carry the daemon's reason). */
async function act(label: string, fn: () => Promise<any>, okText?: string) {
  try {
    const r = await fn();
    const list = Array.isArray(r) ? r : [r];
    const bad = list.find((x) => x && x.ok === false);
    if (bad) toast(`${bad.key?.split('/')[1] || label}: ${bad.reason || 'failed'}${bad.suggestion ? ` — ${bad.suggestion}` : ''}`, false);
    else if (okText) toast(okText);
    return r;
  } catch (e: any) {
    toast(`${label}: ${e.message}`, false);
  }
}

// ------------------------------------------------------------------ confirmation
// Every action that changes what runs, or takes a while, asks first and says
// what it will touch. (A frozen page once replayed queued clicks straight into
// restarts and parallel builds; a confirmation stops that too.)

type Ask = { title: string; body: ComponentChildren; items?: { label: string; note?: string }[]; command?: string[]; confirmLabel: string; danger?: boolean };
let pendingAsk: (Ask & { resolve: (ok: boolean) => void }) | null = null;
const askSubs = new Set<() => void>();
function ask(a: Ask): Promise<boolean> {
  pendingAsk?.resolve(false);
  return new Promise((resolve) => {
    pendingAsk = {
      ...a,
      resolve: (ok) => {
        pendingAsk = null;
        askSubs.forEach((f) => f());
        resolve(ok);
      },
    };
    askSubs.forEach((f) => f());
  });
}

function ConfirmDialog() {
  const [, set] = useState(0);
  useEffect(() => {
    const f = () => set((n) => n + 1);
    askSubs.add(f);
    return () => askSubs.delete(f);
  }, []);
  const okRef = useRef<HTMLButtonElement>(null);
  const a = pendingAsk;
  useEffect(() => {
    if (!a) return;
    okRef.current?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') a.resolve(false);
    };
    addEventListener('keydown', key);
    return () => removeEventListener('keydown', key);
  }, [a]);
  if (!a) return null;
  return (
    <div class="palette-wrap" style={{ alignItems: 'center', paddingTop: '16px' }}>
      <button class="btn-reset palette-veil" aria-label="Cancel" onClick={() => a.resolve(false)} />
      <div class="palette" role="alertdialog" aria-modal="true" aria-labelledby="dp-ask-title" style={{ maxWidth: '520px', padding: '22px 22px 18px' }}>
        <div class="stack" style={{ gap: '14px' }}>
          <div class="row" style={{ gap: '12px', flexWrap: 'nowrap', alignItems: 'flex-start' }}>
            <span class={`ico ${a.danger ? 'danger' : 'info'}`} style={{ width: '36px', height: '36px', borderRadius: '11px' }}>
              <Icon d={a.danger ? IC.alert : IC.info} size={17} stroke={2} />
            </span>
            <div class="stack" style={{ gap: '6px', minWidth: 0 }}>
              <span id="dp-ask-title" style={{ fontSize: '17px', fontWeight: 500, letterSpacing: '-0.01em' }}>
                {a.title}
              </span>
              <span style={{ fontSize: '13.5px', color: 'var(--text-secondary)', lineHeight: 1.5 }}>{a.body}</span>
            </div>
          </div>
          {a.items && a.items.length > 0 && (
            <div class="list" style={{ borderRadius: '14px', maxHeight: '220px', overflowY: 'auto' }}>
              {a.items.map((it) => (
                <div class="row" key={it.label} style={{ gap: '10px', padding: '9px 14px', borderBottom: '1px solid var(--border-soft)', flexWrap: 'nowrap' }}>
                  <span style={{ fontSize: '13.5px', fontWeight: 500 }}>{it.label}</span>
                  {it.note && (
                    <span class="mono muted ellipsis" style={{ fontSize: '11.5px', marginLeft: 'auto' }}>
                      {it.note}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
          {a.command && a.command.length > 0 && (
            <div class="pre-dark" style={{ borderRadius: '12px', maxHeight: '160px' }}>
              {a.command.map((c) => `$ ${c}`).join('\n')}
            </div>
          )}
          <div class="row" style={{ gap: '8px', justifyContent: 'flex-end', paddingTop: '4px' }}>
            <Button variant="secondary" onClick={() => a.resolve(false)}>
              Cancel
            </Button>
            <button ref={okRef} type="button" class={`ds-btn ${a.danger ? 'danger' : 'primary'}`} onClick={() => a.resolve(true)}>
              {a.confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

const live = (s: ServiceView) => isLive(s) || isBusy(s) || isFailing(s);
const wsOf = (id: string) => store.state.workspaces.find((w) => w.id === id);

/** Services that (transitively) depend on `name` and are running: they lose their upstream. */
function dependents(ws: WorkspaceView | undefined, name: string): ServiceView[] {
  if (!ws) return [];
  const out = new Set<string>();
  let frontier = [name];
  while (frontier.length) {
    const next: string[] = [];
    for (const s of ws.services) if (!out.has(s.name) && s.dependsOn.some((d) => frontier.includes(d))) (out.add(s.name), next.push(s.name));
    frontier = next;
  }
  return ws.services.filter((s) => out.has(s.name) && live(s));
}

/** Upstream services a start will bring up first (not running yet). */
function upstreamToStart(ws: WorkspaceView | undefined, names: string[]): ServiceView[] {
  if (!ws) return [];
  const byName = new Map(ws.services.map((s) => [s.name, s]));
  const seen = new Set<string>();
  const walk = (n: string) => {
    for (const d of byName.get(n)?.dependsOn || []) if (!seen.has(d)) (seen.add(d), walk(d));
  };
  names.forEach(walk);
  return [...seen].map((n) => byName.get(n)!).filter((s) => s && s.status !== 'running' && !names.includes(s.name));
}

async function svcAction(s: ServiceView, a: 'start' | 'stop' | 'restart') {
  const ws = wsOf(s.workspace);
  if (a === 'stop') {
    const deps = dependents(ws, s.name);
    const ok = await ask({
      title: s.queued ? `Remove ${s.name} from the start queue?` : `Stop ${s.name}?`,
      body: s.queued ? 'It has not started yet; it will not be started.' : `Kills its process tree${s.pid ? ` (PID ${s.pid})` : ''}.${deps.length ? ` ${deps.length} running service${deps.length > 1 ? 's' : ''} depend${deps.length > 1 ? '' : 's'} on it and will lose ${s.name}:` : ''}`,
      items: deps.map((d) => ({ label: d.name, note: d.port ? `:${d.port}` : undefined })),
      confirmLabel: s.queued ? 'Remove from queue' : `Stop ${s.name}`,
      danger: true,
    });
    if (ok) await act(`stop ${s.name}`, () => api('POST', `/api/services/${s.key}/stop`, {}), `${s.name} stopped`);
    return;
  }
  const up = a === 'start' ? upstreamToStart(ws, [s.name]) : [];
  const ok = await ask({
    title: `${a === 'start' ? 'Start' : 'Restart'} ${s.name}?`,
    body:
      a === 'start'
        ? up.length
          ? `Its dependencies start first, each waited until ready:`
          : `Runs in mode “${s.mode}”.`
        : `Stops it and starts it again in mode “${s.mode}”. ${s.mode !== 'default' ? 'Tasks of this mode run before it starts (rebuild etc.), which can take a while.' : 'Requests in flight are dropped.'}`,
    items: up.map((d) => ({ label: d.name, note: d.port ? `:${d.port}` : undefined })),
    command: [`${s.run}`],
    confirmLabel: a === 'start' ? `Start ${s.name}` : `Restart ${s.name}`,
  });
  if (ok) await act(`${a} ${s.name}`, () => api('POST', `/api/services/${s.key}/${a}`, { background: true }), `${a === 'start' ? 'Starting' : 'Restarting'} ${s.name}…`);
}

async function startProfile(ws: WorkspaceView, profile: string) {
  const names = ws.profiles[profile] || [];
  const toStart = ws.services.filter((s) => names.includes(s.name) && !live(s));
  const extra = upstreamToStart(ws, names);
  if (!toStart.length && !extra.length) return toast(`Everything in “${profile}” is already running`);
  const ok = await ask({
    title: `Start profile “${profile}”?`,
    body: `Starts ${toStart.length + extra.length} service${toStart.length + extra.length > 1 ? 's' : ''} in dependency order; each waits for its dependencies to be ready. Already running services are left alone.`,
    items: [...extra, ...toStart].map((s) => ({ label: s.name, note: `${s.mode !== 'default' ? `mode ${s.mode} · ` : ''}${s.port ? `:${s.port}` : ''}` })),
    confirmLabel: `Start ${profile}`,
  });
  if (ok) await act('start', () => api('POST', `/api/workspaces/${ws.id}/up`, { profile, background: true }), `Starting ${profile}…`);
}

async function stopAll(ws: WorkspaceView) {
  const running = ws.services.filter(live);
  const ok = await ask({
    title: `Stop all services in ${ws.name}?`,
    body: `Stops ${running.length} service${running.length > 1 ? 's' : ''}, dependents first. Queued starts are cancelled.`,
    items: running.map((s) => ({ label: s.name, note: s.pid ? `PID ${s.pid}` : statusMeta(s).label })),
    confirmLabel: 'Stop all',
    danger: true,
  });
  if (ok) await act('stop all', () => api('POST', `/api/workspaces/${ws.id}/down`), `${ws.name} stopped`);
}

async function switchMode(ws: WorkspaceView, mode: string, service?: ServiceView) {
  const targets = service ? [service] : ws.services.filter((s) => s.modes.includes(mode) || (mode === 'default' && s.mode !== 'default'));
  const changing = targets.filter((s) => s.mode !== mode && (s.modes.includes(mode) || mode === 'default'));
  const restarting = changing.filter(live);
  if (!changing.length) return toast(`Already in mode “${mode}”`);
  const ok = await ask({
    title: `Switch ${service ? service.name : ws.name} to mode “${mode}”?`,
    body: restarting.length
      ? `${restarting.length} running service${restarting.length > 1 ? 's' : ''} will restart in the new mode${mode !== 'default' ? ', running the mode’s tasks (e.g. a build) first — this can take several minutes' : ''}. Stopped services just remember the mode.`
      : 'No running service is affected; the mode applies the next time they start.',
    items: changing.map((s) => ({ label: s.name, note: live(s) ? 'restarts' : 'next start' })),
    confirmLabel: restarting.length ? `Switch and restart ${restarting.length}` : 'Switch mode',
    danger: restarting.length > 0,
  });
  if (ok) await act('mode', () => api('POST', `/api/workspaces/${ws.id}/mode`, { mode, services: service ? [service.name] : undefined, restart: true }), `Mode ${mode}${restarting.length ? ` · restarting ${restarting.length}` : ''}`);
  else store.refresh(); // put a <select> back to the current value
}

async function switchEnv(ws: WorkspaceView, profile: string | undefined) {
  const running = ws.services.filter(live);
  const ok = await ask({
    title: `Use env profile “${profile || 'default'}”?`,
    body: running.length ? `${running.length} running service${running.length > 1 ? 's' : ''} restart to pick up the new environment.` : 'No service is running; it applies on the next start.',
    items: running.map((s) => ({ label: s.name, note: 'restarts' })),
    confirmLabel: running.length ? `Switch and restart ${running.length}` : 'Switch env',
    danger: running.length > 0,
  });
  if (ok) await act('env', () => api('POST', `/api/workspaces/${ws.id}/env`, { profile, restart: true }).then(() => store.refresh()), `Env profile ${profile || 'default'}`);
  else store.refresh();
}

async function runTask(ws: WorkspaceView, task: string, opts: { service?: ServiceView; all?: boolean } = {}) {
  let info: any;
  try {
    info = await api('GET', `/api/workspaces/${ws.id}/tasks`);
  } catch (e: any) {
    return toast(e.message, false);
  }
  type T = { name: string; run: string; cwd: string; stopService?: boolean };
  const rows: { svc?: string; t: T }[] = opts.all
    ? Object.entries(info.services as Record<string, T[]>).flatMap(([svc, ts]) => ts.filter((t) => t.name === task).map((t) => ({ svc, t })))
    : opts.service
      ? [{ svc: opts.service.name, t: ((info.services[opts.service.name] || []) as T[]).find((t) => t.name === task) || (info.workspace as T[]).find((t) => t.name === task)! }]
      : [{ t: (info.workspace as T[]).find((t) => t.name === task)! }];
  const valid = rows.filter((r) => r.t);
  const stops = valid.filter((r) => r.t.stopService && r.svc && live(ws.services.find((s) => s.name === r.svc)!));
  const ok = await ask({
    title: `Run task “${task}”${opts.service ? ` for ${opts.service.name}` : opts.all ? ` in ${valid.length} services` : ''}?`,
    body: `${opts.all ? 'Runs one after another. ' : ''}Output goes to ${opts.service || opts.all ? 'each service’s' : 'the workspace task'} log.${stops.length ? ` ${stops.map((r) => r.svc).join(', ')} will be stopped while it runs and started again after.` : ''}`,
    command: valid.map((r) => `${r.t.run}${valid.length > 1 || r.svc ? `   # ${r.svc ?? 'workspace'} · ${r.t.cwd}` : `   # ${r.t.cwd}`}`),
    confirmLabel: `Run ${task}`,
    danger: stops.length > 0,
  });
  if (!ok) return;
  await act(task, () => api('POST', `/api/workspaces/${ws.id}/tasks`, opts.all ? { task, all: true } : { task, service: opts.service?.name }), `Task ${task} started — follow it in the logs`);
  if (opts.service) go(`/service/${opts.service.key}/logs`);
}

// ------------------------------------------------------------------ dependency tiers

type Tier = { label: string; rows: ServiceView[] };

/** Columns for the dependency map: a declared `group`, else the depth in depends_on, named by what lives there. */
function tiersOf(services: ServiceView[]): Tier[] {
  const byName = new Map(services.map((s) => [s.name, s]));
  const depth = new Map<string, number>();
  const depthOf = (s: ServiceView, seen: Set<string>): number => {
    if (depth.has(s.name)) return depth.get(s.name)!;
    if (seen.has(s.name)) return 0;
    const next = new Set(seen).add(s.name);
    const ds = s.dependsOn.map((d) => byName.get(d)).filter((x): x is ServiceView => !!x);
    const v = ds.length ? 1 + Math.max(...ds.map((d) => depthOf(d, next))) : 0;
    depth.set(s.name, v);
    return v;
  };
  const label = (rows: ServiceView[], t: number) => {
    if (t === 0 && rows.every((r) => !r.port || /infra|db|redis|postgres|mysql|mongo|kafka|rabbit|compose/.test(r.name))) return 'Infra';
    if (rows.every((r) => /bff|gateway/.test(r.name))) return 'Gateway';
    if (rows.every((r) => /front|web|ui|app|portal|admin/.test(r.name))) return 'Frontend';
    return t <= 1 ? 'Domain services' : `Tier ${t + 1}`;
  };
  const named = new Map<string, ServiceView[]>();
  const tiers = new Map<number, ServiceView[]>();
  for (const s of services) {
    if (s.group) named.set(s.group, [...(named.get(s.group) || []), s]);
    else {
      const t = depthOf(s, new Set());
      tiers.set(t, [...(tiers.get(t) || []), s]);
    }
  }
  return [
    ...[...tiers.keys()].sort((a, b) => a - b).map((t) => ({ label: label(tiers.get(t)!, t), rows: tiers.get(t)! })),
    ...[...named.entries()].map(([label, rows]) => ({ label, rows })),
  ];
}

// ------------------------------------------------------------------ shell

function Header({ onPalette }: { onPalette: () => void }) {
  const st = useStore();
  return (
    <header class="header">
      <div class="brand">
        <div class="logo">D</div>
        <span style={{ fontSize: '16px', fontWeight: 600, letterSpacing: '-0.02em' }}>DevPilot</span>
        {st.version && <span class="version">v{st.version}</span>}
      </div>
      <button class="btn-reset search" onClick={onPalette}>
        <Icon d={IC.search} />
        <span style={{ flex: 1 }}>Search services, ports, actions…</span>
        <span class="kbd">{navigator.platform.toLowerCase().includes('mac') ? '⌘K' : 'Ctrl K'}</span>
      </button>
      <div class="live">
        <span class={`dot ${st.connected ? 'run' : 'err'}`} />
        <span style={{ color: st.connected ? 'var(--status-success-text)' : 'var(--status-danger-text)', fontWeight: 500 }}>{st.connected ? 'Live' : 'Offline'}</span>
        <span class="faint">·</span>
        <span class="tnum">daemon up {ago(st.daemonStartedAt)}</span>
      </div>
    </header>
  );
}

function Sidebar({ activeWs, page, onPalette }: { activeWs?: string; page: string; onPalette: () => void }) {
  const st = useStore();
  const openInc = st.incidents.length;
  return (
    <nav class="side" aria-label="Main">
      <div class="side-group">
        <div class="overline">Workspaces</div>
        {st.workspaces.map((w) => {
          const up = w.services.filter((s) => s.status === 'running').length;
          const bad = w.services.some(isFailing);
          return (
            <button class={`btn-reset nav${activeWs === w.id && (page === 'ws' || page === '') ? ' on' : ''}`} onClick={() => go(`/ws/${w.id}`)} key={w.id}>
              <span class="row1">
                <span class={`dot ${bad ? 'err' : up ? 'run' : 'stop'}`} />
                <span class="name ellipsis">{w.name}</span>
                <span class="count">
                  {up}/{w.services.length}
                </span>
              </span>
              <span class="bar-track">
                <span class="bar-fill" style={{ width: `${w.services.length ? Math.round((up / w.services.length) * 100) : 0}%`, background: bad ? 'var(--red-500)' : undefined }} />
              </span>
            </button>
          );
        })}
      </div>
      <div class="side-group">
        <div class="overline">Monitor</div>
        <button class={`btn-reset nav${page === 'incidents' ? ' on' : ''}`} onClick={() => go('/incidents')}>
          <span class="row1">
            <Icon d={IC.alert} size={17} stroke={1.7} />
            <span class="name">Incidents</span>
            {openInc > 0 && <Badge tone="danger">{openInc} open</Badge>}
          </span>
        </button>
        <button class={`btn-reset nav${page === 'ports' ? ' on' : ''}`} onClick={() => go('/ports')}>
          <span class="row1">
            <Icon d={IC.plug} size={17} stroke={1.7} />
            <span class="name">Ports</span>
          </span>
        </button>
      </div>
      <div class="jump">
        <span style={{ color: 'var(--text-secondary)', fontWeight: 500 }}>Quick jump</span>
        <span class="muted" style={{ lineHeight: 1.5 }}>
          Open the command bar to jump to any service, port or action.
        </span>
        <button class="btn-reset" onClick={onPalette} style={{ color: 'var(--aurora-blue-deep)', fontWeight: 500, paddingTop: '2px' }}>
          Open command bar →
        </button>
      </div>
    </nav>
  );
}

// ------------------------------------------------------------------ command bar

type PalItem = { label: string; hint: string; icon: string; run: () => void };

function Palette({ onClose }: { onClose: () => void }) {
  const st = useStore();
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const items = useMemo<PalItem[]>(() => {
    const out: PalItem[] = [];
    for (const w of st.workspaces) out.push({ label: `Overview · ${w.name}`, hint: 'page', icon: IC.grid, run: () => go(`/ws/${w.id}`) });
    out.push({ label: 'Incidents', hint: `${st.incidents.length} open`, icon: IC.alert, run: () => go('/incidents') });
    out.push({ label: 'Ports', hint: 'page', icon: IC.plug, run: () => go('/ports') });
    for (const w of st.workspaces)
      for (const s of w.services) out.push({ label: s.name, hint: `${s.port ? ':' + s.port : 'no port'} · ${statusMeta(s).label}${st.workspaces.length > 1 ? ` · ${w.name}` : ''}`, icon: IC.box, run: () => go(`/service/${s.key}/logs`) });
    for (const w of st.workspaces) {
      for (const p of Object.keys(w.profiles)) out.push({ label: `Start profile “${p}”`, hint: w.name, icon: IC.play, run: () => void startProfile(w, p) });
      out.push({ label: `Stop all in ${w.name}`, hint: 'action', icon: IC.stop, run: () => void stopAll(w) });
      if (w.modes.length > 1) for (const m of w.modes) if (m !== w.mode) out.push({ label: `Switch to mode “${m}”`, hint: w.name, icon: IC.layers, run: () => void switchMode(w, m) });
      for (const t of w.tasks) out.push({ label: `Run task “${t}”`, hint: w.name, icon: IC.task, run: () => void runTask(w, t) });
    }
    const qq = q.toLowerCase().trim();
    return out.filter((it) => !qq || `${it.label} ${it.hint}`.toLowerCase().includes(qq)).slice(0, 14);
  }, [st, q]);
  const pick = (it?: PalItem) => {
    if (!it) return;
    onClose();
    it.run();
  };
  return (
    <div class="palette-wrap">
      <button class="btn-reset palette-veil" aria-label="Close command bar" onClick={onClose} />
      <div class="palette" role="dialog" aria-label="Command bar">
        <div style={{ padding: '14px 14px 10px', borderBottom: '1px solid var(--border-soft)' }}>
          <Input
            value={q}
            onInput={(v) => {
              setQ(v);
              setSel(0);
            }}
            placeholder="Jump to a service, page or action"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Escape') onClose();
              else if (e.key === 'ArrowDown') (e.preventDefault(), setSel((i) => Math.min(items.length - 1, i + 1)));
              else if (e.key === 'ArrowUp') (e.preventDefault(), setSel((i) => Math.max(0, i - 1)));
              else if (e.key === 'Enter') pick(items[sel]);
            }}
          />
        </div>
        <div style={{ maxHeight: '380px', overflowY: 'auto', padding: '8px' }}>
          {!items.length && <div style={{ padding: '24px', textAlign: 'center', fontSize: '13px' }} class="muted">No match for that search</div>}
          {items.map((it, i) => (
            <button class={`btn-reset pal-item${i === sel ? ' sel' : ''}`} key={it.label + it.hint} onClick={() => pick(it)} onMouseEnter={() => setSel(i)}>
              <span class="pal-ico">
                <Icon d={it.icon} size={15} />
              </span>
              <span style={{ flex: 1, fontSize: '13.5px', fontWeight: 500 }}>{it.label}</span>
              <span class="mono muted" style={{ fontSize: '11.5px' }}>
                {it.hint}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ overview

function Spark({ values, color, gradient }: { values: number[]; color: string; gradient: string }) {
  const max = Math.max(1e-6, ...values) * 1.25;
  const p = seriesPaths(values.slice(-30), 120, 40, max);
  return (
    <svg class="dp-wipe" viewBox="0 0 120 40" preserveAspectRatio="none" style={{ width: '100%', height: '40px', display: 'block' }} aria-hidden="true">
      <path d={p.area} fill={`url(#${gradient})`} />
      <path d={p.line} fill="none" stroke={color} stroke-width="1.5" vector-effect="non-scaling-stroke" stroke-linejoin="round" />
    </svg>
  );
}

function ServiceCard({ s, index }: { s: ServiceView; index: number }) {
  const st = useStore();
  const pts = st.spark.get(s.key) || [];
  const m = statusMeta(s);
  const alive = s.status === 'running' || s.status === 'unhealthy';
  const busy = isBusy(s);
  const failing = isFailing(s);
  return (
    <article class="card dp-rise" style={{ animationDelay: `${index * 50}ms` }}>
      <div class="row" style={{ justifyContent: 'space-between', gap: '10px', flexWrap: 'nowrap' }}>
        <button class="btn-reset row" onClick={() => go(`/service/${s.key}/logs`)} style={{ gap: '10px', minWidth: 0, flexWrap: 'nowrap', borderRadius: '8px' }}>
          <span class={`dot ${m.dot}`} />
          <span class="ellipsis" style={{ fontSize: '15px', fontWeight: 500, letterSpacing: '-0.01em' }}>
            {s.name}
          </span>
          {s.mode !== 'default' && <span class="tag-mode">{s.mode}</span>}
        </button>
        <Badge tone={m.tone} dot>
          {m.label}
        </Badge>
      </div>
      <div class="meta">
        {s.port ? (
          <a href={s.url} target="_blank" rel="noreferrer">
            :{s.port}
          </a>
        ) : (
          <span>no port</span>
        )}
        <span style={{ color: s.health.state === 'ok' ? 'var(--status-success-text)' : s.health.state === 'failing' ? 'var(--status-danger-text)' : 'var(--text-faint)' }}>{healthText(s)}</span>
        <span>{alive ? `up ${ago(s.startedAt)}` : busy ? '' : 'not running'}</span>
        {s.image && <span>{s.image}</span>}
      </div>
      {alive && pts.length > 1 ? (
        <div class="spark-grid">
          <div class="stack" style={{ gap: '6px' }}>
            <div class="spark-head">
              <span>CPU</span>
              <span class="mono tnum" style={{ color: 'var(--text-secondary)' }}>
                {fmtCpu(s.cpu ?? 0)}
              </span>
            </div>
            <Spark values={pts.map((p) => p.cpu)} color="#720455" gradient="dp-g-cpu" />
          </div>
          <div class="stack" style={{ gap: '6px' }}>
            <div class="spark-head">
              <span>Memory</span>
              <span class="mono tnum" style={{ color: 'var(--text-secondary)' }}>
                {mb(s.mem)}
              </span>
            </div>
            <Spark values={pts.map((p) => p.mem)} color="#7A5CF0" gradient="dp-g-mem" />
          </div>
        </div>
      ) : (
        <div class="dead">
          {busy && <Spinner />}
          <span class="ellipsis">{s.task ? `Running ${s.task}…` : s.queued ? 'Queued · waiting for dependencies' : s.status === 'stopping' ? 'Stopping…' : busy ? 'Waiting for health check…' : alive ? 'Collecting metrics…' : 'Stopped · no metrics'}</span>
        </div>
      )}
      {(failing || s.openIncidents > 0) && (
        <button class={`btn-reset warn-row${failing ? ' err-row' : ''}`} onClick={() => go(`/service/${s.key}/${failing ? 'diagnose' : 'incidents'}`)}>
          <Icon d={IC.alert} size={14} stroke={1.9} />
          <span class="ellipsis" style={{ flex: 1 }}>
            {failing ? s.lastError || `${s.name} is ${s.status}` : `${s.openIncidents} open incident${s.openIncidents > 1 ? 's' : ''}${s.lastError ? ` · ${s.lastError}` : ''}`}
          </span>
          <span aria-hidden="true">→</span>
        </button>
      )}
      <div class="row" style={{ gap: '8px', marginTop: 'auto' }}>
        {alive && !busy && (
          <>
            <Button variant="secondary" size="sm" onClick={() => svcAction(s, 'restart')}>
              Restart
            </Button>
            <Button variant="ghost" size="sm" onClick={() => svcAction(s, 'stop')}>
              Stop
            </Button>
          </>
        )}
        {!alive && !busy && (
          <Button variant="primary" size="sm" onClick={() => svcAction(s, 'start')}>
            Start
          </Button>
        )}
        {busy && (
          <>
            <Button variant="secondary" size="sm" disabled>
              {m.label}…
            </Button>
            {(s.queued || s.status === 'backoff' || s.status === 'starting') && (
              <Button variant="ghost" size="sm" onClick={() => svcAction(s, 'stop')}>
                {s.queued ? 'Dequeue' : 'Stop'}
              </Button>
            )}
          </>
        )}
        <Button variant="ghost" size="sm" onClick={() => go(`/service/${s.key}/logs`)} style={{ marginLeft: 'auto' }}>
          Logs →
        </Button>
      </div>
    </article>
  );
}

function DependencyMap({ ws }: { ws: WorkspaceView }) {
  const tiers = tiersOf(ws.services);
  if (ws.services.length < 2) return null;
  return (
    <section class="panel stack" style={{ padding: '22px 24px', gap: '18px' }}>
      <div class="row" style={{ justifyContent: 'space-between', gap: '12px' }}>
        <div class="stack" style={{ gap: '4px' }}>
          <h2 class="section">Dependency map</h2>
          <span class="muted" style={{ fontSize: '12.5px' }}>
            Start order runs left to right. Select a service to open it.
          </span>
        </div>
        <div class="legend">
          <span>
            <span class="dot" style={{ background: 'var(--green-500)' }} />
            Running
          </span>
          <span>
            <span class="dot" style={{ background: 'var(--aurora-blue)' }} />
            Changing
          </span>
          <span>
            <span class="dot" style={{ background: 'var(--red-500)' }} />
            Failing
          </span>
          <span>
            <span class="dot" style={{ background: 'var(--ink-200)' }} />
            Stopped
          </span>
        </div>
      </div>
      <div class="dep-scroll">
        <div class="dep-row" style={{ minWidth: `${Math.max(600, tiers.length * 230)}px` }}>
          {tiers.map((t, i) => (
            <div class="dep-col-wrap" key={t.label}>
              {i > 0 && (
                <div class="dep-arrow">
                  <div class="flow" />
                  <svg width="8" height="10" viewBox="0 0 8 10" aria-hidden="true">
                    <path d="M0 0l8 5-8 5z" fill="var(--ink-200)" />
                  </svg>
                </div>
              )}
              <div class="dep-col">
                <div class="row" style={{ justifyContent: 'space-between', padding: '0 2px 4px' }}>
                  <span class="overline">{t.label}</span>
                  <span class="mono tnum faint" style={{ fontSize: '11px' }}>
                    {t.rows.filter((r) => r.status === 'running').length}/{t.rows.length}
                  </span>
                </div>
                {t.rows.map((s) => (
                  <button class="btn-reset node" key={s.key} onClick={() => go(`/service/${s.key}/logs`)} title={`${s.name} · ${statusMeta(s).label}`}>
                    <span class={`dot ${statusMeta(s).dot}`} />
                    <span class="ellipsis" style={{ flex: 1, fontSize: '13.5px', fontWeight: 500 }}>
                      {s.name}
                    </span>
                    <span class="mono tnum faint" style={{ fontSize: '11px' }}>
                      {s.port ? `:${s.port}` : ''}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function Overview({ ws }: { ws: WorkspaceView }) {
  const profiles = Object.keys(ws.profiles);
  const [profile, setProfile] = useState(profiles.includes('default') ? 'default' : profiles[0] || 'default');
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const running = ws.services.filter((s) => s.status === 'running');
  const failing = ws.services.filter(isFailing);
  const anyActive = ws.services.some((s) => isLive(s) || isBusy(s) || isFailing(s));
  const cpu = running.reduce((a, s) => a + (s.cpu || 0), 0);
  const mem = running.reduce((a, s) => a + (s.mem || 0), 0);
  const openInc = ws.services.reduce((n, s) => n + s.openIncidents, 0);
  const q = query.toLowerCase().trim();
  const shown = ws.services.filter((s) => {
    if (filter === 'running' && s.status !== 'running') return false;
    if (filter === 'stopped' && (isLive(s) || isBusy(s) || isFailing(s))) return false;
    if (filter === 'failing' && !isFailing(s)) return false;
    return !q || `${s.name} ${s.port ?? ''}`.toLowerCase().includes(q);
  });
  const filterItems = [
    { id: 'all', label: `All · ${ws.services.length}` },
    { id: 'running', label: `Running · ${running.length}` },
    { id: 'stopped', label: `Stopped · ${ws.services.length - running.length - failing.length}` },
    ...(failing.length ? [{ id: 'failing', label: `Failing · ${failing.length}` }] : []),
  ];

  return (
    <div class="dp-view stack" style={{ gap: '24px' }}>
      <div class="row" style={{ alignItems: 'flex-end', justifyContent: 'space-between', gap: '18px' }}>
        <div class="stack" style={{ gap: '6px', minWidth: 0 }}>
          <span class="overline">Workspace</span>
          <h1 class="title">{ws.name}</h1>
          <div class="row" style={{ gap: '8px', minWidth: 0, flexWrap: 'nowrap' }}>
            <span class="mono muted ellipsis" style={{ fontSize: '12.5px' }}>
              {ws.root}
            </span>
            <button class="btn-reset icon-btn" aria-label="Copy workspace path" onClick={() => copyText(ws.root).then((ok) => toast(ok ? 'Workspace path copied' : 'Copy failed', ok))}>
              <Icon d={IC.copy} size={14} />
            </button>
          </div>
        </div>
        <div class="toolbar">
          {profiles.length > 1 && (
            <>
              <span class="muted" style={{ fontSize: '12.5px' }}>
                Profile
              </span>
              <Tabs size="sm" items={profiles.map((p) => ({ id: p, label: p }))} value={profile} onChange={setProfile} />
            </>
          )}
          <Button onClick={() => startProfile(ws, profile)}>
            Start {profile}
          </Button>
          <Button variant="secondary" disabled={!anyActive} onClick={() => stopAll(ws)}>
            Stop all
          </Button>
        </div>
      </div>

      {ws.configError && (
        <div class="warn-row err-row" style={{ alignItems: 'flex-start', padding: '12px 14px' }}>
          <Icon d={IC.alert} size={15} />
          <div class="stack" style={{ gap: '4px', minWidth: 0 }}>
            <b>devpilot.yaml has an error</b>
            <span class="mono" style={{ whiteSpace: 'pre-wrap', fontSize: '12px' }}>
              {ws.configError}
            </span>
          </div>
        </div>
      )}

      <ModeBar ws={ws} />

      <StatGrid columns={4}>
        <Stat label="Running" value={running.length} suffix={`/${ws.services.length}`} hint={`${ws.services.length - running.length} not running`} />
        <Stat label="Failing" value={failing.length} valueColor={failing.length ? 'var(--red-700)' : undefined} hint={failing.length ? failing.map((s) => s.name).join(', ') : openInc ? `${openInc} open incident${openInc > 1 ? 's' : ''}` : 'All health checks passing'} />
        <Stat label="CPU total" value={cpu.toFixed(1)} suffix="%" hint="Across running services" />
        <Stat label="Memory total" value={Math.round(mem / 1048576)} suffix=" MB" hint="Resident set, all services" />
      </StatGrid>

      <DependencyMap ws={ws} />

      <section class="stack" style={{ gap: '16px' }}>
        <div class="row" style={{ justifyContent: 'space-between', gap: '12px' }}>
          <h2 class="section">Services</h2>
          <div class="toolbar">
            <Tabs size="sm" items={filterItems} value={filter} onChange={setFilter} />
            <Input size="sm" value={query} onInput={setQuery} placeholder="Filter by name or port" style={{ width: '220px' }} />
          </div>
        </div>
        {!shown.length && <Empty message="No services match" detail="Try another filter or clear the search." />}
        <div class="cards">
          {shown.map((s, i) => (
            <ServiceCard s={s} index={i} key={s.key} />
          ))}
        </div>
      </section>
    </div>
  );
}

/** Modes, env profile and one-shot tasks: DevPilot controls the design leaves room for. */
function ModeBar({ ws }: { ws: WorkspaceView }) {
  const hasModes = ws.modes.length > 1;
  const tasks = [...ws.tasks.map((t) => ({ t, all: false })), ...ws.serviceTasks.filter((t) => !ws.tasks.includes(t)).map((t) => ({ t, all: true }))];
  if (!hasModes && !tasks.length && !ws.envProfiles.length) {
    return (
      <div class="subbar">
        <span class="lbl">
          Mode <span class="tag-mode">default</span>
        </span>
        <span class="muted" style={{ fontSize: '12.5px' }}>
          Add <span class="mono">modes:</span> and <span class="mono">tasks:</span> to devpilot.yaml to switch between watch and built output and run one-shot tasks.
        </span>
      </div>
    );
  }
  return (
    <div class="subbar">
      {hasModes && (
        <div class="row" style={{ gap: '10px' }}>
          <span class="lbl">Mode</span>
          <Tabs size="sm" items={ws.modes.map((m) => ({ id: m, label: m }))} value={ws.mode} onChange={(m) => void switchMode(ws, m)} />
        </div>
      )}
      {ws.envProfiles.length > 0 && (
        <div class="row" style={{ gap: '10px' }}>
          <span class="lbl">Env</span>
          <select
            class="ds-select"
            value={ws.envProfile || ''}
            onChange={(e) => {
              const p = (e.target as HTMLSelectElement).value || undefined;
              void switchEnv(ws, p);
            }}
          >
            <option value="">default</option>
            {ws.envProfiles.map((p) => (
              <option value={p}>{p}</option>
            ))}
          </select>
        </div>
      )}
      {tasks.length > 0 && (
        <div class="row" style={{ gap: '8px' }}>
          <span class="lbl">Tasks</span>
          {tasks.map(({ t, all }) => {
            const running = ws.runningTasks.some((r) => r.task === t);
            return (
              <Button
                key={t}
                variant="secondary"
                size="sm"
                disabled={running}
                title={all ? `Run "${t}" in every service that defines it` : `Run workspace task "${t}"`}
                onClick={() => runTask(ws, t, { all })}
              >
                {running ? <Spinner size={12} /> : <Icon d={IC.play} size={11} fill />}
                {t}
                {all && <span class="faint">· all</span>}
              </Button>
            );
          })}
        </div>
      )}
      <span class="spacer" />
      {ws.runningTasks.length > 0 && (
        <span class="row" style={{ gap: '6px', fontSize: '12.5px', color: 'var(--aurora-blue-deep)' }}>
          <Spinner size={12} /> Running {ws.runningTasks.map((r) => (r.service ? `${r.task} (${r.service})` : r.task)).join(', ')}
        </span>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ service detail

function LogsTab({ s }: { s: ServiceView }) {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [q, setQ] = useState('');
  const [stream, setStream] = useState('all');
  const [follow, setFollow] = useState(true);
  const [time, setTime] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let alive = true;
    setLines([]);
    api<{ lines: LogLine[] }>('GET', `/api/services/${s.key}/logs?tail=2000`).then((r) => alive && setLines(r.lines));
    const off = store.onLogs((key, more) => key === s.key && setLines((l) => [...l, ...more].slice(-5000)));
    return () => {
      alive = false;
      off();
    };
  }, [s.key]);
  useEffect(() => {
    if (follow && box.current) box.current.scrollTop = box.current.scrollHeight;
  });
  let re: RegExp | null = null;
  let bad = false;
  if (q) {
    try {
      re = new RegExp(q, 'i');
    } catch {
      bad = true;
    }
  }
  const all = lines.filter((l) => stream === 'all' || l.stream === stream);
  const shown = all.filter((l) => !re || re.test(l.text)).slice(-800);
  return (
    <div class="dp-tab stack" style={{ gap: '12px' }}>
      <div class="toolbar">
        <Input size="sm" value={q} onInput={setQ} placeholder="Filter (regex)…" style={{ width: '260px' }} invalid={bad} />
        <Tabs
          size="sm"
          items={[
            { id: 'all', label: 'All' },
            { id: 'out', label: 'stdout' },
            { id: 'err', label: 'stderr' },
            { id: 'sys', label: 'devpilot' },
          ]}
          value={stream}
          onChange={setStream}
        />
        <button class={`btn-reset toggle${follow ? ' on' : ''}`} aria-pressed={follow} onClick={() => setFollow(!follow)}>
          <Icon d={IC.down} size={13} stroke={2} /> Follow
        </button>
        <button class={`btn-reset toggle${time ? ' on' : ''}`} aria-pressed={time} onClick={() => setTime(!time)}>
          <Icon d={IC.clock} size={13} stroke={2} /> Time
        </button>
        <span class="spacer" />
        {bad && <span style={{ fontSize: '12px', color: 'var(--status-danger-text)' }}>Invalid regex</span>}
        <span class="mono tnum muted" style={{ fontSize: '12px' }}>
          {shown.length} of {all.length} lines
        </span>
        <Button variant="ghost" size="sm" onClick={() => act('clear logs', () => api('DELETE', `/api/services/${s.key}/logs`).then(() => setLines([])))}>
          Clear
        </Button>
      </div>
      <div class="logs-box">
        <div
          class="logs"
          ref={box}
          onScroll={(e) => {
            const el = e.currentTarget as HTMLDivElement;
            const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
            if (atBottom !== follow) setFollow(atBottom);
          }}
        >
          {!shown.length && (
            <div class="stack" style={{ height: '440px', alignItems: 'center', justifyContent: 'center', gap: '6px', color: '#8a91a3', fontFamily: 'var(--font-sans)' }}>
              <span style={{ fontSize: '14px', color: '#c9ceda' }}>{q ? 'No lines match this filter' : isLive(s) ? 'Waiting for output…' : 'Service is stopped'}</span>
              <span style={{ fontSize: '12.5px' }}>{q ? 'Edit or clear the filter.' : isLive(s) ? 'New lines appear as the process writes them.' : 'Start it to stream logs.'}</span>
            </div>
          )}
          {shown.map((l) => {
            const m = re ? l.text.match(re) : null;
            return (
              <div class={`logline ${l.stream}`} key={l.seq}>
                <span class="n tnum">{l.seq}</span>
                {time && <span class="t tnum">{new Date(l.t).toLocaleTimeString()}</span>}
                {l.stream !== 'out' && <span class="src">{l.stream === 'err' ? 'stderr' : 'devpilot'}</span>}
                <span class="txt" style={{ flex: 1, minWidth: 0 }}>
                  {m && m[0] ? (
                    <>
                      {l.text.slice(0, m.index)}
                      <mark>{m[0]}</mark>
                      {l.text.slice((m.index || 0) + m[0].length)}
                    </>
                  ) : (
                    l.text
                  )}
                </span>
              </div>
            );
          })}
        </div>
        <div class="logs-foot">
          <span class={`dot ${follow ? 'run' : 'stop'}`} />
          <span>{follow ? 'Streaming · following the tail' : 'Paused · new lines still arrive below'}</span>
        </div>
      </div>
    </div>
  );
}

function Chart({ title, color, gradient, points, pick, fmt, floor, range }: { title: string; color: string; gradient: string; points: MetricPoint[]; pick: (p: MetricPoint) => number | undefined; fmt: (v: number) => string; floor: number; range: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const series = points.map((p) => ({ t: p.t, v: pick(p) })).filter((x): x is { t: number; v: number } => x.v !== undefined);
  const vals = series.map((x) => x.v);
  const max = niceMax(Math.max(0, ...vals) * 1.15, floor);
  const p = seriesPaths(vals, 600, 160, max);
  const fmtTime = (t: number) => (range === '24h' ? new Date(t).toLocaleString(undefined, { weekday: 'short', hour: 'numeric' }) : new Date(t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }));
  const xLabels = series.length > 1 ? [0, 1 / 3, 2 / 3].map((f) => fmtTime(series[Math.round(f * (series.length - 1))].t)) : ['', '', ''];
  const hv = hover !== null && series.length ? series[Math.round(hover * (series.length - 1))] : null;
  const hf = hover !== null && series.length > 1 ? Math.round(hover * (series.length - 1)) / (series.length - 1) : 0;
  return (
    <div class="chart-card dp-rise">
      <div class="row" style={{ alignItems: 'baseline', justifyContent: 'space-between', gap: '8px' }}>
        <span style={{ fontSize: '14px', fontWeight: 500 }}>{title}</span>
        <span class="mono tnum" style={{ fontSize: '20px', fontWeight: 500, letterSpacing: '-0.02em', color }}>
          {vals.length ? fmt(vals[vals.length - 1]) : '—'}
        </span>
      </div>
      <div class="row" style={{ gap: '10px', flexWrap: 'nowrap', alignItems: 'flex-start' }}>
        <div class="mono tnum faint" style={{ position: 'relative', width: '48px', height: '160px', flex: 'none', fontSize: '10.5px' }}>
          <span style={{ position: 'absolute', right: 0, top: '4px' }}>{fmt(max)}</span>
          <span style={{ position: 'absolute', right: 0, top: '78px' }}>{fmt(max / 2)}</span>
          <span style={{ position: 'absolute', right: 0, top: '150px' }}>{fmt(0)}</span>
        </div>
        <div style={{ position: 'relative', flex: 1, minWidth: 0 }}>
          <svg class="dp-wipe" viewBox="0 0 600 160" preserveAspectRatio="none" style={{ width: '100%', height: '160px', display: 'block' }} aria-hidden="true">
            <line x1="0" x2="600" y1="10" y2="10" stroke="#E7E9F0" stroke-dasharray="3 4" vector-effect="non-scaling-stroke" />
            <line x1="0" x2="600" y1="84" y2="84" stroke="#E7E9F0" stroke-dasharray="3 4" vector-effect="non-scaling-stroke" />
            <line x1="0" x2="600" y1="158" y2="158" stroke="#D9DDE6" vector-effect="non-scaling-stroke" />
            <path d={p.area} fill={`url(#${gradient})`} />
            <path d={p.line} fill="none" stroke={color} stroke-width="1.6" vector-effect="non-scaling-stroke" stroke-linejoin="round" />
          </svg>
          {hv && (
            <>
              <div style={{ position: 'absolute', top: 0, height: '160px', width: '1px', background: 'var(--ink-300)', left: `${hf * 100}%`, pointerEvents: 'none' }} />
              <div style={{ position: 'absolute', width: '9px', height: '9px', borderRadius: '50%', background: '#fff', border: `2px solid ${color}`, left: `${hf * 100}%`, top: `${160 - 2 - (Math.min(hv.v, max) / max) * 148}px`, transform: 'translate(-50%, -50%)', pointerEvents: 'none' }} />
              <div class="mono tnum" style={{ position: 'absolute', top: '-6px', left: `${hf * 100}%`, transform: `translate(${hf < 0.15 ? '0%' : hf > 0.85 ? '-100%' : '-50%'}, -100%)`, padding: '6px 9px', borderRadius: '10px', background: 'rgba(11,16,32,.92)', color: '#fff', fontSize: '11.5px', whiteSpace: 'nowrap', boxShadow: 'var(--shadow-tooltip)', pointerEvents: 'none' }}>
                {fmt(hv.v)} · {new Date(hv.t).toLocaleTimeString()}
              </div>
            </>
          )}
          <div
            style={{ position: 'absolute', inset: 0, height: '160px', cursor: 'crosshair' }}
            onMouseMove={(e) => {
              const r = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
              setHover(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)));
            }}
            onMouseLeave={() => setHover(null)}
          />
          <div class="mono tnum faint" style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10.5px', paddingTop: '8px' }}>
            <span>{xLabels[0]}</span>
            <span>{xLabels[1]}</span>
            <span>{xLabels[2]}</span>
            <span>now</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function MetricsTab({ s }: { s: ServiceView }) {
  const [range, setRange] = useState<'15m' | '1h' | '24h'>('15m');
  const [pts, setPts] = useState<MetricPoint[]>([]);
  useEffect(() => {
    let alive = true;
    api<{ points: MetricPoint[] }>('GET', `/api/services/${s.key}/metrics?range=${range}`).then((r) => alive && setPts(r.points));
    const off = range === '24h' ? () => {} : store.onMetric((k, p) => k === s.key && setPts((x) => [...x, p].filter((q) => q.t >= Date.now() - (range === '15m' ? 9e5 : 36e5))));
    return () => {
      alive = false;
      off();
    };
  }, [s.key, range]);
  return (
    <div class="dp-tab stack" style={{ gap: '16px' }}>
      <div class="toolbar">
        <Tabs
          size="sm"
          items={[
            { id: '15m', label: '15m' },
            { id: '1h', label: '1h' },
            { id: '24h', label: '24h' },
          ]}
          value={range}
          onChange={(v) => setRange(v as any)}
        />
        <span class="mono tnum muted" style={{ fontSize: '12px' }}>
          {pts.length} samples{range === '15m' ? ' · live' : ''}
        </span>
        <span class="spacer" />
        <span class="muted" style={{ fontSize: '12.5px' }}>
          Hover a chart to read exact values
        </span>
      </div>
      {!pts.length ? (
        <Empty message="No samples yet" detail="Metrics are collected every 3 seconds while the service runs." />
      ) : (
        <div key={range} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: '16px' }}>
          <Chart title="CPU" color="#720455" gradient="dp-g-cpu" points={pts} pick={(p) => p.cpu} fmt={(v) => fmtCpu(v)} floor={0.2} range={range} />
          <Chart title="Memory" color="#7A5CF0" gradient="dp-g-mem" points={pts} pick={(p) => p.mem / 1048576} fmt={(v) => `${Math.round(v)} MB`} floor={10} range={range} />
          {pts.some((p) => p.latency !== undefined) && <Chart title="Health latency" color="#E08A00" gradient="dp-g-lat" points={pts} pick={(p) => p.latency} fmt={(v) => `${Math.round(v)} ms`} floor={20} range={range} />}
        </div>
      )}
    </div>
  );
}

function incidentIcon(i: Incident): { d: string; cls: Tone } {
  return i.severity === 'error' ? { d: IC.x, cls: 'danger' } : { d: IC.alert, cls: 'warning' };
}

function IncidentRow({ i, showService, onChanged }: { i: Incident; showService?: boolean; onChanged?: () => void }) {
  const [open, setOpen] = useState(false);
  const ic = incidentIcon(i);
  const isOpen = !i.resolvedAt;
  return (
    <div style={{ borderBottom: '1px solid var(--border-soft)', background: isOpen ? 'rgba(229,72,77,0.035)' : 'transparent' }}>
      <button class="btn-reset list-row" style={{ width: '100%', borderBottom: 0 }} aria-expanded={open} onClick={() => setOpen(!open)}>
        <span class={`ico ${ic.cls}`}>
          <Icon d={ic.d} size={14} stroke={2} />
        </span>
        <span class="mono tnum muted" style={{ fontSize: '12px', width: '64px' }}>
          {new Date(i.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
        </span>
        {showService && (
          <span class="ellipsis" style={{ fontSize: '13.5px', fontWeight: 500, color: 'var(--aurora-blue-deep)', width: '130px' }}>
            {i.service}
          </span>
        )}
        <span class="kind">{i.kind}</span>
        <span style={{ flex: '1 1 260px', fontSize: '13.5px', minWidth: 0 }} class="ellipsis">
          {i.title}
        </span>
        {i.count > 1 && (
          <span class="mono tnum muted" style={{ fontSize: '12px' }}>
            ×{i.count}
          </span>
        )}
        <Badge tone={isOpen ? 'danger' : 'success'} dot={isOpen}>
          {isOpen ? 'open' : 'resolved'}
        </Badge>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--ink-400)" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style={{ transition: 'transform .3s var(--ease-expo)', transform: `rotate(${open ? 180 : 0}deg)` }}>
          <path d={IC.chevron} />
        </svg>
      </button>
      {open && (
        <div class="dp-expand stack" style={{ gap: '12px', padding: '2px 20px 16px 62px' }}>
          <div class="row" style={{ gap: '12px 24px' }}>
            <div class="stack" style={{ gap: '2px' }}>
              <span class="muted" style={{ fontSize: '11.5px' }}>
                Detected
              </span>
              <span class="mono tnum" style={{ fontSize: '12.5px' }}>
                {new Date(i.at).toLocaleString()}
              </span>
            </div>
            <div class="stack" style={{ gap: '2px' }}>
              <span class="muted" style={{ fontSize: '11.5px' }}>
                Workspace
              </span>
              <span class="mono" style={{ fontSize: '12.5px' }}>
                {i.workspace}
              </span>
            </div>
            <div class="stack" style={{ gap: '2px' }}>
              <span class="muted" style={{ fontSize: '11.5px' }}>
                Occurrences
              </span>
              <span class="mono tnum" style={{ fontSize: '12.5px' }}>
                {i.count > 1 ? `×${i.count}` : 'once'}
              </span>
            </div>
            {i.exitCode !== undefined && i.exitCode !== null && (
              <div class="stack" style={{ gap: '2px' }}>
                <span class="muted" style={{ fontSize: '11.5px' }}>
                  Exit code
                </span>
                <span class="mono tnum" style={{ fontSize: '12.5px' }}>
                  {i.exitCode}
                </span>
              </div>
            )}
            <span class="spacer" />
            {showService && (
              <Button variant="ghost" size="sm" onClick={() => go(`/service/${i.key}/incidents`)}>
                Open service
              </Button>
            )}
            <Button variant="secondary" size="sm" onClick={() => go(`/service/${i.key}/logs`)}>
              View logs
            </Button>
            {isOpen && (
              <Button size="sm" onClick={() => act('resolve', () => api('POST', `/api/incidents/${i.id}/resolve`).then(() => (store.refresh(), onChanged?.())), `Incident on ${i.service} marked resolved`)}>
                Mark resolved
              </Button>
            )}
          </div>
          {i.context.length > 0 && <div class="pre-dark" style={{ borderRadius: '12px' }}>{i.context.join('\n')}</div>}
        </div>
      )}
    </div>
  );
}

function IncidentsTab({ s }: { s: ServiceView }) {
  const [list, setList] = useState<Incident[]>([]);
  const load = () => api<Incident[]>('GET', `/api/incidents?key=${encodeURIComponent(s.key)}&limit=100`).then(setList);
  useEffect(() => void load(), [s.key, s.openIncidents]);
  return (
    <div class="dp-tab stack" style={{ gap: '12px' }}>
      {!list.length ? (
        <Empty message="No incidents for this service" detail="Crashes, failed starts, health failures and error bursts show up here." />
      ) : (
        <div class="list">
          {list.map((i) => (
            <IncidentRow i={i} key={i.id} onChanged={load} />
          ))}
        </div>
      )}
    </div>
  );
}

function DiagnoseTab({ s }: { s: ServiceView }) {
  const [d, setD] = useState<any>(null);
  const [running, setRunning] = useState(false);
  const [errOpen, setErrOpen] = useState(false);
  const run = async () => {
    setRunning(true);
    try {
      setD(await api('GET', `/api/services/${s.key}/diagnose`));
    } catch (e: any) {
      toast(e.message, false);
    }
    setRunning(false);
  };
  useEffect(() => void run(), [s.key]);
  const worst = d?.findings.some((f: any) => f.level === 'error') ? 'error' : d?.findings.some((f: any) => f.level === 'warning') ? 'warning' : 'ok';
  const banner = running
    ? { bg: 'var(--aurora-blue-50)', border: 'rgba(114,4,85,.2)', color: 'var(--aurora-blue)', icon: IC.check, title: 'Running checks…', sub: `Probing ${s.name}` }
    : worst === 'error'
      ? { bg: 'var(--status-danger-bg)', border: 'rgba(229,72,77,.25)', color: 'var(--status-danger-text)', icon: IC.x, title: d?.verdict, sub: `${d?.findings.filter((f: any) => f.level === 'error').length} problem(s) found for ${s.name}` }
      : worst === 'warning'
        ? { bg: 'var(--status-warning-bg)', border: 'rgba(224,138,0,.25)', color: 'var(--status-warning-text)', icon: IC.alert, title: d?.verdict, sub: `Warnings for ${s.name}` }
        : !isLive(s)
          ? { bg: 'var(--porcelain-100)', border: 'var(--border-hairline)', color: 'var(--ink-500)', icon: IC.stop, title: 'Service is not running', sub: 'Start it to run the health and port checks.' }
          : { bg: 'var(--status-success-bg)', border: 'rgba(14,159,110,.2)', color: 'var(--status-success-text)', icon: IC.check, title: 'No problems detected', sub: `Every check passed for ${s.name}.` };
  const checks: { t: string; d: string; ok: boolean | null }[] = d
    ? [
        { t: 'Process alive', d: s.pid ? `PID ${s.pid}${s.image ? ` · ${s.image}` : ''}` : 'no process', ok: isLive(s) },
        { t: 'Health check', d: healthText(s), ok: s.health.kind === 'none' ? null : s.health.state === 'ok' },
        { t: 'Port', d: s.port ? (d.portHolder ? `:${s.port} held by PID ${d.portHolder.pid}${d.portHolder.isThisService ? ' (this service)' : ` (${d.portHolder.name || 'another process'})`}` : `:${s.port} free`) : 'no port configured', ok: s.port ? !d.portHolder || d.portHolder.isThisService : null },
        { t: 'Env', d: d.missingEnv.length ? `${d.missingEnv.length} missing vs .env.example: ${d.missingEnv.slice(0, 4).join(', ')}` : 'nothing missing vs .env.example', ok: !d.missingEnv.length },
        { t: 'Dependencies', d: d.dependencies.length ? `${d.dependencies.filter((x: any) => x.status === 'running').length}/${d.dependencies.length} upstream running` : 'none upstream', ok: d.dependencies.every((x: any) => x.status === 'running') },
      ]
    : [];
  return (
    <div class="dp-tab stack" style={{ gap: '16px' }}>
      <div class="row" style={{ gap: '14px', padding: '18px 20px', borderRadius: '18px', background: banner.bg, border: `1px solid ${banner.border}` }}>
        <span style={{ width: '40px', height: '40px', borderRadius: '12px', display: 'grid', placeItems: 'center', background: '#fff', color: banner.color, boxShadow: 'var(--shadow-xs)', flex: 'none' }}>{running ? <Spinner size={18} color="currentColor" /> : <Icon d={banner.icon} size={18} stroke={2.2} />}</span>
        <div class="stack" style={{ flex: '1 1 260px', gap: '3px', minWidth: 0 }}>
          <span style={{ fontSize: '15px', fontWeight: 500 }}>{banner.title || '…'}</span>
          <span style={{ fontSize: '12.5px', color: 'var(--text-secondary)' }}>{banner.sub}</span>
        </div>
        <Button variant="secondary" size="sm" disabled={running} onClick={run}>
          Re-run checks
        </Button>
        <Button
          size="sm"
          onClick={() =>
            copyText(`DevPilot service ${s.key} is ${s.status}${s.lastError ? ` (${s.lastError})` : ''}. Diagnose it with \`devpilot diagnose ${s.key} --json\` and propose a fix — don't change anything yet.`).then((ok) => toast(ok ? 'Prompt copied — paste it to Claude' : 'Copy failed', ok))
          }
        >
          <Icon d={IC.sparkle} size={13} fill /> Ask Claude
        </Button>
      </div>
      {d && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '16px', alignItems: 'start' }}>
          <div class="panel" style={{ borderRadius: '18px', padding: '6px 0' }}>
            {checks.map((k, i) => (
              <div class="row dp-check" key={k.t} style={{ gap: '12px', padding: '12px 18px', flexWrap: 'nowrap', animationDelay: `${i * 70}ms` }}>
                <span style={{ width: '22px', height: '22px', borderRadius: '50%', display: 'grid', placeItems: 'center', flex: 'none', background: k.ok === null ? 'var(--porcelain-150)' : k.ok ? 'var(--status-success-bg)' : 'var(--status-danger-bg)', color: k.ok === null ? 'var(--ink-500)' : k.ok ? 'var(--status-success-text)' : 'var(--status-danger-text)' }}>
                  <Icon d={k.ok === null ? IC.dash : k.ok ? IC.check : IC.x} size={12} stroke={3} />
                </span>
                <span class="stack" style={{ flex: 1, gap: '2px', minWidth: 0 }}>
                  <span style={{ fontSize: '13.5px', fontWeight: 500 }}>{k.t}</span>
                  <span class="mono muted ellipsis" style={{ fontSize: '11.5px' }}>
                    {k.d}
                  </span>
                </span>
              </div>
            ))}
          </div>
          <div class="stack" style={{ gap: '12px' }}>
            {d.findings
              .filter((f: any) => f.suggestion || f.level !== 'info')
              .map((f: any, i: number) => (
                <div key={i} class="row" style={{ gap: '12px', padding: '16px 18px', borderRadius: '16px', background: f.level === 'error' ? 'var(--status-danger-bg)' : f.level === 'warning' ? 'var(--status-warning-bg)' : 'var(--aurora-blue-50)', flexWrap: 'nowrap', alignItems: 'flex-start' }}>
                  <span style={{ color: f.level === 'error' ? 'var(--status-danger-text)' : f.level === 'warning' ? 'var(--status-warning-text)' : 'var(--aurora-blue-deep)', flex: 'none', marginTop: '1px' }}>
                    <Icon d={f.level === 'info' ? IC.info : IC.alert} size={18} stroke={1.9} />
                  </span>
                  <div class="stack" style={{ gap: '6px', minWidth: 0 }}>
                    <span style={{ fontSize: '13.5px', color: 'var(--ink-700)', fontWeight: 500 }}>{f.title}</span>
                    {f.detail && (
                      <span class="mono muted" style={{ fontSize: '11.5px', wordBreak: 'break-word' }}>
                        {f.detail}
                      </span>
                    )}
                    {f.suggestion && <span style={{ fontSize: '13px', color: 'var(--ink-700)', lineHeight: 1.5 }}>{f.suggestion}</span>}
                  </div>
                </div>
              ))}
            {d.errorBlock.length > 0 && (
              <div class="panel" style={{ borderRadius: '16px', overflow: 'hidden' }}>
                <button class="btn-reset list-row" style={{ width: '100%', borderBottom: 0 }} aria-expanded={errOpen} onClick={() => setErrOpen(!errOpen)}>
                  <span style={{ flex: 1, fontSize: '13.5px', fontWeight: 500 }}>Error block</span>
                  <span class="mono muted" style={{ fontSize: '11.5px' }}>
                    {d.errorBlock.length} lines
                  </span>
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style={{ transition: 'transform .3s var(--ease-expo)', transform: `rotate(${errOpen ? 180 : 0}deg)` }}>
                    <path d={IC.chevron} />
                  </svg>
                </button>
                {errOpen && <div class="dp-expand pre-dark">{d.errorBlock.map((l: string) => l.replace(/^! /, '')).join('\n')}</div>}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function EnvTab({ s }: { s: ServiceView }) {
  const [env, setEnv] = useState<any>(null);
  const [full, setFull] = useState<Record<string, string> | null>(null);
  const [reveal, setReveal] = useState<Record<string, boolean>>({});
  const [q, setQ] = useState('');
  useEffect(() => {
    setFull(null);
    setReveal({});
    api('GET', `/api/services/${s.key}/env`).then(setEnv);
  }, [s.key]);
  if (!env) return null;
  const masked = (v: string) => v === '••••';
  const valueOf = async (k: string) => {
    let f = full;
    if (!f) {
      const r = await api('GET', `/api/services/${s.key}/env?reveal=1`);
      f = Object.fromEntries(r.vars.map((v: any) => [v.key, v.value]));
      setFull(f);
    }
    return f![k];
  };
  const secrets = env.vars.filter((v: any) => masked(v.value)).length;
  const rows = env.vars.filter((v: any) => !q || v.key.toLowerCase().includes(q.toLowerCase()));
  return (
    <div class="dp-tab stack" style={{ gap: '12px' }}>
      <div class="toolbar">
        {env.envFiles.map((f: any) => (
          <div key={f.path} class="row" style={{ gap: '8px', padding: '7px 12px', borderRadius: '10px', background: f.exists ? 'var(--status-success-bg)' : 'var(--status-danger-bg)', color: f.exists ? 'var(--status-success-text)' : 'var(--status-danger-text)', fontSize: '12.5px' }}>
            <Icon d={IC.file} size={14} />
            <span class="mono">{f.path}</span>
            {!f.exists && <span>· missing</span>}
          </div>
        ))}
        <span class="spacer" />
        <span class="muted" style={{ fontSize: '12.5px' }}>
          {env.vars.length} keys · {secrets} secret{secrets === 1 ? '' : 's'} masked
        </span>
        <Input size="sm" value={q} onInput={setQ} placeholder="Find a key" style={{ width: '200px' }} />
      </div>
      <div class="list">
        <div class="table-head" style={{ gridTemplateColumns: 'minmax(180px, 1fr) minmax(0, 1.6fr) 84px' }}>
          <span>KEY</span>
          <span>VALUE</span>
          <span style={{ textAlign: 'right' }}>ACTIONS</span>
        </div>
        {rows.map((v: any) => {
          const secret = masked(v.value);
          const shown = secret && reveal[v.key] && full ? full[v.key] : v.value;
          return (
            <div class="table-row" key={v.key} style={{ gridTemplateColumns: 'minmax(180px, 1fr) minmax(0, 1.6fr) 84px' }}>
              <span class="mono ellipsis" style={{ fontSize: '12.5px', fontWeight: 500 }}>
                {v.key}
              </span>
              <span class="mono ellipsis" style={{ fontSize: '12.5px', color: v.value === '' ? 'var(--text-faint)' : secret && !reveal[v.key] ? 'var(--text-muted)' : 'var(--text-secondary)' }}>
                {v.value === '' ? '(empty)' : secret && !reveal[v.key] ? '••••••••••••' : shown}
              </span>
              <span class="row" style={{ justifyContent: 'flex-end', gap: '4px', flexWrap: 'nowrap' }}>
                {secret && (
                  <button
                    class="btn-reset icon-btn"
                    aria-label={reveal[v.key] ? 'Hide value' : 'Reveal value'}
                    onClick={async () => {
                      if (!reveal[v.key]) await valueOf(v.key);
                      setReveal((r) => ({ ...r, [v.key]: !r[v.key] }));
                    }}
                  >
                    <Icon d={reveal[v.key] ? IC.eyeOff : IC.eye} size={15} />
                  </button>
                )}
                <button class="btn-reset icon-btn" aria-label="Copy value" onClick={async () => copyText(secret ? await valueOf(v.key) : v.value).then((ok) => toast(ok ? `${v.key} copied` : 'Copy failed', ok))}>
                  <Icon d={IC.copy} size={14} />
                </button>
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ServiceDetail({ s, tab }: { s: ServiceView; tab: string }) {
  const st = useStore();
  const ws = st.workspaces.find((w) => w.id === s.workspace);
  const m = statusMeta(s);
  const alive = s.status === 'running' || s.status === 'unhealthy';
  const busy = isBusy(s);
  const tabs = ['logs', 'metrics', 'incidents', 'diagnose', 'env'];
  const t = tabs.includes(tab) ? tab : 'logs';
  return (
    <div class="dp-view stack" style={{ gap: '20px' }}>
      <div class="crumb">
        <button class="btn-reset back" onClick={() => go(`/ws/${s.workspace}`)}>
          <Icon d={IC.back} size={15} stroke={1.9} />
          <span>{ws?.name || s.workspace}</span>
        </button>
        <span class="faint">/</span>
        <span style={{ color: 'var(--text-primary)', fontWeight: 500 }}>{s.name}</span>
      </div>

      <div class="row" style={{ alignItems: 'flex-start', justifyContent: 'space-between', gap: '16px' }}>
        <div class="stack" style={{ gap: '10px', minWidth: 0, flex: '1 1 520px' }}>
          <div class="row" style={{ gap: '12px' }}>
            <span class={`dot ${m.dot}`} style={{ width: '10px', height: '10px' }} />
            <h1 class="title">{s.name}</h1>
            <Badge tone={m.tone} dot>
              {m.label}
            </Badge>
            {s.mode !== 'default' && <span class="tag-mode">mode: {s.mode}</span>}
          </div>
          <div class="cmd">
            <span class="mono" style={{ fontSize: '12.5px', color: 'var(--aurora-blue-deep)', flex: 'none' }}>
              $
            </span>
            <span class="mono ellipsis" style={{ flex: 1, fontSize: '12.5px', color: 'var(--text-secondary)' }} title={`${s.run}   (cwd ${s.cwd})`}>
              {s.run}
            </span>
            <span class="mono faint ellipsis" style={{ fontSize: '11.5px', maxWidth: '40%' }} title={s.cwd}>
              {s.cwd}
            </span>
            <button class="btn-reset icon-btn" aria-label="Copy command" onClick={() => copyText(s.run).then((ok) => toast(ok ? 'Command copied' : 'Copy failed', ok))}>
              <Icon d={IC.copy} size={14} />
            </button>
          </div>
          <div class="row tnum" style={{ gap: '8px' }}>
            <span class={`chip ${s.health.state === 'ok' ? 'ok' : s.health.state === 'failing' ? 'bad' : ''}`}>{healthText(s)}</span>
            {s.port && (
              <a class="chip info" href={s.url} target="_blank" rel="noreferrer">
                {s.url}
              </a>
            )}
            <span class="chip">PID {s.pid ?? '—'}</span>
            {s.image && <span class="chip">{s.image}</span>}
            <span class="chip">{s.adopted ? 're-attached' : 'managed'}</span>
            {alive && <span class="chip">up {ago(s.startedAt)}</span>}
            <span class="chip">↻ {s.restarts} restarts</span>
            {s.dependsOn.length > 0 && <span class="chip">needs {s.dependsOn.join(', ')}</span>}
            {s.task && <span class="chip info">running {s.task}…</span>}
          </div>
        </div>
        <div class="stack" style={{ gap: '10px', alignItems: 'flex-end' }}>
          <div class="row" style={{ gap: '8px' }}>
            {alive && !busy && (
              <>
                <Button variant="secondary" onClick={() => svcAction(s, 'restart')}>
                  Restart
                </Button>
                <Button variant="danger" onClick={() => svcAction(s, 'stop')}>
                  Stop
                </Button>
              </>
            )}
            {!alive && !busy && <Button onClick={() => svcAction(s, 'start')}>Start service</Button>}
            {busy && (
              <>
                <Button variant="secondary" disabled>
                  {m.label}…
                </Button>
                <Button variant="ghost" onClick={() => svcAction(s, 'stop')}>
                  {s.queued ? 'Dequeue' : 'Stop'}
                </Button>
              </>
            )}
          </div>
          {(s.modes.length > 1 || s.tasks.length > 0) && (
            <div class="row" style={{ gap: '8px', justifyContent: 'flex-end' }}>
              {s.modes.length > 1 && (
                <select class="ds-select" value={s.mode} title="Mode for this service (restarts it if running)" onChange={(e) => ws && void switchMode(ws, (e.target as HTMLSelectElement).value, s)}>
                  {s.modes.map((md) => (
                    <option value={md}>mode: {md}</option>
                  ))}
                </select>
              )}
              {s.tasks.map((tk) => (
                <Button key={tk} variant="secondary" size="sm" disabled={s.task === tk} onClick={() => ws && runTask(ws, tk, { service: s })}>
                  {s.task === tk ? <Spinner size={12} /> : <Icon d={IC.play} size={11} fill />}
                  {tk}
                </Button>
              ))}
            </div>
          )}
        </div>
      </div>

      <Tabs
        items={[
          { id: 'logs', label: 'Logs' },
          { id: 'metrics', label: 'Metrics' },
          { id: 'incidents', label: `Incidents${s.openIncidents ? ` · ${s.openIncidents}` : ''}` },
          { id: 'diagnose', label: 'Diagnose' },
          { id: 'env', label: 'Env' },
        ]}
        value={t}
        onChange={(v) => go(`/service/${s.key}/${v}`)}
      />
      {t === 'logs' && <LogsTab s={s} />}
      {t === 'metrics' && <MetricsTab s={s} />}
      {t === 'incidents' && <IncidentsTab s={s} />}
      {t === 'diagnose' && <DiagnoseTab s={s} />}
      {t === 'env' && <EnvTab s={s} />}
    </div>
  );
}

// ------------------------------------------------------------------ monitor pages

function IncidentsPage() {
  const st = useStore();
  const [list, setList] = useState<Incident[]>([]);
  const [filter, setFilter] = useState('open');
  const load = () => api<Incident[]>('GET', '/api/incidents?limit=300').then(setList);
  useEffect(() => void load(), [st.incidents]);
  const open = list.filter((i) => !i.resolvedAt);
  const dayStart = new Date().setHours(0, 0, 0, 0);
  const resolvedToday = list.filter((i) => i.resolvedAt && i.resolvedAt >= dayStart).length;
  const affected = new Set(open.map((i) => i.key)).size;
  const rows = list.filter((i) => (filter === 'all' ? true : filter === 'open' ? !i.resolvedAt : !!i.resolvedAt));
  return (
    <div class="dp-view stack" style={{ gap: '22px' }}>
      <div class="row" style={{ alignItems: 'flex-end', justifyContent: 'space-between', gap: '16px' }}>
        <div class="stack" style={{ gap: '6px' }}>
          <span class="overline">Monitor · {new Date().toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}</span>
          <h1 class="title">Incidents</h1>
        </div>
        <div class="toolbar">
          <Tabs
            items={[
              { id: 'all', label: `All · ${list.length}` },
              { id: 'open', label: `Open · ${open.length}` },
              { id: 'resolved', label: `Resolved · ${list.length - open.length}` },
            ]}
            value={filter}
            onChange={setFilter}
          />
          {open.length > 0 && (
            <Button variant="secondary" size="sm" onClick={() => act('clear', () => api('POST', '/api/incidents/resolve', {}).then(() => (store.refresh(), load())), `${open.length} incident(s) resolved`)}>
              Resolve all
            </Button>
          )}
        </div>
      </div>
      <StatGrid columns={3}>
        <Stat label="Open" value={open.length} valueColor={open.length ? 'var(--red-700)' : undefined} hint="Needs attention" />
        <Stat label="Resolved today" value={resolvedToday} hint="Cleared when health passed or by hand" />
        <Stat label="Services affected" value={affected} hint={`Across ${st.workspaces.length} workspace${st.workspaces.length === 1 ? '' : 's'}`} />
      </StatGrid>
      {!rows.length ? (
        <Empty message={filter === 'open' ? 'Nothing open' : 'No incidents'} detail={filter === 'open' ? 'All incidents are resolved.' : undefined} />
      ) : (
        <div class="list" style={{ borderRadius: '20px' }}>
          {rows.map((i) => (
            <IncidentRow i={i} key={i.id} showService onChanged={load} />
          ))}
        </div>
      )}
    </div>
  );
}

function PortsPage() {
  const [rows, setRows] = useState<any[] | null>(null);
  const [tab, setTab] = useState('all');
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [at, setAt] = useState<number | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const st = useStore();
  const load = async () => {
    setBusy(true);
    try {
      setRows(await api<any[]>('GET', '/api/ports'));
      setAt(Date.now());
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => void load(), []);
  const all = (rows || []).filter((r) => r.port >= 1024 && r.port < 49152);
  const managed = all.filter((r) => r.service);
  const shown = all.filter((r) => (tab === 'managed' ? r.service : tab === 'other' ? !r.service : true)).filter((r) => !q || `${r.port} ${r.pid} ${r.name} ${r.service || ''}`.toLowerCase().includes(q.toLowerCase()));
  const svcOf = (key: string) => st.workspaces.flatMap((w) => w.services).find((s) => s.key === key);
  const cols = '80px 80px 200px 170px minmax(0, 1fr)';
  return (
    <div class="dp-view stack" style={{ gap: '22px' }}>
      <div class="row" style={{ alignItems: 'flex-end', justifyContent: 'space-between', gap: '16px' }}>
        <div class="stack" style={{ gap: '6px' }}>
          <span class="overline">Monitor · listening ports</span>
          <h1 class="title">Ports</h1>
        </div>
        <div class="toolbar">
          <Tabs
            size="sm"
            items={[
              { id: 'all', label: `All · ${all.length}` },
              { id: 'managed', label: `Managed · ${managed.length}` },
              { id: 'other', label: `Other · ${all.length - managed.length}` },
            ]}
            value={tab}
            onChange={setTab}
          />
          <Input size="sm" value={q} onInput={setQ} placeholder="Port, PID or process" style={{ width: '220px' }} />
          <button class="btn-reset toggle" onClick={load}>
            <span class={busy ? 'dp-spin' : ''} style={{ display: 'inline-flex' }}>
              <Icon d={IC.restart} size={13} stroke={2} />
            </span>
            {busy ? 'Scanning…' : at ? `Updated ${ago(at)} ago` : 'Refresh'}
          </button>
        </div>
      </div>
      <div class="list" style={{ borderRadius: '20px' }}>
        <div style={{ overflowX: 'auto' }}>
          <div style={{ minWidth: '860px' }}>
            <div class="table-head" style={{ gridTemplateColumns: cols, gap: '14px', padding: '12px 20px' }}>
              <span>PORT</span>
              <span>PID</span>
              <span>PROCESS</span>
              <span>SERVICE</span>
              <span>COMMAND</span>
            </div>
            {!rows && <Empty message="Scanning ports…" />}
            {rows && !shown.length && <Empty message="No ports match" />}
            {shown.map((r, i) => {
              const s = r.service ? svcOf(r.service) : undefined;
              const exp = open === r.port;
              return (
                <div class="table-row dp-check" key={r.port} style={{ gridTemplateColumns: cols, gap: '14px', padding: '12px 20px', alignItems: 'start', animationDelay: `${Math.min(i, 20) * 30}ms` }}>
                  <span class="mono tnum" style={{ fontSize: '13px', fontWeight: 500 }}>
                    {r.port}
                  </span>
                  <span class="mono tnum" style={{ fontSize: '12.5px', color: 'var(--text-secondary)' }}>
                    {r.pid}
                  </span>
                  <span class="ellipsis" style={{ fontSize: '13px' }}>
                    {r.name}
                  </span>
                  <span>
                    {r.service ? (
                      <button class="btn-reset" onClick={() => go(`/service/${r.service}/logs`)} style={{ display: 'inline-flex', alignItems: 'center', gap: '7px', padding: '3px 9px 3px 7px', borderRadius: '8px', background: 'var(--aurora-blue-50)', color: 'var(--aurora-blue-deep)', fontSize: '12.5px', fontWeight: 500 }}>
                        <span class={`dot ${s ? statusMeta(s).dot : 'stop'}`} style={{ width: '6px', height: '6px', animation: 'none' }} />
                        {r.service.split('/')[1]}
                      </button>
                    ) : r.configuredBy?.length ? (
                      <span style={{ fontSize: '12.5px', color: 'var(--status-danger-text)' }}>conflicts with {r.configuredBy.map((k: string) => k.split('/')[1]).join(', ')}</span>
                    ) : (
                      <span class="faint" style={{ fontSize: '12.5px' }}>
                        —
                      </span>
                    )}
                  </span>
                  <button class="btn-reset mono" aria-expanded={exp} onClick={() => setOpen(exp ? null : r.port)} style={{ minWidth: 0, fontSize: '12px', lineHeight: 1.6, color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: exp ? 'normal' : 'nowrap', wordBreak: 'break-all' }}>
                    {r.cmd || '—'}
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      </div>
      <span class="muted" style={{ fontSize: '12.5px' }}>
        Select a command to see it in full. Managed ports link to their service.
      </span>
    </div>
  );
}

// ------------------------------------------------------------------ app

function Login() {
  return (
    <div class="shell" style={{ alignItems: 'center', justifyContent: 'center', padding: '24px' }}>
      <div class="sheet stack" style={{ flex: 'none', minHeight: 0, maxWidth: '440px', gap: '14px', alignItems: 'flex-start' }}>
        <div class="brand">
          <div class="logo">D</div>
          <span style={{ fontSize: '16px', fontWeight: 600, letterSpacing: '-0.02em' }}>DevPilot</span>
        </div>
        <h1 class="title" style={{ fontSize: '22px' }}>
          This browser is not signed in
        </h1>
        <span class="muted" style={{ lineHeight: 1.5 }}>
          Run <span class="mono" style={{ color: 'var(--aurora-blue-deep)' }}>devpilot open</span> (or ask Claude to). It opens a one-time link, valid 5 minutes; the browser then stays signed in for 30 days.
        </span>
      </div>
    </div>
  );
}

function Gradients() {
  return (
    <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true">
      <defs>
        {[
          ['dp-g-cpu', '#720455'],
          ['dp-g-mem', '#7A5CF0'],
          ['dp-g-lat', '#E08A00'],
        ].map(([id, c]) => (
          <linearGradient id={id} x1="0" y1="0" x2="0" y2="1" key={id}>
            <stop offset="0%" stop-color={c} stop-opacity="0.22" />
            <stop offset="100%" stop-color={c} stop-opacity="0" />
          </linearGradient>
        ))}
      </defs>
    </svg>
  );
}

function App() {
  const st = useStore();
  const route = useHashRoute();
  const [palette, setPalette] = useState(false);
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 5000);
    const key = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPalette((p) => !p);
      }
    };
    addEventListener('keydown', key);
    return () => {
      clearInterval(t);
      removeEventListener('keydown', key);
    };
  }, []);

  if (st.unauthorized) return <Login />;

  const [page = '', a, b, c] = route;
  let content: ComponentChildren;
  let activeWs: string | undefined;
  if (page === 'service' && a && b) {
    const s = store.service(`${a}/${b}`);
    activeWs = a;
    content = s ? <ServiceDetail s={s} tab={c || 'logs'} /> : <Empty message={`Loading ${a}/${b}…`} />;
  } else if (page === 'incidents') content = <IncidentsPage />;
  else if (page === 'ports') content = <PortsPage />;
  else {
    const ws = st.workspaces.find((w) => w.id === a) || st.workspaces[0];
    activeWs = ws?.id;
    content = ws ? <Overview ws={ws} key={ws.id} /> : <Empty message="No workspaces yet" detail="In a project folder run `devpilot init --write`, or ask Claude to set up DevPilot." />;
  }

  return (
    <div class="shell">
      <Gradients />
      <Header onPalette={() => setPalette(true)} />
      <div class="body">
        <Sidebar activeWs={activeWs} page={page} onPalette={() => setPalette(true)} />
        <main class="sheet">{content}</main>
      </div>
      {palette && <Palette onClose={() => setPalette(false)} />}
      <ConfirmDialog />
      <Toasts />
    </div>
  );
}

store.connect();
render(<App />, document.getElementById('app')!);
