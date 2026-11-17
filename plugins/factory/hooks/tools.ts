import type { Register } from 'claude-code'
import { FactoryError } from '../lib/exec.ts'
import { loadConfig, migrate } from '../lib/config.ts'
import { doctor } from '../lib/doctor.ts'
import { runGate } from '../lib/gate.ts'
import { jobCreate, jobSync } from '../lib/job.ts'
import { jobDir, readJob } from '../lib/jobfile.ts'
import { githubTracker, repoFromUrl } from '../lib/github.ts'
import { queue } from '../lib/queue.ts'
import { setup } from '../lib/setup.ts'
import type { Tracker } from '../lib/tracker.ts'
import type { Ctx } from '../lib/types.ts'

export type ToolDef = {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  // biome-ignore lint: tool input is validated by the engine against inputSchema
  handler: (ctx: Ctx, input: any) => Promise<unknown>
}

function issueOf(input: { issue?: unknown }): number {
  const n = input.issue
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) {
    throw new FactoryError('bad-input', `issue must be a positive integer, got ${JSON.stringify(n)}`)
  }
  return n
}

const issueTool = (name: string, description: string, run: (ctx: Ctx, t: Tracker, n: number) => Promise<unknown>): ToolDef => ({
  name,
  description,
  inputSchema: { type: 'object', properties: { issue: { type: 'integer', minimum: 1 } }, required: ['issue'], additionalProperties: false },
  handler: async (ctx, input) => {
    const n = issueOf(input)
    const t = githubTracker(ctx, repoFromUrl((await loadConfig(ctx)).tracker.url))
    return run(ctx, t, n)
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
    description: 'Check that git, gh, the GitHub login and the origin remote are ready. Returns checks with fixes.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: ctx => doctor(ctx, []),
  },
  {
    name: 'setup',
    description: 'Set up the factory in this repo: config, labels, repo standard. With apply false it only previews.',
    inputSchema: {
      type: 'object',
      properties: {
        apply: { type: 'boolean' },
        baseBranch: { type: 'string' },
        concurrency: { type: 'integer', minimum: 1 },
      },
      required: ['apply'],
      additionalProperties: false,
    },
    handler: (ctx, input) => setup(ctx, { apply: input.apply, baseBranch: input.baseBranch, concurrency: input.concurrency }),
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
  issueTool('job_create', 'Start a job: set the intake label, create the worktree from origin/<base>, write job.md and issue.md.', async (ctx, t, n) => {
    const job = await jobCreate(ctx, t, n)
    return { job, jobDir: job.jobDir, worktree: job.worktree, files: ['job.md', 'issue.md'] }
  }),
  issueTool('job_sync', 'Refresh issue.md, rebuild a missing job folder from the marker comments, restore the worktree, take a newer spec comment.', async (ctx, t, n) => {
    const r = await jobSync(ctx, t, n)
    return { ...r, jobDir: r.job.jobDir, worktree: r.job.worktree }
  }),
]

const NO_JOB = 'Run job_create first.'

const SHA40 = /^[0-9a-f]{40}$/

async function checkBase(ctx: Ctx, wt: string, base: string): Promise<void> {
  const bad = (m: string): FactoryError => new FactoryError('bad-job-base', m, NO_JOB)
  if (!SHA40.test(base)) throw bad(`job.md Base "${base}" is not a full 40-character sha`)
  const head = (await ctx.run(['git', '-C', wt, 'rev-parse', 'HEAD'])).stdout.trim()
  if (head === base) throw bad('job.md Base equals the worktree HEAD')
  if ((await ctx.run(['git', '-C', wt, 'merge-base', '--is-ancestor', base, 'HEAD'])).exitCode !== 0) {
    throw bad('job.md Base is not an ancestor of the worktree HEAD')
  }
  const branch = `origin/${(await loadConfig(ctx)).baseBranch}`
  if ((await ctx.run(['git', '-C', ctx.root, 'merge-base', '--is-ancestor', base, branch])).exitCode !== 0) {
    throw bad(`job.md Base is not an ancestor of ${branch}`)
  }
}

async function gateTool(ctx: Ctx, input: { issue?: unknown; round?: string }): Promise<unknown> {
  const round = input.round ?? 'setup'
  if (!/^(round-[1-9][0-9]*|merge|setup)$/.test(round)) {
    throw new FactoryError('bad-round', `round "${round}" is not valid`, 'Use round-<n>, merge or setup.')
  }
  if (input.issue === undefined) return runGate(ctx, { worktree: ctx.root, round })
  const n = issueOf(input)
  const dir = jobDir(ctx.root, n)
  if (!(await ctx.fs.exists(`${dir}/job.md`))) throw new FactoryError('no-job', `${dir}/job.md does not exist`, NO_JOB)
  const job = await readJob(ctx, n)
  if (!(await ctx.fs.exists(`${dir}/spec.md`))) throw new FactoryError('no-spec', `${dir}/spec.md does not exist`, 'Run the spec step first.')
  const title = /^Title:\s*(.+)$/m.exec(await ctx.fs.read(`${dir}/spec.md`))?.[1]?.trim()
  if (title === undefined) throw new FactoryError('spec-no-title', 'spec.md has no "Title:" line', 'The spec-writer must add a Title line.')
  const worktree = job.worktree
  const expected = `${ctx.root}/.factory/worktrees/${n}`
  if (worktree !== expected) {
    throw new FactoryError('bad-job-worktree', `job.md names worktree ${worktree}, not ${expected}`, NO_JOB)
  }
  const base = job.base
  await checkBase(ctx, worktree, base)
  return runGate(ctx, { worktree, round, base, prTitle: title, jobDir: dir })
}

const DEFAULT_TIMEOUT_MS = 120000
const MAX_TIMEOUT_MS = 600000

export async function makeCtx($: any): Promise<Ctx> {
  const root: string = await $.session.root()
  return {
    root,
    now: () => new Date(),
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

export type ToolOutcome = { result: string } | { isError: true; result: undefined; text: string }

export async function invoke(def: ToolDef, ctx: Ctx, input: unknown): Promise<ToolOutcome> {
  try {
    return { result: JSON.stringify(await def.handler(ctx, input), null, 2) }
  } catch (err) {
    if (err instanceof FactoryError) {
      return { isError: true, result: undefined, text: `${err.code}: ${err.message}${err.fix === undefined ? '' : `\nFix: ${err.fix}`}` }
    }
    throw err
  }
}

// biome-ignore lint: hook arguments are typed by the on() call sites
export const serve = async ($: any, e: any, next: any): Promise<any> => {
  const def = TOOLS.find(d => `mcp__factory__${d.name}` === e.tool)
  if (!def) return next(e)
  const { tool: _tool, ...input } = e
  return invoke(def, await makeCtx($), input)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    for (const t of TOOLS) {
      await $.tool.register({ name: t.name, description: t.description, inputSchema: t.inputSchema, isDeferred: false })
    }
    return next(e)
  })
  // Serve only at tool.run: it fires after the permission check, so tools like merge stay gated.
  on('tool.run', serve)
}
