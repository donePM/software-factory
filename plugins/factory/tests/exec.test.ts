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

test('rmrf refuses a path outside .factory', async () => {
  const ctx = fakeCtx({ root: '/repo' })
  const err = await rmrf(ctx, '/repo/src').catch(e => e)
  expect(err.code).toBe('unsafe-path')
  expect(ctx.calls).toEqual([])
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
