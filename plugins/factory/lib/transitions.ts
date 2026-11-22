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
  approved: ['build', 'done', 'needs-human'],
  docs: ['done', 'needs-human'],
  done: [],
  rejected: [],
}

// prMerged: the caller saw GitHub report the PR on factory/<n> as merged.
export type TransitionOpts = { prMerged?: boolean }

export function canTransition(from: State | null, to: State, opts: TransitionOpts = {}): boolean {
  if (opts.prMerged === true && from !== null && from !== 'done' && from !== 'rejected' && (to === 'done' || (to === 'docs' && from !== 'docs'))) return true
  return TRANSITIONS[from ?? 'backlog'].includes(to)
}

export function assertTransition(from: State | null, to: State, opts: TransitionOpts = {}): void {
  if (canTransition(from, to, opts)) return
  const a = from === null ? 'backlog' : `factory:${from}`
  throw new FactoryError('illegal-transition', `${a} → factory:${to} is not allowed`)
}
