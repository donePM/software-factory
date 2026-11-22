import { FactoryError, must } from './exec.ts'
import { type Migration, migrations } from './migrations/index.ts'
import type { Ctx, Model, Reviewer, StepName } from './types.ts'

export const CONFIG_VERSION = 1

export type StackRef = { id: string; path: string; steps?: Partial<Record<StepName, string>> }
type Models = Partial<Record<Reviewer, Model>>
export type Config = {
  version: number
  tracker: { type: 'github'; url: string }
  concurrency: number
  maxRounds: number
  baseBranch: string
  merge: { method: 'merge'; auto?: boolean }
  repo: { standard: number }
  stacks: StackRef[]
  routing: Record<'low' | 'medium' | 'high', Models>
  surfaces: Record<string, Models>
  protectedPaths: string[]
  project?: { enabled: boolean; number?: number }
  language?: string
}

const MODELS: readonly string[] = ['haiku', 'sonnet', 'opus', 'fable']
const REVIEWERS: readonly string[] = ['code', 'security', 'ux', 'ui']
const STEPS: readonly string[] = ['install', 'format', 'lint', 'typecheck', 'build', 'test', 'audit', 'start']
// The language reaches prompts, so it stays a short name with no newline.
const LANGUAGE = /^\p{L}[\p{L}\p{M} ()-]{0,39}$/u
export const LANGUAGE_ERROR = 'language must be a short single-line name'

export function validLanguage(x: unknown): boolean {
  return typeof x === 'string' && LANGUAGE.test(x)
}

export function defaultConfig(url: string, baseBranch: string, stacks: StackRef[]): Config {
  return {
    version: CONFIG_VERSION,
    tracker: { type: 'github', url },
    concurrency: 4,
    maxRounds: 3,
    baseBranch,
    merge: { method: 'merge' },
    repo: { standard: 1 },
    stacks,
    routing: {
      low: { code: 'haiku' },
      medium: { code: 'sonnet' },
      high: { code: 'sonnet', security: 'opus' },
    },
    surfaces: {
      ui: { ux: 'sonnet', ui: 'haiku' },
      'ui-new': { ux: 'sonnet', ui: 'sonnet' },
      security: { security: 'opus' },
      api: { security: 'opus' },
    },
    project: { enabled: false },
    language: 'English',
    protectedPaths: ['.factory/config.json', '.factory/checks.local.ts'],
  }
}

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x)
}

function posInt(x: unknown): boolean {
  return typeof x === 'number' && Number.isInteger(x) && x >= 1
}

function checkModels(errs: string[], path: string, x: unknown): void {
  if (!isObj(x)) {
    errs.push(`${path} must be an object`)
    return
  }
  for (const [k, v] of Object.entries(x)) {
    if (!REVIEWERS.includes(k)) errs.push(`${path}.${k} is not a reviewer`)
    else if (typeof v !== 'string' || !MODELS.includes(v)) errs.push(`${path}.${k} must be one of ${MODELS.join(', ')}`)
  }
}

function isStrings(x: unknown): x is string[] {
  return Array.isArray(x) && x.every(s => typeof s === 'string')
}

export function validateConfig(x: unknown): string[] {
  if (!isObj(x)) return ['config must be an object']
  const errs: string[] = []
  if (!posInt(x.version)) errs.push('version must be a positive integer')
  if (!isObj(x.tracker) || x.tracker.type !== 'github' || typeof x.tracker.url !== 'string' || x.tracker.url === '') {
    errs.push('tracker must be { type: "github", url }')
  }
  if (!posInt(x.concurrency)) errs.push('concurrency must be an integer of 1 or more')
  if (!posInt(x.maxRounds)) errs.push('maxRounds must be an integer of 1 or more')
  if (typeof x.baseBranch !== 'string' || x.baseBranch === '') errs.push('baseBranch must be a non-empty string')
  if (!isObj(x.merge) || x.merge.method !== 'merge') errs.push('merge.method must be "merge"')
  else if (x.merge.auto !== undefined && typeof x.merge.auto !== 'boolean') errs.push('merge.auto must be a boolean')
  if (!isObj(x.repo) || typeof x.repo.standard !== 'number') errs.push('repo.standard must be a number')
  if (!Array.isArray(x.stacks)) errs.push('stacks must be an array')
  else {
    x.stacks.forEach((s: unknown, i) => {
      if (!isObj(s) || typeof s.id !== 'string' || typeof s.path !== 'string') {
        errs.push(`stacks[${i}] needs id and path`)
        return
      }
      if (s.steps === undefined) return
      if (!isObj(s.steps)) errs.push(`stacks[${i}].steps must be an object`)
      else {
        for (const [k, v] of Object.entries(s.steps)) {
          if (!STEPS.includes(k)) errs.push(`stacks[${i}].steps.${k} is not a step`)
          else if (typeof v !== 'string') errs.push(`stacks[${i}].steps.${k} must be a string`)
        }
      }
    })
  }
  if (!isObj(x.routing)) errs.push('routing must be an object')
  else {
    for (const level of ['low', 'medium', 'high']) checkModels(errs, `routing.${level}`, x.routing[level])
  }
  if (!isObj(x.surfaces)) errs.push('surfaces must be an object')
  else for (const [k, v] of Object.entries(x.surfaces)) checkModels(errs, `surfaces.${k}`, v)
  if (!isStrings(x.protectedPaths)) errs.push('protectedPaths must be an array of strings')
  if (x.project !== undefined) {
    if (!isObj(x.project)) errs.push('project must be an object')
    else {
      if (typeof x.project.enabled !== 'boolean') errs.push('project.enabled must be a boolean')
      if (x.project.number !== undefined && !posInt(x.project.number)) errs.push('project.number must be an integer of 1 or more')
    }
  }
  if (x.language !== undefined && !validLanguage(x.language)) errs.push(LANGUAGE_ERROR)
  return errs
}

export function configPath(root: string): string {
  return `${root}/.factory/config.json`
}

const SETUP = 'Run /factory:setup'

export async function loadConfig(ctx: Ctx): Promise<Config> {
  const path = configPath(ctx.root)
  if (!(await ctx.fs.exists(path))) throw new FactoryError('no-config', `${path} does not exist`, SETUP)
  let raw: unknown
  try {
    raw = JSON.parse(await ctx.fs.read(path))
  } catch (e) {
    throw new FactoryError('config-invalid', `${path} is not valid JSON: ${(e as Error).message}`)
  }
  if (isObj(raw) && typeof raw.version === 'number' && raw.version < CONFIG_VERSION) {
    throw new FactoryError('config-outdated', `config version ${raw.version} is older than ${CONFIG_VERSION}`, SETUP)
  }
  if (isObj(raw) && typeof raw.version === 'number' && raw.version > CONFIG_VERSION) {
    throw new FactoryError('config-too-new', `config version ${raw.version} is newer than the plugin's ${CONFIG_VERSION}`, 'Update the factory plugin.')
  }
  const errs = validateConfig(raw)
  if (errs.length > 0) throw new FactoryError('config-invalid', errs.join('\n'))
  return raw as Config
}

const WIDTH = 80

// JSON.stringify with indent 2, but an array of plain values stays on one line when it fits in 80 columns.
// Prettier and oxfmt (vp fmt) print JSON this way, so the format step of the gate accepts the file.
function formatJson(v: unknown, indent: string, prefix: string, suffix: string): string {
  if (Array.isArray(v) && v.length > 0 && v.every(x => x === null || typeof x !== 'object')) {
    const flat = `[${v.map(x => JSON.stringify(x)).join(', ')}]`
    if (indent.length + prefix.length + flat.length + suffix.length <= WIDTH) return flat
  }
  const inner = `${indent}  `
  if (Array.isArray(v)) {
    if (v.length === 0) return '[]'
    const items = v.map((x, i) => inner + formatJson(x, inner, '', i < v.length - 1 ? ',' : ''))
    return `[\n${items.join(',\n')}\n${indent}]`
  }
  if (v !== null && typeof v === 'object') {
    const entries = Object.entries(v).filter(([, x]) => x !== undefined)
    if (entries.length === 0) return '{}'
    const items = entries.map(([k, x], i) => {
      const key = `${JSON.stringify(k)}: `
      return inner + key + formatJson(x, inner, key, i < entries.length - 1 ? ',' : '')
    })
    return `{\n${items.join(',\n')}\n${indent}}`
  }
  return JSON.stringify(v)
}

export async function writeConfig(ctx: Ctx, c: Config): Promise<void> {
  await ctx.fs.write(configPath(ctx.root), `${formatJson(c, '', '', '')}\n`)
}

export type MigrateResult = { from: number; to: number; applied: string[]; backup?: string }

const KEEP_BACKUPS = 3

async function pruneBackups(ctx: Ctx, dir: string): Promise<void> {
  const found: { v: number; name: string }[] = []
  for (const name of await ctx.fs.list(dir)) {
    const m = /^config\.(\d+)\.json$/.exec(name)
    if (m) found.push({ v: Number(m[1]), name })
  }
  found.sort((a, b) => a.v - b.v)
  for (const old of found.slice(0, Math.max(0, found.length - KEEP_BACKUPS))) {
    await must(ctx, ['rm', '-f', `${dir}/${old.name}`])
  }
}

// Runs the migrations in memory. Writes nothing.
export async function planMigration(
  ctx: Ctx,
  list: Migration[] = migrations,
): Promise<MigrateResult & { config: Config; text: string }> {
  const path = configPath(ctx.root)
  if (!(await ctx.fs.exists(path))) throw new FactoryError('no-config', `${path} does not exist`, SETUP)
  const text = await ctx.fs.read(path)
  let cfg: unknown
  try {
    cfg = JSON.parse(text)
  } catch (e) {
    throw new FactoryError('config-invalid', `${path} is not valid JSON: ${(e as Error).message}`)
  }
  if (!isObj(cfg) || typeof cfg.version !== 'number') throw new FactoryError('config-invalid', 'version must be a number')
  const from = cfg.version
  const target = list.length > 0 ? Math.max(...list.map(m => m.from)) + 1 : CONFIG_VERSION
  if (from > target) {
    throw new FactoryError('config-too-new', `config version ${from} is newer than the plugin's ${target}`, 'Update the factory plugin.')
  }
  if (from === target) return { from, to: from, applied: [], config: cfg as Config, text }
  const applied: string[] = []
  let cur: unknown = cfg
  for (let v = from; v < target; v++) {
    const step = list.find(m => m.from === v)
    if (!step) throw new FactoryError('migration-missing', `no migration from version ${v}`)
    cur = step.up(cur)
    if (isObj(cur)) cur.version = v + 1
    applied.push(step.name)
  }
  const errs = validateConfig(cur)
  if (errs.length > 0) throw new FactoryError('config-invalid', `migration result is invalid:\n${errs.join('\n')}`)
  return { from, to: target, applied, config: cur as Config, text }
}

export async function migrate(ctx: Ctx, list: Migration[] = migrations): Promise<MigrateResult> {
  const { from, to, applied, config, text } = await planMigration(ctx, list)
  if (applied.length === 0) return { from, to, applied }
  const dir = `${ctx.root}/.factory/backup`
  const backup = `.factory/backup/config.${from}.json`
  await ctx.fs.write(`${ctx.root}/${backup}`, text)
  await pruneBackups(ctx, dir)
  await writeConfig(ctx, config)
  return { from, to, applied, backup }
}
