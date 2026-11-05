// Detects runnable services in a folder tree and drafts a devpilot.yaml.
// Covers Node (npm/yarn/pnpm/bun), Python (Django/FastAPI/Flask), Go, Java
// (Maven/Gradle Spring Boot), Rust, .NET, Docker Compose and Procfiles.
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

export interface DetectedService {
  name: string;
  cwd: string; // relative to root, '.' for root
  run?: string;
  compose?: string;
  services?: string[];
  port?: number;
  health?: { http?: string; tcp?: number };
  depends_on?: string[];
  runtime: string;
  confidence: 'high' | 'medium' | 'low';
  note?: string;
}

const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'target', 'vendor', '.venv', 'venv', '__pycache__', '.next', '.nuxt', 'coverage', 'bin', 'obj', '.idea', '.vscode', '.gradle']);

const read = (p: string) => {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return '';
  }
};
const exists = (...p: string[]) => fs.existsSync(path.join(...p));

function envPort(dir: string): number | undefined {
  for (const f of ['.env.local', '.env.development', '.env']) {
    const m = read(path.join(dir, f)).match(/^\s*(?:SERVER_)?PORT\s*=\s*["']?(\d{2,5})/m);
    if (m) return Number(m[1]);
  }
}

function nodeService(dir: string, name: string): DetectedService | null {
  let pkg: any;
  try {
    pkg = JSON.parse(read(path.join(dir, 'package.json')));
  } catch {
    return null;
  }
  const scripts: Record<string, string> = pkg.scripts || {};
  const script = ['dev', 'start:dev', 'serve', 'start', 'develop'].find((s) => scripts[s]);
  if (!script) return null;
  const pm = exists(dir, 'pnpm-lock.yaml') ? 'pnpm' : exists(dir, 'yarn.lock') ? 'yarn' : exists(dir, 'bun.lockb') || exists(dir, 'bun.lock') ? 'bun' : 'npm';
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const cmd = scripts[script];
  let port = Number(cmd.match(/(?:--port|-p)[ =](\d{2,5})/)?.[1]) || envPort(dir);
  let runtime = 'node';
  if (deps.next) (runtime = 'next'), (port ||= 3000);
  else if (deps.vite) (runtime = 'vite'), (port ||= 5173);
  else if (deps['@nestjs/core']) (runtime = 'nestjs'), (port ||= 3000);
  else if (deps['@angular/core']) (runtime = 'angular'), (port ||= 4200);
  else if (deps.nuxt) (runtime = 'nuxt'), (port ||= 3000);
  else if (deps.express || deps.fastify || deps.koa || deps.hono) runtime = 'node-server';
  return {
    name: (pkg.name || name).replace(/^@[^/]+\//, '').replace(/[^A-Za-z0-9._-]/g, '-'),
    cwd: '',
    run: pm === 'npm' ? `npm run ${script}` : `${pm} ${script}`,
    port: port || undefined,
    runtime,
    confidence: port ? 'high' : 'medium',
    note: port ? undefined : 'port unknown — set `port:` so readiness and health checks work',
  };
}

function pythonService(dir: string, name: string): DetectedService | null {
  const hasPy = exists(dir, 'pyproject.toml') || exists(dir, 'requirements.txt') || exists(dir, 'manage.py') || exists(dir, 'Pipfile');
  if (!hasPy) return null;
  const venv = ['.venv', 'venv'].find((v) => exists(dir, v));
  const py = venv ? (process.platform === 'win32' ? `${venv}\\Scripts\\python` : `${venv}/bin/python`) : 'python';
  const reqs = (read(path.join(dir, 'requirements.txt')) + read(path.join(dir, 'pyproject.toml'))).toLowerCase();
  if (exists(dir, 'manage.py')) return { name, cwd: '', run: `${py} manage.py runserver 8000`, port: 8000, runtime: 'django', confidence: 'high' };
  for (const f of ['main.py', 'app.py', 'app/main.py', 'src/main.py', 'server.py']) {
    const src = read(path.join(dir, f));
    if (!src) continue;
    const mod = f.replace(/\.py$/, '').replace(/\//g, '.');
    if (/FastAPI\(/.test(src) || reqs.includes('fastapi')) {
      const app = src.match(/^(\w+)\s*=\s*FastAPI\(/m)?.[1] || 'app';
      return { name, cwd: '', run: `${py} -m uvicorn ${mod}:${app} --reload --port 8000`, port: 8000, health: { http: '/docs' }, runtime: 'fastapi', confidence: 'high' };
    }
    if (/Flask\(/.test(src) || reqs.includes('flask')) {
      return { name, cwd: '', run: `${py} -m flask --app ${mod} run --port 5000`, port: 5000, runtime: 'flask', confidence: 'high' };
    }
    return { name, cwd: '', run: `${py} ${f}`, runtime: 'python', confidence: 'low', note: 'guessed entry point' };
  }
  return null;
}

function goService(dir: string, name: string): DetectedService | null {
  if (!exists(dir, 'go.mod')) return null;
  let target = '.';
  if (!exists(dir, 'main.go') && exists(dir, 'cmd')) {
    const sub = fs.readdirSync(path.join(dir, 'cmd')).find((d) => exists(dir, 'cmd', d, 'main.go'));
    if (sub) target = `./cmd/${sub}`;
  }
  const src = read(path.join(dir, target === '.' ? 'main.go' : `${target}/main.go`));
  const port = Number(src.match(/":(\d{2,5})"/)?.[1]) || envPort(dir);
  return { name, cwd: '', run: `go run ${target}`, port, runtime: 'go', confidence: port ? 'high' : 'medium' };
}

function javaService(dir: string, name: string): DetectedService | null {
  const props = read(path.join(dir, 'src/main/resources/application.properties')) + read(path.join(dir, 'src/main/resources/application.yml'));
  const port = Number(props.match(/server\.port\s*[=:]\s*(\d+)/)?.[1] || props.match(/port:\s*(\d+)/)?.[1]) || 8080;
  const win = process.platform === 'win32';
  if (exists(dir, 'pom.xml')) {
    const mvn = exists(dir, 'mvnw') ? (win ? 'mvnw.cmd' : './mvnw') : 'mvn';
    const boot = read(path.join(dir, 'pom.xml')).includes('spring-boot');
    return { name, cwd: '', run: boot ? `${mvn} spring-boot:run` : `${mvn} exec:java`, port, runtime: boot ? 'spring-boot' : 'maven', confidence: boot ? 'high' : 'low', health: boot ? { http: '/actuator/health' } : undefined, note: boot ? 'health uses /actuator/health — remove if actuator is not on the classpath' : undefined };
  }
  if (exists(dir, 'build.gradle') || exists(dir, 'build.gradle.kts')) {
    const gradle = exists(dir, 'gradlew') ? (win ? 'gradlew.bat' : './gradlew') : 'gradle';
    return { name, cwd: '', run: `${gradle} bootRun`, port, runtime: 'gradle', confidence: 'medium' };
  }
  return null;
}

function otherService(dir: string, name: string): DetectedService | null {
  if (exists(dir, 'Cargo.toml')) return { name, cwd: '', run: 'cargo run', runtime: 'rust', confidence: 'medium' };
  const csproj = fs.readdirSync(dir).find((f) => f.endsWith('.csproj'));
  if (csproj) {
    const port = Number(read(path.join(dir, 'Properties/launchSettings.json')).match(/https?:\/\/localhost:(\d+)/)?.[1]) || undefined;
    return { name, cwd: '', run: 'dotnet watch run', port, runtime: 'dotnet', confidence: 'medium' };
  }
  return null;
}

function composeServices(dir: string, rel: string): DetectedService[] {
  const file = ['compose.yaml', 'compose.yml', 'docker-compose.yml', 'docker-compose.yaml'].find((f) => exists(dir, f));
  if (!file) return [];
  let doc: any;
  try {
    doc = YAML.parse(read(path.join(dir, file)));
  } catch {
    return [];
  }
  const names = Object.keys(doc?.services || {});
  if (!names.length) return [];
  // Only infrastructure-looking services; app services are usually run natively.
  const infra = names.filter((n) => /postgres|mysql|maria|mongo|redis|rabbit|kafka|zookeeper|elastic|minio|keycloak|mailhog|mailpit|localstack|nats|db|cache|queue/i.test(n + ' ' + (doc.services[n].image || '')));
  const chosen = infra.length ? infra : names;
  const firstPort = chosen
    .flatMap((n) => doc.services[n].ports || [])
    .map((p: any) => Number(String(typeof p === 'object' ? p.published : p).split(':').slice(-2, -1)[0] || String(p).split(':')[0]))
    .find((p: number) => p > 0);
  return [
    {
      name: 'infra',
      cwd: rel || '.',
      compose: file,
      services: chosen,
      health: firstPort ? { tcp: firstPort } : undefined,
      runtime: 'docker-compose',
      confidence: 'high',
      note: `docker compose services: ${chosen.join(', ')}`,
    },
  ];
}

function procfile(dir: string, rel: string): DetectedService[] {
  const text = read(path.join(dir, 'Procfile.dev')) || read(path.join(dir, 'Procfile'));
  return text
    .split(/\r?\n/)
    .map((l) => l.match(/^([A-Za-z0-9_-]+):\s*(.+)$/))
    .filter(Boolean)
    .map((m) => ({ name: m![1], cwd: rel || '.', run: m![2].trim(), runtime: 'procfile', confidence: 'high' as const }));
}

export function detectServices(root: string, { maxDepth = 3 } = {}): DetectedService[] {
  const found: DetectedService[] = [];
  const walk = (dir: string, depth: number) => {
    const rel = path.relative(root, dir).replace(/\\/g, '/');
    const name = path.basename(dir).replace(/[^A-Za-z0-9._-]/g, '-');
    const pf = procfile(dir, rel);
    found.push(...pf, ...composeServices(dir, rel));
    if (!pf.length) {
      const svc = nodeService(dir, name) || pythonService(dir, name) || goService(dir, name) || javaService(dir, name) || otherService(dir, name);
      if (svc) {
        found.push({ ...svc, cwd: rel || '.' });
        // A project's own subfolders are part of it, except monorepo-style children.
        if (!exists(dir, 'apps') && !exists(dir, 'packages') && !exists(dir, 'services') && depth > 0) return;
      }
    }
    if (depth >= maxDepth) return;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) if (e.isDirectory() && !SKIP.has(e.name) && !e.name.startsWith('.')) walk(path.join(dir, e.name), depth + 1);
  };
  walk(path.resolve(root), 0);

  // Unique names.
  const seen = new Map<string, number>();
  for (const s of found) {
    const n = seen.get(s.name) || 0;
    seen.set(s.name, n + 1);
    if (n) s.name = `${s.name}-${n + 1}`;
  }
  // App services usually need the infra up first.
  const infra = found.find((s) => s.runtime === 'docker-compose');
  if (infra) for (const s of found) if (s !== infra && /node-server|nestjs|fastapi|django|flask|spring-boot|gradle|go|dotnet/.test(s.runtime)) s.depends_on = [infra.name];
  return found;
}

export function draftYaml(root: string, services: DetectedService[]): string {
  const doc: any = { version: 1, name: path.basename(path.resolve(root)), services: {} };
  for (const s of services) {
    const o: any = {};
    if (s.cwd && s.cwd !== '.') o.cwd = s.cwd;
    if (s.compose) {
      o.compose = s.compose;
      o.services = s.services;
    } else o.run = s.run;
    if (s.port) o.port = s.port;
    if (s.health) o.health = s.health;
    if (s.depends_on) o.depends_on = s.depends_on;
    doc.services[s.name] = o;
  }
  const apps = services.filter((s) => s.runtime !== 'docker-compose').map((s) => s.name);
  if (apps.length && apps.length < services.length) doc.profiles = { default: services.map((s) => s.name), apps };
  const notes = services.filter((s) => s.note).map((s) => `#   ${s.name}: ${s.note}`);
  const header = ['# DevPilot services — generated by `devpilot init`. Review before use.', '# Docs: run `devpilot help config`', ...(notes.length ? ['# Notes:', ...notes] : [])].join('\n');
  return `${header}\n${YAML.stringify(doc)}`;
}
