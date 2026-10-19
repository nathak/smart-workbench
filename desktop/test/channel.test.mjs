import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { ensureHome, ensureKey, readAck, sendCommand, tidy } from '../channel.mjs'
import { ack, canonical, checkOps, sign, take } from '../../tools/desktop-channel.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const script = join(here, '..', '..', 'tools', 'desktop-channel.mjs')

const setup = () => {
  const home = join(mkdtempSync(join(tmpdir(), 'swb-chan-')), 'd')
  ensureHome(home)
  return { home, key: ensureKey(home) }
}
const inboxOf = (home, session) => join(home, 'inbox', session)
const put = (home, session, command, mode = 0o600) => {
  mkdirSync(inboxOf(home, session), { recursive: true, mode: 0o700 })
  const file = join(inboxOf(home, session), `${command.id}.json`)
  writeFileSync(file, JSON.stringify(command), { mode })
  return file
}
const signed = (key, over = {}) => {
  const body = { v: 1, id: 'c1', createdAt: Date.now(), expiresAt: Date.now() + 60000, target: { kind: 'session', sessionId: 's1' }, ops: [{ op: 'set_goal', text: 'g' }], ...over }
  return { ...body, mac: sign(key, body) }
}

test('a command the app signed is taken once, with its ops cleaned, and the key is private', () => {
  const { home, key } = setup()
  assert.equal(statSync(join(home, 'key')).mode & 0o077, 0)
  const sent = sendCommand(home, key, 's1', [{ op: 'set_goal', text: '  new goal  ', extra: 'x' }, { op: 'lock' }], Date.now(), 'cmd1')
  assert.equal(sent.ok, true)
  assert.equal(statSync(join(inboxOf(home, 's1'), 'cmd1.json')).mode & 0o077, 0)
  const got = take(home, 's1')
  assert.deepEqual(got.commands.map(one => [one.id, one.ops]), [['cmd1', [{ op: 'set_goal', text: 'new goal' }, { op: 'lock' }]]])
  assert.deepEqual(readdirSync(inboxOf(home, 's1')), [])
  assert.deepEqual(take(home, 's1'), { commands: [], rejected: [] })
})

test('a forged, edited, expired, misdirected or replayed command is not taken', () => {
  const { home, key } = setup()
  const other = Buffer.alloc(32, 7)
  put(home, 's1', signed(other, { id: 'forged' }))
  const edited = signed(key, { id: 'edited' })
  edited.ops[0].text = 'changed after signing'
  put(home, 's1', edited)
  put(home, 's1', signed(key, { id: 'old', expiresAt: Date.now() - 1 }))
  put(home, 's1', signed(key, { id: 'elsewhere', target: { kind: 'session', sessionId: 's2' } }))
  put(home, 's1', { ...signed(key, { id: 'nomac' }), mac: undefined })
  const got = take(home, 's1')
  assert.deepEqual(got.commands, [])
  assert.deepEqual(got.rejected.map(one => `${one.id}:${one.reason}`).sort(), ['elsewhere:wrong target', 'old:expired'])
  assert.deepEqual(readdirSync(inboxOf(home, 's1')), [])
  // The same signed command again is a replay: its ack file exists.
  const good = signed(key, { id: 'once' })
  put(home, 's1', good)
  assert.equal(take(home, 's1').commands.length, 1)
  put(home, 's1', good)
  assert.equal(take(home, 's1').commands.length, 0)
})

test('ops outside the list, too many, too long or with a bad id are refused whole', () => {
  assert.equal(checkOps([{ op: 'rm', path: '/' }]).reason, 'unknown op')
  assert.equal(checkOps([{ op: 'write_policy', text: 'x' }]).reason, 'unknown op')
  assert.deepEqual(checkOps([{ op: 'proposal_decide', id: 'pr-abc123', accept: true, extra: 'x' }]), { ops: [{ op: 'proposal_decide', id: 'pr-abc123', accept: true }] })
  for (const bad of [{ id: '../x', accept: true }, { id: 'pr-1', accept: 'yes' }, { id: 'pr-1' }, { accept: true }]) assert.equal(checkOps([{ op: 'proposal_decide', ...bad }]).reason, 'bad proposal_decide')
  assert.equal(checkOps([{ op: 'proposal_decide', id: 'pr-1', accept: true }, { op: 'lock' }]).reason, 'a setting goes alone')
  assert.deepEqual(checkOps([{ op: 'ask_answer', id: 'a-1', allow: true, by: 'web', extra: 1 }]), { ops: [{ op: 'ask_answer', id: 'a-1', allow: true, by: 'web' }] })
  for (const bad of [{ id: '../x', allow: true, by: 'app' }, { id: 'a-1', allow: 'yes', by: 'app' }, { id: 'a-1', allow: true, by: 'me' }, { id: 'a-1', allow: true }, { allow: true, by: 'app' }]) assert.equal(checkOps([{ op: 'ask_answer', ...bad }]).reason, 'bad ask_answer')
  assert.equal(checkOps([{ op: 'ask_answer', id: 'a-1', allow: true, by: 'app' }, { op: 'lock' }]).reason, 'a setting goes alone')
  assert.equal(checkOps([]).reason, 'bad ops')
  assert.equal(checkOps(Array.from({ length: 21 }, () => ({ op: 'lock' }))).reason, 'bad ops')
  assert.match(checkOps([{ op: 'add_constraint', text: 'x'.repeat(1001) }]).reason, /bad text/)
  assert.match(checkOps([{ op: 'remove_constraint', id: '../x', text: 't' }]).reason, /bad id/)
  assert.match(checkOps([{ op: 'remove_constraint', id: 'c-1' }]).reason, /bad id/)
  assert.equal(checkOps([{ op: 'toggle_constraint', id: 'c-1' }]).reason, 'unknown op')
  assert.match(checkOps([{ op: 'set_priority', id: 'c-1', priority: 'maybe' }]).reason, /bad set_priority/)
  assert.match(checkOps([{ op: 'remove_non_goal', index: 0 }]).reason, /bad index/)
  assert.match(checkOps([{ op: 'set_goal', text: '   ' }]).reason, /bad text/)
  assert.equal(checkOps([{ op: 'remove_non_goal', index: -1 }]).reason, 'bad index')
  assert.deepEqual(checkOps([{ op: 'unlock' }, { op: 'set_goal', text: 'g' }, { op: 'lock' }]).ops.length, 3)
})

test('a link, a large file, a file open to others, or a directory open to others is not trusted', () => {
  const { home, key } = setup()
  const dir = inboxOf(home, 's1')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const real = join(dir, 'real.txt')
  writeFileSync(real, JSON.stringify(signed(key, { id: 'linked' })))
  symlinkSync(real, join(dir, 'linked.json'))
  writeFileSync(join(dir, 'big.json'), JSON.stringify(signed(key, { id: 'big', pad: 'x'.repeat(20000) })), { mode: 0o600 })
  put(home, 's1', signed(key, { id: 'open' }), 0o644)
  assert.deepEqual(take(home, 's1').commands, [])
  put(home, 's1', signed(key, { id: 'fine' }))
  chmodSync(dir, 0o777)
  assert.deepEqual(take(home, 's1').commands, [])
  chmodSync(dir, 0o700)
  assert.equal(take(home, 's1').commands.length, 1)
  chmodSync(join(home, 'key'), 0o644)
  put(home, 's1', signed(key, { id: 'keyopen' }))
  assert.deepEqual(take(home, 's1').commands, [])
})

test('a session id that is not plain, or a missing key, takes nothing', () => {
  const { home, key } = setup()
  assert.deepEqual(take(home, '../x'), { commands: [], rejected: [] })
  put(home, 's1', signed(key, { id: 'a' }))
  const other = join(mkdtempSync(join(tmpdir(), 'swb-chan-')), 'e')
  ensureHome(other)
  assert.deepEqual(take(other, 's1'), { commands: [], rejected: [] })
  assert.equal(sendCommand(home, key, '../x', [{ op: 'lock' }]).ok, false)
  assert.equal(sendCommand(home, key, 's1', [{ op: 'nope' }]).ok, false)
})

test('two takers at once apply a command exactly once', async () => {
  const { home, key } = setup()
  for (let n = 0; n < 8; n++) put(home, 's1', signed(key, { id: `c${n}` }))
  const run = () => new Promise(done => {
    let out = ''
    const child = spawn(process.execPath, [script, 'take', 's1'], { env: { ...process.env, SWB_DESKTOP_HOME: home } })
    child.stdout.on('data', chunk => (out += chunk))
    child.on('close', () => done(JSON.parse(out || '{"commands":[]}').commands.map(one => one.id)))
  })
  const [a, b] = await Promise.all([run(), run()])
  assert.deepEqual([...a, ...b].sort(), Array.from({ length: 8 }, (_, n) => `c${n}`))
})

test('the plugin\'s answer reaches the app, and the app reads only a status it knows', () => {
  const { home, key } = setup()
  put(home, 's1', signed(key, { id: 'r1' }))
  take(home, 's1')
  assert.equal(readAck(home, 'r1'), undefined)
  const run = (id, body) => spawnSync(process.execPath, [script, 'ack', id], { input: body, env: { ...process.env, SWB_DESKTOP_HOME: home } }).status
  assert.equal(run('r1', JSON.stringify({ status: 'applied', rev: 4 })), 0)
  assert.equal(readAck(home, 'r1').status, 'applied')
  assert.equal(run('../x', '{}'), 1)
  assert.equal(statSync(join(home, 'ack', 'r1.json')).mode & 0o077, 0)
  writeFileSync(join(home, 'ack', 'r2.json'), '')
  ack(home, 'r2', { status: 'weird', reason: 'y'.repeat(500) })
  assert.equal(readAck(home, 'r2').status, 'rejected')
  assert.equal(readAck(home, 'r2').reason.length, 200)
})

test('the signature covers every field and does not depend on key order', () => {
  const key = Buffer.alloc(32, 1)
  assert.equal(canonical({ b: 1, a: [2, { d: 1, c: 2 }] }), '{"a":[2,{"c":2,"d":1}],"b":1}')
  const a = sign(key, { x: 1, y: { p: 1, q: 2 } })
  assert.equal(a, sign(key, { y: { q: 2, p: 1 }, x: 1 }))
  assert.notEqual(a, sign(key, { x: 1, y: { p: 1, q: 3 } }))
  assert.notEqual(a, sign(Buffer.alloc(32, 2), { x: 1, y: { p: 1, q: 2 } }))
})

test('old commands and results are removed', () => {
  const { home, key } = setup()
  sendCommand(home, key, 's1', [{ op: 'lock' }], Date.now(), 'old1')
  mkdirSync(join(home, 'ack'), { recursive: true, mode: 0o700 })
  writeFileSync(join(home, 'ack', 'a1.json'), '{}')
  tidy(home, Date.now() + 25 * 3600 * 1000)
  assert.equal(existsSync(join(home, 'ack', 'a1.json')), false)
  assert.deepEqual(readdirSync(inboxOf(home, 's1')), [])
})

test('only a command that was taken can be answered, and only once; a signed but refused one is answered too', () => {
  const { home, key } = setup()
  mkdirSync(join(home, 'ack'), { recursive: true, mode: 0o700 })
  assert.equal(ack(home, 'never', { status: 'applied' }), false)
  put(home, 's1', signed(key, { id: 'late', expiresAt: Date.now() - 1 }))
  assert.deepEqual(take(home, 's1').rejected.map(one => one.id), ['late'])
  assert.equal(ack(home, 'late', { status: 'rejected', reason: 'expired' }), true)
  assert.equal(ack(home, 'late', { status: 'applied' }), false)
  assert.equal(readAck(home, 'late').status, 'rejected')
})

test('an expiry far in the future is refused, a broken key file is replaced, and an inbox that is a link takes nothing', () => {
  const { home, key } = setup()
  put(home, 's1', signed(key, { id: 'far', expiresAt: Date.now() + 24 * 3600 * 1000 }))
  assert.deepEqual(take(home, 's1').rejected.map(one => `${one.id}:${one.reason}`), ['far:bad expiry'])
  writeFileSync(join(home, 'key'), 'short', { mode: 0o600 })
  const fresh = ensureKey(home)
  assert.equal(fresh.length, 32)
  const elsewhere = mkdtempSync(join(tmpdir(), 'swb-chan-'))
  mkdirSync(join(home, 'inbox'), { recursive: true, mode: 0o700 })
  writeFileSync(join(elsewhere, 'c.json'), JSON.stringify(signed(fresh, { id: 'c', target: { kind: 'session', sessionId: 's9' } })), { mode: 0o600 })
  symlinkSync(elsewhere, join(home, 'inbox', 's9'))
  assert.deepEqual(take(home, 's9'), { commands: [], rejected: [] })
})

test('settings are checked field by field and go one to a command', () => {
  assert.equal(checkOps([{ op: 'team_enabled', enabled: 'yes' }]).reason, 'bad team_enabled')
  assert.equal(checkOps([{ op: 'team_role', role: 'boss', model: 'opus' }]).reason, 'bad team_role')
  assert.equal(checkOps([{ op: 'team_role', role: 'lead' }]).reason, 'bad team_role')
  assert.equal(checkOps([{ op: 'team_role', role: 'lead', model: 'op us' }]).reason, 'bad team_role')
  assert.equal(checkOps([{ op: 'team_role', role: 'lead', effort: 'turbo' }]).reason, 'bad team_role')
  assert.equal(checkOps([{ op: 'set_profile', profile: 'lax' }]).reason, 'bad set_profile')
  assert.equal(checkOps([{ op: 'pause', on: 1 }]).reason, 'bad pause')
  assert.equal(checkOps([{ op: 'set_profile', profile: 'strict' }, { op: 'lock' }]).reason, 'a setting goes alone')
  assert.deepEqual(checkOps([{ op: 'team_role', role: 'advisor', model: 'claude-opus-5-5', effort: 'high', extra: 1 }]).ops, [{ op: 'team_role', role: 'advisor', model: 'claude-opus-5-5', effort: 'high' }])
  assert.equal(checkOps([{ op: 'codex', enabled: true }]).ops.length, 1)
})

test('guard file edits: only ask and block rules are added, every edit quotes the file it saw, and a setting goes alone', () => {
  const base = 'a'.repeat(64)
  const rule = { policy: 'block', tool: 'Bash', command: 'npm\\s+publish', reason: 'manual' }
  assert.deepEqual(checkOps([{ op: 'policy_add_rule', base, rule }]).ops, [{ op: 'policy_add_rule', base, rule }])
  assert.deepEqual(checkOps([{ op: 'policy_add_rule', base: null, rule: { policy: 'ask', path: 'migrations/**' } }]).ops?.[0].base, null)
  assert.deepEqual(checkOps([{ op: 'policy_remove_rule', base, index: 3, policy: 'block' }]).ops, [{ op: 'policy_remove_rule', base, index: 3, policy: 'block' }])
  assert.deepEqual(checkOps([{ op: 'policy_set_profile', base, profile: null }]).ops, [{ op: 'policy_set_profile', base, profile: null }])
  for (const bad of [
    { op: 'policy_add_rule', base, rule: { policy: 'allow', tool: 'Bash' } },
    { op: 'policy_add_rule', rule },
    { op: 'policy_add_rule', base: 'x', rule },
    { op: 'policy_add_rule', base, rule: { policy: 'ask' } },
    { op: 'policy_add_rule', base, rule: { policy: 'ask', command: '(' } },
    { op: 'policy_add_rule', base, rule: { policy: 'ask', command: 'x'.repeat(301) } },
    { op: 'policy_add_rule', base, rule: { policy: 'ask', tool: 'Bash', reason: 'r'.repeat(201) } },
    { op: 'policy_remove_rule', base, index: 'x', policy: 'ask' },
    { op: 'policy_remove_rule', base: null, index: 0, policy: 'ask' },
    { op: 'policy_remove_rule', base, index: 0, policy: 'maybe' },
    { op: 'policy_set_profile', base, profile: 'off' },
    { op: 'policy_set_profile', profile: 'strict' },
  ]) assert.ok(checkOps([bad]).reason, JSON.stringify(bad))
  assert.equal(checkOps([{ op: 'policy_set_profile', base, profile: 'strict' }, { op: 'lock' }]).reason, 'a setting goes alone')
})

test('policy_reload carries nothing; a template op is cleaned or refused whole', () => {
  assert.deepEqual(checkOps([{ op: 'policy_reload', path: '/etc/passwd' }]), { ops: [{ op: 'policy_reload' }] })
  assert.equal(checkOps([{ op: 'policy_reload' }, { op: 'lock' }]).reason, 'a setting goes alone')
  const template = { goal: ' g ', constraints: [{ text: 'a', priority: 'soft' }], doneConditions: [{ text: 'b', link: 'test' }], extra: 1 }
  assert.deepEqual(checkOps([{ op: 'policy_set_template', base: null, name: 'bugfix', template }]), { ops: [{ op: 'policy_set_template', base: null, name: 'bugfix', template: { goal: 'g', constraints: [{ text: 'a', priority: 'soft' }], nonGoals: [], doneConditions: [{ text: 'b', link: 'test' }] } }] })
  assert.deepEqual(checkOps([{ op: 'policy_set_template', base: 'a'.repeat(64), name: 'x', template: null }]), { ops: [{ op: 'policy_set_template', base: 'a'.repeat(64), name: 'x', template: null }] })
  const many = Array.from({ length: 21 }, () => ({ text: 'a', priority: 'hard' }))
  for (const bad of [{ name: '__proto__' }, { name: 'constructor' }, { name: 'a b' }, { name: '' }, { base: 'nope' }, { base: undefined }, { template: { constraints: [], doneConditions: [] } }, { template: { ...template, constraints: many } }, { template: { ...template, doneConditions: [{ text: 'b', link: 'rm' }] } }, { template: [] }]) {
    assert.equal(checkOps([{ op: 'policy_set_template', base: null, name: 'ok', template, ...bad }]).reason, 'bad policy_set_template')
  }
})
