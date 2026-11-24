import { FactoryError } from './exec.ts'
import { lastSection } from './jobfile.ts'

export type Page = { name: string; text: string }
export type Docs = { status: 'DONE' | 'BLOCKED'; summary: string; pages: Page[] }

// The name rule blocks path traversal, hidden pages such as _Sidebar.md, and the old issue pages.
const NAME = /^[A-Za-z0-9][A-Za-z0-9-]*\.md$/
export const ISSUE_PAGE = /^Issue-[0-9]+\.md$/

// A page runs from its "## Page <Name>.md" line to the next one, so a page can have its own "##" headings.
export function parseDocs(text: string): Docs {
  const lines = text.split(/\r\n|\r|\n/)
  const m = /^STATUS: (DONE|BLOCKED)$/.exec((lines[0] ?? '').trimEnd())
  if (!m) throw new FactoryError('docs-not-done', 'docs.md must start with "STATUS: DONE" or "STATUS: BLOCKED"', 'The documenter must finish first.')
  const starts = lines.flatMap((l, i) => (l.startsWith('## Page ') ? [i] : []))
  const pages = starts.map((at, k) => {
    const name = lines[at]!.slice('## Page '.length).trim()
    if (!NAME.test(name) || ISSUE_PAGE.test(name)) {
      throw new FactoryError('docs-bad-page', `docs.md has the bad page name "${name}"`, 'The documenter must use a name such as "Orders.md": letters, digits, and "-", not "Issue-<n>.md".')
    }
    return { name, text: lines.slice(at + 1, starts[k + 1]).join('\n').trim() }
  })
  return {
    status: m[1] as Docs['status'],
    summary: (lastSection(lines.slice(0, starts[0]).join('\n'), 'Summary') ?? '').trim(),
    pages,
  }
}
