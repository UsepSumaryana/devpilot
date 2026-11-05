// Turns a service's state, incidents and logs into a triage report: what is
// wrong, the evidence, and concrete next steps. Read-only — never changes code.
import fs from 'node:fs';
import path from 'node:path';
import type { Incident, ServiceView } from '../shared/types.js';
import type { Supervisor } from './supervisor.js';
import { parseDotenv } from './config.js';
import { findListeningPids, listProcesses } from './platform/index.js';

export interface Finding {
  level: 'error' | 'warning' | 'info';
  title: string;
  detail?: string;
  suggestion?: string;
}

export interface Diagnosis {
  service: ServiceView;
  verdict: string;
  findings: Finding[];
  lastIncident?: Incident;
  errorBlock: string[];
  recentLogs: string[];
  dependencies: Array<{ name: string; status: string }>;
  portHolder?: { pid: number; name?: string; cmd?: string; isThisService: boolean };
  missingEnv: string[];
}

interface Rule {
  re: RegExp;
  finding: (m: RegExpMatchArray, svc: ServiceView) => Finding;
}

const RULES: Rule[] = [
  {
    re: /EADDRINUSE.*?:(\d+)|address already in use.*?:(\d+)|port (\d+) is already in use|Address already in use/i,
    finding: (m) => ({ level: 'error', title: `Port ${m[1] || m[2] || m[3] || ''} is already taken`.trim(), suggestion: 'Find the holder with `devpilot ports`, stop it, or change `port:` in devpilot.yaml.' }),
  },
  {
    re: /Cannot find module '([^']+)'|ERR_MODULE_NOT_FOUND|Module not found: .*?'([^']+)'/i,
    finding: (m) => ({ level: 'error', title: `Missing Node module ${m[1] || m[2] || ''}`.trim(), suggestion: 'Dependencies are probably not installed or out of date: run the package manager install in the service cwd.' }),
  },
  {
    re: /ModuleNotFoundError: No module named '([^']+)'/,
    finding: (m) => ({ level: 'error', title: `Missing Python module ${m[1]}`, suggestion: 'Activate/create the venv and install requirements (pip install -r requirements.txt), or point `run:` at the venv python.' }),
  },
  {
    re: /ECONNREFUSED\s*(?:127\.0\.0\.1|localhost|::1|\[::1\])?:?(\d+)?|Connection refused/i,
    finding: (m) => ({ level: 'error', title: `A dependency refused the connection${m[1] ? ` on port ${m[1]}` : ''}`, suggestion: 'The service it talks to is not running or not ready. Start it, or add it to `depends_on` so DevPilot waits for it.' }),
  },
  {
    re: /password authentication failed|Access denied for user|authentication failed|invalid credentials/i,
    finding: () => ({ level: 'error', title: 'Authentication to a backing service failed', suggestion: 'Check credentials in the env files / active env profile.' }),
  },
  {
    re: /is not recognized as an internal or external command|command not found|: not found$/i,
    finding: () => ({ level: 'error', title: 'A program in `run:` is not installed or not on PATH', suggestion: 'Install it or use an absolute path / the project wrapper (mvnw, gradlew, venv python).' }),
  },
  {
    re: /JavaScript heap out of memory|OutOfMemoryError|MemoryError/,
    finding: () => ({ level: 'error', title: 'Out of memory', suggestion: 'Raise the heap (NODE_OPTIONS=--max-old-space-size / -Xmx) or look for a leak in the memory chart.' }),
  },
  {
    re: /ENOENT: no such file or directory, (?:open|stat|scandir) '([^']+)'|FileNotFoundError: .*?'([^']+)'/,
    finding: (m) => ({ level: 'error', title: `File not found: ${m[1] || m[2]}`, suggestion: 'Check `cwd:` in devpilot.yaml and that build/setup steps have run.' }),
  },
  {
    re: /EACCES|Permission denied/i,
    finding: () => ({ level: 'error', title: 'Permission denied', suggestion: 'Ports below 1024 need privileges; files may be locked by another process.' }),
  },
  {
    re: /SyntaxError|TS\d{4}:|error\[E\d+\]|compilation failed|BUILD FAILURE|cannot find symbol/i,
    finding: () => ({ level: 'error', title: 'The code does not compile / parse', suggestion: 'The error block shows the file and line to fix.' }),
  },
];

function exampleKeys(svc: ServiceView, root: string): string[] {
  for (const dir of [svc.cwd, root]) {
    for (const f of ['.env.example', '.env.sample', '.env.template']) {
      const p = path.join(dir, f);
      if (fs.existsSync(p)) return Object.keys(parseDotenv(fs.readFileSync(p, 'utf8')));
    }
  }
  return [];
}

export async function diagnose(sup: Supervisor, key: string): Promise<Diagnosis> {
  const svc = sup.view(key);
  const ws = sup.workspace(svc.workspace)!;
  const findings: Finding[] = [];
  const incidents = sup.incidents.query({ key, limit: 20 });
  const lastIncident = incidents.find((i) => i.kind !== 'error-log') || incidents[0];
  const errorIncident = incidents.find((i) => i.kind === 'error-log' || i.kind === 'crash' || i.kind === 'start-failed');
  const recentLogs = sup.logs.recent(key, 60);
  const errorBlock = errorIncident?.context?.length ? errorIncident.context : recentLogs.filter((l) => l.startsWith('! ')).slice(-20);

  // Status
  if (svc.status === 'crashed') findings.push({ level: 'error', title: `Not running: ${svc.lastError || `exit code ${svc.exitCode}`}`, detail: svc.restarts ? `${svc.restarts} automatic restart(s) did not help.` : undefined });
  else if (svc.status === 'backoff') findings.push({ level: 'error', title: `Crash-looping (restart #${svc.restarts})`, detail: svc.lastError });
  else if (svc.status === 'unhealthy') findings.push({ level: 'warning', title: `Running but unhealthy: ${svc.health.lastError || svc.lastError || 'health check failing'}` });
  else if (svc.status === 'starting') findings.push({ level: 'info', title: 'Still starting — readiness not reached yet' });
  else if (svc.status === 'stopped' || svc.status === 'exited') findings.push({ level: 'info', title: `Service is ${svc.status}`, suggestion: `devpilot start ${svc.name}` });

  // Known error signatures, newest evidence first.
  const evidence = [...errorBlock, ...recentLogs.slice(-30)].join('\n');
  const seen = new Set<string>();
  for (const rule of RULES) {
    const m = evidence.match(rule.re);
    if (!m) continue;
    const f = rule.finding(m, svc);
    if (seen.has(f.title)) continue;
    seen.add(f.title);
    findings.push({ ...f, detail: m[0].slice(0, 200) });
  }

  // Dependencies
  const dependencies = svc.dependsOn.map((d) => {
    try {
      return { name: d, status: sup.view(`${svc.workspace}/${d}`).status };
    } catch {
      return { name: d, status: 'unknown' };
    }
  });
  for (const d of dependencies) if (d.status !== 'running') findings.push({ level: 'warning', title: `Dependency ${d.name} is ${d.status}`, suggestion: `devpilot diagnose ${d.name}` });

  // Port holder
  let portHolder: Diagnosis['portHolder'];
  if (svc.port) {
    const pid = (await findListeningPids()).get(svc.port);
    if (pid) {
      const snap = await listProcesses({ withCommandLine: true });
      const p = snap.get(pid);
      let isThis = false;
      for (let cur = p; cur && !isThis; cur = snap.get(cur.ppid)) if (cur.pid === svc.pid) isThis = true;
      portHolder = { pid, name: p?.name, cmd: p?.cmd, isThisService: isThis };
      if (!isThis && svc.status !== 'running') findings.push({ level: 'error', title: `Port ${svc.port} is held by another process: PID ${pid} ${p?.name || ''}`.trim(), detail: p?.cmd, suggestion: `devpilot ports kill ${svc.port} --force (only if that process is yours to stop)` });
    } else if (svc.status === 'running' && svc.health.kind !== 'none') {
      findings.push({ level: 'warning', title: `Nothing is listening on port ${svc.port}`, suggestion: 'The app may listen on a different port than devpilot.yaml says.' });
    }
  }

  // Env vars promised by .env.example but missing.
  const env = sup.envFor(key);
  const missingEnv = exampleKeys(svc, ws.root).filter((k) => !(k in env) || env[k] === '');
  if (missingEnv.length) findings.push({ level: 'warning', title: `${missingEnv.length} env var(s) from .env.example are not set`, detail: missingEnv.join(', '), suggestion: 'Add them to an env file listed in devpilot.yaml (env_files) or the active env profile.' });

  if (svc.health.state === 'failing' && svc.health.lastError) findings.push({ level: 'warning', title: `Health check failing: ${svc.health.lastError}`, detail: `${svc.health.consecutiveFailures} consecutive failure(s)` });
  if (svc.adopted) findings.push({ level: 'info', title: 'Re-attached after a daemon restart: logs of this run were not captured', suggestion: `devpilot restart ${svc.name}` });

  const top = findings.find((f) => f.level === 'error') || findings.find((f) => f.level === 'warning');
  const verdict = top ? top.title : svc.status === 'running' ? 'No problems detected.' : `Service is ${svc.status}.`;
  return { service: svc, verdict, findings, lastIncident, errorBlock, recentLogs: recentLogs.slice(-30), dependencies, portHolder, missingEnv };
}
