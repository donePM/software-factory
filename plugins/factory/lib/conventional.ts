export const CC_TYPES = ['feat', 'fix', 'docs', 'style', 'refactor', 'perf', 'test', 'build', 'ci', 'chore', 'revert']
export const CC_PATTERN = /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([a-z0-9][a-z0-9._/-]*\))?(!)?: \S.*$/

// Checks the first line against Conventional Commits 1.0.0. A BREAKING CHANGE footer and the "!" are both optional.
export function checkMessage(msg: string): string | null {
  const first = msg.split('\n')[0] ?? ''
  if (CC_PATTERN.test(first)) return null
  const head = /^([A-Za-z]+)/.exec(first)?.[1] ?? ''
  if (!CC_TYPES.includes(head)) return `unknown type "${head}"; use one of ${CC_TYPES.join(', ')}`
  const m = /^[a-z]+(\([^)]*\))?!?/.exec(first)?.[0] ?? head
  const rest = first.slice(m.length)
  if (!rest.startsWith(':')) return `expected ": " after "${m}"`
  if (!rest.startsWith(': ')) return 'a space must follow the colon'
  if (rest.slice(2).trim() === '') return 'the description is empty'
  return 'the scope must be lower case letters, digits, ".", "_", "/" or "-"'
}

export function typeOf(title: string): { type: string; breaking: boolean } | null {
  const m = CC_PATTERN.exec(title)
  return m ? { type: m[1]!, breaking: m[3] === '!' } : null
}
