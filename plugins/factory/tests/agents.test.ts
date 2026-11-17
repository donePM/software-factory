import { expect, test } from 'claude-code/testing'
import { checkMessage } from '../lib/conventional.ts'
import { parseIntake } from '../lib/intake.ts'

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
