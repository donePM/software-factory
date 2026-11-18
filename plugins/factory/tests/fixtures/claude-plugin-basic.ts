// A repo with one plugin that has a tsconfig and tests.
export const pluginBasic: Record<string, string> = {
  'plugins/factory/.claude-plugin/plugin.json': '{"name":"factory"}',
  'plugins/factory/tsconfig.json': '{}',
  'plugins/factory/hooks/register.tsx': '',
  'plugins/factory/tests/a.test.ts': '',
}
