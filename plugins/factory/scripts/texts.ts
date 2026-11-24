// Writes tests/generated/texts.ts from the agent, skill, and pipeline files.
// With --check, it writes nothing and exits 1 when the file is not up to date.
// Run: node plugins/factory/scripts/texts.ts [--check]
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { renderTexts, TEXTS_MODULE } from '../lib/texts.ts'

const dir = join(import.meta.dirname, '..')
const file = join(dir, TEXTS_MODULE)
const text = await renderTexts({ list: async p => readdirSync(p), read: async p => readFileSync(p, 'utf8') }, dir)
if (!process.argv.includes('--check')) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text)
} else if (!existsSync(file) || readFileSync(file, 'utf8') !== text) {
  console.error(`${file} differs from the agent, skill, and pipeline files. Run node plugins/factory/scripts/texts.ts and commit the file.`)
  process.exit(1)
}
