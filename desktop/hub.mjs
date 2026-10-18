// Keeps the monitor hub (tools/live.mjs --hub --keep) running as a child of the app, and finds the tools to run it from.
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const DEFAULT_PORT = 4317
const here = dirname(fileURLToPath(import.meta.url))

/** Directories that may hold tools/live.mjs, best first: an explicit one, the installed plugin, the copy bundled with the app. */
export function toolCandidates({ env = process.env, home = homedir(), resources = process.resourcesPath } = {}) {
  const found = []
  if (env.SWB_TOOLS) found.push(env.SWB_TOOLS)
  try {
    const list = JSON.parse(readFileSync(join(env.CLAUDE_CONFIG_DIR || join(home, '.claude'), 'plugins', 'installed_plugins.json'), 'utf8'))
    for (const [key, entries] of Object.entries(list.plugins ?? {})) {
      if (!/^smartworkbench@/.test(key) || !Array.isArray(entries)) continue
      for (const one of entries) if (typeof one?.installPath === 'string') found.push(join(one.installPath, 'tools'))
    }
  } catch {
    // No plugin list: the bundled copy is used.
  }
  if (resources) found.push(join(resources, 'tools'))
  found.push(join(here, '..', 'tools'))
  return found
}

/** The first candidate that has a hub able to stay up with no session (--keep). */
export function pickTools(candidates = toolCandidates()) {
  for (const dir of candidates) {
    try {
      if (existsSync(join(dir, 'live.mjs')) && /keep = false/.test(readFileSync(join(dir, 'live-hub.mjs'), 'utf8'))) return dir
    } catch {
      // Try the next one.
    }
  }
  return undefined
}

/** The hub's /info, or undefined when nothing that answers like one listens on the port. */
export async function probe(port, fetchImpl = fetch) {
  try {
    const res = await fetchImpl(`http://127.0.0.1:${port}/info`, { signal: AbortSignal.timeout(1500) })
    const info = await res.json()
    return info?.hub === 'smartworkbench' ? info : undefined
  } catch {
    return undefined
  }
}

/**
 * Starts the hub when none answers on the port and starts it again after it dies. `spawnImpl` and `probeImpl` are for tests.
 * The child is not detached: it ends with the app.
 */
export function superviseHub({ port = DEFAULT_PORT, tools = pickTools(), spawnImpl = spawn, probeImpl = probe, everyMs = 5000, onState = () => {} } = {}) {
  let child
  let stopped = false
  let state = 'starting'
  const set = next => {
    if (next !== state) onState((state = next))
  }

  async function check() {
    if (stopped) return
    const info = await probeImpl(port)
    if (stopped) return
    if (info) return set('up')
    if (child && child.exitCode === null && !child.killed) return set('starting')
    if (!tools) return set('no-tools')
    set('starting')
    child = spawnImpl(process.execPath, [join(tools, 'live.mjs'), '--hub', '--keep', '--watch-parent', '--approve', '--port', String(port)], {
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    })
    child.on('error', () => {})
  }

  void check()
  const timer = setInterval(() => void check(), everyMs)
  return {
    get state() {
      return state
    },
    port,
    stop() {
      stopped = true
      clearInterval(timer)
      if (child && child.exitCode === null) child.kill()
    },
  }
}
