# Docs step

The docs step keeps this wiki up to date after each merge.
Go back to [Home](Home).

## When it runs

Set `docs.target` to `wiki` in `.factory/config.json`.
Then the merge sets the job to `docs`, not `done`.
The merge closes the issue. The job still counts as running, and it takes a slot.

## Feature pages

The wiki has one page for each feature of the project.
`Home.md` is the index. It links every feature page.
A page describes the feature as it works now, not the issue.
Each feature page ends with a `## Changes` list with the issue numbers.

## How it works

1. `job_sync` clones the wiki into `<jobDir>/wiki`.
   The clone uses the gh login and never asks for a password.
2. The `documenter` agent reads the wiki pages and the merged diff.
3. It writes `docs.md`. The file has one `## Page <Name>.md` section for each changed page.
   It updates the feature pages that the change touches.
   It creates a page only when no page fits.
4. `job_advance` with `to: done` makes a new clone of the wiki.
   It writes the pages to that clone, not to the clone of the documenter.
   It deletes the old `Issue-<n>.md` pages.
   It pushes all changes in one commit `docs(wiki): document #<n>`.
5. The factory posts a `<!-- factory:docs -->` comment on the issue.
   The first line is `Docs:` and the links of the changed pages.
   The full `docs.md` text follows.
6. The factory sets `done` and cleans up.

A page name uses only letters, digits, and `-`, and ends in `.md`.
The factory refuses other names and the names `Issue-<n>.md`.

## Credentials

All wiki git calls get the credentials from gh.
An empty credential helper drops the helpers of the user first.
Git never prompts for a user name.

## Rebuild on another machine

The docs comment holds the full `docs.md` text.
When the job folder is missing, `job_sync` writes `docs.md` from this comment.
A docs job gets a new worktree from the base branch, because its PR is merged.
The pipeline then finishes the job without a new documenter run.
A comment with only the link line is not enough. Then the documenter runs again.

## A failed wiki step

A failed wiki git step sets `needs-human`. The merge stays.
The stop comment names the failed step, for example `clone` or `push`.
A failed clone or push adds a `Fix:` line.
`/factory:status` shows the closed job with the next step.
Fix the cause. Then run `/factory:run` without an issue number.
The sweep sets `docs` again, and the documenter runs again.

Two docs jobs can push at the same time. Then the second push fails, and the job goes to `needs-human`.

## Changes
- #133: rebuild `docs.md` from the docs comment.
- #137: show the retry step after a failed wiki push.
- #138: give the wiki git calls the gh credentials.
- #146: keep one page for each feature, and delete the `Issue-<n>` pages.
