import { expect, test } from 'claude-code/testing'
import { defaultConfig } from '../lib/config.ts'
import { jobAdvance, jobSync, roundSummary, intakeComment } from '../lib/job.ts'
import { parseIntake } from '../lib/intake.ts'
import { renderJob, readJob, type Job } from '../lib/jobfile.ts'
import { stateOf } from '../lib/labels.ts'
import { withMarker, type MarkerName } from '../lib/markers.ts'
import { route } from '../lib/route.ts'
import { assertTransition } from '../lib/transitions.ts'
import type { Tracker } from '../lib/tracker.ts'
import type { Comment, State, Ticket } from '../lib/types.ts'
import { TOOLS } from '../hooks/tools.ts'
import { fakeCtx, type Reply } from './support/host.ts'

const SHA = 'a'.repeat(40)
const HEAD = 'b'.repeat(40)
const DIR = '/repo/.factory/jobs/7'
const WT = '/repo/.factory/worktrees/7'
const cfgOf = (maxRounds = 3): string =>
  JSON.stringify({ ...defaultConfig('u', 'main', [{ id: 'node', path: '.' }]), maxRounds })
const pkg = JSON.stringify({ name: 'x', scripts: { test: 'vitest' } })

const J: Job = {
  issue: 7, title: 'Add thing', jobDir: DIR, worktree: WT, branch: 'factory/7', base: SHA, baseBranch: 'main',
  pr: null, round: 0, specUpdated: null, route: { code: 'sonnet', security: 'opus' },
}
const INTAKE = 'DECISION: ACCEPT\nRISK: high\nSURFACES: security\nLANE: regular\n\n## Summary\nDo it.\n\n## Scope\nsmall\n'
const SPEC = 'STATUS: READY\nTitle: feat: add thing\n\n## Summary\nx\n'
const BUILD = 'STATUS: DONE\n\n## Summary\nBuilt the thing.\n'
const rv = (verdict: 'PASS' | 'CHANGES', blocker = ''): string =>
  `VERDICT: ${verdict}\n\n## Summary\nok\n\n## Findings\n${blocker === '' ? '' : `1. [blocker] ${blocker}\n`}`
const APPROVE = 'DECISION: APPROVE\n\n## Summary\nGood.\n'
const ESCALATE = 'DECISION: ESCALATE\n\n## Summary\nUnsure.\n\n## Question\nPublic API?\n'

type Run = { ctx: ReturnType<typeof fakeCtx>; t: ReturnType<typeof tracker> }

function tracker(labels: string[], author = 'alice') {
  const log: string[] = []
  const comments: { name: string; body: string }[] = []
  const posts: string[] = []
  const prs: { branch: string; base: string; title: string; body: string; labels: string[] }[] = []
  const prComments: string[] = []
  const states: State[] = []
  const ticket: Ticket = {
    kind: 'issue', number: 7, title: 'Add thing', body: 'b', author, labels: ['factory', ...labels],
    state: 'open', createdAt: '2026-01-01T00:00:00Z', url: 'u/7', comments: [],
  }
  const t = {
    log, comments, posts, prs, prComments, states,
    login: async () => 'op',
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
    prReady: async (pr: number) => { log.push(`ready ${pr}`) },
    prComment: async (_pr: number, body: string) => { prComments.push(body) },
  }
  return t as unknown as Tracker & typeof t
}

function setup(state: string, over: Partial<Job> = {}, files: Record<string, string> = {}, o: { maxRounds?: number; replies?: Reply[]; author?: string } = {}): Run {
  const job = { ...J, ...over }
  const replies: Reply[] = [
    ...(o.replies ?? []),
    { argv: ['git', '-C', WT, 'rev-parse', 'HEAD'], result: { stdout: `${HEAD}\n` } },
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
      [`${DIR}/job.md`]: renderJob(job),
      [`${DIR}/intake.md`]: INTAKE,
      ...files,
    },
    replies,
  })
  return { ctx, t: tracker([`factory:${state}`], o.author) }
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
  expect(body).toContain('@alice')
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

test('rejected closes the issue as not planned and removes the job folder', async () => {
  const text = 'DECISION: REJECT\nRISK: low\nSURFACES: none\nLANE: regular\n\n## Reason\nOut of scope.\n'
  const { ctx, t } = setup('intake', {}, { [`${DIR}/intake.md`]: text })
  await jobAdvance(ctx, t, { issue: 7, to: 'rejected' })
  expect(t.comments.find(c => c.name === 'intake')!.body).toContain('## Reason')
  expect(t.log).toContain('close rejected')
  expect(ctx.calls).toContainEqual(['rm', '-rf', DIR])
  expect(ctx.calls.filter(c => c.includes('worktree'))).toEqual([])
  expect(ctx.calls.filter(c => c[0] === 'rm')).toHaveLength(1)
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
  await rejects(jobAdvance(ctx, t, { issue: 7, to: 'review' }), 'gate-not-green')
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
  expect(ctx.calls).toContainEqual(['git', '-C', WT, 'push', '-u', 'origin', 'factory/7'])
  expect(t.prs).toHaveLength(1)
  expect(t.prs[0]).toMatchObject({ branch: 'factory/7', base: 'main', title: 'feat: add thing', labels: ['factory:pr', 'type:feat'] })
  expect(r.reviewers).toEqual(['code', 'security'])
  expect((await readJob(ctx, 7)).pr).toBe(12)
  expect(t.comments.find(c => c.name === 'intake')!.body).toContain('- PR: #12\n')
  expect(ctx.files[`${DIR}/round-1/checks.md`]!.startsWith('VERDICT: PASS')).toBe(true)
  // second advance to review (after a rework round): push again, no second PR
  const again = inBuild()
  again.ctx.files[`${DIR}/job.md`] = renderJob({ ...J, round: 2, pr: 12 })
  again.ctx.files[`${DIR}/round-2/build.md`] = BUILD
  await jobAdvance(again.ctx, again.t, { issue: 7, to: 'review' })
  expect(again.t.prs).toHaveLength(0)
  expect(count(again.ctx, 'git', '-C', WT, 'push')).toBe(1)
})

test('PR body closes the issue', async () => {
  const { ctx, t } = inBuild()
  await jobAdvance(ctx, t, { issue: 7, to: 'review' })
  expect(t.prs[0]!.body.startsWith('Closes #7')).toBe(true)
  expect(t.prs[0]!.body).toContain('Built the thing.')
})

test('a breaking title adds the breaking label', async () => {
  const { ctx, t } = inBuild({ [`${DIR}/spec.md`]: SPEC.replace('feat:', 'feat!:') })
  await jobAdvance(ctx, t, { issue: 7, to: 'review' })
  expect(t.prs[0]!.labels).toEqual(['factory:pr', 'type:feat', 'type:breaking'])
})

const inReview = (files: Record<string, string>, o: Parameters<typeof setup>[3] = {}, over: Partial<Job> = {}): Run =>
  setup('review', { round: 1, pr: 12, ...over }, { [`${DIR}/spec.md`]: SPEC, [`${DIR}/round-1/checks.md`]: 'VERDICT: PASS\n', ...files }, o)

test('approved waits for all routed reviews', async () => {
  const { ctx, t } = inReview({ [`${DIR}/round-1/review-code.md`]: rv('PASS'), [`${DIR}/decision.md`]: APPROVE })
  await expect(jobAdvance(ctx, t, { issue: 7, to: 'approved' })).rejects.toMatchObject({ code: 'reviews-missing', message: expect.stringContaining('security') })
  expect(t.states).toEqual([])
})

test('approved needs every review PASS and decision APPROVE', async () => {
  const files = { [`${DIR}/round-1/review-code.md`]: rv('PASS'), [`${DIR}/round-1/review-security.md`]: rv('PASS'), [`${DIR}/decision.md`]: APPROVE }
  const { ctx, t } = inReview(files)
  const r = await jobAdvance(ctx, t, { issue: 7, to: 'approved' })
  expect(r.state).toBe('approved')
  expect(t.log).toContain('ready 12')
  expect(t.comments.map(c => c.name)).toEqual(['round-1', 'decision'])
  expect(t.states).toEqual(['approved'])
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
  expect(t.comments.map(c => c.name)).toEqual(['round-1', 'decision'])
  expect(t.states).toEqual(['needs-human'])
})

test('changes start the next round', async () => {
  const files = { [`${DIR}/round-1/review-code.md`]: rv('PASS'), [`${DIR}/round-1/review-security.md`]: rv('CHANGES', 'fix it') }
  const { ctx, t } = inReview(files)
  const r = await jobAdvance(ctx, t, { issue: 7, to: 'build' })
  expect(r.round).toBe(2)
  expect(r.roundDir).toBe(`${DIR}/round-2`)
  expect(ctx.calls).toContainEqual(['mkdir', '-p', `${DIR}/round-2`])
  expect((await readJob(ctx, 7)).round).toBe(2)
  expect(t.comments.map(c => c.name)).toEqual(['round-1'])
  expect(t.states).toEqual(['build'])
})

test('build from review needs a CHANGES review and all routed files', async () => {
  const allPass = inReview({ [`${DIR}/round-1/review-code.md`]: rv('PASS'), [`${DIR}/round-1/review-security.md`]: rv('PASS') })
  await rejects(jobAdvance(allPass.ctx, allPass.t, { issue: 7, to: 'build' }), 'no-changes')
  const missing = inReview({ [`${DIR}/round-1/review-code.md`]: rv('CHANGES', 'x') })
  await rejects(jobAdvance(missing.ctx, missing.t, { issue: 7, to: 'build' }), 'reviews-missing')
})

test('round over maxRounds goes to needs-human', async () => {
  const files = { [`${DIR}/round-3/review-code.md`]: rv('CHANGES', 'x'), [`${DIR}/round-3/review-security.md`]: rv('PASS'), [`${DIR}/round-3/checks.md`]: 'VERDICT: PASS\n' }
  const { ctx, t } = inReview(files, { maxRounds: 3 }, { round: 3 })
  const r = await jobAdvance(ctx, t, { issue: 7, to: 'build' })
  expect(r.state).toBe('needs-human')
  expect(r.note).toContain('3')
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

test('build from needs-human starts the next round', async () => {
  const { ctx, t } = setup('needs-human', { round: 1 }, { [`${DIR}/spec.md`]: SPEC })
  const r = await jobAdvance(ctx, t, { issue: 7, to: 'build' })
  expect(r.round).toBe(2)
  expect(t.states).toEqual(['build'])
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
  await rejects(jobAdvance(ctx, t, { issue: 7, to: 'needs-human' }), 'reason-required')
})

test('unsupported targets and illegal moves are refused', async () => {
  const a = inBuild()
  await rejects(jobAdvance(a.ctx, a.t, { issue: 7, to: 'done' }), 'unsupported-target')
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
  const job: Job = { ...J, pr: 12, specUpdated: '2026-02-01T00:00:00Z', route: { code: 'sonnet', security: 'opus', ui: 'haiku' } }
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
  expect(r.job.specUpdated).toBe('2026-02-01T00:00:00Z')
  expect(r.job.route).toEqual(job.route)
  expect(ctx.files[`${DIR}/intake.md`]).toBe(INTAKE)
  const none = intakeComment({ ...J, pr: null, specUpdated: null, route: {} }, INTAKE)
  expect(none).toContain('## Job')
  expect(none).toContain('## Route')
})

const advDef = () => TOOLS.find(t => t.name === 'job_advance')!

test('job_advance is registered and validates its input', async () => {
  expect(TOOLS.map(t => t.name)).toContain('job_advance')
  const ctx = fakeCtx()
  for (const input of [{}, { issue: 0, to: 'spec' }, { issue: 1.5, to: 'spec' }, { issue: '7', to: 'spec' }, { issue: 7, to: 'nope' }, { issue: 7 }, { issue: 7, to: 'spec', reason: 5 }]) {
    await rejects(advDef().handler(ctx, input), 'bad-input')
  }
})
