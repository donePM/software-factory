# Set up the factory

This guide takes you from an empty start to the first finished ticket.
You do not need to be a developer. Do the steps in this order.

## 1. What you need first

Setup checks these items for you. It shows the fix for each item that is missing.

| Item | Check | Fix |
|---|---|---|
| `git` | `git --version` | `brew install git` |
| GitHub CLI `gh` | `gh --version` | `brew install gh` |
| A GitHub login | `gh auth status` | `gh auth login --web` |
| The `repo` scope of the login | `gh auth status` shows `Token scopes` | `gh auth refresh -s repo` |
| The `origin` remote, a GitHub URL | `git remote get-url origin` | `git remote add origin <GitHub URL>` |

Setup also checks the tools of your project, for example `node` or `tsc`.
For each missing tool, setup shows the install command.
Setup runs an install command only after you agree.

In Claude Code, you can type a shell command with `!` in front, for example `! gh auth login --web`.

## 2. Install the plugin

In Claude Code in the terminal, type:

```
/plugin install factory --marketplace donePM/software-factory
```

From a shell, you can also run `claude plugin install factory --marketplace donePM/software-factory`.

In Claude Desktop (Code tab):

1. Click **+** next to the prompt box, then **Plugins**.
2. Click **Add marketplace** and enter `donePM/software-factory`.
3. Click **Add plugin** for `factory`.

## 3. Run `/factory:setup`

Open your project in Claude Code and type `/factory:setup`.

1. **Preview.** Setup first writes nothing. It shows the checks, the planned config, and the repo settings that differ from the factory standard.
2. **Questions.** Setup asks whether to apply the setup. On the first run, it also asks about the project board (see step 5). The recommended answer is first.
3. **Apply.** Setup then writes these items:
   - `.factory/config.json`: the settings of the factory. Commit this file.
   - `.factory/.gitignore`: it keeps the job folders and worktrees out of git.
   - The `factory` labels on GitHub. One label per issue shows the state of the job.
   - The repo standard on GitHub: merge commits only, and the branch is deleted after a merge.
4. **Setup gate.** Setup runs the gate one time on your base branch. The gate runs the format, lint, type check, and test steps of your project. A red result means: make your project green first, then start the factory.

At the end, commit the config: `git add .factory/config.json`, then `git commit -m "chore(factory): add factory config"`.
Setup asks you before it makes this commit.

You can run `/factory:setup` again at any time. It repairs what is missing and updates an old config.

## 4. The main settings

The settings are in `.factory/config.json`. Change them in a text editor, then commit the file.

| Setting | What it does | Default |
|---|---|---|
| `concurrency` | The number of jobs that run at the same time | `4` |
| `maxRounds` | The number of build rounds per job before a human must decide | `3` |
| `baseBranch` | The branch that the factory starts from and merges into | the default branch of `origin` |
| `protectedPaths` | Files that a job must not change. A change in these files fails the gate | the config and `.factory/checks.local.ts` |
| `routing` | The reviewers and their models for each risk level: `low`, `medium`, `high` | `code` always, `security` for `high` |
| `surfaces` | More reviewers for each type of change, for example `ui` or `api` | `ux` and `ui` for UI work, `security` for `api` |

The models are `haiku`, `sonnet`, `opus`, and `fable`. The reviewers are `code`, `security`, `ux`, and `ui`.

## 5. The project board (optional)

The factory can show the tickets on a Kanban board in GitHub Projects.
The board is a mirror only. The labels stay the truth.

**The token scope.** The board needs the `project` scope of your GitHub login.
This scope gives write access to all your GitHub projects, not only this one.
To add the scope, type `! gh auth refresh -s project` in Claude Code.

**Turn it on.** On the first run, setup asks about the board. The recommended answer is "No".
Setup saves your answer in `project.enabled`, so it does not ask again.
To turn the board on later, type `/factory:setup project`.
When the scope is missing, setup finishes and shows a warning with the fix command.
Add the scope, then run `/factory:setup` again.

**What setup creates.** Setup creates a project, or uses the one in `project.number`.
It adds the field `Factory` with one option for each state.
Then it adds each open factory ticket with its current state.
After that, the tools update the `Factory` field each time they change a status label.
A board problem never stops a job. It shows as a line in `warnings` in the tool result.
Commit `.factory/config.json` after this step, because it now holds `project.number`.

**The board view.** GitHub cannot create the view from the command line. Setup shows these clicks:

1. Open the project URL that setup shows.
2. Click "New view" and select "Board".
3. Open the view menu. Set "Column by: Factory".
4. Click "Save".

**Turn it off.** Set `project.enabled` to `false` in `.factory/config.json` and commit the file.
The project on GitHub stays. Delete it on GitHub if you do not need it.

## 6. The first ticket

1. **Add work.** Type `/factory:add <what you want>`, for example `/factory:add add a --json flag to the export command`.
   The factory writes one issue for each piece of work. It creates the issues after you agree.
2. **Run.** Type `/factory:run`. The factory starts the ready issues in the background.
   Each job goes through intake, spec, build, gate, and review. The factory opens a pull request.
   Type `/factory:status` at any time to see each job and its next step.
3. **Approve.** Read the pull request. Then type `/factory:approve <n>`. This records your approval. It merges nothing.
4. **Merge.** Type `/factory:merge <n>`. The factory syncs the branch, runs the gate, and merges the pull request.
   Then it closes the job and removes its local files.

`<n>` is the issue number or the pull request number.

## 7. After a Claude Code update

A project that is a Claude plugin with a `tsconfig.json` type-checks against the engine types of Claude Code.
The gate copies these types from the current Claude Code version.
After an update of Claude Code, these types are not there yet.
Then the setup check `engine types` is red, and the type check step of the gate fails.

To fix it, open the `plugin-authoring` skill one time in the new Claude Code version.
Then run `/factory:setup` again.

To get a new version of the factory, type `/plugin marketplace update software-factory`.
