// CPU / memory per service tree, with history.
import os from 'node:os';
import type { MetricPoint } from '../shared/types.js';
import { collectTree, listProcesses, mainImage, type ProcessRecord } from './platform/index.js';

const CORES = os.cpus().length || 1;
const FINE_MAX = 1200; // 3s samples -> 1 hour
const COARSE_MAX = 1440; // 1-minute rollups -> 24 hours

export class MetricsHistory {
  fine: MetricPoint[] = [];
  coarse: MetricPoint[] = [];
  private bucket: MetricPoint[] = [];
  private bucketStart = 0;

  push(p: MetricPoint) {
    this.fine.push(p);
    if (this.fine.length > FINE_MAX) this.fine.shift();
    const minute = Math.floor(p.t / 60_000) * 60_000;
    if (minute !== this.bucketStart && this.bucket.length) {
      const n = this.bucket.length;
      const lat = this.bucket.filter((b) => b.latency !== undefined);
      this.coarse.push({
        t: this.bucketStart,
        cpu: this.bucket.reduce((s, b) => s + b.cpu, 0) / n,
        mem: Math.max(...this.bucket.map((b) => b.mem)),
        latency: lat.length ? lat.reduce((s, b) => s + b.latency!, 0) / lat.length : undefined,
      });
      if (this.coarse.length > COARSE_MAX) this.coarse.shift();
      this.bucket = [];
    }
    this.bucketStart = minute;
    this.bucket.push(p);
  }

  range(r: '15m' | '1h' | '24h'): MetricPoint[] {
    if (r === '24h') return [...this.coarse, ...this.fine.slice(-20)];
    const since = Date.now() - (r === '15m' ? 15 : 60) * 60_000;
    return this.fine.filter((p) => p.t >= since);
  }

  get latest(): MetricPoint | undefined {
    return this.fine[this.fine.length - 1];
  }
}

export interface Sample {
  cpu: number;
  mem: number;
  image?: ProcessRecord;
  treePids: number[];
}

/**
 * Samples every root's whole tree (shell wrapper -> package manager -> runtime)
 * from one process-table snapshot. CPU is the delta of cumulative CPU time
 * since the previous sample, normalised to the whole machine.
 */
export class MetricsSampler {
  private prev = new Map<number, { cpuMs: number; at: number }>();

  async sample(roots: Map<string, number>): Promise<Map<string, Sample>> {
    const out = new Map<string, Sample>();
    if (!roots.size) return out;
    const snapshot = await listProcesses({ withCommandLine: true });
    if (!snapshot.size) return out;
    const now = Date.now();
    for (const [key, pid] of roots) {
      const tree = collectTree(pid, snapshot);
      if (!tree.length) continue;
      let cpuMs = 0;
      let mem = 0;
      for (const p of tree) {
        const r = snapshot.get(p)!;
        cpuMs += r.cpuMs;
        mem += r.mem;
      }
      const prev = this.prev.get(pid);
      const cpu = prev && now > prev.at ? Math.max(0, ((cpuMs - prev.cpuMs) / (now - prev.at) / CORES) * 100) : 0;
      this.prev.set(pid, { cpuMs, at: now });
      out.set(key, { cpu: Math.round(cpu * 10) / 10, mem, image: mainImage(pid, snapshot), treePids: tree });
    }
    for (const pid of this.prev.keys()) if (![...roots.values()].includes(pid)) this.prev.delete(pid);
    return out;
  }
}
