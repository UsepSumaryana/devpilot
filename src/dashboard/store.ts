// Dashboard data layer: REST calls + one SSE stream keeping a live snapshot.
import { useEffect, useState } from 'preact/hooks';
import type { DaemonEvent, Incident, LogLine, MetricPoint, ServiceView, Summary, WorkspaceView } from '../shared/types.js';

export class Unauthorized extends Error {}

export async function api<T = any>(method: string, url: string, body?: unknown): Promise<T> {
  const r = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (r.status === 401) throw new Unauthorized();
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data as T;
}

type Listener = () => void;

interface State {
  connected: boolean;
  unauthorized: boolean;
  version: string;
  daemonStartedAt: number;
  workspaces: WorkspaceView[];
  incidents: Incident[];
  spark: Map<string, MetricPoint[]>; // last ~5 minutes per service, for cards
}

class Store {
  state: State = { connected: false, unauthorized: false, version: '', daemonStartedAt: 0, workspaces: [], incidents: [], spark: new Map() };
  private listeners = new Set<Listener>();
  private logListeners = new Set<(key: string, lines: LogLine[]) => void>();
  private metricListeners = new Set<(key: string, p: MetricPoint) => void>();
  private es?: EventSource;
  private pending = false;

  subscribe(fn: Listener) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  onLogs(fn: (key: string, lines: LogLine[]) => void) {
    this.logListeners.add(fn);
    return () => this.logListeners.delete(fn);
  }
  onMetric(fn: (key: string, p: MetricPoint) => void) {
    this.metricListeners.add(fn);
    return () => this.metricListeners.delete(fn);
  }

  private notify() {
    // Coalesce bursts of events into one render per frame.
    if (this.pending) return;
    this.pending = true;
    requestAnimationFrame(() => {
      this.pending = false;
      this.state = { ...this.state };
      this.listeners.forEach((f) => f());
    });
  }

  async refresh() {
    try {
      const s = await api<Summary>('GET', '/api/summary');
      this.state.workspaces = s.workspaces;
      this.state.incidents = s.incidents;
      this.state.version = s.version;
      this.state.daemonStartedAt = s.startedAt;
      this.state.unauthorized = false;
      // Seed sparklines.
      await Promise.all(
        s.workspaces.flatMap((w) =>
          w.services
            .filter((sv) => sv.pid)
            .map(async (sv) => {
              const m = await api<{ points: MetricPoint[] }>('GET', `/api/services/${sv.key}/metrics?range=15m`);
              this.state.spark.set(sv.key, m.points.slice(-100));
            }),
        ),
      );
    } catch (e) {
      if (e instanceof Unauthorized) this.state.unauthorized = true;
    }
    this.notify();
  }

  connect() {
    void this.refresh();
    this.es?.close();
    const es = new EventSource('/api/events');
    this.es = es;
    es.addEventListener('hello', () => {
      this.state.connected = true;
      void this.refresh();
    });
    es.addEventListener('status', (e) => this.apply(JSON.parse((e as MessageEvent).data)));
    es.addEventListener('incident', (e) => this.apply(JSON.parse((e as MessageEvent).data)));
    es.addEventListener('metrics', (e) => this.apply(JSON.parse((e as MessageEvent).data)));
    es.addEventListener('log', (e) => this.apply(JSON.parse((e as MessageEvent).data)));
    es.addEventListener('workspaces', () => void this.refresh());
    es.onerror = () => {
      this.state.connected = false;
      this.notify();
      // EventSource retries by itself; a 401 needs a fresh login link instead.
      void this.refresh();
    };
  }

  private apply(e: DaemonEvent) {
    switch (e.type) {
      case 'status': {
        const ws = this.state.workspaces.find((w) => w.id === e.service.workspace);
        if (!ws) return void this.refresh();
        const i = ws.services.findIndex((s) => s.key === e.service.key);
        if (i === -1) ws.services.push(e.service);
        else ws.services[i] = e.service;
        ws.services = [...ws.services];
        this.state.workspaces = [...this.state.workspaces];
        break;
      }
      case 'incident': {
        const list = this.state.incidents.filter((i) => i.id !== e.incident.id);
        if (!e.incident.resolvedAt) list.unshift(e.incident);
        this.state.incidents = list.slice(0, 50);
        break;
      }
      case 'metrics': {
        const arr = [...(this.state.spark.get(e.key) || []), e.point].slice(-100);
        this.state.spark.set(e.key, arr);
        this.metricListeners.forEach((f) => f(e.key, e.point));
        break;
      }
      case 'log':
        this.logListeners.forEach((f) => f(e.key, e.lines));
        return; // logs do not change the snapshot
    }
    this.notify();
  }

  service(key: string): ServiceView | undefined {
    for (const w of this.state.workspaces) for (const s of w.services) if (s.key === key) return s;
  }
}

export const store = new Store();

export function useStore(): State {
  const [, set] = useState(0);
  useEffect(() => store.subscribe(() => set((n) => n + 1)), []);
  return store.state;
}

export function useHashRoute(): string[] {
  const read = () => location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const on = () => setRoute(read());
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);
  return route;
}

export const go = (path: string) => (location.hash = path);
