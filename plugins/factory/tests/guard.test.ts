import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import { reachesGitHub } from '../lib/guard.ts'

for (const cmd of [
  'gh pr list', 'cd /w && gh issue comment 3 --body x', '/opt/homebrew/bin/gh api user', 'echo hi; gh pr merge 9',
  'git push origin HEAD', 'cd /w && git -C /w push --force', 'git commit -m x && git push',
  'bash -c "git push origin HEAD"', "sh -c 'gh pr list'", 'git commit -m "docs: x" && git push', 'git -C "/Users/me/Application Support/w" push',
  'rtk gh pr list', 'rtk git push origin HEAD',
]) {
  test(`reachesGitHub finds: ${cmd}`, () => {
    expect(reachesGitHub(cmd)).toBe(true)
  })
}

for (const cmd of [
  'git status', 'git log --oneline', 'npm run test', 'grep -rn high .', 'git commit -m "fix: x"', 'ls ghost', 'rtk git status',
  // Seen in the E2E: a commit message that names push is not a push.
  'git commit --allow-empty -m "docs: explain push rules"', "git commit -m 'feat(api): add push notifications'",
]) {
  test(`reachesGitHub allows: ${cmd}`, () => {
    expect(reachesGitHub(cmd)).toBe(false)
  })
}

const agent = (id: string, type: string) => ({
  id, type, description: 'd', status: 'running', kind: 'local_agent', taskStatus: 'running',
})

function host(on: On): string[] {
  const ran: string[] = []
  on('agent.list', async () => ({ value: [agent('f1', 'factory:builder'), agent('o1', 'Explore')] }) as never)
  on('tool.call', { tool: 'Bash' }, async (_$, e) => {
    ran.push(String((e as { command?: unknown }).command))
    return { result: 'ran' } as never
  })
  return ran
}

test('a factory subagent cannot run gh or git push', async ($, on) => {
  const ran = host(on)
  for (const command of ['gh pr merge 9', 'git push origin HEAD']) {
    const r = await $.tool.call({ tool: 'Bash', command, agentId: 'f1' })
    expect((r as { deny?: string }).deny).toContain('no GitHub access')
  }
  expect(ran).toEqual([])
})

test('an unknown subagent cannot run gh', async ($, on) => {
  const ran = host(on)
  const r = await $.tool.call({ tool: 'Bash', command: 'gh pr list', agentId: 'x9' })
  expect((r as { deny?: string }).deny).toContain('no GitHub access')
  expect(ran).toEqual([])
})

test('other Bash calls pass', async ($, on) => {
  const ran = host(on)
  await $.tool.call({ tool: 'Bash', command: 'git status', agentId: 'f1' })
  await $.tool.call({ tool: 'Bash', command: 'gh pr list' })
  await $.tool.call({ tool: 'Bash', command: 'gh pr list', agentId: 'o1' })
  expect(ran).toEqual(['git status', 'gh pr list', 'gh pr list'])
})

// A user hook that wraps each Bash command, as `rtk` does.
function rewriteHook(on: On): string[] {
  const seen: string[] = []
  on('classic.PreToolUse', async (_$, e) => {
    const command = String((e as { command?: unknown }).command)
    seen.push(command)
    return { updatedInput: { command: `rtk ${command}` } }
  })
  return seen
}

test('a PreToolUse rewrite does not reach the guard', async ($, on) => {
  host(on)
  const seen = rewriteHook(on)
  const r = await $.tool.call({ tool: 'Bash', command: 'git status', agentId: 'f1' })
  expect(String((r as { deny?: string }).deny ?? '')).not.toContain('no GitHub access')
  expect(seen).toEqual(['git status'])
})

test('the guard denies gh before a PreToolUse rewrite', async ($, on) => {
  const ran = host(on)
  const seen = rewriteHook(on)
  const r = await $.tool.call({ tool: 'Bash', command: 'gh pr list', agentId: 'f1' })
  expect((r as { deny?: string }).deny).toContain('no GitHub access')
  expect(seen).toEqual([])
  expect(ran).toEqual([])
})

// A fake core for command.run, so that the mod hook can call next(e).
function runHost(on: On): string[] {
  on('command.run', async () => ({ text: 'ran' }) as never)
  return host(on)
}

test('the main session cannot run Bash after /factory:run', async ($, on) => {
  const ran = runHost(on)
  await $.command.run({ command: 'factory:run' } as never)
  const r = await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect((r as { deny?: string }).deny).toContain('main session')
  expect(ran).toEqual([])
})

test('the main session runs Bash when no factory run started', async ($, on) => {
  const ran = runHost(on)
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await $.command.run({ command: 'factory:status' } as never)
  await $.tool.call({ tool: 'Bash', command: 'git status' })
  expect(ran).toEqual(['ls', 'git status'])
})

test('subagents keep Bash during a factory run', async ($, on) => {
  const ran = runHost(on)
  await $.command.run({ command: 'factory:run' } as never)
  await $.tool.call({ tool: 'Bash', command: 'git status', agentId: 'f1' })
  await $.tool.call({ tool: 'Bash', command: 'ls', agentId: 'o1' })
  const r = await $.tool.call({ tool: 'Bash', command: 'gh pr list', agentId: 'f1' })
  expect((r as { deny?: string }).deny).toContain('no GitHub access')
  expect(ran).toEqual(['git status', 'ls'])
})
