// A session's side of the shared view: owns the project's feed, registers with the hub on a port, keeps it alive,
// starts the hub (detached) when none runs and starts it again if it disappears. Ending this process leaves the view.
import { spawn } from 'node:child_process'
import { get } from 'node:http'
import { hostname } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { HUB_VERSION } from './live-hub.mjs'
import { beat, claimFeed, ensureRegistry, projectOk, register, registryDir, registryRoot, releaseFeed, sweepFeeds, trustedHosts, unregister } from './live-registry.mjs'

const sleep = ms => new Promise(done => setTimeout(done, ms))
const same = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b)

// What answers on a port: our hub of this registry, something else, or nothing.
function probe(port, feedId) {
  return new Promise(done => {
    const req = get({ host: '127.0.0.1', port, path: '/info', headers: { host: `127.0.0.1:${port}` }, timeout: 1500 }, res => {
      let text = ''
      res.on('data', chunk => {
        if (text.length < 8192) text += chunk
      })
      res.on('end', () => {
        try {
          const info = JSON.parse(text)
          if (info?.hub === 'smartworkbench' && (info.v === HUB_VERSION || (!feedId && info.v === 1)) && typeof info.registry === 'string' && same(info.registry, registryDir(port))) {
            // One hub answers to one list of names; a session with another list would have its prompts served under names it never agreed to.
            if (JSON.stringify(info.hosts ?? []) === JSON.stringify(trustedHosts())) done({ kind: 'hub' })
            else done({ kind: 'other', why: 'SWB_LIVE_HOSTS differs from the one the running view was started with; end the other sessions on this port (the view ends about 30 s after the last one) or use another port' })
          } else done({ kind: 'other' })
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

export async function runJoin({ project, port, auto, session, watchParent, perSession = false }) {
  // A session that keeps its own feed is named by its id; the id also names the files.
  const feedId = perSession ? session : undefined
  const lastTry = auto ? Math.min(port + 20, 65535) : port
  const beatMs = Number(process.env.SWB_LIVE_BEAT_MS) || 5000
  let claimed = false
  let reason = ''
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
    if (claimed) releaseFeed(project, feedId)
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
    claimFeed(project, process.pid, feedId)
    claimed = true
    try {
      if (feedId) sweepFeeds(project, feedId)
    } catch {
      // Clutter left by others is not a reason to refuse the view.
    }
  } catch (err) {
    console.error(err.code === 'RUNNING' ? err.message : `Cannot create the live feed in ${project}: ${err.code ?? err.message}`)
    process.exit(1)
  }

  entry = { id: session, project, host: hostname(), pid: process.pid, parent: process.ppid, startedAt: Date.now(), ...(feedId ? { feedId } : {}) }
  // The registration is checked the way the hub will check it: a project it would ignore must not be reported as started.
  if (!projectOk(entry)) {
    console.error(`The live view cannot show ${project}: its .claude folder or feed is a link, or the process note is missing.`)
    process.exit(1)
  }
  for (let at = port; at <= lastTry && !chosen; at++) {
    const found = await probe(at, feedId)
    if (found.kind === 'other') {
      reason = found.why ?? reason
      if (!auto) {
        console.error(found.why ? `Port ${at}: ${found.why}` : `Cannot listen on 127.0.0.1:${at}: EADDRINUSE (port used by another program)`)
        process.exit(1)
      }
      continue
    }
    try {
      dir = ensureRegistry(at, { create: true })
      entry.id = register(dir, entry)
    } catch (err) {
      console.error(`Cannot use the live registry: ${err.message}`)
      process.exit(1)
    }
    // A hub that is about to end for lack of sessions may still answer: it must answer twice, a moment apart, with this session registered.
    let steady = false
    for (let i = 0; i < 40 && !steady; i++) {
      const now = await probe(at, feedId)
      if (now.kind === 'none') startHub(at)
      else if (now.kind === 'hub') {
        await sleep(400)
        steady = (await probe(at, feedId)).kind === 'hub'
        continue
      }
      await sleep(200)
    }
    if (steady) chosen = at
    else unregister(dir, entry)
  }
  if (!chosen) {
    console.error(`No port from ${port} to ${lastTry} could serve the live view${reason ? ` (${reason})` : ' (in use by another program, or the hub did not start)'}.`)
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
      void probe(chosen, feedId).then(found => {
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
