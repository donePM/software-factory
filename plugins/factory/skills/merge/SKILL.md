---
name: merge
description: Merge the PR of an approved factory job. This call is your approval for the merge.
argument-hint: <issue-or-pr-number>
disable-model-invocation: true
---
Plugin root: `${CLAUDE_PLUGIN_ROOT}`
Number: $ARGUMENTS

Use plain words. The user may not be a developer.
Follow `${CLAUDE_PLUGIN_ROOT}/ste.md` for all text to the user.

1. Say in one sentence: "This call is your approval: the factory will sync the branch, run the gate and merge the PR."
2. Never call the tool `mcp__factory__merge` in this session. The gate can run a long time.
   - Spawn the agent `factory:merger` with `run_in_background: true`.
   - Give it only the job path and the issue number, one value on each line. Line 1 is `<root>/.factory/jobs/<issue>`. Line 2 is `<issue>`. Use the repo root as `<root>`. The prompt has no other text. Example:
     ```
     /repo/.factory/jobs/42
     42
     ```
   - If the number is a PR, ask the user for the issue number, or use the issue named by the PR.
3. Stay available while it runs. Answer questions from the user.
4. When the notification comes, report the result in simple words:
   - Success: the PR is merged with the merge commit SHA from the report, the issue is done, and the cleanup report lists what was removed and what was kept.
     Then name each other approved job from the report. The factory merged the base branch into each one.
     A job with a `conflict` entry is now in build. Tell the user to run `/factory:run <n>` for it. The builder resolves the conflict, then the reviews run again. At the round limit, the entry says `needs-human`. Tell the user to increase `maxRounds` in `.factory/config.json`, or to comment in the issue. Then the user runs `/factory:run <n>`.
     A job with a `failed` entry did not change. Its next `/factory:merge` syncs it.
     A `backlog-failed` entry has no job: the factory could not read the list of other jobs. The merge is still done. No other job was synced. The next `/factory:merge` syncs them.
   - Success with the state `docs`: the PR is merged, and the docs step follows. Tell the user to run `/factory:run`. It starts the documenter for the wiki page.
   - Error: give the error text and its `Fix` line.
     - `sync-conflict`: the branch conflicts with the base branch. The factory undid the merge. The job went back to build on its own, in a new round. Read `${CLAUDE_PLUGIN_ROOT}/pipeline.md` and follow it as `/factory:run <issue>`: start the builder. The builder merges the base branch, then the reviews run again. When the job is `approved` or `needs-human` again, tell the user to run `/factory:merge <issue>` again.
     - `sync-conflict-limit`: the branch conflicts with the base branch, and the job reached the round limit. The job is now `needs-human`. Tell the user to increase `maxRounds` in `.factory/config.json`, or to comment in the issue. Then the user runs `/factory:run <issue>`.
     - `sync-failed`: git could not merge the base branch, but there is no conflict. Nothing changed. Fix the git problem, then run `/factory:merge` again.
     - `not-reviewed`: the branch has commits that no review saw. Nothing was merged. Usually the job must go back to build for a new review. At the round limit, the `Fix` line names the step. Increase `maxRounds` in `.factory/config.json`. Then run `/factory:run <issue>`.
     - `gate-failed`: the gate is red after the sync. Nothing was merged. Fix the failures first.
     - `head-mismatch`: the branch changed during the merge, or GitHub did not show the pushed commit in time. Run `/factory:merge` again.
     - `gate-not-green`: the branch changed during the merge. Run `/factory:merge` again.
