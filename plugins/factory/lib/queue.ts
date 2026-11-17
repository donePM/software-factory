import type { Config } from './config.ts'
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

function priorityOf(t: Ticket, cfg: Config): (typeof ORDER)[number] {
  return ORDER.find(p => t.labels.includes(cfg.priorities[p])) ?? 'medium'
}

const time = (s: string): number => Date.parse(s)

// A needs-info ticket resumes when the author answered after the operator's intake question.
async function answered(tr: Tracker, t: Ticket, operator: string): Promise<boolean> {
  const full = await tr.get(t.number)
  const asked = findMarked(full.comments, 'intake', operator)
  if (!asked) return false
  return full.comments.some(c => c.author === full.author && !isMarkerComment(c) && time(c.createdAt) > time(asked.updatedAt))
}

export async function queue(_ctx: Ctx, tr: Tracker, cfg: Config): Promise<Queue> {
  const tickets = await tr.backlog()
  const q: Queue = { running: [], waiting: [], ready: [], blocked: [], conflicts: [], slots: 0, next: [] }
  const open = new Map<number, boolean>()
  const isOpen = async (n: number, self: number): Promise<boolean> => {
    if (n === self) return true
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
    const item: QueueItem = { number: t.number, title: t.title, priority: priorityOf(t, cfg), createdAt: t.createdAt }
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
    candidates.push({ item, rank: ORDER.indexOf(item.priority as (typeof ORDER)[number]) })
  }
  candidates.sort((a, b) => a.rank - b.rank || time(a.item.createdAt) - time(b.item.createdAt))
  for (const { item } of candidates) (item.blockedBy ? q.blocked : q.ready).push(item)
  q.slots = Math.max(0, cfg.concurrency - q.running.length)
  q.next = q.ready.slice(0, q.slots)
  return q
}
