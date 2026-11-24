import type { Config } from './config.ts'
import { FactoryError } from './exec.ts'
import { addToBacklog, listCards, loadBoard, NO_NUMBER, setOption, warningOf } from './project.ts'
import type { Board, CardReader, Cards } from './project.ts'
import { RUNNING, STATUS, stateOf } from './labels.ts'
import { findMarked, isMarkerComment, stripMarker } from './markers.ts'
import type { Tracker } from './tracker.ts'
import type { Comment, Ctx, State, Ticket } from './types.ts'

export type QueueItem = {
  number: number
  title: string
  priority: string
  createdAt: string
  resume?: boolean
  unblocked?: boolean
  blockedBy?: number[]
}
export type Queue = {
  running: { number: number; state: State }[]
  waiting: { number: number; state: State }[]
  ready: QueueItem[]
  blocked: QueueItem[]
  conflicts: number[]
  // The approved and needs-human jobs that keep a plain run from a new issue.
  heldBy: number[]
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

// Right to left on the board: the job nearest to done comes first, then the lower number.
export const rightToLeft = (a: { number: number; state: State }, b: { number: number; state: State }): number =>
  STATUS.indexOf(b.state) - STATUS.indexOf(a.state) || a.number - b.number

const HOLDS: State[] = ['approved', 'needs-human']
export const STOP = 'Factory stopped: '

// Only operator comments count: an issue author can post a fake stop or decision comment.
export function stopOf(comments: Comment[], operator: string): Comment | undefined {
  return comments.filter(c => c.author === operator && c.body.startsWith(STOP)).at(-1)
}

export function escalationOf(comments: Comment[], operator: string): Comment | undefined {
  const d = findMarked(comments, 'decision', operator)
  return d !== undefined && /^DECISION: ESCALATE\s*$/m.test(stripMarker(d.body)) ? d : undefined
}

// A needs-human job is unblocked when the operator commented or changed the spec after the stop or escalation.
function unblocked(comments: Comment[], operator: string): boolean {
  const stop = stopOf(comments, operator)
  const esc = escalationOf(comments, operator)
  if (stop === undefined && esc === undefined) return false
  const cause = Math.max(stop === undefined ? -Infinity : time(stop.createdAt), esc === undefined ? -Infinity : time(esc.updatedAt))
  const spec = findMarked(comments, 'spec', operator)
  if (spec !== undefined && time(spec.updatedAt) > cause) return true
  return comments.some(c => c.author === operator && !isMarkerComment(c) && !c.body.startsWith(STOP) && time(c.createdAt) > cause)
}

const WAITING: State[] = ['needs-info', 'needs-human', 'approved', 'needs-design']
const time = (s: string): number => Date.parse(s)
const ORDER = ['critical', 'high', 'medium', 'low'] as const
const BUG_LABELS = ['type:fix', 'bug']

const FIELD: Record<string, (typeof ORDER)[number]> = { Urgent: 'critical', High: 'high', Medium: 'medium', Low: 'low' }

function priorityOf(t: Ticket): (typeof ORDER)[number] {
  return t.priority !== undefined && Object.hasOwn(FIELD, t.priority) ? FIELD[t.priority]! : 'medium'
}

// A needs-info ticket resumes when the author answered after the operator's intake question.
async function answered(tr: Tracker, t: Ticket, operator: string): Promise<boolean> {
  const full = await tr.get(t.number)
  const asked = findMarked(full.comments, 'intake', operator)
  if (!asked) return false
  return full.comments.some(c => c.author === full.author && !isMarkerComment(c) && time(c.createdAt) > time(asked.updatedAt))
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))

// Moves the open-column card of each closed issue to its final column.
// factory:done gives Done and factory:rejected gives Rejected. With no status label, not planned gives Rejected, else Done.
// shortcut: one get with comments for each open-column card that is not in the backlog, upgrade to a get without comments when the board has many such cards.
async function closedCards(ctx: Ctx, tr: Tracker, number: number, tickets: Ticket[], cards: Cards): Promise<string[]> {
  const known = new Set<string | undefined>(tickets.map(t => t.url))
  const prefix = `https://github.com/${tr.repo}/issues/`
  const warnings: string[] = []
  let board: Promise<Board> | undefined
  for (const [url, card] of cards) {
    const n = url?.startsWith(prefix) ? /^\d+$/.exec(url.slice(prefix.length))?.[0] : undefined
    if (n === undefined || known.has(url) || card.factory === 'Done' || card.factory === 'Rejected') continue
    try {
      const t = await tr.get(Number(n))
      const s = stateOf(t.labels)
      if (t.state !== 'closed' || (s !== null && s !== 'done' && s !== 'rejected')) continue
      board ??= loadBoard(ctx, tr.repo.split('/')[0]!, number)
      await setOption(ctx, await board, card.id, s === 'rejected' || (s === null && t.stateReason === 'not_planned') ? 'Rejected' : 'Done')
    } catch (e) {
      warnings.push(`#${n}: ${messageOf(e)} Fix: Move the card by hand on the board, or wait for the next queue.`)
    }
  }
  return warnings
}

// Gives each ticket with no status label and no card a Backlog card, and moves the cards of closed issues.
async function backlogCards(ctx: Ctx, tr: Tracker, cfg: Config, tickets: Ticket[], read: CardReader): Promise<string[]> {
  const p = cfg.project
  if (p?.enabled !== true) return []
  const loose = tickets.filter(t => stateOf(t.labels) === null)
  if (p.number === undefined) return loose.length === 0 ? [] : [NO_NUMBER]
  let cards: Cards
  try {
    // shortcut: each queue call reads the board again, upgrade to a cache across tool calls when the rate limit stays a problem
    cards = await read(tr.repo.split('/')[0]!, p.number)
  } catch (e) {
    return [`board list failed: ${warningOf(e)}`]
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
export async function queue(ctx: Ctx, tr: Tracker, cfg: Config, issue?: number, read: CardReader = (o, n) => listCards(ctx, o, n)): Promise<Queue> {
  const named = issue === undefined ? undefined : await startable(tr, issue)
  const tickets = await tr.backlog()
  if (named && !tickets.some(t => t.number === named.number)) tickets.push(named)
  const q: Queue = { running: [], waiting: [], ready: [], blocked: [], conflicts: [], heldBy: [], slots: 0, next: [] }
  // The backlog list can be older than a close, so each dependency gets its own read.
  // shortcut: one get with comments for each distinct dependency, upgrade to a get without comments when the backlog has many dependencies
  const deps = new Map<number, Promise<boolean | string>>()
  const depWarnings: string[] = []
  const isOpen = async (n: number, self: number): Promise<boolean> => {
    if (n === self) return true
    let p = deps.get(n)
    if (p === undefined) {
      p = tr.get(n).then(d => d.state !== 'closed', messageOf)
      deps.set(n, p)
    }
    const v = await p
    if (typeof v === 'boolean') return v
    // Fail closed: a dependency that cannot be read counts as open.
    depWarnings.push(`#${self} waits for #${n}. The factory cannot read #${n}: ${v} Fix: Make sure that #${n} exists. Then run /factory:run again.`)
    return true
  }
  const candidates: { item: QueueItem; rank: number }[] = []
  const resumed: QueueItem[] = []
  const humanWarnings: string[] = []
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
      } else if (s === 'needs-human' && t.state !== 'closed') {
        // Only an open ticket can unblock: the cleanup sweep moves a closed one on.
        operator ??= await tr.login()
        const op = operator
        // Fail closed: a ticket that cannot be read stays waiting and holds new issues.
        const free = await tr.get(t.number).then(full => unblocked(full.comments, op), e => {
          humanWarnings.push(`#${t.number}: the factory cannot read the comments: ${messageOf(e)} Fix: Run /factory:run again later.`)
          return false
        })
        if (free) resumed.push({ ...item, unblocked: true })
        else q.waiting.push({ number: t.number, state: s })
        continue
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
  q.ready.push(...resumed.sort((a, b) => a.number - b.number))
  for (const { item } of candidates) (item.blockedBy ? q.blocked : q.ready).push(item)
  q.running.sort(rightToLeft)
  q.waiting.sort(rightToLeft)
  // shortcut: a holding job holds new issues until a human acts, upgrade to a config option for a maximum wait when operators ask for it.
  q.heldBy = q.waiting.filter(w => HOLDS.includes(w.state)).map(w => w.number)
  q.slots = Math.max(0, cfg.concurrency - q.running.length)
  const pool = issue !== undefined ? q.ready.filter(i => i.number === issue) : q.heldBy.length > 0 ? q.ready.filter(i => i.unblocked) : q.ready
  q.next = pool.slice(0, q.slots)
  const warnings = [...depWarnings, ...humanWarnings, ...(await backlogCards(ctx, tr, cfg, tickets, read))]
  if (warnings.length > 0) q.warnings = warnings
  return q
}
