import { repoFromUrl } from './github.ts'
import type { StackRef } from './config.ts'
import type { Ctx } from './types.ts'

export type Check = { check: string; ok: boolean; detail: string; fix?: string }

const LOGIN = '! gh auth login --web'

const first = (text: string): string => text.trim().split('\n')[0] ?? ''

async function tool(ctx: Ctx, name: string): Promise<Check> {
  const r = await ctx.run([name, '--version'])
  if (r.exitCode === 0) return { check: name, ok: true, detail: first(r.stdout) }
  return { check: name, ok: false, detail: `${name} is not installed`, fix: `brew install ${name}` }
}

async function auth(ctx: Ctx): Promise<Check> {
  const r = await ctx.run(['gh', 'auth', 'status'])
  if (r.exitCode !== 0) return { check: 'gh auth', ok: false, detail: 'gh is not logged in', fix: LOGIN }
  const text = `${r.stdout}\n${r.stderr}`
  const login = /account (\S+)/.exec(text)?.[1] ?? 'unknown'
  const scopes = /Token scopes:(.*)/.exec(text)?.[1]
  // Fine-grained tokens show no scope line, so only a listed scope set can fail.
  if (scopes !== undefined && !/\brepo\b/.test(scopes)) {
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

// Stack tool checks arrive with the stack detectors (Task 7).
export async function doctor(ctx: Ctx, _stacks: StackRef[]): Promise<Check[]> {
  const git = await tool(ctx, 'git')
  if (!git.ok) return [git]
  const gh = await tool(ctx, 'gh')
  const checks = [git, gh]
  if (gh.ok) checks.push(await auth(ctx))
  checks.push(await origin(ctx))
  return checks
}
