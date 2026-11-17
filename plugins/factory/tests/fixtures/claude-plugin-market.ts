import { pluginBasic } from './claude-plugin-basic.ts'

// This repo's layout: a marketplace at the root that lists the plugin.
export const pluginMarket: Record<string, string> = {
  ...pluginBasic,
  '.claude-plugin/marketplace.json': '{"name":"m"}',
  'README.md': '',
}
