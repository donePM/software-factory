import { lacksScope } from './doctor.ts'
import { FactoryError, must } from './exec.ts'
import { jobDir, readJob, writeJob } from './jobfile.ts'
import type { BoardIds } from './jobfile.ts'
import { stateOf } from './labels.ts'
import type { Config } from './config.ts'
import type { Tracker } from './tracker.ts'
import type { Ctx, State, Ticket } from './types.ts'

export const FACTORY_OPTIONS = [
  'Backlog', 'Intake', 'Spec', 'Design', 'Build', 'Review', 'Waiting', 'Ready to merge', 'Docs', 'Done', 'Rejected',
] as const
export type FactoryOption = (typeof FACTORY_OPTIONS)[number]

const OPTION: Record<State, FactoryOption> = {
  intake: 'Intake', 'needs-info': 'Waiting', fastlane: 'Build', spec: 'Spec', 'needs-design': 'Design', build: 'Build',
  review: 'Review', 'needs-human': 'Waiting', approved: 'Ready to merge', docs: 'Docs', done: 'Done', rejected: 'Rejected',
}

export const optionFor = (s: State | null): FactoryOption => (s === null ? 'Backlog' : OPTION[s])

export type ProjectReport = { number?: number; url?: string; viewSteps: string[]; added: number; warnings: string[] }
export type Board = { owner: string; number: number; id: string; fieldId: string; options: Map<string, string> }

type RawProject = { number: number; id: string; url: string }
type RawField = { id: string; name: string; options?: { id: string; name: string }[] }

const FIELD = 'Factory'
export const NO_NUMBER = 'project.number is missing. Run /factory:setup project.'

const project = async <T>(ctx: Ctx, argv: string[]): Promise<T> =>
  JSON.parse(await must(ctx, ['gh', 'project', ...argv, '--format', 'json'])) as T

const factoryField = async (ctx: Ctx, owner: string, n: number): Promise<RawField | undefined> =>
  (await project<{ fields: RawField[] }>(ctx, ['field-list', String(n), '--owner', owner])).fields.find(f => f.name === FIELD)

export async function addItem(ctx: Ctx, board: Board, url: string): Promise<string> {
  return (await project<{ id: string }>(ctx, ['item-add', String(board.number), '--owner', board.owner, '--url', url])).id
}

export async function setOption(ctx: Ctx, board: Board, item: string, option: FactoryOption): Promise<void> {
  const id = board.options.get(option)
  if (id === undefined) throw new FactoryError('project-option', `the field ${FIELD} has no option "${option}"`)
  await must(ctx, [
    'gh', 'project', 'item-edit', '--id', item, '--project-id', board.id, '--field-id', board.fieldId, '--single-select-option-id', id,
  ])
}

// shortcut: gh and the API cannot create a project view, upgrade when gh or the GraphQL API can create one.
const viewSteps = (url: string): string[] => [
  `Open ${url}.`,
  'Click "New view" and select "Board".',
  'Open the view menu. Set "Column by: Factory".',
  'Click "Save".',
]

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))
// A board failure as a warning, with the fix when the error has one.
export const warningOf = (e: unknown): string => `${messageOf(e)}${e instanceof FactoryError && e.fix !== undefined ? ` Fix: ${e.fix}` : ''}`
const rateLimited = (e: unknown): boolean => e instanceof FactoryError && e.code === 'rate-limited'

const boardOf = (owner: string, p: RawProject, field: RawField): Board =>
  ({ owner, number: p.number, id: p.id, fieldId: field.id, options: new Map(field.options?.map(o => [o.name, o.id])) })

async function loadBoard(ctx: Ctx, owner: string, number: number): Promise<Board> {
  const p = await project<RawProject>(ctx, ['view', String(number), '--owner', owner])
  const field = await factoryField(ctx, owner, p.number)
  if (field === undefined) throw new FactoryError('project-field', `the project has no field ${FIELD}`)
  return boardOf(owner, p, field)
}

// The cached ids of the card, or undefined when job.md is missing or bad.
async function cachedIds(ctx: Ctx, n: number): Promise<BoardIds | undefined> {
  if (!(await ctx.fs.exists(`${jobDir(ctx.root, n)}/job.md`))) return undefined
  return readJob(ctx, n).then(j => j.board, () => undefined)
}

// The ids never change. A write that fails with them needs the operator, not a retry.
// A rate limit is no cause to delete the ids.
async function editCached(ctx: Ctx, n: number, ids: BoardIds, option: string): Promise<void> {
  try {
    await must(ctx, [
      'gh', 'project', 'item-edit', '--id', ids.item, '--project-id', ids.project, '--field-id', ids.field, '--single-select-option-id', option,
    ])
  } catch (e) {
    if (rateLimited(e)) throw e
    throw new FactoryError('board-write', `the board write with the ids in job.md failed: ${messageOf(e)}`,
      `Delete the ## Board section in ${jobDir(ctx.root, n)}/job.md. The next transition looks the ids up again.`)
  }
}

export type Boarded = { tracker: Tracker; warnings: string[]; save: () => Promise<void> }

// After each label change, sets the Factory option of the issue card. A board failure becomes a warning.
// With the ids in job.md a change is one GraphQL mutation. save() writes the ids that this tracker looked up.
export function withBoard(ctx: Ctx, tracker: Tracker, cfg: Pick<Config, 'project'>): Boarded {
  const warnings: string[] = []
  const found = new Map<number, BoardIds>()
  const save = async (): Promise<void> => {
    for (const [n, board] of found) {
      try {
        if (await ctx.fs.exists(`${jobDir(ctx.root, n)}/job.md`)) await writeJob(ctx, { ...(await readJob(ctx, n)), board })
      } catch (e) {
        warnings.push(`#${n}: the board ids were not saved: ${messageOf(e)}`)
      }
    }
    found.clear()
  }
  const p = cfg.project
  if (p?.enabled !== true) return { tracker, warnings, save }
  let board: Promise<Board> | undefined
  const setState: Tracker['setState'] = async (n, to, opts) => {
    const from = await tracker.setState(n, to, opts)
    // The card is in the right column already.
    if (from !== undefined && optionFor(from) === optionFor(to)) return from
    if (p.number === undefined) {
      warnings.push(NO_NUMBER)
      return from
    }
    try {
      const ids = found.get(n) ?? (await cachedIds(ctx, n))
      const cached = ids?.options[optionFor(to)]
      if (ids !== undefined && cached !== undefined) {
        await editCached(ctx, n, ids, cached)
        return from
      }
      board ??= loadBoard(ctx, tracker.repo.split('/')[0]!, p.number)
      const b = await board
      const item = await addItem(ctx, b, `https://github.com/${tracker.repo}/issues/${n}`)
      found.set(n, { project: b.id, field: b.fieldId, item, options: Object.fromEntries(b.options) })
      await setOption(ctx, b, item, optionFor(to))
    } catch (e) {
      warnings.push(`#${n}: ${warningOf(e)}`)
    }
    return from
  }
  return { tracker: { ...tracker, setState }, warnings, save }
}

// Adds a Backlog card for each issue. A board failure becomes a warning.
export async function addToBacklog(ctx: Ctx, tracker: Pick<Tracker, 'repo'>, cfg: Pick<Config, 'project'>, numbers: number[]): Promise<string[]> {
  const p = cfg.project
  if (p?.enabled !== true) return []
  if (p.number === undefined) return [NO_NUMBER]
  let board: Board
  try {
    board = await loadBoard(ctx, tracker.repo.split('/')[0]!, p.number)
  } catch (e) {
    return [warningOf(e)]
  }
  const warnings: string[] = []
  for (const n of numbers) {
    try {
      await setOption(ctx, board, await addItem(ctx, board, `https://github.com/${tracker.repo}/issues/${n}`), 'Backlog')
    } catch (e) {
      warnings.push(`#${n}: ${warningOf(e)}`)
      // More calls make a secondary rate limit last longer.
      if (rateLimited(e)) break
    }
  }
  return warnings
}

type RawItem = { content?: { url?: string }; factory?: string }
export type Cards = Map<string | undefined, string | undefined>
export type CardReader = (owner: string, number: number) => Promise<Cards>

// The gh project calls (GraphQL) of each tool, with the board on:
// - queue: one item-list when a ticket has no status label. Then view and field-list once, and item-add and item-edit for each new card.
// - status: the queue calls. The board check uses the same item-list, or makes one item-list when the queue made none.
// - job_sync and job_advance: one item-edit for each label change that moves the card, with the ids in job.md.
//   With no ids: view and field-list once, then item-add and item-edit.
// item-list --limit 1000 can make several GraphQL requests, one for each page of cards.

// Maps the issue URL of each card to its Factory option.
export async function listCards(ctx: Ctx, owner: string, number: number): Promise<Cards> {
  // shortcut: one item-list page of 1000 cards, upgrade to paging when a board has more
  const { items } = await project<{ items: RawItem[] }>(ctx, ['item-list', String(number), '--owner', owner, '--limit', '1000'])
  return new Map(items.map(i => [i.content?.url, i.factory]))
}

// Reads the board only. The label wins, so each line tells the operator where to move the card.
export async function boardDrift(
  ctx: Ctx, tracker: Tracker, cfg: Pick<Config, 'project'>, tickets: Ticket[], read: CardReader = (o, n) => listCards(ctx, o, n),
): Promise<string[]> {
  const p = cfg.project
  if (p?.enabled !== true) return []
  if (p.number === undefined) return [NO_NUMBER]
  try {
    const cards = await read(tracker.repo.split('/')[0]!, p.number)
    const lines: string[] = []
    for (const t of tickets) {
      const state = stateOf(t.labels)
      // shortcut: a ticket with no card is not reported, upgrade when cards go missing
      if (state === 'conflict' || !cards.has(t.url)) continue
      const want = optionFor(state)
      const has = cards.get(t.url)
      if (has !== want) lines.push(`#${t.number} board says ${has ?? 'nothing'}, label says ${state ?? 'none'}: move the card to ${want}`)
    }
    return lines
  } catch (e) {
    return [`board check failed: ${warningOf(e)}`]
  }
}

// Connects the project (creates it when number is undefined) and adds each open ticket. A failure becomes a warning.
export async function connectProject(ctx: Ctx, tracker: Tracker, number: number | undefined): Promise<ProjectReport> {
  const report: ProjectReport = { viewSteps: [], added: 0, warnings: [] }
  const auth = await ctx.run(['gh', 'auth', 'status'])
  if (lacksScope(`${auth.stdout}\n${auth.stderr}`, 'project')) {
    report.warnings.push('The gh token has no project scope. Fix: gh auth refresh -s project')
    return report
  }
  const owner = tracker.repo.split('/')[0]!
  try {
    const p = number === undefined
      ? await project<RawProject>(ctx, ['create', '--owner', owner, '--title', `Factory ${tracker.repo}`])
      : await project<RawProject>(ctx, ['view', String(number), '--owner', owner])
    report.number = p.number
    report.url = p.url
    report.viewSteps = viewSteps(p.url)
    let field = await factoryField(ctx, owner, p.number)
    if (field === undefined) {
      await project(ctx, [
        'field-create', String(p.number), '--owner', owner, '--name', FIELD,
        '--data-type', 'SINGLE_SELECT', '--single-select-options', FACTORY_OPTIONS.join(','),
      ])
      field = await factoryField(ctx, owner, p.number)
      if (field === undefined) throw new FactoryError('project-field', `the field ${FIELD} is missing after field-create`)
    }
    const board = boardOf(owner, p, field)
    // shortcut: setup does not add missing options to an existing field, upgrade when operators ask for it.
    const missing = FACTORY_OPTIONS.filter(o => !board.options.has(o))
    if (missing.length > 0) report.warnings.push(`The field ${FIELD} has no option ${missing.join(', ')}. Add the options in the project settings.`)
    // shortcut: two calls per ticket in series are slow for many tickets, upgrade to a batch when setup takes too long.
    for (const t of await tracker.backlog()) {
      const state = stateOf(t.labels)
      try {
        const item = await addItem(ctx, board, t.url)
        report.added++
        if (state === 'conflict') report.warnings.push(`#${t.number} has more than one status label. Its card has no ${FIELD} value.`)
        else await setOption(ctx, board, item, optionFor(state))
      } catch (e) {
        report.warnings.push(`#${t.number}: ${warningOf(e)}`)
      }
    }
  } catch (e) {
    report.warnings.push(warningOf(e))
  }
  return report
}
