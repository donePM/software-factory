import { FactoryError } from '../exec.ts'
import type { Ctx } from '../types.ts'
import type { Detection, ReadFile, Stack, Step, ToolReq } from './types.ts'

const rel = (p: string, name: string): string => (p === '.' ? name : `${p}/${name}`)

const LOCKFILES: [string, string][] = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
]

const INSTALL: Record<string, string[]> = {
  pnpm: ['pnpm', 'install', '--frozen-lockfile'],
  npm: ['npm', 'ci'],
  yarn: ['yarn', 'install', '--immutable'],
  bun: ['bun', 'install', '--frozen-lockfile'],
}

const VP_FIX = 'Install Vite+ (vp) as described at https://viteplus.dev.'

// The package manager from the lockfile at the package path, else from the nearest parent folder.
function packageManager(files: string[], path: string): string {
  let dir = path
  for (;;) {
    for (const [lock, pm] of LOCKFILES) if (files.includes(rel(dir, lock))) return pm
    if (dir === '.') return 'npm'
    const i = dir.lastIndexOf('/')
    dir = i < 0 ? '.' : dir.slice(0, i)
  }
}

function parse(text: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(text)
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

async function nodeVersion(ctx: Ctx, repo: string, files: string[], path: string): Promise<string | undefined> {
  for (const f of ['.nvmrc', '.node-version']) {
    if (!files.includes(rel(path, f))) continue
    const v = (await ctx.fs.read(`${repo}/${rel(path, f)}`)).trim().replace(/^v/, '')
    if (v !== '') return v
  }
  const pkg = parse(await ctx.fs.read(`${repo}/${rel(path, 'package.json')}`))
  const engines = pkg?.engines
  if (typeof engines === 'object' && engines !== null) {
    const n = (engines as Record<string, unknown>).node
    if (typeof n === 'string' && n !== '') return n
  }
  return undefined
}

export const node: Stack = {
  id: 'node',

  async detect(ctx, repo, files) {
    const out: Detection[] = []
    for (const f of files) {
      if (f !== 'package.json' && !f.endsWith('/package.json')) continue
      if (f.split('/').includes('node_modules')) continue
      const path = f === 'package.json' ? '.' : f.slice(0, -'/package.json'.length)
      const tools = ['node', packageManager(files, path), 'vp']
      const ts = files.includes(rel(path, 'tsconfig.json'))
      if (ts) tools.push('tsc')
      const versions: Record<string, string> = {}
      const v = await nodeVersion(ctx, repo, files, path)
      if (v !== undefined) versions.node = v
      out.push({ stack: 'node', path, variant: ts ? 'typescript' : 'javascript', versions, tools })
    }
    return out
  },

  requires(d) {
    const pm = d.tools[1] ?? 'npm'
    const reqs: ToolReq[] = [
      { cmd: 'node', versionArgs: ['--version'], fix: 'Install Node.js.' },
      { cmd: pm, versionArgs: ['--version'], fix: `Install ${pm}.` },
      { cmd: 'vp', versionArgs: ['--version'], fix: VP_FIX },
    ]
    if (d.tools.includes('tsc')) reqs.push({ cmd: 'tsc', versionArgs: ['--version'], fix: 'brew install typescript' })
    return reqs
  },

  async steps(_ctx: Ctx, read: ReadFile, d: Detection): Promise<Step[]> {
    const text = await read(rel(d.path, 'package.json'))
    const pkg = text === null ? {} : parse(text)
    if (pkg === null) {
      throw new FactoryError(
        'bad-package-json',
        `${rel(d.path, 'package.json')} is not valid JSON.`,
        'Fix the JSON syntax in package.json.',
      )
    }
    const scripts = typeof pkg.scripts === 'object' && pkg.scripts !== null ? (pkg.scripts as Record<string, unknown>) : {}
    const pm = d.tools[1] ?? 'npm'
    const mk = (name: Step['name'], argv: string[], source: Step['source'] = 'default'): Step => ({
      name, argv, cwd: d.path, source, stack: d.stack,
    })
    // A script with the step name beats the default. 'install' is excluded: it is a lifecycle hook of the package manager.
    const pick = (name: Step['name'], ...defaults: string[][]): Step[] =>
      name !== 'install' && name in scripts ? [mk(name, [pm, 'run', name], 'script')] : defaults.map(a => mk(name, a))
    return [
      ...pick('install', INSTALL[pm] ?? ['npm', 'ci']),
      ...pick('format', ['vp', 'fmt', '--check']),
      ...pick('lint', ['vp', 'lint']),
      ...pick('typecheck', ['vp', 'check'], ...(d.tools.includes('tsc') ? [['tsc', '--noEmit']] : [])),
      ...pick('build'),
      ...pick('test', ['vp', 'test']),
      ...pick('audit', [pm, 'audit']),
    ]
  },
}
