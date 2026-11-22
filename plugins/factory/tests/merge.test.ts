import { expect, test } from 'claude-code/testing'
import { defaultConfig } from '../lib/config.ts'
import { intakeComment } from '../lib/job.ts'
import { invoke, type ToolDef } from '../hooks/tools.ts'
import { approve, merge, resolvePair } from '../lib/merge.ts'
import { readJob, renderJob, type Job } from '../lib/jobfile.ts'
import { stateOf } from '../lib/labels.ts'
import { withMarker, type MarkerName } from '../lib/markers.ts'
import { assertTransition } from '../lib/transitions.ts'
import type { Tracker } from '../lib/tracker.ts'
import type { Comment, PrState, State, Ticket } from '../lib/types.ts'
import { boardCalls, boardReplies, edit, onBoard } from './support/board.ts'
import { fakeCtx, type Reply } from './support/host.ts'

const SHA = 'a'.repeat(40)
const HEAD = 'b'.repeat(40)
const NEWBASE = 'c'.repeat(40)
const MOVED = 'd'.repeat(40)
const MERGE = 'e'.repeat(40)
const DIR = '/repo/.factory/jobs/7'
const WT = '/repo/.factory/worktrees/7'
const pkg = JSON.stringify({ name: 'x', scripts: { test: 'vitest' } })
const INTAKE = 'DECISION: ACCEPT\nRISK: high\nSURFACES: security\nLANE: regular\n\n## Summary\nDo it.\n'
const J: Job = {
  issue: 7, title: 'Add thing', jobDir: DIR, worktree: WT, branch: 'factory/7', base: SHA, baseBranch: 'main',
  pr: 9, round: 1, specUpdated: null, reviewed: HEAD, route: { code: 'sonnet' },
}
const at = '2026-02-01T00:00:00Z'
// A second job: #8 with PR #10.
const DIR8 = '/repo/.factory/jobs/8'
const WT8 = '/repo/.factory/worktrees/8'
const J8: Job = { ...J, issue: 8, title: 'Other', jobDir: DIR8, worktree: WT8, branch: 'factory/8', pr: 10 }

type Other = { n: number; labels: string[]; pr?: Partial<PrState> | null; job?: Partial<Job> }
type Opts = { job?: Partial<Job>; labels?: string[]; pr?: Partial<PrState>; author?: string; approved?: boolean; closed?: boolean; noMerge?: boolean; prs?: PrState[]; reads?: Partial<PrState>[]; others?: Other[] }

function tracker(o: Opts = {}) {
  const log: string[] = []
  const states: State[] = []
  const posts: string[] = []
  const reviews: string[] = []
  const merges: { pr: number; subject: string; sha: string }[] = []
  const upserts: { name: string; body: string }[] = []
  const assigns: string[] = []
  let merged = false
  let closed = o.closed ?? false
  const comments: Comment[] = [{ id: 1, author: 'op', body: withMarker('intake', intakeComment({ ...J, ...o.job }, INTAKE)), createdAt: at, updatedAt: at }]
  const issue: Ticket = {
    kind: 'issue', number: 7, title: 'Add thing', body: 'b', author: 'alice', labels: ['factory', ...(o.labels ?? ['factory:approved'])],
    state: 'open', createdAt: at, url: 'u/7', comments,
  }
  const prTicket: Ticket = { ...issue, number: 9, body: 'Closes #7\n', labels: ['factory:pr', 'type:feat'], comments: [] }
  // The other jobs: each has its own labels and comments. events logs what the merge does to them.
  const events: string[] = []
  const others = new Map((o.others ?? []).map(x => [x.n, {
    ...x,
    ticket: { ...issue, number: x.n, title: `Job ${x.n}`, labels: ['factory', ...x.labels], comments: [{ id: 1, author: 'op', body: withMarker('intake', intakeComment({ ...J8, issue: x.n, pr: x.n + 2, ...x.job }, INTAKE)), createdAt: at, updatedAt: at }] } as Ticket,
  }]))
  const ticketOf = (n: number): Ticket => (n === 9 ? prTicket : others.get(n)?.ticket ?? { ...issue, state: closed ? 'closed' : 'open' })
  const pr = (): PrState => ({
    number: 9, state: merged ? 'MERGED' : 'OPEN', isDraft: false, title: 'feat(x): y', body: 'Closes #7\n', author: o.author ?? 'bob',
    headRefName: 'factory/7', headRefOid: HEAD, reviewDecision: o.approved === true ? 'APPROVED' : '', mergeCommit: merged ? MERGE : null, ...o.pr,
  })
  const t = {
    log, states, posts, reviews, merges, upserts, assigns,
    login: async () => 'op',
    assign: async (n: number, on: boolean) => { assigns.push(`${on ? '+' : '-'}${n}`) },
    events,
    backlog: async () => [issue, ...[...others.values()].map(x => x.ticket)],
    get: async (n: number) => ticketOf(n),
    setState: async (n: number, to: State, opts?: { prMerged?: boolean }) => {
      const ticket = ticketOf(n)
      assertTransition(stateOf(ticket.labels) as State | null, to, opts)
      if (n !== 7) {
        events.push(`setState ${n} ${to}`)
        ticket.labels = ['factory', `factory:${to}`]
        return
      }
      states.push(to)
    },
    upsertComment: async (n: number, name: MarkerName, body: string): Promise<Comment> => {
      const c: Comment = { id: 2, author: 'op', body: withMarker(name, body), createdAt: at, updatedAt: at }
      const list = ticketOf(n).comments
      const i = list.findIndex(x => x.body.startsWith(`<!-- factory:${name} -->`))
      if (i >= 0) list[i] = c
      else list.push(c)
      if (n === 7) upserts.push({ name, body })
      else events.push(`upsert ${n} ${name}`)
      return c
    },
    comment: async (n: number, body: string) => {
      if (n === 7) posts.push(body)
      else events.push(`comment ${n} ${body}`)
    },
    close: async (_n: number, reason: string) => { log.push(`close ${reason}`); closed = true },
    findPr: async (b: string) => {
      log.push(`findPr ${b}`)
      const other = [...others.values()].find(x => b === `factory/${x.n}`)
      if (other !== undefined) return other.pr === null ? null : { ...pr(), number: other.n + 2, state: 'OPEN', headRefName: b, ...other.pr }
      return o.prs !== undefined ? (o.prs[0] ?? null) : pr()
    },
    prState: async () => ({ ...pr(), ...o.reads?.shift() }),
    approvePr: async (_pr: number, body: string) => { reviews.push(body) },
    prReady: async (p: number) => { log.push(`ready ${p}`) },
    merge: async (p: number, subject: string, sha: string) => {
      log.push(`merge ${p}`)
      merges.push({ pr: p, subject, sha })
      if (!o.noMerge) merged = true
    },
  }
  return t as unknown as Tracker & typeof t
}

function setup(o: Opts = {}, over: Reply[] = [], files: Record<string, string> = {}) {
  const ctx = fakeCtx({
    files: {
      '/repo/.factory/config.json': JSON.stringify(defaultConfig('u', 'main', [{ id: 'node', path: '.' }])),
      '/repo/package.json': pkg,
      [WT]: '',
      [`${WT}/package.json`]: pkg,
      [`${DIR}/job.md`]: renderJob({ ...J, ...o.job }),
      [`${DIR}/intake.md`]: INTAKE,
      [`${DIR}/spec.md`]: 'STATUS: READY\nTitle: feat(x): y\n',
      ...Object.fromEntries((o.others ?? []).flatMap(x => {
        const dir = `/repo/.factory/jobs/${x.n}`
        return [
          [`/repo/.factory/worktrees/${x.n}`, ''],
          [`${dir}/job.md`, renderJob({ ...J8, issue: x.n, jobDir: dir, worktree: `/repo/.factory/worktrees/${x.n}`, branch: `factory/${x.n}`, pr: x.n + 2, ...x.job })],
          [`${dir}/intake.md`, INTAKE],
          [`${dir}/spec.md`, 'STATUS: READY\nTitle: feat(x): z\n'],
        ]
      })),
      ...files,
    },
    replies: [
      ...over,
      ...(o.others ?? []).map(x => ({ argv: ['git', '-C', `/repo/.factory/worktrees/${x.n}`, 'rev-parse', 'HEAD'], result: { stdout: `${HEAD}\n` } })),
      { argv: ['git', '-C', WT, 'rev-parse', 'HEAD'], result: { stdout: `${HEAD}\n` } },
      { argv: ['git', '-C', WT, 'merge-base', 'HEAD', 'origin/main'], result: { stdout: `${NEWBASE}\n` } },
      { argv: ['git', '-C', WT, 'show', `${NEWBASE}:package.json`], result: { stdout: pkg } },
      { argv: ['git', '-C', WT, 'show'], result: { exitCode: 128 } },
      { argv: ['git', '-C', WT, 'ls-files'], result: { stdout: 'package.json\n' } },
      { argv: ['git', '-C', WT, 'log'], result: { stdout: '' } },
      { argv: [] },
    ],
  })
  return { ctx, t: tracker(o) }
}

const count = (calls: string[][], ...prefix: string[]): number => calls.filter(c => prefix.every((p, i) => c[i] === p)).length
const idx = (calls: string[][], ...prefix: string[]): number => calls.findIndex(c => prefix.every((p, i) => c[i] === p))
const rejects = (p: Promise<unknown>, code: string): Promise<void> => expect(p).rejects.toMatchObject({ code })

test('resolvePair accepts an issue number', async () => {
  const { ctx, t } = setup()
  expect(await resolvePair(ctx, t, 7)).toMatchObject({ issue: 7, pr: { number: 9 } })
})

test('resolvePair accepts a PR number', async () => {
  const { ctx, t } = setup()
  expect(await resolvePair(ctx, t, 9)).toMatchObject({ issue: 7, pr: { number: 9 } })
})

test('resolvePair rejects a PR whose head is not factory/<i>', async () => {
  const { ctx, t } = setup({ pr: { headRefName: 'factory/8' } })
  await rejects(resolvePair(ctx, t, 9), 'no-pair')
})

test('resolvePair rejects an issue whose PR head is not factory/<n>', async () => {
  const { ctx, t } = setup({ pr: { headRefName: 'evil/branch' } })
  await rejects(resolvePair(ctx, t, 7), 'no-pair')
})

test('resolvePair rejects an issue without a PR', async () => {
  const { ctx, t } = setup({ prs: [] })
  await rejects(resolvePair(ctx, t, 7), 'no-pair')
})

test('resolvePair rejects a number without a status label or factory:pr', async () => {
  const { ctx, t } = setup({ labels: [] })
  await rejects(resolvePair(ctx, t, 7), 'no-pair')
})

test('approve on an own PR writes a comment', async () => {
  const { ctx, t } = setup({ author: 'op' })
  const r = await approve(ctx, t, 7)
  expect(r).toEqual({ issue: 7, pr: 9, how: 'comment' })
  expect(t.upserts).toEqual([{ name: 'approval', body: `Approved by @op for merge. Reviewed commit: ${HEAD}.` }])
  expect(t.reviews).toEqual([])
  expect(t.states).toEqual([])
})

test('approve on a foreign PR approves', async () => {
  const { ctx, t } = setup({ author: 'bob' })
  const r = await approve(ctx, t, 7)
  expect(r).toEqual({ issue: 7, pr: 9, how: 'review' })
  expect(t.reviews).toEqual([`Approved by @op for merge. Reviewed commit: ${HEAD}.`])
  expect(t.upserts).toEqual([])
})

test('approve refuses a job that is not approved or needs-human', async () => {
  for (const label of ['factory:review', 'factory:build']) {
    const { ctx, t } = setup({ labels: [label] })
    await rejects(approve(ctx, t, 7), 'bad-state')
    expect(t.upserts).toEqual([])
    expect(t.reviews).toEqual([])
  }
})

test('approve accepts needs-human', async () => {
  const { ctx, t } = setup({ labels: ['factory:needs-human'], author: 'op' })
  expect((await approve(ctx, t, 7)).how).toBe('comment')
})

test('merge refuses a job that is still in review', async () => {
  const { ctx, t } = setup({ labels: ['factory:review'] })
  await rejects(merge(ctx, t, 7), 'bad-state')
  expect(t.merges).toEqual([])
  expect(count(ctx.calls, 'git', '-C', WT, 'merge')).toBe(0)
})

test('merge refuses a PR that is not open', async () => {
  const { ctx, t } = setup({ pr: { state: 'CLOSED' } })
  await rejects(merge(ctx, t, 7), 'bad-state')
  expect(t.merges).toEqual([])
  expect(t.states).toEqual([])
  expect(t.log.some(l => l.startsWith('close'))).toBe(false)
  expect(ctx.calls.some(c => c[0] === 'rm')).toBe(false)
})

test('merge of a PR merged on GitHub sets done and cleans up', async () => {
  for (const label of ['factory:review', 'factory:approved']) {
    const { ctx, t } = setup({ labels: [label], pr: { state: 'MERGED', mergeCommit: MERGE } })
    const r = await merge(ctx, t, 7)
    expect(r).toMatchObject({ issue: 7, pr: 9, head: HEAD, mergeCommit: MERGE, alreadyMerged: true })
    expect(t.states).toEqual(['done'])
    expect(t.log).toContain('close done')
    expect(t.merges).toEqual([])
    expect(count(ctx.calls, 'git', '-C', WT, 'merge')).toBe(0)
    expect(count(ctx.calls, 'git', '-C', WT, 'push')).toBe(0)
    expect(idx(ctx.calls, 'vp')).toBe(-1)
    expect(ctx.calls).toContainEqual(['rm', '-rf', DIR])
    expect(r.cleanup.removed).toContain(DIR)
  }
  const { ctx, t } = setup({ labels: ['factory:done'], closed: true, pr: { state: 'MERGED' } })
  await merge(ctx, t, 7)
  expect(t.states).toEqual([])
  expect(t.log).not.toContain('close done')
})

test('merge sets the Done option on the board', async () => {
  const { ctx, t } = setup({ labels: ['factory:approved'], pr: { state: 'MERGED', mergeCommit: MERGE } }, boardReplies)
  const { tracker, warnings } = onBoard(ctx, t)
  await merge(ctx, tracker, 7)
  expect(boardCalls(ctx.calls)).toEqual(['setState 7 done', 'gh project view', 'gh project field-list', 'gh project item-add', 'gh project item-edit'])
  expect(ctx.calls).toContainEqual(edit('Done'))
  expect(warnings).toEqual([])
})

const CONFLICT: Reply ={ argv: ['git', '-C', WT, 'merge', '--no-edit'], result: { exitCode: 1, stderr: 'CONFLICT' } }
const MERGE_HEAD = ['git', '-C', WT, 'rev-parse', '-q', '--verify', 'MERGE_HEAD']

test('a sync conflict says that the merge was undone', async () => {
  const { ctx, t } = setup({}, [CONFLICT, { argv: MERGE_HEAD, result: { stdout: `${HEAD}\n` } }])
  const err = (await merge(ctx, t, 7).catch((e: unknown) => e)) as { code: string; fix: string }
  expect(err.code).toBe('sync-conflict')
  expect(err.fix).not.toContain('in the worktree')
  expect(err.fix).toContain('undid')
})

test('a failed sync without MERGE_HEAD is not a conflict', async () => {
  const fail: Reply = { argv: ['git', '-C', WT, 'merge', '--no-edit'], result: { exitCode: 128, stderr: 'fatal: Unable to create index.lock' } }
  const { ctx, t } = setup({}, [fail, { argv: MERGE_HEAD, result: { exitCode: 1 } }])
  const err = (await merge(ctx, t, 7).catch((e: unknown) => e)) as { code: string; message: string }
  expect(err.code).toBe('sync-failed')
  expect(err.message).toContain('index.lock')
  expect(ctx.calls).not.toContainEqual(['git', '-C', WT, 'merge', '--abort'])
  expect(t.states).toEqual([])
  expect(t.posts).toEqual([])
  expect(t.merges).toEqual([])
})

test('a sync conflict starts a new build round', async () => {
  const { ctx, t } = setup({}, [CONFLICT])
  const err = (await merge(ctx, t, 7).catch((e: unknown) => e)) as { code: string; fix: string }
  expect(err.code).toBe('sync-conflict')
  expect(err.fix).toContain('round 2')
  expect(err.fix).not.toContain('Send the job back')
  expect(ctx.calls).toContainEqual(['git', '-C', WT, 'merge', '--abort'])
  expect(t.states).toEqual(['build'])
  const job = await readJob(ctx, 7)
  expect(job.round).toBe(2)
  expect(job.reviewed).toBe(null)
  const sync = await ctx.fs.read(`${DIR}/round-2/sync.md`)
  expect(sync).toContain('origin/main')
  expect(sync).toContain('conflict')
  expect(t.posts).toHaveLength(1)
  expect(t.posts[0]).toContain('conflict')
  expect(t.posts[0]?.startsWith('Factory stopped:')).toBe(false)
  expect(t.merges).toEqual([])
  expect(count(ctx.calls, 'git', '-C', WT, 'push')).toBe(0)
})

test('a sync conflict from needs-human starts a new build round', async () => {
  const { ctx, t } = setup({ labels: ['factory:needs-human'] }, [CONFLICT])
  await rejects(merge(ctx, t, 7), 'sync-conflict')
  expect(ctx.calls).toContainEqual(['git', '-C', WT, 'merge', '--abort'])
  expect(t.states).toEqual(['build'])
  expect((await readJob(ctx, 7)).round).toBe(2)
  expect(await ctx.fs.exists(`${DIR}/round-2/sync.md`)).toBe(true)
  expect(t.merges).toEqual([])
})

test('a sync conflict at the round limit sets needs-human', async () => {
  const { ctx, t } = setup({ job: { round: 3 } }, [CONFLICT])
  await rejects(merge(ctx, t, 7), 'sync-conflict-limit')
  expect(t.states).toEqual(['needs-human'])
  expect(t.posts.some(p => p.startsWith('Factory stopped: Round limit'))).toBe(true)
  expect(await ctx.fs.exists(`${DIR}/round-4/sync.md`)).toBe(false)
  expect(await ctx.fs.exists(`${DIR}/round-3/sync.md`)).toBe(false)
  expect(t.merges).toEqual([])
})

test('a sync conflict keeps the factory as assignee', async () => {
  const { ctx, t } = setup({}, [CONFLICT])
  await rejects(merge(ctx, t, 7), 'sync-conflict')
  expect(t.assigns).toEqual(['+7', '+9'])
})

test('merge syncs with origin/<base> from the config', async () => {
  const { ctx, t } = setup()
  await merge(ctx, t, 7)
  expect(ctx.calls).toContainEqual(['git', '-C', WT, 'fetch', 'origin', 'main'])
  expect(ctx.calls).toContainEqual(['git', '-C', WT, 'merge', '--no-edit', '-m', 'chore(factory): sync with main', '-m', 'Refs: #7', 'origin/main'])
})

test('the sync commit names the issue, not the PR, in its footer', async () => {
  const { ctx, t } = setup()
  await merge(ctx, t, 9)
  expect(ctx.calls).toContainEqual(['git', '-C', WT, 'merge', '--no-edit', '-m', 'chore(factory): sync with main', '-m', 'Refs: #7', 'origin/main'])
})

test('merge refuses when the gate fails after sync', async () => {
  const { ctx, t } = setup({}, [{ argv: ['vp', 'lint'], result: { exitCode: 1 } }])
  await rejects(merge(ctx, t, 7), 'gate-failed')
  expect(count(ctx.calls, 'git', '-C', WT, 'push')).toBe(0)
  expect(t.merges).toEqual([])
  expect(t.states).toEqual([])
})

test('a forged checks.md with VERDICT: PASS does not help', async () => {
  const { ctx, t } = setup({}, [{ argv: ['vp', 'lint'], result: { exitCode: 1 } }], { [`${DIR}/merge/checks.md`]: 'VERDICT: PASS\n' })
  await rejects(merge(ctx, t, 7), 'gate-failed')
  expect(t.merges).toEqual([])
})

test('merge runs the gate before the push and pushes the gated sha', async () => {
  const { ctx, t } = setup()
  await merge(ctx, t, 7)
  const push = ['git', '-C', WT, 'push', 'origin', `${HEAD}:refs/heads/factory/7`]
  expect(ctx.calls).toContainEqual(push)
  expect(idx(ctx.calls, 'vp')).toBeGreaterThan(-1)
  expect(idx(ctx.calls, 'vp')).toBeLessThan(idx(ctx.calls, ...push))
  expect(ctx.files[`${DIR}/merge/checks.md`]?.startsWith('VERDICT: PASS')).toBe(true)
})

test('merge stops when HEAD moved during the gate', async () => {
  const { ctx, t } = setup()
  const inner = ctx.run
  ctx.run = (async (argv, opts) => {
    const r = await inner(argv, opts)
    const ran = ctx.calls.some(c => c[0] === 'vp')
    if (ran && argv.join(' ') === `git -C ${WT} rev-parse HEAD`) return { exitCode: 0, stdout: `${MOVED}\n`, stderr: '' }
    return r
  }) as typeof inner
  await rejects(merge(ctx, t, 7), 'gate-not-green')
  expect(count(ctx.calls, 'git', '-C', WT, 'push')).toBe(0)
  expect(t.merges).toEqual([])
})

test('a rejected push after the gate returns an error text with a Fix line', async () => {
  const { ctx, t } = setup()
  const inner = ctx.run
  ctx.run = (async (argv, opts) => {
    if (argv[0] === 'git' && argv[2] === WT && argv[3] === 'push') throw new Error('timed out after 120000 ms')
    return inner(argv, opts)
  }) as typeof inner
  const def: ToolDef = { name: 'merge', description: 'd', inputSchema: {}, handler: () => merge(ctx, t, 7) }
  const r = await invoke(def, ctx, {})
  expect(r).toEqual({ isError: true, result: 'internal: merge: timed out after 120000 ms\nFix: Read the error, fix the cause, then call the tool again.' })
  expect(count(ctx.calls, 'vp')).toBeGreaterThan(0)
  expect(t.merges).toEqual([])
  expect(t.states).toEqual([])
})

test('merge stops when the PR head differs from the pushed sha', async () => {
  const { ctx, t } = setup({ reads: [{ headRefOid: MOVED }] })
  await rejects(merge(ctx, t, 7), 'head-mismatch')
  expect(ctx.sleeps).toEqual([])
  expect(t.merges).toEqual([])
  expect(t.states).toEqual([])
})

test('merge stops at once when the PR head branch is wrong', async () => {
  const { ctx, t } = setup({ reads: [{ headRefName: 'other' }] })
  await rejects(merge(ctx, t, 7), 'head-mismatch')
  expect(ctx.sleeps).toEqual([])
  expect(t.merges).toEqual([])
  expect(t.states).toEqual([])
})

// The sync makes the new commit SYNCED, so the PR head HEAD from findPr is the old head.
const SYNCED = 'e'.repeat(40)
function synced(ctx: ReturnType<typeof setup>['ctx']): void {
  const inner = ctx.run
  ctx.run = (async (argv, opts) => {
    const r = await inner(argv, opts)
    const after = ctx.calls.some(c => c[3] === 'merge' && c[4] === '--no-edit')
    if (after && argv.join(' ') === `git -C ${WT} rev-parse HEAD`) return { exitCode: 0, stdout: `${SYNCED}\n`, stderr: '' }
    return r
  }) as typeof inner
}

test('merge waits while the PR still shows the old head', async () => {
  const { ctx, t } = setup({ reads: [{ headRefOid: HEAD }, { headRefOid: HEAD }, { headRefOid: SYNCED }] })
  synced(ctx)
  await merge(ctx, t, 7)
  expect(ctx.sleeps).toEqual([1000, 1000])
  expect(t.merges).toEqual([{ pr: 9, subject: 'feat(x): y (#9)', sha: SYNCED }])
})

test('merge stops with head-mismatch after the read limit', async () => {
  const { ctx, t } = setup({ reads: Array.from({ length: 10 }, () => ({ headRefOid: HEAD })) })
  synced(ctx)
  await rejects(merge(ctx, t, 7), 'head-mismatch')
  expect(ctx.sleeps).toEqual(Array(9).fill(1000))
  expect(t.merges).toEqual([])
  expect(t.states).toEqual([])
})

test('merge writes the synced merge-base as Base to job.md and the intake comment', async () => {
  const { ctx, t } = setup()
  await merge(ctx, t, 7)
  expect(ctx.files[`${DIR}/job.md`]).toContain(`- Base: ${NEWBASE}\n`)
  expect(t.upserts.find(u => u.name === 'intake')!.body).toContain(`- Base: ${NEWBASE}\n`)
})

test('merge compares the gate against the new Base', async () => {
  const { ctx, t } = setup({ noMerge: true })
  await rejects(merge(ctx, t, 7), 'merge-failed') // no cleanup, so job.md stays
  expect((await readJob(ctx, 7)).base).toBe(NEWBASE)
  expect(ctx.calls.some(c => c.includes(`${NEWBASE}..HEAD`))).toBe(true)
  expect(ctx.calls.some(c => c.includes(`${SHA}..HEAD`))).toBe(false)
})

test('merge uses the PR title as subject and pins the sha', async () => {
  const { ctx, t } = setup()
  await merge(ctx, t, 7)
  expect(t.merges).toEqual([{ pr: 9, subject: 'feat(x): y (#9)', sha: HEAD }])
})

test('merge approves when no approval is recorded, and not when one is', async () => {
  const a = setup()
  await merge(a.ctx, a.t, 7)
  expect(a.t.reviews).toEqual([`Approved by @op for merge. Reviewed commit: ${HEAD}.`])
  const b = setup({ approved: true })
  await merge(b.ctx, b.t, 7)
  expect(b.t.reviews).toEqual([])
  expect(b.t.upserts.some(u => u.name === 'approval')).toBe(false)
})

test('approve refuses a job with no reviewed commit', async () => {
  const { ctx, t } = setup({ author: 'op', job: { reviewed: null } })
  await rejects(approve(ctx, t, 7), 'not-reviewed')
  expect(t.upserts).toEqual([])
})

test('merge records the approval again when it names another commit', async () => {
  const { ctx, t } = setup({ author: 'op' })
  await t.upsertComment(7, 'approval', `Approved by @op for merge. Reviewed commit: ${MOVED}.`)
  t.upserts.length = 0
  await merge(ctx, t, 7)
  expect(t.upserts.filter(u => u.name === 'approval')).toEqual([{ name: 'approval', body: `Approved by @op for merge. Reviewed commit: ${HEAD}.` }])
})

test('merge refuses a job with no reviewed commit', async () => {
  const { ctx, t } = setup({ job: { reviewed: null } })
  await rejects(merge(ctx, t, 7), 'not-reviewed')
  expect(count(ctx.calls, 'git', '-C', WT, 'merge')).toBe(0)
  expect(t.merges).toEqual([])
})

const TREE = 'f'.repeat(40)
const moved = (parents: string, tree = TREE): Reply[] => [
  { argv: ['git', '-C', WT, 'rev-parse', 'HEAD'], result: { stdout: `${MOVED}\n` } },
  { argv: ['git', '-C', WT, 'rev-list', '--parents', '-n', '1', MOVED], result: { stdout: `${MOVED} ${parents}\n` } },
  { argv: ['git', '-C', WT, 'merge-tree', '--write-tree'], result: { stdout: `${TREE}\n` } },
  { argv: ['git', '-C', WT, 'rev-parse', `${MOVED}^{tree}`], result: { stdout: `${tree}\n` } },
]

for (const [what, parents, tree] of [
  ['a commit on top of the reviewed commit', HEAD, TREE],
  ['a merge of another commit', `${SHA} ${NEWBASE}`, TREE],
  ['a merge with a changed tree', `${HEAD} ${NEWBASE}`, MOVED],
] as const) {
  test(`merge refuses when HEAD is ${what}`, async () => {
    const { ctx, t } = setup({ pr: { headRefOid: MOVED } }, moved(parents, tree))
    await rejects(merge(ctx, t, 7), 'not-reviewed')
    expect(count(ctx.calls, 'git', '-C', WT, 'merge', '--no-edit')).toBe(0)
    expect(count(ctx.calls, 'git', '-C', WT, 'push')).toBe(0)
    expect(t.states).toEqual([])
    expect(t.merges).toEqual([])
  })
}

test('merge accepts a clean sync merge of the reviewed commit and the base', async () => {
  const { ctx, t } = setup({ pr: { headRefOid: MOVED } }, moved(`${HEAD} ${NEWBASE}`))
  await merge(ctx, t, 7)
  expect(ctx.calls).toContainEqual(['git', '-C', WT, 'merge-base', '--is-ancestor', NEWBASE, 'origin/main'])
  expect(t.merges).toEqual([{ pr: 9, subject: 'feat(x): y (#9)', sha: MOVED }])
})

test('merge sets done, closes the issue and cleans up', async () => {
  const { ctx, t } = setup()
  const r = await merge(ctx, t, 7)
  expect(r).toMatchObject({ issue: 7, pr: 9, head: HEAD })
  expect(t.states).toEqual(['done'])
  expect(t.log).toContain('close done')
  expect(ctx.calls).toContainEqual(['rm', '-rf', DIR])
  expect(r.cleanup.removed).toContain(DIR)
})

test('merge reports the merge commit, not the branch head', async () => {
  const { ctx, t } = setup()
  const r = await merge(ctx, t, 7)
  expect(r).toMatchObject({ head: HEAD, mergeCommit: MERGE, alreadyMerged: false })
  expect(r).not.toHaveProperty('sha')
})

test('merge returns a null merge commit when GitHub gives none', async () => {
  const { ctx, t } = setup({ pr: { mergeCommit: null } })
  const r = await merge(ctx, t, 7)
  expect(r.mergeCommit).toBe(null)
  expect(t.states).toEqual(['done'])
  expect(ctx.calls).toContainEqual(['rm', '-rf', DIR])
})

test('merge unassigns the factory from the issue and the PR', async () => {
  const { ctx, t } = setup()
  await merge(ctx, t, 7)
  expect(t.assigns).toEqual(['-7', '-9'])
})

test('merge does not close an issue that GitHub already closed', async () => {
  const { ctx, t } = setup({ closed: true })
  await merge(ctx, t, 7)
  expect(t.log).not.toContain('close done')
})

test('merge readies a draft PR before the merge', async () => {
  const { ctx, t } = setup({ labels: ['factory:needs-human'], pr: { isDraft: true } })
  await merge(ctx, t, 7)
  expect(t.log.indexOf('ready 9')).toBeGreaterThan(-1)
  expect(t.log.indexOf('ready 9')).toBeLessThan(t.log.indexOf('merge 9'))
})

test('merge does not ready a PR that is not a draft', async () => {
  const { ctx, t } = setup()
  await merge(ctx, t, 7)
  expect(t.log).not.toContain('ready 9')
})

test('merge from needs-human is allowed', async () => {
  const { ctx, t } = setup({ labels: ['factory:needs-human'] })
  await merge(ctx, t, 7)
  expect(t.states).toEqual(['done'])
})

test('merge does not set done when the PR is not merged afterwards', async () => {
  const { ctx, t } = setup({ noMerge: true })
  await rejects(merge(ctx, t, 7), 'merge-failed')
  expect(t.states).toEqual([])
  expect(count(ctx.calls, 'rm')).toBe(0)
})

test('merge refuses when job.md names another PR', async () => {
  const { ctx, t } = setup({ pr: { number: 10 } })
  await rejects(merge(ctx, t, 7), 'bad-pr')
  expect(t.merges).toEqual([])
})

// The first sync of a chain: a merge of the reviewed commit and the base, under the head MOVED.
const STEP = '1'.repeat(40)
const step = (parents: string): Reply[] => [
  { argv: ['git', '-C', WT, 'rev-list', '--parents', '-n', '1', STEP], result: { stdout: `${STEP} ${parents}\n` } },
  { argv: ['git', '-C', WT, 'rev-parse', `${STEP}^{tree}`], result: { stdout: `${TREE}\n` } },
]

test('merge accepts two clean sync merges on top of the reviewed commit', async () => {
  const { ctx, t } = setup({ pr: { headRefOid: MOVED } }, [...moved(`${STEP} ${NEWBASE}`), ...step(`${HEAD} ${SHA}`)])
  await merge(ctx, t, 7)
  expect(ctx.calls).toContainEqual(['git', '-C', WT, 'merge-base', '--is-ancestor', SHA, 'origin/main'])
  expect(ctx.calls).toContainEqual(['git', '-C', WT, 'merge-tree', '--write-tree', HEAD, SHA])
  expect(t.merges).toEqual([{ pr: 9, subject: 'feat(x): y (#9)', sha: MOVED }])
})

test('merge refuses a sync chain with an unreviewed commit', async () => {
  const { ctx, t } = setup({ pr: { headRefOid: MOVED } }, [...moved(`${STEP} ${NEWBASE}`), ...step(HEAD)])
  await rejects(merge(ctx, t, 7), 'not-reviewed')
  // The top step is a clean sync: the walk refuses the commit under it.
  expect(ctx.calls).toContainEqual(['git', '-C', WT, 'rev-list', '--parents', '-n', '1', STEP])
  expect(count(ctx.calls, 'git', '-C', WT, 'merge', '--no-edit')).toBe(0)
  expect(count(ctx.calls, 'git', '-C', WT, 'push')).toBe(0)
  expect(t.merges).toEqual([])
})

test('a sync conflict from approved sends the job to build', async () => {
  const { ctx, t } = setup({}, [CONFLICT])
  const err = (await merge(ctx, t, 7).catch((e: unknown) => e)) as { code: string; fix: string }
  expect(err.code).toBe('sync-conflict')
  expect(err.fix).toContain('/factory:run 7')
  expect(t.states).toEqual(['build'])
  expect((await readJob(ctx, 7)).round).toBe(2)
  expect(ctx.calls).toContainEqual(['git', '-C', WT, 'merge', '--abort'])
  expect(count(ctx.calls, 'git', '-C', WT, 'push')).toBe(0)
  expect(t.merges).toEqual([])
})

const syncArgv = (wt: string, n: number): string[] => ['git', '-C', wt, 'merge', '--no-edit', '-m', 'chore(factory): sync with main', '-m', `Refs: #${n}`, 'origin/main']
const at8 = (calls: string[][], argv: string[]): number => calls.findIndex(c => c.join(' ') === argv.join(' '))

test('merge syncs each other approved job after the merge', async () => {
  const { ctx, t } = setup({ others: [{ n: 8, labels: ['factory:approved'] }] })
  const r = await merge(ctx, t, 7)
  expect(r.syncs).toEqual([{ issue: 8, outcome: 'synced' }])
  const fetch = at8(ctx.calls, ['git', '-C', WT8, 'fetch', 'origin', 'main'])
  const sync = at8(ctx.calls, syncArgv(WT8, 8))
  const push = at8(ctx.calls, ['git', '-C', WT8, 'push', 'origin', 'HEAD:refs/heads/factory/8'])
  expect(fetch).toBeGreaterThan(at8(ctx.calls, ['rm', '-rf', DIR]))
  expect(fetch).toBeLessThan(sync)
  expect(sync).toBeLessThan(push)
  expect(count(ctx.calls, 'git', '-C', WT8, 'push')).toBe(1)
  expect(t.states).toEqual(['done'])
  expect(t.events.filter(e => e.startsWith('setState'))).toEqual([])
})

test('merge does not sync jobs outside approved', async () => {
  const others = ['build', 'review', 'needs-human', 'spec'].map((s, i) => ({ n: 20 + i * 10, labels: [`factory:${s}`] }))
  const { ctx, t } = setup({ others })
  const r = await merge(ctx, t, 7)
  expect(r.syncs).toEqual([])
  for (const o of others) expect(ctx.calls.some(c => c[2] === `/repo/.factory/worktrees/${o.n}`)).toBe(false)
  expect(t.events).toEqual([])
})

test('a sync conflict in another job sends it to build', async () => {
  const conflict: Reply = { argv: ['git', '-C', WT8, 'merge', '--no-edit'], result: { exitCode: 1, stderr: 'CONFLICT' } }
  const { ctx, t } = setup({ others: [{ n: 8, labels: ['factory:approved'] }] }, [conflict])
  const r = await merge(ctx, t, 7)
  expect(r.syncs).toEqual([{ issue: 8, outcome: 'conflict', state: 'build' }])
  expect(ctx.calls).toContainEqual(['git', '-C', WT8, 'merge', '--abort'])
  expect(count(ctx.calls, 'git', '-C', WT8, 'push')).toBe(0)
  const posts = t.events.filter(e => e.startsWith('comment 8 '))
  expect(posts.length).toBe(1)
  expect(posts[0]).toContain('The builder merges origin/main')
  expect(await ctx.fs.exists(`${DIR8}/round-2/sync.md`)).toBe(true)
  expect(t.events).toContain('setState 8 build')
  expect((await readJob(ctx, 8)).round).toBe(2)
  expect(t.states).toEqual(['done'])

  const limit = setup({ others: [{ n: 8, labels: ['factory:approved'], job: { round: 3 } }] }, [conflict])
  const l = await merge(limit.ctx, limit.t, 7)
  expect(l.syncs).toEqual([{ issue: 8, outcome: 'conflict', state: 'needs-human' }])
  expect(limit.t.events).toContain('setState 8 needs-human')
})

test('a failed sync of one job does not stop the others', async () => {
  const others = [8, 20, 30, 40].map(n => ({ n, labels: ['factory:approved'] }))
  const WT30 = '/repo/.factory/worktrees/30'
  const { ctx, t } = setup({ others }, [
    { argv: ['git', '-C', WT8, 'fetch'], result: { exitCode: 1, stderr: 'fetch boom' } },
    { argv: ['git', '-C', WT30, 'rev-parse', 'HEAD'], result: { stdout: `${MOVED}\n` } },
    { argv: ['git', '-C', WT30, 'rev-list', '--parents', '-n', '1', MOVED], result: { stdout: `${MOVED} ${HEAD}\n` } },
    { argv: ['git', '-C', '/repo/.factory/worktrees/40', 'push'], result: { exitCode: 1, stderr: 'push rejected' } },
  ])
  const r = await merge(ctx, t, 7)
  expect(r.syncs).toMatchObject([
    { issue: 8, outcome: 'failed', error: expect.stringContaining('fetch boom') },
    { issue: 20, outcome: 'synced' },
    { issue: 30, outcome: 'failed', error: expect.stringContaining('not the reviewed commit') },
    { issue: 40, outcome: 'failed', error: expect.stringContaining('push rejected') },
  ])
  expect(count(ctx.calls, 'git', '-C', WT30, 'merge')).toBe(0)
  expect(count(ctx.calls, 'git', '-C', WT30, 'push')).toBe(0)
  expect(t.states).toEqual(['done'])
  expect(t.events.filter(e => e.startsWith('setState'))).toEqual([])
})

test('a failed backlog read does not fail a merge that is done', async () => {
  const { ctx, t } = setup({ others: [{ n: 8, labels: ['factory:approved'] }] })
  t.backlog = async () => { throw new Error('backlog boom') }
  const r = await merge(ctx, t, 7)
  expect(r).toMatchObject({ head: HEAD, mergeCommit: MERGE, alreadyMerged: false })
  expect(r.cleanup.removed).toContain(DIR)
  expect(t.states).toEqual(['done'])
  expect(r.syncs).toEqual([{ outcome: 'backlog-failed', error: expect.stringContaining('backlog boom') }])
  expect(ctx.calls.some(c => c[2] === WT8)).toBe(false)
})
