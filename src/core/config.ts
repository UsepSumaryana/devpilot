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
    services: z.record(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'service names: letters, digits, . _ -'), serviceSchema),
  })
  .strict();

export type ConfigFile = z.infer<typeof fileSchema>;

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
}

export interface WorkspaceConfig {
  id: string;
  name: string;
  root: string;
  configPath: string;
  profiles: Record<string, string[]>;
  envProfiles: string[];
  services: ServiceSpec[];
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
    let health: ServiceSpec['health'];
    if (s.health?.http) {
      health = {
        kind: 'http',
        target: s.health.http,
        expect: s.health.expect === undefined ? [] : ([] as number[]).concat(s.health.expect),
        intervalMs: parseDuration(s.health.interval, 5000),
        timeoutMs: parseDuration(s.health.timeout, 2000),
      };
    } else if (s.health?.tcp || (s.health && s.port)) {
      health = { kind: 'tcp', target: s.health.tcp ?? s.port!, expect: [], intervalMs: parseDuration(s.health.interval, 5000), timeoutMs: parseDuration(s.health.timeout, 1500) };
    } else if (s.port) {
      health = { kind: 'tcp', target: s.port, expect: [], intervalMs: 5000, timeoutMs: 1500 };
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
    };
  });

  const profiles = file.profiles || {};
  for (const [p, list] of Object.entries(profiles)) {
    for (const svc of list) if (!names.includes(svc)) throw new Error(`profile "${p}" names unknown service "${svc}"`);
  }
  if (!profiles.default) profiles.default = names;

  const envProfiles = new Set<string>(Object.keys(globalProfiles));
  for (const s of services) Object.keys(s.envProfiles).forEach((p) => envProfiles.add(p));

  return {
    id: workspaceId(root),
    name: file.name || path.basename(root),
    root,
    configPath: path.resolve(configPath),
    profiles,
    envProfiles: [...envProfiles],
    services,
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
