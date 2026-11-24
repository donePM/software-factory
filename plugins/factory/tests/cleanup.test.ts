import { expect, test } from 'claude-code/testing'
import { cleanupJob, finishMerged, sweep } from '../lib/cleanup.ts'
import { defaultConfig } from '../lib/config.ts'
import { invoke, TOOLS } from '../hooks/tools.ts'
import type { Tracker } from '../lib/tracker.ts'
import type { PrState, State, Ticket } from '../lib/types.ts'
import { boardCalls, boardReplies, edit, onBoard } from './support/board.ts'
import { fakeCtx, type Reply } from './support/host.ts'

const WT = '/repo/.factory/worktrees/7'
const DIR = '/repo/.factory/jobs/7'
const CFG = { '/repo/.factory/config.json': JSON.stringify(defaultConfig('https://github.com/a/b', 'main', [])) }

// Later entries are fallbacks: the first reply that matches wins.
const ctxOf = (over: Reply[] = [], files: Record<string, string> = {}) =>
  fakeCtx({ files: { ...CFG, ...files }, replies: [...over, { argv: [] }] })

type Pr = Partial<PrState> | null
function tracker(o: { closed?: number[]; labels?: Record<number, string[]>; backlog?: Ticket[]; prs?: Record<number, Pr>; search?: { number: number; labels: string[] }[] } = {}) {
  const log: string[] = []
  const ticket = (n: number): Ticket => ({
    kind: 'issue', number: n, title: 't', body: '', author: 'a', labels: o.labels?.[n] ?? ['factory', 'factory:done'],
    state: o.closed?.includes(n) ? 'closed' : 'open', createdAt: '2026-01-01T00:00:00Z', url: `u/${n}`, comments: [],
  })
  const t = {
    log,
    get: async (n: number) => { log.push(`get ${n}`); return ticket(n) },
    backlog: async () => o.backlog ?? [],
    searchIssues: async (query: string) => { log.push(`search ${query}`); return (o.search ?? []).map(r => ({ title: 't', ...r })) },
    setState: async (n: number, to: State, opts?: { prMerged?: boolean }) => { log.push(`state ${n} ${to}${opts?.prMerged === true ? ' prMerged' : ''}`) },
    close: async (n: number, reason: string) => { log.push(`close ${n} ${reason}`) },
    findPr: async (branch: string) => {
      log.push(`findPr ${branch}`)
      const pr = o.prs?.[Number(branch.split('/')[1])]
      return pr ? ({ headRefName: branch, ...pr } as PrState) : null
    },
  }
  return t as unknown as Tracker & typeof t
}
const CLEAN: Reply = { argv: ['git', '-C', WT, 'status', '--porcelain', '--untracked-files=no'] }
const has = (calls: string[][], ...prefix: string[]): boolean => calls.some(c => prefix.every((p, i) => c[i] === p))

test('cleanup removes worktree, branch and job folder after merge', async () => {
  const ctx = ctxOf()
  const r = await cleanupJob(ctx, tracker(), 7, 'done')
  expect(ctx.calls).toContainEqual(['git', 'worktree', 'remove', WT])
  expect(ctx.calls).toContainEqual(['git', 'fetch', '--prune', 'origin'])
  expect(ctx.calls).toContainEqual(['git', 'merge-base', '--is-ancestor', 'factory/7', 'origin/main'])
  expect(ctx.calls).toContainEqual(['git', 'branch', '--set-upstream-to=origin/main', 'factory/7'])
  expect(ctx.calls).toContainEqual(['git', 'branch', '-d', 'factory/7'])
  expect(ctx.calls).toContainEqual(['rm', '-rf', DIR])
  expect(r.removed).toEqual([WT, 'factory/7', DIR])
  expect(r.kept).toEqual([])
})

test('cleanup keeps a worktree with tracked changes', async () => {
  const ctx = ctxOf([{ argv: ['git', '-C', WT, 'status', '--porcelain', '--untracked-files=no'], result: { stdout: ' M src/a.ts\n' } }])
  const r = await cleanupJob(ctx, tracker(), 7, 'done')
  expect(r.kept[0]!.path).toBe(WT)
  expect(r.kept[0]!.reason).toContain('changes')
  expect(r.kept[0]!.command).not.toContain('worktree remove')
  expect(has(ctx.calls, 'git', 'worktree', 'remove')).toBe(false)
  expect(has(ctx.calls, 'git', 'branch', '-d')).toBe(false)
  expect(r.kept[1]).toMatchObject({ path: 'factory/7', reason: 'worktree kept' })
  expect(r.removed).toEqual([DIR]) // the job folder always goes
})

test('cleanup forces only when untracked files remain', async () => {
  const stuck: Reply = { argv: ['git', 'worktree', 'remove', WT], result: { exitCode: 1, stderr: "fatal: '/x' contains modified or untracked files, use --force to delete it" } }
  const forced = ctxOf([CLEAN, stuck, { argv: ['git', '-C', WT, 'status', '--porcelain'], result: { stdout: '?? notes.txt\n' } }])
  const a = await cleanupJob(forced, tracker(), 7, 'done')
  expect(forced.calls).toContainEqual(['git', 'worktree', 'remove', '--force', WT])
  expect(a.removed).toContain(WT)

  // A tracked change that appears after the first check stops the force.
  const racy = ctxOf([CLEAN, stuck, { argv: ['git', '-C', WT, 'status', '--porcelain'], result: { stdout: ' M a.ts\n?? b\n' } }])
  const b = await cleanupJob(racy, tracker(), 7, 'done')
  expect(has(racy.calls, 'git', 'worktree', 'remove', '--force')).toBe(false)
  expect(b.kept[0]!.path).toBe(WT)
})

test('cleanup never uses branch -D', async () => {
  const unmerged = ctxOf([{ argv: ['git', 'merge-base', '--is-ancestor'], result: { exitCode: 1 } }])
  const failing = ctxOf([{ argv: ['git', 'branch', '-d'], result: { exitCode: 1, stderr: 'not fully merged' } }])
  const plain = ctxOf()
  for (const ctx of [unmerged, failing, plain]) {
    await cleanupJob(ctx, tracker(), 7, 'done')
    expect(ctx.calls.some(c => c.includes('-D'))).toBe(false)
  }
})

test('cleanup keeps an unmerged branch', async () => {
  const ctx = ctxOf([{ argv: ['git', 'merge-base', '--is-ancestor'], result: { exitCode: 1 } }])
  const r = await cleanupJob(ctx, tracker(), 7, 'done')
  expect(r.kept).toHaveLength(1)
  expect(r.kept[0]).toMatchObject({ path: 'factory/7' })
  expect(r.kept[0]!.reason).toContain('not merged')
  expect(has(ctx.calls, 'git', 'branch', '-d')).toBe(false)
  expect(r.removed).toEqual([WT, DIR])
})

test('cleanup reports a branch that git refuses to delete', async () => {
  const ctx = ctxOf([{ argv: ['git', 'branch', '-d'], result: { exitCode: 1, stderr: 'not fully merged' } }])
  const r = await cleanupJob(ctx, tracker(), 7, 'done')
  expect(r.kept[0]).toMatchObject({ path: 'factory/7' })
  expect(r.kept[0]!.reason).toContain('not fully merged')
})

test('cleanup takes the base branch from the config, not from job.md', async () => {
  const cfg = JSON.stringify(defaultConfig('https://github.com/a/b', 'trunk', []))
  const ctx = ctxOf([], { '/repo/.factory/config.json': cfg, [`${DIR}/job.md`]: '- Base branch: evil\n' })
  await cleanupJob(ctx, tracker(), 7, 'done')
  expect(ctx.calls).toContainEqual(['git', 'merge-base', '--is-ancestor', 'factory/7', 'origin/trunk'])
})

test('rejected removes worktree, empty branch and job folder', async () => {
  const ctx = ctxOf()
  const t = tracker()
  const r = await cleanupJob(ctx, t, 7, 'rejected')
  expect(r.removed).toEqual([WT, 'factory/7', DIR])
  expect(ctx.calls.some(c => c[0] === 'gh')).toBe(false)
  expect(t.log).toEqual([])
})

const LOCAL = 'c'.repeat(40)
const PR_HEAD = 'e'.repeat(40)
const rejectedCtx = (prHead: string, fetchFails = false) => ctxOf([
  { argv: ['git', 'rev-parse', '--verify', '--quiet', 'refs/heads/factory/7'], result: { stdout: `${LOCAL}\n` } },
  { argv: ['git', 'fetch', 'origin', 'refs/pull/12/head'], result: fetchFails ? { exitCode: 128, stderr: 'offline' } : {} },
  { argv: ['git', 'rev-parse', '--verify', '--quiet', 'FETCH_HEAD'], result: { stdout: `${prHead}\n` } },
])

test('rejected deletes the branch only when it matches the PR head', async () => {
  const ctx = rejectedCtx(LOCAL)
  const t = tracker()
  const r = await cleanupJob(ctx, t, 7, 'rejected', 12)
  expect(ctx.calls).toContainEqual(['git', 'fetch', 'origin', 'refs/pull/12/head'])
  expect(ctx.calls).toContainEqual(['git', 'update-ref', '-d', 'refs/heads/factory/7', LOCAL])
  expect(has(ctx.calls, 'git', 'merge-base')).toBe(false)
  expect(ctx.calls.some(c => c.includes('-D'))).toBe(false)
  expect(r.removed).toEqual([WT, 'factory/7', DIR])
  expect(r.kept).toEqual([])
  expect(t.log).toEqual([])
})

test('rejected keeps an unpushed branch and reports it', async () => {
  for (const [ctx, reason] of [[rejectedCtx(PR_HEAD), 'not in PR #12'], [rejectedCtx(LOCAL, true), 'offline']] as const) {
    const r = await cleanupJob(ctx, tracker(), 7, 'rejected', 12)
    expect(has(ctx.calls, 'git', 'update-ref')).toBe(false)
    expect(ctx.calls.some(c => c.includes('-D'))).toBe(false)
    expect(r.removed).toEqual([WT, DIR])
    expect(r.kept).toHaveLength(1)
    expect(r.kept[0]!.path).toBe('factory/7')
    expect(r.kept[0]!.reason).toContain(reason)
    expect(r.kept[0]!.command).toMatch(/^git /)
  }
})

test('sweep cleans jobs of closed issues', async () => {
  const ctx = ctxOf([], { [`${DIR}/job.md`]: 'x', '/repo/.factory/worktrees/8/a.txt': 'x' })
  const t = tracker({ closed: [7, 8], labels: { 8: ['factory', 'factory:rejected'] } })
  const r = await sweep(ctx, t)
  expect(ctx.calls).toContainEqual(['rm', '-rf', DIR])
  expect(ctx.calls).toContainEqual(['rm', '-rf', '/repo/.factory/jobs/8'])
  expect(r.removed).toContain('factory/7')
  expect(r.removed).toContain('factory/8')
})

test('sweep leaves the jobs of open issues alone', async () => {
  const ctx = ctxOf([], { [`${DIR}/job.md`]: 'x' })
  const r = await sweep(ctx, tracker({ labels: { 7: ['factory', 'factory:build'] } }))
  expect(has(ctx.calls, 'rm')).toBe(false)
  expect(r.removed).toEqual([])
})

test('sweep skips folders that are not issue numbers', async () => {
  const ctx = ctxOf([], { '/repo/.factory/jobs/setup/checks.md': 'x', '/repo/.factory/worktrees/tmp/a': 'x' })
  const t = tracker()
  const r = await sweep(ctx, t)
  expect(t.log).toEqual(['search label:"factory:docs"'])
  expect(has(ctx.calls, 'rm')).toBe(false)
  expect(r).toEqual({ removed: [], kept: [], finished: [], docs: [] })
})

test('sweep ignores the plan folders', async () => {
  const ctx = ctxOf([], { '/repo/.factory/plans/1/idea.md': 'x', '/repo/.factory/plans/1/product.md': 'x' })
  const t = tracker({ closed: [1] })
  const r = await sweep(ctx, t)
  expect(t.log).toEqual(['search label:"factory:docs"'])
  expect(has(ctx.calls, 'rm')).toBe(false)
  expect(r).toEqual({ removed: [], kept: [], finished: [], docs: [] })
})

test('sweep finishes a ticket in approved or review whose PR was merged on GitHub', async () => {
  for (const label of ['factory:approved', 'factory:review']) {
    const ticket = { ...(await tracker().get(9)), labels: ['factory', label] }
    const ctx = ctxOf([], { '/repo/.factory/jobs/9/job.md': 'x' })
    const t = tracker({ backlog: [ticket], labels: { 9: ['factory', label] }, prs: { 9: { state: 'MERGED' } } })
    const r = await sweep(ctx, t)
    expect(t.log.filter(l => l.startsWith('state'))).toEqual(['state 9 done prMerged']) // folder and backlog name the same ticket
    expect(t.log).toContain('close 9 done')
    expect(ctx.calls).toContainEqual(['rm', '-rf', '/repo/.factory/jobs/9'])
    expect(r.removed).toContain('factory/9')
    expect(r.finished).toEqual(['#9: PR merged on GitHub, set to done'])
  }
})

test('sweep sets the Done option on the board for a merged PR', async () => {
  const ticket = { ...(await tracker().get(9)), labels: ['factory', 'factory:approved'] }
  const ctx = ctxOf(boardReplies)
  const { tracker: t, warnings } = onBoard(ctx, tracker({ backlog: [ticket], prs: { 9: { state: 'MERGED' } } }))
  await sweep(ctx, t)
  expect(boardCalls(ctx.calls)).toEqual(['setState 9 done', 'gh project view', 'gh project field-list', 'gh project item-add', 'gh project item-edit'])
  expect(ctx.calls).toContainEqual(edit('Done'))
  expect(warnings).toEqual([])
})

test('sweep sets done on a closed issue whose PR was merged', async () => {
  const ctx = ctxOf([], { [`${DIR}/job.md`]: 'x' })
  const t = tracker({ closed: [7], labels: { 7: ['factory', 'factory:approved'] }, prs: { 7: { state: 'MERGED' } } })
  const r = await sweep(ctx, t)
  expect(t.log).toContain('state 7 done prMerged')
  expect(t.log.some(l => l.startsWith('close'))).toBe(false)
  expect(ctx.calls).toContainEqual(['rm', '-rf', DIR])
  expect(r.finished).toEqual(['#7: PR merged on GitHub, set to done'])

  const plain = ctxOf([], { [`${DIR}/job.md`]: 'x' })
  const u = tracker({ closed: [7], labels: { 7: ['factory', 'factory:approved'] } })
  const s = await sweep(plain, u)
  expect(u.log.some(l => l.startsWith('state') || l.startsWith('close'))).toBe(false)
  expect(plain.calls).toContainEqual(['rm', '-rf', DIR])
  expect(s.finished).toEqual([])
})

test('sweep does not finish a ticket whose PR is open, closed, missing, or from another branch', async () => {
  const prs: Pr[] = [{ state: 'OPEN' }, { state: 'CLOSED' }, null, { state: 'MERGED', headRefName: 'other' }]
  for (const label of ['factory:needs-human', 'factory:review', 'factory:approved']) {
    for (const pr of prs) {
      const ticket = { ...(await tracker().get(9)), labels: ['factory', label] }
      const ctx = ctxOf()
      const t = tracker({ backlog: [ticket], prs: { 9: pr } })
      const r = await sweep(ctx, t)
      expect(t.log.some(l => l.startsWith('state') || l.startsWith('close'))).toBe(false)
      expect(has(ctx.calls, 'rm')).toBe(false)
      expect(r.finished).toEqual([])
    }
  }
})

test('sweep prunes worktrees and remote refs', async () => {
  const ctx = ctxOf()
  await sweep(ctx, tracker())
  expect(ctx.calls).toContainEqual(['git', 'worktree', 'prune'])
  expect(ctx.calls).toContainEqual(['git', 'fetch', '--prune', 'origin'])
})

test('tool cleanup is registered and refuses a ticket that is still running', async () => {
  const def = TOOLS.find(t => t.name === 'cleanup')!
  expect(def.inputSchema).toMatchObject({ properties: { issue: { type: 'integer', minimum: 1 } } })
  const out = await invoke(def, ctxOf(), { issue: 0 })
  expect(out).toMatchObject({ isError: true })
})

test('tool cleanup refuses an open ticket in a running state and removes nothing', async () => {
  const def = TOOLS.find(t => t.name === 'cleanup')!
  const ticket = JSON.stringify({ number: 7, title: 't', body: '', labels: [{ name: 'factory' }, { name: 'factory:build' }], user: { login: 'a' }, created_at: '2026-01-01T00:00:00Z', html_url: 'u', state: 'open' })
  const ctx = ctxOf([
    { argv: ['gh', 'api', 'repos/a/b/issues/7'], result: { stdout: ticket } },
    { argv: ['gh', 'api'], result: { stdout: '' } },
  ])
  const out = await invoke(def, ctx, { issue: 7 })
  expect(out).toMatchObject({ isError: true })
  expect(out.result).toContain('not-finished')
  expect(has(ctx.calls, 'rm')).toBe(false)
  expect(has(ctx.calls, 'git')).toBe(false)
})

test('sweep records a failing ticket as kept and continues', async () => {
  const ctx = ctxOf([], { [`${DIR}/job.md`]: 'x', '/repo/.factory/jobs/8/job.md': 'x' })
  const t = tracker({ closed: [8] })
  t.get = async (n: number) => {
    if (n === 7) throw new Error('issue gone')
    return (await tracker({ closed: [8] }).get(n))
  }
  const r = await sweep(ctx, t)
  expect(r.kept).toEqual([{ path: DIR, reason: 'issue gone', command: '/factory:cleanup 7' }])
  expect(r.removed).toContain('factory/8')
  expect(ctx.calls).toContainEqual(['git', 'worktree', 'prune'])
  expect(ctx.calls).toContainEqual(['git', 'fetch', '--prune', 'origin'])
})

test('sweep records a failing setState as kept and continues', async () => {
  const a = { ...(await tracker().get(9)), labels: ['factory', 'factory:approved'] }
  const b = { ...(await tracker().get(10)), labels: ['factory', 'factory:approved'] }
  const t = tracker({ backlog: [a, b], prs: { 9: { state: 'MERGED' }, 10: { state: 'MERGED' } } })
  t.setState = async (n: number) => { if (n === 9) throw new Error('label conflict') }
  const r = await sweep(ctxOf(), t)
  expect(r.kept[0]).toMatchObject({ reason: 'label conflict', command: '/factory:cleanup 9' })
  expect(r.removed).toContain('factory/10')
})

test('tool cleanup without an issue sweeps', async () => {
  const def = TOOLS.find(t => t.name === 'cleanup')!
  const ctx = ctxOf()
  const out = await invoke(def, ctx, {})
  expect(out).toEqual({ result: JSON.stringify({ removed: [], kept: [], finished: [], docs: [] }, null, 2) })
  expect(ctx.calls).toContainEqual(['git', 'worktree', 'prune'])
})

const WIKI = { '/repo/.factory/config.json': JSON.stringify({ ...defaultConfig('https://github.com/a/b', 'main', []), docs: { target: 'wiki' } }) }

test('sweep moves a merged job to docs with a wiki target and keeps it', async () => {
  const ctx = ctxOf([], { ...WIKI, '/repo/.factory/jobs/9/job.md': 'x', [`${DIR}/job.md`]: 'x', '/repo/.factory/jobs/8/job.md': 'x' })
  const t = tracker({
    closed: [7],
    labels: { 9: ['factory', 'factory:approved'], 7: ['factory', 'factory:docs'], 8: ['factory', 'factory:docs'] },
    prs: { 9: { state: 'MERGED' }, 7: { state: 'MERGED' }, 8: { state: 'MERGED' } },
  })
  const r = await sweep(ctx, t)
  expect(t.log.filter(l => l.startsWith('state') || l.startsWith('close'))).toEqual(['state 9 docs prMerged'])
  expect(has(ctx.calls, 'rm')).toBe(false)
  expect(has(ctx.calls, 'git', 'worktree', 'remove')).toBe(false)
  expect(r.finished).toEqual(['#9: PR merged on GitHub, set to docs'])
  expect([...r.docs].sort()).toEqual([7, 8, 9])
  expect(r.removed).toEqual([])
  expect(await finishMerged(ctx, t, await t.get(7))).toEqual({ removed: [], kept: [] })
  expect(t.log.filter(l => l.startsWith('state') || l.startsWith('close'))).toEqual(['state 9 docs prMerged'])
})

test('sweep moves a closed needs-human job with a merged PR back to docs', async () => {
  const ctx = ctxOf([], { ...WIKI, [`${DIR}/job.md`]: 'x' })
  const t = tracker({ closed: [7], labels: { 7: ['factory', 'factory:needs-human'] }, prs: { 7: { state: 'MERGED' } } })
  const r = await sweep(ctx, t)
  expect(t.log.filter(l => l.startsWith('state') || l.startsWith('close'))).toEqual(['state 7 docs prMerged'])
  expect(has(ctx.calls, 'rm')).toBe(false)
  expect(has(ctx.calls, 'git', 'worktree', 'remove')).toBe(false)
  expect(r.docs).toEqual([7])
})

test('sweep finds a docs job with no job folder', async () => {
  const ctx = ctxOf([], { ...WIKI, '/repo/.factory/jobs/8/job.md': 'x' })
  const t = tracker({
    labels: { 8: ['factory', 'factory:docs'] },
    search: [{ number: 5, labels: ['factory', 'factory:docs'] }, { number: 8, labels: ['factory', 'factory:docs'] }, { number: 6, labels: ['factory', 'factory:done'] }],
  })
  const r = await sweep(ctx, t)
  expect(t.log).toContain('search label:"factory:docs"')
  expect([...r.docs].sort()).toEqual([5, 8])
})
