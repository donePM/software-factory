import { expect, test } from 'claude-code/testing'
import { FactoryError, must, rmrf } from '../lib/exec.ts'
import { fakeCtx } from './support/host.ts'

test('must returns trimmed stdout', async () => {
  const ctx = fakeCtx({ replies: [{ argv: ['echo'], result: { stdout: 'abc\n' } }] })
  expect(await must(ctx, ['echo', 'abc'])).toBe('abc')
})

test('must throws FactoryError on exit 1', async () => {
  const ctx = fakeCtx({ replies: [{ argv: ['git'], result: { exitCode: 1, stderr: 'boom' } }] })
  const err = await must(ctx, ['git', 'status']).catch(e => e)
  expect(err).toBeInstanceOf(FactoryError)
  expect(err.code).toBe('command-failed')
  expect(err.message).toContain('boom')
  expect(err.message).toContain('git status')
})

test('must names a GitHub rate limit and tells the operator to wait', async () => {
  for (const stderr of ['GraphQL: API rate limit already exceeded for user ID 1.', 'You have exceeded a secondary rate limit.']) {
    const ctx = fakeCtx({ replies: [{ argv: ['gh'], result: { exitCode: 1, stderr } }] })
    const err = await must(ctx, ['gh', 'api', 'user']).catch(e => e)
    expect(err.code).toBe('rate-limited')
    expect(err.message).toContain(stderr)
    expect(err.fix).toContain('Wait')
    expect(ctx.calls).toHaveLength(1)
  }
  const git = fakeCtx({ replies: [{ argv: ['git'], result: { exitCode: 1, stderr: 'rate limit' } }] })
  expect((await must(git, ['git', 'push']).catch(e => e)).code).toBe('command-failed')
})

test('rmrf refuses a path outside .factory', async () => {
  const ctx = fakeCtx({ root: '/repo' })
  const err = await rmrf(ctx, '/repo/src').catch(e => e)
  expect(err.code).toBe('unsafe-path')
  expect(ctx.calls).toEqual([])
})

test('rmrf names the safe folder in the active voice', async () => {
  const err = await rmrf(fakeCtx({ root: '/repo' }), '/repo/src').catch(e => e)
  expect(err.fix).toBe('The factory deletes only paths below /repo/.factory/.')
})

test('rmrf removes a path under .factory', async () => {
  const ctx = fakeCtx({ root: '/repo', replies: [{ argv: ['rm'] }] })
  await rmrf(ctx, '/repo/.factory/jobs/7')
  expect(ctx.calls[0]).toEqual(['rm', '-rf', '/repo/.factory/jobs/7'])
})

test('rmrf refuses .factory itself and ..', async () => {
  const ctx = fakeCtx({ root: '/repo' })
  expect((await rmrf(ctx, '/repo/.factory').catch(e => e)).code).toBe('unsafe-path')
  expect((await rmrf(ctx, '/repo/.factory/../src').catch(e => e)).code).toBe('unsafe-path')
  expect(ctx.calls).toEqual([])
})
