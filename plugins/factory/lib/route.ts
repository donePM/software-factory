import type { Config } from './config.ts'
import type { Intake } from './intake.ts'
import type { Model, Reviewer } from './types.ts'

export type Route = Partial<Record<Reviewer, Model>>

const STRENGTH: Model[] = ['haiku', 'sonnet', 'opus', 'fable']

function merge(into: Route, from: Route | undefined): void {
  for (const [r, m] of Object.entries(from ?? {}) as [Reviewer, Model][]) {
    const cur = into[r]
    if (cur === undefined || STRENGTH.indexOf(m) > STRENGTH.indexOf(cur)) into[r] = m
  }
}

export function route(i: Intake, cfg: Config): Route {
  const out: Route = {}
  merge(out, cfg.routing[i.risk])
  // shortcut: ui-new counts as ui in the bootstrap; the config already gives it its own models.
  for (const s of i.surfaces) merge(out, cfg.surfaces[s])
  out.code ??= 'sonnet'
  return out
}
