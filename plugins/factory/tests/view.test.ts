import { expect, test } from 'claude-code/testing'
import { invoke, makeCtx, SNAPSHOT_TOOLS, TOOLS, type ToolDef } from '../hooks/tools.ts'
import type { Queue } from '../lib/queue.ts'
import { commandOf } from '../lib/status.ts'
import { buildSnapshot, statusLine, type Snapshot } from '../lib/view.ts'
import { backlogReplies, files, OPEN, raw } from './support/backlog.ts'
import { fakeCtx, fakeHost, type Reply } from './support/host.ts'

const Q = (o: Partial<Queue> = {}): Queue => ({ running: [], waiting: [], ready: [], blocked: [], conflicts: [], heldBy: [], slots: 0, next: [], ...o })
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
      { number: 42, title: 'Add CSV', state: 'approved', next: 'approved: /factory:merge 42', link: 'https://github.com/o/r/pull/50', command: '/factory:merge 42' },
      { number: 43, title: 'Add PDF', state: 'needs-human', next: 'needs you: gate failed · fix the cause. Then run /factory:run 43', link: 'https://github.com/o/r/issues/43', command: '/factory:run 43' },
      { number: 44, title: 'Add XML', state: 'needs-info', next: 'needs info: author answers in the issue', link: 'https://github.com/o/r/issues/44', command: null },
      { number: 5, title: 'Fix it', state: 'conflict', next: 'conflict: remove all status labels but one. Then run /factory:run 5', link: 'https://github.com/o/r/issues/5', command: '/factory:run 5' },
    ],
  })
})

test('commandOf gives the command of each waiting state', () => {
  expect(commandOf(42, 'approved', false, [])).toBe('/factory:merge 42')
  expect(commandOf(42, 'approved', true, [])).toBeNull()
  expect(commandOf(43, 'needs-human', false, [])).toBe('/factory:run 43')
  expect(commandOf(43, 'needs-human', false, [43])).toBe('/factory:run')
  expect(commandOf(5, 'conflict', false, [])).toBe('/factory:run 5')
  for (const state of ['needs-info', 'needs-design', 'build']) expect(commandOf(44, state, false, [])).toBeNull()
})

const stub = (name: string): ToolDef => ({ name, description: 'd', inputSchema: {}, handler: async () => ({ ok: true }) })
const EXPECTED_SNAPSHOT = {
  repo: 'o/r',
  time: '2026-01-01T00:00:00.000Z',
  slots: { used: 1, total: 2 },
  ready: 1,
  running: [{ number: 3, title: 't3', state: 'build', round: 2, reviewsDone: ['code'] }],
  waiting: [{ number: 42, title: 't42', state: 'approved', next: 'approved: /factory:merge 42', link: 'https://github.com/o/r/pull/50', command: '/factory:merge 42' }],
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

const snap = (o: Partial<Snapshot>): Snapshot => ({ repo: 'o/r', time: 't', slots: { used: 0, total: 3 }, ready: 0, running: [], waiting: [], ...o })
const run = (number: number, state: string, round: number | null) => ({ number, title: `t${number}`, state, round, reviewsDone: [] })
const wait = (number: number, state: string) => ({ number, title: `t${number}`, state, next: 'n', link: 'l', command: null })

test('statusLine shows the slots, the running jobs and the waiting count', () => {
  const running = [run(42, 'review', 2), run(45, 'build', 1)]
  const slots = { used: 2, total: 3 }
  expect(statusLine(snap({ slots, running, waiting: [wait(7, 'approved')] }))).toBe('Factory 2/3 slots · #42 review R2 · #45 build R1 · 1 waits for you')
  expect(statusLine(snap({ slots, running, waiting: [wait(7, 'approved'), wait(5, 'conflict')] }))).toBe('Factory 2/3 slots · #42 review R2 · #45 build R1 · 2 wait for you')
})

test('statusLine leaves out a missing round and an empty waiting part', () => {
  expect(statusLine(snap({ slots: { used: 1, total: 3 }, running: [run(4, 'spec', null)] }))).toBe('Factory 1/3 slots · #4 spec')
  expect(statusLine(snap({ waiting: [wait(7, 'approved'), wait(8, 'needs-human')] }))).toBe('Factory 0/3 slots · 2 wait for you')
})

test('statusLine is undefined when nothing runs and nothing waits', () => {
  expect(statusLine(snap({ ready: 4 }))).toBeUndefined()
})

const LINE = 'Factory 1/2 slots · #3 build R2 · 1 waits for you'

// The engine loads its own copy of TOOLS, so it runs the real tools. These two need no issue input.
const ENGINE_TOOLS = ['status', 'cleanup']

// any: the test kit types $ and on per event, and this helper passes them on.
async function statusLines($: any, on: any, open: Partial<Reply['result']> | undefined, surfaces: readonly string[]) {
  const lines: Record<string, (string | undefined)[]> = {}
  let key = ''
  on('ui.status', async (_$: unknown, e: { text: string | undefined }) => {
    ;(lines[key] ??= []).push(e.text)
    return { value: undefined }
  })
  fakeHost(on, { files: files({ enabled: false, number: 3 }), replies: [...backlogReplies(open), { argv: ['gh', 'api', '-X', 'GET', 'search/issues'] }] })
  for (const surface of surfaces) {
    await $.session.start({ cwd: '/repo', surface, isInteractive: false })
    for (const name of ENGINE_TOOLS) {
      key = `${surface} ${name}`
      expect('isError' in (await $.tool.run({ tool: `mcp__factory__${name}`, tool_use_id: 'u' }))).toBe(false)
    }
  }
  return lines
}
const each = (surfaces: string[], line: string | undefined) => Object.fromEntries(surfaces.flatMap(s => ENGINE_TOOLS.map(n => [`${s} ${n}`, [line]])))

// Each listed tool, through invoke with a recording ctx.status.
async function listedLines(open?: Partial<Reply['result']>) {
  const lines: Record<string, (string | undefined)[]> = {}
  for (const name of SNAPSHOT_TOOLS) {
    const ctx = fakeCtx({ files: files(), replies: backlogReplies(open) })
    ctx.status = text => void (lines[name] ??= []).push(text)
    await invoke(stub(name), ctx, {})
  }
  return lines
}

test('the tools set the status line on the terminal and the desktop surface', async ($, on) => {
  const surfaces = ['terminal', 'desktop']
  expect(await statusLines($, on, undefined, surfaces)).toEqual(each(surfaces, LINE))
  expect(await listedLines()).toEqual(Object.fromEntries(SNAPSHOT_TOOLS.map(n => [n, [LINE]])))
})

test('the tools clear the status line when the factory is idle', async ($, on) => {
  const idle = { stdout: raw(6, []) }
  expect(await statusLines($, on, idle, ['terminal'])).toEqual(each(['terminal'], undefined))
  expect(await listedLines(idle)).toEqual(Object.fromEntries(SNAPSHOT_TOOLS.map(n => [n, [undefined]])))
})

test('a rejected status line call does not reject', async () => {
  const ctx = await makeCtx({ session: { root: async () => '/repo' }, ui: { status: () => Promise.reject(new Error('no surface')) } })
  expect(await ctx.status?.('x')).toBeUndefined()
})

test('a status line call that returns void still sets the line', async () => {
  const lines: (string | undefined)[] = []
  const ctx = await makeCtx({ session: { root: async () => '/repo' }, ui: { status: (text: string | undefined) => void lines.push(text) } })
  ctx.status?.('x')
  expect(lines).toEqual(['x'])
})

test('a failed status line leaves the tool result unchanged', async () => {
  const status = TOOLS.find(t => t.name === 'status')!
  const want = await invoke(status, fakeCtx({ files: files({ enabled: false, number: 3 }), replies: backlogReplies() }), {})
  for (const [def, expected] of [[stub('merge'), { result: JSON.stringify({ ok: true }, null, 2) }], [status, want]] as const) {
    const ctx = fakeCtx({ files: files({ enabled: false, number: 3 }), replies: backlogReplies() })
    let called = 0
    ctx.status = () => {
      called++
      throw new Error('no surface')
    }
    expect(await invoke(def, ctx, {})).toEqual(expected)
    expect(called).toBe(1)
    const written = ctx.files['/repo/.factory/status.json']
    expect(written === undefined ? undefined : JSON.parse(written)).toEqual(EXPECTED_SNAPSHOT)
  }
})
