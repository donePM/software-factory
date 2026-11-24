---
name: reject
description: End a factory job that waits for you, with a reason. Closes the PR and the issue.
argument-hint: <issue> <reason>
disable-model-invocation: true
---
Plugin root: `${CLAUDE_PLUGIN_ROOT}`
Arguments: $ARGUMENTS

Use plain words. The user may not be a developer.
Follow `${CLAUDE_PLUGIN_ROOT}/ste.md` for all text to the user.

1. The first word of the arguments is the issue number. The other words are the reason.
   If the number or the reason is missing, ask for it. Do not call a tool yet.
2. Call the tool `mcp__factory__job_sync` with `issue` set to the issue number.
3. Call the tool `mcp__factory__job_advance` with `issue` set to the issue number, `to: rejected`, and `reason` set to the reason.
   Use the words of the user as the reason. Do not change them.
4. On success, say that the job is rejected. The issue has the reason as a comment.
   The PR is closed, and the remote branch is deleted. The issue is closed as not planned.
   Then name each path in `kept` of the `cleanup` report. Give its reason and its command.
   A kept branch has commits that are not on GitHub. The command shows them.
5. On an error, give the error text in one or two simple sentences. Then give its `Fix` line.
   - `illegal-transition`: only a job in `needs-human`, `approved`, or `needs-info` can be rejected here.
   - `reason-required`: the reason is empty. Ask for a reason.
