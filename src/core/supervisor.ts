// The supervisor owns every service runtime: spawn, readiness, health,
// restart policy, dependency ordering, stop, metrics and orphan adoption.
// Ported from jsrunner's process.mjs + supervisor.mjs, re-keyed from
// "project:script" to "<workspace>/<service>" so any runtime can be run.
import fs from 'node:fs';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import type { DaemonEvent, HealthInfo, ServiceStatus, ServiceView, WorkspaceView } from '../shared/types.js';
import { findConfig, loadConfig, resolveEnv, type ServiceSpec, type WorkspaceConfig } from './config.js';
import { LogStore } from './logs.js';
import { OutputTail, type TailPos } from './capture.js';
import { ErrorDetector, IncidentStore, pickHeadline } from './incidents.js';
import { MetricsHistory, MetricsSampler } from './metrics.js';
import { probeHttp, probeTcp, isPortFree, findFreePort } from './health.js';
import { paths, readJson, writeJsonAtomic } from './paths.js';
import { findListeningPids, isWindows, killTree, listProcesses, mainImage, pidAlive, runShell, signalTree, spawnShell } from './platform/index.js';

export interface StartResult {
  ok: boolean;
  key: string;
  status: ServiceStatus;
  reason?: string;
  suggestion?: string;
  logs?: string[];
}

interface Runtime {
  key: string;
  ws: string;
  spec: ServiceSpec;
  status: ServiceStatus;
  child?: ChildProcess;
  tail?: OutputTail;
  pid?: number;
  imagePid?: number;
  image?: string;
  imageCmd?: string;
  startedAt?: number;
  readyAt?: number;
  exitCode?: number | null;
  restarts: number;
  restartTimes: number[];
  stopping: boolean;
  restartTimer?: NodeJS.Timeout;
  readyTimer?: NodeJS.Timeout;
  generation: number;
  health: HealthInfo;
  lastLatency?: number;
  history: MetricsHistory;
  cpu?: number;
  mem?: number;
  adopted: boolean;
  lastError?: string;
  memAlarm: boolean;
  waiters: Array<(ok: boolean) => void>;
}

interface WorkspaceEntry {
  root: string;
  configPath: string;
  envProfile?: string;
  config?: WorkspaceConfig;
  error?: string;
  watcher?: fs.FSWatcher;
}

interface RegistryFile {
  workspaces: Array<{ configPath: string; envProfile?: string }>;
}

interface StateFile {
  [key: string]: { pid: number; imagePid?: number; image?: string; imageCmd?: string; startedAt: number; run: string; tail?: TailPos };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now();

export class Supervisor {
  readonly logs = new LogStore();
  readonly incidents: IncidentStore;
  private workspaces = new Map<string, WorkspaceEntry>();
  private runtimes = new Map<string, Runtime>();
  private listeners = new Set<(e: DaemonEvent) => void>();
  private sampler = new MetricsSampler();
  private timers: NodeJS.Timeout[] = [];
  private detector: ErrorDetector;
  /** Waiting in launchGraph for dependencies to become ready. */
  private queued = new Set<string>();
  private cancelled = new Set<string>();
  private stateDirty = false;

  constructor() {
    this.incidents = new IncidentStore();
    this.detector = new ErrorDetector(
      (key, title, context) => {
        const rt = this.runtimes.get(key);
        if (rt) rt.lastError = title;
        this.incidents.add({ key, kind: 'error-log', severity: 'warning', title, context });
      },
      (key) => this.runtimes.get(key)?.spec.alerts.errorPatterns || [],
    );
    this.logs.onLines((key, lines) => {
      this.emit({ type: 'log', key, lines });
      this.detector.feed(key, lines);
      const rt = this.runtimes.get(key);
      if (rt?.status === 'starting' && rt.spec.readyLog && lines.some((l) => rt.spec.readyLog!.test(l.text))) this.markReady(rt);
    });
    this.incidents.onIncident((incident) => {
      this.emit({ type: 'incident', incident });
      const rt = this.runtimes.get(incident.key);
      if (rt) this.emitStatus(rt);
    });
  }

  // ---------------------------------------------------------------- events

  on(fn: (e: DaemonEvent) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(e: DaemonEvent) {
    for (const fn of this.listeners) {
      try {
        fn(e);
      } catch {
        /* a broken subscriber must not break the supervisor */
      }
    }
  }

  private emitStatus(rt: Runtime) {
    this.emit({ type: 'status', service: this.view(rt) });
  }

  private setStatus(rt: Runtime, status: ServiceStatus) {
    if (rt.status === status) return;
    rt.status = status;
    if (status !== 'starting') this.flushWaiters(rt, status === 'running');
    this.stateDirty = true;
    this.emitStatus(rt);
  }

  // ------------------------------------------------------------ workspaces

  async boot() {
    const reg = readJson<RegistryFile>(paths.registry, { workspaces: [] });
    for (const w of reg.workspaces) {
      if (!fs.existsSync(w.configPath)) continue;
      this.addWorkspace(w.configPath, { envProfile: w.envProfile, persist: false });
    }
    await this.adoptOrphans();
    for (const rt of this.runtimes.values()) if (rt.spec.autostart && rt.status === 'stopped') void this.start(rt.key);
    this.timers.push(setInterval(() => {
      for (const rt of this.runtimes.values()) if (rt.tail) this.drainTail(rt);
    }, 250));
    this.timers.push(setInterval(() => void this.healthTick(), 1000));
    this.timers.push(setInterval(() => void this.metricsTick(), 3000));
    this.timers.push(setInterval(() => this.saveState(), 2000));
  }

  /** Register (or re-register) a workspace from a folder or a config path. */
  addWorkspace(pathOrDir: string, opts: { envProfile?: string; persist?: boolean } = {}): WorkspaceEntry & { id: string } {
    const stat = fs.existsSync(pathOrDir) ? fs.statSync(pathOrDir) : null;
    const configPath = stat?.isDirectory() ? findConfig(pathOrDir) : stat ? path.resolve(pathOrDir) : null;
    if (!configPath) throw new Error(`No devpilot.yaml found in ${pathOrDir} or its parents. Run \`devpilot init\` there first.`);
    const entry: WorkspaceEntry = { root: path.dirname(configPath), configPath, envProfile: opts.envProfile };
    const existing = [...this.workspaces.entries()].find(([, w]) => w.configPath.toLowerCase() === configPath.toLowerCase());
    if (existing) {
      if (opts.envProfile !== undefined) existing[1].envProfile = opts.envProfile;
      this.reloadWorkspace(existing[0]);
      return { ...existing[1], id: existing[0] };
    }
    const id = this.applyConfig(entry);
    this.watch(id, entry);
    if (opts.persist !== false) this.saveRegistry();
    this.emit({ type: 'workspaces', workspaces: [...this.workspaces.keys()] });
    return { ...entry, id };
  }

  private applyConfig(entry: WorkspaceEntry, id?: string): string {
    let config: WorkspaceConfig | undefined;
    try {
      config = loadConfig(entry.configPath);
      entry.config = config;
      entry.error = undefined;
    } catch (e: any) {
      entry.error = e.message;
    }
    const wsId = id || config?.id || path.basename(entry.root);
    this.workspaces.set(wsId, entry);
    if (!config) return wsId;
    const keep = new Set<string>();
    for (const spec of config.services) {
      const key = `${wsId}/${spec.name}`;
      keep.add(key);
      const rt = this.runtimes.get(key);
      if (rt) rt.spec = spec; // takes effect on next (re)start
      else this.runtimes.set(key, this.newRuntime(key, wsId, spec));
    }
    for (const [key, rt] of this.runtimes) {
      if (rt.ws === wsId && !keep.has(key)) {
        void this.stop(key).then(() => this.runtimes.delete(key));
      }
    }
    return wsId;
  }

  private newRuntime(key: string, ws: string, spec: ServiceSpec): Runtime {
    return {
      key,
      ws,
      spec,
      status: 'stopped',
      restarts: 0,
      restartTimes: [],
      stopping: false,
      generation: 0,
      health: { state: 'unknown', kind: spec.health?.kind || 'none', consecutiveFailures: 0 },
      history: new MetricsHistory(),
      adopted: false,
      memAlarm: false,
      waiters: [],
    };
  }

  private watch(id: string, entry: WorkspaceEntry) {
    let t: NodeJS.Timeout | undefined;
    try {
      entry.watcher = fs.watch(entry.configPath, () => {
        clearTimeout(t);
        t = setTimeout(() => this.reloadWorkspace(id), 300);
      });
    } catch {
      /* watching is a convenience */
    }
  }

  reloadWorkspace(id: string) {
    const entry = this.workspaces.get(id);
    if (!entry) throw new Error(`Unknown workspace ${id}`);
    this.applyConfig(entry, id);
    for (const rt of this.runtimes.values()) if (rt.ws === id) this.emitStatus(rt);
    this.emit({ type: 'workspaces', workspaces: [...this.workspaces.keys()] });
  }

  async removeWorkspace(id: string) {
    await this.stopWorkspace(id);
    const entry = this.workspaces.get(id);
    entry?.watcher?.close();
    this.workspaces.delete(id);
    for (const [key, rt] of this.runtimes) if (rt.ws === id) this.runtimes.delete(key);
    this.saveRegistry();
    this.emit({ type: 'workspaces', workspaces: [...this.workspaces.keys()] });
  }

  setEnvProfile(id: string, profile: string | undefined) {
    const entry = this.workspaces.get(id);
    if (!entry) throw new Error(`Unknown workspace ${id}`);
    if (profile && entry.config && !entry.config.envProfiles.includes(profile)) {
      throw new Error(`Unknown env profile "${profile}". Defined: ${entry.config.envProfiles.join(', ') || '(none)'}`);
    }
    entry.envProfile = profile || undefined;
    this.saveRegistry();
  }

  /** Workspace id for a folder: the registered workspace whose root contains it. */
  workspaceFor(dir: string): string | undefined {
    const d = path.resolve(dir).toLowerCase() + path.sep;
    let best: [string, number] | undefined;
    for (const [id, w] of this.workspaces) {
      const root = w.root.toLowerCase() + path.sep;
      if (d.startsWith(root) && (!best || root.length > best[1])) best = [id, root.length];
    }
    return best?.[0];
  }

  private saveRegistry() {
    writeJsonAtomic(paths.registry, {
      workspaces: [...this.workspaces.values()].map((w) => ({ configPath: w.configPath, envProfile: w.envProfile })),
    } satisfies RegistryFile);
  }

  // --------------------------------------------------------------- lookups

  resolveKey(ref: string, wsHint?: string): string {
    if (this.runtimes.has(ref)) return ref;
    if (wsHint && this.runtimes.has(`${wsHint}/${ref}`)) return `${wsHint}/${ref}`;
    const [wsPart, svcPart] = ref.includes('/') ? ref.split('/') : ['', ref];
    const matches = [...this.runtimes.keys()].filter((k) => {
      const [ws, svc] = k.split('/');
      return svc === svcPart && ws.startsWith(wsPart);
    });
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) throw new Error(`"${ref}" is ambiguous: ${matches.join(', ')}. Use <workspace>/<service>.`);
    throw new Error(`Unknown service "${ref}". Known: ${[...this.runtimes.keys()].join(', ') || '(none — register a workspace first)'}`);
  }

  private rt(key: string): Runtime {
    const rt = this.runtimes.get(key);
    if (!rt) throw new Error(`Unknown service ${key}`);
    return rt;
  }

  view(rtOrKey: Runtime | string): ServiceView {
    const rt = typeof rtOrKey === 'string' ? this.rt(rtOrKey) : rtOrKey;
    return {
      key: rt.key,
      workspace: rt.ws,
      name: rt.spec.name,
      status: rt.status,
      run: rt.spec.run,
      cwd: rt.spec.cwd,
      port: rt.spec.port,
      url: rt.spec.url,
      pid: rt.pid,
      image: rt.image,
      startedAt: rt.startedAt,
      readyAt: rt.readyAt,
      exitCode: rt.exitCode,
      restarts: rt.restarts,
      adopted: rt.adopted,
      dependsOn: rt.spec.dependsOn,
      group: rt.spec.group,
      health: { ...rt.health },
      cpu: rt.cpu,
      mem: rt.mem,
      lastError: rt.lastError,
      openIncidents: this.incidents.openCount(rt.key),
      queued: this.queued.has(rt.key),
    };
  }

  workspaceViews(filter?: string): WorkspaceView[] {
    return [...this.workspaces.entries()]
      .filter(([id]) => !filter || id === filter)
      .map(([id, w]) => ({
        id,
        name: w.config?.name || path.basename(w.root),
        root: w.root,
        configPath: w.configPath,
        profiles: w.config?.profiles || {},
        envProfile: w.envProfile,
        envProfiles: w.config?.envProfiles || [],
        configError: w.error,
        services: [...this.runtimes.values()].filter((r) => r.ws === id).map((r) => this.view(r)),
      }));
  }

  /** Re-broadcast a service's view (after something outside it changed, e.g. incidents). */
  touch(key: string) {
    const rt = this.runtimes.get(key);
    if (rt) this.emitStatus(rt);
  }

  workspace(id: string) {
    return this.workspaces.get(id);
  }

  history(key: string, range: '15m' | '1h' | '24h') {
    return this.rt(key).history.range(range);
  }

  spec(key: string) {
    return this.rt(key).spec;
  }

  envFor(key: string) {
    const rt = this.rt(key);
    return resolveEnv(rt.spec, this.workspaces.get(rt.ws)?.envProfile);
  }

  // ----------------------------------------------------------------- start

  /** Start a service (and, by default, its dependencies first, each waited until ready). */
  async start(key: string, opts: { deps?: boolean; wait?: boolean; timeoutMs?: number } = {}): Promise<StartResult> {
    const { deps = true, wait = false } = opts;
    // A deliberate (re)start supersedes earlier failures of this service.
    this.incidents.resolve(key);
    if (deps) {
      const failed = await this.launchGraph([key], { waitTarget: wait, timeoutMs: opts.timeoutMs });
      return failed.get(key) || this.result(key, true);
    }
    const r = await this.spawnOne(key);
    if (!r.ok || !wait) return r;
    const ok = await this.waitReady(this.rt(key), opts.timeoutMs ?? this.rt(key).spec.readyTimeoutMs);
    return this.result(key, ok, ok ? undefined : this.notReadyReason(this.rt(key), opts.timeoutMs));
  }

  /** Start several services honouring depends_on. Returns failures by key. */
  async launchGraph(keys: string[], { sequential = false, waitTarget = false, timeoutMs }: { sequential?: boolean; waitTarget?: boolean; timeoutMs?: number } = {}) {
    const inFlight = new Map<string, Promise<StartResult>>();
    const failed = new Map<string, StartResult>();
    const targets = new Set(keys);

    const launch = (key: string, chain: Set<string>): Promise<StartResult> => {
      const existing = inFlight.get(key);
      if (existing) return existing;
      const next = new Set(chain).add(key);
      const task = (async (): Promise<StartResult> => {
        const rt = this.rt(key);
        const deps = rt.spec.dependsOn.map((d) => `${rt.ws}/${d}`).filter((d) => !next.has(d));
        const waits = deps.length > 0 && !['starting', 'running', 'unhealthy'].includes(rt.status);
        if (waits) {
          this.queued.add(key);
          this.emitStatus(rt);
        }
        const depResults = await Promise.all(deps.map((d) => launch(d, next)));
        if (waits) {
          this.queued.delete(key);
          this.emitStatus(rt);
        }
        if (this.cancelled.delete(key)) {
          this.logs.system(key, '■ removed from the start queue');
          return this.result(key, false, 'removed from the start queue');
        }
        const bad = depResults.find((r) => !r.ok);
        if (bad) {
          const res = this.result(key, false, `dependency ${bad.key} failed: ${bad.reason || bad.status}`);
          this.logs.system(key, `✖ not started: ${res.reason}`);
          return res;
        }
        const r = await this.spawnOne(key);
        if (!r.ok) return r;
        const mustWait = !targets.has(key) || waitTarget;
        if (!mustWait) return r;
        const ok = await this.waitReady(rt, timeoutMs ?? rt.spec.readyTimeoutMs);
        return this.result(key, ok, ok ? undefined : this.notReadyReason(rt, timeoutMs));
      })();
      inFlight.set(key, task);
      return task;
    };

    if (sequential) {
      for (const k of keys) {
        const r = await launch(k, new Set());
        if (!r.ok) failed.set(k, r);
      }
    } else {
      const results = await Promise.all(keys.map((k) => launch(k, new Set())));
      results.forEach((r, i) => !r.ok && failed.set(keys[i], r));
    }
    return failed;
  }

  async startProfile(wsId: string, profile = 'default', opts: { wait?: boolean } = {}) {
    const entry = this.workspaces.get(wsId);
    if (!entry?.config) throw new Error(entry?.error || `Unknown workspace ${wsId}`);
    const list = entry.config.profiles[profile];
    if (!list) throw new Error(`Unknown profile "${profile}". Defined: ${Object.keys(entry.config.profiles).join(', ')}`);
    const keys = list.map((s) => `${wsId}/${s}`);
    const failed = await this.launchGraph(keys, { waitTarget: opts.wait });
    return keys.map((k) => failed.get(k) || this.result(k, true));
  }

  private notReadyReason(rt: Runtime, timeoutMs?: number): string {
    if (['crashed', 'stopped', 'exited'].includes(rt.status)) return rt.lastError || `${rt.status} (exit code ${rt.exitCode})`;
    return `not ready within ${Math.round((timeoutMs ?? rt.spec.readyTimeoutMs) / 1000)}s${rt.health.lastError ? ` (health: ${rt.health.lastError})` : ''}`;
  }

  private result(key: string, ok: boolean, reason?: string): StartResult {
    const rt = this.rt(key);
    return { ok: ok && !['crashed', 'stopped', 'exited'].includes(rt.status), key, status: rt.status, reason: ok ? undefined : reason || rt.lastError, logs: ok ? undefined : this.logs.recent(key, 25) };
  }

  private async spawnOne(key: string): Promise<StartResult> {
    const rt = this.rt(key);
    if (['starting', 'running', 'unhealthy'].includes(rt.status)) return this.result(key, true);
    const entry = this.workspaces.get(rt.ws);
    if (entry?.error) return { ok: false, key, status: rt.status, reason: `config error: ${entry.error}` };
    clearTimeout(rt.restartTimer);
    rt.stopping = false;

    if (rt.spec.port && !(await isPortFree(rt.spec.port))) {
      const holder = (await findListeningPids()).get(rt.spec.port);
      const owner = holder ? (await listProcesses({ withCommandLine: true })).get(holder) : undefined;
      const free = await findFreePort(rt.spec.port + 1);
      const reason = `port ${rt.spec.port} is already in use${holder ? ` by PID ${holder}${owner ? ` (${owner.name})` : ''}` : ''}`;
      rt.lastError = reason;
      this.incidents.add({ key, kind: 'port-conflict', severity: 'error', title: reason, detail: owner?.cmd, context: [] });
      this.logs.system(key, `✖ ${reason}`);
      this.setStatus(rt, 'crashed');
      return { ok: false, key, status: rt.status, reason, suggestion: free ? `Free port nearby: ${free}. Stop PID ${holder ?? '?'} (devpilot port kill ${rt.spec.port} --force) or change port in devpilot.yaml.` : undefined };
    }

    const env = resolveEnv(rt.spec, entry?.envProfile);
    if (!fs.existsSync(rt.spec.cwd)) {
      rt.lastError = `cwd does not exist: ${rt.spec.cwd}`;
      this.setStatus(rt, 'crashed');
      return { ok: false, key, status: rt.status, reason: rt.lastError };
    }

    const gen = ++rt.generation;
    this.logs.system(key, `▶ ${rt.spec.run}   (cwd ${rt.spec.cwd}${entry?.envProfile ? `, env ${entry.envProfile}` : ''})`);
    let child: ChildProcess;
    const { tail, fds } = OutputTail.prepare(paths.logsDir(rt.ws), rt.spec.name);
    try {
      child = spawnShell(rt.spec.run, { cwd: rt.spec.cwd, env, stdio: ['ignore', fds[0], fds[1]] });
    } catch (e: any) {
      rt.lastError = e.message;
      this.setStatus(rt, 'crashed');
      return { ok: false, key, status: rt.status, reason: e.message };
    } finally {
      fds.forEach((fd) => fs.closeSync(fd));
    }
    // The daemon must not keep a detached service alive, nor die with it.
    child.unref();
    rt.tail = tail;
    rt.child = child;
    rt.pid = child.pid;
    rt.adopted = false;
    rt.startedAt = now();
    rt.readyAt = undefined;
    rt.exitCode = undefined;
    rt.image = undefined;
    rt.imagePid = undefined;
    rt.health = { state: rt.spec.health ? 'unknown' : 'none', kind: rt.spec.health?.kind || 'none', consecutiveFailures: 0 };
    rt.memAlarm = false;
    this.setStatus(rt, 'starting');

    child.on('error', (e) => {
      if (gen !== rt.generation) return;
      rt.lastError = e.message;
      this.logs.system(key, `✖ spawn error: ${e.message}`);
    });
    child.on('exit', (code, signal) => {
      if (gen !== rt.generation) return;
      this.onExit(rt, code, signal);
    });

    this.armReadiness(rt, gen);
    return this.result(key, true);
  }

  private armReadiness(rt: Runtime, gen: number) {
    clearTimeout(rt.readyTimer);
    rt.readyTimer = setTimeout(() => {
      if (gen !== rt.generation || rt.status !== 'starting') return;
      const why = `not ready after ${Math.round(rt.spec.readyTimeoutMs / 1000)}s` + (rt.spec.readyLog ? ` (log never matched /${rt.spec.readyLog.source}/)` : rt.health.lastError ? ` (health: ${rt.health.lastError})` : '');
      rt.lastError = why;
      this.incidents.add({ key: rt.key, kind: 'start-failed', severity: 'warning', title: why, context: this.logs.recent(rt.key, 30) });
      this.setStatus(rt, 'unhealthy');
    }, rt.spec.readyTimeoutMs);

    // Without a log pattern or health check, "alive for 1.5s" is the best we know.
    if (!rt.spec.readyLog && !rt.spec.health) {
      setTimeout(() => {
        if (gen === rt.generation && rt.status === 'starting') this.markReady(rt);
      }, 1500);
    }
  }

  private markReady(rt: Runtime) {
    clearTimeout(rt.readyTimer);
    rt.readyAt = now();
    this.logs.system(rt.key, `✔ ready in ${((rt.readyAt - (rt.startedAt || rt.readyAt)) / 1000).toFixed(1)}s`);
    this.incidents.resolve(rt.key, ['start-failed', 'unhealthy', 'port-conflict', 'crash']);
    this.setStatus(rt, 'running');
  }

  private drainTail(rt: Runtime) {
    rt.tail?.drain((stream, text) => this.logs.write(rt.key, stream, text));
  }

  private onExit(rt: Runtime, code: number | null, signal: NodeJS.Signals | null) {
    clearTimeout(rt.readyTimer);
    this.drainTail(rt);
    this.logs.flush(rt.key);
    rt.tail = undefined;
    rt.child = undefined;
    rt.exitCode = code;
    const wasStarting = rt.status === 'starting';
    rt.pid = undefined;
    rt.imagePid = undefined;
    rt.cpu = undefined;
    rt.mem = undefined;

    if (rt.stopping) {
      this.logs.system(rt.key, `■ stopped`);
      this.setStatus(rt, 'stopped');
      return;
    }
    const desc = code !== null ? `exit code ${code}` : signal ? `signal ${signal}` : 'exited, code unknown (re-attached process)';
    if (code === 0 && rt.spec.restart.policy !== 'always') {
      this.logs.system(rt.key, `■ exited (${desc})`);
      this.setStatus(rt, 'exited');
      return;
    }

    const context = this.logs.recent(rt.key, 40);
    rt.lastError = (pickHeadline(context.slice(-30).reverse()) || desc).slice(0, 200);
    this.logs.system(rt.key, `✖ ${wasStarting ? 'failed to start' : 'crashed'} (${desc})`);

    const policy = rt.spec.restart;
    const t = now();
    rt.restartTimes = rt.restartTimes.filter((x) => t - x < policy.windowMs);
    const canRestart = policy.policy !== 'no' && rt.restartTimes.length < policy.max;
    const title = `${wasStarting ? 'failed to start' : 'crashed'} (${desc})${canRestart ? '' : policy.policy === 'no' ? '' : ` — gave up after ${policy.max} restarts`}`;
    this.incidents.add({
      key: rt.key,
      kind: wasStarting ? 'start-failed' : 'crash',
      severity: 'error',
      title,
      detail: rt.lastError,
      exitCode: code,
      restart: rt.restartTimes.length,
      context,
    });

    if (!canRestart) {
      this.setStatus(rt, 'crashed');
      return;
    }
    const n = rt.restartTimes.length;
    const delay = Math.min(30_000, policy.backoff === 'exponential' ? policy.delayMs * 2 ** n : policy.delayMs);
    rt.restartTimes.push(t);
    rt.restarts++;
    this.logs.system(rt.key, `↻ restarting in ${(delay / 1000).toFixed(1)}s (attempt ${n + 1}/${policy.max})`);
    this.setStatus(rt, 'backoff');
    rt.restartTimer = setTimeout(() => {
      if (rt.status === 'backoff') void this.spawnOne(rt.key);
    }, delay);
  }

  waitReady(rt: Runtime, timeoutMs: number): Promise<boolean> {
    if (rt.status === 'running') return Promise.resolve(true);
    if (['crashed', 'stopped', 'exited'].includes(rt.status)) return Promise.resolve(false);
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        rt.waiters = rt.waiters.filter((w) => w !== done);
        resolve(false);
      }, timeoutMs);
      const done = (ok: boolean) => {
        clearTimeout(t);
        resolve(ok);
      };
      rt.waiters.push(done);
    });
  }

  private flushWaiters(rt: Runtime, ok: boolean) {
    // backoff is transient: keep waiting for the next attempt
    if (rt.status === 'backoff') return;
    const ws = rt.waiters;
    rt.waiters = [];
    ws.forEach((w) => w(ok));
  }

  // ------------------------------------------------------------------ stop

  async stop(key: string): Promise<{ ok: boolean; key: string; status: ServiceStatus; note?: string }> {
    const rt = this.rt(key);
    if (this.queued.has(key)) {
      // Not running yet: take it out of the queue instead.
      this.queued.delete(key);
      this.cancelled.add(key);
      this.emitStatus(rt);
      return { ok: true, key, status: rt.status, note: 'removed from the start queue' };
    }
    clearTimeout(rt.restartTimer);
    clearTimeout(rt.readyTimer);
    rt.stopping = true;
    if (rt.status === 'backoff' || (!rt.pid && !rt.child)) {
      this.setStatus(rt, 'stopped');
      return { ok: true, key, status: rt.status };
    }
    this.setStatus(rt, 'stopping');
    const entry = this.workspaces.get(rt.ws);
    if (rt.spec.stop.command) {
      this.logs.system(key, `■ ${rt.spec.stop.command}`);
      const r = await runShell(rt.spec.stop.command, rt.spec.cwd, resolveEnv(rt.spec, entry?.envProfile), rt.spec.stop.timeoutMs);
      if (r.output.trim()) this.logs.system(key, r.output.trim().split('\n').slice(-5).join(' | '));
    }
    const pid = rt.pid;
    let note: string | undefined;
    if (pid && pidAlive(pid) && isWindows && !rt.spec.stop.command) {
      // Console programs on Windows cannot be asked politely (no window to
      // close, no signal to send), so a polite stop request only wastes time.
      killTree(pid);
    } else if (pid && pidAlive(pid)) {
      signalTree(pid);
      const deadline = now() + rt.spec.stop.timeoutMs;
      while (pidAlive(pid) && now() < deadline) await sleep(150);
      if (pidAlive(pid)) {
        killTree(pid);
        note = 'force-killed after grace period';
      }
    }
    if (rt.imagePid && pidAlive(rt.imagePid)) killTree(rt.imagePid);
    // child 'exit' normally flips us to stopped; adopted processes have no child.
    const deadline = now() + 3000;
    while (rt.status === 'stopping' && rt.child && now() < deadline) await sleep(100);
    if (rt.status !== 'stopped') {
      rt.child = undefined;
      rt.pid = undefined;
      this.logs.system(key, '■ stopped');
      this.setStatus(rt, 'stopped');
    }
    rt.adopted = false;
    rt.cpu = rt.mem = undefined;
    // A deliberate stop acknowledges whatever was wrong with this run.
    this.incidents.resolve(key);
    return { ok: true, key, status: rt.status, note };
  }

  async restart(key: string, opts: { wait?: boolean; timeoutMs?: number } = {}) {
    await this.stop(key);
    return this.start(key, { deps: false, wait: opts.wait, timeoutMs: opts.timeoutMs });
  }

  async stopWorkspace(id: string) {
    // Dependents first: reverse topological-ish order by dependency depth.
    const rts = [...this.runtimes.values()].filter((r) => r.ws === id);
    const depth = (r: Runtime, seen = new Set<string>()): number =>
      seen.has(r.key) ? 0 : 1 + Math.max(0, ...r.spec.dependsOn.map((d) => this.runtimes.get(`${id}/${d}`)).filter(Boolean).map((d) => depth(d!, new Set(seen).add(r.key))));
    const byDepth = new Map<number, Runtime[]>();
    for (const r of rts) {
      const d = depth(r);
      byDepth.set(d, [...(byDepth.get(d) || []), r]);
    }
    const out = [];
    for (const d of [...byDepth.keys()].sort((a, b) => b - a)) out.push(...(await Promise.all(byDepth.get(d)!.map((r) => this.stop(r.key)))));
    return out;
  }

  async shutdown({ stopServices }: { stopServices: boolean }) {
    this.timers.forEach(clearInterval);
    this.saveState();
    for (const w of this.workspaces.values()) w.watcher?.close();
    if (stopServices) await Promise.all([...this.workspaces.keys()].map((id) => this.stopWorkspace(id)));
    this.saveState();
  }

  // ------------------------------------------------------- health & metrics

  private async healthTick() {
    const t = now();
    await Promise.all(
      [...this.runtimes.values()].map(async (rt) => {
        const h = rt.spec.health;
        // Adopted processes have no child 'exit' event: poll their liveness.
        if (rt.adopted && rt.pid && !pidAlive(rt.pid) && rt.status !== 'stopping') {
          rt.adopted = false;
          this.onExit(rt, null, null);
          return;
        }
        if (!h || !['starting', 'running', 'unhealthy'].includes(rt.status)) return;
        const interval = rt.status === 'starting' ? 700 : h.intervalMs;
        if (rt.health.lastCheck && t - rt.health.lastCheck < interval) return;
        rt.health.lastCheck = t;
        const r =
          h.kind === 'http'
            ? await probeHttp(String(h.target), rt.spec.port, h.expect, h.timeoutMs)
            : await probeTcp(Number(h.target), h.timeoutMs).then((x) => ({ ...x, error: x.ok ? undefined : `port ${h.target} not accepting connections` }));
        if (!['starting', 'running', 'unhealthy'].includes(rt.status)) return;
        rt.health.latencyMs = r.latencyMs;
        rt.lastLatency = r.latencyMs;
        const prevState = rt.health.state;
        if (r.ok) {
          rt.health.state = 'ok';
          rt.health.lastError = undefined;
          rt.health.consecutiveFailures = 0;
          if (rt.status === 'starting' && !rt.spec.readyLog) this.markReady(rt);
          else if (rt.status === 'unhealthy') {
            this.logs.system(rt.key, '✔ healthy again');
            this.incidents.resolve(rt.key, ['unhealthy', 'start-failed']);
            this.setStatus(rt, 'running');
          }
        } else {
          rt.health.state = 'failing';
          rt.health.lastError = r.error;
          rt.health.consecutiveFailures++;
          if (rt.status === 'running' && rt.health.consecutiveFailures >= rt.spec.alerts.unhealthyAfter) {
            const title = `unhealthy: ${r.error}`;
            this.logs.system(rt.key, `⚠ ${title}`);
            this.incidents.add({ key: rt.key, kind: 'unhealthy', severity: 'warning', title, context: this.logs.recent(rt.key, 20) });
            this.setStatus(rt, 'unhealthy');
          }
        }
        if (prevState !== rt.health.state) this.emitStatus(rt);
      }),
    );
  }

  private async metricsTick() {
    const roots = new Map<string, number>();
    for (const rt of this.runtimes.values()) if (rt.pid) roots.set(rt.key, rt.pid);
    if (!roots.size) return;
    const samples = await this.sampler.sample(roots);
    const t = now();
    for (const [key, s] of samples) {
      const rt = this.runtimes.get(key);
      if (!rt || !rt.pid) continue;
      rt.cpu = s.cpu;
      rt.mem = s.mem;
      if (s.image && s.image.pid !== rt.pid) {
        rt.image = s.image.name;
        rt.imagePid = s.image.pid;
        rt.imageCmd = s.image.cmd;
      } else if (s.image) rt.image = s.image.name;
      const point = { t, cpu: s.cpu, mem: s.mem, latency: rt.lastLatency };
      rt.history.push(point);
      this.emit({ type: 'metrics', key, point });
      const limit = rt.spec.alerts.memBytes;
      if (limit && s.mem > limit && !rt.memAlarm) {
        rt.memAlarm = true;
        this.incidents.add({ key, kind: 'memory', severity: 'warning', title: `uses ${(s.mem / 1048576).toFixed(0)} MB (limit ${(limit / 1048576).toFixed(0)} MB)`, context: [] });
      } else if (limit && s.mem < limit * 0.9 && rt.memAlarm) {
        rt.memAlarm = false;
        this.incidents.resolve(key, ['memory']);
      }
    }
  }

  // ---------------------------------------------------- orphan adoption

  private saveState() {
    if (!this.stateDirty && ![...this.runtimes.values()].some((r) => r.tail)) return;
    this.stateDirty = false;
    const state: StateFile = {};
    for (const rt of this.runtimes.values()) {
      if (rt.pid && ['starting', 'running', 'unhealthy'].includes(rt.status)) {
        state[rt.key] = { pid: rt.pid, imagePid: rt.imagePid, image: rt.image, imageCmd: rt.imageCmd, startedAt: rt.startedAt || now(), run: rt.spec.run, tail: rt.tail ? { ...rt.tail.pos } : undefined };
      }
    }
    writeJsonAtomic(paths.state, state);
  }

  /**
   * After a daemon crash the services usually live on. Re-attach only when
   * the PID still runs the very command we started (PIDs get recycled):
   * the shell wrapper's command line contains `run`, or the recorded main
   * image is still alive with the same command line.
   */
  private async adoptOrphans() {
    const state = readJson<StateFile>(paths.state, {});
    const keys = Object.keys(state).filter((k) => this.runtimes.has(k));
    if (!keys.length) return;
    const snap = await listProcesses({ withCommandLine: true });
    const norm = (s: string) => s.replace(/["']/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
    for (const key of keys) {
      const rec = state[key];
      const rt = this.runtimes.get(key)!;
      if (norm(rec.run) !== norm(rt.spec.run)) continue;
      const root = snap.get(rec.pid);
      const image = rec.imagePid ? snap.get(rec.imagePid) : undefined;
      let pid: number | undefined;
      if (root && norm(root.cmd).includes(norm(rec.run))) pid = rec.pid;
      else if (image && rec.imageCmd && norm(image.cmd) === norm(rec.imageCmd)) pid = rec.imagePid;
      if (!pid) continue;
      rt.pid = pid;
      rt.adopted = true;
      rt.startedAt = rec.startedAt;
      rt.readyAt = now();
      rt.image = mainImage(pid, snap)?.name || rec.image;
      rt.status = 'running';
      rt.health.state = rt.spec.health ? 'unknown' : 'none';
      rt.imagePid = rec.imagePid;
      rt.imageCmd = rec.imageCmd;
      const files = OutputTail.files(paths.logsDir(rt.ws), rt.spec.name);
      if (rec.tail && fs.existsSync(files.out)) {
        rt.tail = new OutputTail(files, { ...rec.tail });
        this.logs.system(key, `⇄ re-attached to PID ${pid} after daemon restart`);
        this.drainTail(rt);
      } else {
        this.logs.system(key, `⇄ re-attached to PID ${pid} after daemon restart — output of this run is not captured; restart the service to see new logs`);
      }
      this.emitStatus(rt);
    }
    this.stateDirty = true;
  }
}
