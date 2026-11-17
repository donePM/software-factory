import { expect, test } from 'claude-code/testing'
import { doctor } from '../lib/doctor.ts'
import { fakeCtx, type Reply } from './support/host.ts'

const good: Reply[] = [
  { argv: ['git', '--version'], result: { stdout: 'git version 2.50.0' } },
  { argv: ['gh', '--version'], result: { stdout: 'gh version 2.80.0' } },
  { argv: ['gh', 'auth', 'status'], result: { stdout: 'Logged in to github.com account octo\n- Token scopes: \'gist\', \'read:org\', \'repo\'' } },
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
  expect(c.fix).toContain('gh auth login --web')
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
