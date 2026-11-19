import { expect, test } from 'claude-code/testing'
import { followState } from '../lib/assignee.ts'
import type { Tracker } from '../lib/tracker.ts'
import type { State } from '../lib/types.ts'

function tracker(fail = false): Tracker & { assigns: string[] } {
  const assigns: string[] = []
  return {
    assigns,
    assign: async (n: number, on: boolean) => {
      assigns.push(`${on ? '+' : '-'}${n}`)
      if (fail) throw new Error('gh failed')
    },
  } as unknown as Tracker & { assigns: string[] }
}

test('assigns in work states and unassigns in wait and end states', async () => {
  const work: State[] = ['intake', 'spec', 'build', 'review']
  const rest: State[] = ['needs-info', 'fastlane', 'needs-design', 'needs-human', 'approved', 'docs', 'done', 'rejected']
  for (const to of work) {
    const t = tracker()
    await followState(t, [7, 12], to)
    expect(t.assigns).toEqual(['+7', '+12'])
  }
  for (const to of rest) {
    const t = tracker()
    await followState(t, [7, 12], to)
    expect(t.assigns).toEqual(['-7', '-12'])
  }
})

test('ignores an assignee error', async () => {
  const t = tracker(true)
  await followState(t, [7, 12], 'build')
  expect(t.assigns).toEqual(['+7', '+12'])
})
