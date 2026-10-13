---
name: inbox
description: Handle the requests from the factory dashboard buttons (approve, rework, start a backlog item) in factory/inbox/.
disable-model-invocation: true
---
Plugin root: `${CLAUDE_PLUGIN_ROOT}`

Read `${CLAUDE_PLUGIN_ROOT}/orchestrator.md`. You are the orchestrator. Run
Preflight, then `/factory:inbox` from its **Inbox** section. If the inbox is
empty, say so and stop.
