---
name: status
description: Show the status, health and recent incidents of this project's DevPilot services.
argument-hint: "[service] [--all]"
disable-model-invocation: true
---

Run `devpilot status $ARGUMENTS` and show its output to the user as is (it is a
formatted table). If there are open incidents, also run `devpilot incidents --open`
and summarise them in a sentence or two; offer `devpilot:diagnose` for the worst one.
