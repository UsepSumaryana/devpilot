// Converts jsrunner's projects.json / profiles.json into DevPilot workspaces.
// Files are written under ~/.devpilot/imported/<group>/devpilot.yaml with
// absolute cwd paths, so the user's repositories are never touched.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { paths } from '../core/paths.js';

interface JsProject {
  id: string;
  name: string;
  group?: string;
  folder: string;
  pm?: string;
  port?: number | null;
  scripts?: string[];
  runScript?: string;
  command?: string;
  env?: Record<string, string>;
  dependsOn?: string[];
  autoRestart?: boolean;
}

interface JsProfile {
  id: string;
  name: string;
  projectIds: string[];
}

const slug = (s: string) => s.toLowerCase().replace(/^@[^/]+\//, '').replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'service';

function runCommand(p: JsProject): string | null {
  if (p.command) return p.command;
  const scripts = p.scripts || [];
  const script = p.runScript || ['dev', 'start:dev', 'start', 'serve'].find((s) => scripts.includes(s)) || scripts[0];
  if (!script) return null;
  const pm = p.pm || 'npm';
  return pm === 'npm' ? `npm run ${script}` : `${pm} ${script}`;
}

export function importJsrunner({ source, write = false, force = false }: { source?: string; write?: boolean; force?: boolean }) {
  const candidates = source ? [source] : [path.join(os.homedir(), '.jsrunner', 'config', 'projects.json')];
  const projectsFile = candidates.find((f) => fs.existsSync(f));
  if (!projectsFile) throw new Error(`jsrunner projects.json not found (looked in ${candidates.join(', ')}). Pass --from <path>.`);
  const projects: JsProject[] = JSON.parse(fs.readFileSync(projectsFile, 'utf8'));
  let profiles: JsProfile[] = [];
  try {
    profiles = JSON.parse(fs.readFileSync(path.join(path.dirname(projectsFile), 'profiles.json'), 'utf8'));
  } catch {
    /* optional */
  }

  const groups = new Map<string, JsProject[]>();
  for (const p of projects) {
    const g = slug(p.group || 'ungrouped');
    groups.set(g, [...(groups.get(g) || []), p]);
  }

  const files: Array<{ path: string; services: number; written: boolean; skipped?: string; yaml: string }> = [];
  for (const [group, list] of groups) {
    const names = new Map<string, string>(); // jsrunner id -> service name
    const services: Record<string, any> = {};
    const skippedProjects: string[] = [];
    for (const p of list) {
      const run = runCommand(p);
      if (!run) {
        skippedProjects.push(p.name);
        continue;
      }
      let name = slug(p.name);
      while (services[name]) name += '-2';
      names.set(p.id, name);
      services[name] = {
        cwd: p.folder.replace(/\\/g, '/'),
        run,
        ...(p.port ? { port: p.port } : {}),
        ...(p.env && Object.keys(p.env).length ? { env: p.env } : {}),
        restart: { policy: p.autoRestart ? 'on-failure' : 'no' },
      };
    }
    for (const p of list) {
      const n = names.get(p.id);
      const deps = (p.dependsOn || []).map((d) => names.get(d)).filter(Boolean);
      if (n && deps.length) services[n].depends_on = deps;
    }
    const prof: Record<string, string[]> = {};
    for (const pf of profiles) {
      const members = pf.projectIds.map((id) => names.get(id)).filter((x): x is string => !!x);
      if (members.length) prof[slug(pf.name)] = members;
    }
    const doc = { version: 1, name: `${group} (from jsrunner)`, ...(Object.keys(prof).length ? { profiles: prof } : {}), services };
    const yaml =
      `# Imported from ${projectsFile} — paths are absolute, your repos were not modified.\n` +
      (skippedProjects.length ? `# Skipped (no runnable script): ${skippedProjects.join(', ')}\n` : '') +
      YAML.stringify(doc);
    const target = path.join(paths.home, 'imported', group, 'devpilot.yaml');
    const entry = { path: target, services: Object.keys(services).length, written: false, skipped: undefined as string | undefined, yaml };
    if (!entry.services) entry.skipped = 'no runnable projects';
    else if (write) {
      if (fs.existsSync(target) && !force) entry.skipped = 'exists (use --force)';
      else {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, yaml);
        entry.written = true;
      }
    }
    files.push(entry);
  }
  return { source: projectsFile, files };
}
