// The hub: one server on one port that shows every registered session as its own tab.
// It is a process of its own (started detached by the first session) and ends when no session is left.
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ID_PATTERN, ensureRegistry, feedOf, registryDir, scan, trustedHosts } from './live-registry.mjs'
import { makeTail } from './live-tail.mjs'

const page = join(dirname(fileURLToPath(import.meta.url)), 'live.html')
// 2: a registration may carry a feed id, the session's own feed. A version 1 hub still serves sessions that share the project's feed.
export const HUB_VERSION = 2

// The page is one file with inline script and style and talks only to this server; anything else it is tricked into loading is refused.
const CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

export function runHub({ port }) {
  const STALE_MS = Number(process.env.SWB_LIVE_STALE_MS) || 20000
  const IDLE_MS = Number(process.env.SWB_LIVE_IDLE_MS) || 30000
  const MAX_SESSIONS = Number(process.env.SWB_LIVE_MAX_SESSIONS) || 16
  const PING_MS = Number(process.env.SWB_LIVE_PING_MS) || 15000
  // A page that cannot be served is cut off the oldest first: EventSource does not retry after a refusal, so refusing would strand a page for good.
  const MAX_CLIENTS = 64
  const REPLAY_BYTES = 6 * 1024 * 1024
  const startedAt = Date.now()
  const dir = (() => {
    try {
      return ensureRegistry(port, { create: true })
    } catch (err) {
      console.error(`Registry unusable: ${err.message}`)
      process.exit(1)
    }
  })()

  const TRUSTED = trustedHosts()
  const HOSTS = new Set([`127.0.0.1:${port}`, `localhost:${port}`, ...TRUSTED.flatMap(name => [name, `${name}:80`, `${name}:443`])])

  /** @type {Map<string, any>} */
  const sessions = new Map()
  const everyone = new Set()
  let over = 0
  let idleSince = Date.now()
  let lastScanAt = Date.now()
  let listSignature = ''
  // A page that falls behind is cut off (it reconnects and replays) instead of letting the hub's memory grow.
  const send = (res, text) => {
    if (res.writableLength > 8 * 1024 * 1024) res.destroy()
    else res.write(text)
  }
  const sessionRow = one => ({ id: one.id, name: (basename(one.reg.project) || one.reg.project) + (one.reg.feedId ? ` · ${one.reg.feedId.slice(0, 8)}` : ''), project: one.reg.project, startedAt: one.reg.startedAt, alive: one.alive, quiet: one.quiet === true, linesRead: one.tail.linesRead, badLines: one.tail.badLines, kept: one.tail.recent.length, lastAt: one.tail.lastAt })
  const listText = () => `event: sessions\ndata: ${JSON.stringify({ sessions: [...sessions.values()].map(sessionRow), over })}\n\n`
  const frame = (id, line) => `event: line\ndata: {"s":"${id}","e":${line}}\n\n`

  function adopt(found) {
    const seen = new Set(found.map(one => one.id))
    over = 0
    for (const one of found) {
      const known = sessions.get(one.id)
      if (known && known.reg.pid === one.reg.pid && known.reg.startedAt === one.reg.startedAt) {
        known.alive = one.alive
        known.quiet = one.quiet
        continue
      }
      if (!one.alive) continue
      if (!known && [...sessions.values()].filter(other => other.alive).length >= MAX_SESSIONS) {
        over++
        continue
      }
      if (known) sessions.delete(one.id)
      const own = { id: one.id, reg: one.reg, alive: one.alive, quiet: one.quiet, clients: new Set(), goneAt: 0, tail: undefined }
      own.tail = makeTail(feedOf(one.reg.project, one.reg.feedId), {
        readMax: 1024 * 1024,
        onLine: line => {
          for (const res of own.clients) send(res, `data: ${line}\n\n`)
          if (everyone.size) {
            const text = frame(own.id, line)
            for (const res of everyone) send(res, text)
          }
        },
      })
      sessions.set(one.id, own)
    }
    for (const own of sessions.values()) {
      if (!seen.has(own.id) || (!own.alive && !own.quiet)) {
        own.alive = false
        own.quiet = false
        own.goneAt ||= Date.now()
      } else own.goneAt = 0
    }
    // A finished session's tab stays for a while so its last lines can still be read.
    for (const [id, own] of sessions) if (!own.alive && !own.quiet && Date.now() - own.goneAt > 10 * 60 * 1000) sessions.delete(id)
    const signature = JSON.stringify([...sessions.values()].map(own => [own.id, own.alive, own.quiet === true, own.reg.startedAt]))
    if (signature !== listSignature) {
      listSignature = signature
      const text = listText()
      for (const res of everyone) send(res, text)
    }
  }

  function look() {
    const now = Date.now()
    // The timer itself was late: the machine slept, so every heartbeat looks old and none of them means a session is gone.
    const slept = now - lastScanAt > 10000
    lastScanAt = now
    try {
      ensureRegistry(port, { create: false })
      adopt(scan(dir, { staleMs: STALE_MS, ignoreStale: slept, now }))
    } catch {
      adopt([])
    }
    if ([...sessions.values()].some(own => own.alive || own.quiet)) idleSince = now
    else if (now - idleSince > IDLE_MS) stop()
  }

  const scanner = setInterval(look, 1000)
  const pumper = setInterval(() => {
    // Only a live session is read: a finished one's feed path may now belong to another session of the same project.
    for (const own of sessions.values()) if (own.alive) own.tail.pump()
  }, 150)
  const pinger = setInterval(() => {
    for (const res of everyone) send(res, ': ping\n\n')
    for (const own of sessions.values()) for (const res of own.clients) send(res, ': ping\n\n')
  }, PING_MS)

  const evict = set => {
    if (set.size >= MAX_CLIENTS) set.values().next().value?.destroy()
  }
  const stream = res => res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' })

  const server = createServer((req, res) => {
    if (!HOSTS.has((req.headers.host ?? '').toLowerCase())) {
      res.writeHead(403).end()
      return
    }
    if (req.method !== 'GET') {
      res.writeHead(405, { allow: 'GET' }).end()
      return
    }
    const url = new URL(req.url ?? '/', 'http://x')
    const wanted = url.searchParams.get('session')
    const own = wanted !== null && ID_PATTERN.test(wanted) ? sessions.get(wanted) : undefined
    if (url.pathname === '/events') {
      if (url.searchParams.get('all') === '1') {
        evict(everyone)
        stream(res)
        res.write(': connected\n\n')
        look()
        res.write(listText())
        const ordered = [...sessions.values()].sort((a, b) => a.reg.startedAt - b.reg.startedAt)
        for (const one of ordered) {
          if (one.alive) one.tail.pump()
          // Every session gets an equal share of the replay, newest lines first, so one connection never queues more than the limit below.
          const share = Math.floor(REPLAY_BYTES / ordered.length)
          let used = 0
          let from = one.tail.recent.length
          while (from > 0 && used + one.tail.recent[from - 1].length <= share) used += one.tail.recent[--from].length
          for (const line of one.tail.recent.slice(from)) res.write(frame(one.id, line))
        }
        // The page counts only what arrives after this as new.
        res.write('event: ready\ndata: {}\n\n')
        everyone.add(res)
        res.on('close', () => everyone.delete(res))
        return
      }
      if (!own) {
        res.writeHead(404).end()
        return
      }
      evict(own.clients)
      stream(res)
      res.write(': connected\n\n')
      if (own.alive) own.tail.pump()
      for (const line of own.tail.recent) res.write(`data: ${line}\n\n`)
      own.clients.add(res)
      res.on('close', () => own.clients.delete(res))
      return
    }
    if (url.pathname === '/sessions') {
      look()
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ sessions: [...sessions.values()].map(sessionRow), over }))
      return
    }
    if (url.pathname === '/info') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      if (wanted !== null) {
        // The same shape the single-project server answers with: the page compares what it received with what was read.
        if (!own) {
          res.end(JSON.stringify({ missing: true }))
          return
        }
        res.end(JSON.stringify({ project: own.reg.project, feed: feedOf(own.reg.project, own.reg.feedId), pid: process.pid, startedAt, linesRead: own.tail.linesRead, badLines: own.tail.badLines, kept: own.tail.recent.length, clients: own.clients.size }))
        return
      }
      res.end(JSON.stringify({ hub: 'smartworkbench', v: HUB_VERSION, pid: process.pid, port, startedAt, registry: registryDir(port), host: hostname(), hosts: TRUSTED, sessions: sessions.size, clients: everyone.size }))
      return
    }
    if (url.pathname === '/') {
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
    clearInterval(scanner)
    clearInterval(pumper)
    clearInterval(pinger)
    for (const res of everyone) res.destroy()
    server.close()
    process.exit(0)
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  process.on('SIGHUP', stop)

  server.on('error', err => {
    // Another hub won the race for this port: that one serves, this one has nothing to do.
    if (err.code === 'EADDRINUSE') process.exit(0)
    console.error(`Cannot listen on 127.0.0.1:${port}: ${err.code ?? err.message}`)
    process.exit(1)
  })
  server.listen(port, '127.0.0.1', () => {
    look()
  })
}
