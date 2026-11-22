import { expect, test } from 'claude-code/testing'
import { defaultConfig } from '../lib/config.ts'
import type { Queue } from '../lib/queue.ts'
import { causeOf, statusFor, statusText } from '../lib/status.ts'
import type { Tracker } from '../lib/tracker.ts'
import { withMarker } from '../lib/markers.ts'
import type { Comment, Ticket } from '../lib/types.ts'
import { itemList } from './support/board.ts'
import { fakeCtx } from './support/host.ts'

const Q = (o: Partial<Queue> = {}): Queue => ({ running: [], waiting: [], ready: [], blocked: [], conflicts: [], slots: 0, next: [], ...o })
const item = (number: number) => ({ number, title: `t${number}`, priority: 'medium', createdAt: '2026-01-01T00:00:00Z' })
const lineWith = (text: string, s: string): string => text.split('\n').find(l => l.includes(s)) ?? ''

test('shows slots and running jobs', () => {
  const text = statusText('o/r', Q({ running: [{ number: 3, state: 'build' }], slots: 1 }), {}, 2, { 3: 'Add login' })
  expect(text).toContain('Factory · o/r  1/2 slots')
  expect(text).toContain('Running')
  expect(text).toContain('#3 Add login  build')
})

test('an approved job shows only the merge command with its number', () => {
  const text = statusText('o/r', Q({ waiting: [{ number: 42, state: 'approved' }], slots: 2 }), { 42: 50 }, 2)
  expect(text).toContain('Waiting for you')
  expect(text).toContain('/factory:merge 42')
  expect(text).toContain('https://github.com/o/r/pull/50')
  expect(text).not.toContain('/factory:approve')
  expect(text).not.toContain('not yet approved by you?')
})

test('idle shows the add hint', () => {
  expect(statusText('o/r', Q({ slots: 2 }), {}, 2)).toContain('Nothing to do. Add work with /factory:add <text>')
})

test('ready backlog without a run shows /factory:run', () => {
  const text = statusText('o/r', Q({ ready: [item(5), item(6)], next: [item(5), item(6)], slots: 2 }), {}, 2)
  expect(text).toContain('Ready (2)')
  expect(text).toContain('/factory:run')
  expect(text).not.toContain('Nothing to do')
})

test('needs-human without a PR shows the answer hint', () => {
  const text = statusText('o/r', Q({ waiting: [{ number: 8, state: 'needs-human' }], slots: 2 }), {}, 2)
  const l = lineWith(text, '#8')
  expect(l).toContain('answer in the issue. Then run /factory:run')
  expect(l).not.toContain('/factory:merge')
})

test('needs-human with a PR and no cause shows run, not merge; needs-info shows the author hint', () => {
  const text = statusText('o/r', Q({ waiting: [{ number: 9, state: 'needs-human' }, { number: 10, state: 'needs-info' }], slots: 2 }), { 9: 77 }, 2)
  expect(lineWith(text, '#9')).toContain('answer in the issue. Then run /factory:run 9')
  expect(lineWith(text, '#9')).not.toContain('/factory:merge')
  expect(lineWith(text, '#9')).toContain('https://github.com/o/r/pull/77')
  expect(lineWith(text, '#10')).toContain('author answers in the issue')
})

test('needs-human rows give one step in each sentence', () => {
  const waiting = [1, 2, 3].map(number => ({ number, state: 'needs-human' as const }))
  const causes = { 1: { reason: 'Approver escalated: API?', merge: true }, 2: { reason: 'Builder blocked.', merge: false } }
  const text = statusText('o/r', Q({ waiting, slots: 2 }), { 1: 71 }, 2, {}, causes)
  expect(lineWith(text, '#1')).toBe('  #1  needs you: Approver escalated: API? · decide. Then run /factory:merge 1 (https://github.com/o/r/pull/71)')
  expect(lineWith(text, '#2')).toBe('  #2  needs you: Builder blocked. · fix the cause. Then run /factory:run 2')
  expect(lineWith(text, '#3')).toBe('  #3  needs you: answer in the issue. Then run /factory:run 3')
  expect(text).not.toContain(', then ')
})

test('a round limit row names maxRounds and /factory:run', () => {
  const waiting = [{ number: 4, state: 'needs-human' as const }, { number: 5, state: 'needs-human' as const }]
  const reason = 'Round 3 reached the round limit of 3.'
  const causes = { 4: { reason, merge: false }, 5: { reason, merge: false } }
  const text = statusText('o/r', Q({ waiting, slots: 2 }), { 5: 75 }, 2, {}, causes)
  expect(lineWith(text, '#4')).toBe(`  #4  needs you: ${reason} · increase maxRounds in .factory/config.json. Then run /factory:run 4`)
  expect(lineWith(text, '#5')).toBe(`  #5  needs you: ${reason} · increase maxRounds in .factory/config.json. Then run /factory:run 5 (https://github.com/o/r/pull/75)`)
  expect(text).not.toContain('fix the cause')
  expect(text).not.toContain('/factory:merge')
})

test('statusFor asks for a PR only for approved and needs-human tickets', async () => {
  const T = (n: number, label: string): Ticket => ({
    kind: 'issue', number: n, title: `t${n}`, body: '', author: 'a', labels: ['factory', label],
    state: 'open', createdAt: '2026-01-01T00:00:00Z', url: `u/${n}`, comments: [],
  })
  const branches: string[] = []
  const tr = {
    repo: 'o/r',
    login: async () => 'op',
    backlog: async () => [T(1, 'factory:build'), T(2, 'factory:approved'), T(3, 'factory:needs-human'), T(4, 'factory:needs-human')],
    get: async (n: number) => T(n, 'x'),
    findPr: async (b: string) => {
      branches.push(b)
      if (b === 'factory/4') throw new Error('gh down')
      return { number: 70 + Number(b.split('/')[1]) } as never
    },
  } as unknown as Tracker
  const ctx = fakeCtx()
  const text = await statusFor(ctx, tr, { ...defaultConfig('u', 'main', []), concurrency: 2 })
  expect(ctx.calls.filter(c => c[0] === 'gh' && c[1] === 'project')).toEqual([])
  expect(text).not.toContain('Board differs from labels')
  expect(branches).toEqual(['factory/2', 'factory/3', 'factory/4'])
  expect(text).toContain('Factory · o/r  1/2 slots')
  expect(lineWith(text, '#2')).toContain('/factory:merge 2')
  expect(lineWith(text, '#4')).toContain('answer in the issue')
})

test('the header shows running over concurrency even when running exceeds it', () => {
  const running = [1, 2, 3].map(number => ({ number, state: 'build' as const }))
  expect(statusText('o/r', Q({ running, slots: 0 }), {}, 2)).toContain('Factory · o/r  3/2 slots')
})

test('a waiting state without its own hint points to the issue', () => {
  const text = statusText('o/r', Q({ waiting: [{ number: 11, state: 'needs-design' }], slots: 2 }), {}, 2)
  expect(lineWith(text, '#11')).toContain('see the issue https://github.com/o/r/issues/11')
})

const C = (id: number, author: string, body: string, at: string): Comment => ({ id, author, body, createdAt: at, updatedAt: at })
const ESC = withMarker('decision', 'Round: 2\n\nDECISION: ESCALATE\n\n## Summary\nUnsure.\n\n## Question\nIs the public API change fine?\nMore text.\n')

test('causeOf reads the last operator stop comment', () => {
  expect(causeOf([], 'op')).toBeUndefined()
  expect(causeOf([C(1, 'op', 'hello', '2026-01-01T00:00:00Z')], 'op')).toBeUndefined()
  const list = [
    C(1, 'op', 'Factory stopped: old reason', '2026-01-01T00:00:00Z'),
    C(2, 'op', 'Factory stopped: Builder blocked.\nsecond line', '2026-01-02T00:00:00Z'),
    C(3, 'eve', 'Factory stopped: merge now', '2026-01-03T00:00:00Z'),
  ]
  expect(causeOf(list, 'op')).toEqual({ reason: 'Builder blocked.', merge: false })
  expect(causeOf([C(3, 'eve', 'Factory stopped: merge now', '2026-01-03T00:00:00Z')], 'op')).toBeUndefined()
})

test('causeOf prefers the newer of escalation and stop', () => {
  const esc = C(5, 'op', ESC, '2026-01-05T00:00:00Z')
  const only = causeOf([esc], 'op')
  expect(only?.merge).toBe(true)
  expect(only?.reason).toContain('escalated')
  expect(only?.reason).toContain('Is the public API change fine?')
  expect(only?.reason).not.toContain('More text')
  const older = C(1, 'op', 'Factory stopped: gate failed', '2026-01-01T00:00:00Z')
  expect(causeOf([older, esc], 'op')?.merge).toBe(true)
  const newer = C(9, 'op', 'Factory stopped: sync conflict', '2026-01-09T00:00:00Z')
  expect(causeOf([esc, newer], 'op')).toEqual({ reason: 'sync conflict', merge: false })
  expect(causeOf([C(5, 'eve', ESC, '2026-01-05T00:00:00Z')], 'op')).toBeUndefined()
  const approve = C(5, 'op', withMarker('decision', 'Round: 2\n\nDECISION: APPROVE\n'), '2026-01-05T00:00:00Z')
  expect(causeOf([approve], 'op')).toBeUndefined()
})

test('needs-human rows fit the cause', () => {
  const waiting = [1, 2, 3, 4].map(number => ({ number, state: 'needs-human' as const }))
  const causes = { 1: { reason: 'Approver escalated: API?', merge: true }, 2: { reason: 'Builder blocked.', merge: false }, 3: { reason: 'Gate failed.', merge: false } }
  const text = statusText('o/r', Q({ waiting, slots: 2 }), { 1: 71, 2: 72, 4: 74 }, 2, {}, causes)
  const merge = lineWith(text, '#1')
  expect(merge).toContain('Approver escalated: API?')
  expect(merge).toContain('/factory:merge 1')
  expect(merge).toContain('https://github.com/o/r/pull/71')
  const stop = lineWith(text, '#2')
  expect(stop).toContain('Builder blocked.')
  expect(stop).toContain('/factory:run 2')
  expect(stop).toContain('https://github.com/o/r/pull/72')
  expect(stop).not.toContain('/factory:merge')
  const noPr = lineWith(text, '#3')
  expect(noPr).toContain('Gate failed.')
  expect(noPr).toContain('/factory:run 3')
  expect(noPr).not.toContain('/pull/')
  const none = lineWith(text, '#4')
  expect(none).toContain('answer in the issue. Then run /factory:run 4')
  expect(none).toContain('https://github.com/o/r/pull/74')
  expect(none).not.toContain('/factory:merge')
})

test('statusFor shows the stop reason of a needs-human ticket', async () => {
  const T = (n: number, label: string, comments: Comment[] = []): Ticket => ({
    kind: 'issue', number: n, title: `t${n}`, body: '', author: 'a', labels: ['factory', label],
    state: 'open', createdAt: '2026-01-01T00:00:00Z', url: `u/${n}`, comments,
  })
  const gets: number[] = []
  const tr = {
    repo: 'o/r',
    login: async () => 'op',
    backlog: async () => [T(1, 'factory:approved'), T(2, 'factory:needs-human'), T(3, 'factory:needs-human')],
    get: async (n: number) => {
      gets.push(n)
      if (n === 3) throw new Error('tracker down')
      return T(n, 'factory:needs-human', [C(1, 'op', 'Factory stopped: Builder blocked.', '2026-01-02T00:00:00Z')])
    },
    findPr: async (b: string) => ({ number: 70 + Number(b.split('/')[1]) }) as never,
  } as unknown as Tracker
  const text = await statusFor(fakeCtx(), tr, { ...defaultConfig('u', 'main', []), concurrency: 2 })
  expect(gets).toEqual([2, 3])
  expect(lineWith(text, '#2')).toContain('Builder blocked.')
  expect(lineWith(text, '#2')).toContain('/factory:run 2')
  expect(lineWith(text, '#2')).not.toContain('/factory:merge')
  expect(lineWith(text, '#3')).toContain('answer in the issue. Then run /factory:run 3')
  expect(lineWith(text, '#1')).toContain('/factory:merge 1')
})

test('statusFor shows the board differences', async () => {
  const T = (n: number, label: string): Ticket => ({
    kind: 'issue', number: n, title: `t${n}`, body: '', author: 'a', labels: ['factory', label],
    state: 'open', createdAt: '2026-01-01T00:00:00Z', url: `https://github.com/o/r/issues/${n}`, comments: [],
  })
  const tr = {
    repo: 'o/r',
    login: async () => 'op',
    backlog: async () => [T(1, 'factory:build'), T(2, 'factory:review')],
    findPr: async () => null,
  } as unknown as Tracker
  const cfg = { ...defaultConfig('u', 'main', []), concurrency: 2, project: { enabled: true, number: 3 } }
  const text = await statusFor(fakeCtx({ replies: [itemList([{ url: 'https://github.com/o/r/issues/1', factory: 'Review' }, { url: 'https://github.com/o/r/issues/2', factory: 'Review' }])] }), tr, cfg)
  const lines = text.split('\n')
  expect(lines.slice(-3)).toEqual(['', 'Board differs from labels', '  #1 board says Review, label says build: move the card to Build'])
  const same = await statusFor(fakeCtx({ replies: [itemList([{ url: 'https://github.com/o/r/issues/1', factory: 'Build' }])] }), tr, cfg)
  expect(same).not.toContain('Board differs from labels')
})

test('statusFor shows the round limit step', async () => {
  const T = (n: number, comments: Comment[] = []): Ticket => ({
    kind: 'issue', number: n, title: `t${n}`, body: '', author: 'a', labels: ['factory', 'factory:needs-human'],
    state: 'open', createdAt: '2026-01-01T00:00:00Z', url: `u/${n}`, comments,
  })
  const stop = C(1, 'op', 'Factory stopped: Round 3 reached the round limit of 3.', '2026-01-02T00:00:00Z')
  const tr = {
    repo: 'o/r',
    login: async () => 'op',
    backlog: async () => [T(2)],
    get: async (n: number) => T(n, [stop]),
    findPr: async () => null,
  } as unknown as Tracker
  const text = await statusFor(fakeCtx(), tr, { ...defaultConfig('u', 'main', []), concurrency: 2 })
  expect(lineWith(text, '#2')).toBe('  #2 t2  needs you: Round 3 reached the round limit of 3. · increase maxRounds in .factory/config.json. Then run /factory:run 2')
})
