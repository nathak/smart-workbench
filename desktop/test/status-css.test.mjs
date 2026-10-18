import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'ui', 'status.css'), 'utf8')

const luminance = hex => {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const ratio = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}
// The :root block is the dark theme; the block in the light media query overrides it.
const tokens = block => Object.fromEntries([...block.matchAll(/--([\w-]+):\s*(#[0-9A-Fa-f]{6})/g)].map(([, name, value]) => [name, value]))
const dark = tokens(css.slice(0, css.indexOf('@media')))
const light = { ...dark, ...tokens(css.slice(css.indexOf('@media')).split('}')[0]) }

for (const [name, theme] of [['dark', dark], ['light', light]]) {
  test(`${name} theme: control borders reach 3:1 and muted text 4.5:1 on the surfaces they sit on`, () => {
    for (const ground of ['surface', 'canvas']) {
      assert.ok(ratio(theme['control-line'], theme[ground]) >= 3, `control-line on ${ground}`)
      assert.ok(ratio(theme.muted, theme[ground]) >= 4.5, `muted on ${ground}`)
    }
  })
}
