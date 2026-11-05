---
name: setup
description: Set up DevPilot for a project that has no devpilot.yaml — detect its services (Node, Python, Go, Java, Rust, .NET, Docker Compose, Procfile), draft the config with the user, write and register it. Also imports an existing jsrunner setup.
argument-hint: "[folder]"
---

# Set up DevPilot for a project

Folder: `$ARGUMENTS` (default: the current project).

1. `devpilot init <folder> --json` — dry run. It returns `services[]` (with `runtime`,
   `confidence`, `note`) and a drafted `yaml`. Nothing is written yet.
2. Review the draft against the repo before showing it:
   - check `run` commands against package.json scripts / README / Makefile,
   - fill missing `port`s (look at .env, framework config, `listen(` calls),
   - add `health: { http: <path> }` when the app has a health endpoint,
   - add `depends_on` (e.g. api → database), and `profiles` for common subsets,
   - for slow starters without a port, use `ready: { log: "<line printed when ready>" }`.
3. Show the user the proposed `devpilot.yaml` and ask for confirmation.
4. Write the agreed file to `<folder>/devpilot.yaml` (or run `devpilot init --write`
   if the draft is fine as is), then `devpilot register <folder> --json`. A config
   error comes back in `error` — fix and re-register.
5. Offer to start it: `devpilot up --wait --json`, then summarise `devpilot status`.
6. Mention: `devpilot open` opens the dashboard. To skip Bash permission prompts for
   DevPilot commands the user can allow `Bash(devpilot:*)` in their Claude settings —
   offer to add that only if they want it.

## Migrating from jsrunner

`devpilot import-jsrunner --json` (dry run; `--from <projects.json>` if it is not in
`~/.jsrunner/config`). It writes one workspace per jsrunner group under
`~/.devpilot/imported/`, with absolute paths, so the user's repos are untouched.
Confirm, then run it again with `--write`.

Reference for every field: `devpilot help config`.
