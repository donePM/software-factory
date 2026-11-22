import { followState } from './assignee.ts'
import { loadConfig } from './config.ts'
import { type CleanupReport, cleanupJob, finishMerged } from './cleanup.ts'
import { FactoryError, must } from './exec.ts'
import { gateJob } from './gatejob.ts'
import { intakeComment, jobAdvance, jobSync, reviewedOf, verifyJob } from './job.ts'
import { branchName, writeJob } from './jobfile.ts'
import { stateOf } from './labels.ts'
import { findMarked } from './markers.ts'
import type { Tracker } from './tracker.ts'
import type { Ctx, PrState, State, Ticket } from './types.ts'

const HEAD_READS = 10
const HEAD_READ_DELAY_MS = 1000
const CLOSES = /^Closes #([1-9][0-9]*)\s*$/m

const noPair = (n: number, why: string): FactoryError =>
  new FactoryError('no-pair', `#${n} ${why}`, 'Pass the number of a factory issue that has a PR, or of its factory PR.')

// An issue n needs a PR on factory/<n>. A PR needs `factory:pr`, a "Closes #<i>" line and the head factory/<i>.
export async function resolvePair(_ctx: Ctx, t: Tracker, n: number): Promise<{ issue: number; pr: PrState }> {
  const ticket = await t.get(n)
  if (ticket.labels.includes('factory:pr')) {
    const issue = Number(CLOSES.exec(ticket.body)?.[1])
    if (!Number.isInteger(issue)) throw noPair(n, 'has no "Closes #<issue>" line')
    const pr = await t.prState(n)
    if (pr.headRefName !== branchName(issue)) throw noPair(n, `is on ${pr.headRefName}, not ${branchName(issue)}`)
    return { issue, pr }
  }
  const state = stateOf(ticket.labels)
  if (state === null || state === 'conflict') throw noPair(n, 'has no single factory status label')
  const pr = await t.findPr(branchName(n))
  if (pr === null) throw noPair(n, `has no PR on ${branchName(n)}`)
  if (pr.headRefName !== branchName(n)) throw noPair(n, `has a PR on ${pr.headRefName}, not ${branchName(n)}`)
  return { issue: n, pr }
}

// The approval names the reviewed commit: a later round needs a new approval.
const approvalBody = (login: string, sha: string): string => `Approved by @${login} for merge. Reviewed commit: ${sha}.`

const notReviewed = (why: string): FactoryError =>
  new FactoryError('not-reviewed', why, 'Commits came after the reviews, or no review ran. The job must go back to build for a new review.')

// GitHub does not allow a review on your own PR, so the approval then becomes a marker comment.
async function record(t: Tracker, issue: number, pr: PrState, sha: string): Promise<'review' | 'comment'> {
  const login = await t.login()
  if (pr.author === login) {
    await t.upsertComment(issue, 'approval', approvalBody(login, sha))
    return 'comment'
  }
  await t.approvePr(pr.number, approvalBody(login, sha))
  return 'review'
}

// HEAD must be the reviewed commit, or a chain of sync merges on top of it that earlier merge runs made.
// Each sync merges the commit under it (first parent) and a base commit, with the tree that git makes from the two.
async function checkReviewed(ctx: Ctx, wt: string, reviewed: string | null, origin: string): Promise<string> {
  if (reviewed === null) throw notReviewed('the job has no reviewed commit')
  const head = await must(ctx, ['git', '-C', wt, 'rev-parse', 'HEAD'])
  for (let c = head; c !== reviewed;) {
    const [, first, second, ...rest] = (await must(ctx, ['git', '-C', wt, 'rev-list', '--parents', '-n', '1', c])).split(/\s+/)
    const clean = first !== undefined && second !== undefined && rest.length === 0
      && (await ctx.run(['git', '-C', wt, 'merge-base', '--is-ancestor', second, origin])).exitCode === 0
      && await sameTree(ctx, wt, c, first, second)
    if (!clean) throw notReviewed(`HEAD ${head} is not the reviewed commit ${reviewed}`)
    c = first
  }
  return reviewed
}

async function sameTree(ctx: Ctx, wt: string, commit: string, a: string, b: string): Promise<boolean> {
  const made = await ctx.run(['git', '-C', wt, 'merge-tree', '--write-tree', a, b])
  if (made.exitCode !== 0) return false // a conflict: the factory never commits one
  return made.stdout.split('\n', 1)[0]?.trim() === (await must(ctx, ['git', '-C', wt, 'rev-parse', `${commit}^{tree}`]))
}

// Merges origin/<base> into the worktree. It undoes a conflict, comments on the issue, and returns false.
async function syncBase(ctx: Ctx, t: Tracker, wt: string, issue: number, base: string): Promise<boolean> {
  const origin = `origin/${base}`
  const sync = await ctx.run(['git', '-C', wt, 'merge', '--no-edit', '-m', `chore(factory): sync with ${base}`, '-m', `Refs: #${issue}`, origin])
  if (sync.exitCode === 0) return true
  // Only a stopped merge leaves MERGE_HEAD. Other failures (lock, disk, bad ref) are no conflict.
  const conflict = (await ctx.run(['git', '-C', wt, 'rev-parse', '-q', '--verify', 'MERGE_HEAD'])).exitCode === 0
  if (!conflict) {
    throw new FactoryError('sync-failed', `git merge ${origin} failed in ${wt}: ${(sync.stderr || sync.stdout).trim()}`, 'Fix the git problem in the worktree, then merge again. The label did not change.')
  }
  await ctx.run(['git', '-C', wt, 'merge', '--abort'])
  await t.comment(issue, `Factory stopped: ${conflictReason(origin, branchName(issue))} The job needs a new build: the builder merges ${origin}, then the reviews run again.`)
  return false
}

const conflictReason = (origin: string, branch: string): string => `merging ${origin} into ${branch} has a conflict.`

export type Sync = { issue: number; outcome: 'synced' } | { issue: number; outcome: 'conflict'; state: State } | { issue: number; outcome: 'failed'; error: string }

// Only approved jobs: no agent and no human uses their worktrees. An error in one job does not stop the next.
// shortcut: no gate after a sync, the gate runs at the merge of each job. Upgrade when a red gate at merge time is common.
async function syncOthers(ctx: Ctx, t: Tracker, merged: number, base: string): Promise<Sync[]> {
  const syncs: Sync[] = []
  for (const other of await t.backlog()) {
    const m = other.number
    if (m === merged || stateOf(other.labels) !== 'approved') continue
    try {
      if ((await t.findPr(branchName(m)))?.state !== 'OPEN') continue
      const { job } = await jobSync(ctx, t, m)
      await verifyJob(ctx, t, await t.get(m), job)
      await must(ctx, ['git', '-C', job.worktree, 'fetch', 'origin', base])
      await checkReviewed(ctx, job.worktree, job.reviewed, `origin/${base}`)
      if (await syncBase(ctx, t, job.worktree, m, base)) {
        await must(ctx, ['git', '-C', job.worktree, 'push', 'origin', `HEAD:refs/heads/${branchName(m)}`])
        syncs.push({ issue: m, outcome: 'synced' })
      } else {
        syncs.push({ issue: m, outcome: 'conflict', state: (await jobAdvance(ctx, t, { issue: m, from: 'approved', to: 'build' })).state })
      }
    } catch (e) {
      syncs.push({ issue: m, outcome: 'failed', error: e instanceof Error ? e.message : String(e) })
    }
  }
  return syncs
}

// Approval and merge apply only after the reviews: the job is approved, or a human must decide.
async function finishedState(t: Tracker, issue: number, what: string): Promise<{ ticket: Ticket; state: 'approved' | 'needs-human' }> {
  const ticket = await t.get(issue)
  const state = stateOf(ticket.labels)
  if (state !== 'approved' && state !== 'needs-human') {
    throw new FactoryError('bad-state', `#${issue} is ${state ?? 'in the backlog'}, ${what} needs approved or needs-human`, 'Let the reviews finish first.')
  }
  return { ticket, state }
}

export async function approve(ctx: Ctx, t: Tracker, n: number): Promise<{ issue: number; pr: number; how: 'review' | 'comment' }> {
  const { issue, pr } = await resolvePair(ctx, t, n)
  const { ticket } = await finishedState(t, issue, 'approve')
  const reviewed = reviewedOf(ticket, await t.login())
  if (reviewed === null) throw notReviewed('the job has no reviewed commit')
  return { issue, pr: pr.number, how: await record(t, issue, pr, reviewed) }
}

export type MergeResult = { issue: number; pr: number; head: string; mergeCommit: string | null; alreadyMerged: boolean; cleanup: CleanupReport; syncs: Sync[] }

export async function merge(ctx: Ctx, t: Tracker, n: number): Promise<MergeResult> {
  const { issue, pr: found } = await resolvePair(ctx, t, n)
  // A human merged the PR on GitHub: only the housekeeping is left.
  if (found.state === 'MERGED') {
    const cleanup = await finishMerged(ctx, t, await t.get(issue))
    return { issue, pr: found.number, head: found.headRefOid, mergeCommit: found.mergeCommit, alreadyMerged: true, cleanup, syncs: [] }
  }
  const cfg = await loadConfig(ctx)
  const base = cfg.baseBranch
  const origin = `origin/${base}`
  const { ticket, state } = await finishedState(t, issue, 'merge')
  if (found.state !== 'OPEN') throw new FactoryError('bad-state', `PR #${found.number} is ${found.state}`, 'Only an open PR can merge.')

  let { job } = await jobSync(ctx, t, issue)
  await verifyJob(ctx, t, ticket, job)
  if (job.pr !== found.number) throw new FactoryError('bad-pr', `job.md names PR ${job.pr}, not #${found.number}`, 'Run job_sync after you remove job.md.')
  const wt = job.worktree

  await must(ctx, ['git', '-C', wt, 'fetch', 'origin', base])
  const reviewed = await checkReviewed(ctx, wt, job.reviewed, origin)
  if (!(await syncBase(ctx, t, wt, issue, base))) {
    // At the round limit, job_advance sets needs-human instead of build.
    const to = state === 'approved' ? (await jobAdvance(ctx, t, { issue, from: 'approved', to: 'build' })).state : state
    const next = to === 'build' ? `The job is in build now. Run /factory:run ${issue}` : 'Send the job back to build'
    throw new FactoryError('sync-conflict', conflictReason(origin, job.branch), `The factory undid the merge, so the worktree has no conflict now. ${next}: the builder merges ${origin}, then the reviews run again.`)
  }

  const head = async (): Promise<string> => must(ctx, ['git', '-C', wt, 'rev-parse', 'HEAD'])
  const sha = await head()
  // The gate and later checks compare against the base the branch now has.
  job = { ...job, base: await must(ctx, ['git', '-C', wt, 'merge-base', 'HEAD', origin]) }
  await writeJob(ctx, job)
  const intake = await ctx.fs.read(`${job.jobDir}/intake.md`)
  await t.upsertComment(issue, 'intake', intakeComment(job, intake))

  const gate = await gateJob(ctx, issue, 'merge')
  if (gate.verdict !== 'PASS') throw new FactoryError('gate-failed', gate.report, `Fix the failures, then merge again. See ${job.jobDir}/merge/checks.md.`)
  if ((await head()) !== sha) throw new FactoryError('gate-not-green', 'HEAD moved during the gate', 'Merge again.')
  await must(ctx, ['git', '-C', wt, 'push', 'origin', `${sha}:refs/heads/${job.branch}`])

  // GitHub shows the pushed head with a delay. Only the old head may cause a new read.
  let pr = await t.prState(found.number)
  for (let read = 1; read < HEAD_READS && pr.headRefName === job.branch && pr.headRefOid === found.headRefOid && pr.headRefOid !== sha; read++) {
    await ctx.sleep(HEAD_READ_DELAY_MS)
    pr = await t.prState(found.number)
  }
  if (pr.headRefName !== job.branch || pr.headRefOid !== sha) {
    throw new FactoryError('head-mismatch', `PR #${pr.number} head is ${pr.headRefOid} on ${pr.headRefName}, not ${sha} on ${job.branch}`, 'Merge again.')
  }
  const login = await t.login()
  const marker = findMarked((await t.get(issue)).comments, 'approval', login)
  const recorded = pr.reviewDecision === 'APPROVED' || marker?.body.includes(`Reviewed commit: ${reviewed}.`) === true
  if (!recorded) await record(t, issue, pr, reviewed)

  if (pr.isDraft) await t.prReady(pr.number) // GitHub does not merge a draft
  await t.merge(pr.number, `${pr.title} (#${pr.number})`, sha)
  const after = await t.prState(pr.number)
  if (after.state !== 'MERGED') {
    throw new FactoryError('merge-failed', `PR #${pr.number} is not merged`, 'Check the PR on GitHub, then merge again.')
  }
  await t.setState(issue, 'done')
  await followState(t, [issue, pr.number], 'done')
  if ((await t.get(issue)).state !== 'closed') await t.close(issue, 'done')
  // shortcut: no retry when GitHub gives no merge commit, upgrade when a real run shows null.
  const cleanup = await cleanupJob(ctx, t, issue, 'done')
  return { issue, pr: pr.number, head: sha, mergeCommit: after.mergeCommit, alreadyMerged: false, cleanup, syncs: await syncOthers(ctx, t, issue, base) }
}
