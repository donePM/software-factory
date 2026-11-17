import { expect, test } from 'claude-code/testing'
import type { StackRef } from '../lib/config.ts'
import { doctor } from '../lib/doctor.ts'
import { setup } from '../lib/setup.ts'
import { claudePlugin, typesSource } from '../lib/stacks/claude-plugin.ts'
import { detectAll, resolveSteps } from '../lib/stacks/index.ts'
import type { Detection } from '../lib/stacks/types.ts'
import { pluginBasic } from './fixtures/claude-plugin-basic.ts'
import { pluginMarket } from './fixtures/claude-plugin-market.ts'
import { fakeCtx, type Reply } from './support/host.ts'

const LS = ['git', '-C', '/repo', 'ls-files', '--cached', '--others', '--exclude-standard']
const lsReply = (files: Record<string, string>): Reply => ({ argv: LS, result: { stdout: Object.keys(files).join('\n') } })
const P = 'plugins/factory'
const none = async (): Promise<string | null> => null
const det = (path: string, variant = 'plugin', tools = ['claude', 'tsc', 'tests']): Detection => ({
  stack: 'claude-plugin', path, variant, versions: {}, tools,
})

test('detects a plugin and a marketplace in one repo', async () => {
  const ds = await detectAll(fakeCtx({ replies: [lsReply(pluginMarket)] }), '/repo')
  expect(ds.map(d => [d.stack, d.path, d.variant])).toEqual([
    ['claude-plugin', P, 'plugin'],
    ['claude-plugin', '.', 'marketplace'],
  ])
})

test('plugin steps are typecheck, lint, test', async () => {
  const ctx = fakeCtx()
  const steps = await claudePlugin.steps(ctx, none, det(P))
  expect(steps.map(s => s.name)).toEqual(['typecheck', 'lint', 'test'])
  expect(steps[1]!.argv).toEqual(['claude', 'plugin', 'validate', P])
  expect(steps[2]!.argv).toEqual(['claude', 'plugin', 'test', P])
  expect(steps.every(s => s.cwd === '/repo')).toBe(true)
})

test('plugin without tests has no test step', async () => {
  const files = { ...pluginBasic }
  delete files['plugins/factory/tests/a.test.ts']
  const [d] = await claudePlugin.detect(fakeCtx(), '/repo', Object.keys(files))
  const steps = await claudePlugin.steps(fakeCtx(), none, d!)
  expect(steps.map(s => s.name)).toEqual(['typecheck', 'lint'])
})

test('plugin without tsconfig has no typecheck step', async () => {
  const files = { ...pluginBasic }
  delete files['plugins/factory/tsconfig.json']
  const [d] = await claudePlugin.detect(fakeCtx(), '/repo', Object.keys(files))
  const steps = await claudePlugin.steps(fakeCtx(), none, d!)
  expect(steps.map(s => s.name)).toEqual(['lint', 'test'])
})

test('a marketplace has only a lint step', async () => {
  const steps = await claudePlugin.steps(fakeCtx(), none, det('.', 'marketplace', ['claude']))
  expect(steps.map(s => s.name)).toEqual(['lint'])
})

test('typecheck copies the engine types before tsc', async () => {
  const [t] = await claudePlugin.steps(fakeCtx(), none, det(P))
  expect(t!.argv.slice(0, 2)).toEqual(['sh', '-c'])
  expect(t!.argv[2]!.startsWith(typesSource(P))).toBe(true)
  expect(t!.argv[2]!.endsWith(`&& tsc -p ${P}`)).toBe(true)
})

test('typesSource fails with a hint when the engine types are missing', () => {
  const s = typesSource(P)
  expect(s).toContain('engine types not found: open the plugin-authoring skill once in this Claude Code version')
  expect(s).toContain('exit 1')
  expect(s).toContain(`mkdir -p ${P}/.claude-plugin/types/claude-code`)
})

test('config step overrides the stack step', async () => {
  const refs: StackRef[] = [{ id: 'claude-plugin', path: P, steps: { test: 'make check' } }]
  const steps = await resolveSteps(fakeCtx(), '/repo', none, refs, [det(P)])
  const t = steps.find(s => s.name === 'test')!
  expect(t).toMatchObject({ argv: ['sh', '-c', 'make check'], source: 'config' })
})

test('a Makefile target replaces the step of every stack at that path', async () => {
  const read = async (rel: string) => (rel === 'Makefile' ? 'test:\n\techo hi\n' : null)
  const steps = await resolveSteps(fakeCtx(), '/repo', read, [], [det('.', 'marketplace', ['claude']), det('.', 'plugin', ['claude', 'tests'])])
  expect(steps.filter(s => s.name === 'test').map(s => s.argv)).toEqual([['make', 'test']])
  expect(steps.find(s => s.name === 'test')!.source).toBe('runner')
})

test('equal commands run once', async () => {
  const steps = await resolveSteps(fakeCtx(), '/repo', none, [], [det('.', 'marketplace', ['claude']), det('.', 'marketplace', ['claude'])])
  expect(steps.map(s => s.argv)).toEqual([['claude', 'plugin', 'validate', '.']])
})

test('steps read the Makefile through the given reader', async () => {
  const ctx = fakeCtx({ files: { '/repo/Makefile': 'lint:\n' } })
  const asked: string[] = []
  const read = async (rel: string) => {
    asked.push(rel)
    return rel === 'Makefile' ? 'test:\n' : null
  }
  const steps = await resolveSteps(ctx, '/repo', read, [], [det('.', 'plugin', ['claude', 'tests'])])
  expect(asked).toEqual(['Makefile'])
  expect(steps.find(s => s.name === 'test')!.argv).toEqual(['make', 'test'])
  expect(steps.find(s => s.name === 'lint')!.argv[0]).toBe('claude')
})

test('requires asks for tsc only with a tsconfig', () => {
  expect(claudePlugin.requires(det(P, 'plugin', ['claude', 'tsc'])).map(r => r.cmd)).toEqual(['claude', 'tsc', 'sh'])
  expect(claudePlugin.requires(det(P, 'plugin', ['claude'])).map(r => r.cmd)).toEqual(['claude'])
  expect(claudePlugin.requires(det('.', 'marketplace', ['claude'])).map(r => r.cmd)).toEqual(['claude'])
})

test('requires checks the bundled engine types for a plugin with tsconfig', () => {
  const r = claudePlugin.requires(det(P, 'plugin', ['claude', 'tsc'])).find(x => x.cmd === 'sh')!
  expect(r.versionArgs[0]).toBe('-c')
  expect(r.versionArgs[1]).toContain('bundled-skills/$(claude --version')
  expect(r.versionArgs[1]).toContain('plugin-authoring/types/claude-code.d.ts')
  expect(r.fix).toBe('open the plugin-authoring skill once in this Claude Code version')
})

const base: Reply[] = [
  { argv: ['git', '--version'], result: { stdout: 'git version 2' } },
  { argv: ['gh', '--version'], result: { stdout: 'gh version 2' } },
  { argv: ['gh', 'auth', 'status'], result: { stdout: "Logged in to github.com account octo\n- Token scopes: 'repo'" } },
  { argv: ['git', 'remote', 'get-url', 'origin'], result: { stdout: 'https://github.com/a/b.git' } },
  lsReply(pluginBasic),
  { argv: ['claude', '--version'], result: { stdout: '2.1.326 (Claude Code)' } },
]

test('doctor reports a missing tsc for a plugin stack', async () => {
  const checks = await doctor(fakeCtx({ replies: base }), [])
  const c = checks.find(x => x.check === 'tsc')!
  expect(c.ok).toBe(false)
  expect(c.fix).toBe('brew install typescript')
})

test('doctor reports missing engine types', async () => {
  const replies = [...base, { argv: ['tsc', '--version'], result: { stdout: 'Version 7' } }]
  const checks = await doctor(fakeCtx({ replies }), [{ id: 'claude-plugin', path: P }])
  const c = checks.find(x => x.check === 'engine types')!
  expect(c.ok).toBe(false)
  expect(c.fix).toBe('open the plugin-authoring skill once in this Claude Code version')
})

test('doctor skips detections that the config does not list', async () => {
  const checks = await doctor(fakeCtx({ replies: base }), [{ id: 'claude-plugin', path: 'elsewhere' }])
  expect(checks.map(c => c.check)).toEqual(['git', 'gh', 'gh auth', 'origin'])
})

test('setup writes the detected stacks into a new config', async () => {
  const repoJson = JSON.stringify({
    allow_merge_commit: true, allow_squash_merge: false, allow_rebase_merge: false,
    merge_commit_title: 'PR_TITLE', merge_commit_message: 'PR_BODY', delete_branch_on_merge: true, has_issues: true,
  })
  const replies: Reply[] = [
    ...base.filter(r => r.argv[0] !== 'git' || r.argv[1] !== '-C'),
    lsReply(pluginMarket),
    { argv: ['tsc', '--version'], result: { stdout: 'Version 7' } },
    { argv: ['sh', '-c'] },
    { argv: ['git', 'symbolic-ref', 'refs/remotes/origin/HEAD'], result: { stdout: 'refs/remotes/origin/main' } },
    { argv: ['gh', 'api', 'repos/a/b'], result: { stdout: repoJson } },
    { argv: ['gh', 'label', 'create'] },
    { argv: ['gh', 'api', '-X', 'PATCH'] },
  ]
  const ctx = fakeCtx({ replies })
  await setup(ctx, { apply: true })
  expect(JSON.parse(ctx.files['/repo/.factory/config.json']!).stacks).toEqual([
    { id: 'claude-plugin', path: P },
    { id: 'claude-plugin', path: '.' },
  ])
})

test('default steps run in the given repo, not in ctx.root', async () => {
  const ctx = fakeCtx({ root: '/repo' })
  const steps = await resolveSteps(ctx, '/other', none, [], [det(P)])
  expect(steps.map(s => s.cwd)).toEqual(['/other', '/other', '/other'])
})

test('equal commands from different stacks at one path run once in another repo', async () => {
  const read = async (rel: string) => (rel === 'Makefile' ? 'lint:\n' : null)
  const steps = await resolveSteps(fakeCtx(), '/other', read, [], [det('.', 'marketplace', ['claude']), det('.', 'plugin', ['claude'])])
  expect(steps.filter(s => s.name === 'lint').map(s => [s.argv, s.cwd])).toEqual([[['make', 'lint'], '/other']])
  const plain = await resolveSteps(fakeCtx(), '/other', none, [], [det('.', 'marketplace', ['claude']), det('.', 'plugin', ['claude'])])
  expect(plain.filter(s => s.name === 'lint')).toHaveLength(1)
})

const noLs = base.filter(r => r.argv[1] !== '-C')

test('doctor reports a failed stack detection', async () => {
  const checks = await doctor(fakeCtx({ replies: noLs }), [])
  const c = checks.find(x => x.check === 'stacks')!
  expect(c.ok).toBe(false)
  expect(c.fix).toContain('git repository')
})

test('setup stops when stack detection fails', async () => {
  const ctx = fakeCtx({ replies: noLs })
  const r = await setup(ctx, { apply: true })
  expect(r.checks.find(c => c.check === 'stacks')!.ok).toBe(false)
  expect(r.created).toBe(false)
  expect(Object.keys(ctx.files)).toEqual([])
})
