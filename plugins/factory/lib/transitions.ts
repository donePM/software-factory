import { FactoryError } from './exec.ts'
import type { State } from './types.ts'

export const TRANSITIONS: Record<State | 'backlog', State[]> = {
  backlog: ['intake'],
  intake: ['rejected', 'needs-info', 'fastlane', 'spec', 'needs-human'],
  'needs-info': ['intake', 'rejected', 'needs-human'],
  fastlane: ['approved', 'done', 'spec', 'needs-human'],
  spec: ['needs-design', 'build', 'needs-human'],
  'needs-design': ['spec', 'needs-human'],
  build: ['review', 'needs-human'],
  review: ['build', 'approved', 'needs-human'],
  'needs-human': ['intake', 'spec', 'build', 'review', 'approved', 'docs', 'rejected', 'needs-human'],
  approved: ['docs', 'done', 'needs-human'],
  docs: ['done', 'needs-human'],
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
