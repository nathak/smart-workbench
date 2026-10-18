// The app's side of the channel with the plugin: a heartbeat file in ~/.claude/smartworkbench-desktop/ that tells running sessions
// where the hub is and what the app takes over. The plugin reads it with tools/desktop-state.mjs and trusts it only while it is fresh.
import { randomBytes } from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'

import { ID_RE, checkOps, sign } from '../tools/desktop-channel.mjs'

export const desktopHome = (env = process.env) => env.SWB_DESKTOP_HOME || join(homedir(), '.claude', 'smartworkbench-desktop')

/** Creates the directory (owner only) and refuses one that is a link or belongs to someone else. */
export function ensureHome(home = desktopHome()) {
  mkdirSync(home, { recursive: true, mode: 0o700 })
  const info = lstatSync(home)
  if (!info.isDirectory()) throw new Error('the desktop directory is a link or not a directory')
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) throw new Error('the desktop directory belongs to someone else')
  if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) chmodSync(home, 0o700)
  return home
}

/** One heartbeat: written whole to a temporary file and renamed, so a reader never sees half of it. */
export function beat(home, state) {
  const file = join(home, 'desktop.json')
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify({ v: 1, pid: process.pid, host: hostname(), port: state.port, autoJoin: state.autoJoin === true, livePrompts: state.livePrompts !== false, askNotify: state.askNotify === 'desktop' ? 'desktop' : 'plugin' }), { mode: 0o600 })
  renameSync(tmp, file)
}

/** Removes the heartbeat, so sessions stop joining a hub nobody keeps. */
export function clear(home) {
  rmSync(join(home, 'desktop.json'), { force: true })
}

/** The signing key: created once, owner only. Only this app and the plugin's channel script ever read it. */
export function ensureKey(home) {
  const file = join(home, 'key')
  try {
    const info = lstatSync(file)
    if (info.isFile() && info.size === 32) return readFileSync(file)
    // A key that is not whole (a write cut short) or not a plain file is replaced; commands signed with it were never valid.
    rmSync(file, { force: true })
  } catch {
    // No key yet.
  }
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, randomBytes(32), { mode: 0o600, flag: 'w' })
  renameSync(tmp, file)
  return readFileSync(file)
}

const COMMAND_TTL_MS = 10 * 60 * 1000

/**
 * Writes one signed command for a session into its inbox. The ops are checked here with the same rules the plugin applies,
 * and the file is written whole (temporary file, then rename) so the plugin never reads half of it.
 */
export function sendCommand(home, key, sessionId, ops, now = Date.now(), id = randomBytes(12).toString('base64url'), ttlMs = COMMAND_TTL_MS) {
  if (typeof sessionId !== 'string' || !ID_RE.test(sessionId)) return { ok: false, reason: 'bad session' }
  const checked = checkOps(ops)
  if (checked.reason) return { ok: false, reason: checked.reason }
  const body = { v: 1, id, createdAt: now, expiresAt: now + ttlMs, target: { kind: 'session', sessionId }, ops: checked.ops }
  const command = { ...body, mac: sign(key, body) }
  const dir = join(home, 'inbox', sessionId)
  mkdirSync(join(home, 'inbox'), { recursive: true, mode: 0o700 })
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const file = join(dir, `${id}.json`)
  const tmp = join(dir, `${id}.tmp`)
  writeFileSync(tmp, JSON.stringify(command), { mode: 0o600, flag: 'wx' })
  renameSync(tmp, file)
  return { ok: true, id }
}

/** The result the plugin left for a command, or undefined while it is still waiting. */
export function readAck(home, id) {
  try {
    if (!ID_RE.test(id)) return undefined
    const file = join(home, 'ack', `${id}.json`)
    const info = lstatSync(file)
    if (!info.isFile() || info.size > 1024) return undefined
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    return ['applied', 'rejected', 'declined'].includes(raw.status) ? { status: raw.status, reason: typeof raw.reason === 'string' ? raw.reason : undefined } : undefined
  } catch {
    return undefined
  }
}

/** Removes commands nobody took and results nobody needs any more. */
export function tidy(home, now = Date.now()) {
  for (const sub of ['ack', 'inbox']) {
    const dir = join(home, sub)
    let names = []
    try {
      names = readdirSync(dir)
    } catch {
      continue
    }
    for (const name of names) {
      try {
        const path = join(dir, name)
        if (sub === 'inbox') {
          for (const file of readdirSync(path)) if (now - lstatSync(join(path, file)).mtimeMs > 3600 * 1000) rmSync(join(path, file), { force: true })
        } else if (now - lstatSync(path).mtimeMs > 24 * 3600 * 1000) rmSync(path, { force: true })
      } catch {
        // Skipped; tried again next time.
      }
    }
  }
}
