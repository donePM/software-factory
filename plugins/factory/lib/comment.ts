import { FactoryError } from './exec.ts'
import { stateOf } from './labels.ts'
import { firstLine, MARKER_LINE } from './markers.ts'
import { STOP } from './queue.ts'
import type { Tracker } from './tracker.ts'

export type CommentInput = { issue: number; text: string; state: 'needs-human' | 'needs-info' }

// Posts an operator comment on a waiting job. Text that the factory reads as its own comment is refused.
export async function issueComment(tr: Tracker, input: CommentInput): Promise<{ issue: number; state: string }> {
  const { issue, state } = input
  const text = input.text.trim()
  const fix = 'Write the text in your own words. Do not start with a factory marker or "Factory stopped: ".'
  if (text === '') throw new FactoryError('bad-text', 'the text is empty', 'Give the text after the issue number.')
  if (text.startsWith(STOP) || MARKER_LINE.test(firstLine(text))) throw new FactoryError('bad-text', 'the text looks like a factory comment', fix)
  const now = stateOf((await tr.get(issue)).labels)
  if (now !== state) {
    throw new FactoryError('wrong-state', `#${issue} is ${now ?? 'not a factory job'}, not ${state}`, 'Run /factory:status. Then use the command for the state of the job.')
  }
  await tr.comment(issue, text)
  return { issue, state }
}
