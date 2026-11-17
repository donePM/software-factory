import { loadConfig, type StackRef } from './config.ts'
import { checkMessage } from './conventional.ts'
import { FactoryError } from './exec.ts'
import { detectAll, resolveSteps, STACKS } from './stacks/index.ts'
import type { Detection, ReadFile, Step, StepName } from './stacks/types.ts'
import type { Ctx } from './types.ts'

export type GateInput = { worktree: string; round: string; base?: string; prTitle?: string; jobDir?: string }
export type StepResult = Step & { exitCode: number; ms: number; skipped?: string }
export type GateResult = {
  verdict: 'PASS' | 'FAIL'
  steps: StepResult[]
  commits: { sha: string; problem: string }[]
  title?: string
  protected: string[]
  scriptsChanged: string[]
  report: string
}

const ORDER: StepName[] = ['install', 'format', 'lint', 'typecheck', 'build', 'test', 'audit']
const STEP_TIMEOUT_MS = 600000

const rank = (n: StepName): number => {
  const i = ORDER.indexOf(n)
  return i < 0 ? ORDER.length : i
}

// Sorts by step name across all stacks (stable). A detection's `after` lists step names;
// each step of that detection moves behind the last step with one of those names.
export function planGate(steps: Step[], ds: Detection[] = []): Step[] {
  const out = steps
    .map((s, i) => ({ s, i }))
    .sort((a, b) => rank(a.s.name) - rank(b.s.name) || a.i - b.i)
    .map(x => x.s)
  for (const d of ds) {
    for (const n of d.after ?? []) {
      const mine = out.filter(s => s.stack === d.stack)
      for (const s of mine) {
        const from = out.indexOf(s)
        let last = -1
        out.forEach((o, i) => {
          if (o.name === n && o.stack !== d.stack) last = i
        })
        if (last > from) {
          out.splice(from, 1)
          out.splice(last, 0, s)
        }
      }
    }
  }
  return out
}

export function jobField(md: string, key: string): string | null {
  for (const line of md.split('\n')) {
    if (!line.startsWith(`- ${key}:`)) continue
    const v = line.slice(key.length + 3).trim()
    return v === '' ? null : v
  }
  return null
}

const at = (path: string, name: string): string => (path === '.' ? name : `${path}/${name}`)

async function git(ctx: Ctx, wt: string, args: string[]): Promise<string> {
  const r = await ctx.run(['git', '-C', wt, ...args])
  if (r.exitCode !== 0) throw new FactoryError('git-failed', `git ${args[0]} failed: ${r.stderr.trim()}`)
  return r.stdout
}

function scriptsOf(text: string | null): string | null {
  if (text === null) return null
  try {
    const v: unknown = JSON.parse(text)
    const s = typeof v === 'object' && v !== null ? (v as Record<string, unknown>).scripts : undefined
    if (typeof s !== 'object' || s === null) return ''
    return JSON.stringify(Object.entries(s).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
  } catch {
    return `invalid:${text}`
  }
}

async function readIfExists(ctx: Ctx, p: string): Promise<string | null> {
  return (await ctx.fs.exists(p)) ? ctx.fs.read(p) : null
}

async function scriptsChanged(ctx: Ctx, wt: string, ds: Detection[], base: ReadFile): Promise<string[]> {
  const out: string[] = []
  for (const d of ds) {
    const make = at(d.path, 'Makefile')
    const pkg = at(d.path, 'package.json')
    if ((await readIfExists(ctx, `${wt}/${make}`)) !== (await base(make))) out.push(make)
    if (scriptsOf(await readIfExists(ctx, `${wt}/${pkg}`)) !== scriptsOf(await base(pkg))) out.push(pkg)
  }
  return [...new Set(out)]
}

function fixFor(step: Step, ds: Detection[], wt: string): string {
  const same = ds.filter(d => d.stack === step.stack)
  const exact = same.filter(d => (d.path === '.' ? wt : `${wt}/${d.path}`) === step.cwd)
  const stack = STACKS.find(s => s.id === step.stack)
  for (const d of [...exact, ...same]) {
    const hit = stack?.requires(d).find(r => r.cmd === step.argv[0])
    if (hit) return hit.fix
  }
  return `install ${step.argv[0]}`
}

const cell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\n/g, ' ')

export async function runGate(ctx: Ctx, input: GateInput): Promise<GateResult> {
  const wt = input.worktree
  const cfg = await loadConfig(ctx)
  const all = await detectAll(ctx, wt)
  const refs: StackRef[] = cfg.stacks
  const ds = refs.length === 0 ? all : all.filter(d => refs.some(r => r.id === d.stack && r.path === d.path))
  const { base } = input
  const read: ReadFile = async rel => {
    if (base !== undefined) {
      const r = await ctx.run(['git', '-C', wt, 'show', `${base}:${rel}`])
      return r.exitCode === 0 ? r.stdout : null
    }
    return readIfExists(ctx, `${ctx.root}/${rel}`)
  }
  const planned = planGate(await resolveSteps(ctx, wt, read, refs, ds), ds)

  const steps: StepResult[] = []
  const outputs: string[] = []
  for (const s of planned) {
    const t0 = ctx.now().getTime()
    const r = await ctx.run(s.argv, { cwd: s.cwd, timeoutMs: STEP_TIMEOUT_MS })
    steps.push({ ...s, exitCode: r.exitCode, ms: ctx.now().getTime() - t0 })
    outputs.push(`### ${s.name} (${s.stack}): ${s.argv.join(' ')}\nexit ${r.exitCode}\n${r.stdout}${r.stderr}`)
  }

  const commits: GateResult['commits'] = []
  let prot: string[] = []
  if (base !== undefined) {
    const log = await git(ctx, wt, ['log', '--first-parent', '--no-merges', '--format=%H%x00%B%x1e', `${base}..HEAD`])
    for (const rec of log.split('\x1e')) {
      const [sha, msg = ''] = rec.replace(/^\n/, '').split('\0')
      if (sha === undefined || sha.trim() === '') continue
      const problem = checkMessage(msg.trim())
      if (problem !== null) commits.push({ sha: sha.trim(), problem })
    }
    const changed = (await git(ctx, wt, ['diff', '--name-only', `${base}...HEAD`])).split('\n').filter(l => l !== '')
    prot = changed.filter(f => cfg.protectedPaths.includes(f))
  }
  const titleProblem = input.prTitle === undefined ? null : checkMessage(input.prTitle)
  const changedScripts = await scriptsChanged(ctx, wt, ds, read)

  const red = steps.filter(s => s.exitCode !== 0)
  const verdict = red.length + commits.length + prot.length + changedScripts.length > 0 || titleProblem !== null ? 'FAIL' : 'PASS'

  const lines: string[] = [`VERDICT: ${verdict}`, '', '## Summary', '']
  lines.push(`${steps.length - red.length} of ${steps.length} steps passed. Round: ${input.round}.`, '')
  lines.push('| Step | Stack | Command | Exit | Duration |', '| --- | --- | --- | --- | --- |')
  for (const s of steps) lines.push(`| ${s.name} | ${s.stack} | \`${cell(s.argv.join(' '))}\` | ${s.exitCode} | ${s.ms} ms |`)
  for (const s of red.filter(x => x.exitCode === 127)) lines.push('', `Missing tool for ${s.name}: ${fixFor(s, ds, wt)}`)
  if (commits.length > 0) {
    lines.push('', '## Commits')
    for (const c of commits) lines.push(`- ${c.sha.slice(0, 12)}: ${c.problem}`)
  }
  if (titleProblem !== null) lines.push('', '## PR title', `- ${titleProblem}`)
  if (prot.length > 0) lines.push('', '## Protected paths', ...prot.map(p => `- ${p}`))
  if (changedScripts.length > 0) lines.push('', '## Scripts changed', ...changedScripts.map(p => `- ${p}`))
  const report = `${lines.join('\n')}\n`

  const dir = input.jobDir === undefined ? `${ctx.root}/.factory/gate/setup` : `${input.jobDir}/${input.round}`
  const logPath = `${dir}/checks.log`
  const old = await readIfExists(ctx, logPath)
  const k = 1 + (old?.split('\n').filter(l => l.startsWith('## Attempt ')).length ?? 0)
  await ctx.fs.write(`${dir}/checks.md`, report)
  await ctx.fs.write(logPath, `${old ?? ''}## Attempt ${k}\n\n${outputs.join('\n\n')}\n\n`)

  const result: GateResult = { verdict, steps, commits, protected: prot, scriptsChanged: changedScripts, report }
  if (titleProblem !== null) result.title = titleProblem
  return result
}
