---
name: diagnose
description: Triage a DevPilot service that crashed, will not start, is unhealthy, is slow or leaks memory — gather evidence with the DevPilot tools and explain the cause and fix without changing anything. Use after a `[devpilot]` ERROR/WARN notification or when the user asks why a service is down.
argument-hint: "[service]"
---

# Diagnose a DevPilot service

Goal: a short, evidence-based explanation of **what is wrong, why, and the fix**, then
let the user decide. Read-only: do not edit files, change config or restart anything
until the user asks.

Service: `$ARGUMENTS` (if empty, pick from the `incidents` tool with `{ open: true }`, or ask).

For anything beyond a quick look, delegate to the read-only `devpilot:diagnoser` agent
with the service name and relay its report. Done yourself, the steps are:

1. `mcp__devpilot-panel__diagnose` `{ service }`: `verdict`, `findings[]` (each with
   `suggestion`), `errorBlock`, `dependencies`, `portHolder`, `missingEnv`, `lastIncident`.
2. If the error block points into the code (stack frame with a file:line in this repo),
   open that file and read around the line.
3. Only if still unclear:
   - `logs` `{ service, tail: 300 }` (or `grep`, `since: "15m"`, `stream: "err"`),
   - `incidents` `{ service }` to see whether it is new or recurring,
   - `metrics` `{ service, range: "1h" }` for memory growth / CPU spikes,
   - `status` for dependencies, `ports` for conflicts,
   - `env` `{ service }` for configuration (secret values are masked; never open `.env`
     files to see them).
4. Report to the user:
   - **Cause**: one or two sentences, citing the decisive log line / finding.
   - **Fix**: the concrete change (code diff, config change, command) you propose.
   - **Confidence** and what would confirm it.
5. Ask before applying. After the user agrees and you changed something, verify with
   `restart` `{ service }` (it waits until ready) and check `status` / `logs` again.

## Common causes (from `findings`)

- Port already in use: another process; show `portHolder` (name + command), never kill
  it without explicit consent (`kill_port` with its pid, after they agreed).
- Missing module / dependency: run the service's install task (`run_task`), or install in
  its `cwd` with its package manager.
- `ECONNREFUSED`: a dependency is down or not ready; check `dependencies`, consider
  `depends_on` in devpilot.yaml.
- Missing env vars vs `.env.example`: add to the env file listed in devpilot.yaml.
- Crash loop with `gave up after N restarts`: the root cause is in the first crash's
  error block, not the later ones.
