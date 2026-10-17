#!/usr/bin/env node
// Writes the project's guard file (<root>/.claude/smartworkbench.json) only if it still has the content the caller saw.
//   node desktop-policy-write.mjs <projectRoot> <expectedSha256|none>      the new text on stdin
// The path is built here from the root, so this can write nothing else. The file is checked, a temporary file in the same folder is
// written, the file is checked again and the temporary file is renamed over it. A plain compare-and-swap does not exist on a file system:
// what is left is the time between the second check and the rename, not the time of a question to the person.
// Exit codes: 0 written (the new sha256 on stdout), 2 bad input, 3 the file changed, 4 a path that is not plain, 5 I/O error.
import { createHash, randomBytes } from 'node:crypto'
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const MAX_BYTES = 256 * 1024
const sha = text => createHash('sha256').update(text).digest('hex')

class Exit extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

// The file as it is now: null when there is none, else its text and mode. A link or anything not a plain file is refused.
function current(file) {
  let info
  try {
    info = lstatSync(file)
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
  if (info.isSymbolicLink() || !info.isFile()) throw new Exit(4, 'the guard file is not a plain file')
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const opened = fstatSync(fd)
    if (!opened.isFile()) throw new Exit(4, 'the guard file is not a plain file')
    return { text: readFileSync(fd, 'utf8'), mode: opened.mode & 0o7777 }
  } finally {
    closeSync(fd)
  }
}

// The engine's read may drop a BOM or carriage returns; the caller's hash is of what it read, so those readings count too.
const matches = (now, expected) => {
  if (now === null) return expected === 'none'
  return [now.text, now.text.replace(/^﻿/, ''), now.text.replace(/\r/g, ''), now.text.replace(/^﻿/, '').replace(/\r/g, '')].some(one => sha(one) === expected)
}

/** Writes `text` over the guard file of `root` when it still hashes to `expected` ('none' = no file). Returns the new hash or throws Exit. */
export function writePolicy(root, expected, text) {
  if (typeof root !== 'string' || !isAbsolute(root)) throw new Exit(2, 'the root must be an absolute path')
  if (expected !== 'none' && !/^[0-9a-f]{64}$/.test(expected ?? '')) throw new Exit(2, 'bad hash')
  if (Buffer.byteLength(text) > MAX_BYTES) throw new Exit(2, 'too big')
  try {
    JSON.parse(text.replace(/^﻿/, ''))
  } catch {
    throw new Exit(2, 'not JSON')
  }
  let info
  try {
    info = statSync(root)
  } catch {
    throw new Exit(4, 'no such project folder')
  }
  if (!info.isDirectory()) throw new Exit(4, 'the project root is not a folder')

  const dir = join(root, '.claude')
  const file = join(dir, 'smartworkbench.json')
  try {
    const dirInfo = lstatSync(dir)
    if (dirInfo.isSymbolicLink() || !dirInfo.isDirectory()) throw new Exit(4, '.claude is not a plain folder')
  } catch (error) {
    if (error instanceof Exit) throw error
    if (error.code !== 'ENOENT') throw error
    if (expected !== 'none') throw new Exit(3, 'the file is gone')
    mkdirSync(dir)
  }

  // A run that was killed leaves its temporary file; the ones older than a minute are removed.
  try {
    for (const name of readdirSync(dir)) {
      if (!/^\.smartworkbench\.json\.\d+\.[0-9a-f]{12}\.tmp$/.test(name)) continue
      const old = lstatSync(join(dir, name))
      if (old.isFile() && Date.now() - old.mtimeMs > 60 * 1000) unlinkSync(join(dir, name))
    }
  } catch {
    // Only tidying.
  }
  const before = current(file)
  if (!matches(before, expected)) throw new Exit(3, 'the file changed')
  const tmp = join(dir, `.smartworkbench.json.${process.pid}.${randomBytes(6).toString('hex')}.tmp`)
  let made = false
  try {
    const fd = openSync(tmp, 'wx', 0o644)
    made = true
    try {
      writeSync(fd, text)
      if (before) fchmodSync(fd, before.mode)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    if (!matches(current(file), expected)) throw new Exit(3, 'the file changed')
    // .claude must still be the plain folder under the root (it could have been swapped for a link since the first look).
    if (lstatSync(dir).isSymbolicLink() || realpathSync(dir) !== join(realpathSync(root), '.claude')) throw new Exit(4, '.claude is not a plain folder')
    for (let attempt = 0; ; attempt += 1) {
      try {
        renameSync(tmp, file)
        made = false
        break
      } catch (error) {
        // Windows refuses a rename over a file another program holds open for a moment.
        if (attempt < 3 && (error.code === 'EPERM' || error.code === 'EBUSY')) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
          continue
        }
        throw error
      }
    }
  } finally {
    if (made) {
      try {
        unlinkSync(tmp)
      } catch {
        // Nothing to remove.
      }
    }
  }
  return sha(text)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const hash = writePolicy(process.argv[2], process.argv[3], readFileSync(0, 'utf8'))
    process.stdout.write(`${hash}\n`)
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    process.exit(error instanceof Exit ? error.code : 5)
  }
}
