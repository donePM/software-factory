import { expect, test } from 'claude-code/testing'
import { STATUS } from '../lib/labels.ts'
import { boardDrift, FACTORY_OPTIONS, optionFor, withBoard } from '../lib/project.ts'
import type { Tracker } from '../lib/tracker.ts'
import type { Ticket } from '../lib/types.ts'
import { boardCalls, boardReplies, edit, itemList, ON, onBoard } from './support/board.ts'
import { fakeCtx } from './support/host.ts'

test('optionFor maps each state to one Factory option', () => {
  expect(FACTORY_OPTIONS).toEqual(['Backlog', 'Intake', 'Spec', 'Design', 'Build', 'Review', 'Waiting', 'Ready to merge', 'Docs', 'Done', 'Rejected'])
  expect(optionFor(null)).toBe('Backlog')
  expect(Object.fromEntries(STATUS.map(s => [s, optionFor(s)]))).toEqual({
    intake: 'Intake', 'needs-info': 'Waiting', fastlane: 'Build', spec: 'Spec', 'needs-design': 'Design', build: 'Build',
    review: 'Review', 'needs-human': 'Waiting', approved: 'Ready to merge', docs: 'Docs', done: 'Done', rejected: 'Rejected',
  })
})

const fake = (fail = false): Tracker => ({
  repo: 'o/r',
  setState: async () => { if (fail) throw new Error('bad move') },
}) as unknown as Tracker

test('withBoard adds the card and sets the option after the label change', async () => {
  const ctx = fakeCtx({ replies: boardReplies })
  const { tracker, warnings } = onBoard(ctx, fake())
  await tracker.setState(7, 'spec')
  await tracker.setState(7, 'build')
  expect(boardCalls(ctx.calls)).toEqual([
    'setState 7 spec', 'gh project view', 'gh project field-list', 'gh project item-add', 'gh project item-edit',
    'setState 7 build', 'gh project item-add', 'gh project item-edit',
  ])
  expect(ctx.calls).toContainEqual(['gh', 'project', 'item-add', '3', '--owner', 'o', '--url', 'https://github.com/o/r/issues/7', '--format', 'json'])
  expect(ctx.calls).toContainEqual(edit('Spec'))
  expect(ctx.calls).toContainEqual(edit('Build'))
  expect(warnings).toEqual([])
})

test('withBoard warns when project.number is missing', async () => {
  const ctx = fakeCtx({ replies: boardReplies })
  const { tracker, warnings } = onBoard(ctx, fake(), { project: { enabled: true } })
  await tracker.setState(7, 'spec')
  expect(boardCalls(ctx.calls)).toEqual(['setState 7 spec'])
  expect(warnings).toEqual(['project.number is missing. Run /factory:setup project.'])
})

test('withBoard turns a failed project call into a warning', async () => {
  const ctx = fakeCtx({ replies: [{ argv: ['gh', 'project', 'item-edit'], result: { exitCode: 1, stderr: 'boom' } }, ...boardReplies] })
  const { tracker, warnings } = onBoard(ctx, fake())
  await tracker.setState(7, 'spec')
  expect(warnings).toHaveLength(1)
  expect(warnings[0]).toContain('#7: ')
  expect(warnings[0]).toContain('boom')
})

test('no gh project call with the project off', async () => {
  for (const cfg of [{ project: { enabled: false, number: 3 } }, {}]) {
    const ctx = fakeCtx({ replies: boardReplies })
    const t = fake()
    const { tracker, warnings } = withBoard(ctx, t, cfg)
    expect(tracker).toBe(t)
    await tracker.setState(7, 'spec')
    expect(boardCalls(ctx.calls)).toEqual([])
    expect(warnings).toEqual([])
  }
  // A failed label change makes no project call either.
  const ctx = fakeCtx({ replies: boardReplies })
  const { tracker, warnings } = onBoard(ctx, fake(true))
  await expect(tracker.setState(7, 'spec')).rejects.toThrow('bad move')
  expect(boardCalls(ctx.calls)).toEqual([])
  expect(warnings).toEqual([])
})

const T = (n: number, ...labels: string[]): Ticket => ({
  kind: 'issue', number: n, title: `t${n}`, body: '', author: 'a', labels: ['factory', ...labels],
  state: 'open', createdAt: '2026-01-01T00:00:00Z', url: `https://github.com/o/r/issues/${n}`, comments: [],
})
const url = (n: number): string => `https://github.com/o/r/issues/${n}`

test('boardDrift shows one line for each card that differs', async () => {
  const ctx = fakeCtx({ replies: [itemList([{ url: url(63), factory: 'Review' }, { url: url(64) }, { url: url(65), factory: 'Spec' }])] })
  const lines = await boardDrift(ctx, fake(), ON, [T(63, 'factory:approved'), T(64, 'factory:build'), T(65, 'factory:spec')])
  expect(lines).toEqual([
    '#63 board says Review, label says approved: move the card to Ready to merge',
    '#64 board says nothing, label says build: move the card to Build',
  ])
  expect(ctx.calls).toEqual([['gh', 'project', 'item-list', '3', '--owner', 'o', '--limit', '1000', '--format', 'json']])
})

test('boardDrift shows no line when all cards match', async () => {
  const ctx = fakeCtx({ replies: [itemList([
    { url: url(1), factory: 'Build' }, { url: url(2), factory: 'Backlog' }, { url: url(3), factory: 'Review' }, { url: url(9), factory: 'Done' },
  ])] })
  const tickets = [T(1, 'factory:fastlane'), T(2), T(3, 'factory:build', 'factory:review'), T(4, 'factory:spec')]
  expect(await boardDrift(ctx, fake(), ON, tickets)).toEqual([])
})

test('boardDrift never changes a label or a card', async () => {
  const ctx = fakeCtx({ replies: [...boardReplies, itemList([{ url: url(63), factory: 'Review' }])] })
  const { tracker } = onBoard(ctx, fake())
  expect(await boardDrift(ctx, tracker, ON, [T(63, 'factory:approved')])).toHaveLength(1)
  expect(boardCalls(ctx.calls)).toEqual(['gh project item-list'])
  expect(ctx.calls.filter(c => c[0] === 'gh' && c[1] === 'issue')).toEqual([])
})

test('boardDrift makes no project call with the project off and warns on failure', async () => {
  for (const cfg of [{ project: { enabled: false, number: 3 } }, {}]) {
    const ctx = fakeCtx({ replies: [itemList([{ url: url(63), factory: 'Review' }])] })
    expect(await boardDrift(ctx, fake(), cfg, [T(63, 'factory:approved')])).toEqual([])
    expect(ctx.calls).toEqual([])
  }
  const off = fakeCtx({ replies: [itemList([])] })
  expect(await boardDrift(off, fake(), { project: { enabled: true } }, [T(63)])).toEqual(['project.number is missing. Run /factory:setup project.'])
  expect(off.calls).toEqual([])
  const bad = fakeCtx({ replies: [{ argv: ['gh', 'project', 'item-list'], result: { exitCode: 1, stderr: 'boom' } }] })
  const lines = await boardDrift(bad, fake(), ON, [T(63)])
  expect(lines).toHaveLength(1)
  expect(lines[0]?.startsWith('board check failed: ')).toBe(true)
  expect(lines[0]).toContain('boom')
})
