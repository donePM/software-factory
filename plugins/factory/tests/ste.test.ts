import { expect, test } from 'claude-code/testing'
import * as tools from '../hooks/tools.ts'
import * as add from '../lib/add.ts'
import * as config from '../lib/config.ts'
import * as exec from '../lib/exec.ts'
import * as gate from '../lib/gate.ts'
import * as gatejob from '../lib/gatejob.ts'
import * as github from '../lib/github.ts'
import * as intake from '../lib/intake.ts'
import * as job from '../lib/job.ts'
import * as jobfile from '../lib/jobfile.ts'
import * as merge from '../lib/merge.ts'
import * as project from '../lib/project.ts'
import * as queue from '../lib/queue.ts'
import * as review from '../lib/review.ts'
import * as setup from '../lib/setup.ts'
import * as stacks from '../lib/stacks/index.ts'
import * as node from '../lib/stacks/node.ts'
import * as status from '../lib/status.ts'
import * as transitions from '../lib/transitions.ts'

// shortcut: plugin tests have no fs, so this scans only exported function source, upgrade to a file scan when tests get fs.
// Helpers that the modules do not export are out of reach. Other tests assert their exact texts.
const sources = (mod: Record<string, unknown>): string[] => Object.values(mod).filter(v => typeof v === 'function').map(String)

test('lib texts give one step in each sentence', () => {
  const mods = [job, tools, add, config, exec, gate, gatejob, github, intake, jobfile, merge, project, queue, review, setup, stacks, node, status, transitions]
  const code = [...mods.flatMap(sources), ...tools.TOOLS.map(d => String(d.handler))].join('\n')
  const joined = code.split('\n').filter(l => /FactoryError\(|Fix:|Factory stopped/.test(l) && l.includes(', then '))
  expect(joined).toEqual([])
})
