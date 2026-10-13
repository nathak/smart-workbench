// Where sessions announce themselves to the hub, and how the hub decides whom to believe.
// A registration names a project; the hub computes the feed path itself and reads it only if the project vouches for it.
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

import { readPlain } from './live-tail.mjs'

export const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/
export const feedOf = project => join(project, '.claude', 'smartworkbench-live.jsonl')
export const noteOf = project => join(project, '.claude', 'smartworkbench-live.pid')

// The names a hub answers to besides loopback; one hub serves every session on its port, so sessions must agree on them.
export const trustedHosts = () => (process.env.SWB_LIVE_HOSTS ?? '').split(',').map(one => one.trim().toLowerCase()).filter(Boolean).sort()

export function registryRoot() {
  return process.env.SWB_LIVE_HOME || join(homedir(), '.claude', 'smartworkbench-live')
}

export const registryDir = port => join(registryRoot(), String(port))

// A directory only this user can write, and not a link: anyone who can plant a file here could name a project for the hub to read.
function checkDir(path) {
  const info = lstatSync(path, { throwIfNoEntry: false })
  if (!info || !info.isDirectory() || info.isSymbolicLink()) throw new Error(`${path} is not a plain directory`)
  if (process.platform !== 'win32' && typeof process.getuid === 'function' && (info.uid !== process.getuid() || (info.mode & 0o077) !== 0)) throw new Error(`${path} must belong to you and be closed to others (mode 700)`)
}

export function ensureRegistry(port, { create }) {
  const dir = registryDir(port)
  if (create) mkdirSync(dir, { recursive: true, mode: 0o700 })
  checkDir(registryRoot())
  checkDir(dir)
  return dir
}

// ---- the project's own feed and process note: made fresh, never through a link, one owner at a time ----

// Throws with a message for the user; returns once this process owns the feed and the note.
export function claimFeed(project, ownPid) {
  const feed = feedOf(project)
  const pidFile = noteOf(project)
  mkdirSync(join(project, '.claude'), { recursive: true })
  // One view per project: a second one would empty the feed the first one is reading.
  if (existsSync(pidFile)) {
    const [host, pid] = readFileSync(pidFile, 'utf8').trim().split(/\s+/)
    if (host === hostname() && /^\d+$/.test(pid ?? '') && Number(pid) !== ownPid) {
      let alive = false
      try {
        process.kill(Number(pid), 0)
        alive = true
      } catch (err) {
        alive = err?.code === 'EPERM'
      }
      if (alive) throw Object.assign(new Error(`A live view already runs for this project (process ${pid}); stop it first.`), { code: 'RUNNING' })
    }
  }
  // The feed is made fresh and only if it is a plain file: a link in its place (a checked-in one) would be followed and emptied or appended to.
  const found = lstatSync(feed, { throwIfNoEntry: false })
  if (found && !found.isFile()) throw Object.assign(new Error('not a regular file'), { code: 'EINVAL' })
  if (found) rmSync(feed)
  closeSync(openSync(feed, 'wx'))
  // The process note gets the same care as the feed: never written through a link.
  const note = lstatSync(pidFile, { throwIfNoEntry: false })
  if (note && !note.isFile()) throw Object.assign(new Error('not a regular file'), { code: 'EINVAL' })
  if (note) rmSync(pidFile)
  const noteFd = openSync(pidFile, 'wx')
  try {
    writeFileSync(noteFd, `${hostname()} ${ownPid}`)
  } finally {
    closeSync(noteFd)
  }
}

export function releaseFeed(project) {
  rmSync(feedOf(project), { force: true })
  rmSync(noteOf(project), { force: true })
}

// ---- registrations ----

const sleepSync = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

// Written whole and moved into place, so the hub never reads half a file. Returns the id actually used.
export function register(dir, entry) {
  let id = ID_PATTERN.test(entry.id) ? entry.id : `p${entry.pid}`
  const existing = readOne(dir, id)
  if (existing && existing.pid !== entry.pid && sameHostAlive(existing)) id = `${id}-${entry.pid}`.slice(0, 64)
  writeEntry(dir, { ...entry, id })
  return id
}

function writeEntry(dir, entry) {
  const target = join(dir, `${entry.id}.json`)
  const staging = `${target}.${process.pid}.tmp`
  const fd = openSync(staging, 'wx', 0o600)
  try {
    writeFileSync(fd, JSON.stringify({ v: 1, ...entry }))
  } finally {
    closeSync(fd)
  }
  // Windows refuses a rename onto a file another process has open for a moment.
  for (let tries = 0; ; tries++) {
    try {
      renameSync(staging, target)
      return
    } catch (err) {
      if (tries >= 3) {
        rmSync(staging, { force: true })
        throw err
      }
      sleepSync(50)
    }
  }
}

// The heartbeat is the file's modification time; a file that went missing (cleaned up while the machine slept) is written again.
export function beat(dir, entry) {
  const target = join(dir, `${entry.id}.json`)
  const info = lstatSync(target, { throwIfNoEntry: false })
  if (info?.isFile()) {
    const now = new Date()
    utimesSync(target, now, now)
  } else if (!info) {
    writeEntry(dir, entry)
  }
}

// Removes the registration only if it is this process's own.
export function unregister(dir, entry) {
  const mine = readOne(dir, entry.id)
  if (mine && mine.pid === entry.pid) rmSync(join(dir, `${entry.id}.json`), { force: true })
}

function readOne(dir, id) {
  try {
    const target = join(dir, `${id}.json`)
    const info = lstatSync(target, { throwIfNoEntry: false })
    if (!info?.isFile() || info.size > 4096) return undefined
    const parsed = JSON.parse(readFileSync(target, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : undefined
  } catch {
    return undefined
  }
}

export function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err?.code === 'EPERM'
  }
}

const sameHostAlive = entry => entry.host === hostname() && Number.isInteger(entry.pid) && pidAlive(entry.pid)

// The project must have a real .claude folder (not a link to somewhere else), its process note must name this very session,
// and a feed that is a link would be read through to wherever it points. The joiner runs the same check before it reports success.
export function projectOk(reg) {
  try {
    if (realpathSync(join(reg.project, '.claude')) !== join(realpathSync(reg.project), '.claude')) return false
    if (readPlain(noteOf(reg.project), 200)?.trim() !== `${reg.host} ${reg.pid}`) return false
    const feedInfo = lstatSync(feedOf(reg.project), { throwIfNoEntry: false })
    return !feedInfo || feedInfo.isFile()
  } catch {
    return false
  }
}

// Every registration the hub may act on. A file that breaks any rule is ignored: it could be a plant.
// `ignoreStale`: the machine just woke from sleep, so heartbeats are old for everyone and say nothing.
export function scan(dir, { staleMs, ignoreStale = false, now = Date.now() }) {
  const found = []
  let names = []
  try {
    names = readdirSync(dir).filter(name => /^[A-Za-z0-9_-]{1,64}\.json$/.test(name)).slice(0, 64)
  } catch {
    return found
  }
  for (const name of names) {
    const file = join(dir, name)
    try {
      const info = lstatSync(file)
      if (!info.isFile() || info.size > 4096) continue
      const reg = JSON.parse(readFileSync(file, 'utf8'))
      const id = name.slice(0, -5)
      if (!reg || typeof reg !== 'object' || reg.v !== 1 || reg.id !== id) continue
      if (typeof reg.project !== 'string' || reg.project.includes('\0') || !isAbsolute(reg.project) || resolve(reg.project) !== reg.project) continue
      if (typeof reg.host !== 'string' || !Number.isInteger(reg.pid) || reg.pid < 1) continue
      if (!projectOk(reg)) continue
      const local = reg.host === hostname()
      const alive = local && pidAlive(reg.pid)
      // A process that is gone on this machine leaves a file that is only clutter.
      if (local && !alive) {
        rmSync(file, { force: true })
        continue
      }
      found.push({ id, reg, file, alive: alive && (ignoreStale || now - info.mtimeMs < staleMs) })
    } catch {
      // Unreadable, half written or not ours: skipped until it is valid.
    }
  }
  return found
}
