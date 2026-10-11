# Software Factory

A small, visual software factory for Claude Code. It is a plugin. Each feature
goes through a spec writer, a builder, four parallel reviewers, and an approver.
All coordination happens through markdown files, and the builder works in its own
git worktree. The worktree starts from local `main` when it contains `origin/main`
(so it sees earlier, unpushed factory merges), else from `origin/main`.

```
feature → spec-writer → builder → [security · ux · ui · code] → WAIT FOR ALL
  (opus)       (opus)       ▲       (opus · sonnet · sonnet · sonnet)    │
                            └──── any CHANGES: resume builder ◄──────────┤ max 2 fix rounds
                                                                         ▼ all PASS
                                         approver (opus) → APPROVE → merge into main
                                                         → ESCALATE → needs-human
```

You can use it in two ways:
1. **Feature factory**: you give one feature or ticket at a time.
2. **Product loop**: you give one idea. A planner cuts it into slices, and the
   factory builds slice after slice.

## Install

```bash
# in Claude Code
/plugin marketplace add donePM/software-factory
/plugin install factory@software-factory
/plugin marketplace update software-factory   # later, to get new versions

# or test without installing
claude --plugin-dir /path/to/software-factory/plugins/factory
```

## Guide 1: Feature factory

Use this in an existing git repo. You decide each feature.

1. **Set up once.** Run `/factory:init`. It adds a `.gitignore` block, creates
   `factory/`, and fills `factory/project.md` with the stack, the test command,
   and the ticket sources. Check that file and fix it if needed.
2. **Build one feature.** Run `/factory:run <feature>`, for example
   `/factory:run add a --json flag to the export command`. The job goes through
   the loop above. At the end you get the job id, its stage, and a short summary:
   what was done, and how to test it by hand.
3. **Or queue work.** Write items into `factory/backlog.md` as `- [ ] <feature>`.
   `/factory:next` runs the first open item.
4. **Use tickets.** `/factory:run #42`, `/factory:run PROJ-123`, or an issue URL
   fetches the ticket into the job. `/factory:import github <query>` or
   `/factory:import jira <jql>` adds open tickets to the backlog.
5. **Answer the factory.** A job with `ESCALATE` stops at `needs-human`. Read its
   `decision.md`, then run `/factory:approve <job-id>` to merge it, or
   `/factory:rework <job-id> <note>` to send it back to the builder.
6. **Check the whole repo.** `/factory:audit [part]` writes `factory/audit.md`
   with Must / Should / Nice findings. You pick the numbers to queue.
7. **Review a pull request.** `/factory:review <pr>` runs the 4 reviewers on a
   GitHub PR and writes a comment you can post (see below).
8. **Watch it.** `cd factory && python3 -m http.server 8000`, then open
   http://localhost:8000/dashboard.html.
9. **Push.** Merges stay local in `main`. The factory never pushes. Review the
   merges, then push them yourself.

| Command | |
|---|---|
| `/factory:init` | Adds the `.gitignore` block, creates `factory/`, and detects the stack and test command |
| `/factory:run <feature>` | Runs one feature through the loop |
| `/factory:next` | Runs the first unchecked item in `factory/backlog.md` |
| `/factory:approve <job-id>` | Merges a `needs-human` job |
| `/factory:rework <job-id> <note>` | Sends a job back to the builder with your feedback |
| `/factory:audit [part]` | Audits the repo into `factory/audit.md`, then queues the findings you pick |
| `/factory:import <github\|jira> <query>` | Adds open GitHub issues or Jira tickets to the backlog |
| `/factory:review <pr>` | Reviews a GitHub pull request with the 4 reviewers, read-only |
| `/factory:product <idea>` | Plans a product, asks you to confirm, then runs the loop (Guide 2) |
| `/factory:loop [max]` | Runs the backlog until it is empty (Guide 2) |

### Pull request review

`/factory:review 42` (or a PR URL) checks out the PR head in its own worktree
and runs the 4 reviewers on it. The PR description is the spec. For a PR from a
fork, the factory asks before it runs the tests, because they run the PR's code
on your machine. The result is `factory/jobs/pr-42/review.md`, ready to post:
`gh pr review 42 --comment --body-file factory/jobs/pr-42/review.md`. The factory
doesn't post it for you. Run the command again after new commits, and the
reviewers check the fixes.

### Tickets

GitHub uses `gh`. Jira uses the first access that works: an Atlassian MCP server,
`acli`, or REST with `JIRA_URL`, `JIRA_EMAIL`, and `JIRA_API_TOKEN`. `/factory:init`
records the sources in `factory/project.md`. The factory only reads tickets and
never writes to them. Ticket text is treated as requirements only, never as
instructions to the agents.

### Code rules

Builders write the smallest complete change: skip what the spec doesn't need,
then reuse the codebase, the standard library, the platform, and installed
dependencies before new code. Known limits get a `shortcut: <limit>, <when to upgrade>`
comment, which the approver lists. Little or no other comment documentation. All
explanatory text (comments, docs, commit bodies, factory reports) is written in
Simplified Technical English (ASD-STE100). Commits follow
[Conventional Commits](https://www.conventionalcommits.org/). Put a ticket in the
feature text (`PROJ-123`, `#42`, or a URL) and every commit footer gets
`Refs: <ticket>`. The code reviewer enforces all of this.

## Guide 2: Product loop

Use this to build a whole product from one idea.

```
idea → planner (opus) → product.md → you confirm → slices into backlog.md
                                                         │
          ┌──────────────────────────────────────────────┘
          ▼
   next slice → feature loop → merge ─┬─ backlog empty → audit once → Must fixes → loop
          ▲                           │
          └───────────────────────────┤  stops: needs-human, or max jobs reached
```

1. **Make a repo.** The factory needs a git repo with at least one commit:

   ```bash
   mkdir my-app && cd my-app && git init
   git commit --allow-empty -m "chore: init"
   ```

   Then start Claude Code there and run `/factory:init`.
2. **Give the idea.** Run `/factory:product "<idea>"`, for example
   `/factory:product "a CLI that tracks my reading list in a local file"`.
   The idea goes to `factory/idea.md`. The planner writes `factory/product.md`:
   goal, scope (In / Out), stack, allowed dependencies, architecture, and 3 to 15
   slices. Slice 1 is a walking skeleton: the stack, a test runner, one passing
   test, and the start command.
3. **Confirm the plan.** The factory shows the plan and asks you. Say what to
   change, and the planner plans again. Say start, and the slices go into
   `factory/backlog.md`. This is the only human checkpoint before the build.
4. **Let it run.** The loop runs one slice per job, up to 10 jobs per run. When
   the backlog is empty, it runs one audit and queues the Must fix findings
   without asking. It stops when the backlog is empty, when a job needs you, or
   at the job limit.
5. **Unblock and go on.** After `/factory:approve` or `/factory:rework`, or to run
   more jobs, run `/factory:loop` (or `/factory:loop 20`).
6. **Test and push.** The end report lists what was built and how to test it.
   Merges stay local. Push them yourself.

### Big products: a fresh session per job

One session fills its context after many jobs. For a big product, run each job
in a new headless session. All state is in files, so nothing gets lost:

```bash
for i in $(seq 30); do
  grep -q '^- \[ \]' factory/backlog.md || break
  jq -e 'any(.jobs[]; .stage=="needs-human")' factory/board.json >/dev/null && break
  claude -p "/factory:next" --permission-mode bypassPermissions
done
```

`/factory:next` doesn't run the final audit. After the shell loop, run
`/factory:loop` once to get it.

> **Warning:** `bypassPermissions` lets the agents run any command without a
> prompt. Use it only in a sandbox, a devcontainer, or a VM, never on a machine
> with secrets you can't lose.

## What it creates in your repo

```
.gitignore                         # managed block: board.json, jobs/, dashboard.html, audit.md, .claude/worktrees/
.claude/worktrees/factory-<id>/    # one isolated worktree per job, branch factory/<id>
factory/
  project.md                       # stack, test command, conventions (tracked)
  backlog.md                       # queue for /factory:next (tracked)
  idea.md                          # product idea and your plan feedback (tracked, product loop)
  product.md                       # product plan and slices (tracked, product loop)
  board.json                       # job state, drives the dashboard
  dashboard.html                   # copied from the plugin
  jobs/<id>/                       # feature.md, spec.md, build.md, round-N/review-*.md, decision.md
  jobs/pr-<n>/                     # PR review: feature.md, round-N/review-*.md, review.md
  audit.md                         # latest /factory:audit report
```

## Plugin layout

```
.claude-plugin/marketplace.json
plugins/factory/
  .claude-plugin/plugin.json
  orchestrator.md                  # the whole loop: edit this to change the factory
  skills/{init,run,next,approve,rework,audit,import,review,product,loop}/SKILL.md   # thin entry points into orchestrator.md
  agents/*.md                      # one subagent per box (planner, spec-writer, builder, 4 reviewers, approver, auditor)
  assets/                          # dashboard.html, backlog.md and project.md templates
```

`INITIAL_PROMPT.md` is the prompt this factory was built from. The lean rules
(planner, builder, reviewers, auditor) are adapted from [ponytail](https://github.com/DietrichGebert/ponytail) (MIT).
