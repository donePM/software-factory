# Setup

`/factory:setup` prepares a repo for the factory.
Go back to [Home](Home).

## What setup does

1. It checks the tools: git, gh, the gh login, and the origin remote.
2. It writes `.factory/config.json` and the labels.
3. It runs a first gate check.

The first call shows a preview. Setup changes the repo only with `apply: true`.

## The wiki check

With the docs target `wiki`, setup also checks the wiki of the repo.

- When the wiki is off, setup turns it on with `gh repo edit --enable-wiki`.
  The preview shows this change as `enableWiki: true`.
  After the change, setup runs the wiki check again in the same call.
- When this change fails, the `Fix:` line names the settings page.
  You need admin rights to turn on the wiki.
- When the wiki repo does not exist yet, open the wiki and create the first page.
- Setup runs a dry-run push to the wiki. The push sends no objects and creates no ref.
  The check is red when git cannot push.
  Then run `gh auth status`. gh needs the `repo` scope, and you need write access.
- The dry-run push skips the pre-push hook.
  Thus a hook of the operator does not run on each setup call, and cannot make the check red.

Do the steps of the `Fix:` line in the browser. Then run `/factory:setup` again.

## Changes
- #134: turn on the GitHub wiki when the docs target is `wiki`.
- #138: check the push access to the wiki.
- #143: run the wiki push check with `--no-verify`.
