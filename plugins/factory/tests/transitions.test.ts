import { expect, test } from 'claude-code/testing'
import { assertTransition, canTransition, TRANSITIONS } from '../lib/transitions.ts'
import { labelSet, RUNNING, STATUS, stateOf, statusLabel } from '../lib/labels.ts'

test('backlog may only go to intake', () => {
  expect(canTransition(null, 'intake')).toBe(true)
  expect(canTransition(null, 'build')).toBe(false)
})

test('every running state may escalate', () => {
  for (const s of RUNNING) expect(canTransition(s, 'needs-human')).toBe(true)
})

test('done and rejected are final', () => {
  for (const s of STATUS) {
    expect(canTransition('done', s)).toBe(false)
    expect(canTransition('rejected', s)).toBe(false)
  }
})

test('review can loop back to build', () => {
  expect(canTransition('review', 'build')).toBe(true)
})

test('approved can go back to build', () => {
  expect(canTransition('approved', 'build')).toBe(true)
  expect(canTransition('approved', 'review')).toBe(false)
  expect(canTransition('approved', 'needs-human')).toBe(true)
  expect(canTransition('approved', 'done')).toBe(true)
  expect(TRANSITIONS.approved).toEqual(['build', 'done', 'needs-human'])
})

test('transitions without a forward path are rejected', () => {
  expect(canTransition('fastlane', 'spec')).toBe(false)
  expect(canTransition('approved', 'docs')).toBe(false)
  expect(canTransition('needs-design', 'spec')).toBe(false)
  expect(TRANSITIONS['needs-design']).toEqual([])
  expect(TRANSITIONS.fastlane).toEqual(['needs-human'])
})

test('docs leads to done or needs-human', () => {
  expect(TRANSITIONS.docs).toEqual(['done', 'needs-human'])
  expect(canTransition('docs', 'done')).toBe(true)
  expect(canTransition('docs', 'needs-human')).toBe(true)
  for (const s of STATUS.filter(s => s !== 'docs' && s !== 'done' && s !== 'rejected')) {
    expect(canTransition(s, 'docs', { prMerged: true })).toBe(true)
  }
  for (const s of [null, 'docs', 'done', 'rejected'] as const) expect(canTransition(s, 'docs', { prMerged: true })).toBe(false)
  expect(canTransition('approved', 'docs')).toBe(false)
  expect(() => assertTransition('approved', 'docs')).toThrow()
})

test('the table matches the bootstrap plan', () => {
  expect(TRANSITIONS.backlog).toEqual(['intake'])
  expect(TRANSITIONS.intake).toEqual(['spec', 'needs-info', 'rejected', 'needs-human'])
  expect(TRANSITIONS['needs-info']).toEqual(['intake'])
  expect(TRANSITIONS.spec).toEqual(['build', 'needs-human'])
  expect(TRANSITIONS.build).toEqual(['review', 'needs-human'])
  expect(TRANSITIONS.review).toEqual(['build', 'approved', 'needs-human'])
  expect(TRANSITIONS['needs-human']).toEqual(['build', 'done', 'needs-human'])
})

test('needs-human may stay needs-human', () => {
  expect(canTransition('needs-human', 'needs-human')).toBe(true)
})

test('assertTransition throws illegal-transition', () => {
  expect(() => assertTransition(null, 'intake')).not.toThrow()
  let err: { code?: string; message?: string } = {}
  try {
    assertTransition('spec', 'done')
  } catch (e) {
    err = e as { code?: string; message?: string }
  }
  expect(err.code).toBe('illegal-transition')
  expect(err.message).toBe('factory:spec → factory:done is not allowed')
})

test('done from any running state needs a merged PR', () => {
  for (const s of STATUS.filter(s => s !== 'done' && s !== 'rejected')) {
    expect(canTransition(s, 'done', { prMerged: true })).toBe(true)
    expect(() => assertTransition(s, 'done', { prMerged: true })).not.toThrow()
  }
  for (const s of [null, 'done', 'rejected'] as const) expect(canTransition(s, 'done', { prMerged: true })).toBe(false)
  expect(canTransition('review', 'done')).toBe(false)
  expect(() => assertTransition('review', 'done')).toThrow()
  expect(canTransition('review', 'build', { prMerged: true })).toBe(true)
})

test('stateOf finds exactly one status label', () => {
  expect(stateOf(['factory', 'factory:spec', 'bug'])).toBe('spec')
})

test('stateOf reports two status labels as conflict', () => {
  expect(stateOf(['factory:spec', 'factory:build'])).toBe('conflict')
})

test('stateOf ignores factory:pr', () => {
  expect(stateOf(['factory:pr'])).toBe(null)
})

test('statusLabel prefixes the state', () => {
  expect(statusLabel('needs-info')).toBe('factory:needs-info')
})

test('labelSet has no priority labels', () => {
  const names = labelSet().map(l => l.name)
  expect(names.filter(n => n.startsWith('priority:'))).toEqual([])
})

test('labelSet has one label per state', () => {
  const names = labelSet().map(l => l.name)
  expect(names.filter(n => /^factory:(?!pr$)/.test(n))).toHaveLength(12)
  expect(names).toContain('factory')
  expect(names).toContain('factory:pr')
  expect(names.filter(n => n.startsWith('type:'))).toHaveLength(12)
  expect(names).toContain('skip-changelog')
})

test('labelSet colors follow the design', () => {
  const by = Object.fromEntries(labelSet().map(l => [l.name, l]))
  expect(by['factory:build']?.color).toBe('fbca04')
  expect(by['factory:needs-human']?.color).toBe('d93f0b')
  expect(by['factory:approved']?.color).toBe('0e8a16')
  expect(by['type:feat']?.color).toBe('a2eeef')
  for (const l of Object.values(by)) expect(l.description.length).toBeGreaterThan(0)
})
