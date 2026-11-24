import type { On, UiOpenResult } from 'claude-code'
import { expect, test } from 'claude-code/testing'
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
  const host = fakeHost(on, { files: { [STATUS]: JSON.stringify(SNAP) } })
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    expect(await textOf(ui, 'header')).toBe('Factory · o/r  2/3 slots')
    expect(await textOf(ui, 'ready')).toBe('Ready: 2')
    expect(await textOf(ui, 'running')).toBe('Running')
    expect(await textOf(ui, 'job-3')).toBe('#3 Add login  build R2  code ✓')
    expect(await textOf(ui, 'job-4')).toBe('#4 Add logout  spec')
    expect(await ui.find({ key: 'running-none' })).toBeUndefined()
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
  const host = fakeHost(on)
  for (const text of [undefined, '{not json']) {
    if (text !== undefined) host.files[STATUS] = text
    for (const surface of SURFACES) {
      const ui = await mount($, surface)
      expect(await textOf(ui, 'empty')).toBe('No snapshot yet. Run /factory:status to write it.')
      expect(await ui.find({ key: 'header' })).toBeUndefined()
      await ui.unmount()
    }
  }
})

test('the pane draws again after a new snapshot', async ($, on) => {
  fakeHost(on, { files: files({ enabled: false, number: 3 }), replies: backlogReplies() })
  const ui = await mount($, 'terminal')
  expect(await textOf(ui, 'empty')).toBe('No snapshot yet. Run /factory:status to write it.')
  await $.tool.run({ tool: 'mcp__factory__status' } as never)
  expect(await textOf(ui, 'header')).toBe('Factory · o/r  1/2 slots')
  expect(await textOf(ui, 'job-3')).toBe('#3 t3  build R2  code ✓')
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
