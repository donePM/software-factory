// Factory agents have no GitHub access: only the tools talk to GitHub, and only the tools push.
// A best-effort word match, not a sandbox: a command can still hide `gh` (a variable, a script file).
// Quoted text and heredoc bodies are data. They are code after -c, -e or eval, in $(…), and in a heredoc to an interpreter.
const START = String.raw`(?:^|[\s;&|()\x60/'"])`
const END = String.raw`(?=$|[\s;&|()\x60'"])`
const GH = new RegExp(`${START}gh${END}`)
const PUSH = new RegExp(`${START}git(?:\\s(?:"[^"]*"|'[^']*'|[^;&|\\n'"])*)?\\spush${END}`)

// One list for the code rule and the script rule, so that the two rules cannot differ.
const INTERPRETERS = new Set(['sh', 'bash', 'zsh', 'python', 'python3', 'node', 'ruby', 'perl', 'bun', 'deno'])
const base = (w: string): string => w.slice(w.lastIndexOf('/') + 1)
const interpreter = (w: string): boolean => INTERPRETERS.has(base(w))
// -c, -e, -E, -p, a combined flag such as -lc or -pe, --eval and --print: the next argument is code.
const CODE_FLAG = /^-[a-zA-Z]*[ceEp]$|^--(?:eval|print)$/
// A quoted word that is only gh runs gh as a command word, also after xargs or env.
const GH_WORD = /^(?:\S*\/)?gh$/
const HEREDOC = /^<<(-?)[ \t]*(?:'([^']*)'|"([^"]*)"|(\\?)([^\s;&|<>()'"]+))/

// The end of a double-quoted part (or of a heredoc body when quote is false), and its $(…) and backtick parts.
function substitutions(s: string, from: number, quote: boolean): { end: number; subs: string[] } {
  const subs: string[] = []
  let i = from
  while (i < s.length) {
    const c = s[i]
    if (quote && c === '"') break
    if (c === '\\') i += 2
    else if (c === '`') {
      const j = s.indexOf('`', i + 1)
      const e = j < 0 ? s.length : j
      subs.push(s.slice(i + 1, e))
      i = e + 1
    } else if (c === '$' && s[i + 1] === '(') {
      let depth = 0
      let j = i + 1
      for (; j < s.length; j++) if (s[j] === '(') depth++; else if (s[j] === ')' && --depth === 0) break
      subs.push(s.slice(i + 2, j))
      i = j + 1
    } else i++
  }
  return { end: i, subs }
}

// The command with each data part (quoted text, a heredoc body) as a space. Code parts stay as they are.
function code(cmd: string): string {
  let out = ''
  let word = ''
  let words: string[] = []
  // The words of the line: a heredoc can go to an interpreter later in a pipe (cat <<EOF | sh).
  let line: string[] = []
  let docs: { delim: string; tabs: boolean; expand: boolean }[] = []
  const end = () => {
    if (word !== '') words.push(word), line.push(word)
    word = ''
  }
  const isCode = () => {
    // In $'…', the $ is not the word before the quote.
    const prev = word !== '' && word !== '$' ? word : (words.at(-1) ?? '')
    return words.some(w => base(w) === 'eval') || (words.some(interpreter) && (CODE_FLAG.test(prev) || prev === '<<<'))
  }
  // The shell joins quoted text into the command word ("gh", g''h), so the command word stays code.
  const data = (body: string, rest: string): string =>
    words.length === 0 ? (word === '$' ? ' ' : '') + body : GH_WORD.test(body) ? ` ${body} ` : rest
  let i = 0
  while (i < cmd.length) {
    const c = cmd[i] as string
    const doc = c === '<' && !cmd.startsWith('<<<', i) ? HEREDOC.exec(cmd.slice(i)) : null
    if (c === '\\') {
      const n = cmd[i + 1] ?? ''
      if (n !== '\n') (word += n), (out += n)
      i += 2
    } else if (cmd.startsWith('<<<', i)) {
      word += '<<<'
      out += '<<<'
      i += 3
    } else if (c === "'") {
      const j = cmd.indexOf("'", i + 1)
      const e = j < 0 ? cmd.length : j
      const body = cmd.slice(i + 1, e)
      out += isCode() ? ` ${body} ` : data(body, ' ')
      word += body
      i = e + 1
    } else if (c === '"') {
      const { end: e, subs } = substitutions(cmd, i + 1, true)
      const body = cmd.slice(i + 1, e)
      out += isCode() ? ` ${body} ` : data(body, ` ${subs.map(code).join(' ')} `)
      word += body
      i = e + 1
    } else if (doc) {
      docs.push({ delim: doc[2] ?? doc[3] ?? doc[5] ?? '', tabs: doc[1] === '-', expand: doc[4] === '' })
      end()
      out += ' '
      i += doc[0].length
    } else if (c === '\n') {
      end()
      let pos = i + 1
      for (const d of docs) {
        const lines: string[] = []
        while (pos < cmd.length) {
          const j = cmd.indexOf('\n', pos)
          const e = j < 0 ? cmd.length : j
          const l = cmd.slice(pos, e)
          pos = e + 1
          if ((d.tabs ? l.replace(/^\t+/, '') : l) === d.delim) break
          lines.push(l)
        }
        const body = lines.join('\n')
        out += line.some(interpreter) ? `\n${body}\n` : d.expand ? ` ${substitutions(body, 0, false).subs.map(code).join(' ')} ` : ' '
      }
      out += '\n'
      docs = []
      words = []
      line = []
      i = pos
    } else {
      if (/[\s;&|()`]/.test(c)) {
        end()
        if (c !== ' ' && c !== '\t') words = []
      } else word += c
      out += c
      i++
    }
  }
  return out
}

export const reachesGitHub = (command: string): boolean => {
  const c = code(command)
  return GH.test(c) || PUSH.test(c)
}

const PAD = '/scratchpad/'

// shortcut: checks only scripts in the scratchpad, upgrade when a run shows a script from another path.
const runsScratchpadScript = (command: string): boolean =>
  command.split(/[;&|()`\n]/).some(part => {
    const words = part.trim().split(/\s+/).map(w => w.replace(/['"]/g, ''))
    const run = words.slice(Math.max(0, words.findIndex(w => !/^\w+=/.test(w))))
    const k = run.findIndex(interpreter)
    return (run[0]?.includes(PAD) ?? false) ||
      ((run[0] === 'source' || run[0] === '.') && (run[1]?.includes(PAD) ?? false)) ||
      (k >= 0 && run.slice(k + 1).some(w => w.includes(PAD)))
  })

export const DENY_GITHUB = 'Factory agents have no GitHub access: do not run gh or git push. The factory tools push and talk to GitHub.'

export const DENY_SCRIPT = 'Factory agents do not run scripts from the scratchpad. Use Edit or Write to change a file. Do not go around a denied command.'

type Agent = { id: string; type: string }

// Denies only for a subagent that is a factory agent, or that the agent list does not name.
export async function guardBash(agentId: string | undefined, command: unknown, list: () => Promise<Agent[]>): Promise<string | null> {
  if (agentId === undefined || typeof command !== 'string') return null
  const deny = reachesGitHub(command) ? DENY_GITHUB : runsScratchpadScript(command) ? DENY_SCRIPT : null
  if (deny === null) return null
  const agent = (await list()).find(a => a.id === agentId)
  return agent === undefined || agent.type.startsWith('factory:') ? deny : null
}

export const DENY_MAIN = 'The factory main session never runs Bash. Use a factory tool or a subagent, or start a new session for Bash.'

// The main session has no agentId. After /factory:run it gets no Bash.
export const guardMain = (agentId: string | undefined, running: boolean): string | null =>
  agentId === undefined && running ? DENY_MAIN : null
