---
name: up
description: Start this project's services with DevPilot (a profile or specific services) and report what came up.
argument-hint: "[profile|service...]"
disable-model-invocation: true
---

Run `devpilot up $ARGUMENTS --wait --json`.

- If the project has no devpilot.yaml, say so and offer the `devpilot:setup` skill.
- Report each service's result in one line. For any failure, show its `reason`,
  `suggestion` and the decisive log lines, then offer to diagnose (`devpilot:diagnose`).
- End with the URLs of services that have one (`devpilot status --json` → `url`) and
  mention `devpilot open` for the dashboard.
