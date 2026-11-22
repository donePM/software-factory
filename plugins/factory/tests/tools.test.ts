import { expect, test } from 'claude-code/testing'
import { defaultConfig } from '../lib/config.ts'
import { FactoryError } from '../lib/exec.ts'
import { invoke, serve, TOOLS, type ToolDef } from '../hooks/tools.ts'
import { renderJob } from '../lib/jobfile.ts'
import { fakeCtx, fakeHost, type Reply } from './support/host.ts'

export const EXPECTED: string[] = ['approve', 'cleanup', 'doctor', 'gate', 'issue_create', 'issue_search', 'job_advance', 'job_create', 'job_sync', 'merge', 'migrate', 'queue', 'setup', 'status']

test('registers exactly the expected tools undeferred', async ($, on) => {
  const { registered } = fakeHost(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: false })
  expect(registered.map(t => t.name).sort()).toEqual([...EXPECTED].sort())
  for (const t of registered) expect(t.isDeferred).toBe(false)
})

const def = (handler: ToolDef['handler']): ToolDef => ({ name: 't', description: 'd', inputSchema: {}, handler })

test('a tool success returns pretty JSON', async () => {
  const r = await invoke(def(async () => ({ a: 1 })), fakeCtx(), {})
  expect(r).toEqual({ result: JSON.stringify({ a: 1 }, null, 2) })
})

test('a FactoryError maps to isError with the fix', async () => {
  const r = await invoke(def(async () => { throw new FactoryError('nope', 'it broke', 'do x') }), fakeCtx(), {})
  expect(r).toEqual({ isError: true, result: 'nope: it broke\nFix: do x' })
})

test('a FactoryError without fix prints no Fix line', async () => {
  const r = await invoke(def(async () => { throw new FactoryError('nope', 'it broke') }), fakeCtx(), {})
  expect(r).toEqual({ isError: true, result: 'nope: it broke' })
})

test('serve passes only the tool arguments, without tool', async () => {
  let seen: unknown
  TOOLS.push({ name: 'probe_input', description: 'd', inputSchema: {}, handler: async (_c, input) => { seen = input; return {} } })
  try {
    const $ = { session: { root: async () => '/repo' } }
    await serve($, { tool: 'mcp__factory__probe_input', n: 1 }, async () => 'next')
  } finally {
    TOOLS.pop()
  }
  expect(seen).toEqual({ n: 1 })
})

const FIX = 'Fix: Read the error. Fix the cause. Then call the tool again.'

test('an unexpected error maps to isError with a Fix line', async () => {
  const r = await invoke(def(async () => { throw new Error('spawn timeout') }), fakeCtx(), {})
  expect(r).toEqual({ isError: true, result: `internal: t: spawn timeout\n${FIX}` })
})

test('a thrown non-Error value maps to isError with a Fix line', async () => {
  const r = await invoke(def(async () => { throw 'boom' }), fakeCtx(), {})
  expect(r).toEqual({ isError: true, result: `internal: t: boom\n${FIX}` })
})

test('serve answers an unexpected error with an error text', async () => {
  TOOLS.push({ name: 'probe_error', description: 'd', inputSchema: {}, handler: async () => { throw new Error('gone') } })
  let r: unknown
  try {
    const $ = { session: { root: async () => '/repo' } }
    r = await serve($, { tool: 'mcp__factory__probe_error' }, async () => 'next')
  } finally {
    TOOLS.pop()
  }
  expect(r).toEqual({ isError: true, result: `internal: probe_error: gone\n${FIX}` })
})

test('a tool call writes no file under .factory/logs', async () => {
  const ctx = fakeCtx({ replies: [{ argv: ['git'], result: { stdout: 'x' } }] })
  const r = await invoke(def(async c => (await c.run(['git'])).stdout), ctx, {})
  expect(r).toEqual({ result: 'x' })
  const e = await invoke(def(async c => { await c.run(['git']); throw new FactoryError('nope', 'it broke') }), ctx, {})
  expect(e).toEqual({ isError: true, result: 'nope: it broke' })
  expect(Object.keys(ctx.files).filter(k => k.startsWith('/repo/.factory/logs/'))).toEqual([])
})

test('invoke passes the ctx to the handler unchanged', async () => {
  const ctx = fakeCtx()
  let seen: unknown
  await invoke(def(async c => { seen = c; return {} }), ctx, {})
  expect(seen).toBe(ctx)
})

const SHA = 'a'.repeat(40)
const HEAD = 'b'.repeat(40)
const MB = 'e'.repeat(40)
const DIR = '/repo/.factory/jobs/7'
const WT7 = '/repo/.factory/worktrees/7'
const jobMd = (wt: string | null = WT7, base: string | null = SHA): string =>
  renderJob({ issue: 7, title: 't', jobDir: DIR, worktree: wt ?? '/x', branch: 'factory/7', base: base ?? SHA, baseBranch: 'main', pr: null, round: 0, specUpdated: null, reviewed: null, route: {}, language: 'English' })
    .split('\n').filter(l => !((wt === null && l.startsWith('- Worktree:')) || (base === null && l.startsWith('- Base:')))).join('\n')

function jobCtx(files: Record<string, string>, replies: Reply[] = []): ReturnType<typeof fakeCtx> {
  return fakeCtx({
    files: { '/repo/.factory/config.json': JSON.stringify(defaultConfig('u', 'main', [])), ...files },
    replies: [
      { argv: ['git', '-C', WT7, 'rev-parse', 'HEAD'], result: { stdout: `${HEAD}\n` } },
      ...replies,
      { argv: ['git', '-C', WT7, 'fetch', 'origin', 'main'] },
      { argv: ['git', '-C', WT7, 'merge-base', 'HEAD', 'origin/main'], result: { stdout: `${MB}\n` } },
      { argv: ['git', '-C', WT7, 'merge-base'] },
      { argv: ['git', '-C', '/repo', 'merge-base'] },
      { argv: ['git', '-C', WT7, 'ls-files'] },
      { argv: ['git', '-C', WT7, 'log'] },
      { argv: ['git', '-C', WT7, 'diff'] },
      { argv: ['git', '-C', WT7, 'status'] },
    ],
  })
}

const gateDef = (): ToolDef => TOOLS.find(t => t.name === 'gate')!
const okFiles = (): Record<string, string> => ({ [`${DIR}/job.md`]: jobMd(), [`${DIR}/spec.md`]: 'Title: feat: x\n' })
const fails = (ctx: Parameters<ToolDef['handler']>[0], code: string): Promise<void> =>
  expect(gateDef().handler(ctx, { issue: 7 })).rejects.toMatchObject({ code })

test('tool gate reads the PR title from spec.md', async () => {
  const ctx = jobCtx({ ...okFiles(), [`${DIR}/spec.md`]: 'STATUS: READY\nTitle: nope\n' })
  const out = (await gateDef().handler(ctx, { issue: 7 })) as { verdict: string; title?: string }
  expect(out.verdict).toBe('FAIL')
  expect(out.title).toContain('type')
  expect(ctx.files[`${DIR}/setup/checks.md`]?.startsWith('VERDICT: FAIL')).toBe(true)
})

test('tool gate fails without job.md', () => fails(jobCtx({}), 'no-job'))
test('tool gate fails without a Worktree field', () => fails(jobCtx({ ...okFiles(), [`${DIR}/job.md`]: jobMd(null) }), 'bad-job'))
test('tool gate fails without a Base field', () => fails(jobCtx({ ...okFiles(), [`${DIR}/job.md`]: jobMd(WT7, null) }), 'bad-job'))
test('tool gate fails without spec.md', () => fails(jobCtx({ [`${DIR}/job.md`]: jobMd() }), 'no-spec'))
test('tool gate fails without a Title line', () => fails(jobCtx({ ...okFiles(), [`${DIR}/spec.md`]: 'STATUS: READY\n' }), 'spec-no-title'))

test('tool gate rejects a relative worktree', () =>
  fails(jobCtx({ ...okFiles(), [`${DIR}/job.md`]: jobMd('.factory/worktrees/7') }), 'bad-job'))

test('tool gate rejects a worktree outside .factory/worktrees/<n>', () =>
  fails(jobCtx({ ...okFiles(), [`${DIR}/job.md`]: jobMd('/repo') }), 'bad-job'))

test('tool gate rejects a base that is not a full sha', () =>
  fails(jobCtx({ ...okFiles(), [`${DIR}/job.md`]: jobMd(WT7, 'abc123') }), 'bad-job'))

test('tool gate rejects Base none', () =>
  fails(jobCtx({ ...okFiles(), [`${DIR}/job.md`]: jobMd(WT7, 'none') }), 'bad-job-base'))

test('tool gate rejects a base equal to HEAD', () =>
  fails(jobCtx({ ...okFiles(), [`${DIR}/job.md`]: jobMd(WT7, HEAD) }), 'bad-job-base'))

test('tool gate rejects a base that is not an ancestor of HEAD', () =>
  fails(jobCtx(okFiles(), [{ argv: ['git', '-C', WT7, 'merge-base', '--is-ancestor'], result: { exitCode: 1 } }]), 'bad-job-base'))

test('tool gate rejects a base that is not on the base branch', () =>
  fails(jobCtx(okFiles(), [{ argv: ['git', '-C', '/repo', 'merge-base', '--is-ancestor', SHA, 'origin/main'], result: { exitCode: 1 } }]), 'bad-job-base'))

test('tool gate accepts a base that is on origin/main but not on local main', async () => {
  const ctx = jobCtx(okFiles(), [{ argv: ['git', '-C', '/repo', 'merge-base', '--is-ancestor', SHA, 'main'], result: { exitCode: 1 } }])
  const out = (await gateDef().handler(ctx, { issue: 7 })) as { verdict: string }
  expect(out.verdict).toBeDefined()
  expect(ctx.calls).toContainEqual(['git', '-C', '/repo', 'merge-base', '--is-ancestor', SHA, 'origin/main'])
})

const diffOf = (base: string): string[] => ['git', '-C', WT7, 'diff', '--name-only', '--no-renames', '-z', `${base}...HEAD`]
const gateOut = async (ctx: ReturnType<typeof jobCtx>): Promise<{ verdict: string; protected: string[] }> =>
  (await gateDef().handler(ctx, { issue: 7 })) as { verdict: string; protected: string[] }

test('tool gate ignores a protected path that came in through a sync merge', async () => {
  const ctx = jobCtx(okFiles(), [
    { argv: diffOf(SHA), result: { stdout: '.factory/config.json\0' } },
    { argv: diffOf(MB), result: { stdout: '' } },
  ])
  const out = await gateOut(ctx)
  expect(out.protected).toEqual([])
  const fetchAt = ctx.calls.findIndex(c => c.join(' ') === `git -C ${WT7} fetch origin main`)
  const baseAt = ctx.calls.findIndex(c => c.join(' ') === `git -C ${WT7} merge-base HEAD origin/main`)
  expect(fetchAt).toBeGreaterThan(-1)
  expect(baseAt).toBeGreaterThan(fetchAt)
  expect(ctx.calls).toContainEqual(diffOf(MB))
})

test('tool gate still fails on a protected path that the branch changes after a sync', async () => {
  const ctx = jobCtx(okFiles(), [{ argv: ['git', '-C', WT7, 'diff'], result: { stdout: '.factory/config.json\0' } }])
  const out = await gateOut(ctx)
  expect(out.protected).toEqual(['.factory/config.json'])
  expect(out.verdict).toBe('FAIL')
})

test('tool gate reads the log and the base files from the merge base', async () => {
  const ctx = jobCtx({ ...okFiles(), [`${WT7}/package.json`]: '{}' }, [{ argv: ['git', '-C', WT7, 'ls-files'], result: { stdout: 'package.json\n' } }])
  await gateOut(ctx)
  const log = ctx.calls.find(c => c[3] === 'log')
  expect(log?.at(-1)).toBe(`${MB}..HEAD`)
  const shows = ctx.calls.filter(c => c[3] === 'show')
  expect(shows.length).toBeGreaterThan(0)
  expect(shows.every(c => c[4]?.startsWith(`${MB}:`))).toBe(true)
})

test('tool gate fails when it cannot find the merge base', async () => {
  const noStep = (ctx: ReturnType<typeof jobCtx>): void => expect(ctx.calls.some(c => c[0] !== 'git')).toBe(false)
  const cases: [Reply, string][] = [
    [{ argv: ['git', '-C', WT7, 'fetch'], result: { exitCode: 1, stderr: 'offline' } }, 'fetch-failed'],
    [{ argv: ['git', '-C', WT7, 'merge-base', 'HEAD', 'origin/main'], result: { exitCode: 1 } }, 'bad-job-base'],
    [{ argv: ['git', '-C', WT7, 'merge-base', 'HEAD', 'origin/main'], result: { stdout: 'abc\n' } }, 'bad-job-base'],
  ]
  for (const [reply, code] of cases) {
    const ctx = jobCtx({ ...okFiles(), [`${WT7}/package.json`]: '{}' }, [reply])
    await fails(ctx, code)
    noStep(ctx)
  }
})

test('tool gate rejects a bad round', async () => {
  const props = gateDef().inputSchema.properties as { round: { pattern: string } }
  expect(new RegExp(props.round.pattern).test('../../..')).toBe(false)
  expect(new RegExp(props.round.pattern).test('round-2')).toBe(true)
  await expect(gateDef().handler(jobCtx(okFiles()), { issue: 7, round: '../x' })).rejects.toMatchObject({ code: 'bad-round' })
})

test('a tool that returns text sends it unquoted', async () => {
  const r = await invoke(def(async () => 'a\nb'), fakeCtx(), {})
  expect(r).toEqual({ result: 'a\nb' })
})
