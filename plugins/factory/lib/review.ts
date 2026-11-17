import { FactoryError } from './exec.ts'
import { lastSection } from './jobfile.ts'

export type Finding = { severity: 'blocker' | 'should' | 'nit'; text: string }

const bad = (code: string, m: string): FactoryError => new FactoryError(code, m)
const firstLine = (text: string): string => (text.split(/\r\n|\r|\n/, 1)[0] ?? '').trimEnd()

export function parseReview(text: string): { verdict: 'PASS' | 'CHANGES'; findings: Finding[] } {
  const m = /^VERDICT: (PASS|CHANGES)$/.exec(firstLine(text))
  if (!m) throw bad('bad-review', 'the first line must be exactly "VERDICT: PASS" or "VERDICT: CHANGES"')
  const verdict = m[1] as 'PASS' | 'CHANGES'
  const findings: Finding[] = []
  for (const line of (lastSection(text, 'Findings') ?? '').split(/\r\n|\r|\n/)) {
    const f = /^\d+\.\s+\[(blocker|should|nit)\]\s+(.+?)\s*$/.exec(line)
    if (f) findings.push({ severity: f[1] as Finding['severity'], text: f[2]! })
  }
  if (verdict === 'CHANGES' && !findings.some(f => f.severity !== 'nit')) {
    throw bad('bad-review', 'changes without blocker or should')
  }
  return { verdict, findings }
}

export function parseDecision(text: string): { decision: 'APPROVE' | 'ESCALATE'; summary: string; question?: string } {
  const m = /^DECISION: (APPROVE|ESCALATE)$/.exec(firstLine(text))
  if (!m) throw bad('bad-decision', 'the first line must be exactly "DECISION: APPROVE" or "DECISION: ESCALATE"')
  const decision = m[1] as 'APPROVE' | 'ESCALATE'
  const summary = (lastSection(text, 'Summary') ?? '').trim()
  if (summary === '') throw bad('bad-decision', 'decision.md needs a non-empty "## Summary"')
  if (decision === 'APPROVE') return { decision, summary }
  const question = (lastSection(text, 'Question') ?? '').trim()
  if (question === '') throw bad('bad-decision', 'an ESCALATE decision needs a non-empty "## Question"')
  return { decision, summary, question }
}
