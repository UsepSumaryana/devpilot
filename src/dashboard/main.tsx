import { render } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import './styles.css';
import type { Incident, LogLine, MetricPoint, ServiceView, WorkspaceView } from '../shared/types.js';
import { api, go, store, useHashRoute, useStore } from './store.js';
import { ansiToHtml } from './ansi.js';

// ------------------------------------------------------------------ helpers

const ago = (t?: number) => {
  if (!t) return '-';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d`;
};
const mb = (n?: number) => (n === undefined ? '-' : `${Math.round(n / 1048576)} MB`);
const live = (s: ServiceView) => ['running', 'starting', 'unhealthy'].includes(s.status);

let toastTimer: number | undefined;
function toast(msg: string, ok = false) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    document.body.appendChild(el);
  }
  el.className = `toast${ok ? ' ok' : ''}`;
  el.textContent = msg;
  el.style.display = 'block';
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (el!.style.display = 'none'), 6000);
}

async function act(label: string, fn: () => Promise<any>) {
  try {
    const r = await fn();
    const list = Array.isArray(r) ? r : [r];
    const bad = list.find((x) => x && x.ok === false);
    if (bad) toast(`${bad.key?.split('/')[1] || label}: ${bad.reason || 'failed'}${bad.suggestion ? ` — ${bad.suggestion}` : ''}`);
  } catch (e: any) {
    toast(`${label}: ${e.message}`);
  }
}

const svcAction = (s: ServiceView, a: 'start' | 'stop' | 'restart') => act(`${a} ${s.name}`, () => api('POST', `/api/services/${s.key}/${a}`, {}));

function Status({ s }: { s: ServiceView }) {
  return (
    <span class={`pill st-${s.status}`}>
      <span class="dot" />
      {s.status}
    </span>
  );
}

function Health({ s }: { s: ServiceView }) {
  const h = s.health;
  if (h.kind === 'none' || h.state === 'none') return <span class="muted">no check</span>;
  const c = h.state === 'ok' ? 'var(--ok)' : h.state === 'failing' ? 'var(--err)' : 'var(--muted)';
  return (
    <span style={{ color: c }} title={h.lastError || ''}>
      {h.kind} {h.state === 'ok' ? `ok · ${h.latencyMs ?? '?'}ms` : h.state === 'failing' ? `failing ×${h.consecutiveFailures}` : '…'}
    </span>
  );
}

function Spark({ values, color, label }: { values: number[]; color: string; label: string }) {
  const w = 120;
  const h = 30;
  const max = Math.max(...values, 1e-6);
  const pts = values.map((v, i) => `${(i / Math.max(1, values.length - 1)) * w},${h - 2 - (v / max) * (h - 4)}`).join(' ');
  return (
    <div class="spark">
      <div>{label}</div>
      <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
        {values.length > 1 && <polyline points={pts} fill="none" stroke={color} stroke-width="1.5" vector-effect="non-scaling-stroke" />}
        {values.length > 1 && <polygon points={`0,${h} ${pts} ${w},${h}`} fill={color} opacity="0.12" />}
      </svg>
    </div>
  );
}

// ------------------------------------------------------------- overview

function ServiceCard({ s }: { s: ServiceView }) {
  const st = useStore();
  const pts = st.spark.get(s.key) || [];
  const stop = (e: Event) => e.stopPropagation();
  return (
    <div class={`panel card st-${s.status}`} onClick={() => go(`/service/${s.key}`)}>
      <div class="title">
        <span class="dot" />
        <span>{s.name}</span>
        <span style={{ marginLeft: 'auto' }}>
          <Status s={s} />
        </span>
      </div>
      <div class="meta">
        {s.port ? (
          <a href={s.url} target="_blank" onClick={stop}>
            :{s.port}
          </a>
        ) : (
          <span>no port</span>
        )}
        <Health s={s} />
        {live(s) && <span>up {ago(s.startedAt)}</span>}
        {s.restarts > 0 && <span style={{ color: 'var(--violet)' }}>↻ {s.restarts}</span>}
        {s.image && <span class="mono">{s.image}</span>}
      </div>
      {live(s) && (
        <div class="sparks">
          <Spark values={pts.map((p) => p.cpu)} color="var(--accent)" label={`CPU ${s.cpu ?? 0}%`} />
          <Spark values={pts.map((p) => p.mem)} color="var(--ok)" label={`MEM ${mb(s.mem)}`} />
        </div>
      )}
      {(s.status === 'crashed' || s.status === 'backoff' || s.status === 'unhealthy') && s.lastError && (
        <div class="err" title={s.lastError}>
          {s.lastError}
        </div>
      )}
      {s.openIncidents > 0 && !['crashed', 'backoff'].includes(s.status) && <div style={{ fontSize: '12px', color: 'var(--warn)' }}>⚠ {s.openIncidents} open incident(s)</div>}
      <div class="actions" onClick={stop}>
        {live(s) || s.status === 'backoff' ? (
          <>
            <button class="btn sm" onClick={() => svcAction(s, 'restart')}>↻ Restart</button>
            <button class="btn sm danger" onClick={() => svcAction(s, 'stop')}>■ Stop</button>
          </>
        ) : (
          <button class="btn sm primary" onClick={() => svcAction(s, 'start')}>▶ Start</button>
        )}
        <button class="btn sm ghost" onClick={() => go(`/service/${s.key}/logs`)}>Logs</button>
      </div>
    </div>
  );
}

function DependencyGraph({ ws }: { ws: WorkspaceView }) {
  const edges = ws.services.flatMap((s) => s.dependsOn.map((d) => [d, s.name] as const));
  if (!edges.length) return null;
  const level = new Map<string, number>();
  const lv = (n: string, seen = new Set<string>()): number => {
    if (level.has(n)) return level.get(n)!;
    if (seen.has(n)) return 0;
    const s = ws.services.find((x) => x.name === n);
    const v = s && s.dependsOn.length ? 1 + Math.max(...s.dependsOn.map((d) => lv(d, new Set(seen).add(n)))) : 0;
    level.set(n, v);
    return v;
  };
  ws.services.forEach((s) => lv(s.name));
  const cols = new Map<number, string[]>();
  for (const [n, l] of level) cols.set(l, [...(cols.get(l) || []), n]);
  const colW = 180;
  const rowH = 46;
  const height = Math.max(...[...cols.values()].map((c) => c.length)) * rowH + 10;
  const pos = new Map<string, { x: number; y: number }>();
  for (const [l, names] of cols) names.forEach((n, i) => pos.set(n, { x: 10 + l * colW, y: 8 + i * rowH }));
  const width = (Math.max(...cols.keys()) + 1) * colW;
  return (
    <div class="panel pad graph" style={{ marginBottom: '14px' }}>
      <h2>Dependencies</h2>
      <svg viewBox={`0 0 ${width} ${height}`} style={{ maxHeight: `${height}px`, maxWidth: `${width}px` }}>
        {edges.map(([from, to]) => {
          const a = pos.get(from);
          const b = pos.get(to);
          if (!a || !b) return null;
          return <path class="edge" d={`M${a.x + 140},${a.y + 16} C${a.x + 165},${a.y + 16} ${b.x - 25},${b.y + 16} ${b.x},${b.y + 16}`} />;
        })}
        {[...pos.entries()].map(([n, p]) => {
          const s = ws.services.find((x) => x.name === n)!;
          return (
            <g class={`st-${s.status}`} style={{ cursor: 'pointer' }} onClick={() => go(`/service/${s.key}`)}>
              <rect x={p.x} y={p.y} width="140" height="32" rx="7" fill="var(--panel-2)" stroke="var(--c)" />
              <circle cx={p.x + 14} cy={p.y + 16} r="4.5" fill="var(--c)" />
              <text x={p.x + 26} y={p.y + 20}>
                {n.length > 15 ? n.slice(0, 14) + '…' : n}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function Overview({ ws }: { ws: WorkspaceView }) {
  const [busy, setBusy] = useState(false);
  const run = async (label: string, fn: () => Promise<any>) => {
    setBusy(true);
    await act(label, fn);
    setBusy(false);
  };
  const running = ws.services.filter(live).length;
  const failing = ws.services.filter((s) => ['crashed', 'backoff', 'unhealthy'].includes(s.status)).length;
  const cpu = ws.services.reduce((a, s) => a + (live(s) ? s.cpu || 0 : 0), 0);
  const mem = ws.services.reduce((a, s) => a + (live(s) ? s.mem || 0 : 0), 0);
  return (
    <>
      <div class="head">
        <div>
          <h1>{ws.name}</h1>
          <div class="sub mono">{ws.root}</div>
        </div>
        <div class="row">
          {Object.keys(ws.profiles).map((p) => (
            <button class="btn" disabled={busy} onClick={() => run(`up ${p}`, () => api('POST', `/api/workspaces/${ws.id}/up`, { profile: p }))}>
              ▶ {p}
            </button>
          ))}
          <button class="btn danger" disabled={busy} onClick={() => run('down', () => api('POST', `/api/workspaces/${ws.id}/down`))}>
            ■ Stop all
          </button>
          {ws.envProfiles.length > 0 && (
            <select
              class="btn"
              value={ws.envProfile || ''}
              onChange={(e) => run('env', () => api('POST', `/api/workspaces/${ws.id}/env`, { profile: (e.target as HTMLSelectElement).value || undefined, restart: true }).then(() => store.refresh()))}
            >
              <option value="">env: default</option>
              {ws.envProfiles.map((p) => (
                <option value={p}>env: {p}</option>
              ))}
            </select>
          )}
        </div>
      </div>
      {ws.configError && (
        <div class="panel pad" style={{ borderColor: 'var(--err)', marginBottom: '14px' }}>
          <b class="sev-error">Config error</b>
          <pre class="mono" style={{ whiteSpace: 'pre-wrap' }}>
            {ws.configError}
          </pre>
        </div>
      )}
      <div class="kpis">
        <div class="panel kpi">
          <div class="v">
            {running}/{ws.services.length}
          </div>
          <div class="k">running</div>
        </div>
        <div class="panel kpi">
          <div class="v" style={{ color: failing ? 'var(--err)' : undefined }}>
            {failing}
          </div>
          <div class="k">failing</div>
        </div>
        <div class="panel kpi">
          <div class="v">{cpu.toFixed(1)}%</div>
          <div class="k">CPU total</div>
        </div>
        <div class="panel kpi">
          <div class="v">{mb(mem)}</div>
          <div class="k">memory total</div>
        </div>
      </div>
      <DependencyGraph ws={ws} />
      <div class="grid">
        {ws.services.map((s) => (
          <ServiceCard s={s} key={s.key} />
        ))}
      </div>
    </>
  );
}

// ---------------------------------------------------------------- detail

function LogViewer({ s }: { s: ServiceView }) {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [filter, setFilter] = useState('');
  const [stream, setStream] = useState('');
  const [follow, setFollow] = useState(true);
  const [time, setTime] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let alive = true;
    api<{ lines: LogLine[] }>('GET', `/api/services/${s.key}/logs?tail=1000&ansi=1`).then((r) => alive && setLines(r.lines));
    const off = store.onLogs((key, more) => key === s.key && setLines((l) => [...l, ...more].slice(-5000)));
    return () => {
      alive = false;
      off();
    };
  }, [s.key]);
  useEffect(() => {
    if (follow && box.current) box.current.scrollTop = box.current.scrollHeight;
  });
  const re = useMemo(() => {
    if (!filter) return null;
    try {
      return new RegExp(filter, 'i');
    } catch {
      return new RegExp(filter.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    }
  }, [filter]);
  const plain = (t: string) => t.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  const shown = lines.filter((l) => (!stream || l.stream === stream) && (!re || re.test(plain(l.text))));
  return (
    <>
      <div class="toolbar">
        <input class="input" placeholder="Filter (regex)…" value={filter} onInput={(e) => setFilter((e.target as HTMLInputElement).value)} />
        <select class="btn" value={stream} onChange={(e) => setStream((e.target as HTMLSelectElement).value)}>
          <option value="">all streams</option>
          <option value="out">stdout</option>
          <option value="err">stderr</option>
          <option value="sys">devpilot</option>
        </select>
        <label class="row muted">
          <input type="checkbox" checked={follow} onChange={(e) => setFollow((e.target as HTMLInputElement).checked)} /> follow
        </label>
        <label class="row muted">
          <input type="checkbox" checked={time} onChange={(e) => setTime((e.target as HTMLInputElement).checked)} /> time
        </label>
        <span class="muted" style={{ marginLeft: 'auto' }}>
          {shown.length} lines
        </span>
        <button class="btn sm" onClick={() => act('clear logs', () => api('DELETE', `/api/services/${s.key}/logs`).then(() => setLines([])))}>
          Clear
        </button>
      </div>
      <div
        class="logs"
        ref={box}
        onScroll={(e) => {
          const el = e.currentTarget as HTMLDivElement;
          const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
          if (atBottom !== follow) setFollow(atBottom);
        }}
      >
        {shown.map((l) => (
          <div class={`l ${l.stream}`} key={l.seq}>
            {time && <span class="t">{new Date(l.t).toLocaleTimeString()}</span>}
            <span dangerouslySetInnerHTML={{ __html: re ? ansiToHtml(l.text).replace(new RegExp(`(${re.source})(?![^<]*>)`, 'gi'), '<mark>$1</mark>') : ansiToHtml(l.text) }} />
          </div>
        ))}
        {!shown.length && <div class="l muted">No log lines{filter ? ' match' : ' yet'}.</div>}
      </div>
    </>
  );
}

function Chart({ title, data, fmt, color }: { title: string; data: [number[], (number | null)[]]; fmt: (v: number) => string; color: string }) {
  const el = useRef<HTMLDivElement>(null);
  const plot = useRef<uPlot | undefined>(undefined);
  useEffect(() => {
    if (!el.current) return;
    const css = getComputedStyle(document.documentElement);
    const stroke = css.getPropertyValue(color.replace(/var\((.*)\)/, '$1')).trim() || color;
    const grid = css.getPropertyValue('--border').trim();
    const muted = css.getPropertyValue('--muted').trim();
    const opts: uPlot.Options = {
      width: el.current.clientWidth,
      height: 180,
      legend: { show: false },
      cursor: { drag: { x: false, y: false } },
      scales: { x: { time: true }, y: { range: (_u, _min, max) => [0, Math.max(max * 1.15, 1e-6)] } },
      axes: [
        { stroke: muted, grid: { stroke: grid, width: 1 }, ticks: { stroke: grid } },
        { stroke: muted, grid: { stroke: grid, width: 1 }, ticks: { stroke: grid }, values: (_u, vals) => vals.map((v) => fmt(v)), size: 64 },
      ],
      series: [{}, { stroke, width: 1.6, fill: `${stroke}22`, points: { show: false } }],
    };
    plot.current = new uPlot(opts, data as any, el.current);
    const ro = new ResizeObserver(() => el.current && plot.current?.setSize({ width: el.current.clientWidth, height: 180 }));
    ro.observe(el.current);
    return () => {
      ro.disconnect();
      plot.current?.destroy();
    };
  }, []);
  useEffect(() => plot.current?.setData(data as any), [data]);
  const lastVal = data[1].length ? data[1][data[1].length - 1] : null;
  return (
    <div class="panel chart">
      <h3>
        {title}{' '}
        <span class="muted" style={{ fontWeight: 400 }}>
          {lastVal !== null && lastVal !== undefined ? fmt(lastVal) : ''}
        </span>
      </h3>
      <div ref={el} />
    </div>
  );
}

function Metrics({ s }: { s: ServiceView }) {
  const [range, setRange] = useState<'15m' | '1h' | '24h'>('15m');
  const [pts, setPts] = useState<MetricPoint[]>([]);
  useEffect(() => {
    let alive = true;
    api<{ points: MetricPoint[] }>('GET', `/api/services/${s.key}/metrics?range=${range}`).then((r) => alive && setPts(r.points));
    const off =
      range === '24h'
        ? () => {}
        : store.onMetric((k, p) => k === s.key && setPts((x) => [...x, p].filter((q) => q.t >= Date.now() - (range === '15m' ? 9e5 : 36e5))));
    return () => {
      alive = false;
      off();
    };
  }, [s.key, range]);
  const xs = pts.map((p) => p.t / 1000);
  return (
    <>
      <div class="toolbar">
        {(['15m', '1h', '24h'] as const).map((r) => (
          <button class={`btn sm${r === range ? ' primary' : ''}`} onClick={() => setRange(r)}>
            {r}
          </button>
        ))}
        <span class="muted">{pts.length} samples</span>
      </div>
      {!pts.length ? (
        <div class="panel empty">No samples yet — metrics are collected every 3s while the service runs.</div>
      ) : (
        <div class="charts" key={range}>
          <Chart title="CPU" color="var(--accent)" data={[xs, pts.map((p) => p.cpu)]} fmt={(v) => `${v.toFixed(1)}%`} />
          <Chart title="Memory" color="var(--ok)" data={[xs, pts.map((p) => p.mem)]} fmt={(v) => `${Math.round(v / 1048576)} MB`} />
          {pts.some((p) => p.latency !== undefined) && <Chart title="Health latency" color="var(--warn)" data={[xs, pts.map((p) => p.latency ?? null)]} fmt={(v) => `${Math.round(v)} ms`} />}
        </div>
      )}
    </>
  );
}

function IncidentList({ list, showService }: { list: Incident[]; showService?: boolean }) {
  const [open, setOpen] = useState<string | null>(null);
  if (!list.length) return <div class="panel empty">No incidents.</div>;
  return (
    <div class="panel">
      {list.map((i) => (
        <div class="inc" key={i.id}>
          <div class="t" onClick={() => setOpen(open === i.id ? null : i.id)}>
            <span class={`sev-${i.severity}`}>{i.severity === 'error' ? '✖' : '⚠'}</span>
            <span class="muted mono" style={{ flex: 'none' }}>
              {new Date(i.at).toLocaleString()}
            </span>
            {showService && (
              <a href={`#/service/${i.key}`} onClick={(e) => e.stopPropagation()}>
                {i.service}
              </a>
            )}
            <span class="tag">{i.kind}</span>
            <span class="ttl">{i.title}</span>
            {i.count > 1 && <span class="muted">×{i.count}</span>}
            {i.resolvedAt ? <span style={{ color: 'var(--ok)', fontSize: '12px' }}>resolved</span> : null}
          </div>
          {open === i.id && i.context.length > 0 && <pre>{i.context.join('\n')}</pre>}
        </div>
      ))}
    </div>
  );
}

function ServiceIncidents({ s }: { s: ServiceView }) {
  const [list, setList] = useState<Incident[]>([]);
  useEffect(() => {
    api<Incident[]>('GET', `/api/incidents?key=${encodeURIComponent(s.key)}&limit=100`).then(setList);
  }, [s.key, s.openIncidents]);
  return <IncidentList list={list} />;
}

function Diagnose({ s }: { s: ServiceView }) {
  const [d, setD] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const run = async () => {
    setLoading(true);
    try {
      setD(await api('GET', `/api/services/${s.key}/diagnose`));
    } catch (e: any) {
      toast(e.message);
    }
    setLoading(false);
  };
  useEffect(() => void run(), [s.key]);
  const icon: Record<string, any> = {
    error: <span class="sev-error">✖</span>,
    warning: <span class="sev-warning">⚠</span>,
    info: <span style={{ color: 'var(--info)' }}>ℹ</span>,
  };
  return (
    <div class="panel pad">
      <div class="row" style={{ justifyContent: 'space-between' }}>
        <div class="verdict">{d ? d.verdict : 'Diagnosing…'}</div>
        <button class="btn sm" disabled={loading} onClick={run}>
          Re-run
        </button>
      </div>
      {d?.findings.map((f: any) => (
        <div class="finding">
          <div>{icon[f.level]}</div>
          <div>
            <div>{f.title}</div>
            {f.detail && (
              <div class="muted mono" style={{ fontSize: '12px' }}>
                {f.detail}
              </div>
            )}
            {f.suggestion && <div class="sug">→ {f.suggestion}</div>}
          </div>
        </div>
      ))}
      {d?.errorBlock?.length > 0 && (
        <>
          <h2 style={{ marginTop: '14px' }}>Error block</h2>
          <div class="logs" style={{ height: 'auto', maxHeight: '340px', minHeight: 0 }}>
            {d.errorBlock.map((l: string) => (
              <div class={`l ${l.startsWith('! ') ? 'err' : ''}`}>{l.replace(/^! /, '')}</div>
            ))}
          </div>
        </>
      )}
      <p class="muted" style={{ fontSize: '12.5px', marginBottom: 0 }}>
        Ask Claude: <code>diagnose {s.name} and propose a fix</code>
      </p>
    </div>
  );
}

function Env({ s }: { s: ServiceView }) {
  const [env, setEnv] = useState<any>(null);
  useEffect(() => {
    api('GET', `/api/services/${s.key}/env`).then(setEnv);
  }, [s.key]);
  if (!env) return null;
  return (
    <div class="panel">
      <table class="t">
        <tbody>
          {env.envFiles.map((f: any) => (
            <tr>
              <td style={{ width: '140px' }}>{f.exists ? <span style={{ color: 'var(--ok)' }}>env file</span> : <span class="sev-error">missing env file</span>}</td>
              <td class="mono">{f.path}</td>
            </tr>
          ))}
          {env.vars.map((v: any) => (
            <tr>
              <td class="mono">{v.key}</td>
              <td class="mono" style={{ wordBreak: 'break-all' }}>
                {v.value}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ServiceDetail({ s, tab }: { s: ServiceView; tab: string }) {
  const tabs = ['logs', 'metrics', 'incidents', 'diagnose', 'env'];
  const t = tabs.includes(tab) ? tab : 'logs';
  return (
    <>
      <div class="head">
        <div>
          <div class="row">
            <a href={`#/ws/${s.workspace}`} class="muted">
              {s.workspace}
            </a>
            <span class="muted">/</span>
            <h1>{s.name}</h1>
            <Status s={s} />
          </div>
          <div class="sub mono">
            {s.run} · {s.cwd}
          </div>
          <div class="sub row" style={{ gap: '14px' }}>
            {s.port && (
              <a href={s.url} target="_blank">
                {s.url}
              </a>
            )}
            <Health s={s} />
            {s.pid && (
              <span>
                PID {s.pid}
                {s.image ? ` · ${s.image}` : ''}
                {s.adopted ? ' · re-attached' : ''}
              </span>
            )}
            {live(s) && <span>up {ago(s.startedAt)}</span>}
            <span>↻ {s.restarts}</span>
            {s.dependsOn.length > 0 && <span>needs {s.dependsOn.join(', ')}</span>}
          </div>
        </div>
        <div class="row">
          {live(s) || s.status === 'backoff' ? (
            <>
              <button class="btn" onClick={() => svcAction(s, 'restart')}>
                ↻ Restart
              </button>
              <button class="btn danger" onClick={() => svcAction(s, 'stop')}>
                ■ Stop
              </button>
            </>
          ) : (
            <button class="btn primary" onClick={() => svcAction(s, 'start')}>
              ▶ Start
            </button>
          )}
        </div>
      </div>
      <div class="tabs">
        {tabs.map((x) => (
          <div class={`tab${x === t ? ' active' : ''}`} onClick={() => go(`/service/${s.key}/${x}`)}>
            {x[0].toUpperCase() + x.slice(1)}
            {x === 'incidents' && s.openIncidents > 0 ? ` (${s.openIncidents})` : ''}
          </div>
        ))}
      </div>
      {t === 'logs' && <LogViewer s={s} />}
      {t === 'metrics' && <Metrics s={s} />}
      {t === 'incidents' && <ServiceIncidents s={s} />}
      {t === 'diagnose' && <Diagnose s={s} />}
      {t === 'env' && <Env s={s} />}
    </>
  );
}

// ---------------------------------------------------------------- others

function Incidents() {
  const [list, setList] = useState<Incident[]>([]);
  const st = useStore();
  useEffect(() => {
    api<Incident[]>('GET', '/api/incidents?limit=200').then(setList);
  }, [st.incidents]);
  return (
    <>
      <div class="head">
        <h1>Incidents</h1>
      </div>
      <IncidentList list={list} showService />
    </>
  );
}

function Ports() {
  const [rows, setRows] = useState<any[] | null>(null);
  const load = () => api<any[]>('GET', '/api/ports').then(setRows);
  useEffect(() => void load(), []);
  return (
    <>
      <div class="head">
        <h1>Ports</h1>
        <button class="btn" onClick={load}>
          Refresh
        </button>
      </div>
      <div class="panel">
        {!rows ? (
          <div class="empty">Loading…</div>
        ) : (
          <table class="t">
            <thead>
              <tr>
                <th>Port</th>
                <th>PID</th>
                <th>Process</th>
                <th>Service</th>
                <th>Command</th>
              </tr>
            </thead>
            <tbody>
              {rows
                .filter((r) => r.port >= 1024 && r.port < 49152)
                .map((r) => (
                  <tr>
                    <td class="mono">{r.port}</td>
                    <td class="mono">{r.pid}</td>
                    <td>{r.name}</td>
                    <td>
                      {r.service ? (
                        <a href={`#/service/${r.service}`}>{r.service.split('/')[1]}</a>
                      ) : r.configuredBy.length ? (
                        <span class="sev-error">conflicts with {r.configuredBy.map((k: string) => k.split('/')[1]).join(', ')}</span>
                      ) : (
                        ''
                      )}
                    </td>
                    <td class="mono muted" style={{ wordBreak: 'break-all' }}>
                      {r.cmd}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

function Login() {
  return (
    <div class="empty" style={{ paddingTop: '18vh' }}>
      <div class="brand" style={{ justifyContent: 'center', fontSize: '20px', marginBottom: '12px' }}>
        <span class="logo">D</span> DevPilot
      </div>
      <p>This browser is not logged in to the daemon.</p>
      <p>
        Run <code>devpilot open</code> in a terminal (or ask Claude to) — it opens a one-time login link.
      </p>
    </div>
  );
}

function App() {
  const st = useStore();
  const route = useHashRoute();
  const [theme, setTheme] = useState(() => {
    try {
      return localStorage.getItem('devpilot-theme') || 'dark';
    } catch {
      return 'dark';
    }
  });
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem('devpilot-theme', theme);
    } catch {
      /* private mode */
    }
  }, [theme]);
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 5000);
    return () => clearInterval(t);
  }, []);

  if (st.unauthorized) return <Login />;

  const [page, a, b, c] = route;
  let content;
  if (page === 'service' && a && b) {
    const s = store.service(`${a}/${b}`);
    content = s ? <ServiceDetail s={s} tab={c || 'logs'} /> : <div class="empty">Loading {a}/{b}…</div>;
  } else if (page === 'incidents') content = <Incidents />;
  else if (page === 'ports') content = <Ports />;
  else {
    const ws = st.workspaces.find((w) => w.id === a) || st.workspaces[0];
    content = ws ? (
      <Overview ws={ws} />
    ) : (
      <div class="empty">
        <h2>No workspaces yet</h2>
        <p>
          In a project folder run <code>devpilot init --write</code>, or ask Claude to set up DevPilot.
        </p>
      </div>
    );
  }
  const activeWs = page === 'service' ? a : page === 'ws' || !page ? a || st.workspaces[0]?.id : undefined;
  const openInc = st.incidents.length;

  return (
    <div class="layout">
      <div class="top">
        <div class="brand">
          <span class="logo">D</span> DevPilot
        </div>
        <span class="muted" style={{ fontSize: '12.5px' }}>
          {st.version && `v${st.version}`}
        </span>
        <div class="spacer" />
        <div class="conn">
          <span class="dot" style={{ background: st.connected ? 'var(--ok)' : 'var(--err)' }} />
          {st.connected ? `live · daemon up ${ago(st.daemonStartedAt)}` : 'disconnected'}
        </div>
        <button class="btn ghost sm" title="Toggle theme" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
          {theme === 'dark' ? '☀' : '☾'}
        </button>
      </div>
      <div class="side">
        <h4>Workspaces</h4>
        {st.workspaces.map((w) => {
          const bad = w.services.filter((s) => ['crashed', 'backoff', 'unhealthy'].includes(s.status)).length;
          return (
            <a class={`nav${activeWs === w.id ? ' active' : ''}`} href={`#/ws/${w.id}`}>
              <span class="dot" style={{ background: bad ? 'var(--err)' : w.services.some(live) ? 'var(--ok)' : 'var(--muted)' }} />
              {w.name}
              <span class="count">
                {w.services.filter(live).length}/{w.services.length}
              </span>
            </a>
          );
        })}
        <h4>Monitor</h4>
        <a class={`nav${page === 'incidents' ? ' active' : ''}`} href="#/incidents">
          ⚠ Incidents{' '}
          {openInc > 0 && (
            <span class="count" style={{ color: 'var(--err)' }}>
              {openInc} open
            </span>
          )}
        </a>
        <a class={`nav${page === 'ports' ? ' active' : ''}`} href="#/ports">
          ⇄ Ports
        </a>
      </div>
      <div class="main">{content}</div>
    </div>
  );
}

store.connect();
render(<App />, document.getElementById('app')!);
