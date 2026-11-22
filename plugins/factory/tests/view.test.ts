import { expect, test } from 'claude-code/testing'
import { invoke, TOOLS, type ToolDef } from '../hooks/tools.ts'
import type { Queue } from '../lib/queue.ts'
import { buildSnapshot } from '../lib/view.ts'
import { backlogReplies, files, OPEN } from './support/backlog.ts'
import { fakeCtx } from './support/host.ts'

const Q = (o: Partial<Queue> = {}): Queue => ({ running: [], waiting: [], ready: [], blocked: [], conflicts: [], slots: 0, next: [], ...o })
const item = (number: number) => ({ number, title: `t${number}`, priority: 'medium', createdAt: '2026-01-01T00:00:00Z' })

test('buildSnapshot holds repo, slots, running, waiting, ready and time', () => {
  const q = Q({
    running: [{ number: 3, state: 'build' }, { number: 4, state: 'spec' }],
    waiting: [{ number: 42, state: 'approved' }, { number: 43, state: 'needs-human' }, { number: 44, state: 'needs-info' }],
    ready: [item(6), item(7)],
    conflicts: [5],
  })
  const data = {
    q,
    prs: { 42: 50 },
    titles: { 3: 'Add login', 4: 'Add logout', 5: 'Fix it', 42: 'Add CSV', 43: 'Add PDF', 44: 'Add XML' },
    causes: { 43: { reason: 'gate failed', merge: false } },
    drift: [],
    closed: [],
  }
  const jobs = { 3: { round: 2, reviewsDone: ['code' as const] }, 4: { round: null, reviewsDone: [] } }
  const snap = buildSnapshot('o/r', { concurrency: 3, merge: { auto: false } }, data, jobs, new Date('2026-02-03T04:05:06Z'))
  expect(snap).toEqual({
    repo: 'o/r',
    time: '2026-02-03T04:05:06.000Z',
    slots: { used: 2, total: 3 },
    ready: 2,
    running: [
      { number: 3, title: 'Add login', state: 'build', round: 2, reviewsDone: ['code'] },
      { number: 4, title: 'Add logout', state: 'spec', round: null, reviewsDone: [] },
    ],
    waiting: [
      { number: 42, title: 'Add CSV', state: 'approved', next: 'approved: /factory:merge 42', link: 'https://github.com/o/r/pull/50' },
      { number: 43, title: 'Add PDF', state: 'needs-human', next: 'needs you: gate failed · fix the cause. Then run /factory:run 43', link: 'https://github.com/o/r/issues/43' },
      { number: 44, title: 'Add XML', state: 'needs-info', next: 'needs info: author answers in the issue', link: 'https://github.com/o/r/issues/44' },
      { number: 5, title: 'Fix it', state: 'conflict', next: 'conflict: remove all status labels but one. Then run /factory:run 5', link: 'https://github.com/o/r/issues/5' },
    ],
  })
})

const stub = (name: string): ToolDef => ({ name, description: 'd', inputSchema: {}, handler: async () => ({ ok: true }) })
const EXPECTED_SNAPSHOT = {
  repo: 'o/r',
  time: '2026-01-01T00:00:00.000Z',
  slots: { used: 1, total: 2 },
  ready: 1,
  running: [{ number: 3, title: 't3', state: 'build', round: 2, reviewsDone: ['code'] }],
  waiting: [{ number: 42, title: 't42', state: 'approved', next: 'approved: /factory:merge 42', link: 'https://github.com/o/r/pull/50' }],
}

test('each listed tool writes status.json', async () => {
  for (const name of ['job_create', 'job_advance', 'job_sync', 'merge', 'cleanup']) {
    const ctx = fakeCtx({ files: files(), replies: backlogReplies() })
    const out = await invoke(stub(name), ctx, {})
    expect(out).toEqual({ result: JSON.stringify({ ok: true }, null, 2) })
    const written = ctx.files['/repo/.factory/status.json']
    expect(written === undefined ? undefined : JSON.parse(written)).toEqual(EXPECTED_SNAPSHOT)
    expect(ctx.calls.filter(c => c[0] === 'gh' && c[1] === 'project')).toEqual([])
  }
  const other = fakeCtx({ files: files(), replies: backlogReplies() })
  await invoke(stub('queue'), other, {})
  expect('/repo/.factory/status.json' in other.files).toBe(false)
})

test('status writes the snapshot from its one backlog read', async () => {
  const status = TOOLS.find(t => t.name === 'status')!
  const ctx = fakeCtx({ files: files({ enabled: false, number: 3 }), replies: backlogReplies() })
  const out = await invoke(status, ctx, {})
  expect('isError' in out).toBe(false)
  expect(out.result).toContain('#42 t42  approved: /factory:merge 42 (https://github.com/o/r/pull/50)')
  const written = ctx.files['/repo/.factory/status.json']
  expect(written === undefined ? undefined : JSON.parse(written)).toEqual(EXPECTED_SNAPSHOT)
  expect(ctx.calls.filter(c => c[0] === 'gh' && c[2] === OPEN)).toHaveLength(1)
})

test('a failed snapshot leaves the tool result unchanged', async () => {
  // The backlog read fails.
  const failed = fakeCtx({ files: files(), replies: backlogReplies({ exitCode: 1, stderr: 'HTTP 502' }) })
  expect(await invoke(stub('job_create'), failed, {})).toEqual({ result: JSON.stringify({ ok: true }, null, 2) })
  expect(failed.calls.some(c => c[2] === OPEN)).toBe(true)
  // The write throws, for a listed tool and for status.
  const status = TOOLS.find(t => t.name === 'status')!
  const want = await invoke(status, fakeCtx({ files: files({ enabled: false, number: 3 }), replies: backlogReplies() }), {})
  for (const [def, expected] of [[stub('merge'), { result: JSON.stringify({ ok: true }, null, 2) }], [status, want]] as const) {
    const ctx = fakeCtx({ files: files({ enabled: false, number: 3 }), replies: backlogReplies() })
    const tried: string[] = []
    ctx.fs.write = async p => {
      tried.push(p)
      throw new Error('disk full')
    }
    expect(await invoke(def, ctx, {})).toEqual(expected)
    expect(tried).toEqual(['/repo/.factory/status.json'])
  }
})
