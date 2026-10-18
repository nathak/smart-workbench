import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { beat, clear, ensureHome } from '../channel.mjs'
import { parseFrames } from '../events.mjs'
import { pickTools, superviseHub, toolCandidates } from '../hub.mjs'
import { pickLang, strings } from '../i18n.mjs'
import { makeNotices } from '../notices.mjs'
import { loadPrefs, savePrefs } from '../prefs.mjs'
import { readSnapshots } from '../snapshots.mjs'
import { readDesktop } from '../../tools/desktop-state.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const tmp = () => mkdtempSync(join(tmpdir(), 'swb-desk-'))
const clock = () => {
  let t = 1_000_000
  return { now: () => t, advance: ms => void (t += ms) }
}

test('an ask with no tool.end after two seconds raises one notice; one answered at once raises none', () => {
  const c = clock()
  const n = makeNotices({ now: c.now })
  n.onSessions([{ id: 's1', project: '/home/u/app', alive: true }])
  n.onLine('s1', { kind: 'tool.start', id: 'a', tool: 'Bash', policy: 'ask' })
  n.onLine('s1', { kind: 'tool.start', id: 'b', tool: 'Edit', policy: 'ask' })
  n.onLine('s1', { kind: 'tool.end', id: 'b', outcome: 'ok' })
  assert.deepEqual(n.tick(), [])
  c.advance(2500)
  assert.deepEqual(n.tick(), [{ kind: 'ask', session: 's1', project: 'app', tool: 'Bash' }])
  assert.deepEqual(n.tick(), [])
})

test('a tool name that is not plain is replaced, and a notice never carries a command', () => {
  const c = clock()
  const n = makeNotices({ now: c.now })
  n.onSessions([{ id: 's1', project: 'C:\\w\\app', alive: true }])
  n.onLine('s1', { kind: 'tool.start', id: 'a', tool: '<b>x</b> secret', policy: 'ask', summary: 'secret-command --flag' })
  c.advance(3000)
  const [one] = n.tick()
  assert.equal(one.tool, 'tool')
  assert.equal(one.project, 'app')
  assert.equal(JSON.stringify(one).includes('secret'), false)
})

test('asks of one session are throttled to one per 30 seconds, and all sessions to one per 5', () => {
  const c = clock()
  const n = makeNotices({ now: c.now })
  n.onSessions([{ id: 's1', project: '/a', alive: true }, { id: 's2', project: '/b', alive: true }])
  n.onLine('s1', { kind: 'tool.start', id: '1', tool: 'Bash', policy: 'ask' })
  n.onLine('s2', { kind: 'tool.start', id: '2', tool: 'Bash', policy: 'ask' })
  c.advance(2500)
  assert.equal(n.tick().length, 1)
  c.advance(5000)
  n.onLine('s1', { kind: 'tool.start', id: '3', tool: 'Bash', policy: 'ask' })
  c.advance(2500)
  // s2's ask was held back by the global gap and now goes out; s1's second ask is inside its own 30 seconds.
  assert.deepEqual(n.tick().map(one => one.session), ['s2'])
})

test('quiet is announced after a minute and not again until the session beats once more', () => {
  const c = clock()
  const n = makeNotices({ now: c.now })
  n.onSessions([{ id: 's1', project: '/a', alive: true, quiet: true }])
  c.advance(30000)
  assert.deepEqual(n.tick(), [])
  c.advance(31000)
  assert.equal(n.tick()[0].kind, 'quiet')
  c.advance(120000)
  assert.deepEqual(n.tick(), [])
})

test('a session that ends is announced once, a quiet one is not an end, and a disabled kind is silent', () => {
  const c = clock()
  const n = makeNotices({ now: c.now })
  n.onSessions([{ id: 's1', project: '/a', alive: true }])
  assert.deepEqual(n.onSessions([{ id: 's1', project: '/a', alive: false, quiet: true }]), [])
  assert.equal(n.onSessions([{ id: 's1', project: '/a', alive: false }]).length, 1)
  assert.deepEqual(n.onSessions([{ id: 's1', project: '/a', alive: false }]), [])
  const off = makeNotices({ now: c.now, enabled: () => ({ ask: false, quiet: true, end: true }) })
  off.onSessions([{ id: 'x', project: '/a', alive: true }])
  off.onLine('x', { kind: 'tool.start', id: '1', tool: 'Bash', policy: 'ask' })
  c.advance(3000)
  assert.deepEqual(off.tick(), [])
})

test('frames split across chunks are rebuilt, comments are skipped', () => {
  const a = parseFrames(': ping\n\nevent: sessions\ndata: {"sess')
  assert.deepEqual(a.frames, [])
  const b = parseFrames(`${a.rest}ions":[]}\n\nevent: ready\ndata: {}\n\n`)
  assert.deepEqual(b.frames.map(f => f.event), ['sessions', 'ready'])
})

test('the hub is started when none answers, once, with --keep, and is not started when one answers', async () => {
  const calls = []
  const fake = { exitCode: null, killed: false, on() {}, kill() { this.killed = true } }
  const hub = superviseHub({ port: 4999, tools: '/t', spawnImpl: (...a) => (calls.push(a), fake), probeImpl: async () => undefined, everyMs: 60000 })
  await new Promise(r => setTimeout(r, 30))
  assert.equal(calls.length, 1)
  assert.ok(calls[0][1].includes('--keep') && calls[0][1].includes('--hub') && calls[0][1].includes('4999'))
  assert.equal(calls[0][2].env.ELECTRON_RUN_AS_NODE, '1')
  hub.stop()
  assert.equal(fake.killed, true)
  const other = []
  const up = superviseHub({ port: 4999, tools: '/t', spawnImpl: (...a) => other.push(a), probeImpl: async () => ({ hub: 'smartworkbench' }), everyMs: 60000 })
  await new Promise(r => setTimeout(r, 30))
  assert.equal(other.length, 0)
  assert.equal(up.state, 'up')
  up.stop()
})

test('tools are taken from the first directory whose hub has --keep', () => {
  const old = tmp()
  const fresh = tmp()
  for (const [dir, text] of [[old, "'connection: keep-alive'"], [fresh, 'export function runHub({ keep = false })']]) {
    writeFileSync(join(dir, 'live.mjs'), '')
    writeFileSync(join(dir, 'live-hub.mjs'), text)
  }
  assert.equal(pickTools([old, fresh]), fresh)
  assert.equal(pickTools([old]), undefined)
  const home = tmp()
  mkdirSync(join(home, '.claude', 'plugins'), { recursive: true })
  writeFileSync(join(home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'smartworkbench@x': [{ installPath: '/p/1' }], 'other@x': [{ installPath: '/o' }] } }))
  const list = toolCandidates({ env: {}, home, resources: undefined })
  assert.equal(list[0], '/p/1/tools')
  assert.equal(list.includes('/o/tools'), false)
})

test('the heartbeat is private and atomic, and the plugin reads it only while fresh', () => {
  const home = join(tmp(), 'd')
  ensureHome(home)
  assert.equal(statSync(home).mode & 0o077, 0)
  beat(home, { port: 4317, autoJoin: true, livePrompts: false, askNotify: 'desktop' })
  assert.equal(statSync(join(home, 'desktop.json')).mode & 0o077, 0)
  assert.deepEqual(readDesktop(home), { home, port: 4317, autoJoin: true, livePrompts: false, askNotify: 'desktop' })
  assert.equal(readDesktop(home, Date.now() + 60000), undefined)
  clear(home)
  assert.equal(readDesktop(home), undefined)
})

test('the plugin ignores a heartbeat with a bad port or version, one that is too large, or one that is not JSON', () => {
  const home = tmp()
  for (const body of [{ v: 1, port: 80 }, { v: 2, port: 4317 }, { v: 1, port: 'x' }]) {
    writeFileSync(join(home, 'desktop.json'), JSON.stringify(body))
    assert.equal(readDesktop(home), undefined)
  }
  writeFileSync(join(home, 'desktop.json'), JSON.stringify({ v: 1, port: 4317, pad: 'x'.repeat(5000) }))
  assert.equal(readDesktop(home), undefined)
  writeFileSync(join(home, 'desktop.json'), '{')
  assert.equal(readDesktop(home), undefined)
})

test('a directory open to others is closed again, and prefs fall back to defaults on bad input', () => {
  const home = tmp()
  chmodSync(home, 0o755)
  ensureHome(home)
  assert.equal(statSync(home).mode & 0o077, 0)
  const file = join(home, 'p.json')
  writeFileSync(file, JSON.stringify({ notifyAsk: 'yes', notifyEnd: true, extra: 1 }))
  const p = loadPrefs(file)
  assert.equal(p.notifyAsk, true)
  assert.equal(p.notifyEnd, true)
  assert.equal('extra' in p, false)
  savePrefs(file, { ...p, autoJoin: false })
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).autoJoin, false)
})

test('Korean locales get Korean, others English, and both languages cover the same keys', () => {
  assert.equal(pickLang('ko-KR', undefined), 'ko')
  assert.equal(pickLang('en-US', undefined), 'en')
  assert.equal(pickLang('en-US', 'ko'), 'ko')
  assert.deepEqual(Object.keys(strings('ko')).sort(), Object.keys(strings('en')).sort())
})

test('an ask held back by a throttle goes out on a later tick, and an end already over when the app starts is not announced', () => {
  const c = clock()
  const n = makeNotices({ now: c.now })
  n.onSessions([{ id: 's1', project: '/a', alive: true }, { id: 's2', project: '/b', alive: true }])
  n.onLine('s1', { kind: 'tool.start', id: '1', tool: 'Bash', policy: 'ask' })
  n.onLine('s2', { kind: 'tool.start', id: '2', tool: 'Edit', policy: 'ask' })
  c.advance(2500)
  assert.equal(n.tick().length, 1)
  c.advance(5000)
  assert.deepEqual(n.tick().map(one => one.tool), ['Edit'])
  const late = makeNotices({ now: c.now })
  assert.deepEqual(late.onSessions([{ id: 'old', project: '/a', alive: false }]), [])
})

test('an ask replayed from long ago is not news, and a project name carries no markup', () => {
  const c = clock()
  const n = makeNotices({ now: c.now })
  n.onSessions([{ id: 's1', project: '/w/<b>app&', alive: true }])
  n.onLine('s1', { kind: 'tool.start', id: '1', tool: 'Bash', policy: 'ask', at: c.now() - 120000 })
  c.advance(3000)
  assert.deepEqual(n.tick(), [])
  n.onLine('s1', { kind: 'tool.start', id: '2', tool: 'Bash', policy: 'ask' })
  c.advance(3000)
  assert.equal(n.tick()[0].project, 'bapp')
})

test('a heartbeat of an app that no longer runs is ignored even while fresh', () => {
  const home = tmp()
  writeFileSync(join(home, 'desktop.json'), JSON.stringify({ v: 1, pid: 2147483646, port: 4317 }))
  assert.equal(readDesktop(home), undefined)
  writeFileSync(join(home, 'desktop.json'), JSON.stringify({ v: 1, pid: process.pid, port: 4317 }))
  assert.equal(readDesktop(home)?.port, 4317)
})

test('snapshots are read only when they are plain, small, recent and shaped right, and keyed by their file name', () => {
  const home = tmp()
  const dir = join(home, 'state')
  mkdirSync(dir, { mode: 0o700 })
  const ok = { v: 1, session: 'a', task: { goal: 'g' } }
  writeFileSync(join(dir, 'a.json'), JSON.stringify(ok))
  writeFileSync(join(dir, 'b.json'), JSON.stringify({ ...ok, session: 'other' }))
  writeFileSync(join(dir, 'c.json'), JSON.stringify({ v: 2, session: 'c', task: {} }))
  writeFileSync(join(dir, 'd.json'), JSON.stringify({ ...ok, session: 'd', pad: 'x'.repeat(70000) }))
  writeFileSync(join(dir, 'e.json'), '{')
  writeFileSync(join(dir, 'bad name.json'), JSON.stringify({ ...ok, session: 'bad name' }))
  symlinkSync(join(dir, 'a.json'), join(dir, 'l.json'))
  assert.deepEqual(Object.keys(readSnapshots(home)), ['a'])
  assert.deepEqual(Object.keys(readSnapshots(home, Date.now() + 25 * 3600 * 1000)), [])
  assert.equal(Object.keys(readSnapshots(join(home, 'none'))).length, 0)
})

test('the snapshot writer needs a fresh heartbeat, a matching session and a small body, and writes a private file', () => {
  const home = tmp()
  const run = (id, body) => spawnSync(process.execPath, [join(here, '..', '..', 'tools', 'desktop-snapshot.mjs'), id], { input: body, env: { ...process.env, SWB_DESKTOP_HOME: home } }).status
  const snap = JSON.stringify({ v: 1, session: 's1', task: { goal: 'g' } })
  assert.equal(run('s1', snap), 0)
  assert.equal(existsSync(join(home, 'state', 's1.json')), false)
  beat(home, { port: 4317 })
  assert.equal(run('../x', snap), 2)
  assert.equal(run('s2', snap), 4)
  assert.equal(run('s1', JSON.stringify({ v: 1, session: 's1', pad: 'x'.repeat(70000) })), 3)
  assert.equal(run('s1', snap), 0)
  const file = join(home, 'state', 's1.json')
  assert.equal(statSync(file).mode & 0o077, 0)
  assert.equal(statSync(join(home, 'state')).mode & 0o077, 0)
  assert.equal(readSnapshots(home).s1.task.goal, 'g')
})

test('a snapshot of an odd shape is given the arrays the window reads, only listed sessions are read, and a day-old file is removed', () => {
  const home = tmp()
  const dir = join(home, 'state')
  mkdirSync(dir, { mode: 0o700 })
  writeFileSync(join(dir, 'odd.json'), JSON.stringify({ v: 1, session: 'odd', task: { constraints: 'x' }, team: 5, evidence: {} }))
  writeFileSync(join(dir, 'other.json'), JSON.stringify({ v: 1, session: 'other', task: {} }))
  writeFileSync(join(dir, '__proto__.json'), JSON.stringify({ v: 1, session: '__proto__', task: {} }))
  const got = readSnapshots(home, Date.now(), new Set(['odd']))
  assert.deepEqual(Object.keys(got), ['odd'])
  assert.deepEqual(got.odd.task.constraints, [])
  assert.deepEqual(got.odd.team.roles, {})
  assert.deepEqual(got.odd.evidence, [])
  assert.equal(Object.hasOwn(readSnapshots(home), '__proto__'), true)
  assert.equal(Object.getPrototypeOf(readSnapshots(home)), null)
  readSnapshots(home, Date.now() + 25 * 3600 * 1000)
  assert.equal(existsSync(join(dir, 'odd.json')), false)
})

test('the snapshot writer refuses a state directory that is a link and leaves no temporary file behind', () => {
  const home = tmp()
  beat(home, { port: 4317 })
  const elsewhere = tmp()
  symlinkSync(elsewhere, join(home, 'state'))
  const run = body => spawnSync(process.execPath, [join(here, '..', '..', 'tools', 'desktop-snapshot.mjs'), 's1'], { input: body, env: { ...process.env, SWB_DESKTOP_HOME: home } }).status
  assert.equal(run(JSON.stringify({ v: 1, session: 's1', task: {} })), 5)
  assert.deepEqual(readdirSync(elsewhere), [])
})

test('the status window page restricts what it loads, and the preload exposes the overview and sending a contract change, and nothing else', () => {
  const page = readFileSync(join(here, '..', 'ui', 'status.html'), 'utf8')
  assert.ok(page.includes("default-src 'none'") && page.includes("base-uri 'none'") && page.includes("form-action 'none'"))
  const preload = readFileSync(join(here, '..', 'preload.cjs'), 'utf8')
  assert.equal([...preload.matchAll(/ipcRenderer\.\w+\('([^']+)'/g)].map(one => one[1]).join(), 'swb:overview,swb:send')
  assert.equal([...preload.matchAll(/exposeInMainWorld\('(\w+)'/g)].length, 1)
})

test('the app never writes the guard file itself, and its guard file texts come in both languages', async () => {
  const { readFileSync, readdirSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const { join, dirname } = await import('node:path')
  const here = join(dirname(fileURLToPath(import.meta.url)), '..')
  for (const name of readdirSync(here).filter(one => (one.endsWith('.mjs') || one.endsWith('.cjs')) && one !== 'i18n.mjs')) assert.ok(!/smartworkbench\.json/.test(readFileSync(join(here, name), 'utf8')), `${name} names the guard file`)
  const ui = readFileSync(join(here, 'ui', 'status.js'), 'utf8')
  assert.ok(!/['"]allow['"]\s*\]\s*\)/.test(ui.split('function ruleForm')[1]?.split('function guardFile')[0] ?? ''), 'the rule form offers allow')
  const { strings } = await import('../i18n.mjs')
  const en = strings('en').ui
  const ko = strings('ko').ui
  for (const key of ['guardFile', 'noFile', 'noFileProfile', 'clearProfile', 'fileRules', 'addRule', 'asksInSession', 'ruleHints', 'policyNote']) {
    assert.ok(en[key] && ko[key] && en[key] !== ko[key], key)
  }
  assert.deepEqual(Object.keys(en.ruleHints), Object.keys(ko.ruleHints))
  // A missing tab name throws in the card and leaves only the session's name on screen.
  for (const key of ['tabs', 'tabsLabel', 'proposalNote', 'ribbonDone']) assert.ok(en[key] && ko[key] && JSON.stringify(en[key]) !== JSON.stringify(ko[key]), key)
  assert.deepEqual(Object.keys(en.tabs), Object.keys(ko.tabs))
  for (const reason of ['policy file is broken', 'invalid', 'unknown rule']) assert.ok(en.reasons[reason] && ko.reasons[reason], reason)
})
