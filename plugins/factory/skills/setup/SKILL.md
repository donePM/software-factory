---
name: setup
description: Set up the factory in this repo. Checks the tools, creates the config and labels, and runs a first gate check.
disable-model-invocation: true
---
Plugin root: `${CLAUDE_PLUGIN_ROOT}`

You guide the user through setup. Use plain words. The user may not be a developer.

1. Call the tool `mcp__factory__setup` with `apply: false`. This writes nothing.
2. Read the `checks`. For each check with `ok: false`, explain the problem in one or two simple sentences. Then give its `fix`.
   - Run an install command only after the user agrees.
   - A command that starts with `!` is for the user to type. Tell them to type it in this session.
   - After a fix, call `mcp__factory__doctor` again.
3. When all checks are green, show the user:
   - The `config` preview: tracker URL, base branch, concurrency.
   - The detected stacks. The list can be empty for now.
   - Each `standard` entry with `ok: false`. These are repo settings that differ from the factory standard.
4. Ask with `AskUserQuestion`. Put the recommended answer first and add "(recommended)" to it. Ask whether to apply the setup. Ask about concurrency only if the user wants to change it. The default is 4.
5. Call `mcp__factory__setup` with `apply: true`, plus `baseBranch` or `concurrency` if the user chose them. Tell the user what was created.
6. Start the first gate check. Never run it in this session.
   - Spawn the agent `factory:gate-runner` with `run_in_background: true`.
   - Give it only one path: `<root>/.factory/gate/setup`. Use the repo root as `<root>`.
   - Stay available while it runs. Answer questions from the user.
   - When the notification comes, report the result. A red result means: first make the project green, then start the factory.
7. Suggest a commit of `.factory/config.json` with the message `chore(factory): add factory config`. Commit only after the user agrees.

You can run setup again at any time. It repairs what is missing and migrates the config.
