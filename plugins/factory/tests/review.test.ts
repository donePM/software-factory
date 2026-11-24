import { expect, test } from 'claude-code/testing'
import { parseDecision, parseReview } from '../lib/review.ts'

const REVIEW = `VERDICT: CHANGES

## Summary
Two problems.

## Findings
1. [blocker] The parser drops the last line.
2. [nit] Rename x to count.
`

test('parseReview reads verdict and findings', () => {
  expect(parseReview(REVIEW)).toEqual({
    verdict: 'CHANGES',
    findings: [
      { severity: 'blocker', text: 'The parser drops the last line.' },
      { severity: 'nit', text: 'Rename x to count.' },
    ],
  })
  expect(parseReview('VERDICT: PASS\n\n## Summary\nFine.\n')).toEqual({ verdict: 'PASS', findings: [] })
})

test('parseReview marks a finding that needs a spec change', () => {
  const text = 'VERDICT: CHANGES\n\n## Findings\n1. [blocker] spec: spec.md:12: AC-1 tests a constant. Fix: move AC-1 to Not tested.\n2. [should] spec: AC-2 is vague.\n3. [nit] spec: wording.\n'
  expect(parseReview(text).findings).toEqual([
    { severity: 'blocker', text: 'spec.md:12: AC-1 tests a constant. Fix: move AC-1 to Not tested.', spec: true },
    { severity: 'should', text: 'AC-2 is vague.', spec: true },
    { severity: 'nit', text: 'spec: wording.' },
  ])
})

test('parseReview rejects a missing verdict line', () => {
  expect(() => parseReview('## Summary\nFine.\n')).toThrow()
  expect(() => parseReview('\nVERDICT: PASS\n')).toThrow()
  expect(() => parseReview('VERDICT: MAYBE\n')).toThrow()
  expect(() => parseReview('VERDICT: PASS extra\n')).toThrow()
})

test('parseReview rejects CHANGES with only nits', () => {
  const text = 'VERDICT: CHANGES\n\n## Findings\n1. [nit] Rename x.\n'
  expect(() => parseReview(text)).toThrow('changes without blocker or should')
  expect(() => parseReview('VERDICT: CHANGES\n\n## Summary\nx\n')).toThrow('changes without blocker or should')
})

test('parseDecision reads ESCALATE with a question', () => {
  const text = 'DECISION: ESCALATE\n\n## Summary\nUnsure.\n\n## Question\nShould the API be public?\n'
  expect(parseDecision(text)).toEqual({ decision: 'ESCALATE', summary: 'Unsure.', question: 'Should the API be public?' })
})

test('parseDecision reads APPROVE and rejects a bad first line or a missing question', () => {
  expect(parseDecision('DECISION: APPROVE\n\n## Summary\nGood.\n')).toEqual({ decision: 'APPROVE', summary: 'Good.' })
  expect(() => parseDecision('APPROVE\n')).toThrow()
  expect(() => parseDecision('DECISION: ESCALATE\n\n## Summary\nx\n')).toThrow()
})

test('parseReview accepts PASS with only a commit nit', () => {
  const text = 'VERDICT: PASS\n\n## Findings\n1. [nit] commit abc1234: the body ends in the middle of a sentence. Fix: none, the commit is pushed.\n'
  expect(parseReview(text)).toEqual({
    verdict: 'PASS',
    findings: [{ severity: 'nit', text: 'commit abc1234: the body ends in the middle of a sentence. Fix: none, the commit is pushed.' }],
  })
  expect(() => parseReview(text.replace('PASS', 'CHANGES'))).toThrow('changes without blocker or should')
})
