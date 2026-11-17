import { expect, test } from 'claude-code/testing'
import { defaultConfig } from '../lib/config.ts'
import { type Intake, parseIntake } from '../lib/intake.ts'
import { route } from '../lib/route.ts'

const head = (decision = 'ACCEPT', risk = 'low', surfaces = 'none', lane = 'regular'): string =>
  `DECISION: ${decision}\nRISK: ${risk}\nSURFACES: ${surfaces}\nLANE: ${lane}\n\n## Summary\nx\n`
const intake = (risk: Intake['risk'], surfaces: string[]): Intake => ({ decision: 'ACCEPT', risk, surfaces, lane: 'regular' })
const cfg = defaultConfig('u', 'main', [])
const bad = (text: string): Promise<unknown> => Promise.resolve().then(() => parseIntake(text))

test('parseIntake reads the four header lines', () => {
  expect(parseIntake(head('NEEDS-INFO', 'high', 'ui, api'))).toEqual({
    decision: 'NEEDS-INFO', risk: 'high', surfaces: ['ui', 'api'], lane: 'regular',
  })
  expect(parseIntake(head('REJECT')).decision).toBe('REJECT')
})

test('parseIntake rejects a missing RISK line', async () => {
  await expect(bad('DECISION: ACCEPT\nSURFACES: none\nLANE: regular\n')).rejects.toMatchObject({
    code: 'bad-intake', message: expect.stringContaining('RISK'),
  })
})

test('parseIntake rejects fastlane for now', async () => {
  await expect(bad(head('ACCEPT', 'low', 'none', 'fastlane'))).rejects.toMatchObject({
    code: 'bad-intake', message: 'fastlane is not available yet',
  })
})

test('parseIntake rejects an unknown surface, decision and risk', async () => {
  await expect(bad(head('ACCEPT', 'low', 'ui, db'))).rejects.toMatchObject({ code: 'bad-intake' })
  await expect(bad(head('MAYBE'))).rejects.toMatchObject({ code: 'bad-intake' })
  await expect(bad(head('ACCEPT', 'extreme'))).rejects.toMatchObject({ code: 'bad-intake' })
})

test('parseIntake tolerates CRLF and trailing spaces', () => {
  const text = 'DECISION: ACCEPT  \r\nRISK: medium \r\nSURFACES: ui  \r\nLANE: regular\r\n\r\nbody'
  expect(parseIntake(text)).toEqual({ decision: 'ACCEPT', risk: 'medium', surfaces: ['ui'], lane: 'regular' })
})

test('parseIntake de-duplicates surfaces', () => {
  expect(parseIntake(head('ACCEPT', 'low', 'ui, api, ui')).surfaces).toEqual(['ui', 'api'])
})

test('parseIntake accepts none alone as an empty list and rejects none with another surface', async () => {
  expect(parseIntake(head()).surfaces).toEqual([])
  await expect(bad(head('ACCEPT', 'low', 'none, ui'))).rejects.toMatchObject({ code: 'bad-intake' })
})

test('parseIntake rejects an empty SURFACES line', async () => {
  await expect(bad(head('ACCEPT', 'low', ''))).rejects.toMatchObject({ code: 'bad-intake' })
})

test('parseIntake rejects lines in the wrong order', async () => {
  await expect(bad('RISK: low\nDECISION: ACCEPT\nSURFACES: none\nLANE: regular\n')).rejects.toMatchObject({ code: 'bad-intake' })
})

test('route low risk gives only code haiku', () => {
  expect(route(intake('low', []), cfg)).toEqual({ code: 'haiku' })
})

test('route high + ui gives security opus, ux sonnet, ui haiku', () => {
  expect(route(intake('high', ['ui']), cfg)).toEqual({ code: 'sonnet', security: 'opus', ux: 'sonnet', ui: 'haiku' })
})

test('route takes the stronger model on overlap', () => {
  expect(route(intake('low', ['ui', 'ui-new']), cfg)).toEqual({ code: 'haiku', ux: 'sonnet', ui: 'sonnet' })
  const c = { ...cfg, surfaces: { ui: { ui: 'opus' as const }, 'ui-new': { ui: 'haiku' as const } } }
  expect(route(intake('low', ['ui', 'ui-new']), c).ui).toBe('opus')
})

test('route ranks fable above opus', () => {
  const c = { ...cfg, surfaces: { api: { security: 'fable' as const } } }
  expect(route(intake('high', ['api']), c).security).toBe('fable')
})

test('route always includes code, default sonnet', () => {
  const c = { ...cfg, routing: { ...cfg.routing, low: {} } }
  expect(route(intake('low', []), c)).toEqual({ code: 'sonnet' })
})

test('route ignores a surface that the config does not know', () => {
  expect(route(intake('low', ['api']), { ...cfg, surfaces: {} })).toEqual({ code: 'haiku' })
})
