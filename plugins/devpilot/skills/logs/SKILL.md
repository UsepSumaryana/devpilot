---
name: logs
description: Show and summarise the recent logs of a DevPilot service, optionally filtered.
argument-hint: "<service> [grep pattern] [since 10m] [tail 200]"
disable-model-invocation: true
---

Call the `mcp__devpilot-panel__logs` tool with `{ service, tail: 200 }` plus `grep`,
`since` or `stream` taken from the arguments (`$ARGUMENTS`).

Summarise: what the service is doing, warnings/errors with their first occurrence and
count, and anything abnormal. Quote the decisive lines verbatim. Do not dump the full
log unless the user asks; point to the Services pane's ≡ Logs (or `open_dashboard` with
the service) for live following.
