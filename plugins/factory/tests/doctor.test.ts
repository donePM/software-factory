import { expect, test } from 'claude-code/testing'
import { invoke, TOOLS } from '../hooks/tools.ts'
import { defaultConfig } from '../lib/config.ts'
import { doctor } from '../lib/doctor.ts'
import { fakeCtx, type Reply } from './support/host.ts'

const good: Reply[] = [
  { argv: ['git', '--version'], result: { stdout: 'git version 2.50.0' } },
  { argv: ['gh', '--version'], result: { stdout: 'gh version 2.80.0' } },
  { argv: ['gh', 'auth', 'status'], result: { stdout: 'Logged in to github.com account octo\n- Token scopes: \'gist\', \'read:org\', \'repo\'' } },
  { argv: ['git', '-C', '/repo', 'ls-files'], result: { stdout: 'README.md' } },
  { argv: ['git', 'remote', 'get-url', 'origin'], result: { stdout: 'https://github.com/a/b.git' } },
]

test('doctor passes when everything is present', async () => {
  const checks = await doctor(fakeCtx({ replies: good }), [])
  expect(checks.map(c => c.check)).toEqual(['git', 'gh', 'gh auth', 'origin'])
  expect(checks.every(c => c.ok)).toBe(true)
  expect(checks.find(c => c.check === 'gh auth')!.detail).toContain('octo')
})

test('doctor reports a missing gh with a brew fix', async () => {
  const replies = good.filter(r => r.argv[0] !== 'gh')
  const checks = await doctor(fakeCtx({ replies }), [])
  expect(checks.find(c => c.check === 'gh')).toMatchObject({ ok: false })
  expect(checks.find(c => c.check === 'gh')!.fix).toContain('brew install gh')
})

test('doctor reports gh not logged in', async () => {
  const replies = good.map(r => (r.argv[1] === 'auth' ? { argv: r.argv, result: { exitCode: 1, stderr: 'You are not logged in' } } : r))
  const checks = await doctor(fakeCtx({ replies }), [])
  const c = checks.find(x => x.check === 'gh auth')!
  expect(c.ok).toBe(false)
  expect(c.detail).toBe('gh is not logged in')
  expect(c.fix).toBe('! gh auth login --web')
})

test('doctor gives a retry hint for a non-login gh error', async () => {
  const replies = good.map(r => (r.argv[1] === 'auth' ? { argv: r.argv, result: { exitCode: 1, stderr: 'error connecting to api.github.com\nmore' } } : r))
  const c = (await doctor(fakeCtx({ replies }), [])).find(x => x.check === 'gh auth')!
  expect(c.ok).toBe(false)
  expect(c.detail).toBe('gh auth status failed: error connecting to api.github.com')
  expect(c.fix).toBe('Wait a moment. Then run setup again.')
  expect(c.fix).not.toContain('gh auth login')
})

test('doctor reports a missing repo scope', async () => {
  const replies = good.map(r => (r.argv[1] === 'auth' ? { argv: r.argv, result: { stdout: "Logged in to github.com account octo\n- Token scopes: 'gist'" } } : r))
  const c = (await doctor(fakeCtx({ replies }), [])).find(x => x.check === 'gh auth')!
  expect(c.ok).toBe(false)
  expect(c.detail).toContain('repo')
})

test('doctor reports a non-GitHub origin', async () => {
  const replies = good.map(r => (r.argv[1] === 'remote' ? { argv: r.argv, result: { stdout: 'https://gitlab.com/a/b' } } : r))
  const c = (await doctor(fakeCtx({ replies }), [])).find(x => x.check === 'origin')!
  expect(c.ok).toBe(false)
})

const scopes = (list: string): Reply[] =>
  good.map(r => (r.argv[1] === 'auth' ? { argv: r.argv, result: { stdout: `Logged in to github.com account octo\n- Token scopes: ${list}` } } : r))

test('doctor passes the project scope check when the scope is present', async () => {
  const checks = await doctor(fakeCtx({ replies: scopes("'gist', 'project', 'repo'") }), [], true)
  expect(checks.map(c => c.check)).toEqual(['git', 'gh', 'gh auth', 'project scope', 'origin'])
  expect(checks.find(c => c.check === 'project scope')!.ok).toBe(true)
})

test('doctor reports a missing project scope with the refresh fix', async () => {
  const c = (await doctor(fakeCtx({ replies: good }), [], true)).find(x => x.check === 'project scope')!
  expect(c.ok).toBe(false)
  expect(c.detail).toContain('octo')
  expect(c.fix).toBe('gh auth refresh -s project')
})

test('doctor does not count read:project as project', async () => {
  const c = (await doctor(fakeCtx({ replies: scopes("'read:project', 'repo'") }), [], true)).find(x => x.check === 'project scope')!
  expect(c.ok).toBe(false)
})

test('doctor skips the project scope check when the project is off', async () => {
  const checks = await doctor(fakeCtx({ replies: scopes("'repo'") }), [])
  expect(checks.map(c => c.check)).toEqual(['git', 'gh', 'gh auth', 'origin'])
})

test('doctor tool runs the project scope check only when the config turns the project on', async () => {
  const def = TOOLS.find(t => t.name === 'doctor')!
  const cfg = (enabled: boolean) => ({ '/repo/.factory/config.json': JSON.stringify({ ...defaultConfig('https://github.com/a/b', 'main', []), project: { enabled } }) })
  const names = async (files: Record<string, string>) => {
    const out = await invoke(def, fakeCtx({ replies: good, files }), {})
    expect(out).not.toMatchObject({ isError: true })
    return (JSON.parse(out.result) as { check: string }[]).map(c => c.check)
  }
  expect(await names(cfg(true))).toContain('project scope')
  expect(await names(cfg(false))).not.toContain('project scope')
  expect(await names({})).not.toContain('project scope')
})

const wikiView = (on: boolean): Reply => ({ argv: ['gh', 'repo', 'view', 'a/b', '--json', 'hasWikiEnabled'], result: { stdout: JSON.stringify({ hasWikiEnabled: on }) } })
const lsRemote = (exitCode: number): Reply => ({ argv: ['git', 'ls-remote', 'https://github.com/a/b.wiki.git'], result: { exitCode } })

test('reports a wiki target with a missing wiki repo', async () => {
  const wiki = async (replies: Reply[]) => (await doctor(fakeCtx({ replies: [...replies, ...good] }), [], false, true)).find(c => c.check === 'wiki')!
  expect((await wiki([wikiView(true), lsRemote(0)])).ok).toBe(true)
  const off = await wiki([wikiView(false), lsRemote(0)])
  expect(off.ok).toBe(false)
  expect(off.fix).toContain('gh repo edit a/b --enable-wiki')
  expect(off.fix).toContain('https://github.com/a/b/wiki')
  const empty = await wiki([wikiView(true), lsRemote(128)])
  expect(empty.ok).toBe(false)
  expect(empty.fix).toContain('first page')
  expect(empty.fix).toContain('https://github.com/a/b/wiki')

  const def = TOOLS.find(t => t.name === 'doctor')!
  const files = { '/repo/.factory/config.json': JSON.stringify({ ...defaultConfig('https://github.com/a/b', 'main', []), docs: { target: 'wiki' } }) }
  const out = await invoke(def, fakeCtx({ replies: [wikiView(true), lsRemote(0), ...good], files }), {})
  expect((JSON.parse(out.result) as { check: string }[]).map(c => c.check)).toContain('wiki')
})

test('runs no wiki check without a wiki target', async () => {
  const ctx = fakeCtx({ replies: [wikiView(true), lsRemote(0), ...good] })
  const checks = await doctor(ctx, [])
  expect(checks.map(c => c.check)).toEqual(['git', 'gh', 'gh auth', 'origin'])
  expect(ctx.calls.some(c => c[1] === 'repo' || c[1] === 'ls-remote')).toBe(false)
  const def = TOOLS.find(t => t.name === 'doctor')!
  const files = { '/repo/.factory/config.json': JSON.stringify({ ...defaultConfig('https://github.com/a/b', 'main', []), docs: { target: 'docs', path: 'docs/' } }) }
  const tool = fakeCtx({ replies: [wikiView(true), lsRemote(0), ...good], files })
  await invoke(def, tool, {})
  expect(tool.calls.some(c => c[1] === 'repo' || c[1] === 'ls-remote')).toBe(false)
})
