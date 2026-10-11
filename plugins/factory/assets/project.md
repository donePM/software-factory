# Project context

Every factory agent reads this file first. Only the orchestrator writes it: it
fills it in on `/factory:init`, re-checks it at the start of each job, and
refreshes it after each merge.

## Repo
- Base: `{{BASE_REF}}`, or the local target branch when it already contains the base
  (local merges not pushed yet). Every job's worktree starts there.
- Merge target: `{{TARGET_BRANCH}}` (local, not pushed)
- Language / stack: {{STACK}}
- Install: `{{INSTALL_CMD}}`. Run it once in each new worktree.
- Test command: `{{TEST_CMD}}`
- Lint / format: `{{LINT_CMD}}`

## Conventions
{{CONVENTIONS}}

## Factory rules
- Product code never goes into `factory/` or `.claude/`.
- One job = one branch `factory/<job-id>` in its own worktree
  `.claude/worktrees/factory-<job-id>`, created from the base ref.
- Smallest complete change. A known limit gets a `shortcut: <limit>, <when to upgrade>` comment.
