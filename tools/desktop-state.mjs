#!/usr/bin/env node
// Prints the desktop app's heartbeat file as one JSON line when the app is running, nothing otherwise.
// The app rewrites ~/.claude/smartworkbench-desktop/desktop.json every few seconds; a file older than FRESH_MS is a dead app's.
import { lstatSync, readFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

export const FRESH_MS = 30000
export const desktopHome = () => process.env.SWB_DESKTOP_HOME || join(homedir(), '.claude', 'smartworkbench-desktop')

/** The app's state, or undefined when there is no app, the file is stale, a link, too big or malformed. */
export function readDesktop(home = desktopHome(), now = Date.now()) {
  try {
    if (!lstatSync(home).isDirectory()) return undefined
    const file = join(home, 'desktop.json')
    const info = lstatSync(file)
    if (!info.isFile() || info.size > 4096 || now - info.mtimeMs > FRESH_MS) return undefined
    if (typeof process.getuid === 'function' && info.uid !== process.getuid()) return undefined
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    // A crashed app leaves a fresh-looking file behind for up to FRESH_MS: its process must still run (on this machine).
    if (raw.host !== undefined && raw.host !== hostname()) return undefined
    if (Number.isInteger(raw.pid)) {
      try {
        process.kill(raw.pid, 0)
      } catch (error) {
        if (error?.code !== 'EPERM') return undefined
      }
    }
    const port = Number(raw.port)
    if (raw.v !== 1 || !Number.isInteger(port) || port < 1024 || port > 65535) return undefined
    return { port, autoJoin: raw.autoJoin === true, livePrompts: raw.livePrompts !== false, askNotify: raw.askNotify === 'desktop' ? 'desktop' : 'plugin' }
  } catch {
    return undefined
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const state = readDesktop()
  if (state) process.stdout.write(JSON.stringify(state))
}
