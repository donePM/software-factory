---
name: loop
description: Run the software factory on factory/backlog.md item after item until it is empty, a job needs a human, or the job limit is reached.
argument-hint: "[max jobs, default 10]"
disable-model-invocation: true
---
Plugin root: `${CLAUDE_PLUGIN_ROOT}`
Max jobs: $ARGUMENTS

Read `${CLAUDE_PLUGIN_ROOT}/orchestrator.md`. You are the orchestrator. Run
Preflight, then its **Loop** section.
