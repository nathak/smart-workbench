// A session's side of the shared view: owns the project's feed, registers with the hub on a port, keeps it alive,
// starts the hub (detached) when none runs and starts it again if it disappears. Ending this process leaves the view.
import { spawn } from 'node:child_process'
import { get } from 'node:http'
import { hostname } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { HUB_VERSION } from './live-hub.mjs'
import { beat, claimFeed, ensureRegistry, register, registryDir, registryRoot, releaseFeed, unregister } from './live-registry.mjs'

const sleep = ms => new Promise(done => setTimeout(done, ms))
const same = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b)

// What answers on a port: our hub of this registry, something else, or nothing.
function probe(port) {
  return new Promise(done => {
    const req = get({ host: '127.0.0.1', port, path: '/info', headers: { host: `127.0.0.1:${port}` }, timeout: 1500 }, res => {
      let text = ''
      res.on('data', chunk => {
        if (text.length < 8192) text += chunk
      })
      res.on('end', () => {
        try {
          const info = JSON.parse(text)
          if (info?.hub === 'smartworkbench' && info.v === HUB_VERSION && typeof info.registry === 'string' && same(info.registry, registryDir(port))) done({ kind: 'hub' })
          else done({ kind: 'other' })
        } catch {
          done({ kind: 'other' })
        }
      })
    })
    req.on('timeout', () => {
      req.destroy()
      done({ kind: 'other' })
    })
    req.on('error', err => done({ kind: err.code === 'ECONNREFUSED' ? 'none' : 'other' }))
  })
}

function startHub(port) {
  const here = resolve(dirname(fileURLToPath(import.meta.url)), 'live.mjs')
  // Detached and with no pipes: the hub must outlive this process and the session that started it.
  spawn(process.execPath, [here, '--hub', '--port', String(port)], { detached: true, stdio: 'ignore', windowsHide: true, cwd: registryRoot() }).unref()
}

export async function runJoin({ project, port, auto, session, watchParent }) {
  const lastTry = auto ? Math.min(port + 20, 65535) : port
  const beatMs = Number(process.env.SWB_LIVE_BEAT_MS) || 5000
  let claimed = false
  let entry
  let dir = ''
  let chosen = 0
  const timers = []

  const leave = () => {
    for (const timer of timers) clearInterval(timer)
    try {
      if (entry && dir) unregister(dir, entry)
    } catch {
      // Nothing to clean up if the registry is gone.
    }
    if (claimed) releaseFeed(project)
    claimed = false
  }
  const quit = () => {
    leave()
    process.exit(0)
  }
  process.on('exit', leave)
  process.on('SIGINT', quit)
  process.on('SIGTERM', quit)
  process.on('SIGHUP', quit)

  try {
    claimFeed(project, process.pid)
    claimed = true
  } catch (err) {
    console.error(err.code === 'RUNNING' ? err.message : `Cannot create the live feed in ${project}: ${err.code ?? err.message}`)
    process.exit(1)
  }

  entry = { id: session, project, host: hostname(), pid: process.pid, parent: process.ppid, startedAt: Date.now() }
  for (let at = port; at <= lastTry && !chosen; at++) {
    let found = await probe(at)
    if (found.kind === 'none') {
      try {
        dir = ensureRegistry(at, { create: true })
        entry.id = register(dir, entry)
      } catch (err) {
        console.error(`Cannot use the live registry: ${err.message}`)
        process.exit(1)
      }
      startHub(at)
      for (let i = 0; i < 40 && found.kind !== 'hub'; i++) {
        await sleep(200)
        found = await probe(at)
      }
      if (found.kind !== 'hub') {
        unregister(dir, entry)
        continue
      }
      chosen = at
    } else if (found.kind === 'hub') {
      try {
        dir = ensureRegistry(at, { create: true })
        entry.id = register(dir, entry)
      } catch (err) {
        console.error(`Cannot use the live registry: ${err.message}`)
        process.exit(1)
      }
      chosen = at
    } else if (!auto) {
      console.error(`Cannot listen on 127.0.0.1:${at}: EADDRINUSE (port used by another program)`)
      process.exit(1)
    }
  }
  if (!chosen) {
    console.error(`No port from ${port} to ${lastTry} could serve the live view (EADDRINUSE or the hub did not start).`)
    process.exit(1)
  }

  timers.push(
    setInterval(() => {
      try {
        beat(dir, entry)
      } catch {
        // The next beat tries again.
      }
    }, beatMs),
    // A hub that vanished (killed, or taken down with a closed session on Windows) is started again; the bind decides which of several starters wins.
    setInterval(() => {
      void probe(chosen).then(found => {
        if (found.kind === 'none') startHub(chosen)
      })
    }, beatMs * 2),
  )

  // A session that ends without stopping its child (a crash, a hard kill on Windows) must not leave a registration behind: it expires by its heartbeat, and this watcher covers a plain exit.
  if (watchParent) {
    const parent = process.ppid
    setInterval(() => {
      try {
        process.kill(parent, 0)
      } catch {
        quit()
      }
    }, 2000).unref?.()
  }

  console.log(`SmartWorkbench live: http://127.0.0.1:${chosen}/#s=${entry.id}  (project ${project})`)
  console.log('Ctrl+C leaves the view; it stays up while other sessions use it.')
}
