---
name: review
description: Review a GitHub pull request with the four factory reviewers. Read-only, nothing is posted to GitHub.
argument-hint: <pr number or url>
disable-model-invocation: true
---
Plugin root: `${CLAUDE_PLUGIN_ROOT}`
Pull request: $ARGUMENTS

Read `${CLAUDE_PLUGIN_ROOT}/orchestrator.md`. You are the orchestrator. Run
Preflight, then its **PR review** section. If no pull request is given, ask for one.
