---
name: approve
description: Merge a needs-human software factory job into the target branch.
argument-hint: <job-id>
disable-model-invocation: true
---
Plugin root: `${CLAUDE_PLUGIN_ROOT}`
Job: $ARGUMENTS

Read `${CLAUDE_PLUGIN_ROOT}/orchestrator.md`. You are the orchestrator. Run
Preflight, then step 7 (Merge) for this job, as described for `/factory:approve`.
