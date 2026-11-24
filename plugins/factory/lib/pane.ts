import type { Snapshot } from './view.ts'

export const PANE = 'factory'
export type PaneRow = { key: string; text: string; bold?: true }

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

// shortcut: no open mark for routed reviewers that are not done, the snapshot has no route. Upgrade when it holds the route.
export function paneRows(s: Snapshot | null): PaneRow[] {
  if (s === null) return [{ key: 'empty', text: 'No snapshot yet. Run /factory:status to write it.' }]
  const jobs = s.running.map(j => ({
    key: `job-${j.number}`,
    text: [`#${j.number} ${j.title}`, j.round === null ? j.state : `${j.state} R${j.round}`, j.reviewsDone.map(r => `${r} ✓`).join(' ')].filter(p => p !== '').join('  '),
  }))
  return [
    { key: 'header', text: `${paneTitle(s)}  ${s.slots.used}/${s.slots.total} slots`, bold: true },
    { key: 'ready', text: `Ready: ${s.ready}` },
    { key: 'running', text: 'Running', bold: true },
    ...(jobs.length === 0 ? [{ key: 'running-none', text: 'No running jobs' }] : jobs),
  ]
}
