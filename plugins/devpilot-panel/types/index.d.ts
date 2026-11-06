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
    };
  }
}
