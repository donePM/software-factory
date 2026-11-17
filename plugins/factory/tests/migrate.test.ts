import { expect, test } from 'claude-code/testing'
import { configPath, defaultConfig, writeConfig } from '../lib/config.ts'
import { migrate } from '../lib/config.ts'
import type { Migration } from '../lib/migrations/index.ts'
import { fakeCtx, fakeHost } from './support/host.ts'

const url = 'https://github.com/o/r'
const cfgAt = (version: number) => ({ ...defaultConfig(url, 'main', []), version })
const path = configPath('/repo')

const list: Migration[] = [
  { from: 0, name: 'a', up: old => ({ ...old, a: 1 }) },
  { from: 1, name: 'b', up: old => ({ ...old, b: 2 }) },
]

test('migrate applies steps in order and backs up', async () => {
  const ctx = fakeCtx({ files: { [path]: JSON.stringify(cfgAt(0)) } })
  const r = await migrate(ctx, list)
  expect(r).toEqual({ from: 0, to: 2, applied: ['a', 'b'], backup: '.factory/backup/config.0.json' })
  const out = JSON.parse(ctx.files[path]!)
  expect(out.version).toBe(2)
  expect(out.a).toBe(1)
  expect(out.b).toBe(2)
  expect(ctx.files['/repo/.factory/backup/config.0.json']).toBe(JSON.stringify(cfgAt(0)))
  expect(ctx.files[path]!.endsWith('}\n')).toBe(true)
})

test('migrate keeps the last three backups', async () => {
  const files: Record<string, string> = { [path]: JSON.stringify(cfgAt(5)) }
  for (const v of [1, 2, 3, 4]) files[`/repo/.factory/backup/config.${v}.json`] = '{}'
  const ctx = fakeCtx({ files, replies: [{ argv: ['rm'] }] })
  await migrate(ctx, [{ from: 5, name: 'c', up: old => old }])
  const rms = ctx.calls.filter(c => c[0] === 'rm').map(c => c[c.length - 1])
  expect(rms).toEqual(['/repo/.factory/backup/config.1.json', '/repo/.factory/backup/config.2.json'])
})

test('migrate leaves the config when the result is invalid', async () => {
  const before = JSON.stringify(cfgAt(1))
  const ctx = fakeCtx({ files: { [path]: before } })
  const err = await migrate(ctx, [{ from: 1, name: 'bad', up: () => ({ version: 2 }) }]).catch(e => e)
  expect(err.code).toBe('config-invalid')
  expect(ctx.files[path]).toBe(before)
})

test('migrate on current version is a no-op', async () => {
  const ctx = fakeCtx()
  await writeConfig(ctx, defaultConfig(url, 'main', []))
  const before = ctx.files[path]
  const r = await migrate(ctx)
  expect(r).toEqual({ from: 1, to: 1, applied: [] })
  expect(r.backup).toBeUndefined()
  expect(ctx.files[path]).toBe(before)
  expect(Object.keys(ctx.files)).toEqual([path])
})

test('tool migrate returns the migrate result', async ($, on) => {
  fakeHost(on, { files: { '/repo/.factory/config.json': JSON.stringify(defaultConfig(url, 'main', [])) } })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: false })
  const r = await $.tool.call({ tool: 'mcp__factory__migrate' })
  expect(JSON.parse((r as { result: string }).result)).toEqual({ from: 1, to: 1, applied: [] })
})

test('migrate rejects a config newer than the plugin', async () => {
  const before = JSON.stringify(cfgAt(9))
  const ctx = fakeCtx({ files: { [path]: before } })
  const err = await migrate(ctx).catch(e => e)
  expect(err.code).toBe('config_too_new')
  expect(err.message).toContain('9')
  expect(err.message).toContain('1')
  expect(err.fix).toBe('Update the factory plugin.')
  expect(ctx.files[path]).toBe(before)
})
