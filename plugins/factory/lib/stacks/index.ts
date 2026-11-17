import type { StackRef } from '../config.ts'
import { FactoryError } from '../exec.ts'
import type { Ctx } from '../types.ts'
import { claudePlugin } from './claude-plugin.ts'
import { node } from './node.ts'
import type { Detection, ReadFile, Stack, Step, StepName } from './types.ts'

export const STACKS: Stack[] = [claudePlugin, node]

const STEP_ORDER: StepName[] = ['install', 'format', 'lint', 'typecheck', 'build', 'test', 'audit', 'start']

export async function listFiles(ctx: Ctx, repo: string): Promise<string[]> {
  const r = await ctx.run(['git', '-C', repo, 'ls-files', '--cached', '--others', '--exclude-standard'])
  if (r.exitCode !== 0) throw new FactoryError('git-failed', `git ls-files failed: ${r.stderr.trim()}`)
  return r.stdout.split('\n').filter(l => l !== '')
}

export async function detectAll(ctx: Ctx, repo: string): Promise<Detection[]> {
  const files = await listFiles(ctx, repo)
  const out: Detection[] = []
  for (const s of STACKS) out.push(...(await s.detect(ctx, repo, files)))
  return out
}

const at = (path: string, name: string): string => (path === '.' ? name : `${path}/${name}`)

export async function resolveSteps(
  ctx: Ctx,
  repo: string,
  read: ReadFile,
  refs: StackRef[],
  ds: Detection[],
): Promise<Step[]> {
  const out: Step[] = []
  const seen = new Set<string>()
  const add = (s: Step): void => {
    const key = JSON.stringify([s.argv, s.cwd])
    if (seen.has(key)) return
    seen.add(key)
    out.push(s)
  }
  for (const d of ds) {
    const stack = STACKS.find(s => s.id === d.stack)
    if (!stack) continue
    const ref = refs.find(r => r.id === d.stack && r.path === d.path)
    // Default steps carry paths in argv, so they run at the repo root like every source's cwd base.
    const own = (await stack.steps(ctx, read, d)).map(s => ({ ...s, cwd: repo }))
    const names = own.map(s => s.name)
    for (const n of STEP_ORDER) if (ref?.steps?.[n] !== undefined && !names.includes(n)) names.push(n)
    const make = await read(at(d.path, 'Makefile'))
    const cwd = d.path === '.' ? repo : `${repo}/${d.path}`
    for (const name of names) {
      const cmd = ref?.steps?.[name]
      if (cmd !== undefined) {
        add({ name, argv: ['sh', '-c', cmd], cwd, source: 'config', stack: d.stack })
      } else if (make !== null && new RegExp(`^${name}:`, 'm').test(make)) {
        add({ name, argv: ['make', name], cwd, source: 'runner', stack: d.stack })
      } else {
        for (const s of own) if (s.name === name) add(s)
      }
    }
  }
  return out
}
