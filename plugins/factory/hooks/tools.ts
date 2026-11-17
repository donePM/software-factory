import type { Register } from 'claude-code'
import { FactoryError } from '../lib/exec.ts'
import type { Ctx } from '../lib/types.ts'


export type ToolDef = {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  // biome-ignore lint: tool input is validated by the engine against inputSchema
  handler: (ctx: Ctx, input: any) => Promise<unknown>
}

export const TOOLS: ToolDef[] = []

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
      return { isError: true, result: undefined, text: `${err.code}: ${err.message}\nFix: ${err.fix}` }
    }
    throw err
  }
}

// biome-ignore lint: hook arguments are typed by the on() call sites
const serve = async ($: any, e: any, next: any): Promise<any> => {
  const def = TOOLS.find(d => `mcp__factory__${d.name}` === e.tool)
  return def ? invoke(def, await makeCtx($), e) : next(e)
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
