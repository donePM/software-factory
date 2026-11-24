import type { Snapshot } from './view.ts'

export const PANE = 'factory'
export type PaneRow = { key: string; text: string; bold?: true; href?: string; copy?: string }

// Any text that is not a snapshot object gives null, so the pane never fails on a bad file.
export function parseSnapshot(text: string): Snapshot | null {
  try {
    const s = JSON.parse(text) as Snapshot | null
    return typeof s === 'object' && s !== null && Array.isArray(s.running) ? s : null
  } catch {
    return null
  }
}

export const paneTitle = (s: Snapshot | null): string => (typeof s?.repo === 'string' ? `Factory · ${s.repo}` : 'Factory')

const copyRow = (text: string, copy = text): PaneRow => ({ key: 'copy', text, copy })

// shortcut: no open mark for routed reviewers that are not done, the snapshot has no route. Upgrade when it holds the route.
// shortcut: setup checks only that config.json exists, not labels, board or stacks. Upgrade when the snapshot holds the doctor result.
export function paneRows(s: Snapshot | null, hasConfig: boolean): PaneRow[] {
  if (!hasConfig) return [{ key: 'setup', text: 'Setup is not complete. Run /factory:setup.' }, copyRow('/factory:setup')]
  if (s === null) return [{ key: 'empty', text: 'No snapshot yet. Run /factory:status to write it.' }]
  const header: PaneRow = { key: 'header', text: `${paneTitle(s)}  ${s.slots.used}/${s.slots.total} slots`, bold: true }
  // An old status.json can lack waiting, or the command field of a row.
  const [first, ...rest] = [...(s.waiting ?? [])].sort((a, b) => a.number - b.number)
  if (first !== undefined) {
    const command = first.command ?? null
    return [
      header,
      { key: 'wait-head', text: `#${first.number} ${first.title} · waits for you`, bold: true },
      { key: 'wait-next', text: first.next },
      { key: 'wait-link', text: first.link, href: first.link },
      ...(command === null ? [] : [copyRow(command)]),
      ...rest.map(w => ({ key: `wait-more-${w.number}`, text: `#${w.number} ${w.command ?? w.next}` })),
    ]
  }
  const jobs = s.running.map(j => ({
    key: `job-${j.number}`,
    text: [`#${j.number} ${j.title}`, j.round === null ? j.state : `${j.state} R${j.round}`, j.reviewsDone.map(r => `${r} ✓`).join(' ')].filter(p => p !== '').join('  '),
  }))
  const next: PaneRow[] = jobs.length > 0 ? [] : s.ready > 0 ? [copyRow('/factory:run')] : [{ key: 'idle', text: 'Nothing to do.' }, copyRow('/factory:add <text>', '/factory:add ')]
  return [
    header,
    { key: 'ready', text: `Ready: ${s.ready}` },
    { key: 'running', text: 'Running', bold: true },
    ...(jobs.length === 0 ? [{ key: 'running-none', text: 'No running jobs' }] : jobs),
    ...next,
  ]
}
