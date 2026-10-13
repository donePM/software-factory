# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

The source of the `factory` Claude Code plugin plus a local marketplace
(`.claude-plugin/marketplace.json`) that publishes it. The plugin lives in
`plugins/factory/`. There's no build step and no product code: everything is
markdown, one HTML file, one stdlib Python server, one sh launcher, and two JSON manifests. `README.md` covers install and
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
  to 7, Rework, Audit, PR review, Product, Parallel jobs, Inbox, Loop, Stop, Tickets, and the `board.json` schema. The skills
  (`/factory:init|run|next|approve|rework|audit|import|review|product|loop|inbox|stop`)
  are thin entry points. Each passes `${CLAUDE_PLUGIN_ROOT}` and tells the session
  to read `orchestrator.md`, because Claude Code namespaces plugin skills: one skill
  named `factory` would be `/factory:factory`.
- `plugins/factory/agents/*.md` define one subagent per box. The orchestrator
  calls them as `factory:<name>`. Models and tools are set in their frontmatter.
- Product loop: `factory:planner` turns `factory/idea.md` into `factory/product.md`
  (stack, allowed dependencies, ordered slices). After the human confirms, the
  slices go into `backlog.md` and Loop runs with no job limit until done or
  `/factory:stop` (a `stop` request in `factory/inbox/`). The planner and
  spec-writer cut small jobs with few needs; spec-writer's `## Split` items go
  into `backlog.md` as `Needs <id>` lines. spec-writer, builder, and approver
  read `product.md` when it exists.
- PR review: `/factory:review <pr>` runs the 4 reviewers on a detached worktree of
  the PR head (`- Mode: pr-review` in `feature.md`, no spec.md or build.md). The
  orchestrator writes `<job>/review.md`. Nothing goes back to GitHub.
- `plugins/factory/assets/` holds what `/factory:init` copies into a target repo:
  `dashboard.html`, `serve.py`, and the `dashboard` launcher (always overwritten), and the `backlog.md` and
  `project.md` templates (`{{…}}` placeholders, filled in by inspecting the repo).
- Dashboard buttons: `serve.py` (127.0.0.1 only) validates a click and writes
  `factory/inbox/<time>.json` (`approve|rework|start`). The orchestrator claims
  requests by moving them to `inbox/done/` (Inbox section). `serve.py --run`
  starts `claude -p "/factory:inbox"` when board `runner` is null or stale.
- Parallel: Loop and Inbox run up to 4 jobs; the orchestrator picks independent
  items (Parallel jobs section). Merges stay serial; a conflict resumes the
  builder once to merge the moved target, then reviews run again.

## Invariants (keep them when editing)

- Agents get context from files, never from the conversation. Spawn prompts
  pass only absolute paths to the job folder and round folder. The `## Job`
  section of each job's `feature.md` names the worktree, branch, and base sha.
- Each job builds in `.claude/worktrees/factory-<id>` on branch `factory/<id>`,
  created from the local default branch when it contains `origin/<default>`
  (it then holds unpushed factory merges), else from `origin/<default>`. Agents run commands in the worktree and write job
  files in the main checkout.
- `serve.py` never writes `board.json`, `backlog.md`, or job files: the
  orchestrator stays their only writer. Request JSON fields and board
  `runner`/`heartbeat` are shared by `serve.py`, `dashboard.html`, and the
  orchestrator: change them together.
- Screenshots: ui-reviewer writes `round-N/screenshots/*.png` and lists them as
  `![…](screenshots/…)` under `## Screenshots` in `review-ui.md`. The dashboard
  parses those image lines.
- Review files start with `VERDICT: PASS|CHANGES`. `decision.md` starts with
  `APPROVE|ESCALATE`. The orchestrator and `dashboard.html` both parse these
  first lines, so change them together.
- WAIT FOR ALL four review files before resuming `builder-<id>` via SendMessage.
- Merges are local `--no-ff` into the target branch, and the factory never pushes.
  Never `branch -D`. `worktree remove --force` only when the worktree has nothing but untracked files.
- Commit, code-style, and Simplified Technical English (STE) rules live in `agents/builder.md` (Code style, Commits)
  and are enforced in `agents/code-reviewer.md`. Change them in both places. The
  ticket comes from the feature text into `feature.md` (`- Ticket:`).
- Lean rules (ponytail-derived: option ladder, `shortcut:` comments, "no case, no
  finding") appear in builder, spec-writer, all reviewers, approver, and auditor.
  Keep them consistent when you change one.
