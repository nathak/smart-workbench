#!/usr/bin/env node
// SmartWorkbench live view: tails .claude/smartworkbench-live.jsonl of a project and streams it to a web page.
// Usage: node live.mjs [projectDir] [--port 4317]
// The plugin writes the feed only while this file exists, so stopping the server (which removes it) stops the writes.
import { createServer } from 'node:http'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const portAt = args.indexOf('--port')
const port = portAt >= 0 ? Number(args[portAt + 1]) : 4317
const project = resolve(args.find((one, i) => !one.startsWith('--') && args[i - 1] !== '--port') ?? process.cwd())
const feed = join(project, '.claude', 'smartworkbench-live.jsonl')
const page = join(dirname(fileURLToPath(import.meta.url)), 'live.html')

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('Invalid --port')
  process.exit(1)
}

mkdirSync(dirname(feed), { recursive: true })
writeFileSync(feed, '')

const clients = new Set()
let offset = 0
let rest = ''

function pump() {
  if (!existsSync(feed)) return
  const size = statSync(feed).size
  if (size < offset) {
    offset = 0
    rest = ''
  }
  if (size === offset) return
  const fd = openSync(feed, 'r')
  const buffer = Buffer.alloc(size - offset)
  readSync(fd, buffer, 0, buffer.length, offset)
  closeSync(fd)
  offset = size
  const lines = (rest + buffer.toString('utf8')).split('\n')
  rest = lines.pop() ?? ''
  for (const line of lines.filter(Boolean)) {
    for (const res of clients) res.write(`data: ${line}\n\n`)
  }
}
const timer = setInterval(pump, 150)

// A page on another site can point its own hostname at 127.0.0.1 (DNS rebinding) and read the feed;
// only a loopback Host header is served.
const HOSTS = new Set([`127.0.0.1:${port}`, `localhost:${port}`])

const server = createServer((req, res) => {
  if (!HOSTS.has((req.headers.host ?? '').toLowerCase())) {
    res.writeHead(403).end()
    return
  }
  if (req.url === '/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
    res.write(': connected\n\n')
    for (const line of readFileSync(feed, 'utf8').split('\n').filter(Boolean)) res.write(`data: ${line}\n\n`)
    clients.add(res)
    req.on('close', () => clients.delete(res))
    return
  }
  if (req.url === '/' || req.url?.startsWith('/?')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(readFileSync(page))
    return
  }
  res.writeHead(404).end()
})

function stop() {
  clearInterval(timer)
  rmSync(feed, { force: true })
  server.close()
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)

// Local only: the feed holds prompts and commands.
server.listen(port, '127.0.0.1', () => {
  console.log(`SmartWorkbench live: http://127.0.0.1:${port}  (project ${project})`)
  console.log('Ctrl+C stops the view and the feed.')
})
