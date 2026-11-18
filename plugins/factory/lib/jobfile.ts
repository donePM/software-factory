import { FactoryError } from './exec.ts'
import type { Route } from './route.ts'
import type { Ctx, Model, Reviewer } from './types.ts'

export type Job = {
  issue: number
  title: string
  jobDir: string
  worktree: string
  branch: string
  base: string
  baseBranch: string
  pr: number | null
  round: number
  specUpdated: string | null
  // The commit that the gate passed and the reviewers saw. A new round clears it.
  reviewed: string | null
  route: Route
}

export const jobDir = (root: string, n: number): string => `${root}/.factory/jobs/${n}`
export const worktreeDir = (root: string, n: number): string => `${root}/.factory/worktrees/${n}`
export const branchName = (n: number): string => `factory/${n}`

const SHA40 = /^[0-9a-f]{40}$/
const REVIEWERS: readonly string[] = ['code', 'security', 'ux', 'ui']
const MODELS: readonly string[] = ['haiku', 'sonnet', 'opus', 'fable']

// Reads a "- Key: value" line. An empty value counts as missing.
export function fieldOf(md: string, key: string): string | null {
  for (const line of md.split(/\r\n|\r|\n/)) {
    if (!line.startsWith(`- ${key}:`)) continue
    const v = line.slice(key.length + 3).trim()
    return v === '' ? null : v
  }
  return null
}

// Body of the last "## <name>" section, or null. Tool-appended sections come last.
export function lastSection(md: string, name: string): string | null {
  let found: string[] | null = null
  let cur: string[] | null = null
  for (const line of md.split(/\r\n|\r|\n/)) {
    if (line.startsWith('## ')) {
      cur = line.trim() === `## ${name}` ? [] : null
      if (cur !== null) found = cur
    } else cur?.push(line)
  }
  return found === null ? null : found.join('\n')
}

export function parseRoute(md: string): Route | null {
  const out: Route = {}
  for (const line of (lastSection(md, 'Route') ?? '').split('\n')) {
    if (!line.startsWith('- ')) continue
    const m = /^- ([a-z]+):\s*([a-z]+)\s*$/.exec(line)
    if (!m || !REVIEWERS.includes(m[1]!) || !MODELS.includes(m[2]!)) return null
    out[m[1] as Reviewer] = m[2] as Model
  }
  return out
}

export const parseBase = (v: string | null): string | null => (v !== null && (v === 'none' || SHA40.test(v)) ? v : null)

export function parsePr(v: string | null): number | null | undefined {
  if (v === 'none') return null
  const m = v === null ? null : /^#([1-9][0-9]*)$/.exec(v)
  return m ? Number(m[1]) : undefined
}

export function parseReviewed(v: string | null): string | null | undefined {
  if (v === null || v === 'none') return null // an older job.md has no Reviewed line
  return SHA40.test(v) ? v : undefined
}

export function parseSpecUpdated(v: string | null): string | null | undefined {
  if (v === 'none') return null
  return v !== null && /^\d{4}-\d{2}-\d{2}T/.test(v) && !Number.isNaN(Date.parse(v)) ? v : undefined
}

const bad = (key: string): FactoryError => new FactoryError('bad-job', key, `job.md has a missing or invalid "${key}".`)

export function parseJob(text: string, dir = ''): Job {
  const num = (key: string, min: number): number => {
    const v = fieldOf(text, key)
    if (v === null || !/^[0-9]+$/.test(v) || Number(v) < min) throw bad(key)
    return Number(v)
  }
  const str = (key: string): string => fieldOf(text, key) ?? (() => { throw bad(key) })()
  const issue = num('Issue', 1)
  const worktree = str('Worktree')
  if (!worktree.startsWith('/')) throw bad('Worktree')
  const base = parseBase(fieldOf(text, 'Base'))
  if (base === null) throw bad('Base')
  const pr = parsePr(fieldOf(text, 'PR'))
  if (pr === undefined) throw bad('PR')
  const specUpdated = parseSpecUpdated(fieldOf(text, 'Spec updated'))
  if (specUpdated === undefined) throw bad('Spec updated')
  const reviewed = parseReviewed(fieldOf(text, 'Reviewed'))
  if (reviewed === undefined) throw bad('Reviewed')
  const route = parseRoute(text)
  if (route === null) throw bad('Route')
  return {
    issue,
    title: str('Title'),
    jobDir: dir,
    worktree,
    branch: str('Branch'),
    base,
    baseBranch: str('Base branch'),
    pr,
    round: num('Round', 0),
    specUpdated,
    reviewed,
    route,
  }
}

export function renderRoute(route: Route): string {
  return Object.entries(route).map(([r, m]) => `- ${r}: ${m}`).join('\n')
}

export function renderJob(j: Job): string {
  const lines = [
    `# Job #${j.issue}`,
    '',
    '## Job',
    `- Issue: ${j.issue}`,
    `- Title: ${j.title}`,
    `- Worktree: ${j.worktree}`,
    `- Branch: ${j.branch}`,
    `- Base: ${j.base}`,
    `- Base branch: ${j.baseBranch}`,
    `- PR: ${j.pr === null ? 'none' : `#${j.pr}`}`,
    `- Round: ${j.round}`,
    `- Spec updated: ${j.specUpdated ?? 'none'}`,
    `- Reviewed: ${j.reviewed ?? 'none'}`,
    '',
    '## Route',
  ]
  const r = renderRoute(j.route)
  if (r !== '') lines.push(r)
  return `${lines.join('\n')}\n`
}

export async function readJob(ctx: Ctx, n: number): Promise<Job> {
  const dir = jobDir(ctx.root, n)
  const job = parseJob(await ctx.fs.read(`${dir}/job.md`), dir)
  // Agents can edit job.md: bind the paths and the branch to the issue number.
  if (job.issue !== n) throw bad('Issue')
  if (job.worktree !== worktreeDir(ctx.root, n)) throw bad('Worktree')
  if (job.branch !== branchName(n)) throw bad('Branch')
  return job
}

export async function writeJob(ctx: Ctx, j: Job): Promise<void> {
  await ctx.fs.write(`${j.jobDir}/job.md`, renderJob(j))
}
