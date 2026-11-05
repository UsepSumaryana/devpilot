// devpilot.yaml: the per-repo description of its services.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import YAML from 'yaml';
import { z } from 'zod';

export { CONFIG_FILES, findConfig } from './find-config.js';

/** "5s", "500ms", "2m", "1h" or a number of ms. */
export function parseDuration(v: string | number | undefined, fallback: number): number {
  if (v === undefined || v === null || v === '') return fallback;
  if (typeof v === 'number') return v;
  const m = String(v).trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/i);
  if (!m) throw new Error(`Invalid duration "${v}" (use e.g. 500ms, 5s, 2m)`);
  const n = parseFloat(m[1]);
  const unit = (m[2] || 'ms').toLowerCase();
  return Math.round(n * { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[unit]!);
}

const duration = z.union([z.string(), z.number()]);
const stringList = z.union([z.string(), z.array(z.string())]).transform((v) => (Array.isArray(v) ? v : [v]));

const healthSchema = z
  .object({
    http: z.string().optional(), // path ("/health") or full URL
    tcp: z.number().int().optional(), // port; defaults to the service port
    expect: z.union([z.number().int(), z.array(z.number().int())]).optional(),
    interval: duration.optional(),
    timeout: duration.optional(),
  })
  .strict();

const nameKey = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'names: letters, digits, . _ -');

/** A one-shot command: yarn install, yarn build, a migration... */
const taskSchema = z.union([
  z.string(),
  z
    .object({
      run: z.string(),
      cwd: z.string().optional(),
      timeout: duration.optional(),
      stop_service: z.boolean().optional(), // stop the service while it runs (file locks on Windows), start it again after
      description: z.string().optional(),
    })
    .strict(),
]);

/** An alternative way to run a service: watch vs built output vs prod. */
const modeSchema = z
  .object({
    run: z.string().optional(),
    env: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
    env_files: stringList.optional(),
    ready: z.object({ log: z.string().optional(), timeout: duration.optional() }).strict().optional(),
    health: healthSchema.optional(),
    before: stringList.optional(), // task names run, in order, before the process starts
    description: z.string().optional(),
  })
  .strict();

const serviceSchema = z
  .object({
    run: z.string().optional(),
    compose: z.string().optional(), // docker compose file, relative to cwd
    services: z.array(z.string()).optional(), // compose services to bring up
    cwd: z.string().optional(),
    port: z.number().int().min(1).max(65535).optional(),
    url: z.string().optional(),
    env: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
    env_files: stringList.optional(),
    env_profiles: z.record(z.string(), z.object({ env_files: stringList.optional(), env: z.record(z.string(), z.string()).optional() })).optional(),
    depends_on: stringList.optional(),
    health: healthSchema.optional(),
    ready: z.object({ log: z.string().optional(), timeout: duration.optional() }).strict().optional(),
    restart: z
      .object({
        policy: z.enum(['no', 'on-failure', 'always']).optional(),
        max: z.number().int().min(0).optional(),
        backoff: z.enum(['fixed', 'exponential']).optional(),
        delay: duration.optional(),
        window: duration.optional(),
      })
      .strict()
      .optional(),
    stop: z.object({ command: z.string().optional(), timeout: duration.optional() }).strict().optional(),
    alerts: z.object({ mem_mb: z.number().optional(), unhealthy_after: z.number().int().optional(), error_patterns: z.array(z.string()).optional() }).strict().optional(),
    autostart: z.boolean().optional(),
    group: z.string().optional(), // display group in the panel/dashboard
    modes: z.record(nameKey, modeSchema).optional(),
    tasks: z.record(nameKey, taskSchema).optional(),
  })
  .strict()
  .refine((s) => s.run || s.compose, { message: 'each service needs `run` or `compose`' });

const fileSchema = z
  .object({
    version: z.literal(1).optional(),
    name: z.string().optional(),
    env_files: stringList.optional(),
    env: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
    env_profiles: z.record(z.string(), z.object({ env_files: stringList.optional(), env: z.record(z.string(), z.string()).optional() })).optional(),
    profiles: z.record(z.string(), z.array(z.string())).optional(),
    tasks: z.record(nameKey, taskSchema).optional(),
    services: z.record(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'service names: letters, digits, . _ -'), serviceSchema),
  })
  .strict();

export type ConfigFile = z.infer<typeof fileSchema>;

export interface TaskSpec {
  name: string;
  run: string;
  cwd: string;
  timeoutMs: number;
  stopService: boolean;
  description?: string;
}

export interface ModeSpec {
  name: string;
  run?: string;
  env: Record<string, string>;
  envFiles: string[];
  readyLog?: RegExp;
  readyTimeoutMs?: number;
  health?: ServiceSpec['health'];
  before: string[];
  description?: string;
}

export const DEFAULT_MODE = 'default';

export interface ServiceSpec {
  name: string;
  run: string;
  cwd: string;
  port?: number;
  url?: string;
  env: Record<string, string>;
  envFiles: string[]; // absolute
  envProfiles: Record<string, { envFiles: string[]; env: Record<string, string> }>;
  dependsOn: string[];
  health?: { kind: 'http' | 'tcp'; target: string | number; expect: number[]; intervalMs: number; timeoutMs: number };
  readyLog?: RegExp;
  readyTimeoutMs: number;
  restart: { policy: 'no' | 'on-failure' | 'always'; max: number; backoff: 'fixed' | 'exponential'; delayMs: number; windowMs: number };
  stop: { command?: string; timeoutMs: number };
  alerts: { memBytes?: number; unhealthyAfter: number; errorPatterns: RegExp[] };
  autostart: boolean;
  group?: string;
  compose?: { file: string; services: string[] };
  modes: Record<string, ModeSpec>;
  tasks: Record<string, TaskSpec>;
  /** Mode this spec was resolved for (DEFAULT_MODE for the plain config). */
  mode: string;
  /** Tasks to run before spawning, from the active mode. */
  before: string[];
}

export interface WorkspaceConfig {
  id: string;
  name: string;
  root: string;
  configPath: string;
  profiles: Record<string, string[]>;
  envProfiles: string[];
  services: ServiceSpec[];
  /** Workspace-level tasks (cwd = workspace root). */
  tasks: Record<string, TaskSpec>;
  /** Every mode some service defines, plus DEFAULT_MODE. */
  modes: string[];
  env: Record<string, string>;
  envFiles: string[];
}

/** Stable, readable id: folder name + short hash of the absolute path. */
export function workspaceId(root: string): string {
  const norm = path.resolve(root).replace(/\\/g, '/').toLowerCase();
  const slug = path.basename(norm).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'ws';
  return `${slug}-${crypto.createHash('sha1').update(norm).digest('hex').slice(0, 6)}`;
}

const quote = (s: string) => (/[\s"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s);

export function parseConfig(text: string, configPath: string): WorkspaceConfig {
  let raw: unknown;
  try {
    raw = YAML.parse(text);
  } catch (e: any) {
    throw new Error(`${path.basename(configPath)}: YAML error: ${e.message}`);
  }
  const res = fileSchema.safeParse(raw ?? {});
  if (!res.success) {
    const issues = res.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
    throw new Error(`${path.basename(configPath)} is invalid:\n${issues}`);
  }
  const file = res.data;
  const root = path.dirname(path.resolve(configPath));
  const abs = (base: string, p: string) => path.resolve(base, p);
  const strEnv = (e?: Record<string, unknown>) => Object.fromEntries(Object.entries(e || {}).map(([k, v]) => [k, String(v)]));

  const globalProfiles = file.env_profiles || {};
  const names = Object.keys(file.services);
  const services: ServiceSpec[] = names.map((name) => {
    const s = file.services[name];
    const cwd = abs(root, s.cwd || '.');
    let run = s.run || '';
    let stopCommand = s.stop?.command;
    let compose: ServiceSpec['compose'];
    if (s.compose) {
      const list = (s.services || []).map(quote).join(' ');
      const f = quote(s.compose);
      run = s.run || `docker compose -f ${f} up ${list}`.trim();
      stopCommand = stopCommand || `docker compose -f ${f} stop ${list}`.trim();
      compose = { file: abs(cwd, s.compose), services: s.services || [] };
    }
    for (const dep of s.depends_on || []) {
      if (!names.includes(dep)) throw new Error(`service "${name}" depends on unknown service "${dep}"`);
    }
    const health = parseHealth(s.health, s.port);
    const tasks = parseTasks(s.tasks, cwd);
    const modes: Record<string, ModeSpec> = {};
    for (const [m, v] of Object.entries(s.modes || {})) {
      if (m === DEFAULT_MODE) throw new Error(`service "${name}": "${DEFAULT_MODE}" is the plain config and cannot be redefined as a mode`);
      for (const t of v.before || []) {
        if (!tasks[t] && !(file.tasks && file.tasks[t])) throw new Error(`service "${name}" mode "${m}" runs unknown task "${t}" before starting`);
      }
      modes[m] = {
        name: m,
        run: v.run,
        env: strEnv(v.env),
        envFiles: (v.env_files || []).map((f) => abs(cwd, f)),
        readyLog: v.ready?.log ? new RegExp(v.ready.log) : undefined,
        readyTimeoutMs: v.ready?.timeout !== undefined ? parseDuration(v.ready.timeout, 120_000) : undefined,
        health: v.health ? parseHealth(v.health, s.port) : undefined,
        before: v.before || [],
        description: v.description,
      };
    }
    const profiles: ServiceSpec['envProfiles'] = {};
    for (const [p, v] of Object.entries(globalProfiles)) profiles[p] = { envFiles: (v.env_files || []).map((f) => abs(root, f)), env: v.env || {} };
    for (const [p, v] of Object.entries(s.env_profiles || {})) {
      const prev = profiles[p] || { envFiles: [], env: {} };
      profiles[p] = { envFiles: [...prev.envFiles, ...(v.env_files || []).map((f) => abs(cwd, f))], env: { ...prev.env, ...(v.env || {}) } };
    }
    const restartPolicy = s.restart?.policy ?? 'on-failure';
    return {
      name,
      run,
      cwd,
      port: s.port,
      url: s.url || (s.port ? `http://localhost:${s.port}` : undefined),
      env: { ...strEnv(file.env), ...strEnv(s.env) },
      envFiles: [...(file.env_files || []).map((f) => abs(root, f)), ...(s.env_files || []).map((f) => abs(cwd, f))],
      envProfiles: profiles,
      dependsOn: s.depends_on || [],
      health,
      readyLog: s.ready?.log ? new RegExp(s.ready.log) : undefined,
      readyTimeoutMs: parseDuration(s.ready?.timeout, 120_000),
      restart: {
        policy: restartPolicy,
        max: s.restart?.max ?? 5,
        backoff: s.restart?.backoff ?? 'exponential',
        delayMs: parseDuration(s.restart?.delay, 1000),
        windowMs: parseDuration(s.restart?.window, 120_000),
      },
      stop: { command: stopCommand, timeoutMs: parseDuration(s.stop?.timeout, compose ? 30_000 : 5000) },
      alerts: {
        memBytes: s.alerts?.mem_mb ? s.alerts.mem_mb * 1024 * 1024 : undefined,
        unhealthyAfter: s.alerts?.unhealthy_after ?? 3,
        errorPatterns: (s.alerts?.error_patterns || []).map((p) => new RegExp(p)),
      },
      autostart: s.autostart ?? false,
      group: s.group,
      compose,
      modes,
      tasks,
      mode: DEFAULT_MODE,
      before: [],
    };
  });

  const profiles = file.profiles || {};
  for (const [p, list] of Object.entries(profiles)) {
    for (const svc of list) if (!names.includes(svc)) throw new Error(`profile "${p}" names unknown service "${svc}"`);
  }
  if (!profiles.default) profiles.default = names;

  const envProfiles = new Set<string>(Object.keys(globalProfiles));
  for (const s of services) Object.keys(s.envProfiles).forEach((p) => envProfiles.add(p));

  const modeNames = new Set<string>([DEFAULT_MODE]);
  for (const s of services) Object.keys(s.modes).forEach((m) => modeNames.add(m));

  return {
    id: workspaceId(root),
    name: file.name || path.basename(root),
    root,
    configPath: path.resolve(configPath),
    profiles,
    envProfiles: [...envProfiles],
    services,
    tasks: parseTasks(file.tasks, root),
    modes: [...modeNames],
    env: strEnv(file.env),
    envFiles: (file.env_files || []).map((f) => abs(root, f)),
  };
}

function parseHealth(h: z.infer<typeof healthSchema> | undefined, port: number | undefined): ServiceSpec['health'] {
  if (h?.http) {
    return {
      kind: 'http',
      target: h.http,
      expect: h.expect === undefined ? [] : ([] as number[]).concat(h.expect),
      intervalMs: parseDuration(h.interval, 5000),
      timeoutMs: parseDuration(h.timeout, 2000),
    };
  }
  if (h?.tcp || (h && port)) return { kind: 'tcp', target: h.tcp ?? port!, expect: [], intervalMs: parseDuration(h.interval, 5000), timeoutMs: parseDuration(h.timeout, 1500) };
  if (port) return { kind: 'tcp', target: port, expect: [], intervalMs: 5000, timeoutMs: 1500 };
  return undefined;
}

function parseTasks(raw: Record<string, z.infer<typeof taskSchema>> | undefined, cwd: string): Record<string, TaskSpec> {
  const out: Record<string, TaskSpec> = {};
  for (const [name, t] of Object.entries(raw || {})) {
    const o = typeof t === 'string' ? { run: t } : t;
    out[name] = {
      name,
      run: o.run,
      cwd: path.resolve(cwd, ('cwd' in o && o.cwd) || '.'),
      timeoutMs: parseDuration('timeout' in o ? o.timeout : undefined, 30 * 60_000),
      stopService: ('stop_service' in o && o.stop_service) || false,
      description: 'description' in o ? o.description : undefined,
    };
  }
  return out;
}

/** The spec a service runs with in `mode` (unknown or default mode: the plain config). */
export function applyMode(spec: ServiceSpec, mode: string | undefined): ServiceSpec {
  const m = mode && mode !== DEFAULT_MODE ? spec.modes[mode] : undefined;
  if (!m) return { ...spec, mode: DEFAULT_MODE, before: [] };
  return {
    ...spec,
    mode: m.name,
    run: m.run ?? spec.run,
    env: { ...spec.env, ...m.env },
    envFiles: [...spec.envFiles, ...m.envFiles],
    readyLog: m.readyLog ?? spec.readyLog,
    readyTimeoutMs: m.readyTimeoutMs ?? spec.readyTimeoutMs,
    health: m.health ?? spec.health,
    before: m.before,
  };
}

export function loadConfig(configPath: string): WorkspaceConfig {
  return parseConfig(fs.readFileSync(configPath, 'utf8'), configPath);
}

/** Minimal dotenv: KEY=VALUE, `export` prefix, quotes, # comments. */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      const dq = v.startsWith('"');
      v = v.slice(1, -1);
      if (dq) v = v.replace(/\\n/g, '\n').replace(/\\"/g, '"');
    } else {
      v = v.replace(/\s+#.*$/, '');
    }
    out[m[1]] = v;
  }
  return out;
}

export function readEnvFile(file: string): Record<string, string> {
  try {
    return parseDotenv(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

/** The environment a service is started with, lowest to highest precedence. */
export function resolveEnv(spec: ServiceSpec, envProfile?: string, base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined) env[k] = v;
  for (const f of spec.envFiles) Object.assign(env, readEnvFile(f));
  const prof = envProfile ? spec.envProfiles[envProfile] : undefined;
  if (prof) for (const f of prof.envFiles) Object.assign(env, readEnvFile(f));
  Object.assign(env, spec.env);
  if (prof) Object.assign(env, prof.env);
  if (spec.port) env.PORT = String(spec.port);
  if (!env.NO_COLOR) env.FORCE_COLOR ??= '1';
  return env;
}
