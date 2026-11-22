import { type SweepReport, sweep } from './cleanup.ts'
import { type Check, doctor } from './doctor.ts'
import { type Config, configPath, defaultConfig, LANGUAGE_ERROR, loadConfig, migrate, planMigration, validLanguage, writeConfig } from './config.ts'
import { FactoryError } from './exec.ts'
import { detectAll } from './stacks/index.ts'
import { githubTracker, repoFromUrl } from './github.ts'
import { labelSet } from './labels.ts'
import type { Migration } from './migrations/index.ts'
import { connectProject, type ProjectReport } from './project.ts'
import type { StandardCheck } from './tracker.ts'
import type { Ctx } from './types.ts'

export type SetupInput = {
  apply: boolean
  baseBranch?: string
  concurrency?: number
  migrations?: Migration[]
  project?: boolean
  language?: string
}
export type SetupReport = {
  checks: Check[]
  config?: Config
  applied: boolean
  reason?: string
  created: boolean
  migrated: string[]
  standard: StandardCheck[]
  labels: number
  gitignore: boolean
  sweep: SweepReport
  next: string[]
  askProject: boolean
  askLanguage: boolean
  project?: ProjectReport
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
  if (input.language !== undefined && !validLanguage(input.language)) throw new FactoryError('bad-input', LANGUAGE_ERROR)
  const stacks: Config['stacks'] = (await detectAll(ctx, ctx.root).catch(() => [])) // doctor reports a failed detection
    .map(d => ({ id: d.stack, path: d.path }))
  const checks = await doctor(ctx, stacks)
  const empty = { created: false, migrated: [], standard: [], labels: 0, gitignore: false, sweep: { removed: [], kept: [], finished: [] } }
  if (checks.some(c => !c.ok)) {
    const failed = checks.filter(c => !c.ok)
    const reason = `checks failed: ${failed.map(c => c.check).join(', ')}`
    return { checks, applied: false, reason, ...empty, next: failed.map(c => c.fix ?? c.detail), askProject: false, askLanguage: false }
  }

  const path = configPath(ctx.root)
  const exists = await ctx.fs.exists(path)
  let migrated: string[] = []
  let cfg: Config
  if (!exists) {
    cfg = defaultConfig(await originUrl(ctx), input.baseBranch ?? (await defaultBranch(ctx)), stacks)
  } else if (input.apply) {
    migrated = (await migrate(ctx, input.migrations)).applied
    cfg = await loadConfig(ctx)
  } else {
    const plan = await planMigration(ctx, input.migrations)
    cfg = plan.config
    migrated = plan.applied
  }
  const stored = JSON.stringify(cfg)
  const askProject = !exists || cfg.project === undefined
  const askLanguage = !exists || cfg.language === undefined
  if (input.concurrency !== undefined) cfg.concurrency = input.concurrency
  if (input.baseBranch !== undefined) cfg.baseBranch = input.baseBranch
  if (input.project !== undefined) cfg.project = { ...cfg.project, enabled: input.project }
  if (input.language !== undefined) cfg.language = input.language
  if (!input.apply) {
    const standard = await githubTracker(ctx, repoFromUrl(cfg.tracker.url)).applyStandard(false)
    return { checks, config: cfg, applied: false, ...empty, migrated, standard, labels: labelSet().length, next: ['Run setup again with apply true.'], askProject, askLanguage }
  }

  const created = !exists
  if (created || JSON.stringify(cfg) !== stored) await writeConfig(ctx, cfg)
  const ignorePath = `${ctx.root}/.factory/.gitignore`
  if (!(await ctx.fs.exists(ignorePath)) || (await ctx.fs.read(ignorePath)) !== GITIGNORE) {
    await ctx.fs.write(ignorePath, GITIGNORE)
  }
  const tracker = githubTracker(ctx, repoFromUrl(cfg.tracker.url))
  const labels = labelSet()
  await tracker.ensureLabels(labels)
  const standard = await tracker.applyStandard(true)
  const swept = await sweep(ctx, tracker)
  const next = ['Commit .factory/config.json (chore(factory): add factory config).', 'Run the gate once on the base branch.']
  const report = { checks, config: cfg, applied: true, created, migrated, standard, labels: labels.length, gitignore: true, sweep: swept, next, askProject, askLanguage }
  if (cfg.project?.enabled !== true) return report
  const project = await connectProject(ctx, tracker, cfg.project.number)
  if (project.number !== undefined && project.number !== cfg.project.number) {
    cfg.project = { ...cfg.project, number: project.number }
    await writeConfig(ctx, cfg)
  }
  return { ...report, project }
}
