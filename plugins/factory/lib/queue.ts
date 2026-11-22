import type { Config } from './config.ts'
import { FactoryError } from './exec.ts'
import { addToBacklog, listCards, loadBoard, NO_NUMBER, setOption } from './project.ts'
import type { Board, Card } from './project.ts'
import { RUNNING, stateOf } from './labels.ts'
import { findMarked, isMarkerComment } from './markers.ts'
import type { Tracker } from './tracker.ts'
import type { Ctx, State, Ticket } from './types.ts'

export type QueueItem = {
  number: number
  title: string
  priority: string
  createdAt: string
  resume?: boolean
  blockedBy?: number[]
}
export type Queue = {
  running: { number: number; state: State }[]
  waiting: { number: number; state: State }[]
  ready: QueueItem[]
  blocked: QueueItem[]
  conflicts: number[]
  slots: number
  next: QueueItem[]
  warnings?: string[]
}

export function dependsOn(body: string): number[] {
  const found: number[] = []
  for (const line of body.split(/\r\n|\r|\n/)) {
    const m = /^depends on\s+(#\d+(?:\s*,\s*#\d+)*)\s*$/i.exec(line.trim())
    if (!m) continue
    for (const n of m[1]!.matchAll(/#(\d+)/g)) {
      const v = Number(n[1])
      if (!found.includes(v)) found.push(v)
    }
  }
  return found
}

const WAITING: State[] = ['needs-info', 'needs-human', 'approved', 'needs-design']
const ORDER = ['critical', 'high', 'medium', 'low'] as const
const BUG_LABELS = ['type:fix', 'bug']

const FIELD: Record<string, (typeof ORDER)[number]> = { Urgent: 'critical', High: 'high', Medium: 'medium', Low: 'low' }

function priorityOf(t: Ticket): (typeof ORDER)[number] {
  return t.priority !== undefined && Object.hasOwn(FIELD, t.priority) ? FIELD[t.priority]! : 'medium'
}

const time = (s: string): number => Date.parse(s)

// A needs-info ticket resumes when the author answered after the operator's intake question.
async function answered(tr: Tracker, t: Ticket, operator: string): Promise<boolean> {
  const full = await tr.get(t.number)
  const asked = findMarked(full.comments, 'intake', operator)
  if (!asked) return false
  return full.comments.some(c => c.author === full.author && !isMarkerComment(c) && time(c.createdAt) > time(asked.updatedAt))
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))

// Moves the open-column card of each closed issue with no status label to Done, or to Rejected when not planned.
// shortcut: one get with comments for each open-column card that is not in the backlog, upgrade to a get without comments when the board has many such cards.
async function closedCards(ctx: Ctx, tr: Tracker, number: number, tickets: Ticket[], cards: Map<string | undefined, Card>): Promise<string[]> {
  const known = new Set<string | undefined>(tickets.map(t => t.url))
  const prefix = `https://github.com/${tr.repo}/issues/`
  const warnings: string[] = []
  let board: Promise<Board> | undefined
  for (const [url, card] of cards) {
    const n = url?.startsWith(prefix) ? /^\d+$/.exec(url.slice(prefix.length))?.[0] : undefined
    if (n === undefined || known.has(url) || card.factory === 'Done' || card.factory === 'Rejected') continue
    try {
      const t = await tr.get(Number(n))
      if (t.state !== 'closed' || stateOf(t.labels) !== null) continue
      board ??= loadBoard(ctx, tr.repo.split('/')[0]!, number)
      await setOption(ctx, await board, card.item, t.stateReason === 'not_planned' ? 'Rejected' : 'Done')
    } catch (e) {
      warnings.push(`#${n}: ${messageOf(e)} Fix: Move the card by hand on the board, or wait for the next queue.`)
    }
  }
  return warnings
}

// Gives each ticket with no status label and no card a Backlog card, and moves the cards of closed issues.
async function backlogCards(ctx: Ctx, tr: Tracker, cfg: Config, tickets: Ticket[]): Promise<string[]> {
  const p = cfg.project
  if (p?.enabled !== true) return []
  const loose = tickets.filter(t => stateOf(t.labels) === null)
  if (p.number === undefined) return loose.length === 0 ? [] : [NO_NUMBER]
  let cards: Map<string | undefined, Card>
  try {
    cards = await listCards(ctx, tr.repo.split('/')[0]!, p.number)
  } catch (e) {
    return [`board list failed: ${messageOf(e)}`]
  }
  const missing = loose.filter(t => !cards.has(t.url)).map(t => t.number)
  const added = missing.length === 0 ? [] : await addToBacklog(ctx, tr, cfg, missing)
  return [...added, ...(await closedCards(ctx, tr, p.number, tickets, cards))]
}

// Checks the issue that the operator named, and gives it the factory label when it has none.
async function startable(tr: Tracker, n: number): Promise<Ticket> {
  const t = await tr.get(n)
  const s = stateOf(t.labels)
  const cause = t.kind === 'pr' ? 'a pull request' : t.state === 'closed' ? 'closed' : s === 'done' || s === 'rejected' ? s : null
  if (cause !== null) throw new FactoryError('not-startable', `#${n} is ${cause}`, 'Name an open issue that is not done or rejected.')
  if (t.labels.includes('factory')) return t
  await tr.addLabel(n, 'factory')
  return { ...t, labels: ['factory', ...t.labels] }
}

// With issue, only that issue can be in next.
export async function queue(ctx: Ctx, tr: Tracker, cfg: Config, issue?: number): Promise<Queue> {
  const named = issue === undefined ? undefined : await startable(tr, issue)
  const tickets = await tr.backlog()
  if (named && !tickets.some(t => t.number === named.number)) tickets.push(named)
  const q: Queue = { running: [], waiting: [], ready: [], blocked: [], conflicts: [], slots: 0, next: [] }
  const open = new Map<number, boolean>()
  const isOpen = async (n: number, self: number): Promise<boolean> => {
    if (n === self) return true
    // A backlog ticket is open: no call.
    if (tickets.some(t => t.number === n && t.state === 'open')) return true
    let v = open.get(n)
    if (v === undefined) {
      // Fail closed: a dependency that cannot be read counts as open.
      v = await tr.get(n).then(d => d.state !== 'closed', () => true)
      open.set(n, v)
    }
    return v
  }
  const candidates: { item: QueueItem; rank: number }[] = []
  let operator: string | undefined
  for (const t of tickets) {
    const s = stateOf(t.labels)
    if (s === 'conflict') {
      q.conflicts.push(t.number)
      continue
    }
    if (s === 'done' || s === 'rejected') continue
    if (s !== null && RUNNING.includes(s)) {
      q.running.push({ number: t.number, state: s })
      continue
    }
    const item: QueueItem = { number: t.number, title: t.title, priority: priorityOf(t), createdAt: t.createdAt }
    if (s !== null && WAITING.includes(s)) {
      if (s === 'needs-info') {
        operator ??= await tr.login()
        if (await answered(tr, t, operator)) item.resume = true
        else {
          q.waiting.push({ number: t.number, state: s })
          continue
        }
      } else {
        q.waiting.push({ number: t.number, state: s })
        continue
      }
    }
    const blockers: number[] = []
    for (const d of dependsOn(t.body)) if (await isOpen(d, t.number)) blockers.push(d)
    if (blockers.length > 0) item.blockedBy = blockers
    const bug = t.labels.some(l => BUG_LABELS.includes(l))
    candidates.push({ item, rank: (bug ? 0 : ORDER.length) + ORDER.indexOf(item.priority as (typeof ORDER)[number]) })
  }
  candidates.sort((a, b) => a.rank - b.rank || time(a.item.createdAt) - time(b.item.createdAt))
  for (const { item } of candidates) (item.blockedBy ? q.blocked : q.ready).push(item)
  q.slots = Math.max(0, cfg.concurrency - q.running.length)
  q.next = (issue === undefined ? q.ready : q.ready.filter(i => i.number === issue)).slice(0, q.slots)
  const warnings = await backlogCards(ctx, tr, cfg, tickets)
  if (warnings.length > 0) q.warnings = warnings
  return q
}
