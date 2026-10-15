export type AgentRow = {
  id: string
  type: string
  description: string
  model: string
  effort?: string
  startedAt: number
  /** ms of the runs that ended; a resumed agent adds a run */
  doneMs: number
  /** start of the run in progress; absent while idle or done */
  runSince?: number
  status: 'running' | 'done' | 'aborted'
}

export type Job = { id: string; title?: string; stage: string; note?: string }

export type Board = {
  /** absolute repo root; empty when the session is not in a factory repo */
  root: string
  runner: string | null
  heartbeat: string | null
  jobs: Job[]
  /** job id → queued inbox action */
  queued: Record<string, string>
}

declare module 'claude-code' {
  interface PluginState {
    factory: {
      agents: AgentRow[]
      board: Board
      now: number
      reworkFor: string
    }
  }
}
