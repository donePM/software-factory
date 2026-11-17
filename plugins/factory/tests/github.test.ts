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

const issueJson = (labels: string[], n = 5) => JSON.stringify({
  number: n, title: 'T', body: 'B', labels: labels.map(name => ({ name })),
  author: { login: 'alice' }, createdAt: '2026-01-01T00:00:00Z', url: `https://github.com/a/b/issues/${n}`, state: 'OPEN',
})
const writes: Reply[] = [
  { argv: ['gh', 'issue', 'edit'] }, { argv: ['gh', 'issue', 'comment'] }, { argv: ['gh', 'issue', 'close'] },
  { argv: ['gh', 'pr', 'merge'] }, { argv: ['gh', 'label', 'create'] }, { argv: ['gh', 'api', '-X', 'PATCH', 'repos/a/b'] },
]
const getReplies = (labels: string[], comments: unknown[] = [], n = 5): Reply[] => [
  { argv: ['gh', 'issue', 'view', String(n)], result: { stdout: issueJson(labels, n) } },
  { argv: ['gh', 'api', `repos/a/b/issues/${n}/comments`], result: { stdout: comments.map(c => JSON.stringify(c)).join('\n') } },
]

test('repoFromUrl handles https, .git and ssh', () => {
  expect(repoFromUrl('https://github.com/a/b')).toBe('a/b')
  expect(repoFromUrl('https://github.com/a/b.git')).toBe('a/b')
  expect(repoFromUrl('git@github.com:a/b.git')).toBe('a/b')
})

test('backlog maps gh json to tickets', async () => {
  const ctx = spyCtx([{ argv: ['gh', 'issue', 'list'], result: { stdout: `[${issueJson(['factory', 'factory:spec'])}]` } }])
  const [t] = await githubTracker(ctx, 'a/b').backlog()
  expect(t).toEqual({
    kind: 'issue', number: 5, title: 'T', body: 'B', author: 'alice', labels: ['factory', 'factory:spec'],
    state: 'open', createdAt: '2026-01-01T00:00:00Z', url: 'https://github.com/a/b/issues/5', comments: [],
  })
  expect(ctx.calls[0]).toEqual([
    'gh', 'issue', 'list', '-R', 'a/b', '--label', 'factory', '--state', 'open', '--limit', '200',
    '--json', 'number,title,body,labels,author,createdAt,url,state',
  ])
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
  expect(ctx.calls).toContainEqual(['gh', 'api', 'repos/a/b/issues/5/comments', '--paginate', '--jq', '.[]'])
})

test('setState swaps exactly one status label', async () => {
  const ctx = spyCtx([...writes, ...getReplies(['factory', 'factory:intake'])])
  await githubTracker(ctx, 'a/b').setState(5, 'spec')
  expect(ctx.calls).toContainEqual([
    'gh', 'issue', 'edit', '5', '-R', 'a/b', '--add-label', 'factory:spec', '--remove-label', 'factory:intake',
  ])
})

test('setState from the backlog only adds a label', async () => {
  const ctx = spyCtx([...writes, ...getReplies(['factory'])])
  await githubTracker(ctx, 'a/b').setState(5, 'intake')
  expect(ctx.calls).toContainEqual(['gh', 'issue', 'edit', '5', '-R', 'a/b', '--add-label', 'factory:intake'])
})

test('setState rejects an illegal transition', async () => {
  const ctx = spyCtx([...writes, ...getReplies(['factory', 'factory:spec'])])
  await expect(githubTracker(ctx, 'a/b').setState(5, 'done')).rejects.toMatchObject({ code: 'illegal-transition' })
  expect(has(ctx.calls, 'gh', 'issue', 'edit')).toBe(false)
})

test('setState rejects an issue with two status labels', async () => {
  const ctx = spyCtx([...writes, ...getReplies(['factory', 'factory:spec', 'factory:build'])])
  await expect(githubTracker(ctx, 'a/b').setState(5, 'review')).rejects.toMatchObject({ code: 'label-conflict' })
  expect(has(ctx.calls, 'gh', 'issue', 'edit')).toBe(false)
  const posts = ctx.stdins.filter(s => s.argv[0] === 'gh' && (s.argv.includes('POST') || s.argv[1] === 'issue' && s.argv[2] === 'comment'))
  expect(posts.length).toBe(1)
  expect(posts[0]!.stdin).toContain('factory:spec')
  expect(posts[0]!.stdin).toContain('factory:build')
})

test('setState needs-human to needs-human edits no label', async () => {
  const ctx = spyCtx([...writes, ...getReplies(['factory', 'factory:needs-human'])])
  await githubTracker(ctx, 'a/b').setState(5, 'needs-human')
  expect(has(ctx.calls, 'gh', 'issue', 'edit')).toBe(false)
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

test('close maps the reason', async () => {
  const ctx = spyCtx(writes)
  const t = githubTracker(ctx, 'a/b')
  await t.close(5, 'done')
  await t.close(6, 'rejected')
  expect(ctx.calls).toContainEqual(['gh', 'issue', 'close', '5', '-R', 'a/b', '--reason', 'completed'])
  expect(ctx.calls).toContainEqual(['gh', 'issue', 'close', '6', '-R', 'a/b', '--reason', 'not planned'])
})

test('createIssue sends the body on stdin', async () => {
  const ctx = spyCtx([{ argv: ['gh', 'issue', 'create'], result: { stdout: 'https://github.com/a/b/issues/12\n' } }])
  const n = await githubTracker(ctx, 'a/b').createIssue('Title', 'Body', ['factory', 'type:feat'])
  expect(n).toBe(12)
  const s = ctx.stdins[0]!
  expect(s.argv).toEqual([
    'gh', 'issue', 'create', '-R', 'a/b', '--title', 'Title', '--body-file', '-', '--label', 'factory', '--label', 'type:feat',
  ])
  expect(s.stdin).toBe('Body')
})

test('openPr opens a draft with labels', async () => {
  const ctx = spyCtx([
    { argv: ['gh', 'pr', 'create'], result: { stdout: 'https://github.com/a/b/pull/9\n' } },
  ])
  const pr = await githubTracker(ctx, 'a/b').openPr('factory/5', 'main', 'feat: x', 'Body', ['factory:pr', 'type:feat'])
  expect(pr).toEqual({ number: 9, url: 'https://github.com/a/b/pull/9' })
  expect(ctx.calls[0]).toEqual([
    'gh', 'pr', 'create', '-R', 'a/b', '--draft', '--base', 'main', '--head', 'factory/5', '--title', 'feat: x',
    '--body-file', '-', '--label', 'factory:pr', '--label', 'type:feat',
  ])
  expect(ctx.stdins[0]!.stdin).toBe('Body')
})

test('findPr returns the first match or null', async () => {
  const pr = { number: 9, state: 'OPEN', isDraft: true, title: 't', body: 'b', author: { login: 'op' }, headRefName: 'factory/5', headRefOid: 'abc', reviewDecision: '' }
  const hit = spyCtx([{ argv: ['gh', 'pr', 'list'], result: { stdout: JSON.stringify([pr]) } }])
  expect(await githubTracker(hit, 'a/b').findPr('factory/5')).toEqual({ ...pr, author: 'op' })
  const none = spyCtx([{ argv: ['gh', 'pr', 'list'], result: { stdout: '[]' } }])
  expect(await githubTracker(none, 'a/b').findPr('x')).toBe(null)
})

test('merge passes the subject', async () => {
  const ctx = spyCtx(writes)
  await githubTracker(ctx, 'a/b').merge(9, 'feat: x (#9)', 'f'.repeat(40))
  expect(ctx.calls[0]).toEqual(['gh', 'pr', 'merge', '9', '-R', 'a/b', '--merge', '--subject', 'feat: x (#9)', '--match-head-commit', 'f'.repeat(40)])
})

test('findPr prefers an open PR over a newer closed one', async () => {
  const mk = (number: number, state: string) => ({ number, state, isDraft: false, title: 't', body: 'b', author: { login: 'op' }, headRefName: 'factory/5', headRefOid: 'abc', reviewDecision: '' })
  const rows = [mk(11, 'CLOSED'), mk(9, 'OPEN'), mk(8, 'MERGED')]
  const ctx = spyCtx([{ argv: ['gh', 'pr', 'list'], result: { stdout: JSON.stringify(rows) } }])
  expect((await githubTracker(ctx, 'a/b').findPr('factory/5'))?.number).toBe(9)
  const none = spyCtx([{ argv: ['gh', 'pr', 'list'], result: { stdout: JSON.stringify([mk(11, 'CLOSED'), mk(8, 'MERGED')]) } }])
  expect((await githubTracker(none, 'a/b').findPr('factory/5'))?.number).toBe(11)
})

test('ensureLabels forces each label', async () => {
  const ctx = spyCtx(writes)
  await githubTracker(ctx, 'a/b').ensureLabels([{ name: 'factory', color: '5319e7', description: 'd' }])
  expect(ctx.calls[0]).toEqual(['gh', 'label', 'create', 'factory', '-R', 'a/b', '--color', '5319e7', '--description', 'd', '--force'])
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

test('searchIssues maps labels to names', async () => {
  const ctx = spyCtx([{ argv: ['gh', 'issue', 'list'], result: { stdout: JSON.stringify([{ number: 3, title: 'X', labels: [{ name: 'factory' }, { name: 'type:fix' }] }]) } }])
  expect(await githubTracker(ctx, 'a/b').searchIssues('dup in:title')).toEqual([{ number: 3, title: 'X', labels: ['factory', 'type:fix'] }])
  expect(ctx.calls[0]).toEqual(['gh', 'issue', 'list', '-R', 'a/b', '--state', 'all', '--search', 'dup in:title', '--limit', '50', '--json', 'number,title,labels'])
})

test('prState maps the author', async () => {
  const pr = { number: 9, state: 'MERGED', isDraft: false, title: 't', body: 'b', author: { login: 'op' }, headRefName: 'factory/5', headRefOid: 'abc', reviewDecision: 'APPROVED' }
  const ctx = spyCtx([{ argv: ['gh', 'pr', 'view'], result: { stdout: JSON.stringify(pr) } }])
  expect(await githubTracker(ctx, 'a/b').prState(9)).toEqual({ ...pr, author: 'op' })
  expect(ctx.calls[0]).toEqual(['gh', 'pr', 'view', '9', '-R', 'a/b', '--json', 'number,state,isDraft,title,body,author,headRefName,headRefOid,reviewDecision'])
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
