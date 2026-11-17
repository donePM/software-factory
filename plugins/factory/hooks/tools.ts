import type { Register } from 'claude-code'
import { FactoryError } from '../lib/exec.ts'
import { migrate } from '../lib/config.ts'
import { doctor } from '../lib/doctor.ts'
import { jobField, runGate } from '../lib/gate.ts'
import { setup } from '../lib/setup.ts'
import type { Ctx } from '../lib/types.ts'

export type ToolDef = {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  // biome-ignore lint: tool input is validated by the engine against inputSchema
  handler: (ctx: Ctx, input: any) => Promise<unknown>
}

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
      properties: { issue: { type: 'integer', minimum: 1 }, round: { type: 'string' } },
      additionalProperties: false,
    },
    handler: (ctx, input) => gateTool(ctx, input),
  },
]

const NO_JOB = 'Run job_create first.'

async function gateTool(ctx: Ctx, input: { issue?: number; round?: string }): Promise<unknown> {
  const round = input.round ?? 'setup'
  if (input.issue === undefined) return runGate(ctx, { worktree: ctx.root, round })
  const jobDir = `${ctx.root}/.factory/jobs/${input.issue}`
  if (!(await ctx.fs.exists(`${jobDir}/job.md`))) throw new FactoryError('no-job', `${jobDir}/job.md does not exist`, NO_JOB)
  const md = await ctx.fs.read(`${jobDir}/job.md`)
  const wt = jobField(md, 'Worktree')
  const base = jobField(md, 'Base')
  if (wt === null) throw new FactoryError('job-no-worktree', `job.md has no "- Worktree:" field`, NO_JOB)
  if (base === null) throw new FactoryError('job-no-base', `job.md has no "- Base:" field`, NO_JOB)
  if (!(await ctx.fs.exists(`${jobDir}/spec.md`))) throw new FactoryError('no-spec', `${jobDir}/spec.md does not exist`, 'Run the spec step first.')
  const title = /^Title:\s*(.+)$/m.exec(await ctx.fs.read(`${jobDir}/spec.md`))?.[1]?.trim()
  if (title === undefined) throw new FactoryError('spec-no-title', 'spec.md has no "Title:" line', 'The spec-writer must add a Title line.')
  const worktree = wt.startsWith('/') ? wt : `${ctx.root}/${wt}`
  return runGate(ctx, { worktree, round, base, prTitle: title, jobDir })
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
