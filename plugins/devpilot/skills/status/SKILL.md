---
name: status
description: Show the status, health and recent incidents of this project's DevPilot services.
argument-hint: "[service] [all]"
disable-model-invocation: true
---

Call the `mcp__devpilot-panel__status` tool (`{ service }` for one service, `{ all: true }`
for every workspace; arguments: `$ARGUMENTS`) and show the user a compact table: service,
status, health, port/URL, CPU, memory, restarts. If there are open incidents, call the
`incidents` tool with `{ open: true }` and summarise them in a sentence or two; offer the
`devpilot:diagnoser` agent for the worst one.
