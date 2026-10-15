import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentRow, Board, Job } from '../types'

// The factory pane: the board with Approve and Rework, and every subagent of
// this session with its task, model, effort, and run time. The agents also go
// to factory/agents/<session>.json, which serve.py shows on the dashboard.

const PANE = 'factory'
const STALE_MS = 60 * 60 * 1000 // as serve.py STALE and the orchestrator
const HIDE_MS = 5 * 60 * 1000 // as serve.py AGENT_HIDE: an ended agent shows this long
const EMPTY: Board = { root: '', runner: null, heartbeat: null, jobs: [], queued: {} }

const agents = atom({ plugin: 'factory', key: 'agents' } as const, [] as AgentRow[])
const board = atom({ plugin: 'factory', key: 'board' } as const, EMPTY)
const now = atom({ plugin: 'factory', key: 'now' } as const, 0)
const reworkFor = atom({ plugin: 'factory', key: 'reworkFor' } as const, '')

const runMs = (a: AgentRow, t: number) => a.doneMs + (a.runSince ? t - a.runSince : 0)

function clock(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000))
  const pad = (n: number) => String(n).padStart(2, '0')
  return s < 3600 ? `${Math.floor(s / 60)}:${pad(s % 60)}` : `${Math.floor(s / 3600)}h${pad(Math.floor((s % 3600) / 60))}`
}

const shortModel = (m: string) => m.replace(/^claude-/, '').replace(/-\d{8}$/, '')
const shortType = (t: string) => t.replace(/^factory:/, '')

// shortcut: the mod API names no model's window; this follows the model catalog
// (2026-10: Haiku 4.5 and older 200k, the rest 1M). Wrong for a new small model.
const windowOf = (model: string) => (/claude-(3|haiku-4)/.test(model) ? 200_000 : 1_000_000)

const ctxColor = (f: number) => (f >= 0.8 ? 'red' : f >= 0.5 ? 'yellow' : 'gray')
const tokens = (n: number) => (n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}k`)

function runnerLive(b: Board) {
  if (!b.runner || !b.heartbeat) return false
  return Date.now() - Date.parse(b.heartbeat) < STALE_MS
}

// serve.py names requests %Y%m%dT%H%M%S%f-<hex>; keep the same sort order.
function requestName() {
  const iso = new Date().toISOString() // 2026-10-15T15:57:53.081Z
  const stamp = iso.replace(/[-:]/g, '').replace('.', '').replace('Z', '') + '000'
  return `${stamp}-${Math.random().toString(16).slice(2, 8)}`
}

// One session per module: register runs again on a reload, and these start over.
let root = ''
let sessionId = ''
let lastBoard = ''
let dirty = false
let ticks = 0
let wrote = false
const efforts: Record<string, string> = {}

async function pollBoard($: EngineInterface) {
  let raw: { runner?: string | null; heartbeat?: string | null; jobs?: Job[] }
  try {
    raw = JSON.parse((await $.fs.read(`${root}/factory/board.json`)) as string)
  } catch {
    return
  }
  const queued: Record<string, string> = {}
  try {
    for (const f of await $.fs.list(`${root}/factory/inbox`)) {
      if (f.kind !== 'file' || !f.name.endsWith('.json')) continue
      try {
        const q = JSON.parse((await $.fs.read(`${root}/factory/inbox/${f.name}`)) as string)
        if (typeof q.job === 'string') queued[q.job] = String(q.action)
      } catch {
        // a request being written: the next poll reads it
      }
    }
  } catch {
    // no inbox yet
  }
  const jobs = (raw.jobs ?? []).map(({ id, title, stage, note }) => ({ id, title, stage, note }))
  const next: Board = { root, runner: raw.runner ?? null, heartbeat: raw.heartbeat ?? null, jobs, queued }
  const text = JSON.stringify(next)
  if (text === lastBoard) return
  lastBoard = text
  await update($, board, () => next)
}

async function writeAgents($: EngineInterface) {
  const list = await read($, agents)
  if (!list.length && !wrote) return
  wrote = true
  const dir = `${root}/factory/agents`
  await $.process.run(['mkdir', '-p', dir])
  const body = { session: sessionId, updated: new Date().toISOString(), agents: list.slice(-40) }
  await $.fs.write(`${dir}/${sessionId}.json`, JSON.stringify(body, null, 2) + '\n')
}

async function queue(
  $: EngineInterface,
  req: { action: 'approve' | 'rework'; job: string; note?: string },
) {
  const b = await read($, board)
  const job = b.jobs.find(j => j.id === req.job)
  if (!job || job.stage !== 'needs-human' || b.queued[req.job]) {
    void $.ui.toast(`Not queued: ${req.job} is not waiting for a human, or has a request.`)
    return
  }
  const dir = `${root}/factory/inbox`
  const name = requestName()
  await $.process.run(['mkdir', '-p', dir])
  await $.fs.write(`${dir}/.${name}.tmp`, JSON.stringify({ ...req, at: new Date().toISOString().replace(/\.\d+Z$/, 'Z') }, null, 2) + '\n')
  await $.process.run(['mv', `${dir}/.${name}.tmp`, `${dir}/${name}.json`])
  await pollBoard($)
  // A live runner (Loop, Inbox) or the dashboard server with --run takes it.
  let server = false
  try {
    server = !!JSON.parse((await $.fs.read(`${dir}/server.info`)) as string).run
  } catch {
    server = false
  }
  if (runnerLive(b) || server) {
    void $.ui.toast(`Queued: ${req.action} ${req.job}`)
    return
  }
  void $.ui.toast(`Queued: ${req.action} ${req.job}. Starting /factory:inbox.`)
  void $.command.run({ command: 'factory:inbox' })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const out = await next(e)
    root = await $.session.root()
    sessionId = await $.session.id()
    const isFactory = await $.fs.exists(`${root}/factory/board.json`)
    await $.command.register({ name: 'factory-board', description: 'Show the factory board and its agents in a pane' })
    if (isFactory) {
      await pollBoard($)
      void $.ui.open({ id: PANE, title: 'Factory' })
    }
    $.clock.every(1000, () => {
      ticks++
      void (async () => {
        const list = await read($, agents)
        const t = await $.clock.now()
        if (list.some(a => a.endedAt && t - a.endedAt > HIDE_MS)) {
          await update($, agents, l => l.filter(a => !a.endedAt || t - a.endedAt <= HIDE_MS))
          dirty = true
        }
        const running = list.some(a => a.status === 'running')
        if (running) await update($, now, () => t)
        if (!isFactory) return
        if (ticks % 2 === 0) await pollBoard($)
        if (dirty || (running && ticks % 15 === 0)) {
          dirty = false
          await writeAgents($)
        }
      })()
    })
    return out
  })

  on('command.run', { command: 'factory-board' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Factory' })
    return { text: 'Factory pane opened.' }
  })

  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)
    if (r.deny !== undefined || !r.agentId) return r
    const t = await $.clock.now()
    const id = r.agentId
    await update($, agents, list => {
      const old = list.find(a => a.id === id)
      const row: AgentRow = old
        ? { ...old, model: r.model, runSince: old.runSince ?? t, endedAt: undefined, status: 'running' }
        : {
            id,
            type: e.subagentType,
            description: e.description,
            model: r.model,
            startedAt: t,
            doneMs: 0,
            runSince: t,
            status: 'running',
            ctxWindow: windowOf(r.model),
          }
      return [...list.filter(a => a.id !== id), row].slice(-100)
    })
    dirty = true
    return r
  })

  on('turn.start', async ($, e, next) => {
    const id = e.agentId
    if (id) {
      const t = await $.clock.now()
      await update($, agents, list =>
        list.map((a): AgentRow => (a.id === id && !a.runSince ? { ...a, runSince: t, endedAt: undefined, status: 'running' } : a)),
      )
      dirty = true
    }
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const id = e.agentId
    const effort = e.effort === undefined ? '' : String(e.effort)
    if (id && effort && efforts[id] !== effort) {
      efforts[id] = effort
      await update($, agents, list => list.map(a => (a.id === id ? { ...a, effort, model: e.model } : a)))
      dirty = true
    }
    const r = yield* next(e)
    const u = r.usage
    if (id && u) {
      const ctxTokens = u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
      const ctxWindow = windowOf(u.model)
      await update($, agents, list => list.map(a => (a.id === id ? { ...a, ctxTokens, ctxWindow } : a)))
      dirty = true
    }
    return r
  })

  on('turn.complete', async ($, e, next) => {
    const id = e.agentId
    if (id) {
      const t = await $.clock.now()
      await update($, agents, list =>
        list.map(
          (a): AgentRow =>
            a.id === id
              ? { ...a, doneMs: runMs(a, t), runSince: undefined, endedAt: t, status: e.isAborted ? 'aborted' : 'done' }
              : a,
        ),
      )
      dirty = true
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const b = await read($, board)
    const list = await read($, agents)
    const t = Math.max(await read($, now), await $.clock.now())
    const rework = await read($, reworkFor)
    const width = e.props.bodyColumns ?? e.viewport?.columns ?? 80
    const wide = width >= 90

    const human = b.jobs.filter(j => j.stage === 'needs-human')
    const active = b.jobs.filter(j => !['needs-human', 'merged', 'reviewed'].includes(j.stage))
    const merged = b.jobs.length - human.length - active.length

    const jobCol = (
      <Box flexDirection="column" width={wide ? '50%' : undefined} paddingRight={wide ? 2 : 0}>
        <Text bold>Jobs</Text>
        {!b.root && <Text dimColor>No factory here: run /factory:init.</Text>}
        {b.root && (
          <Text dimColor>
            {runnerLive(b) ? `runner: ${b.runner}` : 'no runner'} · {merged} merged
          </Text>
        )}
        {human.map(j => (
          <Box key={`h-${j.id}`} flexDirection="column" marginTop={1}>
            <Text color="yellow">
              ● {j.id} <Text dimColor>needs human</Text>
            </Text>
            {j.note && <Text dimColor>{j.note}</Text>}
            {b.queued[j.id] ? (
              <Text color="cyan">queued: {b.queued[j.id]}</Text>
            ) : rework === j.id && 'Input' in ui ? (
              <ui.Input
                key={`rw-${j.id}`}
                label="Note for the builder"
                submitLabel="Send"
                autoFocus
                onSubmit={note => {
                  void update($, reworkFor, () => '')
                  if (note.trim()) void queue($, { action: 'rework', job: j.id, note: note.trim() })
                }}
              />
            ) : (
              <Box flexDirection="row">
                <Button key={`ap-${j.id}`} variant="primary" onPress={() => void queue($, { action: 'approve', job: j.id })}>
                  Approve
                </Button>
                <Text> </Text>
                <Button key={`rw-${j.id}`} onPress={() => void update($, reworkFor, () => j.id)}>
                  Rework…
                </Button>
              </Box>
            )}
          </Box>
        ))}
        {active.map(j => (
          <Text key={`a-${j.id}`}>
            <Text color="blue">●</Text> {j.id} <Text dimColor>{j.stage}</Text>
          </Text>
        ))}
      </Box>
    )

    const shown = list.slice(-Math.max(3, (e.viewport?.rows ?? 30) / 2 - 2)).reverse()
    const agentCol = (
      <Box flexDirection="column" width={wide ? '50%' : undefined} marginTop={wide ? 0 : 1}>
        <Text bold>
          Agents <Text dimColor>{list.filter(a => a.status === 'running').length} running</Text>
        </Text>
        {!list.length && <Text dimColor>No subagents yet.</Text>}
        {shown.map(a => (
          <Box key={`ag-${a.id}`} flexDirection="column">
            <Text>
              <Text color={a.status === 'running' ? 'green' : a.status === 'aborted' ? 'red' : 'gray'}>
                {a.status === 'running' ? '●' : a.status === 'aborted' ? '✕' : '✓'}
              </Text>{' '}
              <Text bold={a.status === 'running'}>{shortType(a.type)}</Text> <Text dimColor>{clock(runMs(a, t))}</Text>{' '}
              <Text color="magenta">
                {shortModel(a.model)}
                {a.effort ? `·${a.effort}` : ''}
              </Text>
              {a.ctxTokens !== undefined && a.ctxWindow ? (
                <Text color={ctxColor(a.ctxTokens / a.ctxWindow)}>
                  {' '}
                  {tokens(a.ctxTokens)}/{tokens(a.ctxWindow)} {Math.round((100 * a.ctxTokens) / a.ctxWindow)}%
                </Text>
              ) : null}
            </Text>
            <Text dimColor wrap="truncate-end">
              {'  '}
              {a.description}
            </Text>
          </Box>
        ))}
      </Box>
    )

    return (
      <Box flexDirection={wide ? 'row' : 'column'}>
        {jobCol}
        {agentCol}
      </Box>
    )
  })
}
