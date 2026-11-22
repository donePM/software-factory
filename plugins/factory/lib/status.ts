import type { Config } from './config.ts'
import { branchName } from './jobfile.ts'
import { findMarked, stripMarker } from './markers.ts'
import { boardDrift, listCards } from './project.ts'
import type { CardReader, Cards } from './project.ts'
import { queue } from './queue.ts'
import type { Queue } from './queue.ts'
import type { Tracker } from './tracker.ts'
import type { Comment, Ctx } from './types.ts'

// merge is true only when a merge is a valid next step (an approver escalation).
export type Cause = { reason: string; merge: boolean }

const STOP = 'Factory stopped: '
const firstLine = (text: string): string => (text.split(/\r\n|\r|\n/, 1)[0] ?? '').trim()

// Only operator comments count: an issue author can post a fake stop comment.
export function causeOf(comments: Comment[], operator: string): Cause | undefined {
  const stop = comments.filter(c => c.author === operator && c.body.startsWith(STOP)).at(-1)
  const decision = findMarked(comments, 'decision', operator)
  const body = decision === undefined ? '' : stripMarker(decision.body)
  if (decision !== undefined && /^DECISION: ESCALATE\s*$/m.test(body)
    && (stop === undefined || Date.parse(decision.updatedAt) > Date.parse(stop.createdAt))) {
    const question = /^## Question\s*$\s*^(.*\S.*)$/m.exec(body)?.[1]
    return { reason: `Approver escalated: ${firstLine(question ?? 'see the PR')}`, merge: true }
  }
  return stop === undefined ? undefined : { reason: firstLine(stop.body.slice(STOP.length)), merge: false }
}

// The stop comment of advanceBuild: build refuses a new round until maxRounds goes up.
export const atRoundLimit = (cause: Cause | undefined): boolean => /^Round \d+ reached the round limit of \d+\.$/.test(cause?.reason ?? '')

const label = (n: number, titles: Record<number, string>): string => (titles[n] ? `#${n} ${titles[n]}` : `#${n}`)

// prs maps an issue number to its PR number; titles maps an issue number to its title.
export function statusText(repo: string, q: Queue, prs: Record<number, number>, concurrency: number, titles: Record<number, string> = {}, causes: Record<number, Cause> = {}, drift: string[] = []): string {
  const lines = [`Factory · ${repo}  ${q.running.length}/${concurrency} slots`]
  const section = (name: string, rows: string[]): void => {
    lines.push('', name, ...rows.map(r => `  ${r}`))
  }
  if (q.ready.length > 0) section(`Ready (${q.ready.length})`, q.ready.map(i => `#${i.number} ${i.title}`))
  if (q.running.length > 0) section('Running', q.running.map(r => `${label(r.number, titles)}  ${r.state}`))
  const rows: string[] = []
  for (const w of q.waiting) {
    const n = w.number
    const pr = prs[n]
    const cause = causes[n]
    const link = pr === undefined ? '' : ` (https://github.com/${repo}/pull/${pr})`
    if (w.state === 'approved') {
      rows.push(`${label(n, titles)}  approved: /factory:merge ${n}${link}`)
    } else if (w.state === 'needs-human' && cause?.merge === true) {
      rows.push(`${label(n, titles)}  needs you: ${cause.reason} · decide. Then run /factory:merge ${n}${link}`)
    } else if (w.state === 'needs-human' && atRoundLimit(cause)) {
      rows.push(`${label(n, titles)}  needs you: ${cause?.reason} · increase maxRounds in .factory/config.json. Then run /factory:run ${n}${link}`)
    } else if (w.state === 'needs-human' && cause !== undefined) {
      rows.push(`${label(n, titles)}  needs you: ${cause.reason} · fix the cause. Then run /factory:run ${n}${link}`)
    } else if (w.state === 'needs-human') {
      rows.push(`${label(n, titles)}  needs you: answer in the issue. Then run /factory:run ${n}${link}`)
    } else if (w.state === 'needs-info') {
      rows.push(`${label(n, titles)}  needs info: author answers in the issue`)
    } else {
      // needs-design and any state without its own hint
      rows.push(`${label(n, titles)}  ${w.state}: see the issue https://github.com/${repo}/issues/${n}`)
    }
  }
  if (rows.length > 0) section('Waiting for you', rows)
  if (q.running.length === 0 && q.ready.length === 0 && rows.length === 0) {
    lines.push('', 'Nothing to do. Add work with /factory:add <text>')
  } else if (q.running.length === 0 && q.ready.length > 0) {
    lines.push('', 'Start the ready work with /factory:run')
  }
  if (drift.length > 0) section('Board differs from labels', drift)
  return lines.join('\n')
}

// One gh call per waiting ticket that can have a PR, and one more per needs-human ticket for its cause.
// A failed lookup leaves the PR or the cause out. With the project on, one more call reads the board.
export async function statusFor(ctx: Ctx, base: Tracker, cfg: Config): Promise<string> {
  // The queue and the board check share one backlog read and one card read.
  const backlog = base.backlog()
  const tr: Tracker = { ...base, backlog: () => backlog }
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
  return statusText(tr.repo, q, prs, cfg.concurrency, titles, causes, await boardDrift(ctx, tr, cfg, tickets, read))
}
