// Factory agents have no GitHub access: only the tools talk to GitHub, and only the tools push.
// A best-effort word match, not a sandbox: a command can still hide `gh` (sh -c "$(…)", another language).
// A quote can open or close a command (bash -c "git push"). A quoted git argument counts as one argument, so a commit message that names push is not a push.
const START = String.raw`(?:^|[\s;&|()\x60/'"])`
const END = String.raw`(?=$|[\s;&|()\x60'"])`
const GH = new RegExp(`${START}gh${END}`)
const PUSH = new RegExp(`${START}git(?:\\s(?:"[^"]*"|'[^']*'|[^;&|\\n'"])*)?\\spush${END}`)

export const reachesGitHub = (command: string): boolean => GH.test(command) || PUSH.test(command)

export const DENY_GITHUB = 'Factory agents have no GitHub access: do not run gh or git push. The factory tools push and talk to GitHub.'

type Agent = { id: string; type: string }

// Denies only for a subagent that is a factory agent, or that the agent list does not name.
export async function guardBash(agentId: string | undefined, command: unknown, list: () => Promise<Agent[]>): Promise<string | null> {
  if (agentId === undefined || typeof command !== 'string' || !reachesGitHub(command)) return null
  const agent = (await list()).find(a => a.id === agentId)
  return agent === undefined || agent.type.startsWith('factory:') ? DENY_GITHUB : null
}
