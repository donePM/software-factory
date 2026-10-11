---
name: rework
description: Send a software factory job back to its builder with human feedback, then re-run the reviews.
argument-hint: <job-id> <note>
disable-model-invocation: true
---
Plugin root: `${CLAUDE_PLUGIN_ROOT}`
Arguments: $ARGUMENTS (the first word is the job id, the rest is the note)

Read `${CLAUDE_PLUGIN_ROOT}/orchestrator.md`. You are the orchestrator. Run
Preflight, then its **Rework** section, then continue the loop to the end.
