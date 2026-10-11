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

## Install

```bash
# in Claude Code
/plugin marketplace add /path/to/software-factory
/plugin install factory@software-factory

# or test without installing
claude --plugin-dir /path/to/software-factory/plugins/factory
```

## Use (in any git repo)

| Command | |
|---|---|
| `/factory:init` | Adds the `.gitignore` block, creates `factory/`, and detects the stack and test command |
| `/factory:run <feature>` | Runs one feature through the loop |
| `/factory:next` | Runs the first unchecked item in `factory/backlog.md` |
| `/factory:approve <job-id>` | Merges a `needs-human` job |
| `/factory:rework <job-id> <note>` | Sends a job back to the builder with your feedback |
| `/factory:audit [part]` | Audits the repo into `factory/audit.md`, then queues the findings you pick |
| `/factory:import <github\|jira> <query>` | Adds open GitHub issues or Jira tickets to the backlog |

Dashboard: `cd factory && python3 -m http.server 8000` → http://localhost:8000/dashboard.html

Merges stay local; the factory never pushes.

Builders write the smallest complete change: skip what the spec doesn't need,
then reuse the codebase, the standard library, the platform, and installed
dependencies before new code. Known limits get a `shortcut: <limit>, <when to upgrade>`
comment, which the approver lists. Little or no other comment documentation. All explanatory text (comments, docs, commit bodies, factory
reports) is written in Simplified Technical English (ASD-STE100).
Commits follow [Conventional Commits](https://www.conventionalcommits.org/). Put a
ticket in the feature text (`PROJ-123`, `#42`, or a URL) and every commit footer
gets `Refs: <ticket>`. The code reviewer enforces all of this.

## Tickets

`/factory:run #42`, `/factory:run PROJ-123`, or an issue URL fetches the ticket into
the job's `feature.md`. GitHub uses `gh`. Jira uses the first access that works: an
Atlassian MCP server, `acli`, or REST with `JIRA_URL`, `JIRA_EMAIL`, and
`JIRA_API_TOKEN`. `/factory:init` records the sources in `factory/project.md`. The
factory only reads tickets and never writes to them.

At the end of each job, `decision.md` has a short summary: what was done, and how
to test it by hand.

## What it creates in your repo

```
.gitignore                         # managed block: board.json, jobs/, dashboard.html, audit.md, .claude/worktrees/
.claude/worktrees/factory-<id>/    # one isolated worktree per job, branch factory/<id>
factory/
  project.md                       # stack, test command, conventions (tracked)
  backlog.md                       # queue for /factory:next (tracked)
  board.json                       # job state, drives the dashboard
  dashboard.html                   # copied from the plugin
  jobs/<id>/                       # feature.md, spec.md, build.md, round-N/review-*.md, decision.md
  audit.md                         # latest /factory:audit report
```

## Plugin layout

```
.claude-plugin/marketplace.json
plugins/factory/
  .claude-plugin/plugin.json
  orchestrator.md                  # the whole loop: edit this to change the factory
  skills/{init,run,next,approve,rework,audit,import}/SKILL.md   # thin entry points into orchestrator.md
  agents/*.md                      # one subagent per box in the loop
  assets/                          # dashboard.html, backlog.md and project.md templates
```

`INITIAL_PROMPT.md` is the prompt this factory was built from. The lean rules
(builder, reviewers, auditor) are adapted from [ponytail](https://github.com/DietrichGebert/ponytail) (MIT).
