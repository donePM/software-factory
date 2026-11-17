import type { Config } from './config.ts'
import type { State } from './types.ts'

export type Label = { name: string; color: string; description: string }

export const STATUS: State[] = [
  'intake', 'needs-info', 'fastlane', 'spec', 'needs-design', 'build',
  'review', 'needs-human', 'approved', 'docs', 'done', 'rejected',
]

export const RUNNING: State[] = ['intake', 'fastlane', 'spec', 'build', 'review', 'docs']

export function statusLabel(s: State): string {
  return `factory:${s}`
}

export function stateOf(labels: string[]): State | null | 'conflict' {
  const found = STATUS.filter(s => labels.includes(statusLabel(s)))
  if (found.length > 1) return 'conflict'
  return found[0] ?? null
}

const WAITING = 'd93f0b'
const RUNNING_COLOR = 'fbca04'
const DESCRIPTION: Record<State, string> = {
  intake: 'Intake is running.',
  'needs-info': 'Waiting for an answer from the author.',
  fastlane: 'The fastlane is running.',
  spec: 'The spec is being written.',
  'needs-design': 'Waiting for the human to choose a design.',
  build: 'Build and gate are running.',
  review: 'Reviews and probe are running.',
  'needs-human': 'Escalated, waiting for a human.',
  approved: 'The approver said yes, waiting for the human to merge.',
  docs: 'Documentation is being written.',
  done: 'Finished.',
  rejected: 'Rejected.',
}

function statusColor(s: State): string {
  if (s === 'approved') return '0e8a16'
  if (s === 'done') return '1d7621'
  if (s === 'rejected') return 'cccccc'
  return RUNNING.includes(s) ? RUNNING_COLOR : WAITING
}

const TYPES: { name: string; color: string; description: string }[] = [
  { name: 'feat', color: 'a2eeef', description: 'A new feature.' },
  { name: 'fix', color: 'd73a4a', description: 'A bug fix.' },
  { name: 'docs', color: '0075ca', description: 'A change to documentation only.' },
  { name: 'style', color: 'ededed', description: 'A change that does not affect the meaning of the code.' },
  { name: 'refactor', color: 'ededed', description: 'A change that neither fixes a bug nor adds a feature.' },
  { name: 'perf', color: 'ededed', description: 'A change that improves performance.' },
  { name: 'test', color: 'ededed', description: 'A change that adds or fixes tests.' },
  { name: 'build', color: 'ededed', description: 'A change to the build system or dependencies.' },
  { name: 'ci', color: 'ededed', description: 'A change to the CI configuration.' },
  { name: 'chore', color: 'ededed', description: 'A change that does not touch source or tests.' },
  { name: 'revert', color: 'ededed', description: 'A change that reverts an earlier commit.' },
]

export function labelSet(cfg: Config): Label[] {
  const prio: [keyof Config['priorities'], string, string][] = [
    ['critical', 'b60205', 'Critical priority.'],
    ['high', 'd93f0b', 'High priority.'],
    ['medium', 'fbca04', 'Medium priority.'],
    ['low', 'c5def5', 'Low priority.'],
  ]
  return [
    { name: 'factory', color: '5319e7', description: 'In the factory backlog.' },
    ...STATUS.map(s => ({ name: statusLabel(s), color: statusColor(s), description: DESCRIPTION[s] })),
    { name: 'factory:pr', color: '5319e7', description: 'A pull request opened by the factory.' },
    ...prio.map(([k, color, description]) => ({ name: cfg.priorities[k], color, description })),
    ...TYPES.map(t => ({ ...t, name: `type:${t.name}` })),
    { name: 'type:breaking', color: 'b60205', description: 'A breaking change.' },
    { name: 'skip-changelog', color: 'ededed', description: 'Leave this change out of the changelog.' },
  ]
}
