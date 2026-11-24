import { expect, test } from 'claude-code/testing'
import { parseDocs } from '../lib/docs.ts'

const head = 'STATUS: DONE\n\n## Summary\nTwo pages.\n\n'

test('parses each page of docs.md with its name', () => {
  const d = parseDocs(`${head}## Page Orders.md\n# Orders\n\n## Use\nRun it.\n\n## Page Home.md\n# Home\n- [Orders](Orders)\n`)
  expect(d.status).toBe('DONE')
  expect(d.summary).toBe('Two pages.')
  expect(d.pages).toEqual([
    { name: 'Orders.md', text: '# Orders\n\n## Use\nRun it.' },
    { name: 'Home.md', text: '# Home\n- [Orders](Orders)' },
  ])
  expect('page' in d).toBe(false)
  expect(parseDocs('STATUS: BLOCKED\n\n## Summary\nNo diff.\n').pages).toEqual([])
})

test('rejects bad page names', () => {
  for (const name of ['../x.md', '/abs.md', '.git.md', '_Sidebar.md', 'a b.md', 'notes.txt', '-x.md', 'Issue-7.md', 'Issue-146.md']) {
    let err: unknown
    try { parseDocs(`${head}## Page ${name}\n# X\n`) } catch (e) { err = e }
    expect(err).toMatchObject({ code: 'docs-bad-page' })
  }
  expect(parseDocs(`${head}## Page Issue-Tracker.md\n# X\n`).pages[0]?.name).toBe('Issue-Tracker.md')
})
