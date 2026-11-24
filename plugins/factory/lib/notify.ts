import type { Config } from './config.ts'
import { WAITING } from './queue.ts'
import { hintOf } from './status.ts'
import type { Tracker } from './tracker.ts'
import type { Ctx } from './types.ts'

// Collects each move into a waiting state. flush sends one notification for each move.
export function withWaitNotify(ctx: Ctx, tracker: Tracker, cfg: Partial<Pick<Config, 'merge'>>): { tracker: Tracker; flush: () => Promise<void> } {
  const texts: string[] = []
  const setState: Tracker['setState'] = async (n, to, opts) => {
    const from = await tracker.setState(n, to, opts)
    // shortcut: no stop cause in the notification, upgrade when operators ask for the reason in the toast
    if (from !== undefined && from !== to && WAITING.includes(to)) texts.push(`#${n} ${hintOf(tracker.repo, n, to, undefined, cfg.merge?.auto === true, [])}`)
    return from
  }
  const flush = async (): Promise<void> => {
    for (const text of texts.splice(0)) {
      // A failed notification never fails the tool.
      try {
        await ctx.notify?.(text)
      } catch {}
    }
  }
  return { tracker: { ...tracker, setState }, flush }
}
