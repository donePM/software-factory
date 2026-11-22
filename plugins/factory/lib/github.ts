import { FactoryError, must } from './exec.ts'
import { statusLabel, stateOf } from './labels.ts'
import type { Label } from './labels.ts'
import { findMarked, withMarker } from './markers.ts'
import type { StandardCheck, Tracker } from './tracker.ts'
import { assertTransition } from './transitions.ts'
import type { Comment, Ctx, PrState, State, Ticket } from './types.ts'

export function repoFromUrl(url: string): string {
  const m = /github\.com[/:]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/.exec(url.trim())
  if (!m) throw new FactoryError('bad-remote', `not a GitHub URL: ${url}`)
  return m[1]!
}

// Issues and PRs go through REST: one `gh issue` or `gh pr` command makes several GraphQL requests, one REST call is one request.
type RawFields = { issue_field_values?: { value?: unknown; single_select_option?: { name?: string } | null }[] | null }
type RawIssue = RawFields & {
  number: number; title: string; body: string | null; labels: { name: string }[]; user: { login: string }
  created_at: string; html_url: string; state: string; pull_request?: unknown; assignees?: { login: string }[] | null; state_reason?: string | null
}
type RawComment = { id: number; user: { login: string }; body: string; created_at: string; updated_at: string }
type RawPr = {
  number: number; state: string; draft: boolean; title: string; body: string | null; user: { login: string }; node_id: string
  head: { ref: string; sha: string }; merged_at: string | null; merge_commit_sha: string | null; html_url: string
}
type RawReview = { state: string; commit_id: string }
type RawLabel = { name: string; color: string; description: string | null }

const PRIORITIES: readonly string[] = ['Urgent', 'High', 'Medium', 'Low']
// shortcut: no field id check, upgrade when another single select field uses the same option names.
const priorityOf = (f: RawFields): string | undefined =>
  (f.issue_field_values ?? [])
    .map(v => v.single_select_option?.name ?? (typeof v.value === 'string' ? v.value : undefined))
    .find((n): n is string => n !== undefined && PRIORITIES.includes(n))

// `--jq '.[]'` makes gh print one compact JSON object per line.
const parseLines = <T>(text: string): T[] =>
  text.split('\n').filter(l => l.trim() !== '').map(l => JSON.parse(l) as T)

const toTicket = (r: RawIssue, comments: Comment[]): Ticket => {
  const t: Ticket = {
    kind: r.pull_request === undefined || r.pull_request === null ? 'issue' : 'pr', number: r.number, title: r.title,
    body: r.body ?? '', author: r.user.login, labels: r.labels.map(l => l.name), state: r.state === 'closed' ? 'closed' : 'open',
    createdAt: r.created_at, url: r.html_url, comments,
  }
  const p = priorityOf(r)
  if (p !== undefined) t.priority = p
  if (typeof r.state_reason === 'string') t.stateReason = r.state_reason
  return t
}
const toComment = (c: RawComment): Comment => ({
  id: c.id, author: c.user.login, body: c.body, createdAt: c.created_at, updatedAt: c.updated_at,
})
// An open PR has a test merge commit in merge_commit_sha: only a merged PR has a merge commit.
const toPr = (r: RawPr): PrState => {
  const merged = r.merged_at !== null
  return {
    number: r.number, state: merged ? 'MERGED' : r.state === 'open' ? 'OPEN' : 'CLOSED', isDraft: r.draft, title: r.title,
    body: r.body ?? '', author: r.user.login, headRefName: r.head.ref, headRefOid: r.head.sha, mergeCommit: merged ? r.merge_commit_sha : null,
  }
}
const READY = 'query=mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { clientMutationId } }'

const STANDARD: Record<string, string | boolean> = {
  allow_merge_commit: true, allow_squash_merge: false, allow_rebase_merge: false,
  merge_commit_title: 'PR_TITLE', merge_commit_message: 'PR_BODY', delete_branch_on_merge: true, has_issues: true,
}

export function githubTracker(ctx: Ctx, repo: string): Tracker {
  let cachedLogin: string | undefined
  // From the last read or write of this tracker. Only the factory login writes its marker comments and its assignment.
  const comments = new Map<number, Comment[]>()
  const assignees = new Map<number, string[]>()
  const gh = (argv: string[], stdin?: string): Promise<string> =>
    must(ctx, ['gh', ...argv], stdin === undefined ? undefined : { stdin })
  const json = async <T>(argv: string[], stdin?: string): Promise<T> => JSON.parse(await gh(argv, stdin)) as T
  const api = (method: string, path: string, body: unknown): Promise<string> =>
    gh(['api', '-X', method, `repos/${repo}/${path}`, '--input', '-'], JSON.stringify(body))
  // The issue without its comments.
  const issue = async (n: number): Promise<RawIssue> => {
    const raw = await json<RawIssue>(['api', `repos/${repo}/issues/${n}`])
    assignees.set(n, (raw.assignees ?? []).map(a => a.login))
    return raw
  }

  const t: Tracker = {
    repo,
    async login() {
      cachedLogin ??= await gh(['api', 'user', '--jq', '.login'])
      return cachedLogin
    },
    async backlog() {
      // The list has the Priority field too. It also has PRs: drop them, as `gh issue list` did.
      const rows = parseLines<RawIssue>(await gh(['api', `repos/${repo}/issues?labels=factory&state=open&per_page=100`, '--paginate', '--jq', '.[]']))
      return rows.map(r => toTicket(r, [])).filter(r => r.kind === 'issue')
    },
    async get(n) {
      const raw = await issue(n)
      const list = parseLines<RawComment>(await gh(['api', `repos/${repo}/issues/${n}/comments`, '--paginate', '--jq', '.[]'])).map(toComment)
      comments.set(n, list)
      return toTicket(raw, list)
    },
    async setState(n, to, opts) {
      // A fresh read each time: a gate can run for minutes between two transitions.
      const labels = (await issue(n)).labels.map(l => l.name)
      const from = stateOf(labels)
      if (from === 'conflict') {
        const found = labels.filter(l => l.startsWith('factory:') && l !== 'factory:pr')
        await t.comment(n, `Factory stopped: this issue has more than one status label (${found.join(', ')}). Remove all status labels but one. Then ask the factory to continue.`)
        throw new FactoryError('label-conflict', `#${n} has several status labels: ${found.join(', ')}`, 'Remove all but one status label.')
      }
      assertTransition(from, to, opts)
      if (from === to) return from
      // One write sets the full list, so the issue never shows two status labels or none.
      const next = labels.filter(l => from === null || l !== statusLabel(from)).concat(statusLabel(to))
      await api('PUT', `issues/${n}/labels`, { labels: next })
      return from
    },
    async addLabel(n, label) {
      await api('POST', `issues/${n}/labels`, { labels: [label] })
    },
    async assign(n, on) {
      const me = await t.login()
      const now = assignees.get(n)
      if (now !== undefined && now.includes(me) === on) return
      await api(on ? 'POST' : 'DELETE', `issues/${n}/assignees`, { assignees: [me] })
      if (now !== undefined) assignees.set(n, on ? [...now, me] : now.filter(a => a !== me))
    },
    async upsertComment(n, name, body) {
      const me = await t.login()
      const text = JSON.stringify({ body: withMarker(name, body) })
      const list = comments.get(n) ?? (await t.get(n)).comments
      const existing = findMarked(list, name, me)
      const c = toComment(existing
        ? await json<RawComment>(['api', '-X', 'PATCH', `repos/${repo}/issues/comments/${existing.id}`, '--input', '-'], text)
        : await json<RawComment>(['api', '-X', 'POST', `repos/${repo}/issues/${n}/comments`, '--input', '-'], text))
      comments.set(n, existing ? list.map(x => (x.id === c.id ? c : x)) : [...list, c])
      return c
    },
    async comment(n, body) {
      await api('POST', `issues/${n}/comments`, { body })
    },
    async close(n, reason) {
      await api('PATCH', `issues/${n}`, { state: 'closed', state_reason: reason === 'done' ? 'completed' : 'not_planned' })
    },
    async createIssue(title, body, labels) {
      return Number(await gh(['api', '-X', 'POST', `repos/${repo}/issues`, '--input', '-', '--jq', '.number'], JSON.stringify({ title, body, labels })))
    },
    // shortcut: one search page of 50 hits, upgrade when the search limit hurts.
    async searchIssues(query) {
      const rows = parseLines<{ number: number; title: string; labels: { name: string }[] }>(await gh([
        'api', '-X', 'GET', 'search/issues', '-f', `q=repo:${repo} is:issue ${query}`, '-f', 'per_page=50', '--jq', '.items[]',
      ]))
      return rows.map(r => ({ number: r.number, title: r.title, labels: r.labels.map(l => l.name) }))
    },
    async findPr(branch) {
      const owner = repo.split('/')[0]!
      const rows = parseLines<RawPr>(await gh(['api', `repos/${repo}/pulls?head=${owner}:${branch}&state=all&per_page=100`, '--paginate', '--jq', '.[]']))
      // A reused branch can have old closed PRs: take the open one, else the newest. REST lists the newest first.
      const row = rows.find(r => r.state === 'open') ?? rows[0]
      return row ? toPr(row) : null
    },
    async openPr(branch, base, title, body, labels) {
      const r = JSON.parse(await api('POST', 'pulls', { title, head: branch, base, body, draft: false })) as RawPr
      if (labels.length > 0) await api('POST', `issues/${r.number}/labels`, { labels })
      return { number: r.number, url: r.html_url }
    },
    async prState(pr) {
      return toPr(await json<RawPr>(['api', `repos/${repo}/pulls/${pr}`]))
    },
    // shortcut: REST cannot end a draft, so an old draft PR takes one GraphQL mutation; upgrade when REST can.
    async prReady(pr) {
      const r = await json<RawPr>(['api', `repos/${repo}/pulls/${pr}`])
      if (r.draft) await gh(['api', 'graphql', '-f', READY, '-f', `id=${r.node_id}`])
    },
    async prApproved(pr, sha) {
      const reviews = parseLines<RawReview>(await gh(['api', `repos/${repo}/pulls/${pr}/reviews?per_page=100`, '--paginate', '--jq', '.[]']))
      return reviews.some(r => r.state === 'APPROVED' && r.commit_id === sha)
    },
    async prComment(pr, body) {
      await api('POST', `issues/${pr}/comments`, { body })
    },
    async approvePr(pr, body) {
      await api('POST', `pulls/${pr}/reviews`, { event: 'APPROVE', body })
    },
    async merge(pr, subject, sha) {
      await api('PUT', `pulls/${pr}/merge`, { merge_method: 'merge', commit_title: subject, sha })
    },
    async ensureLabels(labels: Label[]) {
      // One read, then a write only for a missing or a changed label.
      const have = new Map(parseLines<RawLabel>(await gh(['api', `repos/${repo}/labels?per_page=100`, '--paginate', '--jq', '.[]'])).map(l => [l.name, l]))
      for (const l of labels) {
        const h = have.get(l.name)
        const want = { color: l.color, description: l.description }
        if (h === undefined) await api('POST', 'labels', { name: l.name, ...want })
        else if (h.color.toLowerCase() !== l.color.toLowerCase() || (h.description ?? '') !== l.description) {
          await api('PATCH', `labels/${encodeURIComponent(l.name)}`, want)
        }
      }
    },
    async applyStandard(apply) {
      const read = async (): Promise<StandardCheck[]> => {
        const raw = await json<Record<string, unknown>>(['api', `repos/${repo}`])
        return Object.entries(STANDARD).map(([key, want]) => ({
          key, actual: raw[key] === undefined ? '(missing)' : String(raw[key]), expected: String(want), ok: raw[key] === want,
          fix: `Set ${key} to ${String(want)} in the repository settings.`,
        }))
      }
      const checks = await read()
      const drift = checks.filter(c => !c.ok)
      if (!apply || drift.length === 0) return checks
      // The API rejects one merge commit field without the other.
      const keys = new Set(drift.map(c => c.key))
      if (keys.has('merge_commit_title') || keys.has('merge_commit_message')) {
        keys.add('merge_commit_title').add('merge_commit_message')
      }
      const patch = Object.fromEntries([...keys].map(k => [k, STANDARD[k]]))
      await gh(['api', '-X', 'PATCH', `repos/${repo}`, '--input', '-'], JSON.stringify(patch))
      return read()
    },
  }
  return t
}
