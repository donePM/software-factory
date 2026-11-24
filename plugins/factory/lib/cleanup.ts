import { loadConfig } from './config.ts'
import { rmrf } from './exec.ts'
import { branchName, jobDir, worktreeDir } from './jobfile.ts'
import { stateOf } from './labels.ts'
import type { Tracker } from './tracker.ts'
import type { Ctx, Ticket } from './types.ts'

export type Kept = { path: string; reason: string; command: string }
export type CleanupReport = { removed: string[]; kept: Kept[] }
// docs: the numbers of the tickets in docs after the sweep, for the documenter.
export type SweepReport = CleanupReport & { finished: string[]; docs: number[] }

const ISSUE = /^[1-9][0-9]*$/

const fail = (r: { stderr: string }): string => r.stderr.trim() || 'git failed'

// Removes the worktree. Returns false when it stays.
async function removeWorktree(ctx: Ctx, wt: string, report: CleanupReport): Promise<boolean> {
  const status = await ctx.run(['git', '-C', wt, 'status', '--porcelain', '--untracked-files=no'])
  if (status.exitCode !== 0) return true // no worktree here
  if (status.stdout.trim() !== '') {
    report.kept.push({ path: wt, reason: 'worktree has uncommitted changes to tracked files', command: `git -C ${wt} status` })
    return false
  }
  const plain = await ctx.run(['git', 'worktree', 'remove', wt])
  if (plain.exitCode === 0) {
    report.removed.push(wt)
    return true
  }
  // Force only when nothing but untracked files is left.
  const all = await ctx.run(['git', '-C', wt, 'status', '--porcelain'])
  const onlyUntracked = all.exitCode === 0 && all.stdout.split('\n').filter(l => l !== '').every(l => l.startsWith('?? '))
  if (onlyUntracked && (await ctx.run(['git', 'worktree', 'remove', '--force', wt])).exitCode === 0) {
    report.removed.push(wt)
    return true
  }
  report.kept.push({ path: wt, reason: `worktree could not be removed: ${fail(plain)}`, command: `git worktree remove ${wt}` })
  return false
}

// Deletes the branch only when git agrees it is merged into origin/<base>. Never uses -D.
async function removeBranch(ctx: Ctx, branch: string, base: string, report: CleanupReport): Promise<void> {
  if ((await ctx.run(['git', 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])).exitCode !== 0) return
  const keep = (reason: string, command: string): void => {
    report.kept.push({ path: branch, reason, command })
  }
  const fetch = await ctx.run(['git', 'fetch', '--prune', 'origin'])
  if (fetch.exitCode !== 0) return keep(`fetch failed: ${fail(fetch)}`, 'git fetch --prune origin')
  const anc = await ctx.run(['git', 'merge-base', '--is-ancestor', branch, `origin/${base}`])
  if (anc.exitCode === 1) return keep(`branch not merged into origin/${base}`, `git log origin/${base}..${branch}`)
  if (anc.exitCode !== 0) return keep(`merge check failed: ${fail(anc)}`, `git merge-base --is-ancestor ${branch} origin/${base}`)
  // -d checks against the upstream, so point it at the merged base branch.
  const up = await ctx.run(['git', 'branch', `--set-upstream-to=origin/${base}`, branch])
  if (up.exitCode !== 0) return keep(`upstream not set: ${fail(up)}`, `git branch -d ${branch}`)
  const del = await ctx.run(['git', 'branch', '-d', branch])
  if (del.exitCode !== 0) return keep(fail(del), `git branch -d ${branch}`)
  report.removed.push(branch)
}

// A rejected PR is never merged. So the branch goes only when GitHub has its exact commit. Never uses -D.
async function removeRejectedBranch(ctx: Ctx, branch: string, pr: number, report: CleanupReport): Promise<void> {
  const local = await ctx.run(['git', 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])
  if (local.exitCode !== 0) return
  const sha = local.stdout.trim()
  const keep = (reason: string, command: string): void => {
    report.kept.push({ path: branch, reason, command })
  }
  const fetch = await ctx.run(['git', 'fetch', 'origin', `refs/pull/${pr}/head`])
  if (fetch.exitCode !== 0) return keep(`fetch failed: ${fail(fetch)}`, `git fetch origin refs/pull/${pr}/head`)
  const head = await ctx.run(['git', 'rev-parse', '--verify', '--quiet', 'FETCH_HEAD'])
  if (head.exitCode !== 0) return keep(`PR head not read: ${fail(head)}`, `git fetch origin refs/pull/${pr}/head`)
  const prHead = head.stdout.trim()
  if (prHead !== sha) return keep(`branch has commits that are not in PR #${pr}`, `git log ${prHead}..${branch}`)
  // With the old sha, git deletes the ref only when it did not move since the check.
  const del = await ctx.run(['git', 'update-ref', '-d', `refs/heads/${branch}`, sha])
  if (del.exitCode !== 0) return keep(fail(del), `git update-ref -d refs/heads/${branch} ${sha}`)
  report.removed.push(branch)
}

// pr: the PR of a rejected job. With no PR, the merge check holds: the branch has no commits of its own.
export async function cleanupJob(ctx: Ctx, _t: Tracker, n: number, end: 'done' | 'rejected', pr?: number): Promise<CleanupReport> {
  const base = (await loadConfig(ctx)).baseBranch
  const branch = branchName(n)
  const report: CleanupReport = { removed: [], kept: [] }
  if (await removeWorktree(ctx, worktreeDir(ctx.root, n), report)) {
    if (end === 'rejected' && pr !== undefined) await removeRejectedBranch(ctx, branch, pr, report)
    else await removeBranch(ctx, branch, base, report)
  }
  else report.kept.push({ path: branch, reason: 'worktree kept', command: `git branch -d ${branch}` })
  // job_sync rebuilds the folder from the ticket, so it always goes.
  const dir = jobDir(ctx.root, n)
  await rmrf(ctx, dir)
  report.removed.push(dir)
  return report
}

export const wikiTarget = async (ctx: Ctx): Promise<boolean> => (await loadConfig(ctx)).docs?.target === 'wiki'

// Call only after GitHub reports the PR on factory/<n> as merged. With a wiki target the job goes to docs and keeps its files.
export async function finishMerged(ctx: Ctx, t: Tracker, ticket: Ticket): Promise<CleanupReport> {
  const n = ticket.number
  const state = stateOf(ticket.labels)
  if (state === 'docs') return { removed: [], kept: [] }
  if (state !== 'done' && (await wikiTarget(ctx))) {
    await t.setState(n, 'docs', { prMerged: true })
    return { removed: [], kept: [] }
  }
  if (state !== 'done') await t.setState(n, 'done', { prMerged: true })
  if (ticket.state !== 'closed') await t.close(n, 'done')
  return cleanupJob(ctx, t, n, 'done')
}

async function folders(ctx: Ctx, name: 'jobs' | 'worktrees'): Promise<number[]> {
  const names = await ctx.fs.list(`${ctx.root}/.factory/${name}`).catch(() => [])
  return names.filter(s => ISSUE.test(s)).map(Number)
}

export async function sweep(ctx: Ctx, t: Tracker): Promise<SweepReport> {
  const report: SweepReport = { removed: [], kept: [], finished: [], docs: [] }
  const add = (r: CleanupReport): void => {
    report.removed.push(...r.removed)
    report.kept.push(...r.kept)
  }
  const failed = (n: number, e: unknown): void => {
    report.kept.push({ path: jobDir(ctx.root, n), reason: e instanceof Error ? e.message : String(e), command: `/factory:cleanup ${n}` })
  }
  const tickets = new Map<number, Ticket>()
  for (const n of new Set([...(await folders(ctx, 'jobs')), ...(await folders(ctx, 'worktrees'))])) {
    try {
      tickets.set(n, await t.get(n))
    } catch (e) {
      failed(n, e)
    }
  }
  for (const b of await t.backlog()) if (!tickets.has(b.number)) tickets.set(b.number, b)

  for (const [n, ticket] of tickets) {
    try {
      const state = stateOf(ticket.labels)
      // A docs job waits for the documenter, also when the issue is closed.
      if (state === 'docs') {
        report.docs.push(n)
        continue
      }
      // shortcut: one PR lookup per ticket, upgrade to one merged-PR list call when the backlog makes cleanup slow.
      if (state !== null && state !== 'conflict' && state !== 'done' && state !== 'rejected') {
        const branch = branchName(n)
        const pr = await t.findPr(branch)
        if (pr?.state === 'MERGED' && pr.headRefName === branch) {
          add(await finishMerged(ctx, t, ticket))
          const next = (await wikiTarget(ctx)) ? 'docs' : 'done'
          if (next === 'docs') report.docs.push(n)
          report.finished.push(`#${n}: PR merged on GitHub, set to ${next}`)
          continue
        }
      }
      // shortcut: sweep has no PR number for a rejected job, upgrade when kept rejected branches pile up.
      if (ticket.state === 'closed') add(await cleanupJob(ctx, t, n, state === 'rejected' ? 'rejected' : 'done'))
    } catch (e) {
      failed(n, e)
    }
  }
  // The search also finds closed docs jobs with no job folder.
  // shortcut: one search page of 50 hits, upgrade when more than 50 jobs wait in docs.
  for (const r of await t.searchIssues('label:"factory:docs"')) {
    if (stateOf(r.labels) === 'docs' && !report.docs.includes(r.number)) report.docs.push(r.number)
  }
  await ctx.run(['git', 'worktree', 'prune'])
  await ctx.run(['git', 'fetch', '--prune', 'origin'])
  return report
}
