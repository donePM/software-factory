import type { Ctx } from '../types.ts'
import type { Detection, ReadFile, Stack, Step, ToolReq } from './types.ts'

export const TYPES_FIX = 'Restart Claude Code so that the session runs the installed CLI version. Then open the plugin-authoring skill once.'
// EX_UNAVAILABLE of sysexits. tsc exits only with 0 to 4, so the gate can tell a host problem from a tsc error.
export const TYPES_MISSING_EXIT = 69
const TYPES_AT = (v: string): string => `/private/tmp/claude-*/bundled-skills/${v}/*/plugin-authoring/types/claude-code.d.ts`

// Quotes a path only when the shell would change it.
const q = (s: string): string => (/^[\w./@+-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`)

const under = (p: string, f: string): boolean => p === '.' || f.startsWith(`${p}/`)
const rel = (p: string, name: string): string => (p === '.' ? name : `${p}/${name}`)

// Takes the types of `claude --version`. Else it takes the newest bundled version: the session can run another version.
export function typesSource(p: string): string {
  const dir = q(rel(p, '.claude-plugin/types/claude-code'))
  const first = (v: string): string => `f=$(ls ${TYPES_AT(`"${v}"`)} 2>/dev/null | head -1)`
  return (
    `w=$(claude --version | cut -d' ' -f1); u=$w; ${first('$w')}; ` +
    `[ -n "$f" ] || { u=$(ls ${TYPES_AT('*')} 2>/dev/null | sed 's|^/private/tmp/claude-[^/]*/bundled-skills/||; s|/.*||' | sort -t. -k1,1n -k2,2n -k3,3n | tail -1); ` +
    `[ -z "$u" ] || ${first('$u')}; }; ` +
    // shortcut: "found: none" is fixed text, because any found version makes the fallback run.
    `[ -n "$f" ] || { echo "engine types not found for $w, found: none: ${TYPES_FIX}" >&2; exit ${TYPES_MISSING_EXIT}; }; ` +
    `echo "engine types: used $u, wanted $w"; mkdir -p ${dir} && cp "$f" ${dir}/index.d.ts`
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
      reqs.push({ cmd: 'sh', versionArgs: ['-c', `ls ${TYPES_AT('*')} >/dev/null 2>&1`], fix: TYPES_FIX })
    }
    return reqs
  },

  async steps(_ctx: Ctx, _read: ReadFile, d: Detection): Promise<Step[]> {
    const cwd = '.' // the argv holds the plugin path
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
