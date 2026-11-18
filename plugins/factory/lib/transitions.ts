import { FactoryError } from './exec.ts'
import type { State } from './types.ts'

export const TRANSITIONS: Record<State | 'backlog', State[]> = {
  backlog: ['intake'],
  intake: ['spec', 'needs-info', 'rejected', 'needs-human'],
  'needs-info': ['intake'],
  fastlane: ['needs-human'],
  spec: ['build', 'needs-human'],
  'needs-design': [],
  build: ['review', 'needs-human'],
  review: ['build', 'approved', 'needs-human'],
  'needs-human': ['build', 'done', 'needs-human'],
  approved: ['done', 'needs-human'],
  docs: ['needs-human'],
  done: [],
  rejected: [],
}

export function canTransition(from: State | null, to: State): boolean {
  return TRANSITIONS[from ?? 'backlog'].includes(to)
}

export function assertTransition(from: State | null, to: State): void {
  if (canTransition(from, to)) return
  const a = from === null ? 'backlog' : `factory:${from}`
  throw new FactoryError('illegal-transition', `${a} → factory:${to} is not allowed`)
}
