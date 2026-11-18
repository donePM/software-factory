import { loadConfig } from './config.ts'
import { FactoryError } from './exec.ts'
import { runGate, type GateResult } from './gate.ts'
import { jobDir, readJob } from './jobfile.ts'
import type { Ctx } from './types.ts'

const NO_JOB = 'Run job_create first.'
const SHA40 = /^[0-9a-f]{40}$/

async function checkBase(ctx: Ctx, wt: string, base: string): Promise<void> {
  const bad = (m: string): FactoryError => new FactoryError('bad-job-base', m, NO_JOB)
  if (!SHA40.test(base)) throw bad(`job.md Base "${base}" is not a full 40-character sha`)
  const head = (await ctx.run(['git', '-C', wt, 'rev-parse', 'HEAD'])).stdout.trim()
  if (head === base) throw bad('job.md Base equals the worktree HEAD')
  if ((await ctx.run(['git', '-C', wt, 'merge-base', '--is-ancestor', base, 'HEAD'])).exitCode !== 0) {
    throw bad('job.md Base is not an ancestor of the worktree HEAD')
  }
  const branch = `origin/${(await loadConfig(ctx)).baseBranch}`
  if ((await ctx.run(['git', '-C', ctx.root, 'merge-base', '--is-ancestor', base, branch])).exitCode !== 0) {
    throw bad(`job.md Base is not an ancestor of ${branch}`)
  }
}

// The one path to a job gate: config and plugin from the main checkout, base from job.md, title from spec.md.
export async function gateJob(ctx: Ctx, n: number, round: string): Promise<GateResult> {
  const dir = jobDir(ctx.root, n)
  if (!(await ctx.fs.exists(`${dir}/job.md`))) throw new FactoryError('no-job', `${dir}/job.md does not exist`, NO_JOB)
  const job = await readJob(ctx, n)
  if (!(await ctx.fs.exists(`${dir}/spec.md`))) throw new FactoryError('no-spec', `${dir}/spec.md does not exist`, 'Run the spec step first.')
  const title = /^Title:\s*(.+)$/m.exec(await ctx.fs.read(`${dir}/spec.md`))?.[1]?.trim()
  if (title === undefined) throw new FactoryError('spec-no-title', 'spec.md has no "Title:" line', 'The spec-writer must add a Title line.')
  await checkBase(ctx, job.worktree, job.base)
  const before = await headOf(ctx, job.worktree)
  const result = await runGate(ctx, { worktree: job.worktree, round, base: job.base, prTitle: title, jobDir: dir })
  const key = keyOf(ctx, n, round)
  passed.delete(key)
  if (result.verdict === 'PASS' && before !== '' && (await headOf(ctx, job.worktree)) === before) passed.set(key, before)
  return result
}

// Passing gates of this process: a later job_advance review at the same HEAD reuses the result.
const passed = new Map<string, string>()
const keyOf = (ctx: Ctx, n: number, round: string): string => `${ctx.root}#${n}#${round}`
const headOf = async (ctx: Ctx, wt: string): Promise<string> => (await ctx.run(['git', '-C', wt, 'rev-parse', 'HEAD'])).stdout.trim()

// The HEAD sha of the last passing gate for this job round, if the HEAD did not move during it.
export const passedAt = (ctx: Ctx, n: number, round: string): string | undefined => passed.get(keyOf(ctx, n, round))

export const forgetGates = (): void => passed.clear()
