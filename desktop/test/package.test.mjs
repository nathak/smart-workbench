import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const config = readFileSync(join(root, 'electron-builder.yml'), 'utf8')

test('the packaged app lists every module the main process loads, and the page, preload and tools it needs', () => {
  const seen = new Set()
  const walk = file => {
    if (seen.has(file)) return
    seen.add(file)
    for (const match of readFileSync(join(root, file), 'utf8').matchAll(/from '\.\/([\w-]+\.mjs)'/g)) walk(match[1])
  }
  walk('main.mjs')
  assert.ok(seen.size >= 8)
  for (const file of seen) assert.ok(config.includes(`  - ${file}\n`), `${file} is missing from electron-builder.yml files`)
  assert.ok(config.includes('  - preload.cjs') && config.includes('  - ui/**'))
  assert.ok(config.includes('live*.mjs') && config.includes('live.html') && config.includes('desktop-*.mjs'))
  // The tools the app imports from the repository are the ones shipped beside it.
  assert.match(readFileSync(join(root, 'channel.mjs'), 'utf8'), /\.\.\/tools\/desktop-channel\.mjs/)
})
