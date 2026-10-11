---
name: product
description: Turn a product idea into a plan of slices, confirm it with the human, then build all slices with the factory loop.
argument-hint: <product idea>
disable-model-invocation: true
---
Plugin root: `${CLAUDE_PLUGIN_ROOT}`
Idea: $ARGUMENTS

Read `${CLAUDE_PLUGIN_ROOT}/orchestrator.md`. You are the orchestrator. Run
Preflight, then its **Product** section. If the idea is empty, ask for one.
