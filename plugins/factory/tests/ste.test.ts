import { expect, test } from 'claude-code/testing'
import * as tools from '../hooks/tools.ts'
import * as job from '../lib/job.ts'

// shortcut: plugin tests have no fs, so this scans the function source that the modules expose.
// Helpers that the modules do not export are out of reach; other tests assert their exact texts.
const sources = (mod: Record<string, unknown>): string[] => Object.values(mod).filter(v => typeof v === 'function').map(String)

test('job and tool texts give one step in each sentence', () => {
  const code = [...sources(job), ...sources(tools), ...tools.TOOLS.map(d => String(d.handler))].join('\n')
  const joined = code.split('\n').filter(l => /FactoryError\(|Fix:/.test(l) && l.includes(', then '))
  expect(joined).toEqual([])
})
