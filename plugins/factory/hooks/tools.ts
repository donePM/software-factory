import type { Register } from 'claude-code'
import { FactoryError } from '../lib/exec.ts'
import { issueCreate, issueSearch } from '../lib/add.ts'
import { cleanupJob, sweep } from '../lib/cleanup.ts'
import { loadConfig, migrate } from '../lib/config.ts'
import { doctor } from '../lib/doctor.ts'
import { runGate } from '../lib/gate.ts'
import { gateJob } from '../lib/gatejob.ts'
import { jobAdvance, jobCreate, jobSync } from '../lib/job.ts'
import { STATUS, stateOf } from '../lib/labels.ts'
import { githubTracker, repoFromUrl } from '../lib/github.ts'
import { approve, merge } from '../lib/merge.ts'
import { withBoard } from '../lib/project.ts'
import { guardBash, guardMain } from '../lib/guard.ts'
import { queue } from '../lib/queue.ts'
import { setup } from '../lib/setup.ts'
import { statusFor } from '../lib/status.ts'
import type { Tracker } from '../lib/tracker.ts'
import type { Ctx, State } from '../lib/types.ts'

export type ToolDef = {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  // any: the engine checks the input against inputSchema before the handler runs.
  handler: (ctx: Ctx, input: any) => Promise<unknown>
}

function issueOf(input: { issue?: unknown }): number {
  const n = input.issue
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) {
    throw new FactoryError('bad-input', `issue must be a positive integer, got ${JSON.stringify(n)}`)
  }
  return n
}

// Runs a tool with a tracker that also updates the project board. Board problems come back as warnings.
async function boarded(ctx: Ctx, run: (t: Tracker) => Promise<unknown>): Promise<unknown> {
  const cfg = await loadConfig(ctx)
  const { tracker, warnings } = withBoard(ctx, githubTracker(ctx, repoFromUrl(cfg.tracker.url)), cfg)
  const out = await run(tracker)
  return warnings.length === 0 ? out : { ...(out as object), warnings }
}

const numberTool = (name: string, description: string, run: (ctx: Ctx, t: Tracker, n: number) => Promise<unknown>): ToolDef => ({
  name,
  description,
  inputSchema: { type: 'object', properties: { number: { type: 'integer', minimum: 1 } }, required: ['number'], additionalProperties: false },
  handler: async (ctx, input) => {
    const n = input.number
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) {
      throw new FactoryError('bad-input', `number must be a positive integer, got ${JSON.stringify(n)}`)
    }
    return boarded(ctx, t => run(ctx, t, n))
  },
})

const issueTool = (name: string, description: string, run: (ctx: Ctx, t: Tracker, n: number) => Promise<unknown>): ToolDef => ({
  name,
  description,
  inputSchema: { type: 'object', properties: { issue: { type: 'integer', minimum: 1 } }, required: ['issue'], additionalProperties: false },
  handler: async (ctx, input) => {
    const n = issueOf(input)
    return boarded(ctx, t => run(ctx, t, n))
  },
})

export const TOOLS: ToolDef[] = [
  {
    name: 'migrate',
    description: 'Upgrade .factory/config.json to the current version. Backs up the old file first.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: ctx => migrate(ctx),
  },
  {
    name: 'doctor',
    description: 'Check that git, gh, the GitHub login and the origin remote are ready. With the project board on, it also checks the project token scope. Returns checks with fixes.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    // doctor runs before setup, so a missing or outdated config turns the project check off.
    handler: async ctx => doctor(ctx, [], (await loadConfig(ctx).catch(() => undefined))?.project?.enabled === true),
  },
  {
    name: 'setup',
    description: 'Set up the factory in this repo: config, labels, repo standard. project true connects a GitHub Project board, project false stores no. askProject true means: ask the user. With apply false it only previews.',
    inputSchema: {
      type: 'object',
      properties: {
        apply: { type: 'boolean' },
        baseBranch: { type: 'string' },
        concurrency: { type: 'integer', minimum: 1 },
        project: { type: 'boolean' },
      },
      required: ['apply'],
      additionalProperties: false,
    },
    handler: (ctx, input) => setup(ctx, { apply: input.apply, baseBranch: input.baseBranch, concurrency: input.concurrency, project: input.project }),
  },
  {
    name: 'gate',
    description:
      'Run the stack steps, the Conventional Commits check and the protected-path check. Writes checks.md. Runs up to 600 s per step: only gate-runner and merge call it.',
    inputSchema: {
      type: 'object',
      properties: { issue: { type: 'integer', minimum: 1 }, round: { type: 'string', pattern: '^(round-[1-9][0-9]*|merge|setup)$' } },
      additionalProperties: false,
    },
    handler: (ctx, input) => gateTool(ctx, input),
  },
  {
    name: 'queue',
    description: 'List the backlog: running, waiting, blocked and ready tickets, free slots and the next tickets to start.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async ctx => {
      const cfg = await loadConfig(ctx)
      return queue(ctx, githubTracker(ctx, repoFromUrl(cfg.tracker.url)), cfg)
    },
  },
  {
    name: 'status',
    description: 'Show the factory status as plain text: slots, ready, running and waiting tickets with the next command. Show the text unchanged.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async ctx => {
      const cfg = await loadConfig(ctx)
      return statusFor(ctx, githubTracker(ctx, repoFromUrl(cfg.tracker.url)), cfg)
    },
  },
  {
    name: 'issue_search',
    description: 'Search the issues of this repo in all states. Returns number, title and labels. Use it to find duplicates.',
    inputSchema: { type: 'object', properties: { query: { type: 'string', minLength: 1 } }, required: ['query'], additionalProperties: false },
    handler: async (ctx, input) => issueSearch(githubTracker(ctx, repoFromUrl((await loadConfig(ctx)).tracker.url)), input.query),
  },
  {
    name: 'issue_create',
    description:
      'Create GitHub issues in order, each with the label factory (none when park is true). dependsOnRefs names the ref of an earlier item and becomes a Depends on line. Returns ref, number and url for each issue. Creates nothing when the input is bad.',
    inputSchema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', minLength: 1 },
              body: { type: 'string' },
              dependsOn: { type: 'array', items: { type: 'integer', minimum: 1 } },
              ref: { type: 'string', minLength: 1 },
              dependsOnRefs: { type: 'array', items: { type: 'string' } },
            },
            required: ['title', 'body'],
            additionalProperties: false,
          },
        },
        park: { type: 'boolean' },
      },
      required: ['items'],
      additionalProperties: false,
    },
    handler: async (ctx, input) => issueCreate(githubTracker(ctx, repoFromUrl((await loadConfig(ctx)).tracker.url)), input),
  },
  issueTool('job_create', 'Start a job: set the intake label, create the worktree from origin/<base>, write job.md and issue.md.', async (ctx, t, n) => {
    const job = await jobCreate(ctx, t, n)
    return { job, jobDir: job.jobDir, worktree: job.worktree, files: ['job.md', 'issue.md'] }
  }),
  issueTool('job_sync', 'Refresh issue.md, rebuild a missing job folder from the marker comments, restore the worktree, take a newer spec comment.', async (ctx, t, n) => {
    const r = await jobSync(ctx, t, n)
    return { ...r, jobDir: r.job.jobDir, worktree: r.job.worktree }
  }),
  numberTool('approve', 'Record the human approval of a job in state approved or needs-human. Takes the issue or the PR number. Changes no label. Only the human calls it.', approve),
  numberTool(
    'merge',
    'Merge the PR of an approved job: sync with the base branch, run the gate, approve, merge, set done, clean up. Runs up to 600 s per gate step: only factory:merger calls it.',
    merge,
  ),
  {
    name: 'cleanup',
    description:
      'Remove the worktree, the merged branch and the job folder of a finished ticket. Keeps unsaved work and reports it. Without issue it sweeps every finished ticket.',
    inputSchema: { type: 'object', properties: { issue: { type: 'integer', minimum: 1 } }, additionalProperties: false },
    handler: async (ctx, input) => {
      if (input.issue === undefined) return boarded(ctx, t => sweep(ctx, t))
      const n = issueOf(input)
      const t = githubTracker(ctx, repoFromUrl((await loadConfig(ctx)).tracker.url))
      const ticket = await t.get(n)
      const state = stateOf(ticket.labels)
      if (ticket.state !== 'closed' && state !== 'done' && state !== 'rejected') {
        throw new FactoryError('not-finished', `#${n} is not finished`, 'Clean up a ticket only after it is done or rejected.')
      }
      return cleanupJob(ctx, t, n, state === 'rejected' ? 'rejected' : 'done')
    },
  },
  {
    name: 'job_advance',
    description:
      'Move a job to the next state: checks the job files, writes the issue comments, pushes and opens the PR (review), then sets the one status label. For review it reuses a passing gate-runner result at the same HEAD, else it runs the gate. With from, it refuses (state-moved) when the job is in another state.',
    inputSchema: {
      type: 'object',
      properties: { issue: { type: 'integer', minimum: 1 }, to: { type: 'string', enum: STATUS }, reason: { type: 'string' }, from: { type: 'string', enum: STATUS } },
      required: ['issue', 'to'],
      additionalProperties: false,
    },
    handler: async (ctx, input) => {
      const issue = issueOf(input)
      if (typeof input.to !== 'string' || !(STATUS as string[]).includes(input.to)) {
        throw new FactoryError('bad-input', `to must be one of ${STATUS.join(', ')}, got ${JSON.stringify(input.to)}`)
      }
      if (input.reason !== undefined && typeof input.reason !== 'string') {
        throw new FactoryError('bad-input', 'reason must be a string')
      }
      if (input.from !== undefined && (typeof input.from !== 'string' || !(STATUS as string[]).includes(input.from))) {
        throw new FactoryError('bad-input', `from must be one of ${STATUS.join(', ')}, got ${JSON.stringify(input.from)}`)
      }
      return boarded(ctx, t => jobAdvance(ctx, t, { issue, to: input.to as State, ...(input.reason === undefined ? {} : { reason: input.reason }), ...(input.from === undefined ? {} : { from: input.from as State }) }))
    },
  },
]

async function gateTool(ctx: Ctx, input: { issue?: unknown; round?: string }): Promise<unknown> {
  const round = input.round ?? 'setup'
  if (!/^(round-[1-9][0-9]*|merge|setup)$/.test(round)) {
    throw new FactoryError('bad-round', `round "${round}" is not valid`, 'Use round-<n>, merge or setup.')
  }
  if (input.issue === undefined) return runGate(ctx, { worktree: ctx.root, round })
  return gateJob(ctx, issueOf(input), round)
}

const DEFAULT_TIMEOUT_MS = 120000
const MAX_TIMEOUT_MS = 600000

// any: serve passes its untyped $ on. makeCtx uses only session.root, process.run, clock.sleep and fs.
export async function makeCtx($: any): Promise<Ctx> {
  const root: string = await $.session.root()
  return {
    root,
    now: () => new Date(),
    sleep: ms => $.clock.sleep(ms),
    run: (argv, opts) =>
      $.process.run(argv, {
        ...opts,
        timeoutMs: Math.min(opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS),
      }),
    fs: {
      read: p => $.fs.read(p),
      write: async (p, text) => {
        await $.fs.write(p, text)
      },
      exists: p => $.fs.exists(p),
      list: async p => (await $.fs.list(p)).map((e: { name: string }) => e.name),
    },
  }
}

export type ToolOutcome = { result: string } | { isError: true; result: string }

export async function invoke(def: ToolDef, ctx: Ctx, input: unknown): Promise<ToolOutcome> {
  try {
    const out = await def.handler(ctx, input)
    // Text results (status) go out as they are, not as a quoted JSON string.
    const result = typeof out === 'string' ? out : JSON.stringify(out, null, 2)
    return { result }
  } catch (err) {
    if (err instanceof FactoryError) {
      return { isError: true, result: `${err.code}: ${err.message}${err.fix === undefined ? '' : `\nFix: ${err.fix}`}` }
    }
    // A rethrown error skips the hook, so the engine returns an empty result.
    const message = err instanceof Error ? err.message : String(err)
    return { isError: true, result: `internal: ${def.name}: ${message}\nFix: Read the error, fix the cause, then call the tool again.` }
  }
}

// any: the tool.run event carries a different input type per tool, and tests call serve with a small fake $.
export const serve = async ($: any, e: any, next: any): Promise<any> => {
  const def = TOOLS.find(d => `mcp__factory__${d.name}` === e.tool)
  if (!def) return next(e)
  const { tool: _tool, ...input } = e
  return invoke(def, await makeCtx($), input)
}

export const register: Register = on => {
  // shortcut: the flag stays until the session ends, upgrade when an end event of the run exists.
  let running = false
  on('command.run', { command: 'factory:run' }, async (_$, e, next) => {
    running = true
    return next(e)
  })
  on('session.start', async ($, e, next) => {
    for (const t of TOOLS) {
      await $.tool.register({ name: t.name, description: t.description, inputSchema: t.inputSchema, isDeferred: false })
    }
    return next(e)
  })
  // Serve only at tool.run: it fires after the permission check, so tools like merge stay gated.
  on('tool.run', serve)
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const deny = guardMain(e.agentId, running) ?? (await guardBash(e.agentId, e.command, () => $.agent.list()))
    return deny === null ? next(e) : { deny }
  })
}
