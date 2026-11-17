import type { Ctx } from '../types.ts'

export type StepName = 'install' | 'format' | 'lint' | 'typecheck' | 'build' | 'test' | 'audit' | 'start'

export type Detection = {
  stack: string
  path: string
  variant: string
  versions: Record<string, string>
  tools: string[]
  after?: string[]
}

export type Step = {
  name: StepName
  argv: string[]
  cwd: string
  source: 'config' | 'runner' | 'script' | 'default'
  stack: string
}

export type ToolReq = { cmd: string; versionArgs: string[]; fix: string }

// Reads runner and script files (Makefile, package.json). The gate passes a reader on the base state, never on the branch.
export type ReadFile = (rel: string) => Promise<string | null>

export interface Stack {
  id: string
  detect(ctx: Ctx, repo: string, files: string[]): Promise<Detection[]>
  requires(d: Detection): ToolReq[]
  steps(ctx: Ctx, read: ReadFile, d: Detection): Promise<Step[]>
}
