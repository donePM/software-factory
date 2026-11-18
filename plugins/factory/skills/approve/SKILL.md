---
name: approve
description: Record your approval of a finished factory job. Changes no label and merges nothing.
argument-hint: <issue-or-pr-number>
disable-model-invocation: true
---
Plugin root: `${CLAUDE_PLUGIN_ROOT}`
Number: $ARGUMENTS

Use plain words. The user may not be a developer.

1. Call the tool `mcp__factory__approve` with `number` set to the number above.
2. On success, say who approved and how:
   - `how` is `review`: the PR now has your approval review.
   - `how` is `comment`: GitHub does not allow approval of your own PR, so the approval is a comment on the issue.
   Then tell the user to run `/factory:merge <issue>` to merge. Name the `issue` from the result.
3. On an error, give the error text in one or two simple sentences. Then give its `Fix` line.
   - `no-pair`: the number is not a factory issue with a PR, or not a factory PR. Ask for the right number.
   - `not-reviewed`: no review ran on the current commit. Nothing was approved.
