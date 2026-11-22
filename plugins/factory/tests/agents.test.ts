import { expect, test } from 'claude-code/testing'
import { checkMessage } from '../lib/conventional.ts'
import { parseDocs } from '../lib/docs.ts'
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
  'Users can download the order list as a CSV file.',
  'The endpoint returns one row for each order.',
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

test('builder example commit body ends in a full sentence', () => {
  const body = BUILDER_COMMIT.split('\n').slice(2, -2)
  expect(body.length).toBeGreaterThan(0)
  expect(body.at(-1) ?? '').toMatch(/\.$/)
  for (const l of body) expect(l).not.toMatch(/\.\.\.|…/)
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

// shortcut: plugin tests have no fs, so these are copies. Upgrade to a file scan when tests get fs.
// GATE_PROMPT stands word for word in agents/gate-runner.md and pipeline.md, GATE_BAD_PROMPT in agents/gate-runner.md.
// GATE_SETUP_PROMPT is the `<root>/.factory/gate/setup` form of agents/gate-runner.md with `/repo` as the root.
const GATE_PROMPT = '/repo/.factory/jobs/42/round-2'
const GATE_BAD_PROMPT = '/repo/.factory/jobs/64'
const GATE_SETUP_PROMPT = '/repo/.factory/gate/setup'

const GATE_JOB = /^\/.+\/\.factory\/jobs\/(\d+)\/round-(\d+)$/
const GATE_SETUP = /^\/.+\/\.factory\/gate\/setup$/

test('gate-runner example prompt names a round folder', () => {
  const m = GATE_JOB.exec(GATE_PROMPT)
  expect(m?.[1]).toBe('42')
  expect(`round-${m?.[2]}`).toBe('round-2')
})

test('gate-runner example rejects a job folder without a round', () => {
  expect(GATE_JOB.test(GATE_BAD_PROMPT)).toBe(false)
  expect(GATE_SETUP.test(GATE_BAD_PROMPT)).toBe(false)
})

test('gate-runner example accepts the setup path', () => {
  expect(GATE_SETUP.test(GATE_SETUP_PROMPT)).toBe(true)
  expect(GATE_JOB.test(GATE_SETUP_PROMPT)).toBe(false)
})

// DOCS_DONE stands word for word in agents/documenter.md.
const DOCS_DONE = [
  'STATUS: DONE',
  '',
  '## Summary',
  'The page describes the CSV export of the order list. It names the new endpoint and the new button.',
  '',
  '## Page',
  '# CSV export of the order list',
  '',
  'Users can download the order list as a CSV file. Issue: #42.',
  '',
  '## How to use it',
  '1. Open the orders page.',
  '2. Click "Export CSV".',
  '',
  '## What changed',
  '- `GET /orders.csv` returns one row for each order.',
  '- The orders page has an "Export CSV" button.',
].join('\n')

test('documenter example docs.md has a page', () => {
  const d = parseDocs(DOCS_DONE)
  expect(d.status).toBe('DONE')
  expect(d.summary).not.toBe('')
  expect(d.page.startsWith('# CSV export of the order list')).toBe(true)
  expect(d.page).toContain('## How to use it')
  expect(d.page).toContain('## What changed')
})

// START_STEP_1 stands word for word in pipeline.md, step 1 of `## Start`.
const START_STEP_1 = [
  '1. Call `cleanup` without `issue`. It sweeps finished tickets.',
  '   Show each line of its `finished` list to the operator.',
  '   For each number `<n>` in its `docs` list, call `job_sync` with `<n>`.',
  '   If its `rebuilt` list has `docs.md`, follow "documenter finished".',
  '   Else start `factory:documenter` with its `<jobDir>`.',
].join('\n')

test('pipeline finishes a docs job with a rebuilt docs.md', () => {
  expect(START_STEP_1).toContain('If its `rebuilt` list has `docs.md`, follow "documenter finished".')
  expect(START_STEP_1).toContain('Else start `factory:documenter` with its `<jobDir>`.')
})

// shortcut: plugin tests have no fs, so these are copies. Upgrade to a file scan when tests get fs.
// PLANNER_FRONTMATTER, PLANNER_LANGUAGE, and PRODUCT_READY stand word for word in agents/planner.md.
// CODE_FIRST stands word for word in intake, spec-writer, builder, the code|security|ux|ui reviewers, approver, and planner.
const PLANNER_FRONTMATTER = [
  '---',
  'name: planner',
  'description: Factory planner. Reads one product idea (idea.md) and the repo, and writes product.md with a goal and ordered slices. Writes no code.',
  'tools: Read, Grep, Glob, Write',
  'model: opus',
  '---',
].join('\n')

const PLANNER_LANGUAGE = [
  'Read the **Language** line in `<planDir>/idea.md`.',
  'No line means English. Write the text for people in your file in that language.',
  'Keep these parts in English: the machine-read first line (`STATUS:`), the',
  'section headings, paths, and code. Keep the fixed keywords of the file format',
  'in English (for example `S<n>`, `Files:`, `Needs`). For English, use Simplified Technical English',
  '(ASD-STE100). For another language, use the STE principles in that language:',
  'short sentences (at most 20 words), one instruction in each sentence,',
  'the active voice, and clear words with one meaning.',
].join('\n')

const CODE_FIRST = [
  '## Code first',
  'The code and its tests are the only source of truth for what the repo does now.',
  'Docs, specs, comments, and other Markdown can be out of date.',
  'When they disagree with the code, the code wins.',
  "The job's `spec.md` still defines the new behavior to build.",
].join('\n')

const PRODUCT_READY = [
  'STATUS: READY',
  '',
  '## Goal',
  'Shop owners can see, filter, and export their orders on one page.',
  '',
  '## Scope',
  '- In: an order list page, a status filter, and a CSV export.',
  '- Out: other export formats (Excel, PDF), because the idea asks only for CSV.',
  '- Out: saved filters, because the idea does not ask for them.',
  '',
  '## Stack',
  '- The TypeScript server in `src/`. `npm test` runs the tests.',
  '',
  '## Dependencies',
  '- none.',
  '',
  '## Architecture',
  '- `src/orders/list.ts`: reads the orders from the database layer.',
  '- `src/orders/page.ts`: shows the order list page.',
  '- `src/orders/export.ts`: returns the orders as CSV.',
  '',
  '## Slices',
  'S1 The orders page lists each order with its number and date. Files: src/orders/list.ts, src/orders/page.ts. Needs none.',
  'S2 The orders page filters the list by status. Files: src/orders/page.ts. Needs S1.',
  'S3 `GET /orders.csv` returns one row for each order. Files: src/orders/export.ts. Needs S1.',
  'S4 The orders page has an "Export CSV" button that links to `/orders.csv`. Files: src/orders/page.ts. Needs S3.',
  '',
  '## Open questions',
  '- none.',
].join('\n')

test('planner frontmatter names the agent, the model, and the tools', () => {
  const lines = PLANNER_FRONTMATTER.split('\n')
  expect(lines[0]).toBe('---')
  expect(lines.at(-1)).toBe('---')
  const keys = Object.fromEntries(lines.slice(1, -1).map(l => [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':') + 2)]))
  expect(Object.keys(keys)).toEqual(['name', 'description', 'tools', 'model'])
  expect(keys.name).toBe('planner')
  expect(keys.description ?? '').toMatch(/^\S.+\.$/)
  expect(keys.tools).toBe('Read, Grep, Glob, Write')
  expect(keys.model).toBe('opus')
})

test('planner language block reads idea.md and repeats the STE rules', () => {
  expect(PLANNER_LANGUAGE.split('\n')[0]).toContain('`<planDir>/idea.md`')
  for (const s of ['No line means English.', 'ASD-STE100', 'at most 20 words', 'the active voice']) {
    expect(PLANNER_LANGUAGE).toContain(s)
  }
})

test('code first section is the same in all nine agents', () => {
  expect(CODE_FIRST.split('\n')).toEqual([
    '## Code first',
    'The code and its tests are the only source of truth for what the repo does now.',
    'Docs, specs, comments, and other Markdown can be out of date.',
    'When they disagree with the code, the code wins.',
    "The job's `spec.md` still defines the new behavior to build.",
  ])
})

test('planner example product.md starts with STATUS READY and has the sections in order', () => {
  expect(PRODUCT_READY.split('\n')[0]).toBe('STATUS: READY')
  const headings = (PRODUCT_READY.match(/^## .+$/gm) ?? []).map(h => h.slice(3))
  expect(headings).toEqual(['Goal', 'Scope', 'Stack', 'Dependencies', 'Architecture', 'Slices', 'Open questions'])
})

const SLICE = /^S(\d+) .+\. Files: .+\. Needs (none|S\d+(?:, S\d+)*)\.$/

test('planner example slices start with a walking skeleton and need only earlier slices', () => {
  const slices = (lastSection(PRODUCT_READY, 'Slices') ?? '').split('\n').filter(l => l !== '')
  expect(slices.length).toBeGreaterThan(2)
  const needs = slices.map((l, i) => {
    const m = SLICE.exec(l)
    expect(m?.[1]).toBe(String(i + 1))
    return m?.[2] === 'none' ? [] : (m?.[2] ?? '').split(', ').map(s => Number(s.slice(1)))
  })
  expect(needs[0]).toEqual([])
  needs.slice(1).forEach((n, i) => {
    expect(n.length).toBeGreaterThan(0)
    for (const m of n) expect(m).toBeLessThan(i + 2)
  })
  expect(needs.filter(n => n.length === 1 && n[0] === 1).length).toBeGreaterThan(1)
})

// shortcut: plugin tests have no fs, so these are copies. Upgrade to a file scan when tests get fs.
// AUDITOR_FRONTMATTER, AUDITOR_LANGUAGE, AUDITOR_TOPICS, AUDITOR_WRITE, and AUDIT_DONE stand word for word in agents/auditor.md.
const AUDITOR_FRONTMATTER = [
  '---',
  'name: auditor',
  'description: Factory auditor. Reads the repo, or one folder of it, and writes audit.md with a ranked list of findings. Writes no code.',
  'tools: Read, Grep, Glob, Bash, Write',
  'model: opus',
  '---',
].join('\n')

const AUDITOR_LANGUAGE = [
  'Find `<root>` first (see below). Then read the `"language"` key in `<root>/.factory/config.json`.',
  'No line means English. Write the text for people in your file in that language.',
  'Keep these parts in English: the machine-read first line (`STATUS:`), the',
  'section headings, paths, and code. Keep the fixed keywords of the file format',
  'in English (for example `Fix:`, `Upgrade:`, `- none.`). For English, use Simplified Technical English',
  '(ASD-STE100). For another language, use the STE principles in that language:',
  'short sentences (at most 20 words), one instruction in each sentence,',
  'the active voice, and clear words with one meaning.',
].join('\n')

const AUDITOR_TOPICS = [
  '## Look for',
  'Look for bugs, risks, scale problems, missing tests, speed, lean cuts, and `shortcut:` debt.',
  '- Bugs: a wrong result, a crash, or a missed edge case (empty, zero, last item, time zones).',
  '- Risks: injection, secrets in code, no check on input at a trust boundary, or data loss.',
  '- Scale problems: check-then-write races, lists that only grow, one query for each item.',
  '- Missing tests: risky logic (a branch, a parser, security, data writes) that no test fails on.',
  '- Speed: a large slowdown. A small win goes under `## Nice to have`.',
  '- Lean cuts: dead code, unused options, or a wrapper that only passes through.',
  '- Lean cuts: near-copies, or a dependency that a few lines or the platform can replace.',
  '- `shortcut:` debt: each `shortcut:` comment. Find them with `git grep -nE \'(#|//|/[*]) ?shortcut:\'`.',
  '',
  'No case, no finding. Write a finding only with a concrete case. The case is',
  'an input, a caller, or a user step that shows the problem.',
  '- Before you call code unused, grep the whole tree, with tests and config.',
  '- A `shortcut:` comment that names its limit goes under `## Shortcuts`. It is',
  '  a finding only when the real load already goes past that limit.',
  '- Give the smallest fix that works. A fix that deletes code is better.',
].join('\n')

const AUDITOR_WRITE = [
  '## Write',
  'Write only `<root>/.factory/audit/audit.md`. Do not change code. Do not write other files.',
  'Use Bash only for commands that change no file (for example `git log`, `git blame`, `git ls-files`, `git rev-parse`).',
  'Do not run tests, builds, or installs. A test can write files or call the network.',
  'Do not call factory tools. You have no GitHub access.',
  'Each run overwrites the file.',
].join('\n')

const AUDIT_DONE = [
  'STATUS: DONE',
  '',
  '## Must fix',
  '1. src/orders/export.ts:22: an order without a customer makes `customer.name` throw, so the export returns 500. Fix: write an empty name when the customer is missing.',
  '',
  '## Should fix',
  '2. src/orders/export.ts:30: the code loads the customer for each order, so 1000 orders cause 1000 queries. Fix: load the customers in one query with the orders.',
  '3. src/orders/csv.ts:5: no test has a name with a comma, so a broken quote rule passes. Fix: add one test with the name "Smith, Anna".',
  '',
  '## Nice to have',
  '- none.',
  '',
  '## Shortcuts',
  '- src/orders/export.ts:12: all orders stay in memory. Limit: 10000 orders. Upgrade: stream the rows.',
].join('\n')

test('auditor frontmatter names the agent, the model, and the tools', () => {
  const lines = AUDITOR_FRONTMATTER.split('\n')
  expect(lines[0]).toBe('---')
  expect(lines.at(-1)).toBe('---')
  const keys = Object.fromEntries(lines.slice(1, -1).map(l => [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':') + 2)]))
  expect(Object.keys(keys)).toEqual(['name', 'description', 'tools', 'model'])
  expect(keys.name).toBe('auditor')
  expect(keys.description ?? '').toMatch(/^\S.+ Writes no code\.$/)
  expect(keys.tools).toBe('Read, Grep, Glob, Bash, Write')
  expect(keys.tools ?? '').not.toContain('Edit')
  expect(keys.model).toBe('opus')
})

test('auditor language block reads config.json and repeats the STE rules', () => {
  const first = AUDITOR_LANGUAGE.split('\n')[0] ?? ''
  expect(first).toContain('`<root>/.factory/config.json`')
  expect(first).toContain('`"language"`')
  for (const s of ['No line means English.', 'ASD-STE100', 'at most 20 words', 'the active voice', '`STATUS:`', 'section headings, paths, and code', '`Fix:`', '`Upgrade:`']) {
    expect(AUDITOR_LANGUAGE).toContain(s)
  }
})

test('auditor write rules allow only audit.md and read-only Bash', () => {
  expect(AUDITOR_WRITE.split('\n')[0]).toBe('## Write')
  for (const s of [
    'Write only `<root>/.factory/audit/audit.md`.',
    'Do not change code.',
    'Do not write other files.',
    'Use Bash only for commands that change no file',
    '`git log`, `git blame`, `git ls-files`, `git rev-parse`',
    'Do not run tests, builds, or installs.',
    'Do not call factory tools.',
    'You have no GitHub access.',
  ]) {
    expect(AUDITOR_WRITE).toContain(s)
  }
})

test('auditor example audit.md starts with STATUS DONE and ranks the findings', () => {
  for (const s of ['bugs', 'risks', 'scale problems', 'missing tests', 'speed', 'lean cuts', '`shortcut:` debt']) {
    expect(AUDITOR_TOPICS).toContain(s)
  }
  expect(AUDITOR_TOPICS).toContain('No case, no finding.')
  expect(AUDITOR_TOPICS).toContain('an input, a caller, or a user step')
  expect(AUDIT_DONE.split('\n')[0]).toBe('STATUS: DONE')
  const headings = (AUDIT_DONE.match(/^## .+$/gm) ?? []).map(h => h.slice(3))
  expect(headings).toEqual(['Must fix', 'Should fix', 'Nice to have', 'Shortcuts'])
  const lines = (name: string) => (lastSection(AUDIT_DONE, name) ?? '').split('\n').filter(l => l !== '')
  let findings = 0
  for (const name of ['Must fix', 'Should fix', 'Nice to have']) {
    for (const l of lines(name)) {
      if (l === '- none.') continue
      expect(l).toMatch(/^\d+\. \S+:\d+: .+ Fix: .+$/)
      findings++
    }
  }
  expect(findings).toBeGreaterThan(0)
  for (const l of lines('Shortcuts')) {
    if (l !== '- none.') expect(l).toMatch(/^- \S+:\d+: .+ Upgrade: .+$/)
  }
  expect(lines('Nice to have')).toEqual(['- none.'])
})
