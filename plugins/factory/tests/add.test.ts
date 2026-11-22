import { expect, test } from 'claude-code/testing'
import { defaultConfig } from '../lib/config.ts'
import { issueCreate, issueSearch } from '../lib/add.ts'
import { dependsOn } from '../lib/queue.ts'
import { TOOLS } from '../hooks/tools.ts'
import type { Tracker } from '../lib/tracker.ts'
import { fakeCtx } from './support/host.ts'

type Made = { title: string; body: string; labels: string[] }

function fakeTracker(start = 10, failAt = 0): { t: Tracker; made: Made[] } {
  const made: Made[] = []
  const t = {
    repo: 'a/b',
    createIssue: async (title: string, body: string, labels: string[]) => {
      if (made.length + 1 === failAt) throw new Error('gh issue: HTTP 502')
      made.push({ title, body, labels })
      return start + made.length - 1
    },
    searchIssues: async (query: string) => [{ number: 3, title: `hit ${query}`, labels: ['factory'] }],
  } as unknown as Tracker
  return { t, made }
}

const bad = (p: Promise<unknown>): Promise<void> => expect(p).rejects.toMatchObject({ code: 'bad-input' })

test('issue_create labels issues with factory', async () => {
  const { t, made } = fakeTracker()
  const r = await issueCreate(t, { items: [{ title: 'Add x', body: 'Please add x.', ref: 'x' }] })
  expect(made).toEqual([{ title: 'Add x', body: 'Please add x.', labels: ['factory'] }])
  expect(r).toEqual([{ ref: 'x', number: 10, url: 'https://github.com/a/b/issues/10' }])
})

test('issue_create with park adds no label', async () => {
  const { t, made } = fakeTracker()
  await issueCreate(t, { items: [{ title: 'Add x', body: 'b' }], park: true })
  expect(made[0]!.labels).toEqual([])
})

test('issue_create adds the new factory issues to the board backlog', async () => {
  const seen: number[][] = []
  const board = async (ns: number[]): Promise<string[]> => {
    seen.push(ns)
    return []
  }
  const items = [{ title: 'Add x', body: 'b' }, { title: 'Add y', body: 'b' }]
  const r = await issueCreate(fakeTracker().t, { items }, board)
  expect(seen).toEqual([[10, 11]])
  expect(Array.isArray(r)).toBe(true)
  await issueCreate(fakeTracker().t, { items, park: true }, board)
  expect(seen).toHaveLength(1)
  const warned = await issueCreate(fakeTracker().t, { items: [items[0]!] }, async () => ['#10: boom'])
  expect(warned).toEqual({ created: [{ ref: '', number: 10, url: 'https://github.com/a/b/issues/10' }], warnings: ['#10: boom'] })
})

test('issue_create links a later item to an earlier one', async () => {
  const { t, made } = fakeTracker(11)
  await issueCreate(t, {
    items: [
      { title: 'One', body: 'first', ref: 'a' },
      { title: 'Two', body: 'second', dependsOn: [5], dependsOnRefs: ['a'] },
    ],
  })
  expect(made[1]!.body).toBe('second\n\nDepends on #5\nDepends on #11')
  expect(dependsOn(made[1]!.body)).toEqual([5, 11])
})

test('issue_create validates everything before creating anything', async () => {
  const { t, made } = fakeTracker()
  await bad(issueCreate(t, { items: [] }))
  await bad(issueCreate(t, { items: [{ title: 'ok', body: '' }, { title: ' ', body: '' }] }))
  await bad(issueCreate(t, { items: [{ title: 'a', body: '', ref: 'r' }, { title: 'b', body: '', ref: 'r' }] }))
  await bad(issueCreate(t, { items: [{ title: 'a', body: '', dependsOnRefs: ['later'] }, { title: 'b', body: '', ref: 'later' }] }))
  await bad(issueCreate(t, { items: [{ title: 'a', body: '', dependsOnRefs: ['a'], ref: 'a' }] }))
  await bad(issueCreate(t, { items: [{ title: 'a', body: '' }, { title: 'b', body: '', dependsOn: [0] }] }))
  await bad(issueCreate(t, { items: [{ title: 'a', body: '', dependsOn: [1.5] }] }))
  expect(made).toEqual([])
})

test('issue_create names the created issues when a later item fails', async () => {
  const { t } = fakeTracker(10, 3)
  const items = [{ title: 'One', body: 'a' }, { title: 'Two', body: 'b' }, { title: 'Three', body: 'c' }, { title: 'Four', body: 'd' }]
  let err: unknown
  try { await issueCreate(t, { items }) } catch (e) { err = e }
  expect(err).toMatchObject({ code: 'partial-create' })
  const msg = (err as Error).message
  expect(msg).toContain('#10 https://github.com/a/b/issues/10')
  expect(msg).toContain('#11 https://github.com/a/b/issues/11')
  expect(msg).toContain('item 3 "Three"')
  expect(msg).toContain('HTTP 502')
  expect((err as { fix?: string }).fix).toContain('item 3')
})

test('issue_search passes the query to gh', async () => {
  const ctx = fakeCtx({
    files: { '/repo/.factory/config.json': JSON.stringify(defaultConfig('https://github.com/a/b', 'main', [])) },
    replies: [{ argv: ['gh', 'issue', 'list'], result: { stdout: JSON.stringify([{ number: 4, title: 'T', labels: [{ name: 'bug' }] }]) } }],
  })
  const tool = TOOLS.find(d => d.name === 'issue_search')!
  expect(await tool.handler(ctx, { query: 'login page' })).toEqual([{ number: 4, title: 'T', labels: ['bug'] }])
  expect(ctx.calls.find(c => c[1] === 'issue')).toContain('login page')
  expect(await issueSearch(fakeTracker().t, 'q')).toEqual([{ number: 3, title: 'hit q', labels: ['factory'] }])
})
