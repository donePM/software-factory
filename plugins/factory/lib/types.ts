import type { StepName } from './stacks/types.ts'

export type { StepName }
export type State =
  | 'intake' | 'needs-info' | 'fastlane' | 'spec' | 'needs-design' | 'build'
  | 'review' | 'needs-human' | 'approved' | 'docs' | 'done' | 'rejected'
export type Model = 'haiku' | 'sonnet' | 'opus' | 'fable'
export type Reviewer = 'code' | 'security' | 'ux' | 'ui'

export type RunOpts = { cwd?: string; stdin?: string; timeoutMs?: number; env?: Record<string, string> }
export type RunResult = { exitCode: number; stdout: string; stderr: string }
export type Run = (argv: readonly string[], opts?: RunOpts) => Promise<RunResult>
export type Fs = {
  read(p: string): Promise<string>
  write(p: string, text: string): Promise<void>
  exists(p: string): Promise<boolean>
  list(p: string): Promise<string[]>
}
export type Ctx = { run: Run; fs: Fs; root: string; now: () => Date; sleep: (ms: number) => Promise<void>; notify?: (text: string) => Promise<void> }

export type Comment = { id: number; author: string; body: string; createdAt: string; updatedAt: string }
export type Ticket = {
  kind: 'issue' | 'pr'
  number: number
  title: string
  body: string
  author: string
  labels: string[]
  state: 'open' | 'closed'
  createdAt: string
  url: string
  comments: Comment[]
  priority?: string
  stateReason?: string
}
export type Pr = { number: number; url: string }
export type PrState = {
  number: number
  state: 'OPEN' | 'CLOSED' | 'MERGED'
  isDraft: boolean
  title: string
  body: string
  author: string
  headRefName: string
  headRefOid: string
  mergeCommit: string | null
}
