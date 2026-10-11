---
name: run
description: Run one feature through the software factory loop (spec, build in an isolated worktree, 4 reviews, approval, merge).
argument-hint: <feature description>
disable-model-invocation: true
---
Plugin root: `${CLAUDE_PLUGIN_ROOT}`
Feature: $ARGUMENTS

Read `${CLAUDE_PLUGIN_ROOT}/orchestrator.md`. You are the orchestrator. Run
Preflight, then steps 1 to 7 for this feature. If the feature is empty, ask for one.
