import { expect, test } from 'claude-code/testing'
import { checkMessage } from '../lib/conventional.ts'
import { parseIntake } from '../lib/intake.ts'
import { parseDecision, parseReview } from '../lib/review.ts'

// These examples also stand word for word in agents/intake.md, spec-writer.md and builder.md.
const INTAKE_ACCEPT = [
  'DECISION: ACCEPT',
  'RISK: medium',
  'SURFACES: ui, api',
  'LANE: regular',
  '',
  '## Summary',
  'The issue asks for a CSV export of the order list. The orders page gets one export button.',
  '',
  '## Scope',
  '- In: a new endpoint that returns the orders as CSV, and one button on the orders page.',
  '- Out: other formats (Excel, PDF), because the issue asks only for CSV.',
].join('\n')

const INTAKE_NEEDS_INFO = [
  'DECISION: NEEDS-INFO',
  'RISK: low',
  'SURFACES: none',
  'LANE: regular',
  '',
  '## Summary',
  'The issue asks to "clean up old data". It does not say which data or how old.',
  '',
  '## Scope',
  '- In: one cleanup job for one type of data.',
  '- Out: all other work until the questions have an answer.',
  '',
  '## Questions',
  '1. Which data must the cleanup remove: sessions, logs, or uploaded files?',
  '2. After how many days is data old?',
].join('\n')

const INTAKE_REJECT = [
  'DECISION: REJECT',
  'RISK: low',
  'SURFACES: none',
  'LANE: regular',
  '',
  '## Summary',
  'The issue asks for a dark mode. Issue #12 asks for the same change.',
  '',
  '## Scope',
  '- In: nothing.',
  '- Out: the dark mode, because #12 covers it.',
  '',
  '## Reason',
  'Duplicate of #12.',
].join('\n')

const SPEC_HEAD = [
  'STATUS: READY',
  'Title: feat(orders): add a CSV export of the order list',
  '',
  '## Summary',
  'Users can download the order list as a CSV file from the orders page.',
  '',
  '## Acceptance criteria',
  'AC-1 `GET /orders.csv` returns status 200, type `text/csv`, and one row per order. Test: `tests/orders-export.test.ts` "returns one row per order".',
  'AC-2 The orders page shows an "Export CSV" button that links to `/orders.csv`. Test: `tests/orders-page.test.ts` "links to the CSV export".',
  '',
  '## Tests',
  '- `tests/orders-export.test.ts`: the status, the content type, and the rows.',
  '- `tests/orders-page.test.ts`: the button and its link.',
  '',
  '## Not tested',
  '- `README.md`: one line about the export. This is docs only.',
  '',
  '## Out of scope',
  '- Other formats (Excel, PDF), because the issue asks only for CSV.',
  '',
  '## Notes for reviewers',
  '- Security: the endpoint shows only the orders of the logged-in user.',
  '- UX: one button on the orders page. The file name contains the date.',
  '- UI: one new button on an existing page. No new page.',
].join('\n')

const BUILDER_COMMIT = [
  'feat(orders): add the CSV export endpoint',
  '',
  'Refs: #42',
].join('\n')

// These examples also stand word for word in agents/code-reviewer.md and approver.md.
const REVIEW_CHANGES = [
  'VERDICT: CHANGES',
  '',
  '## Summary',
  'The AC-1 test checks only the status, so it does not prove the rows. The export runs one query for each order.',
  '',
  '## Findings',
  '1. [blocker] tests/orders-export.test.ts:14: the test checks only status 200, so an empty CSV also passes. Fix: assert one row for each order.',
  '2. [should] src/orders/export.ts:22: the code loads the customer for each order, so 1000 orders cause 1000 queries. Fix: load the customers in one query with the orders.',
  '3. [nit] src/orders/export.ts:8: the name `tmp` does not say what it holds. Fix: rename it to `rows`.',
  '',
  '## Checked',
  '- Gate round-1: PASS.',
  '- AC-2: the test fails without the button. The red output in build.md fits the test.',
  '- Commits: 2 commits. Both follow Conventional Commits and have `Refs: #42`.',
].join('\n')

const REVIEW_PASS = [
  'VERDICT: PASS',
  '',
  '## Summary',
  'The round-1 blocker and should are fixed. Each AC has a test that fails without the change.',
  '',
  '## Findings',
  '1. [nit] src/orders/export.ts:8: the name `tmp` does not say what it holds. Fix: rename it to `rows`.',
  '',
  '## Checked',
  '- Round-1 finding 1: fixed. The test now asserts one row for each order.',
  '- Round-1 finding 2: fixed. One query loads the orders and the customers.',
  '- Gate round-2: PASS.',
  '- Commits: 3 commits. All follow Conventional Commits and have `Refs: #42`.',
].join('\n')

const DECISION_ESCALATE = [
  'DECISION: ESCALATE',
  '',
  '## Summary',
  'Users can download the order list as a CSV file. The gate and all reviews pass, and each AC has a test. The change adds the new dependency `csv-stringify`.',
  '',
  '## Checks',
  '- Gate round-2: PASS.',
  '- Reviews round-2: code PASS, security PASS, ux PASS, ui PASS.',
  '- AC-1, AC-2: each has a test with red output before the change, and the test passes.',
  '- Shortcuts: src/orders/export.ts:12: all orders stay in memory. Limit: 10000 orders. Upgrade: stream the rows.',
  '',
  '## Test it by hand',
  '1. Open the orders page and click "Export CSV".',
  '2. Open the file. It has one row for each order.',
  '',
  '## Question',
  'The change adds the dependency `csv-stringify` to write the CSV rows. Do you accept it? If not, send the job back to build, and the builder writes the rows with the standard library.',
].join('\n')

test('intake example ACCEPT parses', () => {
  expect(parseIntake(INTAKE_ACCEPT).decision).toBe('ACCEPT')
})

test('intake example NEEDS-INFO parses', () => {
  expect(parseIntake(INTAKE_NEEDS_INFO).decision).toBe('NEEDS-INFO')
  expect(INTAKE_NEEDS_INFO).toContain('\n## Questions\n')
})

test('intake example REJECT parses', () => {
  expect(parseIntake(INTAKE_REJECT).decision).toBe('REJECT')
  expect(INTAKE_REJECT).toContain('\n## Reason\n')
})

test('spec example title is conventional', () => {
  expect(SPEC_HEAD.split('\n')[0]).toBe('STATUS: READY')
  const title = /^Title:\s*(.+)$/m.exec(SPEC_HEAD)?.[1]?.trim() ?? ''
  expect(checkMessage(title)).toBeNull()
})

test('builder example commit is conventional', () => {
  expect(checkMessage(BUILDER_COMMIT)).toBeNull()
  expect(BUILDER_COMMIT).toMatch(/\nRefs: #\d+$/)
})

const FINDING = /^\S+:\d+: .+ Fix: .+$/

test('review example CHANGES parses with a blocker', () => {
  const r = parseReview(REVIEW_CHANGES)
  expect(r.verdict).toBe('CHANGES')
  expect(r.findings.some(f => f.severity === 'blocker')).toBe(true)
  for (const f of r.findings) expect(f.text).toMatch(FINDING)
})

test('review example PASS parses', () => {
  const r = parseReview(REVIEW_PASS)
  expect(r.verdict).toBe('PASS')
  expect(r.findings.some(f => f.severity !== 'nit')).toBe(false)
  for (const f of r.findings) expect(f.text).toMatch(FINDING)
})

test('decision example ESCALATE parses with a question', () => {
  const d = parseDecision(DECISION_ESCALATE)
  expect(d.decision).toBe('ESCALATE')
  expect(d.summary).not.toBe('')
  expect(d.question ?? '').not.toBe('')
})
