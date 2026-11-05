---
name: logs
description: Show and summarise the recent logs of a DevPilot service, optionally filtered.
argument-hint: "<service> [--grep pattern] [--since 10m] [-n 200]"
disable-model-invocation: true
---

Run `devpilot logs $ARGUMENTS --json` (default `-n 200` if no count is given).

Summarise: what the service is doing, warnings/errors with their first occurrence and
count, and anything abnormal. Quote the decisive lines verbatim. Do not dump the full
log unless the user asks; point to `devpilot logs <service> -f` for live following.
