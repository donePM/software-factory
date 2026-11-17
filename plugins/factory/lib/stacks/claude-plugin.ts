import type { Ctx } from '../types.ts'
import type { Detection, ReadFile, Stack, Step, ToolReq } from './types.ts'

const OPEN_SKILL = 'open the plugin-authoring skill once in this Claude Code version'
const TYPES_GLOB = '/private/tmp/claude-*/bundled-skills/$(claude --version | cut -d\' \' -f1)/*/plugin-authoring/types/claude-code.d.ts'

// Quotes a path only when the shell would change it.
const q = (s: string): string => (/^[\w./@+-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`)

const under = (p: string, f: string): boolean => p === '.' || f.startsWith(`${p}/`)
const rel = (p: string, name: string): string => (p === '.' ? name : `${p}/${name}`)

export function typesSource(p: string): string {
  const dir = q(rel(p, '.claude-plugin/types/claude-code'))
  return (
    `f=$(ls ${TYPES_GLOB} 2>/dev/null | head -1); ` +
    `[ -n "$f" ] || { echo 'engine types not found: ${OPEN_SKILL}' >&2; exit 1; }; ` +
    `mkdir -p ${dir} && cp "$f" ${dir}/index.d.ts`
  )
}

function markerDirs(files: string[], marker: string): string[] {
  const out: string[] = []
  for (const f of files) {
    if (f === marker) out.push('.')
    else if (f.endsWith(`/${marker}`)) out.push(f.slice(0, -marker.length - 1))
  }
  return out
}

export const claudePlugin: Stack = {
  id: 'claude-plugin',

  async detect(_ctx, _repo, files) {
    const plugins: Detection[] = markerDirs(files, '.claude-plugin/plugin.json').map(path => {
      const tools = ['claude']
      if (files.includes(rel(path, 'tsconfig.json'))) tools.push('tsc')
      // 'tests' marks a plugin with test files, so steps needs no second file listing.
      if (files.some(f => under(path, f) && /\.test\.tsx?$/.test(f))) tools.push('tests')
      return { stack: 'claude-plugin', path, variant: 'plugin', versions: {}, tools }
    })
    const markets: Detection[] = markerDirs(files, '.claude-plugin/marketplace.json').map(path => ({
      stack: 'claude-plugin', path, variant: 'marketplace', versions: {}, tools: ['claude'],
    }))
    return [...plugins, ...markets]
  },

  requires(d) {
    const reqs: ToolReq[] = [{ cmd: 'claude', versionArgs: ['--version'], fix: 'Install Claude Code.' }]
    if (d.variant === 'plugin' && d.tools.includes('tsc')) {
      reqs.push({ cmd: 'tsc', versionArgs: ['--version'], fix: 'brew install typescript' })
      reqs.push({ cmd: 'sh', versionArgs: ['-c', `ls ${TYPES_GLOB} >/dev/null 2>&1`], fix: OPEN_SKILL })
    }
    return reqs
  },

  async steps(ctx: Ctx, _read: ReadFile, d: Detection): Promise<Step[]> {
    const cwd = ctx.root
    const step = (name: Step['name'], argv: string[]): Step => ({ name, argv, cwd, source: 'default', stack: d.stack })
    const out: Step[] = []
    if (d.variant === 'plugin' && d.tools.includes('tsc')) {
      out.push(step('typecheck', ['sh', '-c', `${typesSource(d.path)} && tsc -p ${q(d.path)}`]))
    }
    out.push(step('lint', ['claude', 'plugin', 'validate', d.path]))
    if (d.variant === 'plugin' && d.tools.includes('tests')) out.push(step('test', ['claude', 'plugin', 'test', d.path]))
    return out
  },
}
