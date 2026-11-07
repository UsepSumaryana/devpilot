---
name: devpilot
description: Run, stop, monitor and troubleshoot this project's local dev services (APIs, frontends, workers, databases via docker compose — any runtime) with the DevPilot tools (mcp__devpilot-panel__*). Use whenever the user wants to start/stop/restart services or "the app", check whether something is running, read service logs, see crashes or errors, find what holds a port, switch modes or env profiles, run install/build tasks, or when a `[devpilot]` monitor notification arrives. Prefer this over launching dev servers yourself with background Bash.
---

# DevPilot

A per-user daemon supervises the services declared in the project's `devpilot.yaml`.
You drive it with the **DevPilot tools** (`mcp__devpilot-panel__<name>`), never with the
`devpilot` CLI through Bash: a Bash `devpilot …` command is refused and names the tool to
use. Tools not listed yet are loaded with ToolSearch, e.g. `select:mcp__devpilot-panel__tasks`.
The tools start the daemon on demand and register the project's devpilot.yaml on first use.

Services keep running after this session ends. The user watches the same state in the
Services pane beside the chat and in the web dashboard (`open_dashboard`).

## Tools

| Goal | Tool (input) |
|---|---|
| What is running / health / CPU / restarts / URL | `status` (`{}`; one: `{ service: "api" }`; every workspace: `{ all: true }`) |
| Start everything (profile `default`) or a profile | `up` (`{}`, `{ profile: "backend" }`, `{ services: ["api", "web"] }`, `{ mode: "build" }`) |
| Start / restart / stop one | `start` / `restart` (`{ service }`, wait until ready by default), `stop` (`{ service }`) |
| Stop the whole workspace, or some services | `down` (`{}` or `{ services: [...] }`) |
| Logs | `logs` (`{ service, tail: 200, grep: "error|warn", since: "10m", stream: "err" }`) |
| What went wrong | `incidents` (`{ open: true }`), `diagnose` (`{ service }`) |
| Resource history | `metrics` (`{ service, range: "1h" }`) |
| Env | `env` (`{ service }`, secrets masked), `set_env` (`{ profile: "staging", restart: true }`) |
| Modes (watch vs built output…) | `status` shows each service's `mode` and `modes`; `set_mode` (`{ mode: "build", restart: true }`, one service: `{ mode, services: ["api"], restart: true }`; back: `{ mode: "default", restart: true }`); or `start` with `{ service, mode }` |
| One-shot tasks (install, build, migrate) | `tasks` lists them; `run_task` (`{ task: "install", service: "api" }`, workspace task: `{ task }`, every service: `{ task, all: true }`); waits and returns status and output |
| Ports | `ports`; `kill_port` (`{ port, pid }`, see rules) |
| Mark incidents resolved | `clear_incidents` (`{ service }` or `{}`) |
| No devpilot.yaml yet | the `devpilot:setup` skill (`detect`, then `register`) |
| Daemon | `daemon` (`{ action: "restart" }`; services keep running) |
| Dashboard | `open_dashboard` (`{}` or `{ service }`) |

Waiting tools return `ok`, and on failure `reason`, `suggestion` and the last log lines;
read those before anything else. Services are named as in `devpilot.yaml`; from another
folder use `<workspace>/<service>`.

## Rules

- Start services through DevPilot, not with `npm run dev &` / background Bash, so they
  are supervised, logged and visible to the user. (The pane refuses a managed service's own
  command run by hand.)
- When a service defines a task for what you need (install, build, migrate), use
  `run_task` rather than the raw command: its output lands in the service log the user
  watches, and `stop_service` tasks free files the service holds.
- A mode or env switch changes how services run for the user too: do it when asked, and
  say which services restart.
- Never kill a process you did not start. `kill_port` only after the user agreed to stop
  that specific PID (show them name and command line from `ports` first).
- `down` / `unregister` stop the user's running services: only when asked.
- Editing `devpilot.yaml` is fine when the user asks for a config change; the daemon
  reloads it automatically. Changes to `run`/`env` apply on the next restart.

## When a `[devpilot]` notification arrives

A monitor streams lines like `[devpilot] ERROR <workspace>/<service>: crashed (exit code 1) | <context> | details: mcp__devpilot-panel__diagnose (service …)`.

1. Tell the user briefly what happened (service, what, when it matters).
2. Investigate with the read-only `devpilot:diagnoser` agent (or the `diagnose` tool for a
   quick look) and relay its cause and proposed fix.
3. **Do not edit code, change config or restart services on your own** in response to a
   notification; wait for the user to say so.
4. `[devpilot] OK … recovered` needs no action beyond a short mention if relevant.

For deeper triage follow the `devpilot:diagnose` skill.
