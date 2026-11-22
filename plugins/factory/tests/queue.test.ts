import { expect, test } from 'claude-code/testing'
import { defaultConfig } from '../lib/config.ts'
import { dependsOn, queue } from '../lib/queue.ts'
import type { Tracker } from '../lib/tracker.ts'
import type { Comment, Ticket } from '../lib/types.ts'
import { withMarker } from '../lib/markers.ts'
import { TOOLS } from '../hooks/tools.ts'
import { boardCalls, boardReplies, edit, itemList, ON } from './support/board.ts'
import { fakeCtx } from './support/host.ts'

const cfg = { ...defaultConfig('u', 'main', []), concurrency: 2 }
const ctx = fakeCtx()
const T = (n: number, labels: string[] = [], o: Partial<Ticket> = {}): Ticket => ({
  kind: 'issue', number: n, title: `t${n}`, body: '', author: 'alice', labels: ['factory', ...labels],
  state: 'open', createdAt: `2026-01-0${n}T00:00:00Z`, url: `u/${n}`, comments: [], ...o,
})
const C = (id: number, author: string, body: string, at: string): Comment =>
  ({ id, author, body, createdAt: at, updatedAt: at })

function tracker(backlog: Ticket[], extra: Ticket[] = [], login = 'op'): Tracker & { gets: number[]; added: [number, string][] } {
  const gets: number[] = []
  const added: [number, string][] = []
  return {
    gets,
    added,
    addLabel: async (n: number, label: string) => {
      added.push([n, label])
    },
    login: async () => login,
    backlog: async () => backlog,
    get: async (n: number) => {
      gets.push(n)
      const t = [...extra, ...backlog].find(x => x.number === n)
      if (!t) throw new Error(`no #${n}`)
      return t
    },
  } as unknown as Tracker & { gets: number[]; added: [number, string][] }
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
  const closed = T(4, [], { state: 'closed', stateReason: 'completed' })
  const q = await queue(ctx, tracker([T(1, [], { body: 'Depends on #4, #5' }), T(5)], [closed]), cfg)
  expect(q.blocked[0]?.blockedBy).toEqual([5])
})

test('queue blocks a ticket whose dependency is closed as not planned', async () => {
  const q = await queue(ctx, tracker([T(1, [], { body: 'Depends on #4' })], [T(4, [], { state: 'closed', stateReason: 'not_planned' })]), cfg)
  expect(q.blocked.map(b => [b.number, b.blockedBy])).toEqual([[1, [4]]])
  expect(q.ready).toEqual([])
})

test('queue blocks a ticket whose dependency is rejected', async () => {
  const q = await queue(ctx, tracker([T(1, [], { body: 'Depends on #4' })], [T(4, ['factory:rejected'], { state: 'closed', stateReason: 'completed' })]), cfg)
  expect(q.blocked.map(b => [b.number, b.blockedBy])).toEqual([[1, [4]]])
  expect(q.ready).toEqual([])
})

test('queue blocks a ticket whose dependency is closed without completed', async () => {
  const q = await queue(ctx, tracker([T(1, [], { body: 'Depends on #4' }), T(2, [], { body: 'Depends on #5' })], [
    T(4, [], { state: 'closed' }), T(5, [], { state: 'closed', stateReason: 'duplicate' }),
  ]), cfg)
  expect(q.blocked.map(b => [b.number, b.blockedBy])).toEqual([[1, [4]], [2, [5]]])
  expect(q.ready).toEqual([])
})

test('queue frees a ticket whose dependency is completed or done', async () => {
  const q = await queue(ctx, tracker([T(1, [], { body: 'Depends on #4' }), T(2, [], { body: 'Depends on #5' })], [
    T(4, [], { state: 'closed', stateReason: 'completed' }), T(5, ['factory:done'], { state: 'closed', stateReason: 'not_planned' }),
  ]), cfg)
  expect(nums(q.ready)).toEqual([1, 2])
  expect(q.blocked).toEqual([])
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

test('queue reads each dependency once', async () => {
  const tr = tracker([T(1, [], { body: 'Depends on #3, #4' }), T(2, [], { body: 'Depends on #3' }), T(3)], [T(4, [], { state: 'closed', stateReason: 'completed' })])
  const q = await queue(ctx, tr, cfg)
  expect(q.blocked.map(b => [b.number, b.blockedBy])).toEqual([[1, [3]], [2, [3]]])
  expect(tr.gets).toEqual([3, 4])
})

test('queue frees a ticket whose dependency the backlog list still shows open', async () => {
  const tr = tracker([T(1, [], { body: 'Depends on #3' }), T(3), T(2, [], { body: 'Depends on #3' })], [T(3, ['factory:done'], { state: 'closed' })])
  const q = await queue(ctx, tr, cfg)
  expect(nums(q.ready)).toEqual([1, 2, 3])
  expect(q.blocked).toEqual([])
  expect(tr.gets).toEqual([3])
})

test('queue warns when a dependency cannot be read', async () => {
  const q = await queue(ctx, tracker([T(1, [], { body: 'Depends on #99' })]), cfg)
  expect(q.blocked.map(b => [b.number, b.blockedBy])).toEqual([[1, [99]]])
  expect(q.warnings).toHaveLength(1)
  expect(q.warnings?.[0]).toContain('#1')
  expect(q.warnings?.[0]).toContain('#99')
  expect(q.warnings?.[0]).toContain('Fix:')
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
  const issue = { number: 5, title: 'T', body: '', labels: [{ name: 'factory' }], user: { login: 'a' }, created_at: '2026-01-01T00:00:00Z', html_url: 'u/5', state: 'open' }
  const c = fakeCtx({
    files: { '/repo/.factory/config.json': JSON.stringify(defaultConfig('https://github.com/a/b', 'main', [])) },
    replies: [
      { argv: ['gh', 'api', 'repos/a/b/issues?labels=factory&state=open&per_page=100'], result: { stdout: JSON.stringify(issue) } },
      { argv: ['gh', 'api', 'repos/a/b/issues?labels=factory,factory:docs&state=closed&per_page=100'] },
      { argv: ['gh', 'api', 'repos/a/b/issues?labels=factory,factory:needs-human&state=closed&per_page=100'] },
    ],
  })
  const q = (await def.handler(c, {})) as { ready: { number: number }[]; slots: number }
  expect(nums(q.ready)).toEqual([5])
  expect(q.slots).toBe(4)
})

test('tool queue counts a closed docs job against the slots', async () => {
  const def = TOOLS.find(t => t.name === 'queue')!
  const issue = { number: 5, title: 'T', body: '', labels: [{ name: 'factory' }], user: { login: 'a' }, created_at: '2026-01-01T00:00:00Z', html_url: 'u/5', state: 'open' }
  const docs = { ...issue, number: 6, labels: [{ name: 'factory' }, { name: 'factory:docs' }], html_url: 'u/6', state: 'closed' }
  const c = fakeCtx({
    files: { '/repo/.factory/config.json': JSON.stringify(defaultConfig('https://github.com/a/b', 'main', [])) },
    replies: [
      { argv: ['gh', 'api', 'repos/a/b/issues?labels=factory&state=open&per_page=100'], result: { stdout: JSON.stringify(issue) } },
      { argv: ['gh', 'api', 'repos/a/b/issues?labels=factory,factory:docs&state=closed&per_page=100'], result: { stdout: JSON.stringify(docs) } },
      { argv: ['gh', 'api', 'repos/a/b/issues?labels=factory,factory:needs-human&state=closed&per_page=100'] },
    ],
  })
  const q = (await def.handler(c, {})) as { running: { number: number; state: string }[]; slots: number }
  expect(q.running).toEqual([{ number: 6, state: 'docs' }])
  expect(q.slots).toBe(3)
})

const onCfg = { ...cfg, ...ON }
const boardTracker = (backlog: Ticket[], extra: Ticket[] = []): Tracker => ({ ...tracker(backlog, extra), repo: 'o/r' })

test('queue adds a Backlog card only for a ticket without a card', async () => {
  const c = fakeCtx({ replies: [itemList([{ url: 'u/1', factory: 'Intake' }]), ...boardReplies] })
  const q = await queue(c, boardTracker([T(1), T(2), T(3, ['factory:build'])]), onCfg)
  expect(q.warnings).toBeUndefined()
  expect(boardCalls(c.calls)).toEqual(['gh project item-list', 'gh project view', 'gh project field-list', 'gh project item-add', 'gh project item-edit'])
  expect(c.calls).toContainEqual(['gh', 'project', 'item-list', '3', '--owner', 'o', '--limit', '1000', '--format', 'json'])
  expect(c.calls.filter(x => x[2] === 'item-add').map(x => x[7])).toEqual(['https://github.com/o/r/issues/2'])
  expect(c.calls).toContainEqual(edit('Backlog'))
  const all = fakeCtx({ replies: [itemList([{ url: 'u/1', factory: 'Intake' }, { url: 'u/2', factory: 'Done' }]), ...boardReplies] })
  await queue(all, boardTracker([T(1), T(2), T(3, ['factory:build'])]), onCfg)
  expect(boardCalls(all.calls)).toEqual(['gh project item-list'])
  const busy = fakeCtx({ replies: [itemList([]), ...boardReplies] })
  await queue(busy, boardTracker([T(3, ['factory:build'])]), onCfg)
  expect(boardCalls(busy.calls)).toEqual(['gh project item-list'])
})

test('queue reports board failures as warnings and makes no call with the board off', async () => {
  const c = fakeCtx({ replies: [{ argv: ['gh', 'project', 'item-list'], result: { exitCode: 1, stderr: 'boom' } }, ...boardReplies] })
  const q = await queue(c, boardTracker([T(1)]), onCfg)
  expect(nums(q.ready)).toEqual([1])
  expect(q.warnings).toHaveLength(1)
  expect(q.warnings?.[0]).toContain('boom')
  const bad = fakeCtx({ replies: [itemList([]), { argv: ['gh', 'project', 'item-edit'], result: { exitCode: 1, stderr: 'bad edit' } }, ...boardReplies] })
  const q1 = await queue(bad, boardTracker([T(1)]), onCfg)
  expect(q1.warnings).toHaveLength(1)
  expect(q1.warnings?.[0]?.startsWith('#1: ')).toBe(true)
  for (const off of [cfg, { ...cfg, project: { enabled: false, number: 3 } }]) {
    const o = fakeCtx({ replies: [itemList([]), ...boardReplies] })
    const qo = await queue(o, boardTracker([T(1)]), off)
    expect(o.calls).toEqual([])
    expect('warnings' in qo).toBe(false)
  }
})

test('queue gives a rate-limited board list a Fix line', async () => {
  const c = fakeCtx({ replies: [{ argv: ['gh', 'project', 'item-list'], result: { exitCode: 1, stderr: 'GraphQL: API rate limit already exceeded for user ID 1.' } }] })
  const q = await queue(c, boardTracker([T(1)]), onCfg)
  expect(q.warnings).toHaveLength(1)
  expect(q.warnings?.[0]?.startsWith('board list failed: ')).toBe(true)
  expect(q.warnings?.[0]).toContain(' Fix: Wait at least 5 minutes.')
  expect(q.warnings?.[0]?.endsWith('does not show it.')).toBe(true)
})

const bare = (n: number, o: Partial<Ticket> = {}): Ticket => ({ ...T(n, [], o), labels: [] })

const url = (n: number): string => `https://github.com/o/r/issues/${n}`
const closed = (n: number, o: Partial<Ticket> = {}): Ticket => ({ ...bare(n, { state: 'closed', url: url(n) }), ...o })
const edits = (calls: string[][]): string[][] => calls.filter(x => x[2] === 'item-edit')

test('queue moves the card of a closed duplicate issue to Done', async () => {
  for (const o of [{ stateReason: 'duplicate' }, { stateReason: 'completed' }, {}]) {
    const c = fakeCtx({ replies: [itemList([{ url: 'u/3', factory: 'Build' }, { url: url(54), factory: 'Backlog' }]), ...boardReplies] })
    const q = await queue(c, boardTracker([T(3, ['factory:build'])], [closed(54, o)]), onCfg)
    expect(q.warnings).toBeUndefined()
    expect(c.calls.filter(x => x[2] === 'item-list')).toHaveLength(1)
    expect(edits(c.calls)).toEqual([edit('Done')])
  }
})

test('queue moves the card of a closed not planned issue to Rejected', async () => {
  const c = fakeCtx({ replies: [itemList([{ url: 'u/3', factory: 'Build' }, { url: url(54), factory: 'Spec' }]), ...boardReplies] })
  const q = await queue(c, boardTracker([T(3, ['factory:build'])], [closed(54, { stateReason: 'not_planned' })]), onCfg)
  expect(q.warnings).toBeUndefined()
  expect(edits(c.calls)).toEqual([edit('Rejected')])
})

test('queue moves the card of a closed done issue to Done', async () => {
  for (const o of [{ stateReason: 'completed' }, { stateReason: 'not_planned' }]) {
    const c = fakeCtx({ replies: [itemList([{ url: 'u/3', factory: 'Build' }, { url: url(103), factory: 'Ready to merge' }]), ...boardReplies] })
    const q = await queue(c, boardTracker([T(3, ['factory:build'])], [closed(103, { ...o, labels: ['factory', 'factory:done'] })]), onCfg)
    expect(q.warnings).toBeUndefined()
    expect(edits(c.calls)).toEqual([edit('Done')])
  }
})

test('queue moves the card of a closed rejected issue to Rejected', async () => {
  const c = fakeCtx({ replies: [itemList([{ url: 'u/3', factory: 'Build' }, { url: url(54), factory: 'Review' }]), ...boardReplies] })
  const q = await queue(c, boardTracker([T(3, ['factory:build'])], [closed(54, { stateReason: 'completed', labels: ['factory', 'factory:rejected'] })]), onCfg)
  expect(q.warnings).toBeUndefined()
  expect(edits(c.calls)).toEqual([edit('Rejected')])
})

test('queue warns with a fix when a closed done card move fails', async () => {
  const backlog = [T(1), T(3, ['factory:build'])]
  const want = await queue(ctx, boardTracker(backlog), cfg)
  const cards = itemList([{ url: 'u/1', factory: 'Backlog' }, { url: url(54), factory: 'Ready to merge' }])
  const c = fakeCtx({ replies: [cards, { argv: ['gh', 'project', 'item-edit'], result: { exitCode: 1, stderr: 'bad edit' } }, ...boardReplies] })
  const { warnings, ...rest } = await queue(c, boardTracker(backlog, [closed(54, { labels: ['factory', 'factory:done'] })]), onCfg)
  expect(warnings).toHaveLength(1)
  expect(warnings?.[0]?.startsWith('#54: ')).toBe(true)
  expect(warnings?.[0]).toContain('bad edit')
  expect(warnings?.[0]).toContain('Fix: Move the card by hand on the board, or wait for the next queue.')
  expect(rest).toEqual(want)
})

test('queue keeps the card of an open issue and of a labelled issue', async () => {
  const items = [
    { id: 'I0', content: { url: 'u/1' }, factory: 'Backlog' },
    { id: 'I1', content: { url: url(60) }, factory: 'Backlog' },
    { id: 'I2', content: { url: url(61) }, factory: 'Backlog' },
    { id: 'I3', content: { url: url(62) }, factory: 'Done' },
    { id: 'I4', content: { url: url(63) }, factory: 'Rejected' },
    { id: 'I5', content: { url: 'https://github.com/o/r/pull/64' }, factory: 'Backlog' },
    { id: 'I6', content: { url: 'https://github.com/x/y/issues/65' }, factory: 'Backlog' },
    { id: 'I7', content: {}, factory: 'Backlog' },
  ]
  const c = fakeCtx({ replies: [{ argv: ['gh', 'project', 'item-list'], result: { stdout: JSON.stringify({ items }) } }, ...boardReplies] })
  const extra = [bare(60, { url: url(60) }), closed(61, { labels: ['factory', 'factory:approved'] }), closed(62), closed(63, { stateReason: 'not_planned' })]
  const tr = boardTracker([T(1)], extra) as Tracker & { gets: number[] }
  const q = await queue(c, tr, onCfg)
  expect(tr.gets).toEqual([60, 61])
  expect(q.warnings).toBeUndefined()
  expect(edits(c.calls)).toEqual([])
})

test('queue warns with a fix when a closed card move fails', async () => {
  const backlog = [T(1), T(3, ['factory:build'])]
  const cards = itemList([{ url: 'u/1', factory: 'Backlog' }, { url: url(54), factory: 'Backlog' }])
  const want = await queue(ctx, boardTracker(backlog), cfg)
  const bad = fakeCtx({ replies: [cards, { argv: ['gh', 'project', 'item-edit'], result: { exitCode: 1, stderr: 'bad edit' } }, ...boardReplies] })
  const gone = fakeCtx({ replies: [cards, ...boardReplies] })
  for (const [c, tr, text] of [
    [bad, boardTracker(backlog, [closed(54)]), 'bad edit'],
    [gone, boardTracker(backlog), 'no #54'],
  ] as const) {
    const { warnings, ...rest } = await queue(c, tr, onCfg)
    expect(warnings).toHaveLength(1)
    expect(warnings?.[0]?.startsWith('#54: ')).toBe(true)
    expect(warnings?.[0]).toContain(text)
    expect(warnings?.[0]).toContain('Fix: Move the card by hand on the board, or wait for the next queue.')
    expect(rest).toEqual(want)
  }
})

test('queue with issue labels an open issue and puts it in next', async () => {
  const tr = tracker([T(1)], [bare(9)])
  const q = await queue(ctx, tr, cfg, 9)
  expect(tr.added).toEqual([[9, 'factory']])
  expect(nums(q.ready)).toContain(9)
  expect(nums(q.next)).toEqual([9])
})

test('queue with issue refuses a closed issue, a PR, and a final state', async () => {
  const cases: [Ticket, string][] = [
    [bare(5, { state: 'closed' }), '#5 is closed'],
    [bare(6, { kind: 'pr' }), '#6 is a pull request'],
    [T(7, ['factory:done']), '#7 is done'],
    [T(8, ['factory:rejected']), '#8 is rejected'],
  ]
  for (const [t, msg] of cases) {
    const tr = tracker([], [t])
    const err = await queue(ctx, tr, cfg, t.number).catch(e => e)
    expect(err).toMatchObject({ code: 'not-startable', message: msg })
    expect(tr.added).toEqual([])
  }
})

test('queue with issue keeps a blocked issue out of next', async () => {
  const q = await queue(ctx, tracker([T(3)], [bare(9, { body: 'Depends on #3' })]), cfg, 9)
  expect(q.blocked.map(b => [b.number, b.blockedBy])).toEqual([[9, [3]]])
  expect(q.next).toEqual([])
})

test('queue with issue puts only that issue in next', async () => {
  const backlog = [T(3, [], P('Urgent')), T(4, ['bug']), T(9, [], P('Low'))]
  const q = await queue(ctx, tracker(backlog), cfg, 9)
  expect(nums(q.ready)).toEqual([4, 3, 9])
  expect(nums(q.next)).toEqual([9])
  const full = await queue(ctx, tracker(backlog), { ...cfg, concurrency: 0 }, 9)
  expect(full.slots).toBe(0)
  expect(full.next).toEqual([])
})

test('queue without issue changes no label', async () => {
  const tr = tracker([T(1, [], P('Low')), T(2, [], P('High')), T(3)])
  const q = await queue(ctx, tr, cfg)
  expect(tr.added).toEqual([])
  expect(nums(q.ready)).toEqual([2, 3, 1])
  expect(nums(q.next)).toEqual([2, 3])
})

test('tool queue takes an issue', async () => {
  const def = TOOLS.find(t => t.name === 'queue')!
  expect(def.inputSchema).toMatchObject({ properties: { issue: { type: 'integer', minimum: 1 } } })
  const issue = { number: 9, title: 'T', body: '', labels: [], user: { login: 'a' }, created_at: '2026-01-01T00:00:00Z', html_url: 'u/9', state: 'open' }
  const c = fakeCtx({
    files: { '/repo/.factory/config.json': JSON.stringify(defaultConfig('https://github.com/a/b', 'main', [])) },
    replies: [
      { argv: ['gh', 'api', 'repos/a/b/issues/9'], result: { stdout: JSON.stringify(issue) } },
      { argv: ['gh', 'api', 'repos/a/b/issues/9/comments'] },
      { argv: ['gh', 'api', '-X', 'POST'] },
      { argv: ['gh', 'api', 'repos/a/b/issues?labels=factory&state=open&per_page=100'] },
      { argv: ['gh', 'api', 'repos/a/b/issues?labels=factory,factory:docs&state=closed&per_page=100'] },
      { argv: ['gh', 'api', 'repos/a/b/issues?labels=factory,factory:needs-human&state=closed&per_page=100'] },
    ],
  })
  const q = (await def.handler(c, { issue: 9 })) as { next: { number: number }[] }
  expect(c.calls).toContainEqual(['gh', 'api', '-X', 'POST', 'repos/a/b/issues/9/labels', '--input', '-'])
  expect(nums(q.next)).toEqual([9])
  for (const bad of [0, -1, 1.5, '9']) {
    await expect(def.handler(c, { issue: bad })).rejects.toMatchObject({ code: 'bad-input' })
  }
})
