#!/usr/bin/env node
// Writes one session's read-only snapshot for the desktop app: node desktop-snapshot.mjs <sessionId>, the snapshot JSON on stdin.
// Only while the app's heartbeat is fresh, only into the app's own directory, whole and private (temporary file, then rename).
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { desktopHome, readDesktop } from './desktop-state.mjs'

const MAX_BYTES = 64 * 1024
const id = process.argv[2] ?? ''
if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) process.exit(2)
const home = desktopHome()
if (!readDesktop(home)) process.exit(0)
const text = readFileSync(0, 'utf8')
if (Buffer.byteLength(text) > MAX_BYTES) process.exit(3)
try {
  const parsed = JSON.parse(text)
  if (parsed?.v !== 1 || parsed.session !== id) process.exit(4)
  const dir = join(home, 'state')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const info = lstatSync(dir)
  if (!info.isDirectory() || (typeof process.getuid === 'function' && info.uid !== process.getuid())) process.exit(5)
  if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) chmodSync(dir, 0o700)
  const file = join(dir, `${id}.json`)
  const tmp = `${file}.${process.pid}.tmp`
  try {
    writeFileSync(tmp, text, { mode: 0o600, flag: 'wx' })
    renameSync(tmp, file)
  } catch (error) {
    try {
      unlinkSync(tmp)
    } catch {
      // Nothing was left to remove.
    }
    throw error
  }
} catch {
  process.exit(1)
}
