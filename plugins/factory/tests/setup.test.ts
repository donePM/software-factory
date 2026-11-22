import { expect, test } from 'claude-code/testing'
import { defaultConfig, validateConfig } from '../lib/config.ts'
import { labelSet } from '../lib/labels.ts'
import { setup } from '../lib/setup.ts'
import { invoke, TOOLS } from '../hooks/tools.ts'
import { fakeCtx, type Reply } from './support/host.ts'

const repoJson = JSON.stringify({
  allow_merge_commit: true, allow_squash_merge: false, allow_rebase_merge: false,
  merge_commit_title: 'PR_TITLE', merge_commit_message: 'PR_BODY', delete_branch_on_merge: true, has_issues: true,
})
const replies = (head = 'refs/remotes/origin/main'): Reply[] => [
  { argv: ['git', '--version'], result: { stdout: 'git version 2' } },
  { argv: ['gh', '--version'], result: { stdout: 'gh version 2' } },
  { argv: ['gh', 'auth', 'status'], result: { stdout: "Logged in to github.com account octo\n- Token scopes: 'repo'" } },
  { argv: ['git', 'remote', 'get-url', 'origin'], result: { stdout: 'https://github.com/a/b.git' } },
  { argv: ['git', '-C', '/repo', 'ls-files'], result: { stdout: 'README.md' } },
  { argv: ['git', 'symbolic-ref', 'refs/remotes/origin/HEAD'], result: { stdout: head } },
  { argv: ['gh', 'api', 'repos/a/b'], result: { stdout: repoJson } },
  { argv: ['gh', 'label', 'create'] },
  { argv: ['gh', 'issue', 'list'], result: { stdout: '[]' } },
  { argv: ['gh', 'api', 'repos/a/b/issues?labels=factory&state=open&per_page=100'] },
  { argv: ['gh', 'api', '-X', 'PATCH'] },
]
const labelCreates = (calls: string[][]) => calls.filter(c => c[1] === 'label' && c[2] === 'create').length
const CFG = '/repo/.factory/config.json'

test('setup without apply writes nothing', async () => {
  const ctx = fakeCtx({ replies: replies() })
  const r = await setup(ctx, { apply: false })
  expect(r.created).toBe(false)
  expect(r.config!.baseBranch).toBe('main')
  expect(r.config!.tracker.url).toBe('https://github.com/a/b')
  expect(Object.keys(ctx.files)).toEqual([])
  expect(labelCreates(ctx.calls)).toBe(0)
  expect(ctx.calls.some(c => c.includes('PATCH'))).toBe(false)
})

test('setup creates config, gitignore and labels', async () => {
  const ctx = fakeCtx({ replies: replies() })
  const r = await setup(ctx, { apply: true, concurrency: 2 })
  expect(r.created).toBe(true)
  expect(validateConfig(JSON.parse(ctx.files[CFG]!))).toEqual([])
  expect(JSON.parse(ctx.files[CFG]!).concurrency).toBe(2)
  expect(ctx.files['/repo/.factory/.gitignore']).toBe('*\n!.gitignore\n!config.json\n!checks.local.ts\n')
  expect(labelCreates(ctx.calls)).toBe(labelSet().length)
  expect(r.labels).toBe(labelSet().length)
  expect(r.gitignore).toBe(true)
  expect(r.next.length).toBeGreaterThan(0)
})

test('setup reads the base branch from origin HEAD', async () => {
  const r = await setup(fakeCtx({ replies: replies('refs/remotes/origin/trunk') }), { apply: false })
  expect(r.config!.baseBranch).toBe('trunk')
})

test('setup honors an explicit base branch', async () => {
  const r = await setup(fakeCtx({ replies: replies() }), { apply: false, baseBranch: 'dev' })
  expect(r.config!.baseBranch).toBe('dev')
})

test('setup is idempotent', async () => {
  const ctx = fakeCtx({ replies: replies() })
  await setup(ctx, { apply: true })
  const before = { ...ctx.files }
  const r = await setup(ctx, { apply: true })
  expect(r.created).toBe(false)
  expect(r.migrated).toEqual([])
  expect(ctx.files).toEqual(before)
})

test('setup migrates an old config first', async () => {
  const old = { ...defaultConfig('https://github.com/a/b', 'main', []), version: 0 }
  const ctx = fakeCtx({ replies: replies(), files: { [CFG]: JSON.stringify(old) } })
  const r = await setup(ctx, { apply: true, migrations: [{ from: 0, name: 'zero-to-one', up: o => o }] })
  expect(r.migrated).toEqual(['zero-to-one'])
  expect(r.created).toBe(false)
  expect(JSON.parse(ctx.files[CFG]!).version).toBe(1)
})

test('setup stops early when git is missing', async () => {
  const rs = replies().filter(r => r.argv[0] !== 'git')
  const ctx = fakeCtx({ replies: rs })
  const r = await setup(ctx, { apply: true })
  expect(r.checks.find(c => c.check === 'git')!.ok).toBe(false)
  expect(ctx.calls.filter(c => c[0] === 'gh').length).toBe(0)
  expect(Object.keys(ctx.files)).toEqual([])
})

test('tool setup returns the report as JSON', async () => {
  const def = TOOLS.find(t => t.name === 'setup')!
  const out = await invoke(def, fakeCtx({ replies: replies() }), { apply: false })
  expect('result' in out && out.result !== undefined && JSON.parse(out.result).config.baseBranch).toBe('main')
})

test('preview shows standard drift and the planned label count', async () => {
  const drift = JSON.stringify({ ...JSON.parse(repoJson), allow_squash_merge: true })
  const rs = replies().map(r => (r.argv[0] === 'gh' && r.argv[1] === 'api' && r.argv[2] === 'repos/a/b' ? { argv: r.argv, result: { stdout: drift } } : r))
  const ctx = fakeCtx({ replies: rs })
  const r = await setup(ctx, { apply: false })
  expect(r.standard.filter(c => !c.ok).map(c => c.key)).toEqual(['allow_squash_merge'])
  expect(r.labels).toBe(labelSet().length)
  expect(ctx.calls.some(c => c.includes('PATCH') || c[2] === 'create')).toBe(false)
})

test('preview migrates in memory only and lists the planned migrations', async () => {
  const old = { ...defaultConfig('https://github.com/a/b', 'main', []), version: 0 }
  const ctx = fakeCtx({ replies: replies(), files: { [CFG]: JSON.stringify(old) } })
  const before = { ...ctx.files }
  const r = await setup(ctx, { apply: false, migrations: [{ from: 0, name: 'zero-to-one', up: o => o }] })
  expect(r.migrated).toEqual(['zero-to-one'])
  expect(r.config!.version).toBe(1)
  expect(ctx.files).toEqual(before)
})

test('apply sweeps finished jobs and reports it', async () => {
  const ctx = fakeCtx({ replies: replies(), files: { '/repo/.factory/jobs/setup/checks.md': 'x' } })
  const r = await setup(ctx, { apply: true })
  expect(r.sweep).toEqual({ removed: [], kept: [], finished: [] })
  expect(ctx.calls).toContainEqual(['git', 'worktree', 'prune'])
})

test('preview does not sweep', async () => {
  const ctx = fakeCtx({ replies: replies() })
  const r = await setup(ctx, { apply: false })
  expect(r.sweep).toEqual({ removed: [], kept: [], finished: [] })
  expect(ctx.calls.some(c => c.includes('prune'))).toBe(false)
})

const noAuth = () => replies().map(r => (r.argv[1] === 'auth' ? { argv: r.argv, result: { exitCode: 1, stderr: 'You are not logged in' } } : r))

test('failed gh auth with an existing config writes nothing and shows no config', async () => {
  const ctx = fakeCtx({ replies: noAuth(), files: { [CFG]: JSON.stringify({ ...defaultConfig('https://github.com/a/b', 'main', []), concurrency: 1 }) } })
  const before = { ...ctx.files }
  const r = await setup(ctx, { apply: true })
  expect('config' in r).toBe(false)
  expect(ctx.files).toEqual(before)
  expect(labelCreates(ctx.calls)).toBe(0)
  expect(ctx.calls.some(c => c.includes('PATCH'))).toBe(false)
})

test('failed check reports applied false with a reason', async () => {
  const r = await setup(fakeCtx({ replies: noAuth() }), { apply: true })
  expect(r.applied).toBe(false)
  expect(r.reason).toContain('gh auth')
})

test('applied is true only after an apply', async () => {
  const preview = await setup(fakeCtx({ replies: replies() }), { apply: false })
  expect(preview.applied).toBe(false)
  expect(preview.config).toBeDefined()
  const applied = await setup(fakeCtx({ replies: replies() }), { apply: true })
  expect(applied.applied).toBe(true)
})

const stored = () => ({ ...defaultConfig('https://github.com/a/b', 'main', []), concurrency: 1, maxRounds: 5 })

test('apply writes concurrency into an existing config', async () => {
  const ctx = fakeCtx({ replies: replies(), files: { [CFG]: JSON.stringify(stored()) } })
  const r = await setup(ctx, { apply: true, concurrency: 2 })
  expect(JSON.parse(ctx.files[CFG]!)).toEqual({ ...stored(), concurrency: 2 })
  expect(r.config?.concurrency).toBe(2)
})

test('apply writes baseBranch into an existing config', async () => {
  const ctx = fakeCtx({ replies: replies(), files: { [CFG]: JSON.stringify(stored()) } })
  await setup(ctx, { apply: true, baseBranch: 'dev' })
  expect(JSON.parse(ctx.files[CFG]!)).toEqual({ ...stored(), baseBranch: 'dev' })
})

test('apply without arguments keeps an existing config', async () => {
  const text = JSON.stringify(stored())
  const ctx = fakeCtx({ replies: replies(), files: { [CFG]: text } })
  await setup(ctx, { apply: true })
  expect(ctx.files[CFG]).toBe(text)
})

test('a new config takes concurrency and baseBranch', async () => {
  const ctx = fakeCtx({ replies: replies() })
  await setup(ctx, { apply: true, concurrency: 2, baseBranch: 'dev' })
  expect(JSON.parse(ctx.files[CFG]!)).toMatchObject({ concurrency: 2, baseBranch: 'dev' })
})

test('preview shows the arguments for an existing config', async () => {
  const ctx = fakeCtx({ replies: replies(), files: { [CFG]: JSON.stringify(stored()) } })
  const before = { ...ctx.files }
  const r = await setup(ctx, { apply: false, concurrency: 2, baseBranch: 'dev' })
  expect(r.config?.concurrency).toBe(2)
  expect(r.config?.baseBranch).toBe('dev')
  expect(ctx.files).toEqual(before)
})

const projectScope: Reply = { argv: ['gh', 'auth', 'status'], result: { stdout: "Logged in to github.com account octo\n- Token scopes: 'project', 'repo'" } }
const OPTIONS = ['Backlog', 'Intake', 'Spec', 'Design', 'Build', 'Review', 'Waiting', 'Ready to merge', 'Docs', 'Done', 'Rejected']
const fieldList = JSON.stringify({
  fields: [{ id: 'F1', name: 'Factory', type: 'ProjectV2SingleSelectField', options: OPTIONS.map((name, i) => ({ id: `O${i}`, name })) }],
})
const projectCalls = (calls: string[][]) => calls.filter(c => c[0] === 'gh' && c[1] === 'project')

test('setup makes no project call when the project is off', async () => {
  const { project: _, ...noBlock } = stored()
  for (const cfg of [noBlock, stored()]) {
    const ctx = fakeCtx({ replies: [projectScope, ...replies()], files: { [CFG]: JSON.stringify(cfg) } })
    const r = await setup(ctx, { apply: true })
    expect(projectCalls(ctx.calls)).toEqual([])
    expect(r.project).toBeUndefined()
  }
})

test('setup creates the project and the Factory field', async () => {
  let listed = 0
  const ctx = fakeCtx({
    replies: [
      projectScope,
      { argv: ['gh', 'project', 'create'], result: { stdout: JSON.stringify({ number: 7, id: 'P7', url: 'https://github.com/users/a/projects/7' }) } },
      { argv: ['gh', 'project', 'field-create'], result: { stdout: '{}' } },
      ...replies(),
    ],
  })
  const run = ctx.run
  ctx.run = async (argv, opts) => {
    if (argv[1] === 'project' && argv[2] === 'field-list') {
      ctx.calls.push([...argv])
      return { exitCode: 0, stderr: '', stdout: listed++ === 0 ? JSON.stringify({ fields: [] }) : fieldList }
    }
    return run(argv, opts)
  }
  const r = await setup(ctx, { apply: true, project: true })
  const create = ctx.calls.find(c => c[1] === 'project' && c[2] === 'create')!
  expect(create.slice(0, 5)).toEqual(['gh', 'project', 'create', '--owner', 'a'])
  expect(JSON.parse(ctx.files[CFG]!).project).toEqual({ enabled: true, number: 7 })
  const field = ctx.calls.find(c => c[1] === 'project' && c[2] === 'field-create')!
  expect(field).toContain('SINGLE_SELECT')
  expect(field[field.indexOf('--name') + 1]).toBe('Factory')
  expect(field[field.indexOf('--single-select-options') + 1]).toBe(OPTIONS.join(','))
  expect(r.project).toMatchObject({ number: 7, url: 'https://github.com/users/a/projects/7', added: 0, warnings: [] })
  expect(r.project!.viewSteps.some(s => s.includes('Column by') && s.includes('Factory'))).toBe(true)
})

test('setup adds the open tickets with their Factory option', async () => {
  const issue = (number: number, labels: string[]) => ({
    number, title: 't', body: '', labels: labels.map(name => ({ name })), author: { login: 'x' }, createdAt: '',
    url: `https://github.com/a/b/issues/${number}`, state: 'OPEN',
  })
  const issues = [issue(1, ['factory']), issue(2, ['factory', 'factory:review'])]
  const ctx = fakeCtx({
    replies: [
      projectScope,
      { argv: ['gh', 'project', 'view', '7'], result: { stdout: JSON.stringify({ number: 7, id: 'P7', url: 'https://github.com/users/a/projects/7' }) } },
      { argv: ['gh', 'project', 'field-list', '7'], result: { stdout: fieldList } },
      { argv: ['gh', 'project', 'item-add', '7', '--owner', 'a', '--url', 'https://github.com/a/b/issues/1'], result: { stdout: '{"id":"I1"}' } },
      { argv: ['gh', 'project', 'item-add', '7', '--owner', 'a', '--url', 'https://github.com/a/b/issues/2'], result: { stdout: '{"id":"I2"}' } },
      { argv: ['gh', 'project', 'item-edit'] },
      { argv: ['gh', 'issue', 'list'], result: { stdout: JSON.stringify(issues) } },
      ...replies(),
    ],
    files: { [CFG]: JSON.stringify({ ...stored(), project: { enabled: true, number: 7 } }) },
  })
  const r = await setup(ctx, { apply: true })
  const p = projectCalls(ctx.calls)
  expect(p.some(c => c[2] === 'create' || c[2] === 'field-create')).toBe(false)
  const edits = p.filter(c => c[2] === 'item-edit').map(c => [c[c.indexOf('--id') + 1], c[c.indexOf('--single-select-option-id') + 1]])
  expect(edits).toEqual([['I1', 'O0'], ['I2', 'O5']])
  const edit = p.find(c => c[2] === 'item-edit')!
  expect(edit[edit.indexOf('--project-id') + 1]).toBe('P7')
  expect(edit[edit.indexOf('--field-id') + 1]).toBe('F1')
  expect(r.project).toMatchObject({ number: 7, added: 2, warnings: [] })
})

test('setup reports a project failure as a warning', async () => {
  const noScope = fakeCtx({ replies: replies() })
  const a = await setup(noScope, { apply: true, project: true })
  expect(projectCalls(noScope.calls)).toEqual([])
  expect(a.project!.warnings.some(w => w.includes('gh auth refresh -s project'))).toBe(true)
  expect(a.gitignore).toBe(true)
  expect(labelCreates(noScope.calls)).toBe(labelSet().length)
  expect(noScope.calls).toContainEqual(['git', 'worktree', 'prune'])
  expect(JSON.parse(noScope.files[CFG]!).project).toEqual({ enabled: true })

  const broken = fakeCtx({
    replies: [projectScope, { argv: ['gh', 'project', 'create'], result: { exitCode: 1, stderr: 'boom: no access' } }, ...replies()],
  })
  const b = await setup(broken, { apply: true, project: true })
  expect(b.project!.warnings.some(w => w.includes('boom: no access'))).toBe(true)
  expect(b.gitignore).toBe(true)
  expect(broken.calls).toContainEqual(['git', 'worktree', 'prune'])
})

test('setup tool previews the project without project calls', async () => {
  const def = TOOLS.find(t => t.name === 'setup')!
  const ctx = fakeCtx({ replies: [projectScope, ...replies()] })
  const out = await invoke(def, ctx, { apply: false, project: true })
  expect('result' in out && out.result !== undefined && JSON.parse(out.result).config.project.enabled).toBe(true)
  expect(Object.keys(ctx.files)).toEqual([])
  expect(projectCalls(ctx.calls)).toEqual([])
})

test('preview asks about the board when the config has no project answer', async () => {
  const fresh = await setup(fakeCtx({ replies: replies() }), { apply: false })
  expect(fresh.askProject).toBe(true)
  const { project: _, ...noBlock } = stored()
  const old = await setup(fakeCtx({ replies: replies(), files: { [CFG]: JSON.stringify(noBlock) } }), { apply: false })
  expect(old.askProject).toBe(true)
})

test('a stored project answer does not ask again', async () => {
  for (const enabled of [true, false]) {
    const ctx = fakeCtx({ replies: replies(), files: { [CFG]: JSON.stringify({ ...stored(), project: { enabled } }) } })
    expect((await setup(ctx, { apply: false })).askProject).toBe(false)
  }
})

test('the answer no makes no project call and writes enabled false', async () => {
  const { project: _, ...noBlock } = stored()
  const ctx = fakeCtx({ replies: [projectScope, ...replies()], files: { [CFG]: JSON.stringify(noBlock) } })
  const r = await setup(ctx, { apply: true, project: false })
  expect(projectCalls(ctx.calls)).toEqual([])
  expect(r.project).toBeUndefined()
  expect(JSON.parse(ctx.files[CFG]!).project).toEqual({ enabled: false })

  const kept = fakeCtx({ replies: [projectScope, ...replies()], files: { [CFG]: JSON.stringify({ ...stored(), project: { enabled: true, number: 7 } }) } })
  await setup(kept, { apply: true, project: false })
  expect(projectCalls(kept.calls)).toEqual([])
  expect(JSON.parse(kept.files[CFG]!).project).toEqual({ enabled: false, number: 7 })
})
