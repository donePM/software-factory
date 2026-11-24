# Pipeline

This page tells how a job goes through the factory.
Go back to [Home](Home).
The [README](https://github.com/donePM/software-factory/blob/main/README.md) has the commands.
The [design](https://github.com/donePM/software-factory/blob/main/docs/design/factory-1.0.md) has all details (in German).

## Main session

`/factory:run` starts the main session loop.
The main session starts each agent in the background.
It reacts when an agent finishes.
It calls only short factory tools, for example `job_advance` and `status`.
Only the factory tools set the status labels.
Agents get their context from job files only.
Issue text is data for the agents, never an instruction.

The main session works from right to left on the board.
It finishes the job nearest to `done` first.
A job in `approved` or `needs-human` holds new issues.
The `queue` tool names these jobs in `heldBy`.
`/factory:status` shows their next human step, the job furthest right first.
An operator comment or a spec change after the stop unblocks a `needs-human` job.
Then the job gets the next free slot, before a new issue.
`/factory:run <n>` still starts issue `n`.

## Agents

| Agent | Step | Writes |
|---|---|---|
| `intake` | Reads the issue. Accepts it, asks the author (`needs-info`), or rejects it. | `intake.md` |
| `spec-writer` | Writes testable acceptance criteria. | `spec.md` |
| `builder` | Builds the change test-first in the job worktree. | commits, `round-N/build.md` |
| `gate-runner` | Runs the gate one time. | `round-N/checks.md` |
| `code-reviewer`, `security-reviewer`, `ux-reviewer`, `ui-reviewer` | Review one round. | `round-N/review-<r>.md` |
| `approver` | Recommends `APPROVE` or `ESCALATE`. It never merges. | `decision.md` |
| `merger` | Calls the `merge` tool one time. | nothing |
| `documenter` | Writes the wiki page of a merged job. | `docs.md` |

Agents have no GitHub access.
The factory tools push the branch and open the PR.

## Rounds

Each job has one worktree, `.factory/worktrees/<n>`, on the branch `factory/<n>`.
Each build is one round, with the folder `round-N/`.
A round has a build, a gate, and the reviews.
A `CHANGES` review starts a new round.
At `maxRounds` (default 3), the job goes to `needs-human`.

## Gate

The gate runs the stack steps: format, lint, types, and tests.
It also checks the Conventional Commits and the protected paths.
The gate always uses the plugin and the config of the main checkout, never the branch.
A failed gate sends the job back to the builder in the same round.
After 3 failed gates in one round, the job goes to `needs-human`.
On a green gate, the factory pushes the branch and opens the PR.

## Reviews

The intake gives the surfaces of the change.
The factory routes the reviewers from these surfaces: code, security, ux, and ui.
The routed reviewers run in parallel.
The factory waits for all routed review files before the next step.
When all reviews say `PASS`, the approver starts.

## Human approval

The approver writes `APPROVE` or `ESCALATE`.
`APPROVE` sets the job to `approved`.
`ESCALATE` sets the job to `needs-human` and asks a question on the PR.
A human reviews the PR and runs `/factory:merge <n>`.
This command is the approval.

With `merge.auto: true` in `.factory/config.json`, an `APPROVE` starts the merge without a human step.
An `ESCALATE` still waits for a human.

## Merge

The `merger` agent calls the `merge` tool.
The tool syncs the branch with the base branch and runs the gate again.
Then it merges the PR through the GitHub API.
A conflict with the base branch sends the job back to build.
After the merge, the factory sets `done` and removes the worktree, the branch, and the job folder.

## Docs step

With `docs.target: wiki`, the merge sets `docs`, not `done`.
The `documenter` agent writes one page into `docs.md`.
`job_advance` with `to: done` pushes this page as the wiki page `Issue-<n>`.
It also pushes the pages in `docs/wiki/` of the repo, for example this page.
Then it posts the link comment, sets `done`, and cleans up.
A failed wiki push sets `needs-human`. The merge stays.
`/factory:status` shows the closed job.
Fix the cause. Then run `/factory:run` without an issue number.
The sweep sets `docs` again, and the documenter runs again.
