import { expect, test } from 'claude-code/testing'
import { FactoryError } from '../lib/exec.ts'
import { invoke, type ToolDef } from '../hooks/tools.ts'
import { fakeCtx, fakeHost } from './support/host.ts'

export const EXPECTED: string[] = []

test('registers exactly the expected tools undeferred', async ($, on) => {
  const { registered } = fakeHost(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: false })
  expect(registered.map(t => t.name).sort()).toEqual([...EXPECTED].sort())
  for (const t of registered) expect(t.isDeferred).toBe(false)
})

const def = (handler: ToolDef['handler']): ToolDef => ({ name: 't', description: 'd', inputSchema: {}, handler })

test('a tool success returns pretty JSON', async () => {
  const r = await invoke(def(async () => ({ a: 1 })), fakeCtx(), {})
  expect(r).toEqual({ result: JSON.stringify({ a: 1 }, null, 2) })
})

test('a FactoryError maps to isError with the fix', async () => {
  const r = await invoke(def(async () => { throw new FactoryError('nope', 'it broke', 'do x') }), fakeCtx(), {})
  expect(r).toEqual({ isError: true, result: undefined, text: 'nope: it broke\nFix: do x' })
})
