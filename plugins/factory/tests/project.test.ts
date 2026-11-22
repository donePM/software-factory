import { expect, test } from 'claude-code/testing'
import { readJob, renderJob, type BoardIds, type Job } from '../lib/jobfile.ts'
import { STATUS } from '../lib/labels.ts'
import { addToBacklog, boardDrift, FACTORY_OPTIONS, optionFor, withBoard } from '../lib/project.ts'
import type { Tracker } from '../lib/tracker.ts'
import type { State, Ticket } from '../lib/types.ts'
import { boardCalls, boardReplies, edit, itemList, ON, onBoard, optionId } from './support/board.ts'
import { fakeCtx } from './support/host.ts'

test('optionFor maps each state to one Factory option', () => {
  expect(FACTORY_OPTIONS).toEqual(['Backlog', 'Intake', 'Spec', 'Design', 'Build', 'Review', 'Waiting', 'Ready to merge', 'Docs', 'Done', 'Rejected'])
  expect(optionFor(null)).toBe('Backlog')
  expect(Object.fromEntries(STATUS.map(s => [s, optionFor(s)]))).toEqual({
    intake: 'Intake', 'needs-info': 'Waiting', fastlane: 'Build', spec: 'Spec', 'needs-design': 'Design', build: 'Build',
    review: 'Review', 'needs-human': 'Waiting', approved: 'Ready to merge', docs: 'Docs', done: 'Done', rejected: 'Rejected',
  })
})

const fake = (fail = false, from?: State | null): Tracker => ({
  repo: 'o/r',
  setState: async () => {
    if (fail) throw new Error('bad move')
    return from
  },
}) as unknown as Tracker

const DIR = '/repo/.factory/jobs/7'
const JOB: Job = {
  issue: 7, title: 't', jobDir: DIR, worktree: '/repo/.factory/worktrees/7', branch: 'factory/7', base: 'none', baseBranch: 'main',
  pr: null, round: 0, specUpdated: null, reviewed: null, route: {}, language: 'English',
}
const IDS: BoardIds = { project: 'P1', field: 'F1', item: 'I1', options: Object.fromEntries(FACTORY_OPTIONS.map(o => [o, optionId(o)])) }
const withJob = (board?: BoardIds) => ({ [`${DIR}/job.md`]: renderJob(board === undefined ? JOB : { ...JOB, board }) })

test('a transition with the board ids in job.md makes exactly one board call', async () => {
  const ctx = fakeCtx({ files: withJob(IDS), replies: boardReplies })
  const { tracker, warnings } = onBoard(ctx, fake(false, 'intake'))
  await tracker.setState(7, 'spec')
  expect(boardCalls(ctx.calls)).toEqual(['setState 7 spec', 'gh project item-edit'])
  expect(ctx.calls).toContainEqual(edit('Spec'))
  expect(warnings).toEqual([])
})

test('the first board write saves the board ids in job.md', async () => {
  const ctx = fakeCtx({ files: withJob(), replies: boardReplies })
  const { tracker, warnings, save } = onBoard(ctx, fake(false, 'intake'))
  await tracker.setState(7, 'spec')
  await save()
  expect((await readJob(ctx, 7)).board).toEqual(IDS)
  expect(warnings).toEqual([])
  // No job.md: the ids are not saved, and save writes no file.
  const none = fakeCtx({ replies: boardReplies })
  const b = onBoard(none, fake(false, 'intake'))
  await b.tracker.setState(7, 'spec')
  await b.save()
  expect(Object.keys(none.files)).toEqual([])
})

test('a transition that keeps the board column makes no board call', async () => {
  for (const [from, to] of [['spec', 'spec'], ['fastlane', 'build'], ['needs-info', 'needs-human']] as const) {
    const ctx = fakeCtx({ files: withJob(IDS), replies: boardReplies })
    const { tracker } = onBoard(ctx, fake(false, from))
    await tracker.setState(7, to)
    expect(boardCalls(ctx.calls)).toEqual([`setState 7 ${to}`])
  }
})

test('a failed board write with cached ids gives a warning with a fix and no lookup', async () => {
  const ctx = fakeCtx({ files: withJob(IDS), replies: [{ argv: ['gh', 'project', 'item-edit'], result: { exitCode: 1, stderr: 'boom' } }, ...boardReplies] })
  const { tracker, warnings } = onBoard(ctx, fake(false, 'intake'))
  await tracker.setState(7, 'spec')
  expect(boardCalls(ctx.calls)).toEqual(['setState 7 spec', 'gh project item-edit'])
  expect(warnings).toHaveLength(1)
  expect(warnings[0]).toContain('boom')
  expect(warnings[0]).toContain(`Fix: Delete the ## Board section in ${DIR}/job.md.`)
})

test('withBoard adds the card and sets the option after the label change, and looks the ids up once', async () => {
  const ctx = fakeCtx({ replies: boardReplies })
  const { tracker, warnings } = onBoard(ctx, fake())
  await tracker.setState(7, 'spec')
  await tracker.setState(7, 'build')
  expect(boardCalls(ctx.calls)).toEqual([
    'setState 7 spec', 'gh project view', 'gh project field-list', 'gh project item-add', 'gh project item-edit',
    'setState 7 build', 'gh project item-edit',
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

test('withBoard turns a GraphQL rate limit into a warning and keeps the label change', async () => {
  const ctx = fakeCtx({ replies: [{ argv: ['gh', 'project'], result: { exitCode: 1, stderr: 'GraphQL: API rate limit already exceeded for user ID 1.' } }] })
  const { tracker, warnings } = onBoard(ctx, fake())
  await tracker.setState(7, 'spec')
  expect(boardCalls(ctx.calls)).toEqual(['setState 7 spec', 'gh project view'])
  expect(warnings).toHaveLength(1)
  expect(warnings[0]).toContain('rate limit')
  expect(warnings[0]).toContain('Fix: Wait')
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

test('addToBacklog adds a Backlog card for each issue', async () => {
  const ctx = fakeCtx({ replies: boardReplies })
  expect(await addToBacklog(ctx, fake(), ON, [7, 8])).toEqual([])
  expect(boardCalls(ctx.calls)).toEqual([
    'gh project view', 'gh project field-list', 'gh project item-add', 'gh project item-edit', 'gh project item-add', 'gh project item-edit',
  ])
  expect(ctx.calls).toContainEqual(['gh', 'project', 'item-add', '3', '--owner', 'o', '--url', url(7), '--format', 'json'])
  expect(ctx.calls).toContainEqual(['gh', 'project', 'item-add', '3', '--owner', 'o', '--url', url(8), '--format', 'json'])
  expect(ctx.calls.filter(c => c[2] === 'item-edit')).toEqual([edit('Backlog'), edit('Backlog')])
})

test('addToBacklog turns board failures into warnings and skips an off board', async () => {
  const ctx = fakeCtx({
    replies: [
      { argv: ['gh', 'project', 'item-add', '3', '--owner', 'o', '--url', url(7)], result: { stdout: JSON.stringify({ id: 'I7' }) } },
      { argv: ['gh', 'project', 'item-edit', '--id', 'I7'], result: { exitCode: 1, stderr: 'boom' } },
      ...boardReplies,
    ],
  })
  const warnings = await addToBacklog(ctx, fake(), ON, [7, 8])
  expect(warnings).toHaveLength(1)
  expect(warnings[0]?.startsWith('#7: ')).toBe(true)
  expect(warnings[0]).toContain('boom')
  expect(ctx.calls).toContainEqual(edit('Backlog'))
  const view = fakeCtx({ replies: [{ argv: ['gh', 'project', 'view'], result: { exitCode: 1, stderr: 'no scope' } }] })
  const failed = await addToBacklog(view, fake(), ON, [7])
  expect(failed).toHaveLength(1)
  expect(failed[0]).toContain('no scope')
  for (const cfg of [{ project: { enabled: false, number: 3 } }, {}]) {
    const off = fakeCtx({ replies: boardReplies })
    expect(await addToBacklog(off, fake(), cfg, [7])).toEqual([])
    expect(off.calls).toEqual([])
  }
  const none = fakeCtx({ replies: boardReplies })
  expect(await addToBacklog(none, fake(), { project: { enabled: true } }, [7])).toEqual(['project.number is missing. Run /factory:setup project.'])
  expect(none.calls).toEqual([])
})
