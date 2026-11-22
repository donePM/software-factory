import { expect, test } from 'claude-code/testing'
import { fakeCtx, type Reply } from './support/host.ts'
import { githubTracker, repoFromUrl } from '../lib/github.ts'
import type { Ctx } from '../lib/types.ts'

type Spy = Ctx & { calls: string[][]; stdins: { argv: string[]; stdin: string | undefined }[] }

function spyCtx(replies: Reply[]): Spy {
  const base = fakeCtx({ replies })
  const stdins: Spy['stdins'] = []
  const inner = base.run
  base.run = (argv, opts) => {
    stdins.push({ argv: [...argv], stdin: opts?.stdin })
    return inner(argv, opts)
  }
  return Object.assign(base, { stdins })
}

const has = (calls: string[][], ...prefix: string[]): boolean =>
  calls.some(c => prefix.every((p, i) => c[i] === p))

const raw = (labels: string[], n = 5, o: Record<string, unknown> = {}) => ({
  number: n, title: 'T', body: 'B', labels: labels.map(name => ({ name })), user: { login: 'alice' },
  created_at: '2026-01-01T00:00:00Z', html_url: `https://github.com/a/b/issues/${n}`, state: 'open', assignees: [], ...o,
})
const issueJson = (labels: string[], n = 5, o: Record<string, unknown> = {}) => JSON.stringify(raw(labels, n, o))
const writes: Reply[] = [{ argv: ['gh', 'api', '-X'] }]
const getReplies = (labels: string[], comments: unknown[] = [], n = 5): Reply[] => [
  { argv: ['gh', 'api', `repos/a/b/issues/${n}`], result: { stdout: issueJson(labels, n) } },
  { argv: ['gh', 'api', `repos/a/b/issues/${n}/comments`], result: { stdout: comments.map(c => JSON.stringify(c)).join('\n') } },
]
const BACKLOG_ARGV = ['gh', 'api', 'repos/a/b/issues?labels=factory&state=open&per_page=100', '--paginate', '--jq', '.[]']
// Each gh call that is not a REST call is GraphQL.
const graphql = (calls: string[][]): string[][] => calls.filter(c => c[0] === 'gh' && (c[1] !== 'api' || c[2] === 'graphql'))

test('repoFromUrl handles https, .git and ssh', () => {
  expect(repoFromUrl('https://github.com/a/b')).toBe('a/b')
  expect(repoFromUrl('https://github.com/a/b.git')).toBe('a/b')
  expect(repoFromUrl('git@github.com:a/b.git')).toBe('a/b')
})

test('backlog is one REST call and drops pull requests', async () => {
  const pr = issueJson(['factory'], 8, { pull_request: { url: 'x' } })
  const ctx = spyCtx([{ argv: BACKLOG_ARGV.slice(0, 3), result: { stdout: `${issueJson(['factory', 'factory:spec'])}\n${pr}\n${issueJson(['factory'], 6, { body: null })}` } }])
  const [t, u, ...rest] = await githubTracker(ctx, 'a/b').backlog()
  expect(t).toEqual({
    kind: 'issue', number: 5, title: 'T', body: 'B', author: 'alice', labels: ['factory', 'factory:spec'],
    state: 'open', createdAt: '2026-01-01T00:00:00Z', url: 'https://github.com/a/b/issues/5', comments: [],
  })
  expect(u?.body).toBe('')
  expect(rest).toEqual([])
  expect(ctx.calls).toEqual([BACKLOG_ARGV])
})

test('backlog reads the Priority field value', async () => {
  const fields = [
    { number: 5, issue_field_values: [{ issue_field_id: 29998494, data_type: 'single_select', value: 'High', single_select_option: { name: 'High' } }] },
    { number: 6, issue_field_values: [] },
  ]
  const ctx = spyCtx([{ argv: BACKLOG_ARGV.slice(0, 3), result: { stdout: fields.map(f => issueJson(['factory'], f.number, f)).join('\n') } }])
  const [a, b] = await githubTracker(ctx, 'a/b').backlog()
  expect(a?.priority).toBe('High')
  expect(b).not.toHaveProperty('priority')
  expect(ctx.calls).toEqual([BACKLOG_ARGV])
})

test('get filters nothing but loads comments', async () => {
  const ctx = spyCtx([...writes, ...getReplies(['factory'], [
    { id: 55, user: { login: 'bob' }, body: 'hi', created_at: 'c1', updated_at: 'u1' },
    { id: 56, user: { login: 'eve' }, body: 'yo', created_at: 'c2', updated_at: 'u2' },
  ])])
  const t = await githubTracker(ctx, 'a/b').get(5)
  expect(t.comments).toEqual([
    { id: 55, author: 'bob', body: 'hi', createdAt: 'c1', updatedAt: 'u1' },
    { id: 56, author: 'eve', body: 'yo', createdAt: 'c2', updatedAt: 'u2' },
  ])
  expect(ctx.calls).toEqual([['gh', 'api', 'repos/a/b/issues/5'], ['gh', 'api', 'repos/a/b/issues/5/comments', '--paginate', '--jq', '.[]']])
})

test('get marks a pull request as kind pr', async () => {
  const pr = issueJson(['factory:pr'], 9, { html_url: 'https://github.com/a/b/pull/9', pull_request: { url: 'x' } })
  const ctx = spyCtx([{ argv: ['gh', 'api', 'repos/a/b/issues/9'], result: { stdout: pr } }, ...getReplies([], [], 9)])
  expect((await githubTracker(ctx, 'a/b').get(9)).kind).toBe('pr')
  expect((await githubTracker(spyCtx(getReplies(['factory'])), 'a/b').get(5)).kind).toBe('issue')
})

const PUT = ['gh', 'api', '-X', 'PUT', 'repos/a/b/issues/5/labels', '--input', '-']
const puts = (s: Spy) => s.stdins.filter(x => x.argv.includes('PUT')).map(x => ({ argv: x.argv, labels: JSON.parse(x.stdin!).labels }))

test('setState swaps exactly one status label in one read and one write', async () => {
  const ctx = spyCtx([...writes, ...getReplies(['factory', 'factory:intake', 'bug'])])
  expect(await githubTracker(ctx, 'a/b').setState(5, 'spec')).toBe('intake')
  expect(ctx.calls).toEqual([['gh', 'api', 'repos/a/b/issues/5'], PUT])
  expect(puts(ctx)).toEqual([{ argv: PUT, labels: ['factory', 'bug', 'factory:spec'] }])
  expect(graphql(ctx.calls)).toEqual([])
})

test('setState from the backlog only adds a label', async () => {
  const ctx = spyCtx([...writes, ...getReplies(['factory'])])
  expect(await githubTracker(ctx, 'a/b').setState(5, 'intake')).toBe(null)
  expect(puts(ctx)).toEqual([{ argv: PUT, labels: ['factory', 'factory:intake'] }])
})

test('setState rejects an illegal transition', async () => {
  const ctx = spyCtx([...writes, ...getReplies(['factory', 'factory:spec'])])
  await expect(githubTracker(ctx, 'a/b').setState(5, 'done')).rejects.toMatchObject({ code: 'illegal-transition' })
  expect(has(ctx.calls, 'gh', 'api', '-X', 'PUT')).toBe(false)
})

test('setState to done from review needs prMerged', async () => {
  const refused = spyCtx([...writes, ...getReplies(['factory', 'factory:review'])])
  await expect(githubTracker(refused, 'a/b').setState(5, 'done')).rejects.toMatchObject({ code: 'illegal-transition' })
  expect(has(refused.calls, 'gh', 'api', '-X', 'PUT')).toBe(false)
  const ctx = spyCtx([...writes, ...getReplies(['factory', 'factory:review'])])
  await githubTracker(ctx, 'a/b').setState(5, 'done', { prMerged: true })
  expect(puts(ctx)).toEqual([{ argv: PUT, labels: ['factory', 'factory:done'] }])
})

test('setState rejects an issue with two status labels', async () => {
  const ctx = spyCtx([...writes, ...getReplies(['factory', 'factory:spec', 'factory:build'])])
  await expect(githubTracker(ctx, 'a/b').setState(5, 'review')).rejects.toMatchObject({ code: 'label-conflict' })
  expect(has(ctx.calls, 'gh', 'api', '-X', 'PUT')).toBe(false)
  const posts = ctx.stdins.filter(s => s.argv[0] === 'gh' && s.argv.includes('POST'))
  expect(posts.length).toBe(1)
  expect(posts[0]!.argv).toEqual(['gh', 'api', '-X', 'POST', 'repos/a/b/issues/5/comments', '--input', '-'])
  expect(posts[0]!.stdin).toContain('factory:spec')
  expect(posts[0]!.stdin).toContain('factory:build')
})

test('the label conflict comment gives one step in each sentence', async () => {
  const ctx = spyCtx([...writes, ...getReplies(['factory', 'factory:spec', 'factory:build'])])
  await githubTracker(ctx, 'a/b').setState(5, 'review').catch(() => undefined)
  const posts = ctx.stdins.filter(s => s.argv[0] === 'gh' && s.argv.includes('POST'))
  expect(posts.map(p => JSON.parse(p.stdin!).body)).toEqual(['Factory stopped: this issue has more than one status label (factory:spec, factory:build). Remove all status labels but one. Then ask the factory to continue.'])
})

test('setState needs-human to needs-human edits no label', async () => {
  const ctx = spyCtx([...writes, ...getReplies(['factory', 'factory:needs-human'])])
  expect(await githubTracker(ctx, 'a/b').setState(5, 'needs-human')).toBe('needs-human')
  expect(ctx.calls).toEqual([['gh', 'api', 'repos/a/b/issues/5']])
})

test('upsertComment edits the existing marker comment', async () => {
  const ctx = spyCtx([
    { argv: ['gh', 'api', 'user'], result: { stdout: 'op\n' } },
    ...getReplies(['factory'], [{ id: 55, user: { login: 'op' }, body: '<!-- factory:spec -->\nold', created_at: 'c', updated_at: 'u' }]),
    { argv: ['gh', 'api', '-X', 'PATCH'], result: { stdout: JSON.stringify({ id: 55, user: { login: 'op' }, body: 'x', created_at: 'c', updated_at: 'u2' }) } },
  ])
  const c = await githubTracker(ctx, 'a/b').upsertComment(5, 'spec', 'new')
  expect(ctx.calls).toContainEqual(['gh', 'api', '-X', 'PATCH', 'repos/a/b/issues/comments/55', '--input', '-'])
  expect(c.id).toBe(55)
})

test('upsertComment creates a comment when none exists', async () => {
  const ctx = spyCtx([
    { argv: ['gh', 'api', 'user'], result: { stdout: 'op\n' } },
    ...getReplies(['factory'], []),
    { argv: ['gh', 'api', '-X', 'POST'], result: { stdout: JSON.stringify({ id: 9, user: { login: 'op' }, body: 'x', created_at: 'c', updated_at: 'u' }) } },
  ])
  await githubTracker(ctx, 'a/b').upsertComment(5, 'spec', 'new')
  const post = ctx.stdins.find(s => s.argv.includes('POST'))!
  expect(post.argv).toEqual(['gh', 'api', '-X', 'POST', 'repos/a/b/issues/5/comments', '--input', '-'])
  expect(JSON.parse(post.stdin!).body.startsWith('<!-- factory:spec -->')).toBe(true)
})

test('upsertComment reuses the comments of the last read and of its own writes', async () => {
  const mine = (id: number, name: string) => ({ id, user: { login: 'op' }, body: `<!-- factory:${name} -->\nx`, created_at: 'c', updated_at: 'u' })
  const ctx = spyCtx([
    { argv: ['gh', 'api', 'user'], result: { stdout: 'op\n' } },
    ...getReplies(['factory'], [mine(55, 'spec')]),
    { argv: ['gh', 'api', '-X', 'PATCH'], result: { stdout: JSON.stringify(mine(55, 'spec')) } },
    { argv: ['gh', 'api', '-X', 'POST'], result: { stdout: JSON.stringify(mine(56, 'decision')) } },
  ])
  const t = githubTracker(ctx, 'a/b')
  await t.get(5)
  await t.upsertComment(5, 'spec', 'a')
  await t.upsertComment(5, 'decision', 'b')
  await t.upsertComment(5, 'decision', 'c')
  expect(ctx.calls.filter(c => c[2] === 'repos/a/b/issues/5/comments')).toHaveLength(1)
  expect(ctx.calls.filter(c => c[2] === '-X').map(c => `${c[3]} ${c[4]}`)).toEqual([
    'PATCH repos/a/b/issues/comments/55', 'POST repos/a/b/issues/5/comments', 'PATCH repos/a/b/issues/comments/56',
  ])
})

test('close maps the reason', async () => {
  const ctx = spyCtx(writes)
  const t = githubTracker(ctx, 'a/b')
  await t.close(5, 'done')
  await t.close(6, 'rejected')
  expect(ctx.stdins.map(s => [s.argv.join(' '), JSON.parse(s.stdin!)])).toEqual([
    ['gh api -X PATCH repos/a/b/issues/5 --input -', { state: 'closed', state_reason: 'completed' }],
    ['gh api -X PATCH repos/a/b/issues/6 --input -', { state: 'closed', state_reason: 'not_planned' }],
  ])
})

test('comment and prComment post one REST comment', async () => {
  const ctx = spyCtx(writes)
  const t = githubTracker(ctx, 'a/b')
  await t.comment(5, 'hi')
  await t.prComment(9, 'yo')
  expect(ctx.stdins.map(s => [s.argv.join(' '), s.stdin])).toEqual([
    ['gh api -X POST repos/a/b/issues/5/comments --input -', '{"body":"hi"}'],
    ['gh api -X POST repos/a/b/issues/9/comments --input -', '{"body":"yo"}'],
  ])
})

test('approvePr posts one REST review', async () => {
  const ctx = spyCtx(writes)
  await githubTracker(ctx, 'a/b').approvePr(9, 'ok')
  expect(ctx.stdins.map(s => [s.argv.join(' '), s.stdin])).toEqual([
    ['gh api -X POST repos/a/b/pulls/9/reviews --input -', '{"event":"APPROVE","body":"ok"}'],
  ])
})

test('createIssue sends the body on stdin', async () => {
  const ctx = spyCtx([{ argv: ['gh', 'api', '-X', 'POST', 'repos/a/b/issues'], result: { stdout: '12\n' } }])
  const n = await githubTracker(ctx, 'a/b').createIssue('Title', 'Body', ['factory', 'type:feat'])
  expect(n).toBe(12)
  const s = ctx.stdins[0]!
  expect(s.argv).toEqual(['gh', 'api', '-X', 'POST', 'repos/a/b/issues', '--input', '-', '--jq', '.number'])
  expect(JSON.parse(s.stdin!)).toEqual({ title: 'Title', body: 'Body', labels: ['factory', 'type:feat'] })
})

const restPr = (o: Record<string, unknown> = {}) => ({
  number: 9, state: 'open', draft: true, title: 't', body: 'b', user: { login: 'op' }, node_id: 'PR_9',
  head: { ref: 'factory/5', sha: 'abc' }, merged_at: null, merge_commit_sha: 'test-merge', ...o,
})
const prOut = { number: 9, state: 'OPEN', isDraft: true, title: 't', body: 'b', author: 'op', headRefName: 'factory/5', headRefOid: 'abc', mergeCommit: null }
const FIND_ARGV = ['gh', 'api', 'repos/a/b/pulls?head=a:factory/5&state=all&per_page=100', '--paginate', '--jq', '.[]']

test('openPr opens a normal PR through REST, then adds the labels', async () => {
  const ctx = spyCtx([
    { argv: ['gh', 'api', '-X', 'POST', 'repos/a/b/pulls'], result: { stdout: JSON.stringify(restPr({ html_url: 'https://github.com/a/b/pull/9' })) } },
    ...writes,
  ])
  const pr = await githubTracker(ctx, 'a/b').openPr('factory/5', 'main', 'feat: x', 'Body', ['factory:pr', 'type:feat'])
  expect(pr).toEqual({ number: 9, url: 'https://github.com/a/b/pull/9' })
  expect(ctx.stdins.map(s => [s.argv.join(' '), s.stdin === undefined ? undefined : JSON.parse(s.stdin)])).toEqual([
    ['gh api -X POST repos/a/b/pulls --input -', { title: 'feat: x', head: 'factory/5', base: 'main', body: 'Body', draft: false }],
    ['gh api -X POST repos/a/b/issues/9/labels --input -', { labels: ['factory:pr', 'type:feat'] }],
  ])
  expect(graphql(ctx.calls)).toEqual([])
})

test('findPr reads the PRs of the branch through REST and returns the first match or null', async () => {
  const hit = spyCtx([{ argv: FIND_ARGV.slice(0, 3), result: { stdout: JSON.stringify(restPr()) } }])
  expect(await githubTracker(hit, 'a/b').findPr('factory/5')).toEqual(prOut)
  expect(hit.calls).toEqual([FIND_ARGV])
  const none = spyCtx([{ argv: ['gh', 'api'], result: { stdout: '' } }])
  expect(await githubTracker(none, 'a/b').findPr('x')).toBe(null)
})

test('merge puts a merge commit with the subject and pins the sha', async () => {
  const ctx = spyCtx(writes)
  await githubTracker(ctx, 'a/b').merge(9, 'feat: x (#9)', 'f'.repeat(40))
  expect(ctx.calls).toEqual([['gh', 'api', '-X', 'PUT', 'repos/a/b/pulls/9/merge', '--input', '-']])
  expect(JSON.parse(ctx.stdins[0]!.stdin!)).toEqual({ merge_method: 'merge', commit_title: 'feat: x (#9)', sha: 'f'.repeat(40) })
})

test('findPr prefers an open PR over a newer closed one', async () => {
  const rows = [
    restPr({ number: 11, state: 'closed' }), restPr({ number: 9 }), restPr({ number: 8, state: 'closed', merged_at: '2026-01-01T00:00:00Z' }),
  ]
  const lines = (r: unknown[]) => r.map(x => JSON.stringify(x)).join('\n')
  const ctx = spyCtx([{ argv: ['gh', 'api'], result: { stdout: lines(rows) } }])
  expect((await githubTracker(ctx, 'a/b').findPr('factory/5'))?.number).toBe(9)
  const none = spyCtx([{ argv: ['gh', 'api'], result: { stdout: lines([rows[0], rows[2]]) } }])
  expect((await githubTracker(none, 'a/b').findPr('factory/5'))?.number).toBe(11)
})

test('prReady leaves a PR that is not a draft and makes one mutation for a draft', async () => {
  const ready = spyCtx([{ argv: ['gh', 'api', 'repos/a/b/pulls/9'], result: { stdout: JSON.stringify(restPr({ draft: false })) } }])
  await githubTracker(ready, 'a/b').prReady(9)
  expect(ready.calls).toEqual([['gh', 'api', 'repos/a/b/pulls/9']])
  const draft = spyCtx([{ argv: ['gh', 'api', 'repos/a/b/pulls/9'], result: { stdout: JSON.stringify(restPr()) } }, { argv: ['gh', 'api', 'graphql'] }])
  await githubTracker(draft, 'a/b').prReady(9)
  expect(draft.calls[1]).toEqual([
    'gh', 'api', 'graphql', '-f', 'query=mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { clientMutationId } }', '-f', 'id=PR_9',
  ])
  expect(draft.calls).toHaveLength(2)
})

test('prApproved needs an approval of the given commit', async () => {
  const reviews = [
    { state: 'APPROVED', commit_id: 'old' }, { state: 'COMMENTED', commit_id: 'abc' }, { state: 'DISMISSED', commit_id: 'abc' },
  ]
  const ctx = (r: unknown[]) => spyCtx([{ argv: ['gh', 'api', 'repos/a/b/pulls/9/reviews?per_page=100'], result: { stdout: r.map(x => JSON.stringify(x)).join('\n') } }])
  const no = ctx(reviews)
  expect(await githubTracker(no, 'a/b').prApproved(9, 'abc')).toBe(false)
  expect(no.calls).toEqual([['gh', 'api', 'repos/a/b/pulls/9/reviews?per_page=100', '--paginate', '--jq', '.[]']])
  expect(await githubTracker(ctx([...reviews, { state: 'APPROVED', commit_id: 'abc' }]), 'a/b').prApproved(9, 'abc')).toBe(true)
})

test('the PR calls use no GraphQL for a PR that is not a draft', async () => {
  const ctx = spyCtx([{ argv: ['gh', 'api'], result: { stdout: JSON.stringify(restPr({ draft: false, html_url: 'u/pull/9' })) } }])
  const t = githubTracker(ctx, 'a/b')
  await t.openPr('factory/5', 'main', 't', 'b', ['factory:pr'])
  await t.findPr('factory/5')
  await t.prState(9)
  await t.prReady(9)
  await t.prComment(9, 'x')
  await t.approvePr(9, 'x')
  await t.merge(9, 's', 'abc')
  expect(graphql(ctx.calls)).toEqual([])
})

test('ensureLabels reads once and writes only a missing or changed label', async () => {
  const have = [{ name: 'factory', color: '5319E7', description: 'd' }, { name: 'factory:spec', color: '000000', description: 'd' }]
  const ctx = spyCtx([...writes, { argv: ['gh', 'api', 'repos/a/b/labels?per_page=100'], result: { stdout: have.map(h => JSON.stringify(h)).join('\n') } }])
  await githubTracker(ctx, 'a/b').ensureLabels([
    { name: 'factory', color: '5319e7', description: 'd' }, { name: 'factory:spec', color: '111111', description: 'd' }, { name: 'factory:build', color: '222222', description: 'b' },
  ])
  expect(ctx.stdins.map(s => [s.argv.join(' '), s.stdin])).toEqual([
    ['gh api repos/a/b/labels?per_page=100 --paginate --jq .[]', undefined],
    ['gh api -X PATCH repos/a/b/labels/factory%3Aspec --input -', '{"color":"111111","description":"d"}'],
    ['gh api -X POST repos/a/b/labels --input -', '{"name":"factory:build","color":"222222","description":"b"}'],
  ])
})

const repoJson = (over: Record<string, unknown> = {}) => JSON.stringify({
  allow_merge_commit: true, allow_squash_merge: false, allow_rebase_merge: false,
  merge_commit_title: 'PR_TITLE', merge_commit_message: 'PR_BODY', delete_branch_on_merge: true, has_issues: true, ...over,
})

test('applyStandard reports and fixes drift', async () => {
  const ctx = spyCtx([
    ...writes,
    { argv: ['gh', 'api', 'repos/a/b'], result: { stdout: repoJson({ allow_squash_merge: true }) } },
  ])
  const checks = await githubTracker(ctx, 'a/b').applyStandard(false)
  expect(checks.find(c => c.key === 'allow_squash_merge')).toMatchObject({ ok: false, actual: 'true', expected: 'false' })
  expect(checks.filter(c => !c.ok).length).toBe(1)
  await githubTracker(ctx, 'a/b').applyStandard(true)
  const patch = ctx.stdins.find(s => s.argv.includes('PATCH'))!
  expect(patch.argv).toEqual(['gh', 'api', '-X', 'PATCH', 'repos/a/b', '--input', '-'])
  expect(JSON.parse(patch.stdin!)).toEqual({ allow_squash_merge: false })
})

test('applyStandard without apply only reads', async () => {
  const ctx = spyCtx([{ argv: ['gh', 'api', 'repos/a/b'], result: { stdout: repoJson({ has_issues: false }) } }])
  await githubTracker(ctx, 'a/b').applyStandard(false)
  expect(has(ctx.calls, 'gh', 'api', '-X', 'PATCH')).toBe(false)
})

test('get keeps brackets inside comment bodies', async () => {
  const body = 'see ] [ and [1] {x} ][\nnext'
  const ctx = spyCtx(getReplies(['factory'], [
    { id: 1, user: { login: 'bob' }, body, created_at: 'c', updated_at: 'u' },
    { id: 2, user: { login: 'eve' }, body: 'ok', created_at: 'c', updated_at: 'u' },
  ]))
  const t = await githubTracker(ctx, 'a/b').get(5)
  expect(t.comments.map(c => c.id)).toEqual([1, 2])
  expect(t.comments[0]!.body).toBe(body)
})

test('get with no comments returns an empty list', async () => {
  const t = await githubTracker(spyCtx(getReplies(['factory'])), 'a/b').get(5)
  expect(t.comments).toEqual([])
})

test('searchIssues searches the issues of the repo through REST', async () => {
  const ctx = spyCtx([{ argv: ['gh', 'api'], result: { stdout: JSON.stringify({ number: 3, title: 'X', labels: [{ name: 'factory' }, { name: 'type:fix' }] }) } }])
  expect(await githubTracker(ctx, 'a/b').searchIssues('dup in:title')).toEqual([{ number: 3, title: 'X', labels: ['factory', 'type:fix'] }])
  expect(ctx.calls[0]).toEqual(['gh', 'api', '-X', 'GET', 'search/issues', '-f', 'q=repo:a/b is:issue dup in:title', '-f', 'per_page=50', '--jq', '.items[]'])
  expect(graphql(ctx.calls)).toEqual([])
})

test('prState maps the REST fields', async () => {
  const ctx = spyCtx([{ argv: ['gh', 'api', 'repos/a/b/pulls/9'], result: { stdout: JSON.stringify(restPr({ body: null, draft: false })) } }])
  expect(await githubTracker(ctx, 'a/b').prState(9)).toEqual({ ...prOut, body: '', isDraft: false })
  expect(ctx.calls).toEqual([['gh', 'api', 'repos/a/b/pulls/9']])
})

test('prState is MERGED with the merge commit only after the merge', async () => {
  const merged = restPr({ state: 'closed', merged_at: '2026-01-01T00:00:00Z', merge_commit_sha: 'm' })
  const hit = spyCtx([{ argv: ['gh', 'api'], result: { stdout: JSON.stringify(merged) } }])
  expect(await githubTracker(hit, 'a/b').prState(9)).toMatchObject({ state: 'MERGED', mergeCommit: 'm' })
  const closed = spyCtx([{ argv: ['gh', 'api'], result: { stdout: JSON.stringify(restPr({ state: 'closed' })) } }])
  expect(await githubTracker(closed, 'a/b').prState(9)).toMatchObject({ state: 'CLOSED', mergeCommit: null })
  const open = spyCtx([{ argv: ['gh', 'api'], result: { stdout: JSON.stringify(restPr()) } }])
  expect(await githubTracker(open, 'a/b').prState(9)).toMatchObject({ state: 'OPEN', mergeCommit: null })
  const list = spyCtx([{ argv: ['gh', 'api'], result: { stdout: JSON.stringify(merged) } }])
  expect((await githubTracker(list, 'a/b').findPr('factory/5'))?.mergeCommit).toBe('m')
})

test('applyStandard sends both merge commit fields when one drifts', async () => {
  const ctx = spyCtx([
    ...writes,
    { argv: ['gh', 'api', 'repos/a/b'], result: { stdout: repoJson({ merge_commit_message: 'BLANK' }) } },
  ])
  await githubTracker(ctx, 'a/b').applyStandard(true)
  const patch = ctx.stdins.find(s => s.argv.includes('PATCH'))!
  expect(JSON.parse(patch.stdin!)).toEqual({ merge_commit_title: 'PR_TITLE', merge_commit_message: 'PR_BODY' })
})

test('applyStandard shows a missing field as (missing)', async () => {
  const raw = JSON.parse(repoJson())
  delete raw.has_issues
  const ctx = spyCtx([{ argv: ['gh', 'api', 'repos/a/b'], result: { stdout: JSON.stringify(raw) } }])
  const checks = await githubTracker(ctx, 'a/b').applyStandard(false)
  expect(checks.find(c => c.key === 'has_issues')).toMatchObject({ ok: false, actual: '(missing)' })
})

test('assign adds and removes only the factory login', async () => {
  const ctx = spyCtx([
    { argv: ['gh', 'api', 'user'], result: { stdout: 'op\n' } },
    { argv: ['gh', 'api', '-X', 'POST'] }, { argv: ['gh', 'api', '-X', 'DELETE'] },
  ])
  const t = githubTracker(ctx, 'a/b')
  await t.assign(5, true)
  await t.assign(12, false)
  expect(ctx.stdins.filter(s => s.argv.includes('-X'))).toEqual([
    { argv: ['gh', 'api', '-X', 'POST', 'repos/a/b/issues/5/assignees', '--input', '-'], stdin: '{"assignees":["op"]}' },
    { argv: ['gh', 'api', '-X', 'DELETE', 'repos/a/b/issues/12/assignees', '--input', '-'], stdin: '{"assignees":["op"]}' },
  ])
})

test('assign writes nothing when the last read shows the same assignment', async () => {
  const ctx = spyCtx([
    { argv: ['gh', 'api', 'user'], result: { stdout: 'op\n' } },
    { argv: ['gh', 'api', 'repos/a/b/issues/5'], result: { stdout: issueJson(['factory', 'factory:spec'], 5, { assignees: [{ login: 'op' }] }) } },
    ...writes,
  ])
  const t = githubTracker(ctx, 'a/b')
  await t.setState(5, 'build')
  await t.assign(5, true)
  expect(ctx.calls.filter(c => c.includes('repos/a/b/issues/5/assignees'))).toEqual([])
  await t.assign(5, false)
  await t.assign(5, false)
  expect(ctx.calls.filter(c => c.includes('repos/a/b/issues/5/assignees')).map(c => c[3])).toEqual(['DELETE'])
})

test('addLabel adds one label', async () => {
  const ctx = spyCtx(writes)
  await githubTracker(ctx, 'a/b').addLabel(5, 'factory')
  expect(ctx.stdins.map(s => [s.argv.join(' '), s.stdin])).toEqual([['gh api -X POST repos/a/b/issues/5/labels --input -', '{"labels":["factory"]}']])
})
