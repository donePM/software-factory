import { loadConfig } from './config.ts'
import { FactoryError, must } from './exec.ts'
import { renderIssue } from './issue-file.ts'
import { stateOf } from './labels.ts'
import { findMarked, stripMarker } from './markers.ts'
import {
  branchName, fieldOf, jobDir, lastSection, parseBase, parsePr, parseRoute, parseSpecUpdated, readJob, worktreeDir, writeJob,
  type Job,
} from './jobfile.ts'
import type { Tracker } from './tracker.ts'
import type { Ctx, State } from './types.ts'

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim()

async function ok(ctx: Ctx, argv: string[]): Promise<boolean> {
  return (await ctx.run(argv)).exitCode === 0
}

// ls-remote --exit-code: 0 present, 2 absent, anything else is a failure (network, auth).
async function onOrigin(ctx: Ctx, branch: string): Promise<boolean> {
  const r = await ctx.run(['git', 'ls-remote', '--exit-code', '--heads', 'origin', branch])
  if (r.exitCode === 0) return true
  if (r.exitCode === 2) return false
  throw new FactoryError('command-failed', `git ls-remote failed: ${r.stderr.trim()}`, 'Check the network and the origin remote, then run job_sync again.')
}

// Restore order: on origin, then a local branch, then a new branch from `start`.
async function ensureWorktree(ctx: Ctx, wt: string, branch: string, start: string): Promise<void> {
  if (await ctx.fs.exists(wt)) return
  if (await onOrigin(ctx, branch)) {
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
  const resume = from === 'needs-info'
  let old: Job | null = null
  if (resume && (await ctx.fs.exists(`${jobDir(ctx.root, n)}/job.md`))) old = await readJob(ctx, n) // bad-job stops before the label moves
  await t.setState(n, 'intake') // refuses illegal moves before any git call
  const cfg = await loadConfig(ctx)
  const dir = jobDir(ctx.root, n)
  const wt = worktreeDir(ctx.root, n)
  const branch = branchName(n)
  const origin = `origin/${cfg.baseBranch}`

  let base = old?.base ?? 'none'
  if (old === null || base === 'none' || !(await ctx.fs.exists(wt))) {
    await must(ctx, ['git', 'fetch', 'origin', cfg.baseBranch])
    if (old === null || base === 'none') base = await must(ctx, ['git', 'rev-parse', origin])
    await ensureWorktree(ctx, wt, branch, old !== null && old.base !== 'none' ? old.base : origin)
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

// intake.md is the text before the first "## Job" or "## Route" heading.
function beforeSections(text: string): string {
  const out: string[] = []
  for (const line of text.split(/\r\n|\r|\n/)) {
    if (/^## (Job|Route)\s*$/.test(line)) break
    out.push(line)
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
  if (state === null || state === 'conflict' || state === 'done' || state === 'rejected') {
    throw new FactoryError('bad-state', `#${n} is ${state === null ? 'in the backlog' : state}, job_sync does not apply`, 'Use job_create to start a job.')
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
    const jobPart = lastSection(text, 'Job') ?? ''
    if (intake !== undefined) {
      await ctx.fs.write(`${dir}/intake.md`, beforeSections(text))
      rebuilt.push('intake.md')
    }
    const base = parseBase(fieldOf(jobPart, 'Base'))
    let round = 0
    for (const c of ticket.comments) {
      const m = c.author === operator ? /^<!-- factory:round-([1-9][0-9]*) -->\s*$/.exec(c.body.split(/\r\n|\r|\n/, 1)[0] ?? '') : null
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
      pr: parsePr(fieldOf(jobPart, 'PR')) ?? null,
      round,
      specUpdated: parseSpecUpdated(fieldOf(jobPart, 'Spec updated')) ?? null,
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
