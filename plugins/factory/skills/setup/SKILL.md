---
name: setup
description: Set up the factory in this repo. Checks the tools, creates the config and labels, and runs a first gate check.
disable-model-invocation: true
---
Plugin root: `${CLAUDE_PLUGIN_ROOT}`

You guide the user through setup. Use plain words. The user may not be a developer.
Follow `${CLAUDE_PLUGIN_ROOT}/ste.md` for all text to the user.

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
   - When the preview has `askProject: true` and the user did not type `/factory:setup project`, also ask about the board.
     The question: "Show the factory tickets on a Kanban board in GitHub Projects? The board needs the `project` token scope. This scope gives write access to all your GitHub projects, not only this one."
     The answers: "No (recommended)" first, then "Yes".
   - When the preview has `askLanguage: true`, also ask for the ticket language.
     The question: "In which language must the factory write the tickets?"
     The answers: "English (recommended)" first. The user can type another language.
   - When the preview has `askDocs: true`, also ask for the docs target.
     The question: "Where must the factory write the docs?"
     The answers: "docs/ folder (recommended)" first, then "GitHub wiki", then "Ask later".
5. Call `mcp__factory__setup` with `apply: true`, plus `baseBranch` or `concurrency` if the user chose them. Tell the user what was created.
   - When the user typed `/factory:setup project`, pass `project: true` in steps 1 and 5.
   - When you asked about the board in step 4, pass the answer in step 5: `project: true` for "Yes", `project: false` for "No".
   - When you asked for the language in step 4, pass the answer as `language`, for example `language: "Deutsch"`. Pass `language: "English"` for "English (recommended)". With no answer, pass no `language`.
   - On a `language must be a short single-line name` error, ask for the language again. Use only letters, spaces, `(`, `)` and `-`.
   - When you asked for the docs target in step 4, pass `docs: "docs"` for "docs/ folder", `docs: "wiki"` for "GitHub wiki". For "Ask later", pass no `docs`.
   - When the report has `wiki` with `ok: false`, show its `detail` and its `fix`. The user must do these steps in the browser or in a terminal. Then they run `/factory:setup` again. The setup stays valid.
   - When the report has `project`, show its `url`, the count in `added`, each step of `viewSteps`, and each entry of `warnings`.
   - A warning with `gh auth refresh -s project` means that the token scope is missing. Tell the user to type `! gh auth refresh -s project` in this session. Then they run `/factory:setup` again.
   - Otherwise, only mention the board in one sentence: `/factory:setup project` shows the tickets on a Kanban board in GitHub Projects.
6. Start the first gate check. Never run it in this session.
   - Spawn the agent `factory:gate-runner` with `run_in_background: true`.
   - Give it only one path: `<root>/.factory/gate/setup`. Use the repo root as `<root>`.
   - Stay available while it runs. Answer questions from the user.
   - When the notification comes, report the result. A red result means: first make the project green, then start the factory.
7. Suggest a commit of `.factory/config.json` with the message `chore(factory): add factory config`. Commit only after the user agrees.

You can run setup again at any time. It repairs what is missing and migrates the config.
