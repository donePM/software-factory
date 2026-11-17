import { expect, test } from 'claude-code/testing'
import { defaultConfig } from '../lib/config.ts'
import { FactoryError } from '../lib/exec.ts'
import { invoke, serve, TOOLS, type ToolDef } from '../hooks/tools.ts'
import { renderJob } from '../lib/jobfile.ts'
import { fakeCtx, fakeHost, type Reply } from './support/host.ts'

export const EXPECTED: string[] = ['doctor', 'gate', 'job_create', 'job_sync', 'migrate', 'queue', 'setup']

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
  expect(r).toEqual({ isError: true, result: undefined, text: 'nope: it broke\nFix: do x' })
})

test('a FactoryError without fix prints no Fix line', async () => {
  const r = await invoke(def(async () => { throw new FactoryError('nope', 'it broke') }), fakeCtx(), {})
  expect(r).toEqual({ isError: true, result: undefined, text: 'nope: it broke' })
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

const SHA = 'a'.repeat(40)
const HEAD = 'b'.repeat(40)
const DIR = '/repo/.factory/jobs/7'
const WT7 = '/repo/.factory/worktrees/7'
const jobMd = (wt: string | null = WT7, base: string | null = SHA): string =>
  renderJob({ issue: 7, title: 't', jobDir: DIR, worktree: wt ?? '/x', branch: 'factory/7', base: base ?? SHA, baseBranch: 'main', pr: null, round: 0, specUpdated: null, route: {} })
    .split('\n').filter(l => !((wt === null && l.startsWith('- Worktree:')) || (base === null && l.startsWith('- Base:')))).join('\n')

function jobCtx(files: Record<string, string>, replies: Reply[] = []): ReturnType<typeof fakeCtx> {
  return fakeCtx({
    files: { '/repo/.factory/config.json': JSON.stringify(defaultConfig('u', 'main', [])), ...files },
    replies: [
      { argv: ['git', '-C', WT7, 'rev-parse', 'HEAD'], result: { stdout: `${HEAD}\n` } },
      ...replies,
      { argv: ['git', '-C', WT7, 'merge-base'] },
      { argv: ['git', '-C', '/repo', 'merge-base'] },
      { argv: ['git', '-C', WT7, 'ls-files'] },
      { argv: ['git', '-C', WT7, 'log'] },
      { argv: ['git', '-C', WT7, 'diff'] },
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
  fails(jobCtx({ ...okFiles(), [`${DIR}/job.md`]: jobMd('/repo') }), 'bad-job-worktree'))

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

test('tool gate rejects a bad round', async () => {
  const props = gateDef().inputSchema.properties as { round: { pattern: string } }
  expect(new RegExp(props.round.pattern).test('../../..')).toBe(false)
  expect(new RegExp(props.round.pattern).test('round-2')).toBe(true)
  await expect(gateDef().handler(jobCtx(okFiles()), { issue: 7, round: '../x' })).rejects.toMatchObject({ code: 'bad-round' })
})
