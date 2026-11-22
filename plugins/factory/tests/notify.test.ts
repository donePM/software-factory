import { expect, test } from 'claude-code/testing'
import { withWaitNotify } from '../lib/notify.ts'
import { hintOf } from '../lib/status.ts'
import type { Tracker } from '../lib/tracker.ts'
import type { Ctx, State } from '../lib/types.ts'
import { fakeCtx } from './support/host.ts'

const REPO = 'o/r'

// A tracker whose setState returns the given from state.
function fakeTracker(from: State | null): Tracker {
  return { repo: REPO, setState: async () => from } as unknown as Tracker
}

function notifyCtx(fail = false): Ctx & { texts: string[] } {
  const texts: string[] = []
  return {
    ...fakeCtx(),
    texts,
    notify: async text => {
      texts.push(text)
      if (fail) throw new Error('no ui')
    },
  }
}

test('notifies once for each move into a waiting state', async () => {
  for (const to of ['needs-info', 'needs-human', 'approved', 'needs-design'] as State[]) {
    const ctx = notifyCtx()
    const { tracker, flush } = withWaitNotify(ctx, fakeTracker('review'), {})
    await tracker.setState(7, to)
    await flush()
    expect(ctx.texts).toEqual([`#7 ${hintOf(REPO, 7, to, undefined, false, [])}`])
  }
  const ctx = notifyCtx()
  const { tracker, flush } = withWaitNotify(ctx, fakeTracker('review'), { merge: { method: 'merge', auto: true } })
  await tracker.setState(8, 'approved')
  await flush()
  await flush()
  expect(ctx.texts).toEqual(['#8 approved: the factory merges it'])
})

test('does not notify for running states or for no change', async () => {
  const ctx = notifyCtx()
  for (const to of ['intake', 'spec', 'build', 'review', 'docs', 'done', 'rejected'] as State[]) {
    const { tracker, flush } = withWaitNotify(ctx, fakeTracker('needs-human'), {})
    await tracker.setState(7, to)
    await flush()
  }
  const { tracker, flush } = withWaitNotify(ctx, fakeTracker('needs-human'), {})
  await tracker.setState(7, 'needs-human')
  await flush()
  expect(ctx.texts).toEqual([])
})

test('a failed notification never fails the tool', async () => {
  const ctx = notifyCtx(true)
  const a = withWaitNotify(ctx, fakeTracker('review'), {})
  await a.tracker.setState(7, 'approved')
  await a.flush()
  expect(ctx.texts.length).toBe(1)
  const b = withWaitNotify(fakeCtx(), fakeTracker('review'), {})
  await b.tracker.setState(7, 'approved')
  await b.flush()
})

test('flush reports a move made before an error', async () => {
  const ctx = notifyCtx()
  const { tracker, flush } = withWaitNotify(ctx, fakeTracker('review'), {})
  const run = async (): Promise<void> => {
    await tracker.setState(7, 'needs-human')
    throw new Error('sync-conflict-limit')
  }
  await expect(run().finally(flush)).rejects.toMatchObject({ message: 'sync-conflict-limit' })
  expect(ctx.texts).toEqual([`#7 ${hintOf(REPO, 7, 'needs-human', undefined, false, [])}`])
})
