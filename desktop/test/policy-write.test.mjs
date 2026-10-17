import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const script = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'tools', 'desktop-policy-write.mjs')
const sha = text => createHash('sha256').update(text).digest('hex')
const run = (root, expected, stdin) => spawnSync(process.execPath, [script, root, expected], { input: stdin, encoding: 'utf8' })
const project = () => mkdtempSync(join(tmpdir(), 'swb-pw-'))
const withFile = text => {
  const root = project()
  mkdirSync(join(root, '.claude'))
  writeFileSync(join(root, '.claude', 'smartworkbench.json'), text)
  return root
}
const target = root => join(root, '.claude', 'smartworkbench.json')
const noTemp = root => assert.deepEqual(readdirSync(join(root, '.claude')).filter(name => name.endsWith('.tmp')), [])

test('with no file and no folder, "none" creates both and prints the new hash', () => {
  const root = project()
  const out = run(root, 'none', '{"rules":[]}\n')
  assert.equal(out.status, 0, out.stderr)
  assert.equal(out.stdout.trim(), sha('{"rules":[]}\n'))
  assert.equal(readFileSync(target(root), 'utf8'), '{"rules":[]}\n')
  noTemp(root)
})

test('a file that is not what the caller saw is left alone (exit 3), whether the caller expected none or another content', () => {
  const root = withFile('{"rules":[]}')
  for (const expected of ['none', 'a'.repeat(64)]) {
    assert.equal(run(root, expected, '{"rules":[1]}').status, 3)
    assert.equal(readFileSync(target(root), 'utf8'), '{"rules":[]}')
  }
  assert.equal(run(project(), 'a'.repeat(64), '{}').status, 3)
  noTemp(root)
})

test('the right hash writes, keeps the file mode, and also matches a reading without BOM or carriage returns', { skip: process.platform === 'win32' }, () => {
  const root = withFile('{"rules":[]}')
  chmodSync(target(root), 0o600)
  assert.equal(run(root, sha('{"rules":[]}'), '{"rules":[{"policy":"ask","tool":"Bash"}]}').status, 0)
  assert.match(readFileSync(target(root), 'utf8'), /"ask"/)
  assert.equal(statSync(target(root)).mode & 0o777, 0o600)
  const bom = withFile('﻿{"a":1}\r\n')
  assert.equal(run(bom, sha('{"a":1}\n'), '{"a":2}').status, 0)
  noTemp(root)
  noTemp(bom)
})

test('a link in place of the file or the folder is refused (exit 4) and nothing behind it is written', { skip: process.platform === 'win32' }, () => {
  const root = project()
  const elsewhere = join(project(), 'victim.json')
  writeFileSync(elsewhere, '{}')
  mkdirSync(join(root, '.claude'))
  symlinkSync(elsewhere, target(root))
  assert.equal(run(root, sha('{}'), '{"x":1}').status, 4)
  assert.equal(readFileSync(elsewhere, 'utf8'), '{}')
  const other = project()
  const realDir = project()
  symlinkSync(realDir, join(other, '.claude'))
  assert.equal(run(other, 'none', '{}').status, 4)
  assert.equal(existsSync(join(realDir, 'smartworkbench.json')), false)
})

test('bad input is refused (exit 2): a relative root, a bad hash, text that is not JSON, text that is too big', () => {
  const root = project()
  assert.equal(run('relative/dir', 'none', '{}').status, 2)
  assert.equal(run(root, 'xyz', '{}').status, 2)
  assert.equal(run(root, 'none', '{ nope').status, 2)
  assert.equal(run(root, 'none', JSON.stringify({ pad: 'x'.repeat(300 * 1024) })).status, 2)
  assert.equal(existsSync(join(root, '.claude')), false)
})

test('a file that is gone when a hash was expected is stale, and CRLF files match a reading with LF', () => {
  const root = project()
  assert.equal(run(root, 'a'.repeat(64), '{}').status, 3)
  const crlf = withFile('{\r\n  "a": 1\r\n}\r\n')
  assert.equal(run(crlf, sha('{\n  "a": 1\n}\n'), '{"a":2}').status, 0)
})

test('a leftover temporary file older than a minute is removed, a fresh one is not', () => {
  const root = withFile('{}')
  const old = join(root, '.claude', '.smartworkbench.json.1.aaaaaaaaaaaa.tmp')
  const fresh = join(root, '.claude', '.smartworkbench.json.2.bbbbbbbbbbbb.tmp')
  writeFileSync(old, 'x')
  writeFileSync(fresh, 'x')
  const past = new Date(Date.now() - 5 * 60 * 1000)
  utimesSync(old, past, past)
  assert.equal(run(root, sha('{}'), '{"a":1}').status, 0)
  assert.equal(existsSync(old), false)
  assert.equal(existsSync(fresh), true)
})
