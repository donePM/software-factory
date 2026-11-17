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

const ISSUE_FIELDS = 'number,title,body,labels,author,createdAt,url,state'
const PR_FIELDS = 'number,state,isDraft,title,body,author,headRefName,headRefOid,reviewDecision'

type RawIssue = {
  number: number; title: string; body: string; labels: { name: string }[]
  author: { login: string }; createdAt: string; url: string; state: string
}
type RawComment = { id: number; user: { login: string }; body: string; created_at: string; updated_at: string }
type RawPr = Omit<PrState, 'author'> & { author: { login: string } }

// `gh api --paginate` prints one JSON array per page, back to back.
function parsePages<T>(text: string): T[] {
  const out: T[] = []
  let depth = 0
  let inStr = false
  let esc = false
  let start = 0
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
    } else if (ch === '"') inStr = true
    else if (ch === '[' || ch === '{') {
      if (depth === 0) start = i
      depth++
    } else if (ch === ']' || ch === '}') {
      depth--
      if (depth === 0) out.push(...(JSON.parse(text.slice(start, i + 1)) as T[]))
    }
  }
  return out
}

const toTicket = (r: RawIssue, comments: Comment[]): Ticket => ({
  kind: 'issue', number: r.number, title: r.title, body: r.body, author: r.author.login,
  labels: r.labels.map(l => l.name), state: r.state === 'CLOSED' ? 'closed' : 'open',
  createdAt: r.createdAt, url: r.url, comments,
})
const toComment = (c: RawComment): Comment => ({
  id: c.id, author: c.user.login, body: c.body, createdAt: c.created_at, updatedAt: c.updated_at,
})
const toPr = (r: RawPr): PrState => ({ ...r, author: r.author.login })
const numberFromUrl = (url: string): number => {
  const m = /\/(\d+)\s*$/.exec(url)
  if (!m) throw new FactoryError('bad-output', `no number in ${url}`)
  return Number(m[1])
}
const labelArgs = (labels: string[]): string[] => labels.flatMap(l => ['--label', l])

const STANDARD: Record<string, string | boolean> = {
  allow_merge_commit: true, allow_squash_merge: false, allow_rebase_merge: false,
  merge_commit_title: 'PR_TITLE', merge_commit_message: 'PR_BODY', delete_branch_on_merge: true, has_issues: true,
}

export function githubTracker(ctx: Ctx, repo: string): Tracker {
  let cachedLogin: string | undefined
  const gh = (argv: string[], stdin?: string): Promise<string> =>
    must(ctx, ['gh', ...argv], stdin === undefined ? undefined : { stdin })
  const json = async <T>(argv: string[], stdin?: string): Promise<T> => JSON.parse(await gh(argv, stdin)) as T

  const t: Tracker = {
    repo,
    async login() {
      cachedLogin ??= await gh(['api', 'user', '--jq', '.login'])
      return cachedLogin
    },
    async backlog() {
      const rows = await json<RawIssue[]>([
        'issue', 'list', '-R', repo, '--label', 'factory', '--state', 'open', '--limit', '200', '--json', ISSUE_FIELDS,
      ])
      return rows.map(r => toTicket(r, []))
    },
    async get(n) {
      const raw = await json<RawIssue>(['issue', 'view', String(n), '-R', repo, '--json', ISSUE_FIELDS])
      const comments = parsePages<RawComment>(await gh(['api', `repos/${repo}/issues/${n}/comments`, '--paginate']))
      return toTicket(raw, comments.map(toComment))
    },
    async setState(n, to) {
      const ticket = await t.get(n)
      const from = stateOf(ticket.labels)
      if (from === 'conflict') {
        const found = ticket.labels.filter(l => l.startsWith('factory:') && l !== 'factory:pr')
        await t.comment(n, `Factory stopped: this issue has more than one status label (${found.join(', ')}). Remove all but one, then ask the factory to continue.`)
        throw new FactoryError('label-conflict', `#${n} has several status labels: ${found.join(', ')}`, 'Remove all but one status label.')
      }
      assertTransition(from, to)
      if (from === to) return
      const args = ['issue', 'edit', String(n), '-R', repo, '--add-label', statusLabel(to)]
      if (from !== null) args.push('--remove-label', statusLabel(from))
      await gh(args)
    },
    async upsertComment(n, name, body) {
      const me = await t.login()
      const text = withMarker(name, body)
      const existing = findMarked((await t.get(n)).comments, name, me)
      const raw = existing
        ? await json<RawComment>(['api', '-X', 'PATCH', `repos/${repo}/issues/comments/${existing.id}`, '--input', '-'], JSON.stringify({ body: text }))
        : await json<RawComment>(['api', '-X', 'POST', `repos/${repo}/issues/${n}/comments`, '--input', '-'], JSON.stringify({ body: text }))
      return toComment(raw)
    },
    async comment(n, body) {
      await gh(['issue', 'comment', String(n), '-R', repo, '--body-file', '-'], body)
    },
    async close(n, reason) {
      await gh(['issue', 'close', String(n), '-R', repo, '--reason', reason === 'done' ? 'completed' : 'not planned'])
    },
    async createIssue(title, body, labels) {
      const url = await gh(['issue', 'create', '-R', repo, '--title', title, '--body-file', '-', ...labelArgs(labels)], body)
      return numberFromUrl(url)
    },
    async searchIssues(query) {
      const rows = await json<{ number: number; title: string; labels: { name: string }[] }[]>([
        'issue', 'list', '-R', repo, '--state', 'all', '--search', query, '--limit', '50', '--json', 'number,title,labels',
      ])
      return rows.map(r => ({ number: r.number, title: r.title, labels: r.labels.map(l => l.name) }))
    },
    async findPr(branch) {
      const rows = await json<RawPr[]>(['pr', 'list', '-R', repo, '--head', branch, '--state', 'all', '--json', PR_FIELDS])
      return rows[0] ? toPr(rows[0]) : null
    },
    async openPr(branch, base, title, body, labels) {
      const url = await gh([
        'pr', 'create', '-R', repo, '--draft', '--base', base, '--head', branch, '--title', title,
        '--body-file', '-', ...labelArgs(labels),
      ], body)
      return { number: numberFromUrl(url), url }
    },
    async prState(pr) {
      return toPr(await json<RawPr>(['pr', 'view', String(pr), '-R', repo, '--json', PR_FIELDS]))
    },
    async prReady(pr) {
      await gh(['pr', 'ready', String(pr), '-R', repo])
    },
    async prComment(pr, body) {
      await gh(['pr', 'comment', String(pr), '-R', repo, '--body-file', '-'], body)
    },
    async approvePr(pr, body) {
      await gh(['pr', 'review', String(pr), '-R', repo, '--approve', '--body-file', '-'], body)
    },
    async merge(pr, subject) {
      await gh(['pr', 'merge', String(pr), '-R', repo, '--merge', '--subject', subject])
    },
    async ensureLabels(labels: Label[]) {
      for (const l of labels) {
        await gh(['label', 'create', l.name, '-R', repo, '--color', l.color, '--description', l.description, '--force'])
      }
    },
    async applyStandard(apply) {
      const read = async (): Promise<StandardCheck[]> => {
        const raw = await json<Record<string, unknown>>(['api', `repos/${repo}`])
        return Object.entries(STANDARD).map(([key, want]) => ({
          key, actual: String(raw[key]), expected: String(want), ok: raw[key] === want,
          fix: `Set ${key} to ${String(want)} in the repository settings.`,
        }))
      }
      const checks = await read()
      const drift = checks.filter(c => !c.ok)
      if (!apply || drift.length === 0) return checks
      const patch = Object.fromEntries(drift.map(c => [c.key, STANDARD[c.key]]))
      await gh(['api', '-X', 'PATCH', `repos/${repo}`, '--input', '-'], JSON.stringify(patch))
      return read()
    },
  }
  return t
}
