import { expect, test } from 'claude-code/testing'
import { checkMessage } from '../lib/conventional.ts'
import { parseIntake } from '../lib/intake.ts'
import { lastSection } from '../lib/jobfile.ts'
import { parseDecision, parseReview } from '../lib/review.ts'

// These examples also stand word for word in agents/intake.md, spec-writer.md and builder.md (the commit and the build.md example).
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
  'AC-3 `README.md` has one line about the CSV export. Test: none, see Not tested.',
  'AC-4 (regression) The orders page still lists each order as before. Test: `tests/orders-page.test.ts` "still lists the orders".',
  '',
  '## Tests',
  '- `tests/orders-export.test.ts`: the status, the content type, and the rows.',
  '- `tests/orders-page.test.ts`: the button, its link, and the old order list.',
  '',
  '## Not tested',
  '- AC-3 `README.md`: one line about the export. This is docs only.',
  '',
  '## Out of scope',
  '- Other formats (Excel, PDF), because the issue asks only for CSV.',
  '',
  '## Notes for reviewers',
  '- Security: the endpoint shows only the orders of the logged-in user.',
  '- UX: one button on the orders page. The file name contains the date.',
  '- UI: one new button on an existing page. No new page.',
].join('\n')

const BUILD_TABLE = [
  'STATUS: DONE',
  '',
  '## Summary',
  'Added the CSV export endpoint, the export button on the orders page, and one README line.',
  '',
  '| AC | Test | Red output before the change | Status |',
  '|----|------|------------------------------|--------|',
  '| AC-1 | `tests/orders-export.test.ts` "returns one row per order" | expected 200, got 404 | pass |',
  '| AC-2 | `tests/orders-page.test.ts` "links to the CSV export" | no element with text "Export CSV" | pass |',
  '| AC-3 | none (Not tested in spec.md) | none | not tested |',
  '| AC-4 | `tests/orders-page.test.ts` "still lists the orders" | none (regression, green before) | pass |',
  '',
  '## Commands',
  '- `npm test`: 42 passed, 0 failed',
  '',
  '## Changes',
  '- src/orders/export.ts: the CSV endpoint',
  '- README.md: one line about the CSV export',
  '',
  '## Skipped',
  '- nothing',
  '',
  '## Risks',
  '- The export loads all orders into memory.',
].join('\n')

const BUILDER_COMMIT = [
  'feat(orders): add the CSV export endpoint',
  '',
  'Refs: #42',
].join('\n')

// These examples also stand word for word in agents/code-reviewer.md and approver.md (APPROVE and ESCALATE).
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
  'The round-1 blocker and should are fixed. Each tested AC has a test that fails without the change.',
  '',
  '## Findings',
  '1. [nit] src/orders/export.ts:8: the name `tmp` does not say what it holds. Fix: rename it to `rows`.',
  '',
  '## Checked',
  '- Round-1 finding 1: fixed. The test now asserts one row for each order.',
  '- Round-1 finding 2: fixed. One query loads the orders and the customers.',
  '- AC-3: not tested. `## Not tested` in spec.md names it. The diff for it changes only docs (`README.md`).',
  '- AC-4: regression. spec.md marks it `(regression)`. The test passes on the base code and checks the old order list.',
  '- Gate round-2: PASS.',
  '- Commits: 3 commits. All follow Conventional Commits and have `Refs: #42`.',
].join('\n')

const DECISION_APPROVE = [
  'DECISION: APPROVE',
  '',
  '## Summary',
  'Users can download the order list as a CSV file from the orders page. The gate and all reviews pass. AC-1 and AC-2 have tests. AC-3 is docs only, and spec.md lists it under Not tested. AC-4 keeps the old order list.',
  '',
  '## Checks',
  '- Gate round-1: PASS.',
  '- Reviews round-1: code PASS, security PASS, ux PASS, ui PASS.',
  '- AC-1, AC-2: each has a test with red output before the change, and the test passes.',
  '- AC-3: not tested. `## Not tested` in spec.md names it with a reason. The diff for it changes only `README.md`.',
  '- AC-4: regression. spec.md marks it `(regression)`. The test passes before and after the change.',
  '- Shortcuts: none.',
  '',
  '## Test it by hand',
  '1. Open the orders page and click "Export CSV".',
  '2. Open the file. It has one row for each order.',
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

const NOT_TESTED = 'Test: none, see Not tested.'
const acLines = (spec: string): string[] => spec.match(/^AC-\d+ .+$/gm) ?? []
const acId = (line: string): string => /^AC-\d+/.exec(line)?.[0] ?? ''

test('spec example lists each not-tested AC under Not tested', () => {
  const notTested = (lastSection(SPEC_HEAD, 'Not tested') ?? '').split('\n')
  const untested = acLines(SPEC_HEAD).filter(l => l.endsWith(NOT_TESTED))
  expect(untested.map(acId)).toEqual(['AC-3'])
  for (const l of untested) {
    expect(notTested.some(n => new RegExp(`^- ${acId(l)} \`[^\`]+\`: .+\\. .+\\.$`).test(n))).toBe(true)
  }
  for (const l of acLines(SPEC_HEAD).filter(l => !l.endsWith(NOT_TESTED))) {
    expect(l).toMatch(/ Test: `[^`]+` "[^"]+"\.$/)
  }
})

test('builder example marks the not-tested AC', () => {
  const rows = [...BUILD_TABLE.matchAll(/^\| (AC-\d+) \| (.+) \| (.+) \| (.+) \|$/gm)]
  expect(rows.map(r => r[4])).toContain('not tested')
  expect(rows.map(r => r[1])).toEqual(acLines(SPEC_HEAD).map(acId))
  for (const r of rows) {
    if (r[1] === 'AC-3') expect(r[0]).toBe('| AC-3 | none (Not tested in spec.md) | none | not tested |')
    else expect(r[4]).toBe('pass')
  }
})

const REGRESSION = /^AC-\d+ \(regression\) .+ Test: `[^`]+` "[^"]+"\.$/

test('spec example marks the regression AC', () => {
  const marked = acLines(SPEC_HEAD).filter(l => l.startsWith(`${acId(l)} (regression) `))
  expect(marked.length).toBe(1)
  expect(marked[0] ?? '').toMatch(REGRESSION)
  const notTested = (lastSection(SPEC_HEAD, 'Not tested') ?? '').split('\n')
  expect(notTested.some(n => n.startsWith(`- ${acId(marked[0] ?? '')} `))).toBe(false)
})

test('builder example marks the regression AC', () => {
  const marked = acLines(SPEC_HEAD).filter(l => REGRESSION.test(l))
  expect(marked.length).toBeGreaterThan(0)
  for (const l of marked) {
    const t = /Test: (`[^`]+` "[^"]+")\.$/.exec(l)?.[1] ?? ''
    expect(BUILD_TABLE.split('\n')).toContain(`| ${acId(l)} | ${t} | none (regression, green before) | pass |`)
  }
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

test('review example PASS checks the not-tested AC', () => {
  expect(parseReview(REVIEW_PASS).verdict).toBe('PASS')
  const ac3 = (lastSection(REVIEW_PASS, 'Checked') ?? '').split('\n').find(l => l.startsWith('- AC-3: not tested'))
  expect(ac3 ?? '').toContain('changes only docs')
})

test('decision example APPROVE accepts a not-tested AC', () => {
  expect(parseDecision(DECISION_APPROVE).decision).toBe('APPROVE')
  const ac3 = (lastSection(DECISION_APPROVE, 'Checks') ?? '').split('\n').find(l => l.startsWith('- AC-3: not tested'))
  expect(ac3 ?? '').toContain('`## Not tested`')
})

test('review example PASS checks the regression AC', () => {
  expect(parseReview(REVIEW_PASS).verdict).toBe('PASS')
  const ac4 = (lastSection(REVIEW_PASS, 'Checked') ?? '').split('\n').find(l => l.startsWith('- AC-4: regression.'))
  expect(ac4 ?? '').toContain('passes on the base code')
})

test('decision example APPROVE accepts a regression AC', () => {
  expect(parseDecision(DECISION_APPROVE).decision).toBe('APPROVE')
  const ac4 = (lastSection(DECISION_APPROVE, 'Checks') ?? '').split('\n').find(l => l.startsWith('- AC-4: regression.'))
  expect(ac4).toBeDefined()
})

test('decision example ESCALATE parses with a question', () => {
  const d = parseDecision(DECISION_ESCALATE)
  expect(d.decision).toBe('ESCALATE')
  expect(d.summary).not.toBe('')
  expect(d.question ?? '').not.toBe('')
})
