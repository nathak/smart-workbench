// The app's side of the channel with the plugin: a heartbeat file in ~/.claude/smartworkbench-desktop/ that tells running sessions
// where the hub is and what the app takes over. The plugin reads it with tools/desktop-state.mjs and trusts it only while it is fresh.
import { chmodSync, lstatSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'

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
