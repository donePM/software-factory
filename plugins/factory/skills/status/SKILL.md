---
name: status
description: Show the factory status. Lists free slots, ready, running and waiting jobs, and the next command for each.
disable-model-invocation: true
---
Plugin root: `${CLAUDE_PLUGIN_ROOT}`

Use plain words. The user may not be a developer.
Follow `${CLAUDE_PLUGIN_ROOT}/ste.md` for all text to the user.

1. Call the tool `mcp__factory__status`.
2. Show the text of the result unchanged. Do not add to it or reformat it.
3. On an error, give the error text in one or two simple sentences. Then give its `Fix` line.
