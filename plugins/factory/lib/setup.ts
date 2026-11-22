import { type SweepReport, sweep } from './cleanup.ts'
import { type Check, doctor, first, wikiCheck, wikiOn } from './doctor.ts'
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
  docs?: 'docs' | 'wiki'
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
  askDocs: boolean
  enableWiki: boolean
  wiki?: Check
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
  const empty = { created: false, enableWiki: false, migrated: [], standard: [], labels: 0, gitignore: false, sweep: { removed: [], kept: [], finished: [], docs: [] } }
  if (checks.some(c => !c.ok)) {
    const failed = checks.filter(c => !c.ok)
    const reason = `checks failed: ${failed.map(c => c.check).join(', ')}`
    return { checks, applied: false, reason, ...empty, next: failed.map(c => c.fix ?? c.detail), askProject: false, askLanguage: false, askDocs: false }
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
  const askDocs = !exists || cfg.docs === undefined
  if (input.concurrency !== undefined) cfg.concurrency = input.concurrency
  if (input.baseBranch !== undefined) cfg.baseBranch = input.baseBranch
  if (input.project !== undefined) cfg.project = { ...cfg.project, enabled: input.project }
  if (input.language !== undefined) cfg.language = input.language
  if (input.docs === 'docs') cfg.docs = { target: 'docs', path: cfg.docs?.path ?? 'docs/' }
  if (input.docs === 'wiki') cfg.docs = { target: 'wiki' }
  const repo = repoFromUrl(cfg.tracker.url)
  const enableWiki = cfg.docs?.target === 'wiki' && (await wikiOn(ctx, repo)) === false
  if (!input.apply) {
    const standard = await githubTracker(ctx, repo).applyStandard(false)
    return { checks, config: cfg, applied: false, ...empty, migrated, standard, labels: labelSet().length, next: ['Run setup again with apply true.'], askProject, askLanguage, askDocs, enableWiki }
  }

  const created = !exists
  if (created || JSON.stringify(cfg) !== stored) await writeConfig(ctx, cfg)
  const ignorePath = `${ctx.root}/.factory/.gitignore`
  if (!(await ctx.fs.exists(ignorePath)) || (await ctx.fs.read(ignorePath)) !== GITIGNORE) {
    await ctx.fs.write(ignorePath, GITIGNORE)
  }
  const tracker = githubTracker(ctx, repo)
  const labels = labelSet()
  await tracker.ensureLabels(labels)
  const standard = await tracker.applyStandard(true)
  const swept = await sweep(ctx, tracker)
  const next = ['Commit .factory/config.json (chore(factory): add factory config).', 'Run the gate once on the base branch.']
  const edit = enableWiki ? await ctx.run(['gh', 'repo', 'edit', repo, '--enable-wiki']) : undefined
  const wiki = edit !== undefined && edit.exitCode !== 0
    ? { check: 'wiki', ok: false, detail: `gh repo edit failed: ${first(edit.stderr)}`, fix: `You need admin rights to turn on the wiki. Open https://github.com/${repo}/settings and turn on Wikis. Then run setup again.` }
    : cfg.docs?.target === 'wiki' ? await wikiCheck(ctx, repo) : undefined
  if (wiki !== undefined && !wiki.ok && wiki.fix !== undefined) next.push(wiki.fix)
  const report = { checks, config: cfg, applied: true, created, migrated, standard, labels: labels.length, gitignore: true, sweep: swept, next, askProject, askLanguage, askDocs, enableWiki: edit?.exitCode === 0, wiki }
  if (cfg.project?.enabled !== true) return report
  const project = await connectProject(ctx, tracker, cfg.project.number)
  if (project.number !== undefined && project.number !== cfg.project.number) {
    cfg.project = { ...cfg.project, number: project.number }
    await writeConfig(ctx, cfg)
  }
  return { ...report, project }
}
