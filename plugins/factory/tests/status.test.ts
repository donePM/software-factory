import { expect, test } from 'claude-code/testing'
import { defaultConfig } from '../lib/config.ts'
import type { Queue } from '../lib/queue.ts'
import { statusFor, statusText } from '../lib/status.ts'
import type { Tracker } from '../lib/tracker.ts'
import type { Ticket } from '../lib/types.ts'
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

test('an approved job shows the merge command with its number', () => {
  const text = statusText('o/r', Q({ waiting: [{ number: 42, state: 'approved' }], slots: 2 }), { 42: 50 }, 2)
  expect(text).toContain('Waiting for you')
  expect(text).toContain('/factory:merge 42')
  expect(text).toContain('/factory:approve 42')
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
  expect(l).toContain('answer in the issue, then /factory:run')
  expect(l).not.toContain('/factory:merge')
})

test('needs-human with a PR shows merge and the PR link; needs-info shows the author hint', () => {
  const text = statusText('o/r', Q({ waiting: [{ number: 9, state: 'needs-human' }, { number: 10, state: 'needs-info' }], slots: 2 }), { 9: 77 }, 2)
  expect(lineWith(text, '#9')).toContain('/factory:merge 9')
  expect(lineWith(text, '#9')).toContain('https://github.com/o/r/pull/77')
  expect(lineWith(text, '#10')).toContain('author answers in the issue')
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
  const text = await statusFor(fakeCtx(), tr, { ...defaultConfig('u', 'main', []), concurrency: 2 })
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
