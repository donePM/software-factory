import type { Config } from './config.ts'
import { branchName } from './jobfile.ts'
import { stripMarker } from './markers.ts'
import { boardDrift, listCards } from './project.ts'
import type { CardReader, Cards } from './project.ts'
import { escalationOf, queue, rightToLeft, STOP, stopOf } from './queue.ts'
import type { Queue } from './queue.ts'
import type { Tracker } from './tracker.ts'
import type { Comment, Ctx } from './types.ts'

// merge is true only when a merge is a valid next step (an approver escalation).
export type Cause = { reason: string; merge: boolean }

const firstLine = (text: string): string => (text.split(/\r\n|\r|\n/, 1)[0] ?? '').trim()

// Only operator comments count: an issue author can post a fake stop comment.
export function causeOf(comments: Comment[], operator: string): Cause | undefined {
  const stop = stopOf(comments, operator)
  const decision = escalationOf(comments, operator)
  if (decision !== undefined && (stop === undefined || Date.parse(decision.updatedAt) > Date.parse(stop.createdAt))) {
    const body = stripMarker(decision.body)
    const question = /^## Question\s*$\s*^(.*\S.*)$/m.exec(body)?.[1]
    return { reason: `Approver escalated: ${firstLine(question ?? 'see the PR')}`, merge: true }
  }
  return stop === undefined ? undefined : { reason: firstLine(stop.body.slice(STOP.length)), merge: false }
}

// The stop comment of advanceBuild: build refuses a new round until maxRounds goes up.
export const atRoundLimit = (cause: Cause | undefined): boolean => /^Round \d+ reached the round limit of \d+\.$/.test(cause?.reason ?? '')

const label = (n: number, titles: Record<number, string>): string => (titles[n] ? `#${n} ${titles[n]}` : `#${n}`)

// The next step of a waiting row, without the label and the PR link. The status text and the snapshot share it.
export function hintOf(repo: string, n: number, state: string, cause: Cause | undefined, autoMerge: boolean, closed: number[]): string {
  // queue refuses a closed issue: the sweep of a plain run moves it on.
  const run = closed.includes(n) ? '/factory:run' : `/factory:run ${n}`
  if (state === 'conflict') return `conflict: remove all status labels but one. Then run /factory:run ${n}`
  if (state === 'approved') return `approved: ${autoMerge ? 'the factory merges it' : `/factory:merge ${n}`}`
  if (state === 'needs-human' && cause?.merge === true) return `needs you: ${cause.reason} · decide. To merge, run /factory:merge ${n}. To rework, comment in the issue. Then run ${run}`
  if (state === 'needs-human' && atRoundLimit(cause)) return `needs you: ${cause?.reason} · increase maxRounds in .factory/config.json. Then run ${run}`
  if (state === 'needs-human' && cause !== undefined) return `needs you: ${cause.reason} · fix the cause. Then run ${run}`
  if (state === 'needs-human') return `needs you: answer in the issue. Then run ${run}`
  if (state === 'needs-info') return 'needs info: author answers in the issue'
  // needs-design and any state without its own hint
  return `${state}: see the issue https://github.com/${repo}/issues/${n}`
}

// The command that the person copies next, or null when the next step is not a command.
export function commandOf(n: number, state: string, autoMerge: boolean, closed: number[]): string | null {
  if (state === 'approved') return autoMerge ? null : `/factory:merge ${n}`
  if (state === 'needs-human') return closed.includes(n) ? '/factory:run' : `/factory:run ${n}`
  return state === 'conflict' ? `/factory:run ${n}` : null
}

// prs maps an issue number to its PR number; titles maps an issue number to its title.
export function statusText(repo: string, q: Queue, prs: Record<number, number>, concurrency: number, titles: Record<number, string> = {}, causes: Record<number, Cause> = {}, drift: string[] = [], autoMerge = false, closed: number[] = []): string {
  const lines = [`Factory · ${repo}  ${q.running.length}/${concurrency} slots`]
  const section = (name: string, rows: string[]): void => {
    lines.push('', name, ...rows.map(r => `  ${r}`))
  }
  if (q.ready.length > 0) section(`Ready (${q.ready.length})`, q.ready.map(i => `#${i.number} ${i.title}`))
  if (q.blocked.length > 0) section(`Blocked (${q.blocked.length})`, q.blocked.map(i => `#${i.number} ${i.title}  waits for ${(i.blockedBy ?? []).map(d => `#${d}`).join(', ')}`))
  if (q.running.length > 0) section('Running', q.running.map(r => `${label(r.number, titles)}  ${r.state}`))
  const rows: string[] = []
  for (const w of [...q.waiting].sort(rightToLeft)) {
    const pr = prs[w.number]
    const link = pr === undefined || (w.state !== 'approved' && w.state !== 'needs-human') ? '' : ` (https://github.com/${repo}/pull/${pr})`
    rows.push(`${label(w.number, titles)}  ${hintOf(repo, w.number, w.state, causes[w.number], autoMerge, closed)}${link}`)
  }
  for (const n of q.conflicts) rows.push(`${label(n, titles)}  ${hintOf(repo, n, 'conflict', undefined, autoMerge, closed)}`)
  if (rows.length > 0) section('Waiting for you', rows)
  if (q.running.length === 0 && q.ready.length === 0 && q.blocked.length === 0 && rows.length === 0) {
    lines.push('', 'Nothing to do. Add work with /factory:add <text>')
  } else if (q.heldBy.length > 0 && q.ready.length > 0) {
    lines.push('', `New issues wait for ${q.heldBy.map(n => `#${n}`).join(', ')}. Finish these jobs first.`)
  } else if (q.running.length === 0 && q.ready.length > 0) {
    lines.push('', 'Start the ready work with /factory:run')
  }
  if (drift.length > 0) section('Board differs from labels', drift)
  return lines.join('\n')
}

export type StatusData = {
  q: Queue
  prs: Record<number, number>
  titles: Record<number, string>
  causes: Record<number, Cause>
  drift: string[]
  closed: number[]
}

// One gh call per waiting ticket that can have a PR, and one more per needs-human ticket for its cause.
// A failed lookup leaves the PR or the cause out. With the project on, one more call reads the board.
export async function statusData(ctx: Ctx, base: Tracker, cfg: Config): Promise<StatusData> {
  // The queue and the board check share one backlog read and one card read.
  const backlog = base.backlog()
  // The queue and the cause lookup share one read of each needs-human ticket.
  const gets = new Map<number, ReturnType<Tracker['get']>>()
  const get = (n: number): ReturnType<Tracker['get']> => {
    let p = gets.get(n)
    if (p === undefined) gets.set(n, (p = base.get(n)))
    return p
  }
  const tr: Tracker = { ...base, backlog: () => backlog, get }
  let cards: Promise<Cards> | undefined
  const read: CardReader = (owner, n) => (cards ??= listCards(ctx, owner, n))
  const q = await queue(ctx, tr, cfg, undefined, read)
  const titles: Record<number, string> = {}
  const tickets = await backlog
  for (const t of tickets) titles[t.number] = t.title
  const prs: Record<number, number> = {}
  const causes: Record<number, Cause> = {}
  for (const w of q.waiting) {
    if (w.state !== 'approved' && w.state !== 'needs-human') continue
    const pr = await tr.findPr(branchName(w.number)).catch(() => null)
    if (pr) prs[w.number] = pr.number
    if (w.state !== 'needs-human') continue
    const ticket = await tr.get(w.number).catch(() => null)
    const cause = ticket === null ? undefined : causeOf(ticket.comments, await tr.login())
    if (cause !== undefined) causes[w.number] = cause
  }
  return { q, prs, titles, causes, drift: await boardDrift(ctx, tr, cfg, tickets, read), closed: tickets.filter(t => t.state === 'closed').map(t => t.number) }
}

export const renderStatus = (repo: string, cfg: Config, d: StatusData): string =>
  statusText(repo, d.q, d.prs, cfg.concurrency, d.titles, d.causes, d.drift, cfg.merge.auto === true, d.closed)

export const statusFor = async (ctx: Ctx, tr: Tracker, cfg: Config): Promise<string> => renderStatus(tr.repo, cfg, await statusData(ctx, tr, cfg))
