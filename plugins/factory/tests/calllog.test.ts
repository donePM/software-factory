import { expect, test } from 'claude-code/testing'
import { FactoryError } from '../lib/exec.ts'
import { invoke, type ToolDef } from '../hooks/tools.ts'
import { fakeCtx, type Reply } from './support/host.ts'

const T = '2026-01-01T00:00:00.000Z'
const LOGS = '/repo/.factory/logs/'
const def = (handler: ToolDef['handler']): ToolDef => ({ name: 'probe', description: 'd', inputSchema: {}, handler })

function logsOf(files: Record<string, string>): string[] {
  return Object.keys(files).filter(p => p.startsWith(LOGS))
}

function linesOf(files: Record<string, string>): string[] {
  const paths = logsOf(files)
  expect(paths.length).toBe(1)
  return files[paths[0]!]!.trimEnd().split('\n')
}

test('writes the start line before the handler runs', async () => {
  const ctx = fakeCtx()
  let seen: string[] = []
  await invoke(def(async () => { seen = logsOf(ctx.files).map(p => ctx.files[p]!); return {} }), ctx, {})
  expect(seen).toEqual([`${T} start probe\n`])
  expect(logsOf(ctx.files)[0]).toMatch(/^\/repo\/\.factory\/logs\/[^/]+-probe-[^/]+\.log$/)
})

test('writes the end line for ok, error, and exception', async () => {
  const ok = fakeCtx()
  await invoke(def(async () => ({})), ok, {})
  expect(linesOf(ok.files)).toEqual([`${T} start probe`, `${T} end probe ok 0ms`])

  const err = fakeCtx()
  await invoke(def(async () => { throw new FactoryError('nope', 'it broke') }), err, {})
  expect(linesOf(err.files).at(-1)).toBe(`${T} end probe error nope 0ms`)

  const exc = fakeCtx()
  await invoke(def(async () => { throw new Error('spawn timeout') }), exc, {})
  expect(linesOf(exc.files).at(-1)).toBe(`${T} end probe exception spawn timeout 0ms`)
})

test('logs argv, exit code, duration, and output of each run', async () => {
  const replies: Reply[] = [{ argv: ['git', 'status'], result: { exitCode: 1, stdout: 'a\nb', stderr: 'bad' } }]
  const ctx = fakeCtx({ replies })
  const base = ctx.run
  ctx.run = async (argv, opts) => (argv[0] === 'boom' ? Promise.reject(new Error('spawn failed')) : base(argv, opts))
  let rejected = ''
  const r = await invoke(def(async c => {
    await c.run(['git', 'status'])
    await c.run(['boom']).catch((e: Error) => { rejected = e.message })
    return {}
  }), ctx, {})
  expect(r).toEqual({ result: '{}' })
  expect(rejected).toBe('spawn failed')
  expect(linesOf(ctx.files)).toEqual([
    `${T} start probe`,
    `${T} run ["git","status"] exit 1 0ms stdout "a\\nb" stderr "bad"`,
    `${T} run ["boom"] threw spawn failed 0ms`,
    `${T} end probe ok 0ms`,
  ])
})

test('cuts long output and logs no env or stdin', async () => {
  const long = 'x'.repeat(2500)
  const ctx = fakeCtx({ replies: [{ argv: ['cat'], result: { stdout: long, stderr: long } }] })
  await invoke(def(async c => c.run(['cat', long], { env: { GH_TOKEN: 'secret-env' }, stdin: 'secret-stdin' })), ctx, { input: 'secret-input' })
  const text = linesOf(ctx.files).join('\n')
  expect(text).toContain(`stdout "${'x'.repeat(2000)}...[+500 chars]"`)
  expect(text).toContain(`stderr "${'x'.repeat(2000)}...[+500 chars]"`)
  expect(text).toContain('...[+')
  expect(text.length).toBeLessThan(7000)
  expect(text).not.toContain('secret-env')
  expect(text).not.toContain('secret-stdin')
  expect(text).not.toContain('secret-input')
})

test('keeps all lines of parallel runs', async () => {
  const ctx = fakeCtx()
  const write = ctx.fs.write
  let release = (): void => {}
  const held = new Promise<void>(r => { release = r })
  // The write of the first run line is slow. It must not drop the lines of later writes.
  ctx.fs.write = async (p, text) => {
    if (text.includes('"r0"') && !text.includes('"r1"')) await held
    return write(p, text)
  }
  await invoke(def(async c => {
    await Promise.all([0, 1, 2, 3].map(i => c.run([`r${i}`])))
    release()
  }), ctx, {})
  const lines = linesOf(ctx.files)
  for (const i of [0, 1, 2, 3]) expect(lines.some(l => l.includes(`["r${i}"]`))).toBe(true)
  expect(lines.at(-1)).toBe(`${T} end probe ok 0ms`)
})
