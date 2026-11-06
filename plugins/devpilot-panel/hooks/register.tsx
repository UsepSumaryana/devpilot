// DevPilot pane: a live view of the services the devpilot daemon supervises,
// beside the chat. Polls the daemon's local API; never starts anything on
// its own except when the person presses a button.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Changed, Confirm, Row, Scope, Snapshot, Ws } from '../types'

const PANE = 'devpilot'
const EMPTY: Snapshot = { daemon: 'unknown', detail: null, projectWs: null, workspaces: [], openIncidents: 0, updatedAt: 0 }

// Bump a tag when the stored shape changes: the old value is declined.
const snapshot = atom({ plugin: 'devpilot-panel', key: 'snapshot' } as const, EMPTY, { shape: 'snapshot-5' })
const scope = atom({ plugin: 'devpilot-panel', key: 'scope' } as const, 'project' as Scope, { shape: 'scope-1' })
const busy = atom({ plugin: 'devpilot-panel', key: 'busy' } as const, null as string | null, { shape: 'busy-1' })
const menu = atom({ plugin: 'devpilot-panel', key: 'menu' } as const, false, { shape: 'menu-1' })
const confirm = atom({ plugin: 'devpilot-panel', key: 'confirm' } as const, null as Confirm | null, { shape: 'confirm-1' })
// Whether the pane is up in this session (drives the band above the prompt).
const paneOpen = atom({ plugin: 'devpilot-panel', key: 'paneOpen' } as const, false, { shape: 'pane-open-1' })
// Running services whose code Claude edited since they started, and the band's "restart them?" step.
const changed = atom({ plugin: 'devpilot-panel', key: 'changed' } as const, [] as Changed[], { shape: 'changed-1' })
const restartAsk = atom({ plugin: 'devpilot-panel', key: 'restartAsk' } as const, false, { shape: 'restart-ask-1' })

type Daemon = { port: number; token: string }

const LIVE = ['running', 'starting', 'unhealthy', 'backoff']
const FAILING = ['crashed', 'backoff', 'unhealthy']

const join = (...parts: string[]) => parts.join('/').replace(/[\\/]+/g, '/')

// ------------------------------------------------------------- daemon access

async function home($: EngineInterface): Promise<string> {
  const explicit = await $.env.get('DEVPILOT_HOME')
  if (explicit) return explicit
  const base = (await $.env.get('USERPROFILE')) || (await $.env.get('HOME')) || ''
  return join(base, '.devpilot')
}

async function daemonInfo($: EngineInterface): Promise<Daemon | null> {
  try {
    const raw = JSON.parse(await $.fs.read(join(await home($), 'daemon.json')))
    return typeof raw.port === 'number' && typeof raw.token === 'string' ? { port: raw.port, token: raw.token } : null
  } catch {
    return null
  }
}

async function call($: EngineInterface, d: Daemon, method: string, path: string, body?: unknown): Promise<any> {
  const r = await $.http.fetch(`http://127.0.0.1:${d.port}${path}`, {
    method,
    headers: { authorization: `Bearer ${d.token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  let data: any = null
  try {
    data = r.text ? JSON.parse(r.text) : null
  } catch {
    /* not json */
  }
  if (!r.ok) throw new Error(data?.error || `HTTP ${r.status}`)
  return data
}

function toRow(s: any): Row {
  return {
    key: s.key,
    name: s.name,
    status: s.status,
    port: s.port ?? null,
    url: s.url ?? null,
    health: s.health?.state ?? 'none',
    latencyMs: s.health?.latencyMs ?? null,
    cpu: typeof s.cpu === 'number' ? s.cpu : null,
    memMb: typeof s.mem === 'number' ? Math.round(s.mem / 1048576) : null,
    restarts: s.restarts ?? 0,
    exitCode: typeof s.exitCode === 'number' ? s.exitCode : null,
    lastError: s.lastError ?? null,
    openIncidents: s.openIncidents ?? 0,
    dependsOn: Array.isArray(s.dependsOn) ? s.dependsOn : [],
    group: s.group ?? null,
    queued: s.queued === true,
    mode: typeof s.mode === 'string' ? s.mode : 'default',
    modes: Array.isArray(s.modes) ? s.modes : ['default'],
    task: typeof s.task === 'string' ? s.task : null,
    tasks: Array.isArray(s.tasks) ? s.tasks : [],
    cwd: typeof s.cwd === 'string' ? s.cwd : '',
    run: typeof s.run === 'string' ? s.run : '',
    runs: Array.isArray(s.runs) ? s.runs : typeof s.run === 'string' ? [s.run] : [],
    startedAt: typeof s.startedAt === 'number' ? s.startedAt : null,
  }
}

function toWs(w: any): Ws {
  return {
    id: w.id,
    name: w.name,
    envProfile: w.envProfile ?? null,
    services: (w.services || []).map(toRow),
    mode: typeof w.mode === 'string' ? w.mode : 'default',
    modes: Array.isArray(w.modes) ? w.modes : ['default'],
    tasks: Array.isArray(w.tasks) ? w.tasks : [],
    serviceTasks: Array.isArray(w.serviceTasks) ? w.serviceTasks : [],
    runningTasks: (w.runningTasks || []).map((t: any) => (t.service ? `${t.task} (${t.service})` : t.task)),
  }
}

// Module state: starts over when the module reloads, which is fine.
let cwd = ''
let projectWs: string | null = null
/** The session folder (or a parent) has a devpilot.yaml: only then do the pane and band show up. */
let isProject = false
let resolvedOnce = false
const seen = new Set<string>()
let seeded = false
/** The poll under way, shared: a caller that needs fresh data waits for it instead of skipping. */
let inflight: Promise<void> | null = null

function poll($: EngineInterface): Promise<void> {
  inflight ??= pollOnce($).finally(() => {
    inflight = null
  })
  return inflight
}

async function pollOnce($: EngineInterface) {
  {
    const d = await daemonInfo($)
    if (!d) {
      await update($, snapshot, (s): Snapshot => ({ ...s, daemon: 'down', detail: 'not running', workspaces: [], openIncidents: 0, updatedAt: Date.now() }))
      $.ui.status(undefined)
      return
    }
    let sum: any
    try {
      sum = await call($, d, 'GET', '/api/summary')
    } catch (e) {
      await update($, snapshot, (s): Snapshot => ({ ...s, daemon: 'down', detail: String((e as Error).message || e), updatedAt: Date.now() }))
      $.ui.status(undefined)
      return
    }
    if (!resolvedOnce && cwd) {
      try {
        projectWs = (await call($, d, 'GET', `/api/resolve?cwd=${encodeURIComponent(cwd)}`)).workspace ?? null
        resolvedOnce = true
      } catch {
        /* retry next poll */
      }
    }
    const workspaces: Ws[] = (sum.workspaces || []).map(toWs)
    if (projectWs === null && workspaces.length && resolvedOnce) resolvedOnce = false // registered later? look again
    await update($, snapshot, (): Snapshot => ({ daemon: 'up', detail: null, projectWs, workspaces, openIncidents: (sum.incidents || []).length, updatedAt: Date.now() }))

    const all = workspaces.flatMap((w) => w.services)
    const pendingChanges = await read($, changed)
    if (pendingChanges.length) {
      const still = pendingChanges.filter((c) => {
        const r = all.find((x) => x.key === c.key)
        return !!r && LIVE.includes(r.status) && (r.startedAt ?? 0) <= c.at
      })
      if (still.length !== pendingChanges.length) {
        await update($, changed, (): Changed[] => still)
        if (!still.length) await update($, restartAsk, (): boolean => false)
      }
    }

    const mine = workspaces.find((w) => w.id === projectWs)
    const rows = (mine ? [mine] : workspaces).flatMap((w) => w.services)
    const up = rows.filter((r) => r.status === 'running').length
    const bad = rows.filter((r) => FAILING.includes(r.status)).length
    $.ui.status(rows.length ? `devpilot ${up}/${rows.length} up${bad ? ` · ${bad} failing` : ''}` : undefined)

    for (const i of sum.incidents || []) {
      if (seen.has(i.id)) continue
      seen.add(i.id)
      if (!seeded) continue
      if (projectWs && i.workspace !== projectWs) continue
      const text = `${i.service}: ${i.title}`
      $.ui.toast(`DevPilot ${i.severity === 'error' ? '✖' : '⚠'} ${text}`, { timeoutMs: 8000 })
      if (i.severity === 'error' && i.kind !== 'error-log') void $.ui.notify(text, { title: 'DevPilot' })
    }
    seeded = true
  }
}

/** Background poll: a failure (daemon gone, module unloading) must never surface as an unhandled rejection. */
function tick($: EngineInterface) {
  poll($).catch(() => undefined)
}

async function act($: EngineInterface, label: string, method: string, path: string, body?: unknown) {
  const d = await daemonInfo($)
  if (!d) return $.ui.toast('DevPilot daemon is not running')
  await update($, busy, (): string | null => label)
  try {
    const r = await call($, d, method, path, body ?? {})
    const list = Array.isArray(r) ? r : [r]
    const bad = list.find((x: any) => x && x.ok === false)
    if (bad) $.ui.toast(`${label}: ${bad.reason || 'failed'}`, { timeoutMs: 8000 })
  } catch (e) {
    $.ui.toast(`${label}: ${(e as Error).message}`, { timeoutMs: 8000 })
  } finally {
    await update($, busy, (): string | null => null)
    await poll($)
  }
}

/** Ask before anything that changes what runs: the press shows a confirmation card first. */
async function propose($: EngineInterface, c: Confirm) {
  await update($, confirm, (): Confirm | null => c)
}

async function decide($: EngineInterface, ok: boolean) {
  const c = await read($, confirm)
  await update($, confirm, (): Confirm | null => null)
  if (ok && c) await act($, c.busy, c.method, c.path, c.body ?? undefined)
}

/** Running services that (transitively) depend on `name`. */
function runningDependents(name: string, services: Row[]): string[] {
  const out = new Set<string>()
  let frontier = [name]
  while (frontier.length) {
    const next: string[] = []
    for (const r of services) if (!out.has(r.name) && r.dependsOn.some((d) => frontier.includes(d))) (out.add(r.name), next.push(r.name))
    frontier = next
  }
  return services.filter((r) => out.has(r.name) && LIVE.includes(r.status)).map((r) => r.name)
}

const listed = (names: string[], max = 4) => (names.length > max ? `${names.slice(0, max).join(', ')} +${names.length - max}` : names.join(', '))

async function openUrl($: EngineInterface, url: string) {
  const isWin = (await $.env.get('OS')) === 'Windows_NT'
  const argv = isWin ? ['rundll32', 'url.dll,FileProtocolHandler', url] : (await $.env.get('XDG_CURRENT_DESKTOP')) !== undefined ? ['xdg-open', url] : ['open', url]
  try {
    await $.process.run(argv, { timeoutMs: 10_000 })
  } catch {
    $.ui.toast(`Open ${url}`)
  }
}

async function startDaemon($: EngineInterface) {
  try {
    const info = JSON.parse(await $.fs.read(join(await home($), 'install.json')))
    await update($, busy, (): string | null => 'Starting the daemon')
    const r = await $.process.run([info.node, info.cli, 'daemon', 'start'], { timeoutMs: 20_000 })
    if (r.exitCode !== 0) $.ui.toast(`devpilot daemon start failed: ${r.stderr.slice(0, 200)}`)
  } catch {
    $.ui.toast('Run `devpilot daemon start` (the DevPilot plugin must be installed)')
  } finally {
    await update($, busy, (): string | null => null)
    await poll($)
  }
}

/** Opens the dashboard, logged in, optionally at a hash route (`/service/<key>/logs`). */
async function openDashboard($: EngineInterface, route = '') {
  const d = await daemonInfo($)
  if (!d) return $.ui.toast('DevPilot daemon is not running')
  const { code } = await call($, d, 'POST', '/api/auth/code', {})
  const to = encodeURIComponent(route ? `/#${route}` : '/')
  await openUrl($, `http://127.0.0.1:${d.port}/auth?code=${code}&to=${to}`)
}

const CONFIG_FILES = ['devpilot.yaml', 'devpilot.yml', '.devpilot.yaml']

async function hasConfig($: EngineInterface, dir: string): Promise<boolean> {
  let d = dir.replace(/\\/g, '/').replace(/\/+$/, '')
  for (let i = 0; i < 40 && d; i++) {
    for (const f of CONFIG_FILES) {
      try {
        await $.fs.read(`${d}/${f}`)
        return true
      } catch {
        /* not here */
      }
    }
    const up = d.replace(/\/[^/]*$/, '')
    if (!up || up === d || /^[A-Za-z]:$/.test(d)) break
    d = up
  }
  return false
}

/** The person's last choice, remembered across sessions: open or not. */
async function rememberOpen($: EngineInterface, open: boolean) {
  await update($, paneOpen, (): boolean => open)
  try {
    await $.store.set('paneOpen', open)
  } catch {
    /* the preference is a convenience */
  }
}

async function openPane($: EngineInterface) {
  await $.ui.open({ id: PANE, title: 'Services' })
  await rememberOpen($, true)
  await poll($)
}

async function togglePane($: EngineInterface): Promise<boolean> {
  const isUp = (await $.ui.panes()).some((p) => p.id === PANE)
  if (isUp) {
    await $.ui.close({ id: PANE }) // the ui.close hook records the choice
    return false
  }
  await openPane($)
  return true
}

// ---------------------------------------------------------------- layout model

// Palette of the services-panel design. Accents only: neutral text
// keeps the theme's own colours so the pane still reads in dark mode.
const C = {
  muted: '#6B6963',
  border: '#ECEAE5',
  btnBorder: '#E0DDD6',
  bar: '#E8E6E1',
  hollow: '#A3A19B',
  queued: '#8A877F',
  green: '#17B26A',
  greenRing: '#DCFAE6',
  greenText: '#157F3C',
  blue: '#175CD3',
  blueBar: '#84ADFF',
  blueBg: '#F5F8FF',
  blueRing: '#D1E0FF',
  red: '#D92D20',
  redRing: '#FEE4E2',
  redText: '#B42318',
  cardBg: '#FEF3F2',
  cardBorder: '#FECDCA',
  cardTitle: '#7A271A',
  cardBody: '#912018',
  failRowBg: '#FFFBFA',
}

type Kind = 'running' | 'starting' | 'queued' | 'failing' | 'stopped'

function kindOf(r: Row): Kind {
  if (r.task) return 'starting' // a task (install, build) is running for it
  if (r.queued) return 'queued'
  if (FAILING.includes(r.status)) return 'failing'
  if (r.status === 'running') return 'running'
  if (r.status === 'starting' || r.status === 'stopping') return 'starting'
  return 'stopped'
}

type Group = { label: string; rows: Row[]; needs: string[] }

/**
 * Groups for display: the `group:` a service declares, else its tier in the
 * dependency graph, named after what lives there (Infra, BFF, Frontend, ...).
 */
function groupsOf(services: Row[]): Group[] {
  const byName = new Map(services.map((r) => [r.name, r]))
  const depth = new Map<string, number>()
  const depthOf = (r: Row, seenNames: Set<string>): number => {
    if (depth.has(r.name)) return depth.get(r.name)!
    if (seenNames.has(r.name)) return 0
    const next = new Set(seenNames).add(r.name)
    const ds = r.dependsOn.map((d) => byName.get(d)).filter((x): x is Row => !!x)
    const v = ds.length ? 1 + Math.max(...ds.map((d) => depthOf(d, next))) : 0
    depth.set(r.name, v)
    return v
  }
  const tierLabel = (rows: Row[], tier: number): string => {
    const names = rows.map((r) => r.name.toLowerCase()).join(' ')
    if (tier === 0 && (rows.every((r) => r.port === null || /infra|db|redis|postgres|mysql|mongo|kafka|rabbit|compose/.test(r.name)) || /infra/.test(names))) return 'Infra'
    if (rows.every((r) => /bff|gateway/.test(r.name))) return 'BFF'
    if (rows.every((r) => /front|web|ui|app|portal|admin/.test(r.name))) return 'Frontend'
    if (tier <= 1) return 'Core services'
    return `Tier ${tier + 1}`
  }

  const named = new Map<string, Row[]>()
  const order: string[] = []
  const tiers = new Map<number, Row[]>()
  for (const r of services) {
    if (r.group) {
      if (!named.has(r.group)) {
        named.set(r.group, [])
        order.push(r.group)
      }
      named.get(r.group)!.push(r)
    } else {
      const t = depthOf(r, new Set())
      tiers.set(t, [...(tiers.get(t) || []), r])
    }
  }
  const groups: Group[] = []
  for (const t of [...tiers.keys()].sort((a, b) => a - b)) groups.push({ label: tierLabel(tiers.get(t)!, t), rows: tiers.get(t)!, needs: [] })
  for (const g of order) groups.push({ label: g, rows: named.get(g)!, needs: [] })

  const groupOf = new Map<string, Group>()
  for (const g of groups) for (const r of g.rows) groupOf.set(r.name, g)
  for (const g of groups) {
    const up = new Set<string>()
    for (const r of g.rows)
      for (const d of r.dependsOn) {
        const dg = groupOf.get(d)
        const dep = byName.get(d)
        if (dg && dg !== g && dep && dep.status !== 'running') up.add(dg.label)
      }
    g.needs = [...up]
  }
  return groups
}

/** Services that (transitively) depend on `name` and are not running. */
function heldBy(name: string, services: Row[]): number {
  const held = new Set<string>()
  let frontier = [name]
  while (frontier.length) {
    const next: string[] = []
    for (const r of services) {
      if (held.has(r.name) || r.status === 'running') continue
      if (r.dependsOn.some((d) => frontier.includes(d))) {
        held.add(r.name)
        next.push(r.name)
      }
    }
    frontier = next
  }
  return held.size
}

function alertTitle(r: Row): string {
  if (r.status === 'backoff' || (r.status === 'crashed' && r.restarts > 0)) return `${r.name} is crash-looping`
  if (r.status === 'unhealthy') return `${r.name} is unhealthy`
  return `${r.name} has crashed`
}

function alertText(r: Row, services: Row[]): string {
  const held = heldBy(r.name, services)
  const exit = r.status === 'unhealthy' ? 'Its health check is failing' : r.exitCode !== null ? `Exited with code ${r.exitCode}` : 'Exited'
  const after = r.restarts > 0 && r.status !== 'unhealthy' ? ` after ${r.restarts} restart${r.restarts > 1 ? 's' : ''}` : ''
  const deps = held ? ` ${held} service${held > 1 ? 's' : ''} depend on it and ${held > 1 ? 'are' : 'is'} on hold.` : ''
  return `${exit}${after}.${deps}`
}

// ------------------------------------------------------------------ svg bits

const svg = (w: number, h: number, body: string, extra = '') => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"${extra}>${body}</svg>`

const SPIN = (color: string, track?: string) =>
  svg(
    12,
    12,
    `${track ? `<circle cx="6" cy="6" r="4.5" fill="none" stroke="${track}" stroke-width="2"/>` : ''}<path d="M6 1.5a4.5 4.5 0 0 1 4.5 4.5" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round"><animateTransform attributeName="transform" type="rotate" from="0 6 6" to="360 6 6" dur="0.9s" repeatCount="indefinite"/></path>`,
  )

function dotSvg(k: Kind): string {
  switch (k) {
    case 'running':
      return svg(16, 16, `<circle cx="8" cy="8" r="8" fill="${C.greenRing}"/><circle cx="8" cy="8" r="5" fill="${C.green}"/>`)
    case 'failing':
      return svg(16, 16, `<circle cx="8" cy="8" r="8" fill="${C.redRing}"/><circle cx="8" cy="8" r="5" fill="${C.red}"/>`)
    case 'starting':
      return svg(16, 16, `<g transform="translate(2 2)">${SPIN(C.blue, C.blueRing).replace(/^<svg[^>]*>|<\/svg>$/g, '')}</g>`)
    case 'queued':
      return svg(16, 16, `<circle cx="8" cy="8" r="4.25" fill="none" stroke="${C.queued}" stroke-width="1.5" stroke-dasharray="2 2"/>`)
    default:
      return svg(16, 16, `<circle cx="8" cy="8" r="4.25" fill="none" stroke="${C.hollow}" stroke-width="1.5"/>`)
  }
}

const ALERT_ICON = svg(
  28,
  28,
  `<rect width="28" height="28" rx="8" fill="${C.redRing}"/><g transform="translate(6 6) scale(0.6667)" fill="none" stroke="${C.redText}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 15.5-6.3L21 8"/><path d="M21 3v5h-5"/><path d="M12 8v5"/><circle cx="12" cy="16.5" r="0.6" fill="${C.redText}"/></g>`,
)

const DIVIDER = `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="1" viewBox="0 0 1000 1" preserveAspectRatio="none"><rect width="1000" height="1" fill="${C.border}"/></svg>`

/**
 * Segmented health bar, drawn at (about) the pane's real pixel width so the
 * stretch to the slot is ~1:1 and the 3px corners stay round. A fixed narrow
 * viewBox stretched across the pane turned 2 segments into flat lozenges.
 */
function barSvg(services: Row[], widthPx: number): string {
  const n = Math.max(1, services.length)
  const w = Math.max(120, Math.round(widthPx))
  const gap = n > 1 ? Math.max(3, Math.min(6, w / n / 8)) : 0
  const seg = (w - gap * (n - 1)) / n
  const fill = (r: Row) => {
    const k = kindOf(r)
    return k === 'running' ? C.green : k === 'starting' ? C.blueBar : k === 'failing' ? C.red : C.bar
  }
  const rects = services
    .map((r, i) => `<rect x="${(i * (seg + gap)).toFixed(1)}" y="0" width="${seg.toFixed(1)}" height="6" rx="3" ry="3" fill="${fill(r)}"/>`)
    .join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="6" viewBox="0 0 ${w} 6" preserveAspectRatio="none">${rects}</svg>`
}

const diagnosePrompt = (r: Row) =>
  `DevPilot service ${r.key} is ${r.status}${r.lastError ? ` (${r.lastError})` : ''}. Diagnose it with \`devpilot diagnose ${r.key} --json\` and propose a fix — don't change anything yet.`

const triagePrompt = (w: Ws) =>
  `Summarise the open DevPilot incidents of workspace ${w.id} (\`devpilot incidents --open --ws ${w.id} --json\`), most important first, and say which need action. Don't change anything.`

// ------------------------------------------------- guard and code changes
// Claude starting a managed service itself (`yarn start:dev` in its folder) blocks the turn and
// races DevPilot for the port; an edit to a service without a watcher leaves it on old code.

const slash = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '')
const isWin = (p: string) => /^[A-Za-z]:/.test(p)
/** Same folder, or inside it. Case-insensitive on Windows paths. */
function within(path: string, dir: string): boolean {
  if (!path || !dir) return false
  let f = slash(path)
  let d = slash(dir)
  if (isWin(d)) {
    f = f.toLowerCase()
    d = d.toLowerCase()
  }
  return f === d || f.startsWith(d + '/')
}

/** Resolves `p` (absolute, relative, or Git Bash's `/d/x`) against `base`. */
function resolveDir(base: string, p: string): string {
  const raw = p.replace(/^["']|["']$/g, '')
  const gitBash = isWin(base) ? /^\/([a-zA-Z])(\/.*)?$/.exec(raw) : null
  const full = gitBash ? `${gitBash[1]!.toUpperCase()}:${gitBash[2] ?? '/'}` : /^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith('/') ? raw : `${base}/${raw}`
  const out: string[] = []
  for (const seg of slash(full).split('/')) {
    if (seg === '..') out.pop()
    else if (seg !== '.' && seg !== '') out.push(seg)
  }
  return (slash(full).startsWith('/') ? '/' : '') + out.join('/')
}

/** One shell command made comparable: env prefixes dropped, `npm run x` / `yarn x` / `pnpm x` / `bun run x` read as `script x`, a `--prefix`/`--cwd` folder pulled out. */
function canon(cmd: string): { text: string; dir: string | null } {
  let c = cmd.trim().replace(/\s+/g, ' ')
  c = c.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S* )+/, '')
  let dir: string | null = null
  c = c.replace(/ (?:--prefix|--cwd|-C|--dir)[ =](\S+)/, (_m: string, d: string) => {
    dir = d
    return ''
  })
  const m = /^(npm|pnpm|bun|yarn)(?: run(?:-script)?)? ([\w:.@/-]+)(.*)$/.exec(c)
  if (m && !(m[1] === 'npm' && /^(?:i|install|ci|exec|x)$/.test(m[2]!))) c = `script ${m[2]}${m[3]!.replace(/^ --(?= |$)/, '')}`
  return { text: c.trim(), dir }
}

type Hit = { row: Row; command: string }

/** The managed service a Bash command would start, if any: its command, run in its folder. */
function managedStart(command: string, base: string, rows: Row[]): Hit | null {
  let dir = base
  for (const part of command.split(/&&|\|\||;|\||\n/)) {
    const seg = part.trim().replace(/&$/, '').trim()
    if (!seg) continue
    const cd = /^(?:cd|pushd|Set-Location|sl)(?: -[A-Za-z]+)* +(.+)$/.exec(seg)
    if (cd) {
      dir = resolveDir(dir, cd[1]!.trim())
      continue
    }
    const want = canon(seg)
    const where = want.dir ? resolveDir(dir, want.dir) : dir
    for (const row of rows) {
      if (!row.cwd || !within(where, row.cwd) || !within(row.cwd, where)) continue
      for (const run of row.runs) {
        const have = canon(run).text
        if (have && (want.text === have || want.text.startsWith(have + ' '))) return { row, command: run }
      }
    }
  }
  return null
}

function guardText(h: Hit, wsName: string): string {
  const { row } = h
  const port = row.port ? `, port ${row.port}` : ''
  if (LIVE.includes(row.status))
    return `DevPilot already runs "${row.name}" (${row.key}${port}, ${row.status}) with this command. Running it again here would block this turn and clash with the running one. Use \`devpilot logs ${row.key} --json\` to read its output, or \`devpilot restart ${row.key} --wait --json\` to restart it.`
  return `"${row.name}" is managed by DevPilot (workspace ${wsName}). Start it in the background with \`devpilot start ${row.key} --wait --json\` (dependencies and mode included), then read its output with \`devpilot logs ${row.key} --json\`. Running it here would block this turn and DevPilot would not supervise it.`
}

const EDIT_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']
/** A command that reloads by itself: no restart needed after an edit. */
const WATCHES = /--watch\b|\bwatch\b|\bnodemon\b|\bvite\b(?! (?:build|preview))|\b(?:next|nuxt|astro|remix) dev\b|(?:^|[\s:])dev\b|--reload\b|ts-node-dev|\bair\b|webpack(?:-dev-server| serve)|--hot\b/
/** Files whose change a running service does not care about. */
const NOT_CODE = /(?:^|\/)(?:node_modules|dist|build|out|coverage|logs?|\.git|\.devpilot)\/|\.(?:md|mdx|txt|log)$/i

async function noteEdit($: EngineInterface, file: string) {
  if (!file || NOT_CODE.test(slash(file))) return
  const snap = await read($, snapshot)
  if (snap.daemon !== 'up') return
  const hit = snap.workspaces
    .flatMap((w) => w.services)
    .filter((r) => LIVE.includes(r.status) && r.cwd && within(file, r.cwd) && !WATCHES.test(r.run))
  if (!hit.length) return
  const at = Date.now()
  const name = slash(file).split('/').pop() || file
  await update($, changed, (list): Changed[] => {
    const out = list.map((c) => ({ ...c, files: [...c.files] }))
    for (const r of hit) {
      const have = out.find((c) => c.key === r.key)
      if (have) {
        if (!have.files.includes(name)) have.files = [...have.files, name].slice(-20)
        have.at = at
      } else out.push({ key: r.key, name: r.name, files: [name], at })
    }
    return out
  })
}

async function restartChanged($: EngineInterface) {
  const list = await read($, changed)
  await update($, restartAsk, (): boolean => false)
  await update($, changed, (): Changed[] => [])
  for (const c of list) await act($, `Restarting ${c.name}`, 'POST', `/api/services/${c.key}/restart`, { background: true })
}

// ------------------------------------------------------------------ hooks

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    try {
      cwd = await $.session.cwd()
    } catch {
      /* the pane still works without a project scope */
    }
    isProject = cwd ? await hasConfig($, cwd) : false
    // Reopen only if the person left it open last time, and only in a DevPilot project.
    let wantOpen = false
    try {
      wantOpen = (await $.store.get('paneOpen')) === true
    } catch {
      /* no preference yet */
    }
    if (isProject && wantOpen) {
      void $.ui.open({ id: PANE, title: 'Services' })
      await update($, paneOpen, (): boolean => true)
    } else {
      await update($, paneOpen, (): boolean => false)
    }
    $.clock.every(2000, () => tick($))
    tick($)
    // Each name on its own: one refused name (a built-in's) must not cost the others.
    for (const name of ['devpilot-panel', 'services', 'dp-services']) {
      try {
        await $.command.register({ name, description: 'Show or hide the DevPilot services pane' })
      } catch {
        /* name taken by a built-in */
      }
    }
    return result
  })

  on('command.run', { command: 'services' }, async ($) => ({ text: (await togglePane($)) ? 'Services pane opened.' : 'Services pane hidden.' }))

  on('command.run', { command: 'dp-services' }, async ($) => ({ text: (await togglePane($)) ? 'Services pane opened.' : 'Services pane hidden.' }))

  on('command.run', { command: 'devpilot-panel' }, async ($) => ({ text: (await togglePane($)) ? 'Services pane opened.' : 'Services pane hidden.' }))

  // The person closed it (its X, a key, or our toggle): remember that for the next sessions.
  // A close on unload (a plugin reload) is not their choice and changes nothing.
  on('ui.close', { id: PANE }, async ($, e, next) => {
    const result = await next(e)
    if (e.origin.kind !== 'unload') await rememberOpen($, false)
    return result
  })

  // While the pane is hidden, a one-line summary above the prompt opens it again.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const edits = await read($, changed)
    const asking = await read($, restartAsk)
    const showSummary = isProject && !(await read($, paneOpen))
    if (!edits.length && !showSummary) return next(e)
    const names = listed(edits.map((c) => c.name), 3)
    const files = [...new Set(edits.flatMap((c) => c.files))]
    const many = edits.length > 1
    const changeRow = !edits.length ? null : asking ? (
      <Box key="changed" flexDirection="row" gap="sm" alignItems="center">
        <Text color="warning">↻</Text>
        <Text>{`Restart ${names}? ${many ? 'They stop and start' : 'It stops and starts'} again.`}</Text>
        <Button key="restart-changed-ok" variant="primary" label="Restart" onPress={() => restartChanged($)} />
        <Button key="restart-changed-cancel" plain dimColor label="Cancel" onPress={() => update($, restartAsk, (): boolean => false)} />
      </Box>
    ) : (
      <Box key="changed" flexDirection="row" gap="sm" alignItems="center">
        <Text color="warning">↻</Text>
        <Text>{`${names}: code changed since ${many ? 'they' : 'it'} started`}</Text>
        <Text dimColor>{listed(files, 2)}</Text>
        <Button key="restart-changed" plain label="Restart ▸" onPress={() => update($, restartAsk, (): boolean => true)} />
        <Button key="dismiss-changed" plain dimColor label="Dismiss" onPress={() => update($, changed, (): Changed[] => [])} />
      </Box>
    )
    if (!showSummary) return <Box flexDirection="column">{changeRow}</Box>
    const snap = await read($, snapshot)
    const ws = snap.workspaces.find((w) => w.id === snap.projectWs)
    const up = ws ? ws.services.filter((r) => r.status === 'running').length : 0
    const bad = ws ? ws.services.filter((r) => FAILING.includes(r.status)).length : 0
    const label = snap.daemon !== 'up' ? 'daemon off' : ws ? `${up}/${ws.services.length} up${bad ? ` · ${bad} failing` : ''}` : 'not registered yet'
    return (
      <Box flexDirection="column">
        {changeRow}
        <Box key="summary" flexDirection="row" gap="sm" alignItems="center">
        <Text color={snap.daemon !== 'up' ? 'inactive' : bad ? 'error' : up ? 'success' : 'inactive'}>●</Text>
        <Text dimColor>DevPilot{ws ? ` · ${ws.name}` : ''}</Text>
        <Text color={bad ? 'error' : undefined} dimColor={!bad}>
          {label}
        </Text>
        <Button key="show-pane" plain dimColor label="Show services ▸" onPress={() => openPane($)} />
        </Box>
      </Box>
    )
  })

  // Claude starting a service DevPilot manages: refuse, and say how to do it through DevPilot.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if ((await read($, snapshot)).daemon === 'unknown') await pollOnce($).catch(() => undefined) // no poll has finished yet
    const snap = await read($, snapshot)
    if (snap.daemon !== 'up' || typeof e.command !== 'string') return next(e)
    const hit = managedStart(e.command, cwd || (await $.session.cwd()), snap.workspaces.flatMap((w) => w.services))
    if (!hit) return next(e)
    const ws = snap.workspaces.find((w) => w.services.some((r) => r.key === hit.row.key))
    $.ui.toast(`DevPilot: kept Claude from starting ${hit.row.name} outside DevPilot`, { timeoutMs: 6000 })
    return { deny: guardText(hit, ws?.name ?? hit.row.key.split('/')[0]!) }
  })

  // Claude edited a file of a running service that does not reload by itself: offer a restart.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (!EDIT_TOOLS.includes(e.tool) || ran.deny !== undefined || ran.isError) return ran
    const input = e as unknown as { file_path?: unknown; notebook_path?: unknown }
    const file = typeof input.file_path === 'string' ? input.file_path : typeof input.notebook_path === 'string' ? input.notebook_path : ''
    if (file) await noteEdit($, resolveDir(cwd, file)).catch(() => undefined)
    return ran
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    const Svg: any = 'Svg' in els ? (els as any).Svg : null
    const snap = await read($, snapshot)
    const sc = await read($, scope)
    const working = await read($, busy)
    const menuOpen = await read($, menu)
    const pending = await read($, confirm)

    // Svg where the surface draws it, a glyph elsewhere (the terminal).
    const pic = (source: string, alt: string, glyph: string, color: string, pw: number, ph: number) =>
      Svg ? <Svg source={source} alt={alt} width={pw} height={ph} /> : <Text color={color}>{glyph}</Text>
    const divider = () => (Svg ? <Svg source={DIVIDER} alt="" height={1} /> : null)

    if (snap.daemon !== 'up') {
      return (
        <Box flexDirection="column" gap={1}>
          <Text size="heading" weight="semibold">
            DevPilot
          </Text>
          <Text dimColor>{snap.daemon === 'unknown' ? 'Connecting…' : `The daemon is ${snap.detail || 'not running'}.`}</Text>
          {snap.daemon === 'down' && (
            <Box>
              <Button key="start-daemon" variant="primary" label={working ? 'Starting…' : '▶ Start daemon'} onPress={() => startDaemon($)} />
            </Box>
          )}
          <Text dimColor size="caption">
            New project? Ask Claude to "set up devpilot".
          </Text>
        </Box>
      )
    }

    const shown = sc === 'project' && snap.projectWs ? snap.workspaces.filter((w) => w.id === snap.projectWs) : snap.workspaces
    if (!shown.length) {
      return (
        <Box flexDirection="column" gap={1}>
          <Text size="heading" weight="semibold">
            DevPilot
          </Text>
          <Text dimColor>No workspaces yet. Ask Claude to "set up devpilot" in a project.</Text>
        </Box>
      )
    }

    const serviceRow = (r: Row, all: Row[]) => {
      const k = kindOf(r)
      const bg = k === 'failing' ? C.failRowBg : k === 'starting' ? C.blueBg : undefined
      const right =
        k === 'failing' ? (
          <Text size="caption" weight="medium" color={C.redText}>
            {r.status === 'unhealthy' ? 'unhealthy' : r.status === 'backoff' ? 'restarting' : 'crashed'}
          </Text>
        ) : k === 'starting' ? (
          <Text size="caption" color={C.blue}>
            {r.task ? `${r.task}…` : r.status === 'stopping' ? 'stopping' : 'starting'}
          </Text>
        ) : k === 'queued' ? (
          <Text size="caption" color={C.muted}>
            queued
          </Text>
        ) : r.port !== null ? (
          <Text size="caption" mono color={k === 'running' ? undefined : C.muted}>
            :{r.port}
          </Text>
        ) : k === 'running' ? (
          <Text size="caption" color={C.greenText}>
            running
          </Text>
        ) : null
      const action =
        k === 'failing' ? (
          <Button key={`restart-${r.key}`} plain label="↻" onPress={() => propose($, { title: `Restart ${r.name}?`, detail: `Stops it and starts it again${r.mode !== 'default' ? ` in mode ${r.mode} (its tasks run first)` : ''}.`, label: 'Restart', danger: false, method: 'POST', path: `/api/services/${r.key}/restart`, body: { background: true }, busy: `Restarting ${r.name}` })} />
        ) : k === 'queued' ? (
          <Button key={`dequeue-${r.key}`} plain label="✕" onPress={() => propose($, { title: `Remove ${r.name} from the queue?`, detail: 'It has not started yet and will not be started.', label: 'Remove', danger: true, method: 'POST', path: `/api/services/${r.key}/stop`, body: null, busy: `Removing ${r.name} from the queue` })} />
        ) : k === 'running' || k === 'starting' ? (
          <Button key={`stop-${r.key}`} plain label="■" onPress={() => {
              const deps = runningDependents(r.name, all)
              return propose($, { title: `Stop ${r.name}?`, detail: `Kills its process tree.${deps.length ? ` Running services that depend on it: ${listed(deps)}.` : ''}`, label: 'Stop', danger: true, method: 'POST', path: `/api/services/${r.key}/stop`, body: null, busy: `Stopping ${r.name}` })
            }} />
        ) : (
          <Button key={`start-${r.key}`} plain label={'▶︎'} onPress={() => {
              const down = r.dependsOn.filter((d) => all.find((x) => x.name === d)?.status !== 'running')
              return propose($, { title: `Start ${r.name}?`, detail: `${down.length ? `Dependencies start first: ${listed(down)}. ` : ''}Mode ${r.mode}.`, label: 'Start', danger: false, method: 'POST', path: `/api/services/${r.key}/start`, body: { background: true }, busy: `Starting ${r.name}` })
            }} />
        )
      const glyphColor = k === 'running' ? 'success' : k === 'failing' ? 'error' : k === 'starting' ? C.blue : 'inactive'
      return (
        <Box key={`row-${r.key}`} flexDirection="row" alignItems="center" gap="sm" paddingX="sm" paddingY="xs" backgroundColor={bg}>
          {pic(dotSvg(k), r.status, k === 'running' || k === 'failing' ? '●' : k === 'starting' ? '◐' : '○', glyphColor, 16, 16)}
          <Box flexGrow={1} flexShrink={1}>
            <Text weight="medium" wrap="truncate-end">
              {r.name}
            </Text>
            {r.mode !== 'default' && (
              <Text size="footnote" weight="medium" color={C.blue}>
                {r.mode}
              </Text>
            )}
          </Box>
          {right}
          {action}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" gap="md">
        {shown.map((w) => {
          const all = w.services
          const kinds = all.map(kindOf)
          const count = (k: Kind) => kinds.filter((x) => x === k).length
          const up = count('running')
          const failing = all.filter((r) => kindOf(r) === 'failing')
          const starting = count('starting')
          const queued = count('queued')
          const stopped = count('stopped')
          const anyActive = up + starting + queued + failing.length > 0
          const incidents = all.reduce((n, r) => n + r.openIncidents, 0)
          const groups = groupsOf(all)
          const startingGroups = groups.filter((g) => g.rows.some((r) => kindOf(r) === 'starting')).map((g) => g.label.toLowerCase())
          const status = working
            ? { text: `${working}…`, color: C.muted }
            : w.runningTasks.length
              ? { text: `Running ${w.runningTasks.join(', ')}…`, color: C.blue }
              : starting + queued > 0
              ? { text: `Starting ${startingGroups.join(', ') || 'services'}…`, color: C.blue }
              : null
          const tally = [failing.length && `${failing.length} ${failing.every((r) => r.status === 'crashed') ? 'crashed' : 'failing'}`, starting && `${starting} starting`, queued && `${queued} queued`, stopped && `${stopped} stopped`]
            .filter(Boolean)
            .join(' · ')
          const upColor = failing.length ? C.redText : up > 0 ? C.greenText : C.muted

          return (
            <Box key={`ws-${w.id}`} flexDirection="column" gap="md">
              {/* header */}
              <Box flexDirection="row" alignItems="center" gap="sm">
                <Box flexDirection="column" flexGrow={1} flexShrink={1} gap="xs">
                  <Box flexDirection="row" gap="sm" alignItems="center">
                    <Text size="heading" weight="semibold">
                      {w.name}
                    </Text>
                    {w.envProfile && (
                      <Text size="caption" color="suggestion">
                        env:{w.envProfile}
                      </Text>
                    )}
                  </Box>
                  {status && (
                    <Box flexDirection="row" gap="xs" alignItems="center">
                      {pic(SPIN(status.color), 'working', '◌', status.color, 12, 12)}
                      <Text size="caption" color={status.color}>
                        {status.text}
                      </Text>
                    </Box>
                  )}
                </Box>
                <Button key={`dash-${w.id}`} label="⊞" onPress={() => openDashboard($)} />
                <Button key={`menu-${w.id}`} label={incidents > 0 ? `⋯ ${incidents}` : '⋯'} onPress={() => update($, menu, (m): boolean => !m)} />
              </Box>

              {menuOpen && (
                <Box flexDirection="row" gap="sm" flexWrap="wrap">
                  {snap.projectWs && (
                    <Button key="scope" label={sc === 'project' ? 'All projects' : 'This project'} onPress={() => update($, scope, (s): Scope => (s === 'project' ? 'all' : 'project'))} />
                  )}
                  <Button key={`incidents-${w.id}`} label="Summarise incidents" onPress={() => $.prompt.submit({ text: triagePrompt(w), asUser: true })} />
                  {incidents > 0 && (
                    <Button key={`clear-${w.id}`} label={`Clear ${incidents} incident${incidents > 1 ? 's' : ''}`} onPress={() => act($, 'Clearing incidents', 'POST', '/api/incidents/resolve', { ws: w.id })} />
                  )}
                </Box>
              )}
              {menuOpen && w.modes.length > 1 && (
                <Box flexDirection="column" gap="xs">
                  <Text size="footnote" weight="semibold" color={C.muted}>
                    MODE
                  </Text>
                  <Box flexDirection="row" gap="sm" flexWrap="wrap">
                    {w.modes.map((m) => (
                      <Button
                        key={`mode-${w.id}-${m}`}
                        variant={m === w.mode ? 'primary' : undefined}
                        label={m === 'default' ? 'default (watch)' : m}
                        onPress={() => {
                          const restarts = w.services.filter((r) => LIVE.includes(r.status) && r.mode !== m && (r.modes.includes(m) || m === 'default')).map((r) => r.name)
                          return propose($, { title: `Switch to mode ${m}?`, detail: restarts.length ? `Restarts ${restarts.length} running service(s)${m !== 'default' ? ', running the mode’s tasks (e.g. build) first — can take minutes' : ''}: ${listed(restarts)}.` : 'No running service is affected.', label: restarts.length ? `Switch & restart ${restarts.length}` : 'Switch', danger: restarts.length > 0, method: 'POST', path: `/api/workspaces/${w.id}/mode`, body: { mode: m, restart: true }, busy: `Switching to ${m}` })
                        }}
                      />
                    ))}
                  </Box>
                </Box>
              )}
              {menuOpen && w.tasks.length + w.serviceTasks.length > 0 && (
                <Box flexDirection="column" gap="xs">
                  <Text size="footnote" weight="semibold" color={C.muted}>
                    TASKS
                  </Text>
                  <Box flexDirection="row" gap="sm" flexWrap="wrap">
                    {w.tasks.map((t) => (
                      <Button key={`task-${w.id}-${t}`} label={`▷ ${t}`} onPress={() => propose($, { title: `Run task ${t}?`, detail: 'Runs the workspace task; output goes to the workspace task log (devpilot task, dashboard).', label: `Run ${t}`, danger: false, method: 'POST', path: `/api/workspaces/${w.id}/tasks`, body: { task: t }, busy: `Running ${t}` })} />
                    ))}
                    {w.serviceTasks
                      .filter((t) => !w.tasks.includes(t))
                      .map((t) => (
                        <Button key={`stask-${w.id}-${t}`} label={`▷ ${t} · all`} onPress={() => {
                          const svcs = w.services.filter((r) => r.tasks.includes(t)).map((r) => r.name)
                          return propose($, { title: `Run ${t} in ${svcs.length} services?`, detail: `One after another: ${listed(svcs)}. Services whose task stops them restart after.`, label: `Run ${t}`, danger: false, method: 'POST', path: `/api/workspaces/${w.id}/tasks`, body: { task: t, all: true }, busy: `Running ${t} in every service` })
                        }} />
                      ))}
                  </Box>
                </Box>
              )}

              {/* pending confirmation */}
              {pending && (
                <Box key="confirm" flexDirection="column" gap="sm" borderStyle="round" borderColor={pending.danger ? C.cardBorder : C.blueRing} backgroundColor={pending.danger ? C.cardBg : C.blueBg} padding="md">
                  <Text weight="semibold" color={pending.danger ? C.cardTitle : C.blue}>
                    {pending.title}
                  </Text>
                  <Text size="caption" color={pending.danger ? C.cardBody : undefined} dimColor={!pending.danger}>
                    {pending.detail}
                  </Text>
                  <Box flexDirection="row" gap="sm">
                    <Button key="confirm-ok" variant="primary" label={pending.label} onPress={() => decide($, true)} />
                    <Button key="confirm-cancel" label="Cancel" onPress={() => decide($, false)} />
                  </Box>
                </Box>
              )}

              {/* health bar */}
              <Box flexDirection="column" gap="xs">
                <Box flexDirection="row" justifyContent="space-between" alignItems="center">
                  <Text size="caption" weight="semibold" color={upColor}>
                    {up} of {all.length} up
                  </Text>
                  <Text size="caption" color={C.muted}>
                    {tally}
                  </Text>
                </Box>
                {Svg ? (
                  <Svg source={barSvg(all, ((e.props.bodyColumns ?? 44) - 2) * 8.6)} alt={`${up} of ${all.length} services up`} height={6} />
                ) : (
                  <Text>
                    {all.map((r) => {
                      const k = kindOf(r)
                      return <Text color={k === 'running' ? 'success' : k === 'failing' ? 'error' : k === 'starting' ? C.blue : 'inactive'}>▬</Text>
                    })}
                  </Text>
                )}
              </Box>
              {divider()}

              {/* incident cards */}
              {failing.slice(0, 2).map((r) => (
                <Box key={`alert-${r.key}`} flexDirection="column" gap="sm" borderStyle="round" borderColor={C.cardBorder} backgroundColor={C.cardBg} padding="md">
                  <Box flexDirection="row" gap="sm" alignItems="flex-start">
                    {pic(ALERT_ICON, 'crash', '⚠', C.redText, 28, 28)}
                    <Box flexDirection="column" flexShrink={1} gap="xs">
                      <Box flexDirection="row" gap="sm" alignItems="center">
                        <Text weight="semibold" color={C.cardTitle}>
                          {alertTitle(r)}
                        </Text>
                        {r.restarts > 0 && (
                          <Box borderStyle="round" borderColor={C.cardBorder} backgroundColor="#FFFFFF" paddingX="sm">
                            <Text size="footnote" weight="semibold" color={C.redText}>
                              ↻ {r.restarts}
                            </Text>
                          </Box>
                        )}
                      </Box>
                      <Text size="caption" color={C.cardBody}>
                        {alertText(r, all)}
                      </Text>
                      {r.lastError && !/^(exit code|signal|exited)\b/i.test(r.lastError) && (
                        <Text size="caption" mono color={C.redText} wrap="truncate-end">
                          {r.lastError}
                        </Text>
                      )}
                    </Box>
                  </Box>
                  <Box flexDirection="row" gap="xs" alignItems="stretch">
                    <Box flexGrow={1} flexDirection="column" alignItems="stretch">
                      <Button key={`ask-${r.key}`} variant="primary" label="✦  Ask Claude" onPress={() => $.prompt.submit({ text: diagnosePrompt(r), asUser: true })} />
                    </Box>
                    <Button key={`logs-${r.key}`} label="≡  Logs" onPress={() => openDashboard($, `/service/${r.key}/logs`)} />
                    <Button key={`halt-${r.key}`} label="■" onPress={() => propose($, { title: `Stop ${r.name}?`, detail: 'Stops it and its restart attempts.', label: 'Stop', danger: true, method: 'POST', path: `/api/services/${r.key}/stop`, body: null, busy: `Stopping ${r.name}` })} />
                  </Box>
                </Box>
              ))}
              {failing.length > 2 && (
                <Text size="caption" color={C.redText}>
                  +{failing.length - 2} more failing
                </Text>
              )}

              {/* layers */}
              {groups.map((g) => {
                const gk = g.rows.map(kindOf)
                const gUp = gk.filter((k) => k === 'running').length
                const color = gk.includes('failing') ? C.redText : gk.some((k) => k === 'starting' || k === 'queued') ? C.blue : gUp === g.rows.length ? C.greenText : C.muted
                const waits = gk.includes('queued')
                const prefix = g.needs.length ? `${waits ? 'waits for' : 'needs'} ${g.needs.map((n) => n.toLowerCase()).join(', ')} · ` : ''
                return (
                  <Box key={`grp-${w.id}-${g.label}`} flexDirection="column" gap="xs">
                    <Box flexDirection="row" justifyContent="space-between" paddingX="sm">
                      <Text size="footnote" weight="semibold" color={C.muted}>
                        {g.label.toUpperCase()}
                      </Text>
                      <Text size="footnote" weight="medium" color={g.needs.length && !gUp && !gk.includes('failing') ? C.muted : color}>
                        {prefix}
                        {gUp}/{g.rows.length}
                      </Text>
                    </Box>
                    {g.rows.map((r) => serviceRow(r, all))}
                  </Box>
                )
              })}

              {/* footer */}
              {divider()}
              <Box flexDirection="row" gap="sm" alignItems="stretch">
                <Box flexGrow={1} flexDirection="column" alignItems="stretch">
                  {starting + queued > 0 ? (
                    <Box borderStyle="round" borderColor={C.btnBorder} backgroundColor="#F7F6F3" paddingX="sm" paddingY="xs" flexDirection="row" gap="xs" alignItems="center" justifyContent="center">
                      {pic(SPIN(C.muted), 'working', '◌', C.muted, 12, 12)}
                      <Text color={C.muted} wrap="truncate-end">
                        Starting {up + starting}/{all.length}…
                      </Text>
                    </Box>
                  ) : (
                    <Button key={`up-${w.id}`} variant="primary" label={'▶︎  Start all'} onPress={() => {
                      const down = w.services.filter((r) => !LIVE.includes(r.status) && !FAILING.includes(r.status)).map((r) => r.name)
                      return propose($, { title: `Start ${w.name}?`, detail: `Starts the default profile in dependency order; ${down.length} service(s) are not running: ${listed(down)}.`, label: 'Start all', danger: false, method: 'POST', path: `/api/workspaces/${w.id}/up`, body: { background: true }, busy: `Starting ${w.name}` })
                    }} />
                  )}
                </Box>
                {anyActive && <Button key={`down-${w.id}`} label="■  Stop all" onPress={() => {
                      const up = w.services.filter((r) => LIVE.includes(r.status) || FAILING.includes(r.status) || r.queued).map((r) => r.name)
                      return propose($, { title: `Stop all of ${w.name}?`, detail: `Stops ${up.length} service(s), dependents first: ${listed(up)}.`, label: 'Stop all', danger: true, method: 'POST', path: `/api/workspaces/${w.id}/down`, body: null, busy: `Stopping ${w.name}` })
                    }} />}
              </Box>
            </Box>
          )
        })}
      </Box>
    )
  })
}
