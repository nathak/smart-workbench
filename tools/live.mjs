#!/usr/bin/env node
// SmartWorkbench live view: tails .claude/smartworkbench-live.jsonl of a project and streams it to a web page.
// Usage: node live.mjs [projectDir] [--port 4317]
// The plugin writes the feed only while this file exists, so stopping the server (which removes it) stops the writes.
import { createServer } from 'node:http'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const portAt = args.indexOf('--port')
const port = portAt >= 0 ? Number(args[portAt + 1]) : 4317
const project = resolve(args.find((one, i) => !one.startsWith('--') && args[i - 1] !== '--port') ?? process.cwd())
const feed = join(project, '.claude', 'smartworkbench-live.jsonl')
// Names this process, so the plugin can tell a feed left behind by a killed server from one a running view keeps.
const pidFile = join(project, '.claude', 'smartworkbench-live.pid')
const page = join(dirname(fileURLToPath(import.meta.url)), 'live.html')

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('Invalid --port')
  process.exit(1)
}

// Set once this process owns the feed; only the owner removes it, so a failed second start never deletes a running one's file.
let created = false

const clients = new Set()
// The newest lines are kept in memory and replayed to a new connection, so the file can grow without every page load re-reading it.
const RECENT_MAX = 2000
const recent = []
// The feed file is emptied in place (tee appends, so a rename would drop lines) once it is read to the end past this size.
const FEED_CAP = 8 * 1024 * 1024
let offset = 0
let rest = ''
// What this server has read, so the page can tell whether it received all of it.
let linesRead = 0
const startedAt = Date.now()

function pump() {
  try {
    if (!existsSync(feed)) return
    const size = statSync(feed).size
    if (size < offset) {
      offset = 0
      rest = ''
    }
    if (size === offset) return
    const fd = openSync(feed, 'r')
    const buffer = Buffer.alloc(size - offset)
    try {
      readSync(fd, buffer, 0, buffer.length, offset)
    } finally {
      closeSync(fd)
    }
    offset = size
    const lines = (rest + buffer.toString('utf8')).split('\n')
    rest = lines.pop() ?? ''
    for (const line of lines.filter(Boolean)) {
      linesRead++
      recent.push(line)
      if (recent.length > RECENT_MAX) recent.shift()
      for (const res of clients) res.write(`data: ${line}\n\n`)
    }
    // Everything is read and no line is half written: a line the plugin appends in these few instructions is lost, which the live view tolerates.
    if (offset > FEED_CAP && rest === '' && statSync(feed).size === offset) {
      truncateSync(feed, 0)
      offset = 0
    }
  } catch {
    // The file vanished or is mid-write; the next tick tries again.
  }
}
const timer = setInterval(pump, 150)

// A comment line now and then keeps an idle stream from being closed by a proxy's read timeout (often 60 s) and shows a dead client early.
const PING_MS = Number(process.env.SWB_LIVE_PING_MS) || 15000
const pinger = setInterval(() => {
  for (const res of clients) res.write(': ping\n\n')
}, PING_MS)

// A page on another site can point its own hostname at 127.0.0.1 (DNS rebinding) and read the feed;
// only a loopback Host header or a named host the owner trusts (a reverse proxy in front of this server) is served.
const TRUSTED = (process.env.SWB_LIVE_HOSTS ?? '').split(',').map(one => one.trim().toLowerCase()).filter(Boolean)
const HOSTS = new Set([`127.0.0.1:${port}`, `localhost:${port}`, ...TRUSTED.flatMap(name => [name, `${name}:80`, `${name}:443`])])

// The page is one file with inline script and style and talks only to this server; anything else it is tricked into loading is refused.
const CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'"

const server = createServer((req, res) => {
  if (!HOSTS.has((req.headers.host ?? '').toLowerCase())) {
    res.writeHead(403).end()
    return
  }
  if (req.url === '/events') {
    // no-transform and x-accel-buffering keep a reverse proxy (nginx, a CDN) from holding the stream back or recompressing it.
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' })
    res.write(': connected\n\n')
    pump()
    for (const line of recent) res.write(`data: ${line}\n\n`)
    clients.add(res)
    res.on('close', () => clients.delete(res))
    return
  }
  if (req.url === '/info') {
    // Where the feed is and how much this server has read: the page compares it with what it received.
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify({ project, feed, pid: process.pid, startedAt, linesRead, kept: recent.length, clients: clients.size, feedSize: existsSync(feed) ? statSync(feed).size : null }))
    return
  }
  if (req.url === '/' || req.url?.startsWith('/?')) {
    try {
      const html = readFileSync(page)
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': CSP })
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
  if (created) {
    rmSync(feed, { force: true })
    rmSync(pidFile, { force: true })
  }
})

// Not "SmartWorkbench live:" — the plugin reads that prefix as a successful start.
server.on('error', err => {
  console.error(`Cannot listen on 127.0.0.1:${port}: ${err.code ?? err.message}`)
  process.exit(1)
})

// Local only: the feed holds prompts and commands.
server.listen(port, '127.0.0.1', () => {
  try {
    mkdirSync(dirname(feed), { recursive: true })
    writeFileSync(feed, '')
    created = true
    writeFileSync(pidFile, `${hostname()} ${process.pid}`)
  } catch (err) {
    console.error(`Cannot create ${feed}: ${err.code ?? err.message}`)
    process.exit(1)
  }
  console.log(`SmartWorkbench live: http://127.0.0.1:${port}  (project ${project})`)
  console.log('Ctrl+C stops the view and the feed.')
})
