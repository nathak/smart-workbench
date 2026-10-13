#!/usr/bin/env node
// Smoke test for tools/live.mjs using only node built-ins: node tools/live-check.mjs
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { get } from 'node:http'
import { hostname, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const server = join(dirname(fileURLToPath(import.meta.url)), 'live.mjs')
const dir = mkdtempSync(join(tmpdir(), 'swb-live-'))
const feed = join(dir, '.claude', 'smartworkbench-live.jsonl')
const port = 20000 + Math.floor(Math.random() * 20000)
const sleep = ms => new Promise(done => setTimeout(done, ms))
process.env.SWB_LIVE_PING_MS = '200'
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
  const raw = { text: '' }
  const req = get({ host: '127.0.0.1', port, path: '/events', headers: { host: `127.0.0.1:${port}` } }, res => {
    res.on('data', chunk => (raw.text += chunk))
    res.on('data', chunk => lines.push(...String(chunk).split('\n').filter(one => one.startsWith('data: '))))
  })
  req.on('error', () => undefined)
  return { lines, raw, close: () => req.destroy() }
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

let first
try {
  first = launch()
  for (let i = 0; i < 40 && !first.out.stdout.includes('SmartWorkbench live:'); i++) await sleep(100)
  check(first.out.stdout.includes('SmartWorkbench live:'), 'starts and prints its address')
  check(existsSync(feed), 'creates the feed after listening')
  check(readFileSync(join(dir, '.claude', 'smartworkbench-live.pid'), 'utf8') === `${hostname()} ${first.child.pid}`, 'names its host and process beside the feed')

  appendFileSync(feed, '{"kind":"a"}\n{"kind":"b"}\n')
  await sleep(400)
  const events = await request('/events', `127.0.0.1:${port}`)
  check(events.body.split('data: ').length === 3, 'replays each appended line once')
  check((await request('/', `evil.test:${port}`)).status === 403, 'refuses a foreign Host header')
  check((await request('/', `127.0.0.1:${port}`)).status === 200, 'serves the page on a loopback Host')
  const info = JSON.parse((await request('/info', `127.0.0.1:${port}`)).body || '{}')
  check(info.pid > 0 && typeof info.linesRead === 'number' && typeof info.startedAt === 'number' && typeof info.feed === 'string' && info.feed.endsWith('smartworkbench-live.jsonl') && (await request('/info', `evil.test:${port}`)).status === 403, 'reports where the feed is and how many lines it read, and only to a trusted Host')
  check(await headerOf('/', 'content-security-policy').then(value => value?.includes("default-src 'none'")), 'sends a content security policy with the page')

  const second = launch()
  for (let i = 0; i < 40 && second.out.code === undefined; i++) await sleep(100)
  check(second.out.code === 1 && second.out.stderr.includes('EADDRINUSE'), 'a second start on the same port exits 1 with EADDRINUSE')
  check(existsSync(feed), 'a failed second start leaves the running feed in place')

  check((await headerOf('/events', 'x-accel-buffering')) === 'no', 'the stream tells a proxy not to buffer it')
  const idle = follow()
  await sleep(700)
  check(idle.raw.text.includes(': ping'), 'an idle stream gets a keep-alive comment')
  idle.close()

  const watcher = follow()
  await sleep(300)
  const before = watcher.lines.length
  appendFileSync(feed, '{"kind":"c"}\n')
  await sleep(500)
  check(watcher.lines.length === before + 1 && watcher.lines.at(-1) === 'data: {"kind":"c"}', 'a connected page gets a new line exactly once')
  watcher.close()

  // Past the cap the file is emptied once read, and a later line still arrives exactly once.
  appendFileSync(feed, '{"kind":"pad"}\n'.repeat(600000))
  await sleep(2500)
  check(statSync(feed).size === 0, 'empties the feed once it passes the cap')
  const afterCap = follow()
  await sleep(300)
  const seen = afterCap.lines.length
  appendFileSync(feed, '{"kind":"d"}\n')
  await sleep(500)
  check(afterCap.lines.length === seen + 1 && afterCap.lines.at(-1) === 'data: {"kind":"d"}', 'a line after the cap arrives exactly once')
  afterCap.close()

  // A character that is only half written (Korean is three bytes) is decoded once it is whole, and lines that are not JSON are dropped and counted.
  const text = follow()
  await sleep(300)
  const korean = Buffer.from('{"kind":"ko","t":"가나다"}\n')
  appendFileSync(feed, korean.subarray(0, 19))
  await sleep(500)
  appendFileSync(feed, korean.subarray(19))
  appendFileSync(feed, 'this is not json\n{"kind":"after-bad"}\n')
  await sleep(600)
  check(text.lines.filter(one => one === 'data: {"kind":"ko","t":"가나다"}').length === 1, 'a line written in two parts, split inside a Korean character, arrives whole and once')
  check(text.lines.some(one => one.includes('after-bad')) && !text.lines.some(one => one.includes('not json')), 'a line that is not JSON is dropped and the next one still arrives')
  const info2 = JSON.parse((await request('/info', `127.0.0.1:${port}`)).body || '{}')
  check(info2.badLines >= 1, 'the dropped line is counted in /info')
  text.close()

  // The file deleted and made again is read from its start, not from the old position.
  rmSync(feed)
  await sleep(500)
  const again = follow()
  await sleep(300)
  appendFileSync(feed, '{"kind":"reborn"}\n')
  await sleep(600)
  check(again.lines.some(one => one.includes('reborn')), 'a feed that was deleted and made again is read from the start')
  again.close()

  rmSync(feed)
  await sleep(400)
  check(first.out.code === undefined, 'survives the feed file vanishing')

  appendFileSync(feed, '')
  first.child.kill('SIGTERM')
  for (let i = 0; i < 20 && first.out.code === undefined; i++) await sleep(100)
  check(!existsSync(feed) && !existsSync(join(dir, '.claude', 'smartworkbench-live.pid')), 'removes the feed and the process note on exit')

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

  // A feed that is a link (one a repository could ship) is refused, and what it points at is left alone.
  const linkDir = mkdtempSync(join(tmpdir(), 'swb-live-'))
  mkdirSync(join(linkDir, '.claude'))
  const victim = join(linkDir, 'victim.txt')
  writeFileSync(victim, 'keep me')
  symlinkSync(victim, join(linkDir, '.claude', 'smartworkbench-live.jsonl'))
  const linked = launch(port + 2, linkDir)
  for (let i = 0; i < 30 && linked.out.code === undefined; i++) await sleep(100)
  check(linked.out.code === 1 && readFileSync(victim, 'utf8') === 'keep me', 'a feed that is a link is refused and its target is not emptied')
  rmSync(linkDir, { recursive: true, force: true })

  // A second server for the same project is refused instead of emptying the feed the first one reads.
  const crowded = mkdtempSync(join(tmpdir(), 'swb-live-'))
  const one = launch(port + 3, crowded)
  for (let i = 0; i < 40 && !one.out.stdout.includes('SmartWorkbench live:'); i++) await sleep(100)
  appendFileSync(join(crowded, '.claude', 'smartworkbench-live.jsonl'), '{"kind":"keep"}\n')
  const two = launch(port + 4, crowded)
  for (let i = 0; i < 30 && two.out.code === undefined; i++) await sleep(100)
  check(two.out.code === 1 && two.out.stderr.includes('already runs') && readFileSync(join(crowded, '.claude', 'smartworkbench-live.jsonl'), 'utf8').includes('keep'), 'a second view for the same project is refused and the feed is kept')
  one.child.kill('SIGTERM')
  rmSync(crowded, { recursive: true, force: true })
} finally {
  first?.child.kill('SIGTERM')
  rmSync(dir, { recursive: true, force: true })
}
// Feed text must only reach the page through textContent.
const page = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'live.html'), 'utf8')
check(!/innerHTML|insertAdjacentHTML|outerHTML|document\.write|\beval\(|new Function/.test(page), 'the page never builds markup or code from feed text')

// The routing table is a pure function between the flow markers; run it here without a browser.
const flowCode = page.slice(page.indexOf('// flow:begin'), page.indexOf('// flow:end'))
const { routeOf, returnRoute, hopOf, promptHits, ctxLevel } = new Function(`${flowCode}\nreturn { routeOf, returnRoute, hopOf, promptHits, ctxLevel }`)()
const paths = (ev, ctx = {}) => routeOf(ev, ctx).map(one => `${one.path.join('>')}:${one.cls}${one.park ? ':park' : ''}`)
check(paths({ kind: 'prompt', origin: 'user' })[0] === 'u>l:info', 'a prompt moves from the user to the lead')
check(paths({ kind: 'prompt', origin: 'user', loop: true }).join() === 'u>l:info,p>l:loop', 'a loop prompt also moves from the loop to the lead')
check(paths({ kind: 'prompt', origin: 'plugin' }, { looping: true })[0] === 'p>l:info', 'a plugin prompt during a loop comes from the loop')
check(paths({ kind: 'tool.start', tool: 'Edit', policy: 'allow' })[0] === 'l>g>w:allow', 'an edit goes lead, guard, worker')
check(paths({ kind: 'tool.start', tool: 'Read', policy: 'allow' })[0] === 'l>g:allow', 'a read stops at the guard')
check(paths({ kind: 'tool.start', tool: 'Agent', subagent: 'smartworkbench:advisor', policy: 'allow' })[0] === 'l>g>o:allow', 'the advisor is reached through the guard')
check(paths({ kind: 'tool.start', tool: 'Agent', subagent: 'smartworkbench:explorer', policy: 'allow' })[0] === 'l>g>d>e:allow', 'an explorer is reached through the dispatcher')
check(paths({ kind: 'tool.start', tool: 'Workflow', policy: 'allow' })[0] === 'l>g>d:allow', 'a workflow is started through the dispatcher')
check(paths({ kind: 'tool.start', tool: 'Bash', policy: 'ask' })[0] === 'l>g:ask:park', 'an ask parks at the guard')
check(paths({ kind: 'tool.start', tool: 'Bash', policy: 'block' })[0] === 'l>g:block', 'a block stops at the guard')
check(paths({ kind: 'tool.start', agent: 'a1', tool: 'Read' }, { onlyAdvisor: true })[0] === 'o>g:allow', 'a call by a lone advisor comes from Opus')
check(paths({ kind: 'tool.start', agent: 'a1', tool: 'Read' })[0] === 'e>d>g:allow', 'a subagent call comes up from the explorer')
check(paths({ kind: 'turn', aborted: true })[0] === 'l>u:block', 'an aborted turn returns to the user in red')
check(paths({ kind: 'tool.start', tool: 'Bash', codex: 'review', policy: 'allow' })[0] === 'l>g>x:allow', 'a Codex review goes lead, guard, Codex')
check(paths({ kind: 'tool.start', tool: 'Bash', codex: 'task', codexWrite: true, policy: 'ask' })[0] === 'l>g:ask:park', 'a Codex write waits at the guard for an answer')
check(paths({ kind: 'tool.start', tool: 'Bash', codex: 'status', agent: 'a1', policy: 'allow' })[0] === 'd>g>x:allow', 'a subagent reaches Codex through the dispatcher')
check(hopOf('g', 'x')?.id === 'x-g' && hopOf('g', 'x')?.rev === true, 'the Codex link is walked backwards from the guard')
check(paths({ kind: 'contract.set' }).length === 0, 'contract events move nothing')
check(returnRoute({ full: ['l', 'g', 'w'] }, 'ok').path.join('>') === 'w>g>l', 'a finished call walks back the way it went')
check(returnRoute({ full: ['l', 'g', 'w'] }, 'blocked').path.join('>') === 'g>l', 'a refused call comes back from the guard')
check(hopOf('w', 'g')?.rev === true && hopOf('l', 'u')?.id === 'u-l' && hopOf('x', 'y') === null, 'hops know their link and direction')
check(ctxLevel(undefined) === 'none' && ctxLevel(null) === 'none' && ctxLevel(59) === 'allow' && ctxLevel(60) === 'ask' && ctxLevel(79) === 'ask' && ctxLevel(80) === 'block', 'the context gauge changes colour at 60 and 80 percent')
check(promptHits(['l', 'g', 'o'], { type: 'edge', id: 'g-o' }) && promptHits(['l', 'g', 'd', 'e'], { type: 'edge', id: 'd-e' }) && promptHits(['l', 'g', 'x'], { type: 'edge', id: 'x-g' }) && promptHits(['u', 'l'], { type: 'node', id: 'u' }), 'a prompt belongs to the boxes and links on its path')
check(!promptHits(['u', 'l'], { type: 'edge', id: 'g-w' }) && !promptHits(['u', 'l'], { type: 'node', id: 'o' }), 'a prompt is not listed on a link or box it did not cross')
check(page.includes('id="s-wf"'), 'the dispatcher box counts started workflows')
check(page.includes('id="ctx"') && page.includes('pre.full') && page.includes('pre-wrap'), 'the page has the context gauge and shows a whole prompt as preformatted text')

// Every hop a route takes must be a drawn link, or the packet silently goes nowhere.
const samples = [
  { kind: 'prompt', origin: 'user' }, { kind: 'prompt', origin: 'user', loop: true }, { kind: 'prompt', origin: 'plugin' },
  { kind: 'tool.start', tool: 'Edit', policy: 'allow' }, { kind: 'tool.start', tool: 'Read', policy: 'ask' }, { kind: 'tool.start', tool: 'Bash', policy: 'block' },
  { kind: 'tool.start', tool: 'Agent', subagent: 'smartworkbench:advisor', policy: 'allow' }, { kind: 'tool.start', tool: 'Agent', subagent: 'smartworkbench:explorer', policy: 'allow' },
  { kind: 'tool.start', tool: 'Workflow', policy: 'allow' }, { kind: 'tool.start', tool: 'Workflow', agent: 'a1', policy: 'allow' },
  { kind: 'tool.start', tool: 'Bash', codex: 'review', policy: 'allow' }, { kind: 'tool.start', tool: 'Bash', codex: 'task', agent: 'a1', policy: 'ask' },
  ...['loop.start', 'loop.pass', 'loop.done', 'loop.stop', 'loop.cancel', 'turn', 'guard.block', 'guard.ask', 'team.design-required', 'team.plan-review-required', 'team.final-check-required'].map(kind => ({ kind })),
]
const missingHops = samples.flatMap(ev => routeOf(ev, { looping: true }).flatMap(route => route.path.slice(1).map((to, i) => [route.path[i], to])).filter(([a, b]) => hopOf(a, b) === null).map(([a, b]) => `${ev.kind}:${a}>${b}`))
check(missingHops.length === 0, `every hop of every route is a drawn link${missingHops.length ? ' (missing ' + missingHops.join(', ') + ')' : ''}`)

// ---- page structure: translations, ids, external resources, contrast ----
const dictBody = /var DICT = \{([\s\S]*?)\n\};/.exec(page)?.[1] ?? ''
const dict = new Function(`return {${dictBody}}`)()
check(Object.keys(dict).length > 20 && Object.entries(dict).every(([, v]) => Array.isArray(v) && v.length === 2 && v[0] && v[1]), 'every DICT entry has an English and a Korean text')
const usedKeys = [...page.matchAll(/data-i="([^"]+)"/g)].map(m => m[1]).concat([...page.matchAll(/\bT\('([^']+)'\)/g)].map(m => m[1]))
const missingKeys = [...new Set(usedKeys)].filter(key => !(key in dict))
check(missingKeys.length === 0, `every data-i and T() key is in DICT${missingKeys.length ? ' (missing ' + missingKeys.join(', ') + ')' : ''}`)
const ids = [...page.slice(0, page.indexOf('<script>')).matchAll(/\bid="([^"]+)"/g)].map(m => m[1])
const dupes = ids.filter((id, i) => ids.indexOf(id) !== i)
check(dupes.length === 0, `no id appears twice${dupes.length ? ' (' + [...new Set(dupes)].join(', ') + ')' : ''}`)
check(!/\bsrc=|href="https?:|@import|url\(/.test(page), 'the page loads nothing from outside')
check(!/\son[a-z]+=/.test(page.slice(0, page.indexOf('<script>'))), 'no inline event handler attributes')
check(page.includes('role="tablist"') && page.includes('role="tab"') && page.includes('role="tabpanel"'), 'the views are tabs with tab and tabpanel roles')

const tokens = theme => {
  const block = theme === 'dark' ? /:root\{([\s\S]*?)\n\}/.exec(page)?.[1] : /:root\[data-theme=light\]\{([\s\S]*?)\n\}/.exec(page)?.[1]
  return Object.fromEntries([...(block ?? '').matchAll(/--([a-z0-9-]+):(#[0-9a-fA-F]{6})/g)].map(m => [m[1], m[2]]))
}
const lum = hex => {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05) }
for (const theme of ['dark', 'light']) {
  const t = tokens(theme)
  const bad = []
  for (const bg of ['bg', 'surface', 'surface-2']) {
    for (const fg of ['fg', 'fg-muted']) if (ratio(t[fg], t[bg]) < 4.5) bad.push(`${fg} on ${bg}`)
    for (const c of ['ok', 'warn', 'bad', 'hold', 'loop', 'opus', 'sonnet', 'haiku', 'codex', 'guard']) if (ratio(t[c], t[bg]) < 4.5) bad.push(`${c} on ${bg}`)
  }
  for (const [c, bg] of [['ok', 'ok-bg'], ['warn', 'warn-bg'], ['bad', 'bad-bg'], ['hold', 'hold-bg'], ['loop', 'loop-bg']]) if (ratio(t[c], t[bg]) < 4.5) bad.push(`${c} on ${bg}`)
  for (const bg of ['bg', 'surface']) for (const c of ['border-strong', 'focus']) if (ratio(t[c], t[bg]) < 3) bad.push(`${c} on ${bg}`)
  check(Object.keys(t).length >= 20 && bad.length === 0, `${theme} theme text is 4.5:1 and controls 3:1 against their backgrounds${bad.length ? ' (' + bad.join(', ') + ')' : ''}`)
}

// ---- the data model: pure, so it runs here on synthetic events ----
const modelCode = page.slice(page.indexOf('// model:begin'), page.indexOf('// model:end'))
const M = new Function(`${modelCode}\nreturn { newTrace, ingest, kpis, pct, buckets, statusOf, spanDur, latencyOf, selKey, buildHash, parseHash, agentStats, turnWarns, parseQuery, matchQuery, marksOf, criticalPath, runsOf, decisionOf, guardRows, sortRows, groupRows, guardStats, attention, kindStats, rebuild }`)()
const feedOf = list => { const tr = M.newTrace(); let at = 1000; for (const ev of list) { at += 100; M.ingest(tr, { at, ...ev }) } return tr }
const tr1 = feedOf([
  { kind: 'tool.start', id: 'x0', tool: 'Read', policy: 'allow' }, { kind: 'tool.end', id: 'x0', outcome: 'ok', ms: 30 },
  { kind: 'prompt', text: 'one', origin: 'user' },
  { kind: 'tool.start', id: 'a', tool: 'Read', policy: 'allow' }, { kind: 'tool.end', id: 'a', outcome: 'ok', ms: 100 },
  { kind: 'tool.start', id: 'b', tool: 'Bash', policy: 'allow' }, { kind: 'tool.end', id: 'b', outcome: 'error', ms: 900 },
  { kind: 'tool.start', id: 'c', tool: 'Bash', policy: 'ask' }, { kind: 'guard.ask', id: 'c', reason: 'r', answer: 'allowed' }, { kind: 'tool.end', id: 'c', outcome: 'ok', ms: 5000 },
  { kind: 'tool.start', id: 'd', tool: 'Bash', policy: 'block' }, { kind: 'tool.end', id: 'd', outcome: 'blocked', ms: 0 },
  { kind: 'tool.start', id: 'e', tool: 'Agent', policy: 'allow' }, { kind: 'tool.end', id: 'e', outcome: 'ok', ms: 7000, agentRun: 'sa' },
  { kind: 'tool.start', id: 'f', tool: 'Workflow', policy: 'allow' }, { kind: 'tool.end', id: 'f', outcome: 'ok', ms: 40, workflowBg: true },
  { kind: 'tool.start', id: 'g', tool: 'Read', policy: 'ask' },
  { kind: 'turn.agent', agent: 'sa', model: 'claude-haiku-4-5', tokensIn: 50, tokensOut: 5 },
  { kind: 'turn', aborted: false, contextTokens: 50000, contextWindow: 200000, tokensIn: 1000, tokensOut: 100, model: 'claude-sonnet-5-5' },
  { kind: 'prompt', text: 'two', origin: 'plugin', loop: true },
  { kind: 'turn', aborted: true },
  { kind: 'loop.stop', done: 2 },
])
const k1 = M.kpis(tr1, 5000)
check(k1.p50 === 100 && k1.p95 === 900 && k1.latN === 3, 'latency leaves out asks, blocked, Agent, Workflow, running and zero-length calls (the pre-prompt Read is the third)')
check(k1.askPending === 1 && k1.askAge !== null, 'an ask with no answer or end counts as waiting; one that was answered does not')
check(k1.blocked === 1 && k1.errors === 1 && k1.aborted === 1 && k1.fails === 3, 'blocks, errors and an aborted turn make the failure count')
check(k1.tokIn === 1050 && k1.tokOut === 105, 'tokens add up the lead turns and the subagents')
check(k1.ctx && k1.ctx.p === 25, 'context percent is computed from tokens and window when the turn gives no percent')
check(tr1.turns.length === 3 && tr1.turns[0].early && tr1.turns[1].spans.length === 7 && tr1.turns[2].loop === true && tr1.turns[2].origin === 'plugin', 'events before the first prompt form an early turn; a prompt starts a turn; a plugin prompt is its own turn')
check(tr1.turns[2].marks.some(m => m.kind === 'loop.stop'), 'a loop event after a turn is marked on that turn')
check(M.statusOf(tr1.spans.get('f')) === 'bg' && M.statusOf(tr1.spans.get('g')) === 'running' && M.statusOf(tr1.spans.get('d')) === 'blocked', 'span statuses: background start, running, blocked')
check(M.pct([], 50) === null && M.pct([5], 95) === 5 && M.pct([1, 2, 3, 4], 50) === 2 && M.pct([1, 2, 3, 4], 95) === 4, 'percentiles use the nearest rank')
check(M.buckets([100, 190, 250, 9999], 300, 3, 100).join() === '1,1,1' && M.buckets([-5], 300, 3, 100).join() === '0,0,0', 'buckets count events into equal slices ending now and ignore the future and the too old')
const tr2 = feedOf([
  { kind: 'prompt', text: 'p' },
  { kind: 'tool.start', id: 'A', tool: 'Agent', subagent: 'x:explorer' },
  { kind: 'tool.start', id: 's1', tool: 'Read', agent: 'sub1' },
])
check(tr2.spans.get('s1').parent === 'A' && tr2.spans.get('s1').est === true, 'with one Agent call open a subagent call is attached to it as a guess')
const tr3 = feedOf([
  { kind: 'prompt', text: 'p' },
  { kind: 'tool.start', id: 'A', tool: 'Agent' }, { kind: 'tool.start', id: 'B', tool: 'Agent' },
  { kind: 'tool.start', id: 's1', tool: 'Read', agent: 'sub1' },
])
check(tr3.spans.get('s1').parent === null, 'with two Agent calls open a subagent call stays unattached')
M.ingest(tr3, { at: 9000, kind: 'tool.end', id: 'B', outcome: 'ok', agentRun: 'sub1' })
check(tr3.spans.get('s1').parent === 'B' && tr3.spans.get('s1').est === false, 'the Agent call that returns agentRun settles which call its subagent belongs to')
check(M.spanDur({ ms: 50, end: 10, at: 0 }, 99) === 50 && M.spanDur({ ms: null, end: 30, at: 10 }, 99) === 20 && M.spanDur({ ms: null, end: null, at: 10 }, 99) === 89, 'a span lasts ms, else end minus start, else until now')
const big = M.newTrace(); const t0 = Date.now()
for (let i = 0; i < 2000; i++) { M.ingest(big, { at: i * 10, kind: 'tool.start', id: 'i' + i, tool: 'Read', policy: 'allow' }); M.ingest(big, { at: i * 10 + 5, kind: 'tool.end', id: 'i' + i, outcome: 'ok', ms: 5 }) }
M.kpis(big, 30000)
check(Date.now() - t0 < 400, 'two thousand calls ingest and summarise in under 400 ms')

const h1 = M.buildHash({ tab: 'timeline', sel: M.selKey('call', 'a/b c&d=e'), q: 'tool:Bash -policy:allow' })
const p1 = M.parseHash(h1)
check(p1.tab === 'timeline' && p1.sel === 'call:a/b c&d=e' && p1.q === 'tool:Bash -policy:allow', 'an address round-trips a tab, a selected call and a query, whatever characters the id holds')
check(M.parseHash('#tab=%E0%A4%A&sel=call:x').sel === 'call:x' && M.parseHash('#sel=<script>').sel === null && M.parseHash('#tab=../../x').tab === null && M.parseHash(undefined).tab === null, 'a damaged or hostile address is dropped piece by piece without an exception')
const trA = feedOf([
  { kind: 'prompt', text: 'p' },
  { kind: 'tool.start', id: 'A', tool: 'Agent' },
  { kind: 'tool.start', id: 's1', tool: 'Read', agent: 'sub1' }, { kind: 'tool.end', id: 's1', outcome: 'error', ms: 5 },
  { kind: 'tool.start', id: 's2', tool: 'Read', agent: 'sub1' }, { kind: 'tool.end', id: 's2', outcome: 'ok', ms: 5 },
  { kind: 'turn.agent', agent: 'sub1', model: 'claude-haiku-4-5', tokensIn: 7, tokensOut: 3 },
  { kind: 'tool.end', id: 'A', outcome: 'ok', ms: 100, agentRun: 'sub1' },
])
const stA = M.agentStats(trA, trA.spans.get('A'))
check(stA.calls === 2 && stA.fails === 1 && stA.tokIn === 7 && stA.tokOut === 3, 'a subagent run adds up its calls, its failures and its own tokens')
const trW = feedOf([{ kind: 'prompt', text: 'p' }, ...[1, 2, 3].flatMap(i => [{ kind: 'tool.start', id: 'r' + i, tool: 'Bash', summary: 'npm test' }, { kind: 'tool.end', id: 'r' + i, outcome: 'error', ms: 9 }])])
check(M.turnWarns(trW.turns[0]).map(w => w.kind).join() === 'repeat,errors', 'the same call three times in a row, and three failures, each raise a note on the turn')
check(M.turnWarns(feedOf([{ kind: 'prompt', text: 'p' }, { kind: 'tool.start', id: 'q1', tool: 'Bash', summary: 'a' }, { kind: 'tool.start', id: 'q2', tool: 'Bash', summary: 'b' }, { kind: 'tool.start', id: 'q3', tool: 'Bash', summary: 'a' }]).turns[0]).length === 0, 'different calls in a row raise no note')
check(page.includes('role="tree"') && page.includes("'treeitem'"), 'the timeline is a tree of tree items')

const q1 = M.parseQuery('tool:Bash -policy:allow "npm test" ms:>500 foo is:fail bogus:x')
check(q1.terms.length === 7 && q1.terms[0].field === 'tool' && q1.terms[1].neg && q1.terms[1].field === 'policy' && q1.terms[2].val === 'npm test' && q1.terms[3].cmp.op === '>' && q1.terms[3].cmp.n === 500 && q1.terms[5].field === 'is' && q1.terms[6].field === null && q1.terms[6].val === 'bogus:x', 'the query parser reads fields, exclusions, phrases, comparisons and keeps an unknown field as plain text')
check(M.parseQuery('ms:abc').terms[0].field === null && M.parseQuery('   ').terms.length === 0 && M.parseQuery('x'.repeat(1000)).text.length === 300, 'a bad comparison is plain text, a blank query is empty, a long one is cut')
const sp1 = trW.spans.get('r1'), sp9 = tr1.spans.get('c')
const m = (text, sp, now = 99999) => M.matchQuery(M.parseQuery(text), sp, now)
check(m('tool:bash', sp1) && !m('tool:read', sp1) && m('npm', sp1) && m('"npm test" is:fail', sp1) && !m('-npm', sp1) && m('outcome:error', sp1) && m('ms:>5', sp1) && !m('ms:>10', sp1), 'search matches tool, text, outcome, phrase and duration, ANDs the words and honours exclusion')
check(m('policy:ask', sp9) && m('is:ask -is:fail', sp9) && m('turn:1', sp9) && !m('turn:>1', sp9), 'search matches policy, the ask flag and the turn')
check(M.marksOf('Run npm test, npm run', M.parseQuery('npm -run tool:x')).join('|') === '4,7|14,17', 'highlights cover the plain words, merged, ignoring exclusions and fields')
const spn = (id, s, e) => ({ id, at: s, end: e })
const cp = M.criticalPath([spn('a', 0, 100), spn('b', 10, 50), spn('c', 100, 300), spn('d', 120, 200)], 999)
check(Object.keys(cp).sort().join() === 'a,c' && M.criticalPath([], 9) !== null, 'the critical path follows the latest finisher back through what ended before it started')
check(M.runsOf([{ tool: 'B', summary: 'x' }, { tool: 'B', summary: 'x' }, { tool: 'B', summary: 'x' }, { tool: 'R', summary: 'y' }]).map(r => (r.run ? 'run' + r.run.length : 'one')).join() === 'run3,one' && M.runsOf([{ tool: 'B', summary: 'x' }, { tool: 'B', summary: 'x' }]).every(r => r.one), 'three or more neighbours that are the same call fold into a run; two do not')
check(page.includes('id="mini"') && page.includes('id="tl-q"') && page.includes('type="search"'), 'the timeline has an overview strip and a search box')

const ds = id => M.decisionOf(tr1.spans.get(id))
check(ds('a') === 'allow' && ds('c') === 'ask' && ds('d') === 'block' && ds('g') === 'asking', 'a call is allow, asked and answered yes, blocked, or still asking')
const trD = feedOf([
  { kind: 'prompt', text: 'p' },
  { kind: 'tool.start', id: 'p1', tool: 'Bash', policy: 'ask', risk: 'high', category: 'external' }, { kind: 'guard.ask', id: 'p1', reason: 'send', answer: 'declined' }, { kind: 'tool.end', id: 'p1', outcome: 'declined', ms: 10 },
  { kind: 'tool.start', id: 'p2', tool: 'Bash', policy: 'block', risk: 'high', category: 'destructive' }, { kind: 'guard.block', id: 'p2', reason: 'rm', input: 'rm -rf x' }, { kind: 'tool.end', id: 'p2', outcome: 'blocked', ms: 0 },
  { kind: 'tool.start', id: 'p3', tool: 'Bash', policy: 'block', risk: 'high', category: 'destructive' }, { kind: 'guard.block', id: 'p3', reason: 'rm', input: 'rm -rf y' }, { kind: 'tool.end', id: 'p3', outcome: 'blocked', ms: 0 },
  { kind: 'tool.start', id: 'p4', tool: 'Read', policy: 'allow', risk: 'low', category: 'read' }, { kind: 'tool.end', id: 'p4', outcome: 'ok', ms: 3 },
  { kind: 'tool.start', id: 'p5', tool: 'Bash', policy: 'ask', risk: 'high', category: 'external' },
  { kind: 'feed.recovered', missed: 4 }, { kind: 'team.final-check-required' },
])
check(M.decisionOf(trD.spans.get('p1')) === 'declined', 'an ask a person answered no is declined')
const gr = M.guardRows(trD, 9999)
check(M.groupRows(gr.filter(r => r.decision === 'block')).length === 1 && M.groupRows(gr.filter(r => r.decision === 'block'))[0].n === 2, 'blocks of the same tool and reason are one line counted twice')
check(M.sortRows(gr, 'risk', -1)[0].risk === 'high' && M.sortRows(gr, 'at', -1)[0].key === 'call:p5' && M.sortRows(gr, 'at', 1)[0].key === 'call:p1', 'rows sort by risk rank and by time in either direction')
const gs = M.guardStats(trD)
check(gs.destructive.block === 2 && gs.external.declined === 1 && gs.external.asking === 1 && gs.read.allow === 1, 'decisions are counted per category')
const at1 = M.attention(trD, 99999)
check(at1[0].type === 'ask' && at1[0].sp.id === 'p5' && at1.slice(1).map(a => a.kind).join() === 'team.final-check-required,feed.recovered', 'attention lists waiting asks first, then notes newest first')
const kstat = M.kindStats(feedOf([
  { kind: 'prompt', text: 'p' },
  { kind: 'tool.start', id: 'k1', tool: 'Agent', subagent: 'smartworkbench:explorer' }, { kind: 'tool.end', id: 'k1', outcome: 'ok', ms: 100 },
  { kind: 'tool.start', id: 'k2', tool: 'Agent', subagent: 'smartworkbench:explorer' }, { kind: 'tool.end', id: 'k2', outcome: 'ok', ms: 300 },
  { kind: 'tool.start', id: 'k3', tool: 'Agent', subagent: 'smartworkbench:advisor' },
]), 9999)
check(kstat.length === 2 && kstat.find(e => e.kind === 'explorer').runs === 2 && kstat.find(e => e.kind === 'explorer').avg === 200 && kstat.find(e => e.kind === 'advisor').avg === null, 'agents are summed by kind with the average of the runs that ended')
check(!/addLog|addFlag|id="log"|id="flags"/.test(page), 'the old log and flag lists are gone')

check(page.includes('<dialog id="help"') && page.includes('id="keys-off"') && page.includes('id="helpb"'), 'a keyboard help dialog with a switch for single-key shortcuts exists')
check((page.match(/aria-live="assertive"/g) ?? []).length === 1 && (page.match(/aria-live="polite"/g) ?? []).length === 1, 'exactly one polite and one assertive live region, the assertive one only for asks and blocks')
check(page.includes("aria-busy") && page.includes('prefers-reduced-motion'), 'the timeline is marked busy while rebuilding and motion respects the system setting')
check(page.includes("e.key === '?'") && page.includes("keysOff"), 'shortcuts are bound to keys and can be switched off')

const trBg = feedOf([
  { kind: 'prompt', text: 'p' },
  { kind: 'tool.start', id: 'A', tool: 'Agent' }, { kind: 'tool.end', id: 'A', outcome: 'ok', ms: 5, agentRun: 'bg1' },
  { kind: 'tool.start', id: 'B', tool: 'Agent' },
  { kind: 'tool.start', id: 'late', tool: 'Read', agent: 'bg1' },
])
check(trBg.spans.get('late').parent === 'A' && trBg.spans.get('late').est === false, 'a subagent call that arrives after its Agent call ended is attached to it, not guessed onto another open Agent call')
const same = Array.from({ length: 40 }, (_, i) => ({ id: 'z' + i, at: 100, end: 100 }))
const t1 = Date.now()
check(Object.keys(M.criticalPath(same, 100)).length <= 40 && Date.now() - t1 < 100, 'calls that start and end at the same moment do not make the critical path loop')
const trG = feedOf([{ kind: 'prompt', text: 'a' }, { kind: 'turn', aborted: false }, { kind: 'turn', aborted: false, tokensIn: 5, model: 'claude-x' }, { kind: 'prompt', text: 'b' }])
check(trG.turns.length === 2 && trG.activeMs > 0, 'a second turn line after a turn closed adds no empty turn')
const trF = feedOf([{ kind: 'prompt', text: 'p' }, { kind: 'tool.start', id: 'f1', tool: 'Bash' }, { kind: 'tool.end', id: 'f1', outcome: 'error', ms: 1 }, { kind: 'turn', aborted: true }])
check(trF.failTotal === 2, 'failures are counted for the screen reader summary whatever the buffer holds')
const rb = M.rebuild([{ at: 1, kind: 'prompt', text: 'x' }, { at: 2, kind: 'tool.start', id: 'r', tool: 'Read' }, null, { at: 3, kind: 'tool.end', id: 'r', outcome: 'ok', ms: 1 }])
check(rb.turns.length === 1 && rb.spans.size === 1 && rb.events === 3, 'a rebuilt trace comes from the events given and survives a bad entry')
check(tr1.spans.get('__proto__') === undefined && M.statusOf({ end: 1, outcome: 'constructor', workflowBg: false }) === 'ok', 'an outcome or id named like an object property is just text')

const trR = feedOf([
  { kind: 'prompt', text: 'task' }, { kind: 'tool.start', id: 'a1', tool: 'Read' }, { kind: 'tool.end', id: 'a1', outcome: 'ok', ms: 1 }, { kind: 'turn', aborted: false },
  { kind: 'tool.start', id: 'a2', tool: 'Agent', subagent: 'smartworkbench:advisor' }, { kind: 'tool.end', id: 'a2', outcome: 'ok', ms: 1, agentRun: 'x1' },
  { kind: 'tool.start', id: 'a3', tool: 'Grep', agent: 'x1' }, { kind: 'turn', aborted: false },
])
check(trR.turns.length === 2 && trR.turns[1].resumed === true && trR.turns[1].spans.map(s => s.id).join() === 'a2,a3' && trR.turns[0].spans.length === 1, 'calls after a turn ended with no prompt start a resumed turn instead of piling into the old one')
check(page.includes('id="errs"') && page.includes('function safe(') && !/catch \(e\) \{\}\s*\n\s*try \{ flow/.test(page), 'a failure while reading or drawing is shown in the status bar, not swallowed')

process.exit(failed === 0 ? 0 : 1)
