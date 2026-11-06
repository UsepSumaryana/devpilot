// Wire types shared by the daemon, MCP server, CLI, hooks and dashboard.

export type ServiceStatus =
  | 'stopped' // never started or stopped on request
  | 'starting' // spawned, waiting for readiness
  | 'running' // ready (or no readiness check configured)
  | 'unhealthy' // was ready, health checks now failing
  | 'stopping'
  | 'backoff' // exited unexpectedly, restart scheduled
  | 'crashed' // exited unexpectedly, no more restarts
  | 'exited'; // exited with code 0 on its own

export type HealthState = 'unknown' | 'none' | 'ok' | 'failing';

export interface HealthInfo {
  state: HealthState;
  kind: 'http' | 'tcp' | 'none';
  latencyMs?: number;
  lastCheck?: number;
  lastError?: string;
  consecutiveFailures: number;
}

export interface MetricPoint {
  t: number;
  cpu: number; // percent of the whole machine
  mem: number; // bytes
  latency?: number; // ms of the last health check
}

export interface ServiceView {
  key: string; // "<workspaceId>/<service>"
  workspace: string;
  name: string;
  status: ServiceStatus;
  run: string;
  runs: string[]; // its commands across every mode (the panel guards against Claude running them by hand)
  cwd: string;
  port?: number;
  url?: string;
  pid?: number;
  image?: string;
  startedAt?: number;
  readyAt?: number;
  exitCode?: number | null;
  restarts: number;
  adopted: boolean;
  dependsOn: string[];
  group?: string;
  health: HealthInfo;
  cpu?: number;
  mem?: number;
  lastError?: string;
  openIncidents: number;
  /** Waiting for its dependencies before it is spawned. */
  queued?: boolean;
  /** Active mode ("default" = the plain config) and the ones it defines. */
  mode: string;
  modes: string[];
  /** One-shot tasks the service defines, and the one running now if any. */
  tasks: string[];
  task?: string;
}

export interface WorkspaceView {
  id: string;
  name: string;
  root: string;
  configPath: string;
  profiles: Record<string, string[]>;
  envProfile?: string;
  envProfiles: string[];
  configError?: string;
  services: ServiceView[];
  /** Workspace-wide mode ("default" unless switched) and every mode some service defines. */
  mode: string;
  modes: string[];
  /** Workspace-level task names, and the union of the services' task names. */
  tasks: string[];
  serviceTasks: string[];
  runningTasks: TaskRun[];
}

export type IncidentKind = 'crash' | 'start-failed' | 'unhealthy' | 'error-log' | 'memory' | 'port-conflict' | 'task-failed';

export interface TaskRun {
  id: string;
  workspace: string;
  service?: string;
  task: string;
  run: string;
  cwd: string;
  status: 'running' | 'ok' | 'failed' | 'cancelled';
  startedAt: number;
  endedAt?: number;
  exitCode?: number | null;
  /** Log stream the output went to: the service's, or "<workspace>/tasks". */
  logKey: string;
  /** Why it ran: by hand, or before a service start in some mode. */
  reason: 'manual' | 'before-start';
}

export interface Incident {
  id: string;
  at: number;
  key: string;
  workspace: string;
  service: string;
  kind: IncidentKind;
  severity: 'error' | 'warning';
  title: string;
  detail?: string;
  exitCode?: number | null;
  restart?: number;
  context: string[]; // log lines around the event
  count: number; // repeats folded into this incident
  resolvedAt?: number;
}

export interface LogLine {
  seq: number;
  t: number;
  stream: 'out' | 'err' | 'sys';
  text: string;
}

export interface Summary {
  version: string;
  pid: number;
  startedAt: number;
  workspaces: WorkspaceView[];
  incidents: Incident[]; // most recent first, open ones
}

export type DaemonEvent =
  | { type: 'status'; service: ServiceView }
  | { type: 'incident'; incident: Incident }
  | { type: 'metrics'; key: string; point: MetricPoint }
  | { type: 'log'; key: string; lines: LogLine[] }
  | { type: 'workspaces'; workspaces: string[] }
  | { type: 'task'; run: TaskRun };
