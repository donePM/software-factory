import { expect, test } from 'claude-code/testing'
import { defaultConfig } from '../lib/config.ts'
import { dependsOn, queue } from '../lib/queue.ts'
import type { Tracker } from '../lib/tracker.ts'
import type { Comment, Ticket } from '../lib/types.ts'
import { withMarker } from '../lib/markers.ts'
import { TOOLS } from '../hooks/tools.ts'
import { fakeCtx } from './support/host.ts'

const cfg = { ...defaultConfig('u', 'main', []), concurrency: 2 }
const ctx = fakeCtx()
const T = (n: number, labels: string[] = [], o: Partial<Ticket> = {}): Ticket => ({
  kind: 'issue', number: n, title: `t${n}`, body: '', author: 'alice', labels: ['factory', ...labels],
  state: 'open', createdAt: `2026-01-0${n}T00:00:00Z`, url: `u/${n}`, comments: [], ...o,
})
const C = (id: number, author: string, body: string, at: string): Comment =>
  ({ id, author, body, createdAt: at, updatedAt: at })

function tracker(backlog: Ticket[], extra: Ticket[] = [], login = 'op'): Tracker & { gets: number[] } {
  const gets: number[] = []
  return {
    gets,
    login: async () => login,
    backlog: async () => backlog,
    get: async (n: number) => {
      gets.push(n)
      const t = [...extra, ...backlog].find(x => x.number === n)
      if (!t) throw new Error(`no #${n}`)
      return t
    },
  } as unknown as Tracker & { gets: number[] }
}
const nums = (xs: { number: number }[]): number[] => xs.map(x => x.number)

test('dependsOn reads several numbers', () => {
  expect(dependsOn('Depends on #2, #5')).toEqual([2, 5])
  expect(dependsOn('x\n  depends ON #7\ny depends on #9')).toEqual([7])
  expect(dependsOn('Depends on #5, #2, #5\nDepends on #2')).toEqual([5, 2])
  expect(dependsOn('nothing')).toEqual([])
})

const P = (priority: string): Partial<Ticket> => ({ priority })

test('queue orders by priority then age', async () => {
  const q = await queue(ctx, tracker([
    T(1, [], P('Low')), T(2, [], P('High')), T(3, [], { priority: 'High', createdAt: '2025-12-01T00:00:00Z' }),
    T(4, [], P('Urgent')),
  ]), cfg)
  expect(nums(q.ready)).toEqual([4, 3, 2, 1])
  expect(nums(q.next)).toEqual([4, 3])
})

test('queue puts bugs before other tickets, also before a higher priority', async () => {
  const q = await queue(ctx, tracker([T(1, [], P('Urgent')), T(3, ['type:fix'], P('Low'))]), cfg)
  expect(nums(q.ready)).toEqual([3, 1])
})

test('queue treats the bug label as a bug', async () => {
  const q = await queue(ctx, tracker([T(1), T(2, ['bug'])]), cfg)
  expect(nums(q.ready)).toEqual([2, 1])
})

test('queue keeps priority and age order in each group', async () => {
  const q = await queue(ctx, tracker([
    T(1, ['bug'], P('Low')), T(2, ['type:fix'], P('High')), T(3, ['bug'], { priority: 'High', createdAt: '2025-12-01T00:00:00Z' }),
    T(4, [], P('Urgent')), T(5, [], P('Low')), T(6),
  ]), cfg)
  expect(nums(q.ready)).toEqual([3, 2, 1, 4, 6, 5])
})

test('queue gives slots to bugs first and keeps blocked bugs blocked', async () => {
  const q = await queue(ctx, tracker([
    T(1, [], P('Urgent')), T(2, ['bug']), T(3, ['type:fix'], { body: 'Depends on #9' }), T(4, ['bug'], P('Low')),
  ]), cfg)
  expect(nums(q.next)).toEqual([2, 4])
  expect(nums(q.ready)).toEqual([2, 4, 1])
  expect(q.blocked.map(b => [b.number, b.blockedBy])).toEqual([[3, [9]]])
})

test('queue counts a ticket without a Priority field as medium', async () => {
  const q = await queue(ctx, tracker([
    T(1, [], P('Low')), T(2, ['priority:high']), T(3, [], P('High')), T(4, [], P('Someday')), T(5, ['priority:low']),
  ]), cfg)
  expect(nums(q.ready)).toEqual([3, 2, 4, 5, 1])
  expect(q.ready.map(i => i.priority)).toEqual(['high', 'medium', 'medium', 'medium', 'low'])
})

test('queue orders by the Priority field then age', async () => {
  const q = await queue(ctx, tracker([
    T(1, [], P('Medium')), T(2, ['priority:critical']), T(3, [], P('Low')), T(4, [], P('High')), T(5, [], P('Urgent')),
  ]), cfg)
  expect(nums(q.ready)).toEqual([5, 4, 1, 2, 3])
  expect(q.ready.map(i => i.priority)).toEqual(['critical', 'high', 'medium', 'medium', 'low'])
})

test('queue blocks a ticket with an open dependency', async () => {
  const q = await queue(ctx, tracker([T(1, [], { body: 'Depends on #3' }), T(3, ['factory:build'])]), cfg)
  expect(q.blocked[0]?.blockedBy).toEqual([3])
  expect(nums(q.ready)).toEqual([])
  expect(nums(q.running)).toEqual([3])
})

test('queue frees a ticket whose dependency is closed', async () => {
  const q = await queue(ctx, tracker([T(1, [], { body: 'Depends on #3' })], [T(3, ['factory:done'], { state: 'closed' })]), cfg)
  expect(nums(q.ready)).toEqual([1])
  expect(q.blocked).toEqual([])
})

test('queue blocks on an unknown dependency and on a self-dependency', async () => {
  const q = await queue(ctx, tracker([T(1, [], { body: 'Depends on #99' }), T(2, [], { body: 'Depends on #2' })]), cfg)
  expect(q.blocked.map(b => [b.number, b.blockedBy])).toEqual([[1, [99]], [2, [2]]])
  expect(q.ready).toEqual([])
})

test('queue lists only open dependencies in blockedBy', async () => {
  const closed = T(4, [], { state: 'closed' })
  const q = await queue(ctx, tracker([T(1, [], { body: 'Depends on #4, #5' }), T(5)], [closed]), cfg)
  expect(q.blocked[0]?.blockedBy).toEqual([5])
})

const marked = C(1, 'op', withMarker('intake', 'Which db?'), '2026-01-02T00:00:00Z')

test('queue resumes needs-info after an author answer', async () => {
  const full = T(1, ['factory:needs-info'], { comments: [marked, C(2, 'alice', 'Postgres', '2026-01-03T00:00:00Z')] })
  const tr = tracker([T(1, ['factory:needs-info'])], [full])
  const q = await queue(ctx, tr, cfg)
  expect(q.ready).toEqual([expect.objectContaining({ number: 1, resume: true })])
  expect(q.waiting).toEqual([])
})

test('queue does not resume needs-info on an operator note', async () => {
  const full = T(1, ['factory:needs-info'], { comments: [marked, C(2, 'op', 'note', '2026-01-03T00:00:00Z')] })
  const q = await queue(ctx, tracker([T(1, ['factory:needs-info'])], [full]), cfg)
  expect(q.ready).toEqual([])
  expect(q.waiting).toEqual([{ number: 1, state: 'needs-info' }])
})

test('queue keeps needs-info waiting without an intake marker, or when the answer is older', async () => {
  const noMarker = T(1, ['factory:needs-info'], { comments: [C(2, 'alice', 'hi', '2026-01-03T00:00:00Z')] })
  const old = T(2, ['factory:needs-info'], { comments: [marked, C(3, 'alice', 'early', '2026-01-01T00:00:00Z')] })
  const forged = T(3, ['factory:needs-info'], {
    comments: [C(4, 'mallory', withMarker('intake', 'q'), '2026-01-01T00:00:00Z'), C(5, 'alice', 'a', '2026-01-03T00:00:00Z')],
  })
  const q = await queue(ctx, tracker([T(1, ['factory:needs-info']), T(2, ['factory:needs-info']), T(3, ['factory:needs-info'])], [noMarker, old, forged]), cfg)
  expect(nums(q.waiting)).toEqual([1, 2, 3])
  expect(q.ready).toEqual([])
})

test('queue resumes when the author is the operator and answers after the marker', async () => {
  const full = T(1, ['factory:needs-info'], {
    author: 'op', comments: [marked, C(2, 'op', withMarker('spec', 'x'), '2026-01-04T00:00:00Z'), C(3, 'op', 'answer', '2026-01-03T00:00:00Z')],
  })
  const q = await queue(ctx, tracker([T(1, ['factory:needs-info'], { author: 'op' })], [full]), cfg)
  expect(nums(q.ready)).toEqual([1])
  const only = T(2, ['factory:needs-info'], { author: 'op', comments: [marked, C(3, 'op', withMarker('spec', 'x'), '2026-01-04T00:00:00Z')] })
  const q2 = await queue(ctx, tracker([T(2, ['factory:needs-info'], { author: 'op' })], [only]), cfg)
  expect(q2.ready).toEqual([])
})

test('queue applies dependencies to a resume item', async () => {
  const full = T(1, ['factory:needs-info'], { body: 'Depends on #8', comments: [marked, C(2, 'alice', 'a', '2026-01-03T00:00:00Z')] })
  const q = await queue(ctx, tracker([T(1, ['factory:needs-info'], { body: 'Depends on #8' }), T(8)], [full]), cfg)
  expect(q.blocked[0]).toMatchObject({ number: 1, resume: true, blockedBy: [8] })
})

test('queue calls get only for needs-info tickets and dependencies', async () => {
  const tr = tracker([T(1), T(2, ['factory:needs-human']), T(3, ['factory:spec'])])
  await queue(ctx, tr, cfg)
  expect(tr.gets).toEqual([])
})

test('queue puts a ticket with two status labels into conflicts', async () => {
  const q = await queue(ctx, tracker([T(1, ['factory:spec', 'factory:build']), T(2)]), cfg)
  expect(q.conflicts).toEqual([1])
  expect(nums(q.ready)).toEqual([2])
  expect(q.running).toEqual([])
  expect(q.waiting).toEqual([])
})

test('queue skips done and rejected and sorts states', async () => {
  const q = await queue(ctx, tracker([
    T(1, ['factory:done']), T(2, ['factory:rejected']), T(3, ['factory:approved']), T(4, ['factory:needs-design']),
    T(5, ['factory:needs-human']), T(6, ['factory:docs']), T(7, ['factory:review']),
  ]), cfg)
  expect(q.waiting.map(w => w.state)).toEqual(['approved', 'needs-design', 'needs-human'])
  expect(q.running.map(w => w.state)).toEqual(['docs', 'review'])
})

test('waiting jobs take no slot', async () => {
  const q = await queue(ctx, tracker([T(1, ['factory:needs-human']), T(2)]), { ...cfg, concurrency: 1 })
  expect(q.slots).toBe(1)
  expect(nums(q.next)).toEqual([2])
})

test('slots never go below zero', async () => {
  const q = await queue(ctx, tracker([T(1, ['factory:build']), T(2, ['factory:spec']), T(3)]), { ...cfg, concurrency: 1 })
  expect(q.slots).toBe(0)
  expect(q.next).toEqual([])
  expect(nums(q.ready)).toEqual([3])
})

test('tool queue returns the queue', async () => {
  const def = TOOLS.find(t => t.name === 'queue')!
  const issue = { number: 5, title: 'T', body: '', labels: [{ name: 'factory' }], author: { login: 'a' }, createdAt: '2026-01-01T00:00:00Z', url: 'u/5', state: 'OPEN' }
  const c = fakeCtx({
    files: { '/repo/.factory/config.json': JSON.stringify(defaultConfig('https://github.com/a/b', 'main', [])) },
    replies: [
      { argv: ['gh', 'issue', 'list'], result: { stdout: JSON.stringify([issue]) } },
      { argv: ['gh', 'api', 'repos/a/b/issues?labels=factory&state=open&per_page=100'] },
    ],
  })
  const q = (await def.handler(c, {})) as { ready: { number: number }[]; slots: number }
  expect(nums(q.ready)).toEqual([5])
  expect(q.slots).toBe(4)
})
