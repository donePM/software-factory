// Two packages, one root lockfile, and a vendored package in node_modules.
export const nodeMonorepo: Record<string, string> = {
  'pnpm-lock.yaml': '',
  'web/package.json': '{"name":"web"}',
  'web/tsconfig.json': '{}',
  'api/package.json': '{"name":"api"}',
  'api/yarn.lock': '',
  'node_modules/dep/package.json': '{"name":"dep"}',
  'web/node_modules/x/package.json': '{"name":"x"}',
}
