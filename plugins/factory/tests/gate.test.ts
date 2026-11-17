import { expect, test } from 'claude-code/testing'
import { defaultConfig, type Config, type StackRef } from '../lib/config.ts'
import { planGate, runGate } from '../lib/gate.ts'
import type { Detection, Step } from '../lib/stacks/types.ts'
import type { Ctx } from '../lib/types.ts'
import { fakeCtx, type Reply } from './support/host.ts'

const WT = '/wt'
const BASE = 'b4se'
const git = (...a: string[]): string[] => ['git', '-C', WT, ...a]
const LS = git('ls-files', '--cached', '--others', '--exclude-standard')
const pkg = (scripts: Record<string, string>, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ name: 'x', scripts, ...extra })
const cfg = (stacks: StackRef[] = [{ id: 'node', path: '.' }], over: Partial<Config> = {}): string =>
  JSON.stringify({ ...defaultConfig('u', 'main', stacks), ...over })

type Setup = { files?: Record<string, string>; replies?: Reply[]; stacks?: StackRef[]; ls?: string }

// A node repo: package.json in root and worktree, config in root only unless the files say otherwise.
function make(o: Setup = {}): ReturnType<typeof fakeCtx> {
  return fakeCtx({
    files: {
      '/repo/.factory/config.json': cfg(o.stacks),
      '/repo/package.json': pkg({ test: 'vitest' }),
      [`${WT}/package.json`]: pkg({ test: 'vitest' }),
      ...o.files,
    },
    replies: [
      { argv: LS, result: { stdout: o.ls ?? 'package.json\n' } },
      ...(o.replies ?? []),
      { argv: git('show'), result: { exitCode: 128 } },
      { argv: git('log'), result: { stdout: '' } },
      { argv: git('diff'), result: { stdout: '' } },
      { argv: [] },
    ],
  })
}

const baseReplies = (scripts: Record<string, string> = { test: 'vitest' }): Reply[] => [
  { argv: git('show', `${BASE}:package.json`), result: { stdout: pkg(scripts) } },
]

const step = (name: Step['name'], stack = 'node'): Step => ({ name, argv: [name], cwd: '/wt', source: 'default', stack })

test('planGate runs install before test across stacks', () => {
  const out = planGate([step('test', 'a'), step('lint', 'b'), step('install', 'b'), step('build', 'a')])
  expect(out.map(s => s.name)).toEqual(['install', 'lint', 'build', 'test'])
})

test('planGate keeps the order within one step name', () => {
  const out = planGate([{ ...step('lint', 'a'), argv: ['1'] }, { ...step('lint', 'b'), argv: ['2'] }])
  expect(out.map(s => s.argv[0])).toEqual(['1', '2'])
})

test('planGate moves a step behind the one named in after', () => {
  const d: Detection = { stack: 'a', path: '.', variant: '', versions: {}, tools: [], after: ['test'] }
  const out = planGate([step('lint', 'a'), step('test', 'b'), step('build', 'b')], [d])
  expect(out.map(s => [s.stack, s.name])).toEqual([['b', 'build'], ['b', 'test'], ['a', 'lint']])
})

test('a config-only install is sorted before test', async () => {
  const stacks: StackRef[] = [{ id: 'node', path: '.', steps: { install: 'make deps' } }]
  const ctx = make({ stacks })
  await runGate(ctx, { worktree: WT, round: 'setup' })
  const run = ctx.calls.filter(c => c[0] === 'sh' || c[0] === 'npm' || c[0] === 'vp')
  const names = run.map(c => c.join(' '))
  expect(names.indexOf('sh -c make deps')).toBeGreaterThanOrEqual(0)
  expect(names.indexOf('sh -c make deps')).toBeLessThan(names.indexOf('npm run test'))
})

test('gate passes when every step exits 0', async () => {
  const ctx = make()
  const r = await runGate(ctx, { worktree: WT, round: 'setup' })
  expect(r.verdict).toBe('PASS')
  const md = ctx.files['/repo/.factory/gate/setup/checks.md']!
  expect(md.split('\n')[0]).toBe('VERDICT: PASS')
  expect(md).toContain('## Summary')
})

test('gate fails on a red step and keeps running the rest', async () => {
  const ctx = make({ replies: [{ argv: ['vp', 'lint'], result: { exitCode: 1, stderr: 'bad' } }] })
  const r = await runGate(ctx, { worktree: WT, round: 'setup' })
  expect(r.verdict).toBe('FAIL')
  expect(ctx.calls.some(c => c.join(' ') === 'npm run test')).toBe(true)
  expect(r.steps.find(s => s.name === 'lint')?.exitCode).toBe(1)
})

test('every step runs with a 600000 ms timeout in its cwd', async () => {
  const ctx = make()
  const seen: unknown[] = []
  const inner = ctx.run
  const wrapped: Ctx = { ...ctx, run: (argv, opts) => { if (argv[0] === 'vp') seen.push(opts); return inner(argv, opts) } }
  await runGate(wrapped, { worktree: WT, round: 'setup' })
  expect(seen.length).toBeGreaterThan(0)
  for (const o of seen) expect(o).toEqual({ cwd: WT, timeoutMs: 600000 })
})

test('gate fails on a bad commit message', async () => {
  const ctx = make({ replies: [{ argv: git('log'), result: { stdout: 'abc\0bad message\n\x1e' } }, ...baseReplies()] })
  const r = await runGate(ctx, { worktree: WT, round: 'setup', base: BASE })
  expect(r.verdict).toBe('FAIL')
  expect(r.badCommits[0]?.sha).toBe('abc')
  expect(r.badCommits[0]?.problem).toContain('type')
})

// Seen in the E2E: gate-runner read an empty `commits` list as "no commits to check".
test('gate names its commit list after the bad commits only', async () => {
  const ctx = make({ replies: baseReplies() })
  const r = await runGate(ctx, { worktree: WT, round: 'setup', base: BASE })
  expect('commits' in r).toBe(false)
  expect(r.badCommits).toEqual([])
})

test('gate fails on a bad PR title', async () => {
  const ctx = make()
  const r = await runGate(ctx, { worktree: WT, round: 'setup', prTitle: 'Add things' })
  expect(r.verdict).toBe('FAIL')
  expect(r.title).toContain('type')
})

test('gate fails when the branch touches a protected path', async () => {
  const ctx = make({ replies: [{ argv: git('diff'), result: { stdout: '.factory/config.json\0src/a.ts\0' } }, ...baseReplies()] })
  const r = await runGate(ctx, { worktree: WT, round: 'setup', base: BASE })
  expect(r.verdict).toBe('FAIL')
  expect(r.protected).toEqual(['.factory/config.json'])
})

test('gate diffs committed changes only', async () => {
  const ctx = make({ replies: baseReplies() })
  await runGate(ctx, { worktree: WT, round: 'setup', base: BASE })
  expect(ctx.calls).toContainEqual(git('diff', '--name-only', '--no-renames', '-z', `${BASE}...HEAD`))
})

test('gate reads config from the main checkout', async () => {
  const stacks: StackRef[] = [{ id: 'node', path: '.', steps: { test: 'make check' } }]
  const other: StackRef[] = [{ id: 'node', path: '.', steps: { test: 'true' } }]
  const ctx = make({ stacks, files: { [`${WT}/.factory/config.json`]: cfg(other) } })
  await runGate(ctx, { worktree: WT, round: 'setup' })
  expect(ctx.calls).toContainEqual(['sh', '-c', 'make check'])
  expect(ctx.calls).not.toContainEqual(['sh', '-c', 'true'])
})

test('a missing tool is a FAIL with a fix', async () => {
  const ctx = make({ replies: [{ argv: ['vp', 'lint'], result: { exitCode: 127 } }] })
  const r = await runGate(ctx, { worktree: WT, round: 'setup' })
  expect(r.verdict).toBe('FAIL')
  expect(r.report).toContain('Install Vite+')
})

test('a missing tool without a requires entry says install <cmd>', async () => {
  const stacks: StackRef[] = [{ id: 'node', path: '.', steps: { test: 'zzz' } }]
  const ctx = make({ stacks, replies: [{ argv: ['sh', '-c', 'zzz'], result: { exitCode: 127 } }] })
  const r = await runGate(ctx, { worktree: WT, round: 'setup' })
  expect(r.report).toContain('install sh')
})

test('gate appends each run to checks.log as an attempt', async () => {
  const ctx = make({ replies: [{ argv: ['vp', 'lint'], result: { exitCode: 1, stdout: 'LINT-OUT' } }] })
  await runGate(ctx, { worktree: WT, round: 'setup' })
  await runGate(ctx, { worktree: WT, round: 'setup' })
  const log = ctx.files['/repo/.factory/gate/setup/checks.log']!
  expect(log).toContain('## Attempt 1')
  expect(log).toContain('## Attempt 2')
  expect(log).toContain('LINT-OUT')
})

test('gate ignores commits synced from base', async () => {
  const ctx = make({ replies: baseReplies() })
  const r = await runGate(ctx, { worktree: WT, round: 'setup', base: BASE })
  expect(ctx.calls).toContainEqual(git('log', '--first-parent', '--no-merges', '--format=%H%x00%B%x1e', `${BASE}..HEAD`))
  expect(r.badCommits).toEqual([])
})

test('gate takes scripts from the base, not the branch', async () => {
  const ctx = make({
    files: { [`${WT}/package.json`]: pkg({ test: 'true' }) },
    replies: baseReplies({ test: 'vitest run' }),
  })
  await runGate(ctx, { worktree: WT, round: 'setup', base: BASE })
  expect(ctx.calls).toContainEqual(['npm', 'run', 'test'])
})

test('gate fails when the branch changes a package.json script', async () => {
  const ctx = make({
    files: { [`${WT}/package.json`]: pkg({ test: 'true' }) },
    replies: baseReplies({ test: 'vitest' }),
  })
  const r = await runGate(ctx, { worktree: WT, round: 'setup', base: BASE })
  expect(r.verdict).toBe('FAIL')
  expect(r.scriptsChanged).toEqual(['package.json'])
})

test('gate allows a dependency change in package.json', async () => {
  const ctx = make({
    files: { [`${WT}/package.json`]: pkg({ test: 'vitest' }, { dependencies: { a: '1' } }) },
    replies: baseReplies({ test: 'vitest' }),
  })
  const r = await runGate(ctx, { worktree: WT, round: 'setup', base: BASE })
  expect(r.scriptsChanged).toEqual([])
  expect(r.verdict).toBe('PASS')
})

test('gate fails when the branch adds or changes a Makefile', async () => {
  const ctx = make({ files: { [`${WT}/Makefile`]: 'test:\n\ttrue\n' }, replies: baseReplies() })
  const r = await runGate(ctx, { worktree: WT, round: 'setup', base: BASE })
  expect(r.verdict).toBe('FAIL')
  expect(r.scriptsChanged).toEqual(['Makefile'])
})

test('setup gate writes to .factory/gate/setup', async () => {
  const ctx = make()
  await runGate(ctx, { worktree: WT, round: 'setup' })
  expect(ctx.files['/repo/.factory/gate/setup/checks.md']).toBeDefined()
})

test('a job gate writes to the round folder of the job', async () => {
  const ctx = make()
  await runGate(ctx, { worktree: WT, round: 'round-2', jobDir: '/repo/.factory/jobs/5' })
  expect(ctx.files['/repo/.factory/jobs/5/round-2/checks.md']).toBeDefined()
})

const diffReply = (out: string): Reply[] => [{ argv: git('diff'), result: { stdout: out } }, ...baseReplies()]

test('a rename of a protected path lists the old path', async () => {
  const ctx = make({ replies: diffReply('.factory/config.json\0old.json\0') })
  const r = await runGate(ctx, { worktree: WT, round: 'setup', base: BASE })
  expect(r.verdict).toBe('FAIL')
  expect(r.protected).toEqual(['.factory/config.json'])
})

for (const f of ['GNUmakefile', 'sub/makefile', 'rules.mk', 'sub/.npmrc']) {
  test(`gate fails when the branch changes ${f}`, async () => {
    const ctx = make({ replies: diffReply(`${f}\0`) })
    const r = await runGate(ctx, { worktree: WT, round: 'setup', base: BASE })
    expect(r.verdict).toBe('FAIL')
    expect(r.scriptsChanged).toEqual([f])
  })
}

test('a configured stack that is not detected is a FAIL that names it', async () => {
  const ctx = make({ ls: '', stacks: [{ id: 'node', path: 'app' }] })
  const r = await runGate(ctx, { worktree: WT, round: 'setup' })
  expect(r.verdict).toBe('FAIL')
  expect(r.missingStacks).toEqual(['node app'])
  expect(r.report).toContain('node app')
})

test('a run with zero steps is a FAIL', async () => {
  const ctx = make({ ls: '', stacks: [] })
  const r = await runGate(ctx, { worktree: WT, round: 'setup' })
  expect(r.steps).toEqual([])
  expect(r.verdict).toBe('FAIL')
})

test('a job gate fails when the config lists no stacks', async () => {
  const ctx = make({ stacks: [], replies: baseReplies() })
  const r = await runGate(ctx, { worktree: WT, round: 'round-1', base: BASE, jobDir: '/repo/.factory/jobs/7' })
  expect(r.steps.length).toBeGreaterThan(0)
  expect(r.verdict).toBe('FAIL')
  expect(r.report).toContain('## No stacks')
})

test('a setup gate with no configured stacks runs the detected stacks', async () => {
  const ctx = make({ stacks: [] })
  const r = await runGate(ctx, { worktree: WT, round: 'setup' })
  expect(r.steps.length).toBeGreaterThan(0)
  expect(r.report).not.toContain('## No stacks')
})

test('runGate rejects a round that is not a round name', async () => {
  const ctx = make()
  for (const round of ['../../..', 'round-0', 'round-1\nx', 'other']) {
    await expect(runGate(ctx, { worktree: WT, round })).rejects.toMatchObject({ code: 'bad-round' })
  }
})

const STATUS = git('status', '--porcelain', '-z', '--untracked-files=all')
const STATUS_IGNORED = git('status', '--porcelain', '-z', '--ignored', '--untracked-files=all')

test('gate fails on an uncommitted change in the worktree', async () => {
  const ctx = make({ replies: [{ argv: STATUS, result: { stdout: ' M src/a.ts\0' } }, ...baseReplies()] })
  const r = await runGate(ctx, { worktree: WT, round: 'setup', base: BASE })
  expect(r.verdict).toBe('FAIL')
  expect(r.report).toContain('## Working tree')
  expect(r.report).toContain('src/a.ts')
})

test('gate fails on an untracked file in the worktree', async () => {
  const ctx = make({ replies: [{ argv: STATUS, result: { stdout: '?? new.ts\0' } }, ...baseReplies()] })
  expect((await runGate(ctx, { worktree: WT, round: 'setup', base: BASE })).verdict).toBe('FAIL')
})

for (const f of ['.npmrc', 'Makefile', 'GNUmakefile', 'makefile', 'rules.mk', '.factory/config.json']) {
  test(`gate fails on an ignored ${f}`, async () => {
    const ctx = make({ replies: [{ argv: STATUS_IGNORED, result: { stdout: `!! ${f}\0` } }, ...baseReplies()] })
    const r = await runGate(ctx, { worktree: WT, round: 'setup', base: BASE })
    expect(r.verdict).toBe('FAIL')
    expect(r.report).toContain(f)
  })
}

test('gate passes with an ignored node_modules file', async () => {
  const ctx = make({ replies: [{ argv: STATUS_IGNORED, result: { stdout: '!! node_modules/a/index.js\0!! dist/x.js\0' } }, ...baseReplies()] })
  expect((await runGate(ctx, { worktree: WT, round: 'setup', base: BASE })).verdict).toBe('PASS')
})

test('the clean-tree check needs a base: a setup run in the main checkout skips it', async () => {
  const ctx = make({ replies: [{ argv: STATUS, result: { stdout: ' M x\0' } }] })
  expect((await runGate(ctx, { worktree: WT, round: 'setup' })).verdict).toBe('PASS')
})

test('an ignored runner file in a dependency folder or a non-stack folder is fine', async () => {
  const out = '!! node_modules/x/build/Makefile\0!! node_modules/x/build/a.target.mk\0!! sub/.npmrc\0!! vendor/Makefile\0'
  const ctx = make({ replies: [{ argv: STATUS_IGNORED, result: { stdout: out } }, ...baseReplies()] })
  expect((await runGate(ctx, { worktree: WT, round: 'setup', base: BASE })).verdict).toBe('PASS')
})

test('an ignored .npmrc in a stack path fails', async () => {
  const stacks: StackRef[] = [{ id: 'node', path: 'app' }]
  const ctx = make({
    stacks,
    ls: 'app/package.json\n',
    files: { [`${WT}/app/package.json`]: pkg({ test: 'vitest' }), '/repo/app/package.json': pkg({ test: 'vitest' }) },
    replies: [
      { argv: STATUS_IGNORED, result: { stdout: '!! app/.npmrc\0' } },
      { argv: git('show', `${BASE}:app/package.json`), result: { stdout: pkg({ test: 'vitest' }) } },
      ...baseReplies(),
    ],
  })
  const r = await runGate(ctx, { worktree: WT, round: 'setup', base: BASE })
  expect(r.verdict).toBe('FAIL')
  expect(r.report).toContain('app/.npmrc')
})
