---
name: setup
description: Set up DevPilot for a project that has no devpilot.yaml — detect its services (Node, Python, Go, Java, Rust, .NET, Docker Compose, Procfile), draft the config with the user, write and register it. Also imports an existing jsrunner setup.
argument-hint: "[folder]"
---

# Set up DevPilot for a project

Folder: `$ARGUMENTS` (default: the current project).

1. `mcp__devpilot-panel__detect` `{ path }` (path optional): returns `services[]` (with
   `runtime`, `confidence`, `note`), a drafted `yaml`, `existing` (a config already there)
   and `reference` (every devpilot.yaml field). Nothing is written.
2. Review the draft against the repo before showing it:
   - check `run` commands against package.json scripts / README / Makefile,
   - fill missing `port`s (look at framework config, `listen(` calls; not secret files),
   - add `health: { http: <path> }` when the app has a health endpoint,
   - add `depends_on` (e.g. api → database), and `profiles` for common subsets,
   - for slow starters without a port, use `ready: { log: "<line printed when ready>" }`,
   - `tasks` for install/build/migrate, `modes` (e.g. `build`) when the user runs built output.
3. Show the user the proposed `devpilot.yaml` and ask for confirmation.
4. Write the agreed file to `<folder>/devpilot.yaml` with the Write tool, then
   `register` `{ path }`. A config error comes back in `error`: fix and register again.
5. Offer to start it with `up`, then summarise `status`.
6. Mention the Services pane beside the chat and `open_dashboard` for the dashboard.

## Migrating from jsrunner

This one-off import is the only step that has no tool: ask the user to run
`devpilot import-jsrunner` (dry run) and then `devpilot import-jsrunner --write` in a
terminal. It writes one workspace per jsrunner group under `~/.devpilot/imported/`, with
absolute paths, so their repos are untouched.
