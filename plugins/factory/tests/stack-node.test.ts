import { expect, test } from 'claude-code/testing'
import { FactoryError } from '../lib/exec.ts'
import { resolveSteps } from '../lib/stacks/index.ts'
import { node } from '../lib/stacks/node.ts'
import type { Detection } from '../lib/stacks/types.ts'
import { fakeCtx } from './support/host.ts'
import { nodeMonorepo } from './fixtures/node-monorepo.ts'
import { nodeScripts } from './fixtures/node-scripts.ts'
import { nodeVp } from './fixtures/node-vp.ts'

const inRepo = (files: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(files).map(([k, v]) => [`/repo/${k}`, v]))
const detect = (files: Record<string, string>): Promise<Detection[]> =>
  node.detect(fakeCtx({ files: inRepo(files) }), '/repo', Object.keys(files))
const reader = (files: Record<string, string>, prefix = '') => async (r: string): Promise<string | null> =>
  files[prefix + r] ?? null
const stepsOf = async (files: Record<string, string>) => {
  const [d] = await detect(files)
  return node.steps(fakeCtx(), reader(files), d!)
}
const argvOf = (steps: { name: string; argv: string[] }[], name: string): string[][] =>
  steps.filter(s => s.name === name).map(s => s.argv)

test('picks pnpm from pnpm-lock.yaml', async () => {
  const steps = await stepsOf(nodeVp)
  expect(argvOf(steps, 'install')).toEqual([['pnpm', 'install', '--frozen-lockfile']])
  const [d] = await detect(nodeVp)
  expect(d).toMatchObject({ stack: 'node', path: '.', variant: 'typescript' })
})

test('falls back to npm ci', async () => {
  const steps = await stepsOf({ 'package.json': '{}' })
  expect(argvOf(steps, 'install')).toEqual([['npm', 'ci']])
  expect(argvOf(steps, 'audit')).toEqual([['npm', 'audit']])
})

test('maps yarn and bun lockfiles', async () => {
  expect(argvOf(await stepsOf({ 'package.json': '{}', 'yarn.lock': '' }), 'install')).toEqual([['yarn', 'install', '--immutable']])
  expect(argvOf(await stepsOf({ 'package.json': '{}', 'bun.lockb': '' }), 'install')).toEqual([['bun', 'install', '--frozen-lockfile']])
  expect(argvOf(await stepsOf({ 'package.json': '{}', 'bun.lock': '' }), 'audit')).toEqual([['bun', 'audit']])
})

test('uses vp for format, lint, check and test', async () => {
  const steps = await stepsOf({ 'package.json': '{}' })
  expect(argvOf(steps, 'format')).toEqual([['vp', 'fmt', '--check']])
  expect(argvOf(steps, 'lint')).toEqual([['vp', 'lint']])
  expect(argvOf(steps, 'typecheck')).toEqual([['vp', 'check']])
  expect(argvOf(steps, 'test')).toEqual([['vp', 'test']])
})

test('adds tsc --noEmit for TypeScript', async () => {
  const steps = await stepsOf(nodeVp)
  expect(argvOf(steps, 'typecheck')).toEqual([['vp', 'check'], ['tsc', '--noEmit']])
})

test('a package.json script beats the default', async () => {
  const steps = await stepsOf(nodeVp)
  expect(argvOf(steps, 'test')).toEqual([['vp', 'test']])
  const files = { ...nodeVp, 'package.json': '{"scripts":{"test":"vitest run","build":"vite build"}}' }
  const s2 = await stepsOf(files)
  expect(s2.filter(s => s.name === 'test')).toMatchObject([{ argv: ['pnpm', 'run', 'test'], source: 'script' }])
  expect(argvOf(s2, 'build')).toEqual([['pnpm', 'run', 'build']])
})

test('no build script, no build step', async () => {
  const steps = await stepsOf(nodeVp)
  expect(steps.some(s => s.name === 'build')).toBe(false)
})

test('finds web/ and api/ in a monorepo, skips node_modules', async () => {
  const ds = await detect(nodeMonorepo)
  expect(ds.map(d => d.path)).toEqual(['web', 'api'])
  expect(ds.map(d => d.variant)).toEqual(['typescript', 'javascript'])
})

test('takes the package manager from the own lockfile, else the nearest parent lockfile', async () => {
  const [web, api] = await detect(nodeMonorepo)
  const readAt = (d: Detection) => node.steps(fakeCtx(), reader(nodeMonorepo), d)
  expect(argvOf(await readAt(web!), 'install')).toEqual([['pnpm', 'install', '--frozen-lockfile']])
  expect(argvOf(await readAt(api!), 'install')).toEqual([['yarn', 'install', '--immutable']])
})

test('reads the node version from .nvmrc, then engines.node', async () => {
  const [a] = await detect(nodeVp)
  expect(a!.versions.node).toBe('22')
  const [b] = await detect(nodeScripts)
  expect(b!.versions.node).toBe('>=20')
})

test('requires node, the package manager, vp and tsc for TypeScript', async () => {
  const [d] = await detect(nodeVp)
  expect(node.requires(d!).map(r => r.cmd)).toEqual(['node', 'pnpm', 'vp', 'tsc'])
  expect(node.requires(d!).find(r => r.cmd === 'vp')!.fix).toContain('https://viteplus.dev')
  const [j] = await detect({ 'package.json': '{}' })
  expect(node.requires(j!).map(r => r.cmd)).toEqual(['node', 'npm', 'vp'])
})

test('an invalid package.json fails with bad-package-json', async () => {
  const files = { 'package.json': '{oops' }
  const [d] = await detect(files)
  const err = await node.steps(fakeCtx(), reader(files), d!).catch((e: unknown) => e)
  expect(err).toBeInstanceOf(FactoryError)
  expect((err as FactoryError).code).toBe('bad-package-json')
  expect((err as FactoryError).fix).toBeTruthy()
})

test('monorepo steps run in their package folder and are not merged', async () => {
  const files = { ...nodeMonorepo, 'web/package.json': '{"scripts":{"test":"vitest run"}}' }
  const ds = await detect(files)
  const steps = await resolveSteps(fakeCtx(), '/repo', reader(files), [], ds)
  const web = steps.filter(s => s.cwd === '/repo/web')
  const api = steps.filter(s => s.cwd === '/repo/api')
  expect(web.length).toBeGreaterThan(0)
  expect(api.length).toBeGreaterThan(0)
  expect(steps.filter(s => s.name === 'lint').map(s => s.cwd)).toEqual(['/repo/web', '/repo/api'])
  expect(web.filter(s => s.name === 'test')).toMatchObject([{ argv: ['pnpm', 'run', 'test'], source: 'script' }])
  expect(api.filter(s => s.name === 'test')).toMatchObject([{ argv: ['vp', 'test'], source: 'default' }])
})
