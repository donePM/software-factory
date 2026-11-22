import { repoFromUrl } from './github.ts'
import type { StackRef } from './config.ts'
import { detectAll, STACKS } from './stacks/index.ts'
import type { ToolReq } from './stacks/types.ts'
import type { Ctx } from './types.ts'

export type Check = { check: string; ok: boolean; detail: string; fix?: string }

const LOGIN = '! gh auth login --web'

const first = (text: string): string => text.trim().split('\n')[0] ?? ''

async function tool(ctx: Ctx, name: string): Promise<Check> {
  const r = await ctx.run([name, '--version'])
  if (r.exitCode === 0) return { check: name, ok: true, detail: first(r.stdout) }
  return { check: name, ok: false, detail: `${name} is not installed`, fix: `brew install ${name}` }
}

async function req(ctx: Ctx, r: ToolReq): Promise<Check> {
  const res = await ctx.run([r.cmd, ...r.versionArgs])
  const check = r.cmd === 'sh' ? 'engine types' : r.cmd
  if (res.exitCode === 0) return { check, ok: true, detail: first(res.stdout) || 'ok' }
  return { check, ok: false, detail: `${check} is not available`, fix: r.fix }
}

async function stackChecks(ctx: Ctx, stacks: StackRef[]): Promise<Check[]> {
  let found
  try {
    found = await detectAll(ctx, ctx.root)
  } catch (e) {
    return [{ check: 'stacks', ok: false, detail: `stack detection failed: ${(e as Error).message}`, fix: 'Run the factory inside a git repository.' }]
  }
  const out: Check[] = []
  const seen = new Set<string>()
  for (const d of found) {
    if (stacks.length > 0 && !stacks.some(s => s.id === d.stack && s.path === d.path)) continue
    const stack = STACKS.find(s => s.id === d.stack)
    for (const r of stack?.requires(d) ?? []) {
      const key = JSON.stringify([r.cmd, r.versionArgs])
      if (seen.has(key)) continue
      seen.add(key)
      out.push(await req(ctx, r))
    }
  }
  return out
}

// text: the output of `gh auth status`. Fine-grained tokens show no scope line, so only a listed scope set can miss a scope.
export function lacksScope(text: string, scope: string): boolean {
  const scopes = /Token scopes:(.*)/.exec(text)?.[1]
  return scopes !== undefined && !scopes.split(',').map(s => s.trim().replace(/^'|'$/g, '')).includes(scope)
}

async function auth(ctx: Ctx): Promise<Check> {
  const r = await ctx.run(['gh', 'auth', 'status'])
  if (r.exitCode !== 0) return { check: 'gh auth', ok: false, detail: 'gh is not logged in', fix: LOGIN }
  const text = `${r.stdout}\n${r.stderr}`
  const login = /account (\S+)/.exec(text)?.[1] ?? 'unknown'
  if (lacksScope(text, 'repo')) {
    return { check: 'gh auth', ok: false, detail: `${login} has no repo scope`, fix: 'gh auth refresh -s repo' }
  }
  return { check: 'gh auth', ok: true, detail: `logged in as ${login}` }
}

async function origin(ctx: Ctx): Promise<Check> {
  const r = await ctx.run(['git', 'remote', 'get-url', 'origin'])
  const url = r.stdout.trim()
  if (r.exitCode !== 0 || url === '') {
    return { check: 'origin', ok: false, detail: 'no origin remote', fix: 'git remote add origin <GitHub URL>' }
  }
  try {
    return { check: 'origin', ok: true, detail: repoFromUrl(url) }
  } catch {
    return { check: 'origin', ok: false, detail: `origin is not a GitHub URL: ${url}`, fix: 'Point origin at a GitHub repository.' }
  }
}

export async function doctor(ctx: Ctx, stacks: StackRef[]): Promise<Check[]> {
  const git = await tool(ctx, 'git')
  if (!git.ok) return [git]
  const gh = await tool(ctx, 'gh')
  const checks = [git, gh]
  if (gh.ok) checks.push(await auth(ctx))
  checks.push(await origin(ctx))
  checks.push(...(await stackChecks(ctx, stacks)))
  return checks
}
