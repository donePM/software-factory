import type { On } from 'claude-code'
import type { Ctx, RunResult } from '../../lib/types.ts'

export type Reply = { argv: string[]; result?: Partial<RunResult> }
type Opts = { files?: Record<string, string>; replies?: Reply[]; root?: string }

function answer(replies: Reply[], argv: readonly string[]): RunResult {
  const hit = replies.find(r => r.argv.every((a, i) => argv[i] === a))
  if (!hit) return { exitCode: 127, stdout: '', stderr: `no reply for ${argv.join(' ')}` }
  return { exitCode: 0, stdout: '', stderr: '', ...hit.result }
}

function listDir(files: Record<string, string>, dir: string): string[] {
  const names = new Set<string>()
  for (const p of Object.keys(files)) {
    if (p.startsWith(`${dir}/`)) names.add(p.slice(dir.length + 1).split('/')[0]!)
  }
  return [...names]
}

export function fakeCtx(opts: Opts = {}): Ctx & { calls: string[][]; files: Record<string, string> } {
  const files = { ...opts.files }
  const calls: string[][] = []
  const replies = opts.replies ?? []
  return {
    calls,
    files,
    root: opts.root ?? '/repo',
    now: () => new Date('2026-01-01T00:00:00Z'),
    run: async argv => {
      calls.push([...argv])
      return answer(replies, argv)
    },
    fs: {
      read: async p => {
        const t = files[p]
        if (t === undefined) throw new Error(`ENOENT ${p}`)
        return t
      },
      write: async (p, text) => {
        files[p] = text
      },
      exists: async p => p in files,
      list: async p => listDir(files, p),
    },
  }
}

export type Registered = { name: string; description: string; isDeferred?: boolean }

export function fakeHost(on: On, opts: Opts = {}): { calls: string[][]; files: Record<string, string>; registered: Registered[] } {
  const ctx = fakeCtx(opts)
  const registered: Registered[] = []
  on('tool.register', async (_$, e) => {
    registered.push(e as Registered)
    return { value: { tool: `mcp__factory__${e.name}` } }
  })
  on('session.root', async () => ({ value: ctx.root }))
  on('session.start', async ($, e) => ({ cwd: e.cwd }))
  on('process.run', async ($, e) => ({ value: await ctx.run(e.argv) }) as never)
  on('fs.read', async ($, e) => ctx.fs.read(e.path).then(value => ({ value }), () => ({ deny: `ENOENT ${e.path}` })))
  on('fs.write', async ($, e) => {
    await ctx.fs.write(e.path, e.text)
    return { value: undefined }
  })
  on('fs.exists', async ($, e) => ({ value: await ctx.fs.exists(e.path) }))
  on('fs.list', async ($, e) => ({
    value: (await ctx.fs.list(e.path)).map(name => ({ name, kind: 'file' as const, size: 0, mtimeMs: 0, isLink: false })),
  }))
  return { calls: ctx.calls, files: ctx.files, registered }
}
