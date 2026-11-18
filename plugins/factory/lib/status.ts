import type { Config } from './config.ts'
import { branchName } from './jobfile.ts'
import { queue } from './queue.ts'
import type { Queue } from './queue.ts'
import type { Tracker } from './tracker.ts'
import type { Ctx } from './types.ts'

const label = (n: number, titles: Record<number, string>): string => (titles[n] ? `#${n} ${titles[n]}` : `#${n}`)

// prs maps an issue number to its PR number; titles maps an issue number to its title.
export function statusText(repo: string, q: Queue, prs: Record<number, number>, concurrency: number, titles: Record<number, string> = {}): string {
  const lines = [`Factory · ${repo}  ${q.running.length}/${concurrency} slots`]
  const section = (name: string, rows: string[]): void => {
    lines.push('', name, ...rows.map(r => `  ${r}`))
  }
  if (q.ready.length > 0) section(`Ready (${q.ready.length})`, q.ready.map(i => `#${i.number} ${i.title}`))
  if (q.running.length > 0) section('Running', q.running.map(r => `${label(r.number, titles)}  ${r.state}`))
  const rows: string[] = []
  for (const w of q.waiting) {
    const n = w.number
    const pr = prs[n]
    const link = pr === undefined ? '' : ` (https://github.com/${repo}/pull/${pr})`
    if (w.state === 'approved') {
      rows.push(`${label(n, titles)}  approved: /factory:merge ${n}${link}`, `    not yet approved by you? /factory:approve ${n}`)
    } else if (w.state === 'needs-human' && pr !== undefined) {
      rows.push(`${label(n, titles)}  needs you: /factory:merge ${n}${link}`)
    } else if (w.state === 'needs-human') {
      rows.push(`${label(n, titles)}  needs you: answer in the issue, then /factory:run`)
    } else if (w.state === 'needs-info') {
      rows.push(`${label(n, titles)}  needs info: author answers in the issue`)
    } else {
      // needs-design and any state without its own hint
      rows.push(`${label(n, titles)}  ${w.state}: see the issue https://github.com/${repo}/issues/${n}`)
    }
  }
  if (rows.length > 0) section('Waiting for you', rows)
  if (q.running.length === 0 && q.ready.length === 0 && rows.length === 0) {
    lines.push('', 'Nothing to do. Add work with /factory:add <text>')
  } else if (q.running.length === 0 && q.ready.length > 0) {
    lines.push('', 'Start the ready work with /factory:run')
  }
  return lines.join('\n')
}

// One gh call per waiting ticket that can have a PR; a failed lookup leaves the PR out.
export async function statusFor(ctx: Ctx, tr: Tracker, cfg: Config): Promise<string> {
  const q = await queue(ctx, tr, cfg)
  const titles: Record<number, string> = {}
  for (const t of await tr.backlog()) titles[t.number] = t.title
  const prs: Record<number, number> = {}
  for (const w of q.waiting) {
    if (w.state !== 'approved' && w.state !== 'needs-human') continue
    const pr = await tr.findPr(branchName(w.number)).catch(() => null)
    if (pr) prs[w.number] = pr.number
  }
  return statusText(tr.repo, q, prs, cfg.concurrency, titles)
}
