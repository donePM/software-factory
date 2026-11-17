import { FactoryError } from './exec.ts'

export type Intake = {
  decision: 'ACCEPT' | 'NEEDS-INFO' | 'REJECT'
  risk: 'low' | 'medium' | 'high'
  surfaces: string[]
  lane: 'regular'
}

const DECISIONS: readonly string[] = ['ACCEPT', 'NEEDS-INFO', 'REJECT']
const RISKS: readonly string[] = ['low', 'medium', 'high']
const SURFACES: readonly string[] = ['ui', 'ui-new', 'security', 'api', 'none']

const bad = (m: string): FactoryError => new FactoryError('bad-intake', m)

function header(lines: string[], i: number, key: string): string {
  const line = lines[i] ?? ''
  const prefix = `${key}:`
  if (!line.startsWith(prefix)) throw bad(`line ${i + 1} must start with "${prefix}", got "${line}"`)
  return line.slice(prefix.length).trim()
}

export function parseIntake(text: string): Intake {
  const lines = text.split(/\r\n|\r|\n/).map(l => l.trimEnd())
  const decision = header(lines, 0, 'DECISION')
  const risk = header(lines, 1, 'RISK')
  const surfaces = header(lines, 2, 'SURFACES')
  const lane = header(lines, 3, 'LANE')
  if (!DECISIONS.includes(decision)) throw bad(`DECISION must be one of ${DECISIONS.join(', ')}, got "${decision}"`)
  if (!RISKS.includes(risk)) throw bad(`RISK must be one of ${RISKS.join(', ')}, got "${risk}"`)
  if (lane === 'fastlane') throw bad('fastlane is not available yet')
  if (lane !== 'regular') throw bad(`LANE must be regular, got "${lane}"`)
  const list = [...new Set(surfaces.split(',').map(s => s.trim()))]
  if (list.length === 1 && list[0] === '') throw bad('SURFACES must not be empty')
  for (const s of list) if (!SURFACES.includes(s)) throw bad(`SURFACES has unknown surface "${s}"`)
  if (list.includes('none') && list.length > 1) throw bad('SURFACES: none must stand alone')
  return {
    decision: decision as Intake['decision'],
    risk: risk as Intake['risk'],
    surfaces: list.filter(s => s !== 'none'),
    lane: 'regular',
  }
}
