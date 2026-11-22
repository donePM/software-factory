import { FactoryError } from './exec.ts'
import { lastSection } from './jobfile.ts'

export type Docs = { status: 'DONE' | 'BLOCKED'; summary: string; page: string }

// The page is all text after "## Page", so the page can have its own "##" headings.
export function parseDocs(text: string): Docs {
  const lines = text.split(/\r\n|\r|\n/)
  const m = /^STATUS: (DONE|BLOCKED)$/.exec((lines[0] ?? '').trimEnd())
  if (!m) throw new FactoryError('docs-not-done', 'docs.md must start with "STATUS: DONE" or "STATUS: BLOCKED"', 'The documenter must finish first.')
  const at = lines.findIndex(l => l.trim() === '## Page')
  const head = at < 0 ? lines : lines.slice(0, at)
  return {
    status: m[1] as Docs['status'],
    summary: (lastSection(head.join('\n'), 'Summary') ?? '').trim(),
    page: at < 0 ? '' : lines.slice(at + 1).join('\n').trim(),
  }
}
