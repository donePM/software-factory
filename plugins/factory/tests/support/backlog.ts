import { defaultConfig } from '../../lib/config.ts'
import type { Reply } from './host.ts'

// The backlog replies and files of one status read: running #3 in round 2, approved #42 with PR 50, ready #6.
export const raw = (n: number, labels: string[]) => JSON.stringify({
  number: n, title: `t${n}`, body: '', labels: ['factory', ...labels].map(name => ({ name })), user: { login: 'a' },
  created_at: '2026-01-01T00:00:00Z', html_url: `https://github.com/o/r/issues/${n}`, state: 'open',
})
export const OPEN = 'repos/o/r/issues?labels=factory&state=open&per_page=100'
export const backlogReplies = (open: Partial<Reply['result']> = { stdout: [raw(3, ['factory:build']), raw(42, ['factory:approved']), raw(6, [])].join('\n') }): Reply[] => [
  { argv: ['gh', 'api', OPEN], result: open },
  { argv: ['gh', 'api', 'repos/o/r/issues?labels=factory,factory:docs&state=closed&per_page=100'] },
  { argv: ['gh', 'api', 'repos/o/r/issues?labels=factory,factory:needs-human&state=closed&per_page=100'] },
  { argv: ['gh', 'api', 'repos/o/r/pulls?head=o:factory/42&state=all&per_page=100'], result: { stdout: JSON.stringify({ number: 50, state: 'open', draft: false, title: 'x', body: '', user: { login: 'a' }, node_id: 'N', html_url: 'https://github.com/o/r/pull/50', head: { ref: 'factory/42', sha: 'abc' }, merged_at: null, merge_commit_sha: null }) } },
]
const JOB_MD = '# Job #3\n\n## Job\n- Issue: 3\n- Round: 2\n\n## Route\n- code: sonnet\n- security: opus\n'
export const files = (project = { enabled: true, number: 3 }) => ({
  '/repo/.factory/config.json': JSON.stringify({ ...defaultConfig('https://github.com/o/r', 'main', []), concurrency: 2, project }),
  '/repo/.factory/jobs/3/job.md': JOB_MD,
  '/repo/.factory/jobs/3/round-2/review-code.md': 'VERDICT: PASS\n',
})
