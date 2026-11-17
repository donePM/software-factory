import { type Check, doctor } from './doctor.ts'
import { type Config, configPath, defaultConfig, loadConfig, migrate, writeConfig } from './config.ts'
import { githubTracker, repoFromUrl } from './github.ts'
import { labelSet } from './labels.ts'
import type { Migration } from './migrations/index.ts'
import type { StandardCheck } from './tracker.ts'
import type { Ctx } from './types.ts'

export type SetupInput = { apply: boolean; baseBranch?: string; concurrency?: number; migrations?: Migration[] }
export type SetupReport = {
  checks: Check[]
  config: Config
  created: boolean
  migrated: string[]
  standard: StandardCheck[]
  labels: number
  gitignore: boolean
  next: string[]
}

export const GITIGNORE = '*\n!.gitignore\n!config.json\n!checks.local.ts\n'

async function originUrl(ctx: Ctx): Promise<string> {
  const r = await ctx.run(['git', 'remote', 'get-url', 'origin'])
  return r.stdout.trim().replace(/\.git$/, '')
}

async function defaultBranch(ctx: Ctx): Promise<string> {
  const r = await ctx.run(['git', 'symbolic-ref', 'refs/remotes/origin/HEAD'])
  const name = r.stdout.trim().replace(/^refs\/remotes\/origin\//, '')
  return r.exitCode === 0 && name !== '' ? name : 'main'
}

export async function setup(ctx: Ctx, input: SetupInput): Promise<SetupReport> {
  const stacks: Config['stacks'] = [] // Task 7 adds stack detection.
  const checks = await doctor(ctx, stacks)
  const empty = { created: false, migrated: [], standard: [], labels: 0, gitignore: false }
  if (checks.some(c => !c.ok)) {
    const fixes = checks.filter(c => !c.ok).map(c => c.fix ?? c.detail)
    return { checks, config: defaultConfig('', 'main', stacks), ...empty, next: fixes }
  }

  const path = configPath(ctx.root)
  const exists = await ctx.fs.exists(path)
  let migrated: string[] = []
  let cfg: Config
  if (!exists) {
    cfg = defaultConfig(await originUrl(ctx), input.baseBranch ?? (await defaultBranch(ctx)), stacks)
    if (input.concurrency !== undefined) cfg.concurrency = input.concurrency
  } else if (input.apply) {
    migrated = (await migrate(ctx, input.migrations)).applied
    cfg = await loadConfig(ctx)
  } else {
    cfg = JSON.parse(await ctx.fs.read(path)) as Config
  }
  if (!input.apply) return { checks, config: cfg, ...empty, next: ['Run setup again with apply true.'] }

  const created = !exists
  if (created) await writeConfig(ctx, cfg)
  const ignorePath = `${ctx.root}/.factory/.gitignore`
  if (!(await ctx.fs.exists(ignorePath)) || (await ctx.fs.read(ignorePath)) !== GITIGNORE) {
    await ctx.fs.write(ignorePath, GITIGNORE)
  }
  const tracker = githubTracker(ctx, repoFromUrl(cfg.tracker.url))
  const labels = labelSet(cfg)
  await tracker.ensureLabels(labels)
  const standard = await tracker.applyStandard(true)
  const next = ['Commit .factory/config.json (chore(factory): add factory config).', 'Run the gate once on the base branch.']
  return { checks, config: cfg, created, migrated, standard, labels: labels.length, gitignore: true, next }
}
