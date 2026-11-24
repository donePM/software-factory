import type { On, UiOpenResult } from 'claude-code'
import { expect, test, type FoundElement } from 'claude-code/testing'
import { configPath } from '../lib/config.ts'
import { backlogReplies, files } from './support/backlog.ts'
import { fakeHost } from './support/host.ts'

const STATUS = '/repo/.factory/status.json'
const SNAP = {
  repo: 'o/r',
  time: '2026-02-03T04:05:06.000Z',
  slots: { used: 2, total: 3 },
  ready: 2,
  running: [
    { number: 3, title: 'Add login', state: 'build', round: 2, reviewsDone: ['code'] },
    { number: 4, title: 'Add logout', state: 'spec', round: null, reviewsDone: [] },
  ],
  waiting: [],
}
const CONFIG = { [configPath('/repo')]: '{}' }
const SURFACES = ['terminal', 'desktop'] as const
const PROPS = { title: 'Factory', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} } as const
const mount = ($: any, surface: (typeof SURFACES)[number]) => $.ui.mount({ plugin: 'factory', surface, component: 'Pane', requestId: 'factory', props: PROPS })
const textOf = async (ui: any, key: string): Promise<string | undefined> => (await ui.find({ key }))?.text

// Records the pane opens, the status lines and the registered commands.
function uiHost(on: On, placed: UiOpenResult = { isPlaced: true }) {
  const opens: unknown[] = []
  const statuses: (string | undefined)[] = []
  const commands: string[] = []
  on('ui.open', async (_$, e) => {
    opens.push(e)
    return { value: placed } as never
  })
  on('ui.status', async (_$, e) => {
    statuses.push(e.text)
    return { value: undefined } as never
  })
  on('command.register', async (_$, e) => {
    commands.push(e.name)
    return { value: undefined } as never
  })
  return { opens, statuses, commands }
}

const start = ($: any) => $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

test('the pane draws the snapshot on terminal and desktop', async ($, on) => {
  const host = fakeHost(on, { files: { ...CONFIG, [STATUS]: JSON.stringify(SNAP) } })
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    expect(await textOf(ui, 'header')).toBe('Factory · o/r  2/3 slots')
    expect(await textOf(ui, 'ready')).toBe('Ready: 2')
    expect(await textOf(ui, 'running')).toBe('Running')
    expect(await textOf(ui, 'job-3')).toBe('#3 Add login  build R2  code ✓')
    expect(await textOf(ui, 'job-4')).toBe('#4 Add logout  spec')
    expect(await ui.find({ key: 'running-none' })).toBeUndefined()
    expect(await ui.find({ type: 'Button' })).toBeUndefined()
    await ui.unmount()
  }
  host.files[STATUS] = JSON.stringify({ ...SNAP, slots: { used: 0, total: 3 }, running: [] })
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    expect(await textOf(ui, 'header')).toBe('Factory · o/r  0/3 slots')
    expect(await textOf(ui, 'running-none')).toBe('No running jobs')
    await ui.unmount()
  }
})

test('the pane says how to write a snapshot when status.json is missing', async ($, on) => {
  const host = fakeHost(on, { files: CONFIG })
  for (const text of [undefined, '{not json']) {
    if (text !== undefined) host.files[STATUS] = text
    for (const surface of SURFACES) {
      const ui = await mount($, surface)
      expect(await textOf(ui, 'empty')).toBe('No snapshot yet. Run /factory:status to write it.')
      expect(await ui.find({ key: 'header' })).toBeUndefined()
      expect(await ui.find({ type: 'Button' })).toBeUndefined()
      await ui.unmount()
    }
  }
})

const waiting = (number: number, state: string, next: string, command: string | null) => ({ number, title: `t${number}`, state, next, link: `https://github.com/o/r/issues/${number}`, command })
const IDLE = { ...SNAP, slots: { used: 0, total: 3 }, ready: 0, running: [] }

test('a waiting job fills the pane with its next step', async ($, on) => {
  const host = fakeHost(on, { files: CONFIG })
  const cases = [
    waiting(42, 'approved', 'approved: /factory:merge 42', '/factory:merge 42'),
    waiting(43, 'needs-human', 'needs you: answer in the issue. Then run /factory:run 43', '/factory:run 43'),
    waiting(5, 'conflict', 'conflict: remove all status labels but one. Then run /factory:run 5', '/factory:run 5'),
    waiting(44, 'needs-info', 'needs info: author answers in the issue', null),
  ]
  for (const w of cases) {
    host.files[STATUS] = JSON.stringify({ ...SNAP, waiting: [w] })
    for (const surface of SURFACES) {
      const ui = await mount($, surface)
      expect(await textOf(ui, 'header')).toBe('Factory · o/r  2/3 slots')
      expect((await ui.find({ type: 'Text', text: `#${w.number} t${w.number} · waits for you` }))?.props.bold).toBe(true)
      expect(await textOf(ui, 'wait-head')).toBe(`#${w.number} t${w.number} · waits for you`)
      expect(await textOf(ui, 'wait-next')).toBe(w.next)
      expect((await ui.find({ type: 'Link' }))?.props.href).toBe(w.link)
      expect(await ui.find({ key: 'ready' })).toBeUndefined()
      expect(await ui.find({ key: 'running' })).toBeUndefined()
      expect((await ui.find({ type: 'Button' }))?.props.label).toBe(w.command ?? undefined)
      await ui.unmount()
    }
  }
  // An old status.json has no command field.
  const { command: _c, ...old } = cases[0]!
  host.files[STATUS] = JSON.stringify({ ...SNAP, waiting: [old] })
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    expect(await textOf(ui, 'wait-next')).toBe('approved: /factory:merge 42')
    expect(await ui.find({ type: 'Button' })).toBeUndefined()
    await ui.unmount()
  }
})

test('the lowest waiting number fills the pane, the others get one line', async ($, on) => {
  const rows = [
    waiting(43, 'needs-human', 'needs you: answer in the issue. Then run /factory:run 43', '/factory:run 43'),
    waiting(44, 'needs-info', 'needs info: author answers in the issue', null),
    waiting(42, 'approved', 'approved: /factory:merge 42', '/factory:merge 42'),
    waiting(5, 'conflict', 'conflict: remove all status labels but one. Then run /factory:run 5', '/factory:run 5'),
  ]
  fakeHost(on, { files: { ...CONFIG, [STATUS]: JSON.stringify({ ...SNAP, waiting: rows }) } })
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    expect(await textOf(ui, 'wait-head')).toBe('#5 t5 · waits for you')
    expect((await ui.find({ type: 'Button' }))?.props.label).toBe('/factory:run 5')
    const more = (await ui.findAll({ type: 'Box' })).filter((b: FoundElement) => b.key?.startsWith('wait-more-'))
    expect(more.map((b: FoundElement) => [b.key, b.text])).toEqual([
      ['wait-more-42', '#42 /factory:merge 42'],
      ['wait-more-43', '#43 /factory:run 43'],
      ['wait-more-44', '#44 needs info: author answers in the issue'],
    ])
    await ui.unmount()
  }
})

test('a press on the button copies the command', async ($, on) => {
  const copies: unknown[] = []
  on('ui.copy', async (_$, e) => {
    copies.push({ text: e.text, surface: e.surface })
    return { value: { isCopied: true } } as never
  })
  fakeHost(on, { files: { ...CONFIG, [STATUS]: JSON.stringify({ ...SNAP, waiting: [waiting(42, 'approved', 'approved: /factory:merge 42', '/factory:merge 42')] }) } })
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    await ui.press({ key: 'copy' })
    await ui.unmount()
  }
  expect(copies).toEqual([
    { text: '/factory:merge 42', surface: 'terminal' },
    { text: '/factory:merge 42', surface: 'desktop' },
  ])
})

test('the pane offers /factory:run for a ready backlog and /factory:add when idle', async ($, on) => {
  const copies: string[] = []
  on('ui.copy', async (_$, e) => {
    copies.push(e.text)
    return { value: { isCopied: true } } as never
  })
  const host = fakeHost(on, { files: { ...CONFIG, [STATUS]: JSON.stringify({ ...IDLE, ready: 2 }) } })
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    expect(await textOf(ui, 'ready')).toBe('Ready: 2')
    expect(await textOf(ui, 'running-none')).toBe('No running jobs')
    expect(await ui.find({ key: 'idle' })).toBeUndefined()
    expect((await ui.find({ type: 'Button' }))?.props.label).toBe('/factory:run')
    await ui.press({ key: 'copy' })
    await ui.unmount()
  }
  host.files[STATUS] = JSON.stringify(IDLE)
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    expect(await textOf(ui, 'running-none')).toBe('No running jobs')
    expect(await textOf(ui, 'idle')).toBe('Nothing to do.')
    expect((await ui.find({ type: 'Button' }))?.props.label).toBe('/factory:add <text>')
    await ui.press({ key: 'copy' })
    await ui.unmount()
  }
  expect(copies).toEqual(['/factory:run', '/factory:run', '/factory:add ', '/factory:add '])
  host.files[STATUS] = JSON.stringify({ ...SNAP, ready: 0 })
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    expect(await ui.find({ type: 'Button' })).toBeUndefined()
    await ui.unmount()
  }
})

test('the pane offers /factory:setup when config.json is missing', async ($, on) => {
  const copies: string[] = []
  on('ui.copy', async (_$, e) => {
    copies.push(e.text)
    return { value: { isCopied: true } } as never
  })
  const host = fakeHost(on)
  for (const text of [undefined, JSON.stringify({ ...SNAP, waiting: [waiting(42, 'approved', 'approved: /factory:merge 42', '/factory:merge 42')] })]) {
    if (text !== undefined) host.files[STATUS] = text
    for (const surface of SURFACES) {
      const ui = await mount($, surface)
      expect(await textOf(ui, 'setup')).toBe('Setup is not complete. Run /factory:setup.')
      expect(await ui.find({ key: 'empty' })).toBeUndefined()
      expect(await ui.find({ key: 'header' })).toBeUndefined()
      expect(await ui.find({ key: 'wait-head' })).toBeUndefined()
      expect((await ui.findAll({ type: 'Button' })).map((b: FoundElement) => b.props.label)).toEqual(['/factory:setup'])
      await ui.press({ key: 'copy' })
      await ui.unmount()
    }
  }
  expect(copies).toEqual(['/factory:setup', '/factory:setup', '/factory:setup', '/factory:setup'])
})

test('the pane draws again after a new snapshot', async ($, on) => {
  fakeHost(on, { files: files({ enabled: false, number: 3 }), replies: backlogReplies() })
  const ui = await mount($, 'terminal')
  expect(await textOf(ui, 'empty')).toBe('No snapshot yet. Run /factory:status to write it.')
  await $.tool.run({ tool: 'mcp__factory__status' } as never)
  expect(await textOf(ui, 'header')).toBe('Factory · o/r  1/2 slots')
  expect(await textOf(ui, 'wait-head')).toBe('#42 t42 · waits for you')
  await ui.unmount()
})

test('factory-pane opens the pane with the repo in the title', async ($, on) => {
  const host = fakeHost(on, { files: { [STATUS]: JSON.stringify(SNAP) } })
  const { opens, commands } = uiHost(on)
  await start($)
  expect(commands).toEqual(['factory-pane'])
  opens.length = 0
  expect(await $.command.run({ command: 'factory-pane', args: '' } as never)).toEqual({})
  delete host.files[STATUS]
  await $.command.run({ command: 'factory-pane', args: '' } as never)
  expect(opens).toEqual([{ id: 'factory', title: 'Factory · o/r' }, { id: 'factory', title: 'Factory' }])
})

test('factory-pane returns the reason when the pane is not placed', async ($, on) => {
  fakeHost(on)
  uiHost(on, { isPlaced: false, reason: 'the terminal is 80 columns, the pane needs 110' })
  expect(await $.command.run({ command: 'factory-pane', args: '' } as never)).toEqual({ text: 'the terminal is 80 columns, the pane needs 110' })
})

test('an unplaced pane shows the command to open it', async ($, on) => {
  fakeHost(on, { files: { [STATUS]: JSON.stringify(SNAP) } })
  const { opens, statuses } = uiHost(on, { isPlaced: false, reason: 'narrow' })
  await start($)
  expect(opens).toEqual([{ id: 'factory', title: 'Factory · o/r' }])
  expect(statuses).toEqual(['Factory pane: run /factory-pane to open it.'])
  const ui = await mount($, 'terminal')
  expect(statuses).toEqual(['Factory pane: run /factory-pane to open it.', undefined])
  await ui.unmount()
})

test('a placed pane pins no status line, and no snapshot opens no pane', async ($, on) => {
  const host = fakeHost(on, { files: { [STATUS]: JSON.stringify(SNAP) } })
  const placed = uiHost(on)
  await start($)
  expect(placed.opens).toHaveLength(1)
  expect(placed.statuses).toEqual([])
  delete host.files[STATUS]
  placed.opens.length = 0
  await start($)
  expect(placed.opens).toEqual([])
})
