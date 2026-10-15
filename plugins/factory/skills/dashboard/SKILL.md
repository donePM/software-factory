---
name: dashboard
description: Start the factory dashboard server in the background with the inbox runner, so its buttons work. Opens the dashboard when the server already runs. "stop" stops it.
argument-hint: "[stop]"
disable-model-invocation: true
---
Plugin root: `${CLAUDE_PLUGIN_ROOT}`
Arguments: $ARGUMENTS

Read `${CLAUDE_PLUGIN_ROOT}/orchestrator.md`. Run only its **Dashboard** section.
Don't run Preflight.
