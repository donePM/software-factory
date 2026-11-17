import { loadConfig } from './config.ts'
import { FactoryError, must } from './exec.ts'
import { renderIssue } from './issue-file.ts'
import { stateOf } from './labels.ts'
import { findMarked, stripMarker } from './markers.ts'
import {
  branchName, fieldOf, jobDir, parseBase, parsePr, parseRoute, parseSpecUpdated, readJob, worktreeDir, writeJob,
  type Job,
} from './jobfile.ts'
import type { Tracker } from './tracker.ts'
import type { Ctx, State } from './types.ts'

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim()

async function ok(ctx: Ctx, argv: string[]): Promise<boolean> {
  return (await ctx.run(argv)).exitCode === 0
}

// Restore order: on origin, then a local branch, then a new branch from `start`.
async function ensureWorktree(ctx: Ctx, wt: string, branch: string, start: string): Promise<void> {
  if (await ctx.fs.exists(wt)) return
  if (await ok(ctx, ['git', 'ls-remote', '--exit-code', '--heads', 'origin', branch])) {
    await must(ctx, ['git', 'fetch', 'origin', branch])
    await must(ctx, ['git', 'worktree', 'add', wt, branch])
  } else if (await ok(ctx, ['git', 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])) {
    await must(ctx, ['git', 'worktree', 'add', wt, branch])
  } else {
    await must(ctx, ['git', 'worktree', 'add', '-b', branch, wt, start])
  }
}

export async function jobCreate(ctx: Ctx, t: Tracker, n: number): Promise<Job> {
  const operator = await t.login()
  const ticket = await t.get(n)
  const from = stateOf(ticket.labels)
  await t.setState(n, 'intake') // refuses illegal moves before any git call
  const resume = from === 'needs-info'
  const cfg = await loadConfig(ctx)
  const dir = jobDir(ctx.root, n)
  const wt = worktreeDir(ctx.root, n)
  const branch = branchName(n)
  const origin = `origin/${cfg.baseBranch}`

  let old: Job | null = null
  if (resume && (await ctx.fs.exists(`${dir}/job.md`))) {
    try {
      old = await readJob(ctx, n)
    } catch (err) {
      if (!(err instanceof FactoryError)) throw err
    }
  }
  let base = old?.base ?? 'none'
  if (old === null || base === 'none' || !(await ctx.fs.exists(wt))) {
    await must(ctx, ['git', 'fetch', 'origin', cfg.baseBranch])
    if (old === null || base === 'none') base = await must(ctx, ['git', 'rev-parse', origin])
    await ensureWorktree(ctx, wt, branch, origin)
  }
  const job: Job = {
    issue: n,
    title: oneLine(ticket.title),
    jobDir: dir,
    worktree: wt,
    branch,
    base,
    baseBranch: cfg.baseBranch,
    pr: old?.pr ?? null,
    round: old?.round ?? 0,
    specUpdated: old?.specUpdated ?? null,
    route: old?.route ?? {},
  }
  await writeJob(ctx, job)
  await ctx.fs.write(`${dir}/issue.md`, renderIssue(ticket, operator))
  return job
}

export type SyncResult = { job: Job; state: State | null; rebuilt: string[]; specChanged: boolean }

function dropSections(text: string, names: string[]): string {
  const out: string[] = []
  let skip = false
  for (const line of text.split(/\r\n|\r|\n/)) {
    if (line.startsWith('## ')) skip = names.includes(line.slice(3).trim())
    if (!skip) out.push(line)
  }
  return `${out.join('\n').trimEnd()}\n`
}

async function mergeBase(ctx: Ctx, baseBranch: string, branch: string): Promise<string> {
  for (const ref of [branch, `origin/${branch}`]) {
    const r = await ctx.run(['git', 'merge-base', `origin/${baseBranch}`, ref])
    if (r.exitCode === 0 && r.stdout.trim() !== '') return r.stdout.trim()
  }
  return 'none'
}

export async function jobSync(ctx: Ctx, t: Tracker, n: number): Promise<SyncResult> {
  const operator = await t.login()
  const ticket = await t.get(n)
  const state = stateOf(ticket.labels)
  if (state === 'conflict') {
    throw new FactoryError('label-conflict', `#${n} has several status labels`, 'Remove all but one status label.')
  }
  const dir = jobDir(ctx.root, n)
  await ctx.fs.write(`${dir}/issue.md`, renderIssue(ticket, operator))
  const cfg = await loadConfig(ctx)
  const rebuilt: string[] = []
  let job: Job

  if (await ctx.fs.exists(`${dir}/job.md`)) {
    job = await readJob(ctx, n)
  } else {
    const branch = branchName(n)
    const intake = findMarked(ticket.comments, 'intake', operator)
    const text = intake === undefined ? '' : stripMarker(intake.body)
    if (intake !== undefined) {
      await ctx.fs.write(`${dir}/intake.md`, dropSections(text, ['Job', 'Route']))
      rebuilt.push('intake.md')
    }
    const base = parseBase(fieldOf(text, 'Base'))
    let round = 0
    for (const c of ticket.comments) {
      const m = c.author === operator ? /^<!-- factory:round-([1-9][0-9]*) -->/.exec(c.body) : null
      if (m) round = Math.max(round, Number(m[1]))
    }
    job = {
      issue: n,
      title: oneLine(ticket.title),
      jobDir: dir,
      worktree: worktreeDir(ctx.root, n),
      branch,
      base: base === null || base === 'none' ? await mergeBase(ctx, cfg.baseBranch, branch) : base,
      baseBranch: cfg.baseBranch,
      pr: parsePr(fieldOf(text, 'PR')) ?? null,
      round,
      specUpdated: parseSpecUpdated(fieldOf(text, 'Spec updated')) ?? null,
      route: parseRoute(text) ?? {},
    }
    await writeJob(ctx, job)
    rebuilt.push('job.md')
    const spec = findMarked(ticket.comments, 'spec', operator)
    if (spec !== undefined) {
      await ctx.fs.write(`${dir}/spec.md`, stripMarker(spec.body))
      rebuilt.push('spec.md')
    }
    const decision = findMarked(ticket.comments, 'decision', operator)
    if (decision !== undefined) {
      await ctx.fs.write(`${dir}/decision.md`, stripMarker(decision.body))
      rebuilt.push('decision.md')
    }
  }

  await ensureWorktree(ctx, job.worktree, job.branch, job.base === 'none' ? `origin/${job.baseBranch}` : job.base)

  let specChanged = false
  const spec = findMarked(ticket.comments, 'spec', operator)
  if (spec !== undefined && (job.specUpdated === null || Date.parse(spec.updatedAt) > Date.parse(job.specUpdated))) {
    await ctx.fs.write(`${dir}/spec.md`, stripMarker(spec.body))
    job = { ...job, specUpdated: spec.updatedAt }
    await writeJob(ctx, job)
    specChanged = true
  }
  return { job, state, rebuilt, specChanged }
}
