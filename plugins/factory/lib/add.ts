import { FactoryError } from './exec.ts'
import type { Tracker } from './tracker.ts'

export type AddItem = { title: string; body: string; dependsOn?: number[]; ref?: string; dependsOnRefs?: string[] }
export type AddInput = { items: AddItem[]; park?: boolean }
export type Created = { ref: string; number: number; url: string }

const bad = (msg: string): FactoryError => new FactoryError('bad-input', msg)

export function issueSearch(t: Tracker, query: string): Promise<{ number: number; title: string; labels: string[] }[]> {
  if (typeof query !== 'string' || query.trim() === '') throw bad('query must be a non-empty string')
  return t.searchIssues(query)
}

// Check the whole input first, so a bad item creates nothing.
function validate(input: AddInput): void {
  if (!Array.isArray(input.items) || input.items.length === 0) throw bad('items must be a non-empty list')
  const seen = new Set<string>()
  input.items.forEach((it, i) => {
    const at = `item ${i + 1}`
    if (typeof it.title !== 'string' || it.title.trim() === '') throw bad(`${at}: title must not be empty`)
    if (typeof it.body !== 'string') throw bad(`${at}: body must be a string`)
    for (const n of it.dependsOn ?? []) {
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) throw bad(`${at}: dependsOn must hold positive integers, got ${JSON.stringify(n)}`)
    }
    for (const r of it.dependsOnRefs ?? []) {
      if (!seen.has(r)) throw bad(`${at}: dependsOnRefs "${r}" must name the ref of an earlier item`)
    }
    if (it.ref !== undefined) {
      if (typeof it.ref !== 'string' || it.ref === '') throw bad(`${at}: ref must not be empty`)
      if (seen.has(it.ref)) throw bad(`${at}: ref "${it.ref}" is used twice`)
      seen.add(it.ref)
    }
  })
}

export async function issueCreate(
  t: Tracker, input: AddInput, board?: (numbers: number[]) => Promise<string[]>,
): Promise<Created[] | { created: Created[]; warnings: string[] }> {
  validate(input)
  const labels = input.park === true ? [] : ['factory']
  const numbers = new Map<string, number>()
  const out: Created[] = []
  for (const [i, it] of input.items.entries()) {
    const deps = [...(it.dependsOn ?? []), ...(it.dependsOnRefs ?? []).map(r => numbers.get(r)!)]
    const lines = deps.map(n => `Depends on #${n}`)
    const body = lines.length === 0 ? it.body : `${it.body}\n\n${lines.join('\n')}`
    let number: number
    try {
      number = await t.createIssue(it.title.trim(), body, labels)
    } catch (e) {
      // Name what exists, so a retry does not create the same issues again.
      const made = out.length === 0 ? 'none' : out.map(c => `#${c.number} ${c.url}`).join(', ')
      const why = e instanceof Error ? e.message : String(e)
      throw new FactoryError('partial-create', `item ${i + 1} "${it.title.trim()}" failed: ${why}. Created before it: ${made}.`,
        `Do not create the created issues again. Retry from item ${i + 1} only.`)
    }
    if (it.ref !== undefined) numbers.set(it.ref, number)
    out.push({ ref: it.ref ?? '', number, url: `https://github.com/${t.repo}/issues/${number}` })
  }
  if (board === undefined || input.park === true) return out
  const warnings = await board(out.map(c => c.number))
  return warnings.length === 0 ? out : { created: out, warnings }
}
