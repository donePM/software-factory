// shortcut: temporary debug log for #19, remove it when the cause of #19 is known
import type { Ctx } from './types.ts'

const MAX = 2000

const cut = (s: string): string => (s.length > MAX ? `${s.slice(0, MAX)}...[+${s.length - MAX} chars]` : s)
const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

export type CallLog = { ctx: Ctx; end(outcome: string): Promise<void> }

// One file for each call. Each write holds the full buffer, and the writes go one after the other.
export async function openLog(ctx: Ctx, tool: string): Promise<CallLog> {
  const started = ctx.now()
  const path = `${ctx.root}/.factory/logs/${started.toISOString().replace(/[:.]/g, '-')}-${tool}-${crypto.randomUUID().slice(0, 8)}.log`
  let text = ''
  let chain: Promise<void> = Promise.resolve()
  const add = (line: string): Promise<void> => {
    text += `${ctx.now().toISOString()} ${line}\n`
    const snapshot = text
    chain = chain.then(() => ctx.fs.write(path, snapshot)).catch(() => {})
    return chain
  }
  await add(`start ${tool}`)
  const run: Ctx['run'] = async (argv, opts) => {
    const t0 = ctx.now().getTime()
    const head = `run ${cut(JSON.stringify(argv))}`
    try {
      const r = await ctx.run(argv, opts)
      void add(`${head} exit ${r.exitCode} ${ctx.now().getTime() - t0}ms stdout ${JSON.stringify(cut(r.stdout))} stderr ${JSON.stringify(cut(r.stderr))}`)
      return r
    } catch (err) {
      void add(`${head} threw ${messageOf(err)} ${ctx.now().getTime() - t0}ms`)
      throw err
    }
  }
  return {
    ctx: { ...ctx, run },
    end: outcome => add(`end ${tool} ${outcome} ${ctx.now().getTime() - started.getTime()}ms`),
  }
}
