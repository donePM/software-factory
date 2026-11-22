import type { Ctx, RunOpts } from './types.ts'

export class FactoryError extends Error {
  code: string
  fix?: string
  constructor(code: string, message: string, fix?: string) {
    super(message)
    this.name = 'FactoryError'
    this.code = code
    if (fix !== undefined) this.fix = fix
  }
}

export async function must(ctx: Ctx, argv: readonly string[], opts?: RunOpts): Promise<string> {
  const r = await ctx.run(argv, opts)
  if (r.exitCode !== 0) {
    throw new FactoryError('command-failed', `${argv[0]} ${argv[1] ?? ''}: ${r.stderr.trim()}`)
  }
  return r.stdout.trim()
}

// Only for empty folders: ctx.fs.write creates parent folders itself.
export async function mkdirp(ctx: Ctx, dir: string): Promise<void> {
  await must(ctx, ['mkdir', '-p', dir])
}

function normalize(path: string): string {
  const out: string[] = []
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') out.pop()
    else out.push(seg)
  }
  return '/' + out.join('/')
}

export async function rmrf(ctx: Ctx, path: string): Promise<void> {
  const base = normalize(`${ctx.root}/.factory`)
  const target = normalize(path)
  if (!target.startsWith(`${base}/`)) {
    throw new FactoryError('unsafe-path', `refusing to delete ${path}`, `The factory deletes only paths below ${base}/.`)
  }
  await must(ctx, ['rm', '-rf', target])
}
