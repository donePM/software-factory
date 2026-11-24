import { loadConfig } from './config.ts'
import type { Config } from './config.ts'
import { githubTracker, repoFromUrl } from './github.ts'
import { fieldOf, jobDir, parseRoute } from './jobfile.ts'
import { commandOf, hintOf, statusData } from './status.ts'
import type { StatusData } from './status.ts'
import type { Ctx, Reviewer } from './types.ts'

export type JobRound = { round: number | null; reviewsDone: Reviewer[] }
export type Snapshot = {
  repo: string
  time: string
  slots: { used: number; total: number }
  ready: number
  running: ({ number: number; title: string; state: string } & JobRound)[]
  waiting: { number: number; title: string; state: string; next: string; link: string; command: string | null }[]
}

export function statusLine(s: Snapshot): string | undefined {
  if (s.running.length === 0 && s.waiting.length === 0) return undefined
  const k = s.waiting.length
  return [
    `Factory ${s.slots.used}/${s.slots.total} slots`,
    ...s.running.map(r => `#${r.number} ${r.state}${r.round === null ? '' : ` R${r.round}`}`),
    ...(k === 0 ? [] : [k === 1 ? '1 waits for you' : `${k} wait for you`]),
  ].join(' · ')
}

export const statusPath = (root: string): string => `${root}/.factory/status.json`

export function buildSnapshot(repo: string, cfg: { concurrency: number; merge: { auto?: boolean } }, d: StatusData, jobs: Record<number, JobRound>, now: Date): Snapshot {
  const auto = cfg.merge.auto === true
  const row = (number: number, state: string) => {
    const pr = d.prs[number]
    return {
      number,
      title: d.titles[number] ?? '',
      state,
      next: hintOf(repo, number, state, d.causes[number], auto, d.closed),
      link: pr === undefined ? `https://github.com/${repo}/issues/${number}` : `https://github.com/${repo}/pull/${pr}`,
      command: commandOf(number, state, auto, d.closed),
    }
  }
  return {
    repo,
    time: now.toISOString(),
    slots: { used: d.q.running.length, total: cfg.concurrency },
    ready: d.q.ready.length,
    running: d.q.running.map(r => ({ number: r.number, title: d.titles[r.number] ?? '', state: r.state, ...(jobs[r.number] ?? { round: null, reviewsDone: [] }) })),
    waiting: [...d.q.waiting.map(w => row(w.number, w.state)), ...d.q.conflicts.map(n => row(n, 'conflict'))],
  }
}

// Reads the round of job.md and the review files of the routed reviewers in that round.
async function jobRound(ctx: Ctx, n: number): Promise<JobRound> {
  const dir = jobDir(ctx.root, n)
  if (!(await ctx.fs.exists(`${dir}/job.md`))) return { round: null, reviewsDone: [] }
  const md = await ctx.fs.read(`${dir}/job.md`)
  const round = Number(fieldOf(md, 'Round'))
  if (!Number.isInteger(round) || round < 1) return { round: null, reviewsDone: [] }
  const reviewsDone: Reviewer[] = []
  for (const r of Object.keys(parseRoute(md) ?? {}) as Reviewer[]) {
    if (await ctx.fs.exists(`${dir}/round-${round}/review-${r}.md`)) reviewsDone.push(r)
  }
  return { round, reviewsDone }
}

export async function writeSnapshot(ctx: Ctx, repo: string, cfg: Config, d: StatusData): Promise<void> {
  const jobs: Record<number, JobRound> = {}
  for (const r of d.q.running) jobs[r.number] = await jobRound(ctx, r.number)
  const snapshot = buildSnapshot(repo, cfg, d, jobs, ctx.now())
  await ctx.fs.write(statusPath(ctx.root), `${JSON.stringify(snapshot, null, 2)}\n`)
  ctx.status?.(statusLine(snapshot))
}

// The board stays off: a write for display must not add Backlog cards.
// shortcut: each refresh reads the backlog again, upgrade to a cache when the rate limit is a problem
export async function refreshSnapshot(ctx: Ctx): Promise<void> {
  const cfg = await loadConfig(ctx)
  const off: Config = { ...cfg, project: { enabled: false } }
  const tr = githubTracker(ctx, repoFromUrl(cfg.tracker.url))
  await writeSnapshot(ctx, tr.repo, off, await statusData(ctx, tr, off))
}
