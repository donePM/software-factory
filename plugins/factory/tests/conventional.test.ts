import { expect, test } from 'claude-code/testing'
import { checkMessage, typeOf } from '../lib/conventional.ts'

test('accepts feat(scope): text', () => {
  expect(checkMessage('feat(gate): add x')).toBeNull()
})

test('accepts a breaking change with !', () => {
  expect(checkMessage('feat(api)!: drop v1')).toBeNull()
})

test('accepts a BREAKING CHANGE footer without !', () => {
  expect(checkMessage('feat: drop v1\n\nBREAKING CHANGE: v1 is gone')).toBeNull()
})

test('rejects an unknown type', () => {
  expect(checkMessage('feature: x')).toContain('type')
})

test('rejects a missing space after the colon', () => {
  expect(checkMessage('feat:x')).toContain('space')
})

test('rejects "Merge branch main"', () => {
  expect(checkMessage("Merge branch 'main'")).not.toBeNull()
})

test('typeOf reads type and breaking', () => {
  expect(typeOf('fix(api)!: y')).toEqual({ type: 'fix', breaking: true })
  expect(typeOf('fix: y')).toEqual({ type: 'fix', breaking: false })
  expect(typeOf('nope')).toBeNull()
})
