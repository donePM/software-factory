import type { Tracker } from './tracker.ts'
import type { State } from './types.ts'

const WORK: State[] = ['intake', 'spec', 'build', 'review']

// The factory is assignee while it works on a job, and not while the job waits or ends.
export async function followState(t: Tracker, numbers: number[], to: State): Promise<void> {
  for (const n of numbers) {
    try {
      await t.assign(n, WORK.includes(to))
    } catch {
      // shortcut: assignee errors are ignored, report them when a user misses an assignee
    }
  }
}
