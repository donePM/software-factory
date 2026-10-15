import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const ROOT = '/repo'
const BOARD = {
  runner: null,
  heartbeat: null,
  jobs: [
    { id: 'login-form', title: 'Login form', stage: 'needs-human', note: 'approver escalated' },
    { id: 'api-auth', title: 'API auth', stage: 'building' },
  ],
}

function fake(on: On) {
  const files: Record<string, string> = { [`${ROOT}/factory/board.json`]: JSON.stringify(BOARD) }
  const runs: string[][] = []
  mock.clock(on)
  const commands: string[] = []
  on('session.root', async () => ({ value: ROOT }))
  on('session.id', async () => ({ value: 'sess-1' }))
  on('fs.exists', async ($, e) => ({ value: e.path in files }))
  on('fs.read', async ($, e) => {
    const text = files[e.path]
    return text === undefined ? { deny: `ENOENT ${e.path}` } : { value: text }
  })
  on('fs.write', async ($, e) => {
    files[e.path] = e.text
    return { value: undefined }
  })
  on('fs.list', async ($, e) => ({
    value: Object.keys(files)
      .filter(p => p.startsWith(`${e.path}/`) && !p.slice(e.path.length + 1).includes('/'))
      .map(p => ({ name: p.slice(e.path.length + 1), kind: 'file' as const, size: files[p]!.length, mtimeMs: 0, isLink: false })),
  }))
  on('process.run', async ($, e) => {
    runs.push([...e.argv])
    if (e.argv[0] === 'mv') {
      files[e.argv[2]!] = files[e.argv[1]!]!
      delete files[e.argv[1]!]
    }
    return { value: { exitCode: 0, stdout: '', stderr: '' } } as never
  })
  on('command.register', async () => ({ value: undefined }) as never)
  on('ui.open', async () => ({ value: { isPlaced: true } }) as never)
  on('ui.toast', async () => ({ value: undefined }) as never)
  on('command.run', async ($, e) => {
    commands.push(e.command)
    return { text: '' } as never
  })
  on('session.start', async ($, e) => ({ cwd: e.cwd }))
  on('agent.spawn', async () => ({ agentId: 'a1', model: 'claude-sonnet-5-5' }) as never)

  return { files, runs, commands }
}

test('agents show with task, model, effort, and run time; approve queues a request', async ($, on) => {
  const { files, commands } = fake(on)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await $.agent.spawn({ subagentType: 'factory:builder', description: 'Build login-form', prompt: 'p' } as never)

  const ui = await $.ui.mount({
    plugin: 'factory',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'factory',
    props: { bodyColumns: 120 },
    viewport: { columns: 120, rows: 30 },
  } as never)
  expect(await ui.find({ type: 'Text', text: /builder/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /sonnet-5-5/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Build login-form/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /1 running/ })).toBeDefined()

  await ui.press({ key: 'ap-login-form' })
  const reqs = Object.keys(files).filter(p => /\/factory\/inbox\/\d{8}T\d{12}\d*-[0-9a-f]+\.json$/.test(p))
  expect(reqs.length).toBe(1)
  const req = JSON.parse(files[reqs[0]!]!)
  expect(req.action).toBe('approve')
  expect(req.job).toBe('login-form')
  expect(commands).toEqual(['factory:inbox'])
  await ui.unmount()
})

test('rework takes a note, a finished agent shows done, and the pane draws on desktop', async ($, on) => {
  const { files } = fake(on)
  on('turn.complete', async () => ({ text: '' }) as never)
  await $.session.start({ cwd: ROOT, surface: 'desktop', isInteractive: true })
  await $.agent.spawn({ subagentType: 'factory:code-reviewer', description: 'Review login-form', prompt: 'p' } as never)
  await $.turn.complete({ agentId: 'a1', isAborted: false, answer: 'done', durationMs: 5000, turnId: 't1', reason: 'answer' } as never)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'factory', surface, component: 'Pane', requestId: 'factory', props: { bodyColumns: 60 } } as never)
    expect(await ui.find({ type: 'Text', text: /0 running/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /code-reviewer/ })).toBeDefined()
    await ui.unmount()
  }
  const ui = await $.ui.mount({ plugin: 'factory', surface: 'terminal', component: 'Pane', requestId: 'factory', props: { bodyColumns: 60 } } as never)
  await ui.press({ key: 'rw-login-form' })
  await $.ui.input({ plugin: 'factory', key: 'rw-login-form', text: 'Use the shared form component.' })
  const reqs = Object.keys(files).filter(p => p.includes('/factory/inbox/') && p.endsWith('.json'))
  expect(reqs.length).toBe(1)
  expect(JSON.parse(files[reqs[0]!]!)).toMatchObject({ action: 'rework', job: 'login-form', note: 'Use the shared form component.' })
  await ui.unmount()
})
