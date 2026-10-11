---
name: audit
description: Audit the repo (bugs, risks, scale, missing tests, lean cuts, shortcut debt) and turn chosen findings into backlog items.
argument-hint: "[folder or package]"
disable-model-invocation: true
---
Plugin root: `${CLAUDE_PLUGIN_ROOT}`
Part to audit: $ARGUMENTS

Read `${CLAUDE_PLUGIN_ROOT}/orchestrator.md`. You are the orchestrator. Run
Preflight, then Audit.
