import { loadConfig } from './config.ts'
import { checkMessage, typeOf } from './conventional.ts'
import { type CleanupReport, cleanupJob } from './cleanup.ts'
import { FactoryError, must, mkdirp, rmrf } from './exec.ts'
import { gateJob, passedAt } from './gatejob.ts'
import { parseIntake } from './intake.ts'
import { parseDecision, parseReview } from './review.ts'
import { route } from './route.ts'
import { renderIssue } from './issue-file.ts'
import { stateOf } from './labels.ts'
import { findMarked, stripMarker } from './markers.ts'
import {
  branchName, fieldOf, jobDir, lastSection, parseBase, parsePr, parseRoute, parseSpecUpdated, readJob, renderRoute, worktreeDir, writeJob,
  type Job,
} from './jobfile.ts'
import type { Tracker } from './tracker.ts'
import { assertTransition } from './transitions.ts'
import type { Ctx, Reviewer, State, Ticket } from './types.ts'

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
  // The factory label is the trust boundary: only a person with triage rights sets it.
  if (ticket.kind !== 'issue' || ticket.state !== 'open' || !ticket.labels.includes('factory')) {
    throw new FactoryError('not-factory', `#${n} is not an open issue with the label factory`, 'Add the label factory to an open issue, then run it again.')
  }
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
    const fromComment = fieldOf(jobPart, 'Round')
    let round = fromComment !== null && /^[0-9]+$/.test(fromComment) ? Number(fromComment) : 0
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

export type AdvanceInput = { issue: number; to: State; reason?: string; from?: State }
export type AdvanceResult = { job: Job; state: State; round: number; roundDir: string; reviewers?: Reviewer[]; note?: string; cleanup?: CleanupReport }

const SUPPORTED: State[] = ['spec', 'needs-info', 'rejected', 'build', 'review', 'approved', 'needs-human']
const MENTION = /^[A-Za-z0-9-]+(\[bot\])?$/

// The one writer of the intake comment: intake.md, then "## Job" and "## Route", both always present.
export function intakeComment(job: Job, intake: string, mention?: string): string {
  const lines = [beforeSections(intake).trimEnd()]
  if (mention !== undefined) lines.push('', mention)
  lines.push(
    '', '## Job',
    `- Base: ${job.base}`,
    `- Spec updated: ${job.specUpdated ?? 'none'}`,
    `- PR: ${job.pr === null ? 'none' : `#${job.pr}`}`,
    `- Round: ${job.round}`,
    '', '## Route',
  )
  const r = renderRoute(job.route)
  if (r !== '') lines.push(r)
  return `${lines.join('\n')}\n`
}

const roundOf = (job: Job): string => `${job.jobDir}/round-${job.round}`

async function readIfExists(ctx: Ctx, p: string): Promise<string | null> {
  return (await ctx.fs.exists(p)) ? ctx.fs.read(p) : null
}

async function readRequired(ctx: Ctx, p: string, code: string, fix: string): Promise<string> {
  const text = await readIfExists(ctx, p)
  if (text === null) throw new FactoryError(code, `${p} does not exist`, fix)
  return text
}

type Reviews = { missing: string[]; parsed: Partial<Record<Reviewer, ReturnType<typeof parseReview>>> }

async function readReviews(ctx: Ctx, job: Job, roundDir: string): Promise<Reviews> {
  const reviewers = Object.keys(job.route) as Reviewer[]
  if (reviewers.length === 0) throw new FactoryError('no-route', 'job.md has an empty Route', 'Run the spec advance again.')
  const out: Reviews = { missing: [], parsed: {} }
  for (const r of reviewers) {
    const text = await readIfExists(ctx, `${roundDir}/review-${r}.md`)
    if (text === null) out.missing.push(r)
    else out.parsed[r] = parseReview(text)
  }
  if (out.missing.length > 0) {
    throw new FactoryError('reviews-missing', `Missing review files: ${out.missing.join(', ')}`, 'Wait for every routed reviewer to finish.')
  }
  return out
}

// Gate verdict, each routed reviewer's verdict and every blocker line. Display only: it decides nothing.
export async function roundSummary(ctx: Ctx, job: Job, roundDir: string): Promise<string> {
  const checks = await readIfExists(ctx, `${roundDir}/checks.md`)
  const gate = /^VERDICT: (PASS|FAIL)$/m.exec(checks?.split(/\r\n|\r|\n/, 1)[0] ?? '')?.[1] ?? 'missing'
  const lines = [`Round ${job.round}`, '', `Gate: ${gate}`]
  for (const r of Object.keys(job.route)) {
    const text = await readIfExists(ctx, `${roundDir}/review-${r}.md`)
    if (text === null) {
      lines.push(`- ${r}: missing`)
      continue
    }
    const p = parseReview(text)
    lines.push(`- ${r}: ${p.verdict}`)
    for (const f of p.findings) if (f.severity === 'blocker') lines.push(`  - [blocker] ${f.text}`)
  }
  return `${lines.join('\n')}\n`
}

function checkSpec(spec: string): string {
  if ((spec.split(/\r\n|\r|\n/, 1)[0] ?? '').trimEnd() !== 'STATUS: READY') {
    throw new FactoryError('spec-not-ready', 'spec.md must start with "STATUS: READY"', 'Finish the spec first.')
  }
  const title = /^Title:\s*(.+)$/m.exec(spec)?.[1]?.trim()
  if (title === undefined) throw new FactoryError('spec-no-title', 'spec.md has no "Title:" line', 'The spec-writer must add a Title line.')
  const problem = checkMessage(title)
  if (problem !== null) throw new FactoryError('bad-title', `spec title "${title}": ${problem}`, 'Use a Conventional Commits title.')
  return title
}

// The ticket is the authority; job.md is a cache an agent can edit. Refuse when it differs.
export async function verifyJob(ctx: Ctx, t: Tracker, ticket: Ticket, job: Job): Promise<void> {
  const differs = (key: string): FactoryError => new FactoryError('bad-job', `job.md differs from the ticket: ${key}`, 'Run job_sync after you remove job.md, or restore the file.')
  if (job.baseBranch !== (await loadConfig(ctx)).baseBranch) throw differs('Base branch')
  const comment = findMarked(ticket.comments, 'intake', await t.login())
  if (comment === undefined) throw differs('intake comment')
  const text = stripMarker(comment.body)
  const part = lastSection(text, 'Job') ?? ''
  if ((fieldOf(part, 'Base') ?? 'none') !== job.base) throw differs('Base')
  if (parsePr(fieldOf(part, 'PR')) !== job.pr) throw differs('PR')
  if (fieldOf(part, 'Round') !== String(job.round)) throw differs('Round')
  if (renderRoute(parseRoute(text) ?? {}) !== renderRoute(job.route)) throw differs('Route')
}

export async function jobAdvance(ctx: Ctx, t: Tracker, input: AdvanceInput): Promise<AdvanceResult> {
  const { issue: n, to, reason } = input
  const ticket = await t.get(n)
  const from = stateOf(ticket.labels)
  if (from === 'conflict') throw new FactoryError('label-conflict', `#${n} has several status labels`, 'Remove all but one status label.')
  // A late notification must not move a job that left the step it reports on.
  if (input.from !== undefined && from !== input.from) throw new FactoryError('state-moved', `#${n} is ${from ?? 'not a job'}, not ${input.from}`, 'Ignore this notification.')
  if (!SUPPORTED.includes(to)) throw new FactoryError('unsupported-target', `job_advance cannot move to ${to}`, 'Use merge for done.')
  assertTransition(from, to)
  const dir = jobDir(ctx.root, n)
  if (!(await ctx.fs.exists(`${dir}/job.md`))) throw new FactoryError('no-job', `${dir}/job.md does not exist`, 'Run job_create first.')
  let job = await readJob(ctx, n)
  const result = (state: State, extra: Partial<AdvanceResult> = {}): AdvanceResult => ({ job, state, round: job.round, roundDir: roundOf(job), ...extra })
  const intakeText = async (): Promise<string> => readRequired(ctx, `${dir}/intake.md`, 'no-intake', 'Run the intake step first.')
  const upsertIntake = (mention?: string) => async (text: string): Promise<void> => {
    await t.upsertComment(n, 'intake', intakeComment(job, text, mention))
  }

  if (to === 'needs-human' && reason !== undefined) {
    await t.comment(n, `Factory stopped: ${reason}`)
    await t.setState(n, 'needs-human')
    return result('needs-human')
  }

  if (from !== 'intake') await verifyJob(ctx, t, ticket, job)

  if (to === 'spec') {
    const text = await intakeText()
    const intake = parseIntake(text)
    if (intake.decision !== 'ACCEPT') throw new FactoryError('intake-not-accept', `intake.md says ${intake.decision}`, 'Only an ACCEPT intake goes to spec.')
    job = { ...job, route: route(intake, await loadConfig(ctx)) }
    await writeJob(ctx, job)
    await upsertIntake()(text)
    await t.setState(n, 'spec')
    return result('spec')
  }

  if (to === 'needs-info') {
    const text = await intakeText()
    if (parseIntake(text).decision !== 'NEEDS-INFO') throw new FactoryError('intake-mismatch', 'intake.md must say DECISION: NEEDS-INFO')
    if ((lastSection(text, 'Questions') ?? '').trim() === '') throw new FactoryError('intake-no-questions', 'intake.md needs a non-empty "## Questions"')
    const mention = MENTION.test(ticket.author) ? `@${ticket.author} please answer the questions above.` : undefined
    await upsertIntake(mention)(text)
    await t.setState(n, 'needs-info')
    return result('needs-info')
  }

  if (to === 'rejected') {
    const text = await intakeText()
    if (parseIntake(text).decision !== 'REJECT') throw new FactoryError('intake-mismatch', 'intake.md must say DECISION: REJECT')
    if ((lastSection(text, 'Reason') ?? '').trim() === '') throw new FactoryError('intake-no-reason', 'intake.md needs a non-empty "## Reason"')
    await upsertIntake()(text)
    await t.setState(n, 'rejected')
    await t.close(n, 'rejected')
    return result('rejected', { cleanup: await cleanupJob(ctx, t, n, 'rejected') })
  }

  if (to === 'build') return advanceBuild(ctx, t, job, from, await specMoved(t, ticket, job))
  if (to === 'review') return advanceReview(ctx, t, job)
  if (to === 'needs-human' && from !== 'review') throw new FactoryError('reason-required', 'needs-human outside review needs a reason', 'Pass reason.')
  if (to === 'approved' && (await specMoved(t, ticket, job))) {
    throw new FactoryError('spec-changed', 'the spec changed after this round started', 'Call job_advance with to: build, then start a new builder.')
  }
  return advanceDecision(ctx, t, job, to)
}

const done = (job: Job, state: State, extra: Partial<AdvanceResult> = {}): AdvanceResult => ({ job, state, round: job.round, roundDir: roundOf(job), ...extra })

async function startRound(ctx: Ctx, t: Tracker, job: Job): Promise<AdvanceResult> {
  const intake = await readRequired(ctx, `${job.jobDir}/intake.md`, 'no-intake', 'Run the intake step first.')
  // The comment first: job.md must not be ahead of the ticket when the upsert fails.
  await t.upsertComment(job.issue, 'intake', intakeComment(job, intake))
  await writeJob(ctx, job)
  await rmrf(ctx, `${job.jobDir}/decision.md`) // a new round needs a new decision
  await mkdirp(ctx, roundOf(job))
  await t.setState(job.issue, 'build')
  return done(job, 'build')
}

// job_sync took a newer spec after the round started: job.md differs from the intake comment.
async function specMoved(t: Tracker, ticket: Ticket, job: Job): Promise<boolean> {
  const comment = findMarked(ticket.comments, 'intake', await t.login())
  if (comment === undefined) return false
  const posted = fieldOf(lastSection(stripMarker(comment.body), 'Job') ?? '', 'Spec updated') ?? 'none'
  return posted !== (job.specUpdated ?? 'none')
}

async function advanceBuild(ctx: Ctx, t: Tracker, old: Job, from: State | null, specChanged: boolean): Promise<AdvanceResult> {
  const n = old.issue
  if (from !== 'spec' && old.round === 0) {
    throw new FactoryError('bad-state', 'no round has started yet', 'Advance spec to build first.')
  }
  if (from === 'spec') {
    const spec = await readRequired(ctx, `${old.jobDir}/spec.md`, 'no-spec', 'Run the spec step first.')
    checkSpec(spec)
    const posted = await t.upsertComment(n, 'spec', spec)
    const job: Job = { ...old, specUpdated: posted.updatedAt, round: 1 }
    return startRound(ctx, t, job)
  }
  const max = (await loadConfig(ctx)).maxRounds
  const over = (job: Job): boolean => job.round + 1 > max
  if (from === 'review') {
    const { parsed } = await readReviews(ctx, old, roundOf(old))
    if (!specChanged && !Object.values(parsed).some(p => p.verdict === 'CHANGES')) {
      throw new FactoryError('no-changes', 'no review asks for changes', 'Use approved or needs-human when every review passes.')
    }
    await t.upsertComment(n, `round-${old.round}`, await roundSummary(ctx, old, roundOf(old)))
  } else {
    checkSpec(await readRequired(ctx, `${old.jobDir}/spec.md`, 'no-spec', 'Run the spec step first.'))
  }
  if (over(old)) {
    const note = `Round limit of ${max} reached after round ${old.round}.`
    await t.comment(n, `Factory stopped: ${note}`)
    if (from !== 'needs-human') await t.setState(n, 'needs-human')
    return done(old, 'needs-human', { note })
  }
  return startRound(ctx, t, { ...old, round: old.round + 1 })
}

async function advanceReview(ctx: Ctx, t: Tracker, old: Job): Promise<AdvanceResult> {
  const n = old.issue
  if (old.round < 1) throw new FactoryError('bad-round', 'job.md Round is 0, no build ran', 'Advance to build first.')
  const roundDir = roundOf(old)
  const spec = await readRequired(ctx, `${old.jobDir}/spec.md`, 'no-spec', 'Run the spec step first.')
  const title = checkSpec(spec)
  const build = await readRequired(ctx, `${roundDir}/build.md`, 'build-incomplete', 'The builder must write build.md.')
  if ((build.split(/\r\n|\r|\n/, 1)[0] ?? '').trimEnd() !== 'STATUS: DONE') {
    throw new FactoryError('build-incomplete', 'build.md must start with "STATUS: DONE"', 'The builder must finish first.')
  }
  // checks.md can be written by agents: run the gate here, through the gate tool's own path.
  const head = async (): Promise<string> => (await must(ctx, ['git', '-C', old.worktree, 'rev-parse', 'HEAD']))
  const sha = await head()
  // gate-runner usually ran the gate at this HEAD already: run it again only when it did not pass here.
  if (passedAt(ctx, n, `round-${old.round}`) !== sha) {
    const gate = await gateJob(ctx, n, `round-${old.round}`)
    if (gate.verdict !== 'PASS') throw new FactoryError('gate-not-green', `the gate is ${gate.verdict}, see ${roundDir}/checks.md`, 'Fix the failures and run the gate again.')
    if ((await head()) !== sha) throw new FactoryError('gate-not-green', 'HEAD moved during the gate', 'Run the gate again.')
  }
  await must(ctx, ['git', '-C', old.worktree, 'push', 'origin', `${sha}:refs/heads/${old.branch}`])
  let job = old
  if (job.pr === null) {
    const found = await t.findPr(old.branch)
    let pr = found !== null && found.state === 'OPEN' ? found.number : null
    if (pr === null) {
      const kind = typeOf(title)!
      const labels = ['factory:pr', `type:${kind.type}`, ...(kind.breaking ? ['type:breaking'] : [])]
      const summary = (lastSection(build, 'Summary') ?? '').trim()
      pr = (await t.openPr(old.branch, old.baseBranch, title, `Closes #${n}\n\n## Summary\n\n${summary}\n`, labels)).number
    }
    job = { ...old, pr }
    await writeJob(ctx, job)
  }
  // Always: a spec change during build updates Spec updated, and approved compares it with this comment.
  await t.upsertComment(n, 'intake', intakeComment(job, await readRequired(ctx, `${job.jobDir}/intake.md`, 'no-intake', 'Run the intake step first.')))
  await t.setState(n, 'review')
  return done(job, 'review', { reviewers: Object.keys(job.route) as Reviewer[] })
}

async function advanceDecision(ctx: Ctx, t: Tracker, job: Job, to: State): Promise<AdvanceResult> {
  const n = job.issue
  const roundDir = roundOf(job)
  const { parsed } = await readReviews(ctx, job, roundDir)
  const decision = parseDecision(await readRequired(ctx, `${job.jobDir}/decision.md`, 'no-decision', 'The approver must write decision.md.'))
  const allPass = Object.values(parsed).every(p => p.verdict === 'PASS')
  const ok = to === 'approved' ? decision.decision === 'APPROVE' && allPass : decision.decision === 'ESCALATE'
  if (!ok) {
    throw new FactoryError('decision-mismatch', `decision ${decision.decision} and the review verdicts do not fit ${to}`, 'Approve only when every review passes and the decision is APPROVE.')
  }
  if (job.pr === null) throw new FactoryError('no-pr', 'job.md has no PR', 'Advance to review first.')
  await t.upsertComment(n, `round-${job.round}`, await roundSummary(ctx, job, roundDir))
  await t.upsertComment(n, 'decision', await ctx.fs.read(`${job.jobDir}/decision.md`))
  if ((await t.prState(job.pr)).headRefName !== job.branch) throw new FactoryError('bad-pr', `PR #${job.pr} is not on ${job.branch}`, 'Run job_sync.')
  // Both ways the PR leaves draft: GitHub does not merge a draft, and a human may merge an escalated job.
  await t.prReady(job.pr)
  if (to === 'needs-human') await t.prComment(job.pr, decision.question ?? '')
  await t.setState(n, to)
  return done(job, to)
}
