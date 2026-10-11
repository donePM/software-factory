# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

The source of the `factory` Claude Code plugin plus a local marketplace
(`.claude-plugin/marketplace.json`) that publishes it. The plugin lives in
`plugins/factory/`. There's no build step and no product code: everything is
markdown, one HTML file, and two JSON manifests. `README.md` covers install and
usage. `INITIAL_PROMPT.md` holds the original design brief.

## Commands

```bash
claude plugin validate .                          # marketplace manifest
claude plugin validate plugins/factory            # plugin manifest
claude --plugin-dir plugins/factory               # load the plugin without installing
```

To test end to end, set up a throwaway repo with a bare `origin`, then run
`claude -p "/factory:init" --plugin-dir <abs>/plugins/factory` there, followed by
`/factory:run <tiny feature>`. Don't run the factory against this repo itself.

## Architecture

- `plugins/factory/orchestrator.md` holds the whole loop: Init, Preflight, steps 1
  to 7, Rework, and the `board.json` schema. The five skills (`/factory:init|run|next|approve|rework`)
  are thin entry points. Each passes `${CLAUDE_PLUGIN_ROOT}` and tells the session
  to read `orchestrator.md`, because Claude Code namespaces plugin skills: one skill
  named `factory` would be `/factory:factory`.
- `plugins/factory/agents/*.md` define one subagent per box. The orchestrator
  calls them as `factory:<name>`. Models and tools are set in their frontmatter.
- `plugins/factory/assets/` holds what `/factory:init` copies into a target repo:
  `dashboard.html` (always overwritten), and the `backlog.md` and `project.md`
  templates (`{{…}}` placeholders, filled in by inspecting the repo).

## Invariants (keep them when editing)

- Agents get context from files, never from the conversation. Spawn prompts
  pass only absolute paths to the job folder and round folder. The `## Job`
  section of each job's `feature.md` names the worktree, branch, and base sha.
- Each job builds in `.claude/worktrees/factory-<id>` on branch `factory/<id>`,
  created from the local default branch when it contains `origin/<default>`
  (it then holds unpushed factory merges), else from `origin/<default>`. Agents run commands in the worktree and write job
  files in the main checkout.
- Review files start with `VERDICT: PASS|CHANGES`. `decision.md` starts with
  `APPROVE|ESCALATE`. The orchestrator and `dashboard.html` both parse these
  first lines, so change them together.
- WAIT FOR ALL four review files before resuming `builder-<id>` via SendMessage.
- Merges are local `--no-ff` into the target branch, and the factory never pushes.
- Commit, code-style, and Simplified Technical English (STE) rules live in `agents/builder.md` (Code style, Commits)
  and are enforced in `agents/code-reviewer.md`. Change them in both places. The
  ticket comes from the feature text into `feature.md` (`- Ticket:`).
- Lean rules (ponytail-derived: option ladder, `shortcut:` comments, "no case, no
  finding") appear in builder, spec-writer, all reviewers, approver, and auditor.
  Keep them consistent when you change one.
