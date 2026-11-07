---
name: up
description: Start this project's services with DevPilot (a profile or specific services) and report what came up.
argument-hint: "[profile|service...]"
disable-model-invocation: true
---

Start with the `mcp__devpilot-panel__up` tool: no arguments → `{}`; a profile name →
`{ profile }`; service names → `{ services: [...] }`. Arguments: `$ARGUMENTS`.

- If the project has no devpilot.yaml, say so and offer the `devpilot:setup` skill.
- Report each service's result in one line. For any failure, show its `reason`,
  `suggestion` and the decisive log lines, then offer to diagnose (`devpilot:diagnoser`).
- End with the URLs of services that have one (`status` tool → `url`) and mention the
  Services pane and `open_dashboard` for the dashboard.
