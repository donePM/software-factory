import { loadConfig, type StackRef } from './config.ts'
import { checkMessage } from './conventional.ts'
import { FactoryError } from './exec.ts'
import { TYPES_FIX, TYPES_MISSING_EXIT } from './stacks/claude-plugin.ts'
import { detectAll, resolveSteps, STACKS } from './stacks/index.ts'
import type { Detection, ReadFile, Step, StepName } from './stacks/types.ts'
import { renderTexts, TEXTS_MODULE, TEXTS_SCRIPT } from './texts.ts'
import type { Ctx } from './types.ts'

export type GateInput = { worktree: string; round: string; base?: string; prTitle?: string; jobDir?: string }
export type StepResult = Step & { exitCode: number; ms: number; skipped?: string }
export type GateResult = {
  verdict: 'PASS' | 'FAIL'
  steps: StepResult[]
  // Only the commits that break Conventional Commits. Empty means all commits pass.
  badCommits: { sha: string; problem: string }[]
  title?: string
  protected: string[]
  scriptsChanged: string[]
  missingStacks: string[]
  // Problems of the host, not of the branch. The builder cannot fix them.
  host: string[]
  report: string
}

const ORDER: StepName[] = ['install', 'format', 'lint', 'typecheck', 'build', 'test', 'audit']
const STEP_TIMEOUT_MS = 600000
const ROUND = /^(round-[1-9][0-9]*|merge|setup)$/
const RUNNER_FILE = /(^|\/)(Makefile|GNUmakefile|makefile|\.npmrc)$|\.mk$/

// Ignored files that can change what the steps run, and ignored protected paths.
// A runner file counts only where the steps read it: the repo root and each stack path.
const isRunnerFile = (path: string, protectedPaths: string[], dirs: string[]): boolean => {
  if (protectedPaths.includes(path)) return true
  const slash = path.lastIndexOf('/')
  return RUNNER_FILE.test(path) && dirs.includes(slash < 0 ? '.' : path.slice(0, slash))
}

// Lists dirty entries and ignored runner files. Needs a clean committed tree: pushed content must be what the gate ran.
async function dirtyTree(ctx: Ctx, wt: string, protectedPaths: string[], dirs: string[]): Promise<string[]> {
  const entries = (out: string): string[] => out.split('\0').filter(e => e !== '')
  const dirty = entries(await git(ctx, wt, ['status', '--porcelain', '-z', '--untracked-files=all'])).map(e => e.slice(3))
  const ignored = entries(await git(ctx, wt, ['status', '--porcelain', '-z', '--ignored', '--untracked-files=all']))
    .filter(e => e.startsWith('!! '))
    .map(e => e.slice(3))
    .filter(f => isRunnerFile(f, protectedPaths, dirs))
    .map(f => `${f} (ignored)`)
  return [...dirty, ...ignored]
}

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

export const countAttempts = (log: string | null): number => log?.split('\n').filter(l => l.startsWith('## Attempt ')).length ?? 0

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

// A plugin that commits the texts module gets it checked before its tests run: a stale module tests old text.
async function staleTexts(ctx: Ctx, wt: string, ds: Detection[]): Promise<string[]> {
  const out: string[] = []
  for (const d of ds.filter(x => x.stack === 'claude-plugin' && x.variant === 'plugin')) {
    const dir = d.path === '.' ? wt : `${wt}/${d.path}`
    const file = `${dir}/${TEXTS_MODULE}`
    if (!(await ctx.fs.exists(file))) continue
    if ((await ctx.fs.read(file)) !== (await renderTexts(ctx.fs, dir))) {
      out.push(`${at(d.path, TEXTS_MODULE)} differs from the agent, skill, and pipeline files. Run \`node ${at(d.path, TEXTS_SCRIPT)}\` and commit the file.`)
    }
  }
  return out
}

const USES = /^\s*(?:-\s+)?uses:\s*(['"]?)([^\s'"#]+)\1\s*(?:#.*)?$/
const PINNED = /^(\.\/|docker:\/\/)|@[0-9a-fA-F]{40}$/

// Lists each workflow `uses:` value that is not a full commit SHA: a moved tag or branch changes what CI runs.
// shortcut: line match, not a YAML parser; upgrade when a workflow uses multi-line or flow-style uses values
async function unpinnedActions(ctx: Ctx, wt: string): Promise<string[]> {
  const dir = '.github/workflows'
  const names = (await ctx.fs.list(`${wt}/${dir}`).catch(() => [])).filter(n => /\.ya?ml$/.test(n)).sort()
  const out: string[] = []
  for (const n of names) {
    for (const line of (await ctx.fs.read(`${wt}/${dir}/${n}`)).split('\n')) {
      const v = USES.exec(line)?.[2]
      if (v !== undefined && !PINNED.test(v)) out.push(`${dir}/${n}: ${v}`)
    }
  }
  return out
}

const cell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\n/g, ' ')

export async function runGate(ctx: Ctx, input: GateInput): Promise<GateResult> {
  if (!ROUND.test(input.round)) {
    throw new FactoryError('bad-round', `round "${input.round}" is not valid`, 'Use round-<n>, merge or setup.')
  }
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
  const missingStacks = refs.filter(r => !all.some(d => d.stack === r.id && d.path === r.path)).map(r => `${r.id} ${r.path}`)
  const planned = planGate(await resolveSteps(ctx, wt, read, refs, ds), ds)
  const stale = await staleTexts(ctx, wt, ds)
  const unpinned = await unpinnedActions(ctx, wt)

  const steps: StepResult[] = []
  const outputs: string[] = []
  const engine: string[] = []
  const host: string[] = []
  for (const s of planned) {
    const t0 = ctx.now().getTime()
    const r = await ctx.run(s.argv, { cwd: s.cwd, timeoutMs: STEP_TIMEOUT_MS })
    steps.push({ ...s, exitCode: r.exitCode, ms: ctx.now().getTime() - t0 })
    if (s.stack === 'claude-plugin' && s.name === 'typecheck') {
      const m = /engine types: used (\S+), wanted (\S+)/.exec(r.stdout)
      if (m) engine.push(m[1] === m[2] ? `Engine types: ${m[1]}.` : `Engine types: ${m[1]}. Note: \`claude --version\` is ${m[2]}, so the gate used the types of ${m[1]}.`)
      if (r.exitCode === TYPES_MISSING_EXIT) {
        const wanted = /engine types not found for ([^,\s]+),/.exec(r.stderr)?.[1] ?? 'unknown'
        host.push(`${s.name} (${s.stack}): engine types not found for ${wanted}. Found: none. ${TYPES_FIX}`)
      }
    }
    outputs.push(`### ${s.name} (${s.stack}): ${s.argv.join(' ')}\nexit ${r.exitCode}\n${r.stdout}${r.stderr}`)
  }

  const commits: GateResult['badCommits'] = []
  let prot: string[] = []
  let dirty: string[] = []
  let runnerFiles: string[] = []
  if (base !== undefined) {
    dirty = await dirtyTree(ctx, wt, cfg.protectedPaths, ['.', ...ds.map(d => d.path)])
    const log = await git(ctx, wt, ['log', '--first-parent', '--no-merges', '--format=%H%x00%B%x1e', `${base}..HEAD`])
    for (const rec of log.split('\x1e')) {
      const [sha, msg = ''] = rec.replace(/^\n/, '').split('\0')
      if (sha === undefined || sha.trim() === '') continue
      const problem = checkMessage(msg.trim())
      if (problem !== null) commits.push({ sha: sha.trim(), problem })
    }
    const changed = (await git(ctx, wt, ['diff', '--name-only', '--no-renames', '-z', `${base}...HEAD`])).split('\0').filter(l => l !== '')
    prot = changed.filter(f => cfg.protectedPaths.includes(f))
    runnerFiles = changed.filter(f => RUNNER_FILE.test(f))
  }
  const titleProblem = input.prTitle === undefined ? null : checkMessage(input.prTitle)
  const changedScripts = [...new Set([...(await scriptsChanged(ctx, wt, ds, read)), ...runnerFiles])]

  const red = steps.filter(s => s.exitCode !== 0)
  // A job gate needs the configured stacks: with none, a branch could drop a stack and its checks.
  const noStacks = input.jobDir !== undefined && refs.length === 0
  const verdict = red.length + stale.length + unpinned.length + commits.length + prot.length + dirty.length + changedScripts.length + missingStacks.length > 0 || steps.length === 0 || titleProblem !== null || noStacks ? 'FAIL' : 'PASS'

  const lines: string[] = [`VERDICT: ${verdict}`, '', '## Summary', '']
  lines.push(`${steps.length - red.length} of ${steps.length} steps passed. Round: ${input.round}.`, '')
  lines.push('| Step | Stack | Command | Exit | Duration |', '| --- | --- | --- | --- | --- |')
  for (const s of steps) lines.push(`| ${s.name} | ${s.stack} | \`${cell(s.argv.join(' '))}\` | ${s.exitCode} | ${s.ms} ms |`)
  if (engine.length > 0) lines.push('', ...engine)
  for (const s of red.filter(x => x.exitCode === 127)) lines.push('', `Missing tool for ${s.name}: ${fixFor(s, ds, wt)}`)
  if (host.length > 0) lines.push('', '## Host problem', ...host.map(h => `- ${h}`))
  if (stale.length > 0) lines.push('', '## Generated files', ...stale.map(s => `- ${s}`))
  if (unpinned.length > 0) lines.push('', '## Unpinned actions', ...unpinned.map(u => `- ${u}`))
  if (commits.length > 0) {
    lines.push('', '## Commits')
    for (const c of commits) lines.push(`- ${c.sha.slice(0, 12)}: ${c.problem}`)
  }
  if (titleProblem !== null) lines.push('', '## PR title', `- ${titleProblem}`)
  if (prot.length > 0) lines.push('', '## Protected paths', ...prot.map(p => `- ${p}`))
  if (dirty.length > 0) lines.push('', '## Working tree', ...dirty.map(d => `- ${d}`))
  if (missingStacks.length > 0) lines.push('', '## Stacks not detected', ...missingStacks.map(m => `- ${m}`))
  if (steps.length === 0) lines.push('', '## No steps', '- No step ran.')
  if (noStacks) lines.push('', '## No stacks', '- .factory/config.json lists no stacks. Run /factory:setup to write them.')
  if (changedScripts.length > 0) lines.push('', '## Scripts changed', ...changedScripts.map(p => `- ${p}`))
  const report = `${lines.join('\n')}\n`

  const dir = input.jobDir === undefined ? `${ctx.root}/.factory/gate/setup` : `${input.jobDir}/${input.round}`
  const logPath = `${dir}/checks.log`
  const old = await readIfExists(ctx, logPath)
  const k = 1 + countAttempts(old)
  await ctx.fs.write(`${dir}/checks.md`, report)
  await ctx.fs.write(logPath, `${old ?? ''}## Attempt ${k}\n\n${outputs.join('\n\n')}\n\n`)

  const result: GateResult = { verdict, steps, badCommits: commits, protected: prot, scriptsChanged: changedScripts, missingStacks, host, report }
  if (titleProblem !== null) result.title = titleProblem
  return result
}
