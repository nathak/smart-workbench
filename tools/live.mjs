#!/usr/bin/env node
// SmartWorkbench live view: tails .claude/smartworkbench-live.jsonl of a project and streams it to a web page.
// Usage: node live.mjs [projectDir] [--port 4317] [--auto] [--watch-parent]
// --auto: when the port is taken (another session's view), the next free one is used, up to 20 further.
//        node live.mjs [projectDir] --join [--session <id>] [--port 4317] [--auto] [--watch-parent]
// --hub --keep: a hub that stays up with no session.
// --join: share one hub on the port with the other sessions (each is a tab); --hub is the server process that join starts.
// The plugin writes the feed only while this file exists, so stopping the server (which removes it) stops the writes.
import { createServer } from 'node:http'
import { lstatSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { runHub } from './live-hub.mjs'
import { runJoin } from './live-join.mjs'
import { claimFeed, feedOf, noteOf, releaseFeed } from './live-registry.mjs'
import { makeTail } from './live-tail.mjs'

const args = process.argv.slice(2)
const portAt = args.indexOf('--port')
let port = portAt >= 0 ? Number(args[portAt + 1]) : 4317
const auto = args.includes('--auto')
const LAST_TRY = port + 20
const sessionAt = args.indexOf('--session')
const project = resolve(args.find((one, i) => !one.startsWith('--') && args[i - 1] !== '--port' && args[i - 1] !== '--session') ?? process.cwd())
const feed = feedOf(project)
// Names this process, so the plugin can tell a feed left behind by a killed server from one a running view keeps.
const pidFile = noteOf(project)
const page = join(dirname(fileURLToPath(import.meta.url)), 'live.html')

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('Invalid --port')
  process.exit(1)
}
if (args.includes('--hub')) {
  // --keep: the hub never ends for lack of sessions (the desktop app supervises it).
  runHub({ port, keep: args.includes('--keep'), watchParent: args.includes('--watch-parent') })
} else if (args.includes('--join')) {
  if (args.includes('--per-session') && !/^[A-Za-z0-9_-]{1,64}$/.test(sessionAt >= 0 ? (args[sessionAt + 1] ?? '') : '')) {
    console.error('--per-session needs a valid --session id')
    process.exit(1)
  }
  await runJoin({ project, port, auto, session: sessionAt >= 0 ? (args[sessionAt + 1] ?? '') : '', perSession: args.includes('--per-session'), watchParent: args.includes('--watch-parent') })
} else {
  runSolo()
}

function runSolo() {
// Set once this process owns the feed; only the owner removes it, so a failed second start never deletes a running one's file.
let created = false

const clients = new Set()
const startedAt = Date.now()
const tail = makeTail(feed, {
  onLine: line => {
    for (const res of clients) res.write(`data: ${line}\n\n`)
  },
})
const timer = setInterval(tail.pump, 150)

// A comment line now and then keeps an idle stream from being closed by a proxy's read timeout (often 60 s) and shows a dead client early.
const PING_MS = Number(process.env.SWB_LIVE_PING_MS) || 15000
// A session that ends without stopping its child (a crash, a kill on Windows, where signals do not reach node) must not leave a server and a feed behind.
// Only when the plugin started it (--watch-parent): a view started by hand and left running in the background keeps running.
const parent = process.ppid
if (args.includes('--watch-parent')) {
  const watcher = setInterval(() => {
    try {
      process.kill(parent, 0)
    } catch {
      stop()
    }
  }, 2000)
  watcher.unref?.()
}
const pinger = setInterval(() => {
  for (const res of clients) res.write(': ping\n\n')
}, PING_MS)

// A page on another site can point its own hostname at 127.0.0.1 (DNS rebinding) and read the feed;
// only a loopback Host header or a named host the owner trusts (a reverse proxy in front of this server) is served.
const TRUSTED = (process.env.SWB_LIVE_HOSTS ?? '').split(',').map(one => one.trim().toLowerCase()).filter(Boolean)
const HOSTS = new Set(TRUSTED.flatMap(name => [name, `${name}:80`, `${name}:443`]))

// The page is one file with inline script and style and talks only to this server; anything else it is tricked into loading is refused.
const CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

const server = createServer((req, res) => {
  if (!HOSTS.has((req.headers.host ?? '').toLowerCase())) {
    res.writeHead(403).end()
    return
  }
  const path = new URL(req.url ?? '/', 'http://x').pathname
  if (path === '/events') {
    // no-transform and x-accel-buffering keep a reverse proxy (nginx, a CDN) from holding the stream back or recompressing it.
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' })
    res.write(': connected\n\n')
    tail.pump()
    for (const line of tail.recent) res.write(`data: ${line}\n\n`)
    clients.add(res)
    res.on('close', () => clients.delete(res))
    return
  }
  if (path === '/info') {
    // Where the feed is and how much this server has read: the page compares it with what it received.
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify({ project, feed, pid: process.pid, startedAt, linesRead: tail.linesRead, badLines: tail.badLines, kept: tail.recent.length, clients: clients.size, feedSize: lstatSync(feed, { throwIfNoEntry: false })?.size ?? null }))
    return
  }
  if (path === '/') {
    try {
      const html = readFileSync(page)
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': CSP, 'x-content-type-options': 'nosniff' })
      res.end(html)
    } catch {
      res.writeHead(500).end()
    }
    return
  }
  res.writeHead(404).end()
})

function stop() {
  clearInterval(timer)
  clearInterval(pinger)
  server.close()
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
process.on('SIGHUP', stop)
process.on('exit', () => {
  if (created) releaseFeed(project)
})

// Not "SmartWorkbench live:" — the plugin reads that prefix as a successful start.
server.on('error', err => {
  // Another session's view holds this port: the next one is tried (the project's own feed decides which view is whose, not the port).
  if (auto && err.code === 'EADDRINUSE' && port < LAST_TRY && port < 65535) {
    port++
    listen()
    return
  }
  console.error(`Cannot listen on 127.0.0.1:${port}: ${err.code ?? err.message}`)
  process.exit(1)
})

// Local only: the feed holds prompts and commands.
function listen() {
  server.listen(port, '127.0.0.1', onListening)
}

function onListening() {
  HOSTS.add(`127.0.0.1:${port}`)
  HOSTS.add(`localhost:${port}`)
  try {
    claimFeed(project, process.pid)
    created = true
  } catch (err) {
    console.error(err.code === 'RUNNING' ? err.message : `Cannot create ${feed}: ${err.code ?? err.message}`)
    process.exit(1)
  }
  console.log(`SmartWorkbench live: http://127.0.0.1:${port}  (project ${project})`)
  console.log('Ctrl+C stops the view and the feed.')
}

listen()
}
