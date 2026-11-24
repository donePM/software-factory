import { expect, test } from 'claude-code/testing'
import { defaultConfig } from '../lib/config.ts'
import { jobAdvance, jobSync, roundSummary, intakeComment } from '../lib/job.ts'
import { forgetGates, gateJob, passedAt } from '../lib/gatejob.ts'
import { parseIntake } from '../lib/intake.ts'
import { renderJob, readJob, type Job } from '../lib/jobfile.ts'
import { stateOf } from '../lib/labels.ts'
import { withMarker, type MarkerName } from '../lib/markers.ts'
import { route } from '../lib/route.ts'
import { assertTransition } from '../lib/transitions.ts'
import type { Tracker } from '../lib/tracker.ts'
import type { Comment, State, Ticket } from '../lib/types.ts'
import { invoke, TOOLS } from '../hooks/tools.ts'
import { boardCalls, boardReplies, edit, ON, onBoard } from './support/board.ts'
import { fakeCtx, type Reply } from './support/host.ts'

const SHA = 'a'.repeat(40)
const HEAD = 'b'.repeat(40)
const MOVED = 'd'.repeat(40)
const DIR = '/repo/.factory/jobs/7'
const WT = '/repo/.factory/worktrees/7'
const cfgOf = (maxRounds = 3): string =>
  JSON.stringify({ ...defaultConfig('u', 'main', [{ id: 'node', path: '.' }]), maxRounds })
const pkg = JSON.stringify({ name: 'x', scripts: { test: 'vitest' } })

const J: Job = {
  issue: 7, title: 'Add thing', jobDir: DIR, worktree: WT, branch: 'factory/7', base: SHA, baseBranch: 'main',
  pr: null, round: 0, specUpdated: null, reviewed: null, route: { code: 'sonnet', security: 'opus' }, language: 'English',
}
const INTAKE = 'DECISION: ACCEPT\nRISK: high\nSURFACES: security\nLANE: regular\n\n## Summary\nDo it.\n\n## Scope\nsmall\n'
const SPEC = 'STATUS: READY\nTitle: feat: add thing\n\n## Summary\nx\n'
const BUILD = 'STATUS: DONE\n\n## Summary\nBuilt the thing.\n'
const rv = (verdict: 'PASS' | 'CHANGES', blocker = ''): string =>
  `VERDICT: ${verdict}\n\n## Summary\nok\n\n## Findings\n${blocker === '' ? '' : `1. [blocker] ${blocker}\n`}`
const APPROVE = 'DECISION: APPROVE\n\n## Summary\nGood.\n'
const ESCALATE = 'DECISION: ESCALATE\n\n## Summary\nUnsure.\n\n## Question\nPublic API?\n'

type Run = { ctx: ReturnType<typeof fakeCtx>; t: ReturnType<typeof tracker> }

function tracker(labels: string[], author = 'alice', initial: Comment[] = [], head = 'factory/7', draft = false, readyError?: string) {
  const log: string[] = []
  const comments: { name: string; body: string }[] = []
  const posts: string[] = []
  const prs: { branch: string; base: string; title: string; body: string; labels: string[] }[] = []
  const prComments: string[] = []
  const states: State[] = []
  const assigns: string[] = []
  const ticket: Ticket = {
    kind: 'issue', number: 7, title: 'Add thing', body: 'b', author, labels: ['factory', ...labels],
    state: 'open', createdAt: '2026-01-01T00:00:00Z', url: 'u/7', comments: initial,
  }
  const t = {
    log, comments, posts, prs, prComments, states, assigns,
    repo: 'a/b',
    login: async () => 'op',
    assign: async (n: number, on: boolean) => { assigns.push(`${on ? '+' : '-'}${n}`) },
    get: async () => ticket,
    setState: async (_n: number, to: State) => {
      assertTransition(stateOf(ticket.labels) as State | null, to)
      states.push(to)
    },
    upsertComment: async (_n: number, name: MarkerName, body: string): Promise<Comment> => {
      comments.push({ name, body })
      return { id: 1, author: 'op', body: withMarker(name, body), createdAt: '2026-02-01T00:00:00Z', updatedAt: '2026-02-01T00:00:00Z' }
    },
    comment: async (_n: number, body: string) => { posts.push(body) },
    close: async (_n: number, reason: string) => { log.push(`close ${reason}`) },
    findPr: async () => null,
    openPr: async (branch: string, base: string, title: string, body: string, l: string[]) => {
      prs.push({ branch, base, title, body, labels: l })
      return { number: 12, url: 'u/pull/12' }
    },
    prState: async () => ({ headRefName: head, isDraft: draft }),
    prReady: async (pr: number) => {
      log.push(`ready ${pr}`)
      if (readyError !== undefined) throw new Error(readyError)
    },
    prComment: async (_pr: number, body: string) => { prComments.push(body) },
  }
  return t as unknown as Tracker & typeof t
}

function setup(state: string, over: Partial<Job> = {}, files: Record<string, string> = {}, o: { maxRounds?: number; replies?: Reply[]; author?: string; tamper?: Partial<Job>; head?: string; draft?: boolean; readyError?: string } = {}): Run {
  forgetGates()
  const job = { ...J, ...over }
  const opComment = (): Comment => ({ id: 1, author: 'op', body: withMarker('intake', intakeComment(job, INTAKE)), createdAt: '2026-02-01T00:00:00Z', updatedAt: '2026-02-01T00:00:00Z' })
  const replies: Reply[] = [
    ...(o.replies ?? []),
    { argv: ['git', '-C', WT, 'rev-parse', 'HEAD'], result: { stdout: `${HEAD}\n` } },
    { argv: ['git', '-C', WT, 'merge-base', 'HEAD', 'origin/main'], result: { stdout: `${SHA}\n` } },
    { argv: ['git', '-C', WT, 'show', `${SHA}:package.json`], result: { stdout: pkg } },
    { argv: ['git', '-C', WT, 'show'], result: { exitCode: 128 } },
    { argv: ['git', '-C', WT, 'ls-files'], result: { stdout: 'package.json\n' } },
    { argv: ['git', '-C', WT, 'log'], result: { stdout: '' } },
    { argv: [] },
  ]
  const ctx = fakeCtx({
    files: {
      '/repo/.factory/config.json': cfgOf(o.maxRounds),
      '/repo/package.json': pkg,
      [`${WT}/package.json`]: pkg,
      [`${DIR}/job.md`]: renderJob({ ...job, ...o.tamper }),
      [`${DIR}/intake.md`]: INTAKE,
      ...files,
    },
    replies,
  })
  return { ctx, t: tracker([`factory:${state}`], o.author, state === 'intake' ? [] : [opComment()], o.head, o.draft, o.readyError) }
}

const count = (ctx: Run['ctx'], ...prefix: string[]): number =>
  ctx.calls.filter(c => prefix.every((p, i) => c[i] === p)).length
const rejects = (p: Promise<unknown>, code: string): Promise<void> => expect(p).rejects.toMatchObject({ code })

test('spec requires DECISION: ACCEPT', async () => {
  const { ctx, t } = setup('intake', {}, { [`${DIR}/intake.md`]: INTAKE.replace('ACCEPT', 'REJECT') })
  await rejects(jobAdvance(ctx, t, { issue: 7, to: 'spec' }), 'intake-not-accept')
  expect(t.states).toEqual([])
})

test('spec writes the route into job.md and the intake comment', async () => {
  const { ctx, t } = setup('intake', { route: {} })
  const r = await jobAdvance(ctx, t, { issue: 7, to: 'spec' })
  const want = route(parseIntake(INTAKE), JSON.parse(cfgOf()))
  expect(r.state).toBe('spec')
  expect((await readJob(ctx, 7)).route).toEqual(want)
  const body = t.comments.find(c => c.name === 'intake')!.body
  expect(body).toContain('## Summary')
  expect(body).toContain(`- Base: ${SHA}\n`)
  expect(body).toContain('- Spec updated: none\n')
  expect(body).toContain('- PR: none\n')
  expect(body).toContain('## Route')
  expect(body).toContain(`- code: ${want.code}`)
  expect(t.states).toEqual(['spec'])
})

test('needs-info posts the questions and mentions the author', async () => {
  const text = 'DECISION: NEEDS-INFO\nRISK: low\nSURFACES: none\nLANE: regular\n\n## Summary\nx\n\n## Questions\n1. Which API?\n'
  const { ctx, t } = setup('intake', {}, { [`${DIR}/intake.md`]: text })
  await jobAdvance(ctx, t, { issue: 7, to: 'needs-info' })
  const body = t.comments.find(c => c.name === 'intake')!.body
  expect(body).toContain('## Questions')
  expect(body).toContain('@alice Please answer the questions above.')
  expect(body).toContain('## Job')
  expect(body).toContain('## Route')
  expect(t.states).toEqual(['needs-info'])
})

for (const [author, mention] of [['dependabot[bot]', true], ['a-b1', true], ['x y', false], ['a@b', false], ['', false]] as const) {
  test(`the author mention for "${author}" is ${mention ? 'used' : 'dropped'}`, async () => {
    const text = 'DECISION: NEEDS-INFO\nRISK: low\nSURFACES: none\nLANE: regular\n\n## Questions\n1. Q?\n'
    const { ctx, t } = setup('intake', {}, { [`${DIR}/intake.md`]: text }, { author })
    await jobAdvance(ctx, t, { issue: 7, to: 'needs-info' })
    const body = t.comments.find(c => c.name === 'intake')!.body
    expect(body.includes(`@${author}`)).toBe(mention)
    if (!mention) expect(body).not.toMatch(/(^|\s)@/)
  })
}

test('rejected closes the issue as not planned and cleans up worktree, branch and job folder', async () => {
  const text = 'DECISION: REJECT\nRISK: low\nSURFACES: none\nLANE: regular\n\n## Reason\nOut of scope.\n'
  const { ctx, t } = setup('intake', {}, { [`${DIR}/intake.md`]: text })
  await jobAdvance(ctx, t, { issue: 7, to: 'rejected' })
  expect(t.comments.find(c => c.name === 'intake')!.body).toContain('## Reason')
  expect(t.log).toContain('close rejected')
  expect(ctx.calls).toContainEqual(['rm', '-rf', DIR])
  expect(ctx.calls).toContainEqual(['git', 'worktree', 'remove', WT])
  expect(ctx.calls).toContainEqual(['git', 'branch', '-d', 'factory/7'])
  expect(ctx.calls.some(c => c[0] === 'gh' || c.includes('-D'))).toBe(false)
  expect(ctx.calls.filter(c => c[0] === 'rm')).toHaveLength(1)
})

const LOCAL = 'c'.repeat(40)
const rejectReplies: Reply[] = [
  { argv: ['git', 'rev-parse', '--verify', '--quiet', 'refs/heads/factory/7'], result: { stdout: `${LOCAL}\n` } },
  { argv: ['git', 'rev-parse', '--verify', '--quiet', 'FETCH_HEAD'], result: { stdout: `${LOCAL}\n` } },
]
// One log of the tracker calls of a rejection, in call order.
function rejectRun(state: State, pr: number | null, prOpen = true): Run & { order: string[] } {
  const run = setup(state, { round: state === 'needs-info' ? 0 : 1, pr }, {}, { replies: rejectReplies })
  const order: string[] = []
  const t = run.t as unknown as Record<string, unknown>
  t.comment = async (_n: number, body: string) => { order.push(`comment ${body}`) }
  t.prState = async (p: number) => { order.push(`prState ${p}`); return { number: p, state: prOpen ? 'OPEN' : 'CLOSED', headRefName: 'factory/7' } }
  t.closePr = async (p: number) => { order.push(`closePr ${p}`) }
  t.deleteBranch = async (b: string) => { order.push(`deleteBranch ${b}`) }
  t.setState = async (_n: number, to: State) => { order.push(`setState ${to}`) }
  t.close = async (_n: number, reason: string) => { order.push(`close ${reason}`) }
  return { ...run, order }
}

test('a rejection outside intake needs a reason', async () => {
  for (const state of ['needs-human', 'approved', 'needs-info'] as State[]) {
    for (const reason of [undefined, '  \n ']) {
      const { ctx, t, order } = rejectRun(state, 12)
      await rejects(jobAdvance(ctx, t, { issue: 7, to: 'rejected', ...(reason === undefined ? {} : { reason }) }), 'reason-required')
      expect(order).toEqual([])
      expect(t.comments).toEqual([])
      expect(ctx.calls.some(c => c[0] === 'rm' || c.includes('worktree'))).toBe(false)
    }
  }
})

test('a rejection closes the PR, deletes the remote branch, and closes the issue', async () => {
  for (const state of ['needs-human', 'approved', 'needs-info'] as State[]) {
    const { ctx, t, order } = rejectRun(state, 12)
    const r = await jobAdvance(ctx, t, { issue: 7, to: 'rejected', reason: 'duplicate of #40' })
    expect(order).toEqual(['comment Rejected: duplicate of #40', 'prState 12', 'closePr 12', 'deleteBranch factory/7', 'setState rejected', 'close rejected'])
    expect(r.state).toBe('rejected')
    expect(r.cleanup!.removed).toEqual([WT, 'factory/7', DIR])
    expect(ctx.calls).toContainEqual(['git', 'fetch', 'origin', 'refs/pull/12/head'])
    expect(ctx.calls).toContainEqual(['git', 'update-ref', '-d', 'refs/heads/factory/7', LOCAL])
    expect(ctx.calls.some(c => c.includes('-D'))).toBe(false)
  }
  // intake.md is not read: a REJECT decision is not needed.
  const none = rejectRun('needs-human', null)
  delete none.ctx.files[`${DIR}/intake.md`]
  await jobAdvance(none.ctx, none.t, { issue: 7, to: 'rejected', reason: 'not needed' })
  expect(none.order).toEqual(['comment Rejected: not needed', 'deleteBranch factory/7', 'setState rejected', 'close rejected'])
  expect(none.ctx.calls.some(c => c[1] === 'fetch' && c[3] !== undefined && c[3].startsWith('refs/pull/'))).toBe(false)
  const closed = rejectRun('approved', 12, false)
  await jobAdvance(closed.ctx, closed.t, { issue: 7, to: 'rejected', reason: 'stale' })
  expect(closed.order).not.toContain('closePr 12')
  expect(closed.order).toContain('deleteBranch factory/7')
})

test('build starts round 1 in the existing worktree', async () => {
  const { ctx, t } = setup('spec', {}, { [`${DIR}/spec.md`]: SPEC })
  const r = await jobAdvance(ctx, t, { issue: 7, to: 'build' })
  expect(r.round).toBe(1)
  expect(r.roundDir).toBe(`${DIR}/round-1`)
  expect(ctx.calls).toContainEqual(['mkdir', '-p', `${DIR}/round-1`])
  expect(ctx.calls.some(c => c.includes('worktree'))).toBe(false)
  expect(t.comments.find(c => c.name === 'spec')!.body).toBe(SPEC)
  const job = await readJob(ctx, 7)
  expect(job.specUpdated).toBe('2026-02-01T00:00:00Z')
  expect(job.round).toBe(1)
  expect(t.comments.find(c => c.name === 'intake')!.body).toContain('- Spec updated: 2026-02-01T00:00:00Z\n')
})

test('build refuses a spec title that is not conventional', async () => {
  const { ctx, t } = setup('spec', {}, { [`${DIR}/spec.md`]: SPEC.replace('feat: add thing', 'Add thing') })
  await rejects(jobAdvance(ctx, t, { issue: 7, to: 'build' }), 'bad-title')
  expect(t.states).toEqual([])
  const notReady = setup('spec', {}, { [`${DIR}/spec.md`]: SPEC.replace('READY', 'DRAFT') })
  await rejects(jobAdvance(notReady.ctx, notReady.t, { issue: 7, to: 'build' }), 'spec-not-ready')
})

const inBuild = (files: Record<string, string> = {}, o: Parameters<typeof setup>[3] = {}): Run =>
  setup('build', { round: 1 }, { [`${DIR}/spec.md`]: SPEC, [`${DIR}/round-1/build.md`]: BUILD, ...files }, o)

test('review refuses when the gate is not green', async () => {
  const { ctx, t } = inBuild({}, { replies: [{ argv: ['vp', 'lint'], result: { exitCode: 1 } }] })
  await expect(jobAdvance(ctx, t, { issue: 7, to: 'review' })).rejects.toMatchObject({
    code: 'gate-not-green', message: `The gate is FAIL. See ${DIR}/round-1/checks.md.`, fix: 'Fix the failures. Then run the gate again.',
  })
  expect(count(ctx, 'git', '-C', WT, 'push')).toBe(0)
  expect(t.states).toEqual([])
})

test('a forged checks.md with VERDICT: PASS still gives gate-not-green', async () => {
  const forged = inBuild({ [`${DIR}/round-1/checks.md`]: 'VERDICT: PASS\n' }, { replies: [{ argv: ['npm', 'run', 'test'], result: { exitCode: 1 } }] })
  await rejects(jobAdvance(forged.ctx, forged.t, { issue: 7, to: 'review' }), 'gate-not-green')
  expect(count(forged.ctx, 'git', '-C', WT, 'push')).toBe(0)
  expect(forged.ctx.files[`${DIR}/round-1/checks.md`]!.startsWith('VERDICT: FAIL')).toBe(true)
})

test('review pushes and opens one draft PR', async () => {
  const { ctx, t } = inBuild()
  const r = await jobAdvance(ctx, t, { issue: 7, to: 'review' })
  expect(ctx.calls).toContainEqual(['git', '-C', WT, 'push', 'origin', `${HEAD}:refs/heads/factory/7`])
  expect(t.prs).toHaveLength(1)
  expect(t.prs[0]).toMatchObject({ branch: 'factory/7', base: 'main', title: 'feat: add thing', labels: ['factory:pr', 'type:feat'] })
  expect(r.reviewers).toEqual(['code', 'security'])
  expect((await readJob(ctx, 7)).pr).toBe(12)
  expect(t.comments.find(c => c.name === 'intake')!.body).toContain('- PR: #12\n')
  expect(ctx.files[`${DIR}/round-1/checks.md`]!.startsWith('VERDICT: PASS')).toBe(true)
  // second advance to review (after a rework round): push again, no second PR
  const again = setup('build', { round: 2, pr: 12 }, { [`${DIR}/spec.md`]: SPEC, [`${DIR}/round-2/build.md`]: BUILD })
  await jobAdvance(again.ctx, again.t, { issue: 7, to: 'review' })
  expect(again.t.prs).toHaveLength(0)
  expect(count(again.ctx, 'git', '-C', WT, 'push')).toBe(1)
})

test('review in a later round writes the new spec date into the intake comment', async () => {
  const later = '2026-03-01T00:00:00Z'
  const { ctx, t } = setup('build', { round: 2, pr: 12 }, { [`${DIR}/spec.md`]: SPEC, [`${DIR}/round-2/build.md`]: BUILD }, { tamper: { specUpdated: later } })
  await jobAdvance(ctx, t, { issue: 7, to: 'review' })
  expect(t.prs).toHaveLength(0)
  expect(t.comments.find(c => c.name === 'intake')!.body).toContain(`- Spec updated: ${later}\n`)
})

const attempts = (ctx: Run['ctx']): number =>
  (ctx.files[`${DIR}/round-1/checks.log`] ?? '').split('\n').filter(l => l.startsWith('## Attempt ')).length

test('review reuses a passing gate at the same HEAD', async () => {
  const { ctx, t } = inBuild()
  expect((await gateJob(ctx, 7, 'round-1')).verdict).toBe('PASS')
  expect(passedAt(ctx, 7, 'round-1')).toBe(HEAD)
  const lints = count(ctx, 'vp', 'lint')
  await jobAdvance(ctx, t, { issue: 7, to: 'review' })
  expect(attempts(ctx)).toBe(1)
  expect(count(ctx, 'vp', 'lint')).toBe(lints)
  expect(ctx.calls).toContainEqual(['git', '-C', WT, 'push', 'origin', `${HEAD}:refs/heads/factory/7`])
  expect(t.states).toEqual(['review'])
})

test('review runs the gate again when HEAD moved after the gate', async () => {
  const { ctx, t } = inBuild()
  await gateJob(ctx, 7, 'round-1')
  const moved = 'c'.repeat(40)
  const run = ctx.run
  ctx.run = async (argv, opts) =>
    argv.join(' ') === `git -C ${WT} rev-parse HEAD` ? { exitCode: 0, stdout: `${moved}\n`, stderr: '' } : run(argv, opts)
  await jobAdvance(ctx, t, { issue: 7, to: 'review' })
  expect(attempts(ctx)).toBe(2)
  expect(ctx.calls).toContainEqual(['git', '-C', WT, 'push', 'origin', `${moved}:refs/heads/factory/7`])
})

test('a failing gate is never recorded', async () => {
  const { ctx, t } = inBuild({}, { replies: [{ argv: ['vp', 'lint'], result: { exitCode: 1 } }] })
  expect((await gateJob(ctx, 7, 'round-1')).verdict).toBe('FAIL')
  expect(passedAt(ctx, 7, 'round-1')).toBeUndefined()
  await rejects(jobAdvance(ctx, t, { issue: 7, to: 'review' }), 'gate-not-green')
  expect(attempts(ctx)).toBe(2)
})

test('review records the pushed commit as the reviewed commit', async () => {
  const { ctx, t } = inBuild()
  await jobAdvance(ctx, t, { issue: 7, to: 'review' })
  expect((await readJob(ctx, 7)).reviewed).toBe(HEAD)
  expect(t.comments.find(c => c.name === 'intake')!.body).toContain(`- Reviewed: ${HEAD}\n`)
})

test('review writes the merge base with origin/main as Base', async () => {
  const synced = 'e'.repeat(40)
  const { ctx, t } = inBuild({}, { replies: [
    { argv: ['git', '-C', WT, 'merge-base', 'HEAD', 'origin/main'], result: { stdout: `${synced}\n` } },
    { argv: ['git', '-C', WT, 'show', `${synced}:package.json`], result: { stdout: pkg } },
  ] })
  await jobAdvance(ctx, t, { issue: 7, to: 'review' })
  expect((await readJob(ctx, 7)).base).toBe(synced)
  expect(t.comments.find(c => c.name === 'intake')!.body).toContain(`- Base: ${synced}\n`)
})

test('a new round clears the reviewed commit', async () => {
  const files = { [`${DIR}/round-1/review-code.md`]: rv('PASS'), [`${DIR}/round-1/review-security.md`]: rv('CHANGES', 'fix it') }
  const { ctx, t } = inReview(files)
  await jobAdvance(ctx, t, { issue: 7, to: 'build' })
  expect((await readJob(ctx, 7)).reviewed).toBeNull()
  expect(t.comments.find(c => c.name === 'intake')!.body).toContain('- Reviewed: none\n')
})

test('approved is refused when HEAD is not the reviewed commit', async () => {
  const files = { [`${DIR}/round-1/review-code.md`]: rv('PASS'), [`${DIR}/round-1/review-security.md`]: rv('PASS'), [`${DIR}/decision.md`]: APPROVE }
  const { ctx, t } = inReview(files, {}, { reviewed: MOVED })
  await rejects(jobAdvance(ctx, t, { issue: 7, to: 'approved' }), 'head-moved')
  expect(t.states).toEqual([])
  expect(t.log).not.toContain('ready 12')
  expect(t.comments).toEqual([])
})

test('the head-moved fix names /factory:run', async () => {
  const files = { [`${DIR}/round-1/review-code.md`]: rv('PASS'), [`${DIR}/round-1/review-security.md`]: rv('PASS'), [`${DIR}/decision.md`]: APPROVE }
  const { ctx, t } = inReview(files, {}, { reviewed: MOVED })
  await expect(jobAdvance(ctx, t, { issue: 7, to: 'approved' })).rejects.toMatchObject({
    code: 'head-moved',
    fix: 'Commits came after the reviews. Call job_advance with to: needs-human and this error as reason. Then a human comments in the issue and runs /factory:run 7.',
  })
})

test('PR body closes the issue', async () => {
  const { ctx, t } = inBuild()
  await jobAdvance(ctx, t, { issue: 7, to: 'review' })
  expect(t.prs[0]!.body.startsWith('Closes #7')).toBe(true)
  expect(t.prs[0]!.body).toContain('Built the thing.')
})

test('PR body neutralizes closing keywords and mentions in the build summary', async () => {
  const build = 'STATUS: DONE\n\n## Summary\nFixes #3, closes: #4 and resolved o/r#5. Ask @bob and @org/team.\n'
  const { ctx, t } = inBuild({ [`${DIR}/round-1/build.md`]: build })
  await jobAdvance(ctx, t, { issue: 7, to: 'review' })
  const body = t.prs[0]!.body
  expect(body.startsWith('Closes #7\n')).toBe(true)
  const summary = body.slice(body.indexOf('## Summary'))
  expect(summary).not.toMatch(/\b(close[sd]?|fix(e[sd])?|resolve[sd]?)\b/i)
  expect(summary).not.toMatch(/@[a-z]/i)
  expect(summary.replace(/\u200b/g, '')).toContain('Fixes #3, closes: #4 and resolved o/r#5. Ask @bob and @org/team.')
})

test('a breaking title adds the breaking label', async () => {
  const { ctx, t } = inBuild({ [`${DIR}/spec.md`]: SPEC.replace('feat:', 'feat!:') })
  await jobAdvance(ctx, t, { issue: 7, to: 'review' })
  expect(t.prs[0]!.labels).toEqual(['factory:pr', 'type:feat', 'type:breaking'])
})

const inReview = (files: Record<string, string>, o: Parameters<typeof setup>[3] = {}, over: Partial<Job> = {}): Run =>
  setup('review', { round: 1, pr: 12, reviewed: HEAD, ...over }, { [`${DIR}/spec.md`]: SPEC, [`${DIR}/round-1/checks.md`]: 'VERDICT: PASS\n', ...files }, o)

test('approved waits for all routed reviews', async () => {
  const { ctx, t } = inReview({ [`${DIR}/round-1/review-code.md`]: rv('PASS'), [`${DIR}/decision.md`]: APPROVE })
  await expect(jobAdvance(ctx, t, { issue: 7, to: 'approved' })).rejects.toMatchObject({ code: 'reviews-missing', message: expect.stringMatching(/^These review files are missing: .*security.*\.$/) })
  expect(t.states).toEqual([])
})

test('approved with an empty Route is refused', async () => {
  const r = inReview({ [`${DIR}/decision.md`]: APPROVE }, {}, { route: {} })
  await expect(jobAdvance(r.ctx, r.t, { issue: 7, to: 'approved' })).rejects.toMatchObject({ code: 'no-route', fix: 'Call job_advance with to: spec again.' })
  expect(r.t.states).toEqual([])
})

test('approved needs every review PASS and decision APPROVE', async () => {
  const files = { [`${DIR}/round-1/review-code.md`]: rv('PASS'), [`${DIR}/round-1/review-security.md`]: rv('PASS'), [`${DIR}/decision.md`]: APPROVE }
  const { ctx, t } = inReview(files)
  const r = await jobAdvance(ctx, t, { issue: 7, to: 'approved' })
  expect(r.state).toBe('approved')
  expect(t.log).not.toContain('ready 12') // a PR that is not a draft needs no call
  expect(r.warnings).toBeUndefined()
  expect(t.comments.map(c => c.name)).toEqual(['round-1', 'decision'])
  expect(t.comments[1]!.body).toBe(`Round: 1\n\n${APPROVE}`)
  expect(t.states).toEqual(['approved'])
})

test('build assigns and approved unassigns the issue and the PR', async () => {
  const b = setup('spec', { pr: 12 }, { [`${DIR}/spec.md`]: SPEC })
  await jobAdvance(b.ctx, b.t, { issue: 7, to: 'build' })
  expect(b.t.assigns).toEqual(['+7', '+12'])
  const files = { [`${DIR}/round-1/review-code.md`]: rv('PASS'), [`${DIR}/round-1/review-security.md`]: rv('PASS'), [`${DIR}/decision.md`]: APPROVE }
  const a = inReview(files)
  await jobAdvance(a.ctx, a.t, { issue: 7, to: 'approved' })
  expect(a.t.assigns).toEqual(['-7', '-12'])
})

test('approved is refused after a spec change during review', async () => {
  const files = { [`${DIR}/round-1/review-code.md`]: rv('PASS'), [`${DIR}/round-1/review-security.md`]: rv('PASS'), [`${DIR}/decision.md`]: APPROVE }
  const { ctx, t } = inReview(files, { tamper: { specUpdated: '2026-03-01T00:00:00Z' } })
  await expect(jobAdvance(ctx, t, { issue: 7, to: 'approved' })).rejects.toMatchObject({ code: 'spec-changed', fix: 'Call job_advance with to: build. Then start a new builder.' })
  expect(t.states).toEqual([])
  expect(t.log).not.toContain('ready 12')
})

test('decision-mismatch for every other mix', async () => {
  const pass = { [`${DIR}/round-1/review-code.md`]: rv('PASS'), [`${DIR}/round-1/review-security.md`]: rv('PASS') }
  const changes = { [`${DIR}/round-1/review-code.md`]: rv('PASS'), [`${DIR}/round-1/review-security.md`]: rv('CHANGES', 'bad') }
  const cases: [Record<string, string>, 'approved' | 'needs-human'][] = [
    [{ ...pass, [`${DIR}/decision.md`]: ESCALATE }, 'approved'],
    [{ ...changes, [`${DIR}/decision.md`]: APPROVE }, 'approved'],
    [{ ...changes, [`${DIR}/decision.md`]: ESCALATE }, 'approved'],
    [{ ...pass, [`${DIR}/decision.md`]: APPROVE }, 'needs-human'],
    [{ ...changes, [`${DIR}/decision.md`]: APPROVE }, 'needs-human'],
  ]
  for (const [files, to] of cases) {
    const { ctx, t } = inReview(files)
    await rejects(jobAdvance(ctx, t, { issue: 7, to }), 'decision-mismatch')
    expect(t.states).toEqual([])
  }
})

test('escalate sets needs-human and asks on the PR', async () => {
  const files = { [`${DIR}/round-1/review-code.md`]: rv('PASS'), [`${DIR}/round-1/review-security.md`]: rv('CHANGES', 'bad'), [`${DIR}/decision.md`]: ESCALATE }
  const { ctx, t } = inReview(files)
  const r = await jobAdvance(ctx, t, { issue: 7, to: 'needs-human' })
  expect(r.state).toBe('needs-human')
  expect(t.prComments).toEqual(['Public API?'])
  expect(t.log).not.toContain('ready 12')
  expect(t.comments.map(c => c.name)).toEqual(['round-1', 'decision'])
  expect(t.states).toEqual(['needs-human'])
})

test('approved and needs-human end an old draft PR', async () => {
  const pass = { [`${DIR}/round-1/review-code.md`]: rv('PASS'), [`${DIR}/round-1/review-security.md`]: rv('PASS') }
  const a = inReview({ ...pass, [`${DIR}/decision.md`]: APPROVE }, { draft: true })
  await jobAdvance(a.ctx, a.t, { issue: 7, to: 'approved' })
  expect(a.t.log).toContain('ready 12') // a draft PR cannot merge, and the human may merge an escalated job
  const b = inReview({ ...pass, [`${DIR}/round-1/review-security.md`]: rv('CHANGES', 'x'), [`${DIR}/decision.md`]: ESCALATE }, { draft: true })
  await jobAdvance(b.ctx, b.t, { issue: 7, to: 'needs-human' })
  expect(b.t.log).toContain('ready 12')
})

test('a failed draft end is a warning and the job still moves', async () => {
  const pass = { [`${DIR}/round-1/review-code.md`]: rv('PASS'), [`${DIR}/round-1/review-security.md`]: rv('PASS') }
  const a = inReview({ ...pass, [`${DIR}/decision.md`]: APPROVE }, { draft: true, readyError: 'GraphQL: API rate limit already exceeded' })
  const r = await jobAdvance(a.ctx, a.t, { issue: 7, to: 'approved' })
  expect(r.state).toBe('approved')
  expect(a.t.states).toEqual(['approved'])
  expect(r.warnings).toHaveLength(1)
  expect(r.warnings![0]).toContain('PR #12 is still a draft')
  expect(r.warnings![0]).toContain('rate limit')
  expect(r.warnings![0]).toContain('Fix: ')
  const b = inReview({ ...pass, [`${DIR}/round-1/review-security.md`]: rv('CHANGES', 'x'), [`${DIR}/decision.md`]: ESCALATE }, { draft: true, readyError: 'boom' })
  const e = await jobAdvance(b.ctx, b.t, { issue: 7, to: 'needs-human' })
  expect(e.state).toBe('needs-human')
  expect(b.t.prComments).toEqual(['Public API?'])
  expect(e.warnings![0]).toContain('boom')
})

test('changes start the next round', async () => {
  const files = { [`${DIR}/round-1/review-code.md`]: rv('PASS'), [`${DIR}/round-1/review-security.md`]: rv('CHANGES', 'fix it') }
  const { ctx, t } = inReview(files)
  const r = await jobAdvance(ctx, t, { issue: 7, to: 'build' })
  expect(r.round).toBe(2)
  expect(r.roundDir).toBe(`${DIR}/round-2`)
  expect(ctx.calls).toContainEqual(['mkdir', '-p', `${DIR}/round-2`])
  expect((await readJob(ctx, 7)).round).toBe(2)
  expect(t.comments.map(c => c.name)).toEqual(['round-1', 'intake'])
  expect(t.states).toEqual(['build'])
})

const SPEC_FINDING = 'VERDICT: CHANGES\n\n## Findings\n1. [blocker] spec: spec.md:5: AC-1 fixes #12 @someone. Fix: move AC-1 to Not tested.\n'

test('a review finding that needs a spec change goes to needs-human', async () => {
  const files = { [`${DIR}/round-3/review-code.md`]: rv('PASS'), [`${DIR}/round-3/review-security.md`]: SPEC_FINDING, [`${DIR}/round-3/checks.md`]: 'VERDICT: PASS\n' }
  const { ctx, t } = inReview(files, { maxRounds: 3 }, { round: 3 })
  const r = await jobAdvance(ctx, t, { issue: 7, to: 'build' })
  expect(r.state).toBe('needs-human')
  expect(r.round).toBe(3)
  expect(r.note).toBe('Round 3 needs a spec change.')
  expect(t.comments.map(c => c.name)).toEqual(['round-3'])
  expect(t.posts).toHaveLength(1)
  const post = t.posts[0]!
  expect(post.startsWith('Factory stopped: Round 3 needs a spec change.\n')).toBe(true)
  expect(post).toContain('- security: spec.md:5: AC-1 f\u200bixes #12 @\u200bsomeone. F\u200bix: move AC-1 to Not tested.\n')
  expect(post.endsWith('\nComment the spec change you approve, or edit the spec comment. Then run /factory:run 7.')).toBe(true)
  expect(post).not.toContain('round limit')
  expect(t.states).toEqual(['needs-human'])
  expect(count(ctx, 'mkdir')).toBe(0)
  expect((await readJob(ctx, 7)).round).toBe(3)
})

test('a spec change during review starts the next round despite a spec finding', async () => {
  const files = { [`${DIR}/round-1/review-code.md`]: rv('PASS'), [`${DIR}/round-1/review-security.md`]: SPEC_FINDING }
  const { ctx, t } = inReview(files, { tamper: { specUpdated: '2026-03-01T00:00:00Z' } })
  const r = await jobAdvance(ctx, t, { issue: 7, to: 'build' })
  expect(r.state).toBe('build')
  expect(r.round).toBe(2)
  expect(t.posts).toEqual([])
  expect(t.states).toEqual(['build'])
})

test('build from review needs a CHANGES review and all routed files', async () => {
  const allPass = inReview({ [`${DIR}/round-1/review-code.md`]: rv('PASS'), [`${DIR}/round-1/review-security.md`]: rv('PASS') })
  await rejects(jobAdvance(allPass.ctx, allPass.t, { issue: 7, to: 'build' }), 'no-changes')
  const missing = inReview({ [`${DIR}/round-1/review-code.md`]: rv('CHANGES', 'x') })
  await rejects(jobAdvance(missing.ctx, missing.t, { issue: 7, to: 'build' }), 'reviews-missing')
})

test('a spec changed during review starts the next round without a CHANGES review', async () => {
  const pass = { [`${DIR}/round-1/review-code.md`]: rv('PASS'), [`${DIR}/round-1/review-security.md`]: rv('PASS') }
  const moved = inReview(pass, { tamper: { specUpdated: '2026-03-01T00:00:00Z' } })
  const r = await jobAdvance(moved.ctx, moved.t, { issue: 7, to: 'build' })
  expect(r.state).toBe('build')
  expect(r.round).toBe(2)
  expect(moved.t.comments.find(c => c.name === 'intake')!.body).toContain('- Spec updated: 2026-03-01T00:00:00Z\n')
  const same = inReview(pass)
  await rejects(jobAdvance(same.ctx, same.t, { issue: 7, to: 'build' }), 'no-changes')
})

test('round over maxRounds goes to needs-human', async () => {
  const files = { [`${DIR}/round-3/review-code.md`]: rv('CHANGES', 'x'), [`${DIR}/round-3/review-security.md`]: rv('PASS'), [`${DIR}/round-3/checks.md`]: 'VERDICT: PASS\n' }
  const { ctx, t } = inReview(files, { maxRounds: 3 }, { round: 3 })
  const r = await jobAdvance(ctx, t, { issue: 7, to: 'build' })
  expect(r.state).toBe('needs-human')
  expect(r.note).toBe('Round 3 reached the round limit of 3.')
  expect(t.posts).toContain('Factory stopped: Round 3 reached the round limit of 3.')
  expect(t.states).toEqual(['needs-human'])
  expect(count(ctx, 'mkdir')).toBe(0)
})

test('over maxRounds from needs-human changes no label', async () => {
  const { ctx, t } = setup('needs-human', { round: 3 }, { [`${DIR}/spec.md`]: SPEC }, { maxRounds: 3 })
  const r = await jobAdvance(ctx, t, { issue: 7, to: 'build' })
  expect(r.state).toBe('needs-human')
  expect(r.note).toBeDefined()
  expect(t.states).toEqual([])
  expect(count(ctx, 'gh')).toBe(0)
})

test('build is refused from each state without a legal move to build', async () => {
  for (const state of ['backlog', 'intake', 'needs-info', 'fastlane', 'needs-design', 'build', 'docs', 'done', 'rejected']) {
    const { ctx, t } = setup(state, { round: 1 }, { [`${DIR}/spec.md`]: SPEC })
    await rejects(jobAdvance(ctx, t, { issue: 7, to: 'build' }), 'illegal-transition')
    expect(t.states).toEqual([])
  }
})

test('build from needs-human starts the next round', async () => {
  const { ctx, t } = setup('needs-human', { round: 1 }, { [`${DIR}/spec.md`]: SPEC })
  const r = await jobAdvance(ctx, t, { issue: 7, to: 'build' })
  expect(r.round).toBe(2)
  expect(t.states).toEqual(['build'])
})

test('build from needs-human with a PR starts the next round and keeps the PR', async () => {
  const { ctx, t } = setup('needs-human', { round: 1, pr: 12 }, { [`${DIR}/spec.md`]: SPEC })
  const r = await jobAdvance(ctx, t, { issue: 7, to: 'build' })
  expect(r.round).toBe(2)
  expect(t.states).toEqual(['build'])
  expect((await readJob(ctx, 7)).pr).toBe(12)
  expect(t.prs).toEqual([])
})

test('review abort with a reason skips decision.md', async () => {
  const { ctx, t } = inReview({})
  const r = await jobAdvance(ctx, t, { issue: 7, to: 'needs-human', reason: 'the builder crashed' })
  expect(r.state).toBe('needs-human')
  expect(t.posts.join('\n')).toContain('the builder crashed')
  expect(t.states).toEqual(['needs-human'])
})

test('needs-human without a reason is only for a review decision', async () => {
  const { ctx, t } = inBuild()
  await expect(jobAdvance(ctx, t, { issue: 7, to: 'needs-human' })).rejects.toMatchObject({
    code: 'reason-required', message: 'A move to needs-human outside review needs a reason.', fix: 'Give a reason.',
  })
})

test('unsupported targets and illegal moves are refused', async () => {
  const a = inBuild()
  await expect(jobAdvance(a.ctx, a.t, { issue: 7, to: 'done' })).rejects.toMatchObject({ code: 'unsupported-target', fix: 'Use the merge tool for an open PR. For a merged PR, run /factory:run without an issue number.' })
  const b = inBuild()
  await rejects(jobAdvance(b.ctx, b.t, { issue: 7, to: 'rejected' }), 'illegal-transition')
})

test('every advance writes exactly one label change', async () => {
  const runs: [Run, State][] = [
    [setup('intake', { route: {} }), 'spec'],
    [setup('spec', {}, { [`${DIR}/spec.md`]: SPEC }), 'build'],
    [inBuild(), 'review'],
    [inReview({ [`${DIR}/round-1/review-code.md`]: rv('PASS'), [`${DIR}/round-1/review-security.md`]: rv('PASS'), [`${DIR}/decision.md`]: APPROVE }), 'approved'],
  ]
  for (const [{ ctx, t }, to] of runs) {
    await jobAdvance(ctx, t, { issue: 7, to })
    expect(t.states).toEqual([to])
  }
})

test('job_advance uses parseReview for the round summary', async () => {
  const files = { [`${DIR}/round-1/review-code.md`]: rv('CHANGES', 'Null deref in parse'), [`${DIR}/round-1/review-security.md`]: rv('PASS') }
  const { ctx } = inReview(files)
  const text = await roundSummary(ctx, { ...J, round: 1 }, `${DIR}/round-1`)
  expect(text).toContain('Gate: PASS')
  expect(text).toContain('code: CHANGES')
  expect(text).toContain('security: PASS')
  expect(text).toContain('[blocker] Null deref in parse')
})

test('the intake comment round-trips through jobSync', async () => {
  const job: Job = { ...J, pr: 12, round: 2, specUpdated: '2026-02-01T00:00:00Z', route: { code: 'sonnet', security: 'opus', ui: 'haiku' } }
  const body = intakeComment(job, INTAKE)
  const ticket: Ticket = {
    kind: 'issue', number: 7, title: 'Add thing', body: 'b', author: 'alice', labels: ['factory', 'factory:build'], state: 'open',
    createdAt: '2026-01-01T00:00:00Z', url: 'u/7',
    comments: [{ id: 1, author: 'op', body: withMarker('intake', body), createdAt: '2026-02-01T00:00:00Z', updatedAt: '2026-02-01T00:00:00Z' }],
  }
  const ctx = fakeCtx({
    files: { '/repo/.factory/config.json': cfgOf() },
    replies: [{ argv: ['git', 'ls-remote'], result: { exitCode: 2 } }, { argv: [] }],
  })
  const t = { login: async () => 'op', get: async () => ticket } as unknown as Tracker
  const r = await jobSync(ctx, t, 7)
  expect(r.job.base).toBe(SHA)
  expect(r.job.pr).toBe(12)
  expect(r.job.round).toBe(2)
  expect(r.job.specUpdated).toBe('2026-02-01T00:00:00Z')
  expect(r.job.route).toEqual(job.route)
  expect(ctx.files[`${DIR}/intake.md`]).toBe(INTAKE)
  expect(body).toContain('- Round: 2\n')
  const none = intakeComment({ ...J, pr: null, specUpdated: null, route: {} }, INTAKE)
  expect(none).toContain('## Job')
  expect(none).toContain('## Route')
})

test('a late notification cannot restart a needs-human job', async () => {
  const { ctx, t } = setup('needs-human', { round: 1 }, { [`${DIR}/spec.md`]: SPEC })
  await expect(jobAdvance(ctx, t, { issue: 7, to: 'build', from: 'review' })).rejects.toMatchObject({ code: 'state-moved', message: expect.stringContaining('needs-human') })
  expect(t.states).toEqual([])
  expect(ctx.calls.filter(c => c[0] === 'mkdir')).toHaveLength(0)
  const ok = setup('needs-human', { round: 1 }, { [`${DIR}/spec.md`]: SPEC })
  expect((await jobAdvance(ok.ctx, ok.t, { issue: 7, to: 'build', from: 'needs-human' })).round).toBe(2)
})

const advDef = () => TOOLS.find(t => t.name === 'job_advance')!

test('job_advance is registered and validates its input', async () => {
  expect(TOOLS.map(t => t.name)).toContain('job_advance')
  const ctx = fakeCtx()
  for (const input of [{}, { issue: 0, to: 'spec' }, { issue: 1.5, to: 'spec' }, { issue: '7', to: 'spec' }, { issue: 7, to: 'nope' }, { issue: 7 }, { issue: 7, to: 'spec', reason: 5 }, { issue: 7, to: 'spec', from: 'nope' }]) {
    await rejects(advDef().handler(ctx, input), 'bad-input')
  }
})

test('job_advance sets the option of the new state on the board', async () => {
  const { ctx, t } = setup('intake', {}, {}, { replies: boardReplies })
  const { tracker, warnings } = onBoard(ctx, t)
  await jobAdvance(ctx, tracker, { issue: 7, to: 'spec' })
  expect(boardCalls(ctx.calls)).toEqual(['setState 7 spec', 'gh project view', 'gh project field-list', 'gh project item-add', 'gh project item-edit'])
  expect(ctx.calls).toContainEqual(edit('Spec'))
  expect(warnings).toEqual([])
})

test('the tool saves the board ids in job.md, and the next transition makes one board call', async () => {
  const raw = (state: string) => ({ number: 7, title: 'Add thing', body: 'b', labels: [{ name: 'factory' }, { name: `factory:${state}` }], user: { login: 'alice' }, created_at: '2026-01-01T00:00:00Z', html_url: 'https://github.com/o/r/issues/7', state: 'open', assignees: [] })
  const files = {
    '/repo/.factory/config.json': JSON.stringify({ ...defaultConfig('https://github.com/o/r', 'main', []), ...ON }),
    [`${DIR}/job.md`]: renderJob({ ...J, round: 1 }),
  }
  const replies = (state: string) => [
    { argv: ['gh', 'api', 'repos/o/r/issues/7'], result: { stdout: JSON.stringify(raw(state)) } },
    { argv: ['gh', 'api', 'user'], result: { stdout: 'op' } },
    ...boardReplies,
    { argv: [] },
  ]
  const first = fakeCtx({ files, replies: replies('build') })
  expect('isError' in await invoke(advDef(), first, { issue: 7, to: 'needs-human', reason: 'stuck' })).toBe(false)
  expect(boardCalls(first.calls)).toEqual(['gh project view', 'gh project field-list', 'gh project item-add', 'gh project item-edit'])
  expect((await readJob(first, 7)).board?.item).toBe('I1')
  const next = fakeCtx({ files: first.files, replies: replies('review') })
  expect('isError' in await invoke(advDef(), next, { issue: 7, to: 'needs-human', reason: 'stuck' })).toBe(false)
  expect(boardCalls(next.calls)).toEqual(['gh project item-edit'])
  expect(next.calls).toContainEqual(edit('Waiting'))
})

test('a failed project call leaves the transition done and returns a warning', async () => {
  const raw = { number: 7, title: 'Add thing', body: 'b', labels: [{ name: 'factory' }, { name: 'factory:build' }], user: { login: 'alice' }, created_at: '2026-01-01T00:00:00Z', html_url: 'https://github.com/o/r/issues/7', state: 'open', assignees: [] }
  const ctx = fakeCtx({
    files: {
      '/repo/.factory/config.json': JSON.stringify({ ...defaultConfig('https://github.com/o/r', 'main', []), ...ON }),
      [`${DIR}/job.md`]: renderJob({ ...J, round: 1 }),
    },
    replies: [
      { argv: ['gh', 'api', 'repos/o/r/issues/7'], result: { stdout: JSON.stringify(raw) } },
      { argv: ['gh', 'api', 'user'], result: { stdout: 'op' } },
      { argv: ['gh', 'project', 'item-edit'], result: { exitCode: 1, stderr: 'item-edit refused' } },
      ...boardReplies,
      { argv: [] },
    ],
  })
  const out = await invoke(advDef(), ctx, { issue: 7, to: 'needs-human', reason: 'stuck' })
  expect('isError' in out).toBe(false)
  expect(ctx.calls).toContainEqual(['gh', 'api', '-X', 'PUT', 'repos/o/r/issues/7/labels', '--input', '-'])
  const r = JSON.parse(out.result) as { state: string; warnings: string[] }
  expect(r.state).toBe('needs-human')
  expect(r.warnings).toHaveLength(1)
  expect(r.warnings[0]).toContain('#7: ')
  expect(r.warnings[0]).toContain('item-edit refused')
})

const noEffects = (r: Run): void => {
  expect(r.t.states).toEqual([])
  expect(count(r.ctx, 'git', '-C', WT, 'push')).toBe(0)
}

test('a tampered Round in job.md is refused', async () => {
  for (const [state, tamper, to] of [
    ['review', { round: 0 }, 'build'],
    ['review', { round: 1 }, 'build'],
    ['build', { round: 0 }, 'review'],
  ] as const) {
    const r = setup(state, { round: 3 }, { [`${DIR}/spec.md`]: SPEC }, { tamper })
    await expect(jobAdvance(r.ctx, r.t, { issue: 7, to })).rejects.toMatchObject({ code: 'bad-job', message: 'job.md differs from the ticket: Round' })
    noEffects(r)
  }
})

test('a tampered Route in job.md is refused', async () => {
  const files = { [`${DIR}/round-1/review-code.md`]: rv('PASS'), [`${DIR}/decision.md`]: APPROVE }
  const r = inReview(files, { tamper: { route: { code: 'sonnet' } } })
  await expect(jobAdvance(r.ctx, r.t, { issue: 7, to: 'approved' })).rejects.toMatchObject({ code: 'bad-job', message: 'job.md differs from the ticket: Route' })
  noEffects(r)
})

test('a tampered Reviewed in job.md is refused', async () => {
  const files = { [`${DIR}/round-1/review-code.md`]: rv('PASS'), [`${DIR}/round-1/review-security.md`]: rv('PASS'), [`${DIR}/decision.md`]: APPROVE }
  const r = inReview(files, { tamper: { reviewed: MOVED } }, { reviewed: null })
  await expect(jobAdvance(r.ctx, r.t, { issue: 7, to: 'approved' })).rejects.toMatchObject({ code: 'bad-job', message: 'job.md differs from the ticket: Reviewed' })
  noEffects(r)
})

test('a tampered PR or Base branch in job.md is refused', async () => {
  const a = inBuild({}, { tamper: { pr: 99 } })
  await expect(jobAdvance(a.ctx, a.t, { issue: 7, to: 'review' })).rejects.toMatchObject({ code: 'bad-job', message: 'job.md differs from the ticket: PR' })
  noEffects(a)
  expect(a.t.prs).toHaveLength(0)
  const b = inBuild({}, { tamper: { baseBranch: 'release' } })
  await expect(jobAdvance(b.ctx, b.t, { issue: 7, to: 'review' })).rejects.toMatchObject({ code: 'bad-job' })
  noEffects(b)
})

test('prReady and prComment need a PR whose head is the job branch', async () => {
  const pass = { [`${DIR}/round-1/review-code.md`]: rv('PASS'), [`${DIR}/round-1/review-security.md`]: rv('PASS') }
  const a = inReview({ ...pass, [`${DIR}/decision.md`]: APPROVE }, { head: 'other' })
  await rejects(jobAdvance(a.ctx, a.t, { issue: 7, to: 'approved' }), 'bad-pr')
  expect(a.t.log).toEqual([])
  const b = inReview({ ...pass, [`${DIR}/round-1/review-security.md`]: rv('CHANGES', 'x'), [`${DIR}/decision.md`]: ESCALATE }, { head: 'other' })
  await rejects(jobAdvance(b.ctx, b.t, { issue: 7, to: 'needs-human' }), 'bad-pr')
  expect(b.t.prComments).toEqual([])
})

test('every round change rewrites the intake comment with the new Round', async () => {
  const files = { [`${DIR}/round-1/review-code.md`]: rv('PASS'), [`${DIR}/round-1/review-security.md`]: rv('CHANGES', 'fix it') }
  const { ctx, t } = inReview(files)
  await jobAdvance(ctx, t, { issue: 7, to: 'build' })
  expect(t.comments.find(c => c.name === 'intake')!.body).toContain('- Round: 2\n')
})

test('review pushes the commit the gate checked, and refuses when HEAD moved', async () => {
  const r = inBuild()
  let heads = 0
  const inner = r.ctx.run
  const ctx = { ...r.ctx, run: (async (argv: readonly string[], opts?: never) => {
    if (argv.join(' ') === `git -C ${WT} rev-parse HEAD` && ++heads >= 3) return { exitCode: 0, stdout: `${'c'.repeat(40)}\n`, stderr: '' }
    return inner(argv, opts)
  }) as typeof inner }
  await rejects(jobAdvance(ctx, r.t, { issue: 7, to: 'review' }), 'gate-not-green')
  expect(r.ctx.calls.filter(c => c.includes('push'))).toEqual([])
  expect(r.t.states).toEqual([])
})

test('starting a new round removes the old decision.md', async () => {
  const files = { [`${DIR}/round-1/review-code.md`]: rv('PASS'), [`${DIR}/round-1/review-security.md`]: rv('CHANGES', 'x'), [`${DIR}/decision.md`]: ESCALATE }
  const a = inReview(files)
  await jobAdvance(a.ctx, a.t, { issue: 7, to: 'build' })
  expect(a.ctx.calls).toContainEqual(['rm', '-rf', `${DIR}/decision.md`])
  const b = setup('needs-human', { round: 1 }, { [`${DIR}/spec.md`]: SPEC, [`${DIR}/decision.md`]: ESCALATE })
  await jobAdvance(b.ctx, b.t, { issue: 7, to: 'build' })
  expect(b.ctx.calls).toContainEqual(['rm', '-rf', `${DIR}/decision.md`])
})

test('spec from needs-human restarts the spec only before round 1', async () => {
  const r = setup('needs-human', { round: 0 }, { [`${DIR}/spec.md`]: SPEC })
  expect((await jobAdvance(r.ctx, r.t, { issue: 7, to: 'spec' })).state).toBe('spec')
  expect(r.t.states).toEqual(['spec'])
  expect(r.ctx.calls).toContainEqual(['rm', '-rf', `${DIR}/spec.md`])
  const late = setup('needs-human', { round: 1 }, { [`${DIR}/spec.md`]: SPEC })
  await rejects(jobAdvance(late.ctx, late.t, { issue: 7, to: 'spec' }), 'bad-state')
  expect(late.t.states).toEqual([])
  expect(late.ctx.calls.some(c => c[0] === 'rm')).toBe(false)
})

const stopComment = (body: string, id = 5): Comment =>
  ({ id, author: 'op', body, createdAt: '2026-02-02T00:00:00Z', updatedAt: '2026-02-02T00:00:00Z' })

test('spec from needs-human after a spec stop keeps the spec and the round', async () => {
  const r = setup('needs-human', { round: 2, pr: 12 }, { [`${DIR}/spec.md`]: SPEC })
  ;(await r.t.get(7)).comments.push(stopComment('Factory stopped: Round 2 needs a spec change.\n\n- code: x\n'))
  const res = await jobAdvance(r.ctx, r.t, { issue: 7, to: 'spec' })
  expect(res.state).toBe('spec')
  expect(res.round).toBe(2)
  expect(r.t.states).toEqual(['spec'])
  expect(r.ctx.calls.some(c => c[0] === 'rm')).toBe(false)
  expect(r.ctx.files[`${DIR}/spec.md`]).toBe(SPEC)
  expect((await readJob(r.ctx, 7)).round).toBe(2)
  expect(r.t.comments.find(c => c.name === 'intake')!.body).toContain('- Round: 2\n')
  const limit = setup('needs-human', { round: 2 }, { [`${DIR}/spec.md`]: SPEC })
  const comments = (await limit.t.get(7)).comments
  comments.push(stopComment('Factory stopped: Round 2 needs a spec change.'), stopComment('Factory stopped: Round 2 reached the round limit of 3.', 6))
  await expect(jobAdvance(limit.ctx, limit.t, { issue: 7, to: 'spec' })).rejects.toMatchObject({ code: 'bad-state', fix: 'Call job_advance with to: build.' })
  expect(limit.t.states).toEqual([])
  expect(limit.t.comments).toEqual([])
})

const blockedBuild = (summary: string): string => `STATUS: BLOCKED\n\n## Summary\n${summary}\n`
const resume = async (r: Run): Promise<void> => {
  const ticket = await r.t.get(7)
  ticket.labels = ['factory', 'factory:needs-human']
  ticket.comments.push(stopComment(r.t.posts[0]!, 8))
}

test('a blocked build that asks for a spec change posts a spec stop', async () => {
  const r = setup('build', { round: 2 }, { [`${DIR}/spec.md`]: SPEC, [`${DIR}/round-2/build.md`]: blockedBuild('\nNeeds a spec change.\nThe spec puts the picked way out of scope.') })
  const res = await jobAdvance(r.ctx, r.t, { issue: 7, from: 'build', to: 'needs-human', reason: 'The spec puts the picked way out of scope.' })
  expect(res.state).toBe('needs-human')
  expect(r.t.posts).toEqual(['Factory stopped: Round 2 needs a spec change.\n\nThe spec puts the picked way out of scope.'])
  expect(r.t.states).toEqual(['needs-human'])
  await resume(r)
  const next = await jobAdvance(r.ctx, r.t, { issue: 7, to: 'spec' })
  expect(next.state).toBe('spec')
  expect(next.round).toBe(2)
  expect(r.t.states).toEqual(['needs-human', 'spec'])
})

test('a blocked build with another cause posts a free-text stop', async () => {
  const cases = [blockedBuild('The command npm publish is denied.'), 'STATUS: DONE\n\n## Summary\nNeeds a spec change.\n']
  for (const build of cases) {
    const r = setup('build', { round: 2 }, { [`${DIR}/spec.md`]: SPEC, [`${DIR}/round-2/build.md`]: build })
    await jobAdvance(r.ctx, r.t, { issue: 7, from: 'build', to: 'needs-human', reason: 'stuck' })
    expect(r.t.posts).toEqual(['Factory stopped: stuck'])
    await resume(r)
    await rejects(jobAdvance(r.ctx, r.t, { issue: 7, to: 'spec' }), 'bad-state')
    expect(r.t.states).toEqual(['needs-human'])
  }
})

test('build after a spec update starts the next round, not round 1', async () => {
  const { ctx, t } = setup('spec', { round: 2 }, { [`${DIR}/spec.md`]: SPEC })
  const r = await jobAdvance(ctx, t, { issue: 7, to: 'build' })
  expect(r.round).toBe(3)
  expect(r.roundDir).toBe(`${DIR}/round-3`)
  expect(ctx.calls).toContainEqual(['mkdir', '-p', `${DIR}/round-3`])
  expect((await readJob(ctx, 7)).round).toBe(3)
  expect((await readJob(ctx, 7)).specUpdated).toBe('2026-02-01T00:00:00Z')
  expect(t.comments.map(c => c.name)).toEqual(['spec', 'intake'])
  expect(t.comments.find(c => c.name === 'intake')!.body).toContain('- Round: 3\n')
  const over = setup('spec', { round: 3 }, { [`${DIR}/spec.md`]: SPEC }, { maxRounds: 3 })
  const o = await jobAdvance(over.ctx, over.t, { issue: 7, to: 'build' })
  expect(o.state).toBe('needs-human')
  expect(o.round).toBe(3)
  expect(over.t.comments.map(c => c.name)).toEqual(['spec'])
  expect(over.t.posts).toEqual(['Factory stopped: Round 3 reached the round limit of 3.'])
  expect(over.t.states).toEqual(['needs-human'])
  expect(count(over.ctx, 'mkdir')).toBe(0)
  expect((await readJob(over.ctx, 7)).round).toBe(3)
})

test('needs-human without a spec stop still goes to build', async () => {
  const late = setup('needs-human', { round: 1 }, { [`${DIR}/spec.md`]: SPEC })
  ;(await late.t.get(7)).comments.push(stopComment('Factory stopped: Round 1 reached the round limit of 3.'))
  const r = await jobAdvance(late.ctx, late.t, { issue: 7, to: 'build' })
  expect(r.state).toBe('build')
  expect(r.round).toBe(2)
  const early = setup('needs-human', { round: 0 }, { [`${DIR}/spec.md`]: SPEC })
  expect((await jobAdvance(early.ctx, early.t, { issue: 7, to: 'spec' })).state).toBe('spec')
  expect(early.ctx.calls).toContainEqual(['rm', '-rf', `${DIR}/spec.md`])
})

test('build refuses a blocked spec', async () => {
  const blocked = SPEC.replace('STATUS: READY', 'STATUS: BLOCKED')
  const { ctx, t } = setup('spec', {}, { [`${DIR}/spec.md`]: blocked })
  await rejects(jobAdvance(ctx, t, { issue: 7, to: 'build' }), 'spec-not-ready')
  expect(t.states).toEqual([])
  expect(t.comments).toEqual([])
})

test('build from needs-human before any round is refused', async () => {
  const r = setup('needs-human', { round: 0 }, { [`${DIR}/spec.md`]: SPEC })
  await rejects(jobAdvance(r.ctx, r.t, { issue: 7, to: 'build' }), 'bad-state')
  noEffects(r)
})

test('jobSync takes Round from the intake comment, with round markers as a floor', async () => {
  const mk = (round: number, marker: number | null): Ticket => ({
    kind: 'issue', number: 7, title: 'Add thing', body: 'b', author: 'alice', labels: ['factory', 'factory:build'], state: 'open',
    createdAt: '2026-01-01T00:00:00Z', url: 'u/7',
    comments: [
      { id: 1, author: 'op', body: withMarker('intake', intakeComment({ ...J, round }, INTAKE)), createdAt: '2026-02-01T00:00:00Z', updatedAt: '2026-02-01T00:00:00Z' },
      ...(marker === null ? [] : [{ id: 2, author: 'op', body: withMarker(`round-${marker}` as MarkerName, 'x'), createdAt: '2026-02-01T00:00:00Z', updatedAt: '2026-02-01T00:00:00Z' }]),
    ],
  })
  for (const [round, marker, want] of [[3, 1, 3], [1, 4, 4], [2, null, 2]] as const) {
    const ctx = fakeCtx({ files: { '/repo/.factory/config.json': cfgOf() }, replies: [{ argv: ['git', 'ls-remote'], result: { exitCode: 2 } }, { argv: [] }] })
    const t = { login: async () => 'op', get: async () => mk(round, marker) } as unknown as Tracker
    expect((await jobSync(ctx, t, 7)).job.round).toBe(want)
  }
})

test('rejected reports what cleanup kept', async () => {
  const text = 'DECISION: REJECT\nRISK: low\nSURFACES: none\nLANE: regular\n\n## Reason\nOut of scope.\n'
  const { ctx, t } = setup('intake', {}, { [`${DIR}/intake.md`]: text }, { replies: [{ argv: ['git', 'fetch', '--prune'], result: { exitCode: 1, stderr: 'offline' } }] })
  const r = await jobAdvance(ctx, t, { issue: 7, to: 'rejected' })
  expect(r.cleanup!.kept[0]).toMatchObject({ path: 'factory/7' })
  expect(r.cleanup!.kept[0]!.reason).toContain('offline')
  expect(r.cleanup!.removed).toContain(DIR)
})

const autoCfg = (auto?: boolean): Record<string, string> => ({
  '/repo/.factory/config.json': JSON.stringify({ ...defaultConfig('u', 'main', [{ id: 'node', path: '.' }]), merge: auto === undefined ? { method: 'merge' } : { method: 'merge', auto } }),
})
const allPass = { [`${DIR}/round-1/review-code.md`]: rv('PASS'), [`${DIR}/round-1/review-security.md`]: rv('PASS') }

test('approved returns autoMerge when merge.auto is on', async () => {
  const { ctx, t } = inReview({ ...autoCfg(true), ...allPass, [`${DIR}/decision.md`]: APPROVE })
  const r = await jobAdvance(ctx, t, { issue: 7, to: 'approved' })
  expect(r.state).toBe('approved')
  expect(r.autoMerge).toBe(true)
  expect(t.states).toEqual(['approved'])
})

test('approved has no autoMerge when merge.auto is off', async () => {
  for (const auto of [undefined, false]) {
    const { ctx, t } = inReview({ ...autoCfg(auto), ...allPass, [`${DIR}/decision.md`]: APPROVE })
    const r = await jobAdvance(ctx, t, { issue: 7, to: 'approved' })
    expect(r.state).toBe('approved')
    expect('autoMerge' in r).toBe(false)
  }
})

test('escalate has no autoMerge when merge.auto is on', async () => {
  const { ctx, t } = inReview({ ...autoCfg(true), ...allPass, [`${DIR}/decision.md`]: ESCALATE })
  const r = await jobAdvance(ctx, t, { issue: 7, to: 'needs-human' })
  expect(r.state).toBe('needs-human')
  expect('autoMerge' in r).toBe(false)
})

const WIKI = `${DIR}/wiki-push`
const DOC_WIKI = `${DIR}/wiki`
const DOCS = 'STATUS: DONE\n\n## Summary\nTwo pages.\n\n## Page Orders.md\n# Orders\n\n## Use\nRun it.\n\n## Changes\n- #7: add the thing.\n\n## Page Home.md\n# Home\n- [Orders](Orders)\n'
const GH_GIT = ['git', '-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential']
const CLONE = [...GH_GIT, 'clone', '--depth', '1', 'https://github.com/a/b.wiki.git', WIKI]
const COMMIT = [...GH_GIT, '-C', WIKI, 'commit', '-m', 'docs(wiki): document #7', '-m', 'Refs: #7']
const PUSH = [...GH_GIT, '-C', WIKI, 'push', 'origin', 'HEAD']
const STATUS = [...GH_GIT, '-C', WIKI, 'status', '--porcelain']
const ADD = [...GH_GIT, '-C', WIKI, 'add', '--']
const RM = [...GH_GIT, '-C', WIKI, 'rm', '--quiet', '--']
const CHANGED: Reply = { argv: STATUS, result: { stdout: '?? Orders.md\n' } }
const inDocs = (docs = DOCS, replies: Reply[] = [CHANGED]): Run => setup('docs', { pr: 9, round: 1, reviewed: HEAD }, { [`${DIR}/docs.md`]: docs }, { replies })
const at = (ctx: Run['ctx'], argv: string[]): number => ctx.calls.findIndex(c => c.join(' ') === argv.join(' '))

const times = (ctx: Run['ctx'], argv: string[]): number => ctx.calls.filter(c => c.join(' ') === argv.join(' ')).length

test('a docs job publishes the feature pages and deletes the issue pages', async () => {
  const { ctx, t } = inDocs()
  // The fake clone keeps the files that the test puts in the push folder.
  for (const f of ['Issue-87.md', 'Issue-133.md', 'Pipeline.md', 'Issue-Tracker.md']) ctx.files[`${WIKI}/${f}`] = '# Old\n'
  ctx.files[`${WT}/docs/wiki/Repo.md`] = '# Repo\n'
  const r = await jobAdvance(ctx, t, { issue: 7, to: 'done' })
  expect(r.state).toBe('done')
  expect(at(ctx, ['rm', '-rf', WIKI])).toBeGreaterThan(-1)
  expect(at(ctx, ['rm', '-rf', WIKI])).toBeLessThan(at(ctx, CLONE))
  expect(at(ctx, CLONE)).toBeLessThan(at(ctx, COMMIT))
  expect(ctx.calls).toContainEqual([...RM, 'Issue-133.md', 'Issue-87.md'])
  expect(ctx.files[`${WIKI}/Orders.md`]).toBe('# Orders\n\n## Use\nRun it.\n\n## Changes\n- #7: add the thing.\n')
  expect(ctx.files[`${WIKI}/Home.md`]).toBe('# Home\n- [Orders](Orders)\n')
  expect(ctx.files[`${WIKI}/Issue-7.md`]).toBeUndefined()
  expect(ctx.files[`${WIKI}/Repo.md`]).toBeUndefined()
  expect(ctx.calls).toContainEqual([...ADD, 'Orders.md', 'Home.md'])
  expect(times(ctx, COMMIT)).toBe(1)
  expect(times(ctx, PUSH)).toBe(1)
  expect(at(ctx, COMMIT)).toBeLessThan(at(ctx, PUSH))
  expect(t.states).toEqual(['done'])
  expect(t.log).toContain('close done')
  expect(ctx.calls).toContainEqual(['rm', '-rf', DIR])
  expect(r.cleanup?.removed).toContain(DIR)

  const same = inDocs(DOCS, [])
  expect((await jobAdvance(same.ctx, same.t, { issue: 7, to: 'done' })).state).toBe('done')
  expect(at(same.ctx, COMMIT)).toBe(-1)
  expect(at(same.ctx, PUSH)).toBe(-1)
})

test('a docs job pushes from a fresh clone, not from the documenter clone', async () => {
  const { ctx, t } = inDocs()
  ctx.files[DOC_WIKI] = ''
  ctx.files[`${DOC_WIKI}/_Sidebar.md`] = '# Added by the documenter\n'
  ctx.files[`${DOC_WIKI}/.git/hooks/pre-push`] = '#!/bin/sh\nexit 0\n'
  ctx.files[`${DOC_WIKI}/.git/config`] = '[core]\n\tfsmonitor = /bin/evil\n'
  ctx.files[WIKI] = ''
  expect((await jobAdvance(ctx, t, { issue: 7, to: 'done' })).state).toBe('done')
  expect(at(ctx, ['rm', '-rf', WIKI])).toBeLessThan(at(ctx, CLONE))
  expect(times(ctx, CLONE)).toBe(1)
  expect(times(ctx, PUSH)).toBe(1)
  expect(ctx.calls.some(c => c[0] === 'git' && c.includes(DOC_WIKI))).toBe(false)
  expect(ctx.calls.some(c => c.join(' ').includes(`${DOC_WIKI}/`))).toBe(false)
})

test('a docs job links each changed page in the docs comment', async () => {
  const { ctx, t } = inDocs()
  expect((await jobAdvance(ctx, t, { issue: 7, to: 'done' })).state).toBe('done')
  expect(t.comments).toEqual([{ name: 'docs', body: `Docs: https://github.com/a/b/wiki/Orders, https://github.com/a/b/wiki/Home\n\n${DOCS}` }])
})

test('a docs job rejects docs.md with no page or a bad page name', async () => {
  const cases: [string, string][] = [
    ['STATUS: BLOCKED\n\n## Summary\nNo diff.\n', 'docs-not-done'],
    ['STATUS: DONE\n\n## Summary\nx\n', 'docs-not-done'],
    ['STATUS: DONE\n\n## Summary\nx\n\n## Page\n# Old format\n', 'docs-not-done'],
    ['STATUS: DONE\n\n## Summary\nx\n\n## Page Home.md\n\n', 'docs-not-done'],
    ['STATUS: DONE\n\n## Summary\nx\n\n## Page ../x.md\n# X\n', 'docs-bad-page'],
    ['STATUS: DONE\n\n## Summary\nx\n\n## Page Issue-7.md\n# X\n', 'docs-bad-page'],
  ]
  for (const [bad, code] of cases) {
    const b = inDocs(bad)
    await rejects(jobAdvance(b.ctx, b.t, { issue: 7, to: 'done' }), code)
    expect(b.t.states).toEqual([])
    expect(b.ctx.calls.some(c => c.includes(WIKI) || c.includes(DOC_WIKI))).toBe(false)
  }
})

test('a docs job runs the wiki git calls with the gh credentials', async () => {
  const { ctx, t } = inDocs()
  const runs: { argv: string[]; env?: Record<string, string> }[] = []
  const inner = ctx.run
  ctx.run = async (argv, opts) => {
    runs.push({ argv: [...argv], env: opts?.env })
    return inner(argv, opts)
  }
  expect((await jobAdvance(ctx, t, { issue: 7, to: 'done' })).state).toBe('done')
  for (const step of [CLONE, STATUS, ADD, COMMIT, PUSH]) {
    const hit = runs.find(r => step.every((a, i) => r.argv[i] === a))
    expect(hit?.env).toEqual({ GIT_TERMINAL_PROMPT: '0' })
  }
  const wiki = runs.filter(r => r.argv[0] === 'git' && (r.argv.includes('clone') || r.argv.includes(WIKI)))
  expect(wiki).toHaveLength(5)
  expect(wiki.every(r => GH_GIT.every((a, i) => r.argv[i] === a))).toBe(true)
  expect(runs.some(r => r.argv.join(' ').includes('@github.com'))).toBe(false)
})

test('a failed wiki push moves a docs job to needs-human', async () => {
  const PUSH_FIX = 'Fix: Run gh auth status. gh must be logged in with the repo scope and you need write access to a/b. Then run /factory:run without an issue number.'
  const CLONE_FIX = 'Fix: Open https://github.com/a/b/wiki and create the first page. Then run /factory:run without an issue number.'
  const OTHER_FIX = '\n\nFix the cause. Then run /factory:run without an issue number.'
  const cases: [Reply[], string][] = [
    [[CHANGED, { argv: PUSH, result: { exitCode: 1, stderr: 'remote: Permission denied\n' } }], `the wiki push failed: remote: Permission denied\n${PUSH_FIX}`],
    [[{ argv: CLONE, result: { exitCode: 128, stderr: 'fatal: repository not found\n' } }], `the wiki clone failed: fatal: repository not found\n${CLONE_FIX}`],
    [[{ argv: STATUS, result: { exitCode: 128, stderr: 'fatal: not a repo\n' } }], `the wiki status failed: fatal: not a repo${OTHER_FIX}`],
    [[CHANGED, { argv: ADD, result: { exitCode: 128, stderr: 'fatal: bad path\n' } }], `the wiki add failed: fatal: bad path${OTHER_FIX}`],
    [[CHANGED, { argv: COMMIT, result: { exitCode: 1, stderr: 'fatal: no identity\n' } }], `the wiki commit failed: fatal: no identity${OTHER_FIX}`],
  ]
  for (const [replies, error] of cases) {
    const { ctx, t } = inDocs(DOCS, [...replies])
    const r = await jobAdvance(ctx, t, { issue: 7, to: 'done' })
    expect(r.state).toBe('needs-human')
    expect(t.posts).toEqual([`Factory stopped: ${error}`])
    expect(t.states).toEqual(['needs-human'])
    expect(t.comments).toEqual([])
    expect(t.log).toEqual([])
    expect(ctx.calls).not.toContainEqual(['rm', '-rf', DIR])
  }
})
