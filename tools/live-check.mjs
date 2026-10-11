#!/usr/bin/env node
// Smoke test for tools/live.mjs using only node built-ins: node tools/live-check.mjs
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { get } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const server = join(dirname(fileURLToPath(import.meta.url)), 'live.mjs')
const dir = mkdtempSync(join(tmpdir(), 'swb-live-'))
const feed = join(dir, '.claude', 'smartworkbench-live.jsonl')
const port = 20000 + Math.floor(Math.random() * 20000)
const sleep = ms => new Promise(done => setTimeout(done, ms))
let failed = 0
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`)
  if (!ok) failed++
}

function launch(at = port, where = dir) {
  const child = spawn('node', [server, where, '--port', String(at)], { stdio: ['ignore', 'pipe', 'pipe'] })
  const out = { stdout: '', stderr: '', code: undefined }
  child.stdout.on('data', chunk => (out.stdout += chunk))
  child.stderr.on('data', chunk => (out.stderr += chunk))
  child.on('exit', code => (out.code = code ?? -1))
  return { child, out }
}

// Stays connected to /events and collects every data line that arrives.
function follow() {
  const lines = []
  const req = get({ host: '127.0.0.1', port, path: '/events', headers: { host: `127.0.0.1:${port}` } }, res => {
    res.on('data', chunk => lines.push(...String(chunk).split('\n').filter(one => one.startsWith('data: '))))
  })
  req.on('error', () => undefined)
  return { lines, close: () => req.destroy() }
}

function headerOf(path, name) {
  return new Promise(done => {
    const req = get({ host: '127.0.0.1', port, path, headers: { host: `127.0.0.1:${port}` } }, res => {
      done(res.headers[name])
      res.resume()
    })
    req.on('error', () => done(undefined))
  })
}

function request(path, host) {
  return new Promise(done => {
    const req = get({ host: '127.0.0.1', port, path, headers: { host } }, res => {
      let body = ''
      res.on('data', chunk => {
        body += chunk
        if (path === '/events' && body.split('data: ').length > 2) req.destroy()
      })
      res.on('end', () => done({ status: res.statusCode, body }))
      res.on('close', () => done({ status: res.statusCode, body }))
    })
    req.on('error', () => undefined)
    setTimeout(() => {
      req.destroy()
      done({ status: 0, body: '' })
    }, 1500)
  })
}

try {
  const first = launch()
  for (let i = 0; i < 40 && !first.out.stdout.includes('SmartWorkbench live:'); i++) await sleep(100)
  check(first.out.stdout.includes('SmartWorkbench live:'), 'starts and prints its address')
  check(existsSync(feed), 'creates the feed after listening')

  appendFileSync(feed, '{"kind":"a"}\n{"kind":"b"}\n')
  await sleep(400)
  const events = await request('/events', `127.0.0.1:${port}`)
  check(events.body.split('data: ').length === 3, 'replays each appended line once')
  check((await request('/', `evil.test:${port}`)).status === 403, 'refuses a foreign Host header')
  check((await request('/', `127.0.0.1:${port}`)).status === 200, 'serves the page on a loopback Host')
  check(await headerOf('/', 'content-security-policy').then(value => value?.includes("default-src 'none'")), 'sends a content security policy with the page')

  const second = launch()
  for (let i = 0; i < 40 && second.out.code === undefined; i++) await sleep(100)
  check(second.out.code === 1 && second.out.stderr.includes('EADDRINUSE'), 'a second start on the same port exits 1 with EADDRINUSE')
  check(existsSync(feed), 'a failed second start leaves the running feed in place')

  const watcher = follow()
  await sleep(300)
  const before = watcher.lines.length
  appendFileSync(feed, '{"kind":"c"}\n')
  await sleep(500)
  check(watcher.lines.length === before + 1 && watcher.lines.at(-1) === 'data: {"kind":"c"}', 'a connected page gets a new line exactly once')
  watcher.close()

  rmSync(feed)
  await sleep(400)
  check(first.out.code === undefined, 'survives the feed file vanishing')

  appendFileSync(feed, '')
  first.child.kill('SIGTERM')
  for (let i = 0; i < 20 && first.out.code === undefined; i++) await sleep(100)
  check(!existsSync(feed), 'removes the feed on exit')

  for (const signal of ['SIGINT', 'SIGHUP']) {
    const otherDir = mkdtempSync(join(tmpdir(), 'swb-live-'))
    const otherFeed = join(otherDir, '.claude', 'smartworkbench-live.jsonl')
    const other = launch(port + 1, otherDir)
    for (let i = 0; i < 40 && !other.out.stdout.includes('SmartWorkbench live:'); i++) await sleep(100)
    other.child.kill(signal)
    for (let i = 0; i < 20 && other.out.code === undefined; i++) await sleep(100)
    check(other.out.code !== undefined && !existsSync(otherFeed), `${signal} ends the server and removes its feed`)
    rmSync(otherDir, { recursive: true, force: true })
  }
} finally {
  rmSync(dir, { recursive: true, force: true })
}
process.exit(failed === 0 ? 0 : 1)
