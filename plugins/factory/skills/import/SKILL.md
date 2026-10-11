---
name: import
description: Queue open GitHub issues or Jira tickets in factory/backlog.md for /factory:next.
argument-hint: <github|jira> <query>
disable-model-invocation: true
---
Plugin root: `${CLAUDE_PLUGIN_ROOT}`
Arguments: $ARGUMENTS (the first word is the source, the rest is the query)

Read `${CLAUDE_PLUGIN_ROOT}/orchestrator.md`. You are the orchestrator. Run
Preflight, then `/factory:import` from its **Tickets** section. If the source or
the query is missing, ask for it.
