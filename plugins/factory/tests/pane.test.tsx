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
  const clock = mock.clock(on)
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

  return { files, runs, commands, clock }
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

test('an agent shows its context fill, and hides 5 minutes after it ends', async ($, on) => {
  const { files, clock } = fake(on)
  await clock.set(1_800_000_000_000)
  on('turn.complete', async () => ({ text: '' }) as never)
  on('turn.step', async function* (_$, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn',
      usage: { model: 'claude-sonnet-5-5', input_tokens: 2000, output_tokens: 500, cache_read_input_tokens: 38000, cache_creation_input_tokens: 2000 },
    } as never
  })
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await $.agent.spawn({ subagentType: 'factory:builder', description: 'Build login-form', prompt: 'p' } as never)
  const step = $.turn.step({ turnId: 't1', index: 0, model: 'claude-sonnet-5-5', effort: 'high', messageCount: 1, agentId: 'a1' })
  for await (const _ of step);
  await step.result

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'factory', surface, component: 'Pane', requestId: 'factory', props: { bodyColumns: 120 } } as never)
    expect(await ui.find({ type: 'Text', text: /42k\/1M 4%/ })).toBeDefined()
    await ui.unmount()
  }

  await $.turn.complete({ agentId: 'a1', isAborted: false, answer: 'done', durationMs: 5000, turnId: 't1', reason: 'answer' } as never)
  await clock.advance(2000)
  const written = () => JSON.parse(files[`${ROOT}/factory/agents/sess-1.json`]!).agents
  expect(written()[0]).toMatchObject({ status: 'done', ctxTokens: 42000, ctxWindow: 1_000_000, endedAt: 1_800_000_000_000 })

  await clock.advance(5 * 60 * 1000)
  expect(written()).toEqual([])
  const ui = await $.ui.mount({ plugin: 'factory', surface: 'terminal', component: 'Pane', requestId: 'factory', props: { bodyColumns: 120 } } as never)
  expect(await ui.find({ type: 'Text', text: /No agents yet/ })).toBeDefined()
  await ui.unmount()
})

test('a headless session shows its own loop with the last tool call', async ($, on) => {
  const { files, clock } = fake(on)
  await clock.set(1_800_000_000_000)
  on('turn.start', async ($, e) => ({ turnId: e.turnId }))
  on('tool.call', async () => ({ result: '', text: '' }) as never)
  on('turn.step', async function* (_$, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'tool_use',
      usage: { model: 'claude-opus-5-5', input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 150000, cache_creation_input_tokens: 0 },
    } as never
  })
  await $.session.start({ cwd: ROOT, surface: null, isInteractive: false } as never)
  await $.turn.start({ text: '/factory:inbox', turnId: 'm1' })
  const step = $.turn.step({ turnId: 'm1', index: 0, model: 'claude-opus-5-5', messageCount: 1 })
  for await (const _ of step);
  await $.tool.call({ tool: 'Bash', tool_use_id: 'u1', command: 'git merge --no-ff factory/034', description: 'Merge job 034' } as never)
  await clock.advance(1000)
  const row = JSON.parse(files[`${ROOT}/factory/agents/sess-1.json`]!).agents[0]
  expect(row).toMatchObject({
    id: 'main',
    type: 'headless',
    description: '/factory:inbox',
    model: 'claude-opus-5-5',
    status: 'running',
    ctxTokens: 150010,
    activity: 'Bash: Merge job 034',
  })
})
