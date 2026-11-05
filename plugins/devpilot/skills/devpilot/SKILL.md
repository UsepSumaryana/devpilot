---
name: devpilot
description: Run, stop, monitor and troubleshoot this project's local dev services (APIs, frontends, workers, databases via docker compose — any runtime) with the `devpilot` CLI. Use whenever the user wants to start/stop/restart services or "the app", check whether something is running, read service logs, see crashes or errors, find what holds a port, switch env profiles, or when a `[devpilot]` monitor notification arrives. Prefer this over launching dev servers yourself with background Bash.
---

# DevPilot

A per-user daemon supervises the services declared in the project's `devpilot.yaml`.
You drive it with the `devpilot` CLI through Bash. **Always add `--json`** when you
need to read the result; the human-readable form is for showing the user.

Services keep running after this session ends. The user watches the same state in
the web dashboard (`devpilot open`) and the Claude desktop panel.

## Commands

| Goal | Command |
|---|---|
| What is running / health / CPU / restarts | `devpilot status --json` (one service: `devpilot status api --json`) |
| Start everything (profile `default`) | `devpilot up --wait --json` |
| Start a profile or some services | `devpilot up backend --wait --json`, `devpilot up api web --wait --json` |
| Start / stop / restart one | `devpilot start api --wait --json`, `devpilot stop api`, `devpilot restart api --wait --json` |
| Stop the whole workspace | `devpilot down` |
| Logs | `devpilot logs api -n 200 --json`, `--grep "error\|warn"`, `--since 10m`, `--stream err` |
| What went wrong | `devpilot incidents --open --json`, `devpilot diagnose api --json` |
| Resource history | `devpilot metrics api --range 1h --json` |
| Env | `devpilot env api --json` (secrets masked), `devpilot env use staging --restart` |
| Modes (watch vs built output…) | `devpilot mode --json`; `devpilot mode use build --restart`; one service: `devpilot mode use build api --restart` or `devpilot start api --mode build --wait --json`; back: `devpilot mode reset --restart` |
| One-shot tasks (install, build, migrate) | `devpilot task --json` lists them; `devpilot task run install api` (follows output, exit code = task's); every service: `devpilot task run install --all` |
| Ports | `devpilot ports --json`; `devpilot ports kill 3000 --force` (see rules) |
| No devpilot.yaml yet | use the `devpilot:setup` skill |
| Config reference | `devpilot help config` |

`--wait` blocks until the service is ready (health check / log pattern) and, on
failure, returns `reason`, `suggestion` and the last log lines — read those before
anything else. Services are named as in `devpilot.yaml`; from another folder use
`<workspace>/<service>` or `--ws <workspace>`.

## Rules

- Start services through DevPilot, not with `npm run dev &` / background Bash, so they
  are supervised, logged and visible to the user.
- When a service defines a task for what you need (install, build, migrate), run it with
  `devpilot task run <task> <service>` rather than the raw command: its output lands in the
  service log the user watches, and `stop_service` tasks free files the service holds.
- A mode switch changes how a service runs for the user too: do it when asked, and say
  which services restart.
- Never kill a process you did not start. `devpilot ports kill … --force` only after the
  user agreed to stop that specific PID (show them name and command line first).
- `devpilot down` / `unregister` stop the user's running services: only when asked.
- Editing `devpilot.yaml` is fine when the user asks for a config change; the daemon
  reloads it automatically. Changes to `run`/`env` apply on the next restart.

## When a `[devpilot]` notification arrives

A monitor streams lines like `[devpilot] ERROR <workspace>/<service>: crashed (exit code 1) | <context> | details: devpilot diagnose … --json`.

1. Tell the user briefly what happened (service, what, when it matters).
2. Run the `diagnose` command it names (`--json`) to get the verdict and evidence.
3. Offer a diagnosis and the fix you would make. **Do not edit code, change config or
   restart services on your own** in response to a notification — wait for the user to
   say so.
4. `[devpilot] OK … recovered` needs no action beyond a short mention if relevant.

For deeper triage follow the `devpilot:diagnose` skill.
