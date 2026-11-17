import { expect, test } from 'claude-code/testing'
import { CONFIG_VERSION, configPath, defaultConfig, loadConfig, validateConfig } from '../lib/config.ts'
import { fakeCtx } from './support/host.ts'

const url = 'https://github.com/o/r'

test('defaultConfig is valid', () => {
  expect(validateConfig(defaultConfig(url, 'main', []))).toEqual([])
})

test('validateConfig names a bad concurrency', () => {
  const errs = validateConfig({ ...defaultConfig(url, 'main', []), concurrency: 0 })
  expect(errs.some(e => e.includes('concurrency'))).toBe(true)
})

test('validateConfig rejects an unknown model', () => {
  const c = defaultConfig(url, 'main', [])
  c.routing.low = { code: 'gpt' as never }
  expect(validateConfig(c).some(e => e.includes('routing.low.code'))).toBe(true)
})

test('loadConfig without file says run setup', async () => {
  const err = await loadConfig(fakeCtx()).catch(e => e)
  expect(err.code).toBe('no-config')
  expect(err.fix).toContain('/factory:setup')
})

test('loadConfig with older version says run setup', async () => {
  const ctx = fakeCtx({ files: { [configPath('/repo')]: JSON.stringify({ ...defaultConfig(url, 'main', []), version: 0 }) } })
  const err = await loadConfig(ctx).catch(e => e)
  expect(err.code).toBe('config-outdated')
  expect(err.fix).toContain('/factory:setup')
})

test('loadConfig with an invalid file lists the errors', async () => {
  const ctx = fakeCtx({ files: { [configPath('/repo')]: JSON.stringify({ ...defaultConfig(url, 'main', []), maxRounds: 'x' }) } })
  const err = await loadConfig(ctx).catch(e => e)
  expect(err.code).toBe('config-invalid')
  expect(err.message).toContain('maxRounds')
})

test('loadConfig returns a valid config', async () => {
  const c = defaultConfig(url, 'main', [])
  const ctx = fakeCtx({ files: { [configPath('/repo')]: JSON.stringify(c) } })
  expect((await loadConfig(ctx)).version).toBe(CONFIG_VERSION)
})
