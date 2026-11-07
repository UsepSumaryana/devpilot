/** One service row as the pane draws it (a trimmed copy of the daemon's ServiceView). */
export type Row = {
  key: string;
  name: string;
  status: string;
  port: number | null;
  url: string | null;
  health: string; // 'ok' | 'failing' | 'unknown' | 'none'
  latencyMs: number | null;
  cpu: number | null;
  memMb: number | null;
  restarts: number;
  exitCode: number | null;
  lastError: string | null;
  openIncidents: number;
  dependsOn: string[];
  group: string | null;
  queued: boolean;
  mode: string;
  modes: string[];
  task: string | null; // running one-shot task, if any
  tasks: string[]; // task names it defines
  cwd: string;
  run: string; // the command of its current mode
  runs: string[]; // its commands across every mode
  startedAt: number | null;
};

/** An incident shown as a card in the transcript (crash, failed start, unhealthy...). */
export type Card = {
  id: string; // the placed row's id
  incident: string;
  key: string;
  service: string;
  kind: string;
  title: string;
  exitCode: number | null;
  restart: number | null;
  excerpt: string[]; // last log lines of its context
  at: number;
  step: 'idle' | 'confirm' | 'asked' | 'restarting' | 'restarted';
};

/** Workspace CPU (percent of the machine) and memory (bytes) over the last 15 minutes. */
export type Usage = { ws: string | null; points: { t: number; cpu: number; mem: number }[]; at: number };

/** A running service whose source changed (Claude edited it) since it started. */
export type Changed = { key: string; name: string; files: string[]; at: number };

export type Ws = {
  id: string;
  name: string;
  envProfile: string | null;
  services: Row[];
  mode: string;
  modes: string[];
  tasks: string[]; // workspace-level
  serviceTasks: string[]; // union of the services' task names
  runningTasks: string[]; // "install", "build (api)"...
};

export type Snapshot = {
  daemon: 'up' | 'down' | 'unknown';
  detail: string | null;
  projectWs: string | null; // workspace of the session folder
  workspaces: Ws[];
  openIncidents: number;
  updatedAt: number;
};

export type Scope = 'project' | 'all';

/** An action waiting for the person's confirmation (two-step buttons). */
export type Confirm = {
  title: string;
  detail: string;
  label: string; // the confirm button
  danger: boolean;
  method: string;
  path: string;
  body: Record<string, unknown> | null;
  busy: string; // what the header says while it runs
};

declare module 'claude-code' {
  interface PluginState {
    'devpilot-panel': {
      snapshot: Shaped<Snapshot>;
      scope: Shaped<Scope>;
      busy: Shaped<string | null>;
      menu: Shaped<boolean>;
      confirm: Shaped<Confirm | null>;
      paneOpen: Shaped<boolean>;
      changed: Shaped<Changed[]>;
      restartAsk: Shaped<boolean>;
      cards: Shaped<Record<string, Card>>;
      usage: Shaped<Usage>;
    };
  }
}
