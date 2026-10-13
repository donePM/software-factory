# Software Factory

A small, visual software factory for Claude Code. It is a plugin. Each feature
goes through a spec writer, a builder, four parallel reviewers, and an approver.
All coordination happens through markdown files, and the builder works in its own
git worktree. The worktree starts from local `main` when it contains `origin/main`
(so it sees earlier, unpushed factory merges), else from `origin/main`.

```mermaid
flowchart LR
  F(["Feature or ticket"]) --> S["spec-writer<br/><i>opus</i>"]
  S --> B["builder<br/><i>opus · own worktree</i>"]
  B --> SEC & UX & UI & CODE
  subgraph R ["4 reviewers in parallel · wait for all"]
    SEC["security<br/><i>opus</i>"]
    UX["ux<br/><i>sonnet</i>"]
    UI["ui<br/><i>sonnet</i>"]
    CODE["code<br/><i>sonnet</i>"]
  end
  SEC & UX & UI & CODE --> G{"all PASS?"}
  G -- "CHANGES<br/>max 2 fix rounds" --> B
  G -- "PASS" --> A["approver<br/><i>opus</i>"]
  A -- "APPROVE" --> M(["merge into main<br/>local, never pushed"])
  A -- "ESCALATE" --> H(["needs human"])
  H -- "Approve" --> M
  H -- "Rework + note" --> B

  classDef human fill:#fff4e0,stroke:#b45309,color:#1c1c1a
  classDef done fill:#e3f4ea,stroke:#1f8a4c,color:#1c1c1a
  class H human
  class M done
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
   `/factory:rework <job-id> <note>` to send it back to the builder. Or use the
   **Approve** and **Rework** buttons on the dashboard (see below).
6. **Check the whole repo.** `/factory:audit [part]` writes `factory/audit.md`
   with Must / Should / Nice findings. You pick the numbers to queue.
7. **Review a pull request.** `/factory:review <pr>` runs the 4 reviewers on a
   GitHub PR and writes a comment you can post (see below).
8. **Watch and steer it.** `python3 factory/serve.py`, then open
   http://localhost:8000/dashboard.html (see Dashboard).
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
| `/factory:loop [max]` | Runs the backlog until it is empty, up to 4 jobs at a time (Guide 2) |
| `/factory:inbox` | Handles the requests from the dashboard buttons |

### Dashboard

`python3 factory/serve.py [--port 8000]` serves `factory/` on 127.0.0.1 only.
The dashboard shows:
- a **Backlog** column with the open items of `factory/backlog.md`. **Start**
  sends an item to the spec writer.
- one column per step, and a **Needs human** lane on top. A card there shows the
  screenshots of the UI reviewer (click to enlarge), and **Approve** (merge) and
  **Rework…** (send a note to the builder) buttons.
- a drawer with every job file, when you click a card.

The buttons don't run anything themselves. They write one request per click
into `factory/inbox/`. A running `/factory:loop` picks them up after each step,
and also waits for them when only `needs-human` jobs are left. Otherwise run
`/factory:inbox`. Or let the server start a headless session for new requests:

```bash
python3 factory/serve.py --run -- --permission-mode acceptEdits
```

Arguments after `--` go to `claude -p "/factory:inbox"`. The headless session
can't answer permission prompts, so allow the git, test, and file commands in
your settings first. The server starts no session while another factory command
runs (`runner` in `board.json`), and logs to `factory/inbox/runner.log`.
`python3 -m http.server` in `factory/` still works, read-only and without buttons.

### Screenshots

The UI reviewer takes screenshots of changed screens (1280 and 390 wide) when it
can start the app and Playwright or Chrome is already installed. It installs
nothing. The files go to `factory/jobs/<id>/round-N/screenshots/`.

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

```mermaid
flowchart TD
  I(["Your idea"]) --> P["planner<br/><i>opus</i>"]
  P --> PM["factory/product.md<br/>stack · scope · slices"]
  PM --> C{"You confirm?"}
  C -- "change" --> P
  C -- "start" --> BL[("factory/backlog.md")]
  BL --> PAR["1 to 4 independent slices<br/>each runs the feature loop"]
  PAR --> MG["merge into main<br/>one at a time"]
  MG --> E{"Backlog empty?"}
  E -- "no" --> BL
  E -- "yes, first time" --> AU["audit<br/><i>opus</i>"]
  AU -- "Must fix findings" --> BL
  E -- "yes, audit done" --> D(["Report: what was built"])
  PAR -. "ESCALATE" .-> H(["needs human"])
  H -. "dashboard button<br/>or command" .-> PAR

  classDef human fill:#fff4e0,stroke:#b45309,color:#1c1c1a
  classDef done fill:#e3f4ea,stroke:#1f8a4c,color:#1c1c1a
  class H human
  class D done
```

The loop stops when nothing is left or at the job limit. When only
`needs-human` jobs are left, it waits up to 30 minutes for a dashboard button.

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
4. **Let it run.** The loop runs one slice per job, up to 10 jobs per run. It
   runs 2 to 4 jobs at the same time when slices don't need each other (the
   planner writes "Needs S<n>") and will not touch the same files. The
   orchestrator decides how many. The walking skeleton always runs alone.
   Merges happen one at a time. When a merge conflicts, the builder merges the
   new `main` into its branch and the reviewers check it again. A job that needs
   you only blocks the slices that need it. When the backlog is empty, the loop
   runs one audit and queues the Must fix findings without asking. When only
   `needs-human` jobs are left, it waits up to 30 minutes for a dashboard
   button. It stops when nothing is left or at the job limit.
5. **Unblock and go on.** Use the dashboard buttons while the loop waits. Or,
   after `/factory:approve` or `/factory:rework`, or to run more jobs, run
   `/factory:loop` (or `/factory:loop 20`).
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
.gitignore                         # managed block: board.json, jobs/, dashboard.html, serve.py, inbox/, audit.md, .claude/worktrees/
.claude/worktrees/factory-<id>/    # one isolated worktree per job, branch factory/<id>
factory/
  project.md                       # stack, test command, conventions (tracked)
  backlog.md                       # queue for /factory:next (tracked)
  idea.md                          # product idea and your plan feedback (tracked, product loop)
  product.md                       # product plan and slices (tracked, product loop)
  board.json                       # job state, drives the dashboard
  dashboard.html                   # copied from the plugin
  serve.py                         # dashboard server with buttons, copied from the plugin
  inbox/                           # button requests; done/ holds the handled ones
  jobs/<id>/                       # feature.md, spec.md, build.md, round-N/review-*.md, round-N/screenshots/, decision.md
  jobs/pr-<n>/                     # PR review: feature.md, round-N/review-*.md, review.md
  audit.md                         # latest /factory:audit report
```

## Plugin layout

```
.claude-plugin/marketplace.json
plugins/factory/
  .claude-plugin/plugin.json
  orchestrator.md                  # the whole loop: edit this to change the factory
  skills/{init,run,next,approve,rework,audit,import,review,product,loop,inbox}/SKILL.md   # thin entry points into orchestrator.md
  agents/*.md                      # one subagent per box (planner, spec-writer, builder, 4 reviewers, approver, auditor)
  assets/                          # dashboard.html, serve.py, backlog.md and project.md templates
```

`INITIAL_PROMPT.md` is the prompt this factory was built from. The lean rules
(planner, builder, reviewers, auditor) are adapted from [ponytail](https://github.com/DietrichGebert/ponytail) (MIT).
