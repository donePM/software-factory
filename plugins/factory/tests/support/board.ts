import { FACTORY_OPTIONS, withBoard } from '../../lib/project.ts'
import type { Tracker } from '../../lib/tracker.ts'
import type { Ctx } from '../../lib/types.ts'
import type { Reply } from './host.ts'

export const ON = { project: { enabled: true, number: 3 } }

const json = (v: unknown) => ({ stdout: JSON.stringify(v) })
export const boardReplies: Reply[] = [
  { argv: ['gh', 'project', 'view'], result: json({ number: 3, id: 'P1', url: 'https://github.com/users/o/projects/3' }) },
  { argv: ['gh', 'project', 'field-list'], result: json({ fields: [{ id: 'F1', name: 'Factory', options: FACTORY_OPTIONS.map(o => ({ id: `id-${o}`, name: o })) }] }) },
  { argv: ['gh', 'project', 'item-add'], result: json({ id: 'I1' }) },
  { argv: ['gh', 'project', 'item-edit'] },
]

// Records each label change in ctx.calls as ['setState', n, to], so that a test can check the order.
export function onBoard(ctx: Ctx & { calls: string[][] }, t: Tracker, cfg: Parameters<typeof withBoard>[2] = ON) {
  const rec: Tracker = {
    ...t,
    repo: 'o/r',
    setState: async (n, to, opts) => {
      await t.setState(n, to, opts)
      ctx.calls.push(['setState', String(n), to])
    },
  }
  return withBoard(ctx, rec, cfg)
}

// The label changes and the project calls, in order.
export const boardCalls = (calls: string[][]): string[] =>
  calls
    .filter(c => c[0] === 'setState' || (c[0] === 'gh' && c[1] === 'project'))
    .map(c => (c[0] === 'setState' ? c.join(' ') : c.slice(0, 3).join(' ')))

export const edit = (option: string): string[] =>
  ['gh', 'project', 'item-edit', '--id', 'I1', '--project-id', 'P1', '--field-id', 'F1', '--single-select-option-id', `id-${option}`]
