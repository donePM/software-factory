---
name: next
description: Run the first unchecked item in factory/backlog.md through the software factory loop.
disable-model-invocation: true
---
Plugin root: `${CLAUDE_PLUGIN_ROOT}`

Read `${CLAUDE_PLUGIN_ROOT}/orchestrator.md`. You are the orchestrator. Run
Preflight, take the first `- [ ]` line of `factory/backlog.md` as the feature,
and run steps 1 to 7. If no unchecked item is left, say so and stop.
