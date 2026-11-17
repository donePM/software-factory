import { expect, test } from 'claude-code/testing'
import { defaultConfig, validateConfig } from '../lib/config.ts'
import { labelSet } from '../lib/labels.ts'
import { setup } from '../lib/setup.ts'
import { invoke, TOOLS } from '../hooks/tools.ts'
import { fakeCtx, type Reply } from './support/host.ts'

const repoJson = JSON.stringify({
  allow_merge_commit: true, allow_squash_merge: false, allow_rebase_merge: false,
  merge_commit_title: 'PR_TITLE', merge_commit_message: 'PR_BODY', delete_branch_on_merge: true, has_issues: true,
})
const replies = (head = 'refs/remotes/origin/main'): Reply[] => [
  { argv: ['git', '--version'], result: { stdout: 'git version 2' } },
  { argv: ['gh', '--version'], result: { stdout: 'gh version 2' } },
  { argv: ['gh', 'auth', 'status'], result: { stdout: "Logged in to github.com account octo\n- Token scopes: 'repo'" } },
  { argv: ['git', 'remote', 'get-url', 'origin'], result: { stdout: 'https://github.com/a/b.git' } },
  { argv: ['git', 'symbolic-ref', 'refs/remotes/origin/HEAD'], result: { stdout: head } },
  { argv: ['gh', 'api', 'repos/a/b'], result: { stdout: repoJson } },
  { argv: ['gh', 'label', 'create'] },
  { argv: ['gh', 'api', '-X', 'PATCH'] },
]
const labelCreates = (calls: string[][]) => calls.filter(c => c[1] === 'label' && c[2] === 'create').length
const CFG = '/repo/.factory/config.json'

test('setup without apply writes nothing', async () => {
  const ctx = fakeCtx({ replies: replies() })
  const r = await setup(ctx, { apply: false })
  expect(r.created).toBe(false)
  expect(r.config.baseBranch).toBe('main')
  expect(r.config.tracker.url).toBe('https://github.com/a/b')
  expect(Object.keys(ctx.files)).toEqual([])
  expect(labelCreates(ctx.calls)).toBe(0)
  expect(ctx.calls.some(c => c.includes('PATCH'))).toBe(false)
})

test('setup creates config, gitignore and labels', async () => {
  const ctx = fakeCtx({ replies: replies() })
  const r = await setup(ctx, { apply: true, concurrency: 2 })
  expect(r.created).toBe(true)
  expect(validateConfig(JSON.parse(ctx.files[CFG]!))).toEqual([])
  expect(JSON.parse(ctx.files[CFG]!).concurrency).toBe(2)
  expect(ctx.files['/repo/.factory/.gitignore']).toBe('*\n!.gitignore\n!config.json\n!checks.local.ts\n')
  expect(labelCreates(ctx.calls)).toBe(labelSet(r.config).length)
  expect(r.labels).toBe(labelSet(r.config).length)
  expect(r.gitignore).toBe(true)
  expect(r.next.length).toBeGreaterThan(0)
})

test('setup reads the base branch from origin HEAD', async () => {
  const r = await setup(fakeCtx({ replies: replies('refs/remotes/origin/trunk') }), { apply: false })
  expect(r.config.baseBranch).toBe('trunk')
})

test('setup honors an explicit base branch', async () => {
  const r = await setup(fakeCtx({ replies: replies() }), { apply: false, baseBranch: 'dev' })
  expect(r.config.baseBranch).toBe('dev')
})

test('setup is idempotent', async () => {
  const ctx = fakeCtx({ replies: replies() })
  await setup(ctx, { apply: true })
  const before = { ...ctx.files }
  const r = await setup(ctx, { apply: true })
  expect(r.created).toBe(false)
  expect(r.migrated).toEqual([])
  expect(ctx.files).toEqual(before)
})

test('setup migrates an old config first', async () => {
  const old = { ...defaultConfig('https://github.com/a/b', 'main', []), version: 0 }
  const ctx = fakeCtx({ replies: replies(), files: { [CFG]: JSON.stringify(old) } })
  const r = await setup(ctx, { apply: true, migrations: [{ from: 0, name: 'zero-to-one', up: o => o }] })
  expect(r.migrated).toEqual(['zero-to-one'])
  expect(r.created).toBe(false)
  expect(JSON.parse(ctx.files[CFG]!).version).toBe(1)
})

test('setup stops early when git is missing', async () => {
  const rs = replies().filter(r => r.argv[0] !== 'git')
  const ctx = fakeCtx({ replies: rs })
  const r = await setup(ctx, { apply: true })
  expect(r.checks.find(c => c.check === 'git')!.ok).toBe(false)
  expect(ctx.calls.filter(c => c[0] === 'gh').length).toBe(0)
  expect(Object.keys(ctx.files)).toEqual([])
})

test('tool setup returns the report as JSON', async () => {
  const def = TOOLS.find(t => t.name === 'setup')!
  const out = await invoke(def, fakeCtx({ replies: replies() }), { apply: false })
  expect('result' in out && out.result !== undefined && JSON.parse(out.result).config.baseBranch).toBe('main')
})

test('preview shows standard drift and the planned label count', async () => {
  const drift = JSON.stringify({ ...JSON.parse(repoJson), allow_squash_merge: true })
  const rs = replies().map(r => (r.argv[0] === 'gh' && r.argv[1] === 'api' && r.argv[2] === 'repos/a/b' ? { argv: r.argv, result: { stdout: drift } } : r))
  const ctx = fakeCtx({ replies: rs })
  const r = await setup(ctx, { apply: false })
  expect(r.standard.filter(c => !c.ok).map(c => c.key)).toEqual(['allow_squash_merge'])
  expect(r.labels).toBe(labelSet(r.config).length)
  expect(ctx.calls.some(c => c.includes('PATCH') || c[2] === 'create')).toBe(false)
})

test('preview migrates in memory only and lists the planned migrations', async () => {
  const old = { ...defaultConfig('https://github.com/a/b', 'main', []), version: 0 }
  const ctx = fakeCtx({ replies: replies(), files: { [CFG]: JSON.stringify(old) } })
  const before = { ...ctx.files }
  const r = await setup(ctx, { apply: false, migrations: [{ from: 0, name: 'zero-to-one', up: o => o }] })
  expect(r.migrated).toEqual(['zero-to-one'])
  expect(r.config.version).toBe(1)
  expect(ctx.files).toEqual(before)
})
