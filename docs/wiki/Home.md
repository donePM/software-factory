# Software Factory

The software factory is a Claude Code plugin with the name `factory`.
Your GitHub issues are its work queue.
Agents write a spec, build the change test-first, and review it.
The factory opens a pull request (PR) for each job.
A human approves and merges the PR.

- [Pipeline](Pipeline): how a job goes through the factory.
- [Setup](Setup): how `/factory:setup` prepares a repo, and the wiki check.
- [Status](Status): the running and waiting jobs in `/factory:status`.
- [Docs step](Docs-Step): how the factory keeps this wiki up to date.
- [README](https://github.com/donePM/software-factory/blob/main/README.md): install, commands, and safety notes.
- [Design](https://github.com/donePM/software-factory/blob/main/docs/design/factory-1.0.md): the full design (in German).

## Install

Install the plugin from the marketplace `donePM/software-factory`:

```
/plugin install factory --marketplace donePM/software-factory
```

Then open your project in Claude Code and run `/factory:setup`.
The README gives the steps for Claude Desktop and for updates.

## Commands

| Command | What it does |
|---|---|
| `/factory:setup` | Checks the tools, writes `.factory/config.json` and the labels, and runs a first gate check. |
| `/factory:add <todos>` | Makes issues from free text, one issue for each piece of work. |
| `/factory:run [n]` | Starts the ready issues, or only issue `n`. |
| `/factory:status` | Shows the free slots and the ready, running, and waiting jobs. |
| `/factory:approve <n>` | Records your approval on the PR. It merges nothing. |
| `/factory:merge <n>` | Syncs the branch, runs the gate, and merges the PR. |

## Job states

Each job has one `factory:<state>` label on its issue.
This label is the only place for the job state.

| State | Meaning | Next states |
|---|---|---|
| (no state) | The issue is in the backlog. | `intake` |
| `intake` | The intake agent reads the issue. | `spec`, `needs-info`, `rejected`, `needs-human` |
| `needs-info` | The factory waits for an answer from the author. | `intake` |
| `spec` | The spec writer writes the spec. | `build`, `needs-human` |
| `build` | The builder and the gate run. | `review`, `needs-human` |
| `review` | The reviewers run. | `build`, `approved`, `needs-human` |
| `approved` | The approver said yes. The PR waits for a human to merge. | `build`, `done`, `needs-human` |
| `needs-human` | The job stopped. It waits for a human. | `build`, `done`, `needs-human` |
| `docs` | The documenter updates the feature pages of the wiki. | `done`, `needs-human` |
| `done` | The job is finished. | none |
| `rejected` | The intake rejected the issue. | none |

`fastlane` and `needs-design` are labels for later. They are not in use now.
A merged PR can move a running job to `done` or `docs`.

## Project board

The board is optional. `/factory:setup` asks one time if you want it.
The board is a GitHub project with the single-select field `Factory`.
The factory moves each issue to the column of its state:

| Column | States |
|---|---|
| Backlog | no state |
| Intake | `intake` |
| Spec | `spec` |
| Design | `needs-design` |
| Build | `build`, `fastlane` |
| Review | `review` |
| Waiting | `needs-info`, `needs-human` |
| Ready to merge | `approved` |
| Docs | `docs` |
| Done | `done` |
| Rejected | `rejected` |

The board needs the `project` token scope.

## Feature pages

The wiki has one page for each feature, not one page for each issue.
Each finished job updates the pages of the features that it changes.
This page links every feature page.

## Changes
- #87: add the start page and the pipeline page.
- #146: link the feature pages, not the job pages.
