import type { Label } from './labels.ts'
import type { MarkerName } from './markers.ts'
import type { Comment, Pr, PrState, State, Ticket } from './types.ts'

export type StandardCheck = { key: string; actual: string; expected: string; ok: boolean; fix: string }

export interface Tracker {
  repo: string
  login(): Promise<string>
  backlog(): Promise<Ticket[]>
  get(n: number): Promise<Ticket>
  setState(n: number, to: State): Promise<void>
  upsertComment(n: number, name: MarkerName, body: string): Promise<Comment>
  comment(n: number, body: string): Promise<void>
  close(n: number, reason: 'done' | 'rejected'): Promise<void>
  createIssue(title: string, body: string, labels: string[]): Promise<number>
  searchIssues(query: string): Promise<{ number: number; title: string; labels: string[] }[]>
  findPr(branch: string): Promise<PrState | null>
  openPr(branch: string, base: string, title: string, body: string, labels: string[]): Promise<Pr>
  prState(pr: number): Promise<PrState>
  prReady(pr: number): Promise<void>
  prComment(pr: number, body: string): Promise<void>
  approvePr(pr: number, body: string): Promise<void>
  // sha: GitHub refuses the merge when the PR head is not this commit.
  merge(pr: number, subject: string, sha: string): Promise<void>
  ensureLabels(labels: Label[]): Promise<void>
  applyStandard(apply: boolean): Promise<StandardCheck[]>
}
