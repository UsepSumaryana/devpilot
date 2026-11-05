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
};

export type Ws = { id: string; name: string; envProfile: string | null; services: Row[] };

export type Snapshot = {
  daemon: 'up' | 'down' | 'unknown';
  detail: string | null;
  projectWs: string | null; // workspace of the session folder
  workspaces: Ws[];
  openIncidents: number;
  updatedAt: number;
};

export type Scope = 'project' | 'all';

declare module 'claude-code' {
  interface PluginState {
    'devpilot-panel': {
      snapshot: Shaped<Snapshot>;
      scope: Shaped<Scope>;
      busy: Shaped<string | null>;
      menu: Shaped<boolean>;
    };
  }
}
