#!/usr/bin/env node
// The command channel between the desktop app and a session's plugin, for the plugin side and for tests.
//   node desktop-channel.mjs take <sessionId>      prints {"commands":[...],"rejected":[...]} for the commands waiting for that session
//   node desktop-channel.mjs ack <commandId>       writes the result (JSON on stdin) where the app reads it
// The app writes a command file into <home>/inbox/<sessionId>/, signed with the key in <home>/key. A command is taken only if it is a
// small plain file of ours, signed, not expired, for this session, and not seen before (the ack file is created exclusively).
import { createHmac, timingSafeEqual } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { desktopHome } from './desktop-state.mjs'

export const MAX_COMMAND_BYTES = 16 * 1024
export const MAX_OPS = 20
export const TEXT_MAX = 1000
export const ID_RE = /^[A-Za-z0-9_-]{1,64}$/
const ITEM_ID_RE = /^[A-Za-z0-9_-]{1,40}$/

export const canonical = value => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

export const sign = (key, command) => {
  const { mac: _mac, ...body } = command
  return createHmac('sha256', key).update(canonical(body)).digest('hex')
}

export function macOk(key, command) {
  if (typeof command?.mac !== 'string' || !/^[0-9a-f]{64}$/.test(command.mac)) return false
  return timingSafeEqual(Buffer.from(sign(key, command), 'hex'), Buffer.from(command.mac, 'hex'))
}

const TEXT_OPS = new Set(['set_goal', 'add_constraint', 'add_done_condition', 'add_non_goal'])
// A change names what it expects to find (the item's text, the target state), so a command written from an old view is refused, not misapplied.
const REMOVE_OPS = new Set(['remove_constraint', 'remove_done_condition'])
const BARE_OPS = new Set(['lock', 'unlock'])
// Settings of the session, not of the contract: one per command, so its answer says what happened to it.
export const SETTING_OPS = new Set(['team_enabled', 'team_role', 'codex', 'set_profile', 'pause', 'policy_add_rule', 'policy_remove_rule', 'policy_set_profile'])
const HASH_RE = /^[0-9a-f]{64}$/
const RULE_FIELD_MAX = 300
const RULE_REASON_MAX = 200
const regexOk = source => {
  try {
    new RegExp(source)
    return true
  } catch {
    return false
  }
}
const ROLE_NAMES = new Set(['lead', 'explorer', 'advisor'])
const EFFORT_NAMES = new Set(['default', 'low', 'medium', 'high', 'xhigh', 'max'])
const PROFILES = new Set(['off', 'permissive', 'balanced', 'strict'])
const MODEL_RE = /^[A-Za-z0-9._:[\]-]{1,64}$/

/** The ops of a command, cleaned, or a reason it is refused. Nothing outside this list is ever applied. */
export function checkOps(ops) {
  if (!Array.isArray(ops) || ops.length === 0 || ops.length > MAX_OPS) return { reason: 'bad ops' }
  const clean = []
  for (const one of ops) {
    const op = typeof one?.op === 'string' ? one.op : ''
    if (TEXT_OPS.has(op)) {
      const text = typeof one.text === 'string' ? one.text.trim() : ''
      if (text === '' || text.length > TEXT_MAX) return { reason: `bad text in ${op}` }
      clean.push({ op, text })
    } else if (REMOVE_OPS.has(op)) {
      const text = typeof one.text === 'string' ? one.text.trim() : ''
      if (typeof one.id !== 'string' || !ITEM_ID_RE.test(one.id) || text === '' || text.length > TEXT_MAX) return { reason: `bad id in ${op}` }
      clean.push({ op, id: one.id, text })
    } else if (op === 'set_active') {
      if (typeof one.id !== 'string' || !ITEM_ID_RE.test(one.id) || typeof one.isActive !== 'boolean') return { reason: 'bad set_active' }
      clean.push({ op, id: one.id, isActive: one.isActive })
    } else if (op === 'set_priority') {
      if (typeof one.id !== 'string' || !ITEM_ID_RE.test(one.id) || (one.priority !== 'hard' && one.priority !== 'soft')) return { reason: 'bad set_priority' }
      clean.push({ op, id: one.id, priority: one.priority })
    } else if (op === 'remove_non_goal') {
      const text = typeof one.text === 'string' ? one.text.trim() : ''
      if (!Number.isInteger(one.index) || one.index < 0 || one.index > 1000 || text === '' || text.length > TEXT_MAX) return { reason: 'bad index' }
      clean.push({ op, index: one.index, text })
    } else if (op === 'team_enabled' || op === 'codex') {
      if (typeof one.enabled !== 'boolean') return { reason: `bad ${op}` }
      clean.push({ op, enabled: one.enabled })
    } else if (op === 'team_role') {
      const model = one.model === undefined ? undefined : one.model
      const effort = one.effort === undefined ? undefined : one.effort
      if (!ROLE_NAMES.has(one.role) || (model === undefined && effort === undefined)) return { reason: 'bad team_role' }
      if (model !== undefined && (typeof model !== 'string' || !MODEL_RE.test(model))) return { reason: 'bad team_role' }
      if (effort !== undefined && !EFFORT_NAMES.has(effort)) return { reason: 'bad team_role' }
      clean.push({ op, role: one.role, ...(model !== undefined ? { model } : {}), ...(effort !== undefined ? { effort } : {}) })
    } else if (op === 'set_profile') {
      if (!PROFILES.has(one.profile)) return { reason: 'bad set_profile' }
      clean.push({ op, profile: one.profile })
    } else if (op === 'policy_add_rule') {
      // Only ask and block: a rule that allows would loosen the guard, and it is added at the end, so it never shadows an earlier rule.
      const rule = one.rule
      const base = one.base === null || (typeof one.base === 'string' && HASH_RE.test(one.base)) ? one.base : undefined
      if (base === undefined || rule === null || typeof rule !== 'object' || (rule.policy !== 'ask' && rule.policy !== 'block')) return { reason: 'bad policy_add_rule' }
      const clean1 = { policy: rule.policy }
      for (const key of ['tool', 'command', 'path']) {
        if (rule[key] === undefined) continue
        if (typeof rule[key] !== 'string' || rule[key].trim() === '' || rule[key].length > RULE_FIELD_MAX) return { reason: 'bad policy_add_rule' }
        clean1[key] = rule[key]
      }
      if (rule.reason !== undefined) {
        if (typeof rule.reason !== 'string' || rule.reason.length > RULE_REASON_MAX) return { reason: 'bad policy_add_rule' }
        if (rule.reason.trim() !== '') clean1.reason = rule.reason.trim()
      }
      if (clean1.tool === undefined && clean1.command === undefined && clean1.path === undefined) return { reason: 'bad policy_add_rule' }
      // The plugin matches a tool as ^(?:tool)$, so that form has to compile too.
      if ((clean1.tool !== undefined && !regexOk(`^(?:${clean1.tool})$`)) || (clean1.command !== undefined && !regexOk(clean1.command))) return { reason: 'bad policy_add_rule' }
      clean.push({ op, base, rule: clean1 })
    } else if (op === 'policy_remove_rule') {
      if (typeof one.base !== 'string' || !HASH_RE.test(one.base) || !Number.isInteger(one.index) || one.index < 0 || one.index > 1000 || !['allow', 'ask', 'block'].includes(one.policy)) return { reason: 'bad policy_remove_rule' }
      clean.push({ op, base: one.base, index: one.index, policy: one.policy })
    } else if (op === 'policy_set_profile') {
      const base = one.base === null || (typeof one.base === 'string' && HASH_RE.test(one.base)) ? one.base : undefined
      if (base === undefined || (one.profile !== null && !['permissive', 'balanced', 'strict'].includes(one.profile))) return { reason: 'bad policy_set_profile' }
      clean.push({ op, base, profile: one.profile })
    } else if (op === 'pause') {
      if (typeof one.on !== 'boolean') return { reason: 'bad pause' }
      clean.push({ op, on: one.on })
    } else if (BARE_OPS.has(op)) clean.push({ op })
    else return { reason: 'unknown op' }
  }
  if (clean.some(one => SETTING_OPS.has(one.op)) && clean.length !== 1) return { reason: 'a setting goes alone' }
  return { ops: clean }
}

const ownDir = path => {
  const info = lstatSync(path)
  if (!info.isDirectory()) return false
  if (typeof process.getuid === 'function' && (info.uid !== process.getuid() || (info.mode & 0o022) !== 0)) return false
  return true
}

// Opens without following a link and checks the file that was opened, not the name: nothing can be swapped in between.
function readOwn(path, max) {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const info = fstatSync(fd)
    if (!info.isFile() || info.size > max) throw new Error('not a plain file')
    if (typeof process.getuid === 'function' && (info.uid !== process.getuid() || (info.mode & 0o077) !== 0)) throw new Error('not ours or open to others')
    return readFileSync(fd)
  } finally {
    closeSync(fd)
  }
}

function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.tmp`
  try {
    writeFileSync(tmp, text, { mode: 0o600, flag: 'wx' })
    renameSync(tmp, file)
  } catch (error) {
    try {
      unlinkSync(tmp)
    } catch {
      // Nothing to remove.
    }
    throw error
  }
}

/** The commands waiting for one session. A command is consumed (file removed, ack claimed) whether it is accepted or refused. */
export function take(home, sessionId, now = Date.now()) {
  const out = { commands: [], rejected: [] }
  if (!ID_RE.test(sessionId)) return out
  let key
  let names
  const inbox = join(home, 'inbox', sessionId)
  try {
    if (!ownDir(home) || !ownDir(join(home, 'inbox')) || !ownDir(inbox)) return out
    key = readOwn(join(home, 'key'), 64)
    if (key.length !== 32) return out
    names = readdirSync(inbox).filter(name => /^[A-Za-z0-9_-]{1,64}\.json$/.test(name)).slice(0, 20)
  } catch {
    return out
  }
  const ackDir = join(home, 'ack')
  try {
    mkdirSync(ackDir, { recursive: true, mode: 0o700 })
    if (!ownDir(ackDir)) return out
  } catch {
    return out
  }
  for (const name of names) {
    const file = join(inbox, name)
    const id = name.slice(0, -5)
    let command
    try {
      command = JSON.parse(readOwn(file, MAX_COMMAND_BYTES).toString('utf8'))
    } catch {
      removeQuietly(file)
      continue
    }
    removeQuietly(file)
    let reason
    const checked = checkOps(command?.ops)
    if (command?.v !== 1 || command.id !== id) reason = 'bad command'
    else if (!macOk(key, command)) reason = 'bad signature'
    else if (!Number.isFinite(command.expiresAt) || command.expiresAt < now) reason = 'expired'
    // The app gives ten minutes; much more means a clock set back, which would let an old command through after its ack was tidied.
    else if (command.expiresAt > now + 15 * 60 * 1000) reason = 'bad expiry'
    else if (command.target?.kind !== 'session' || command.target.sessionId !== sessionId) reason = 'wrong target'
    else if (checked.reason) reason = checked.reason
    // A forged or malformed file gets no ack: the app only learns about commands it signed. Every signed one is claimed (replays stop here).
    if (reason === 'bad signature' || reason === 'bad command') continue
    try {
      closeSync(openSync(join(ackDir, `${id}.json`), 'wx', 0o600))
    } catch {
      continue
    }
    if (reason) {
      out.rejected.push({ id, reason })
      continue
    }
    out.commands.push({ id, createdAt: Number(command.createdAt) || 0, expiresAt: command.expiresAt, ops: checked.ops })
  }
  out.commands.sort((a, b) => a.createdAt - b.createdAt)
  return out
}

function removeQuietly(file) {
  try {
    unlinkSync(file)
  } catch {
    // Already gone.
  }
}

/** Writes a command's result. Only for a command id that was taken (its ack file exists), only by status and a short reason. */
export function ack(home, id, result) {
  if (!ID_RE.test(id)) return false
  const dir = join(home, 'ack')
  if (!ownDir(home) || !ownDir(dir)) return false
  // Only a command that was taken (its ack file was claimed empty) gets an answer, and only once.
  try {
    const claimed = lstatSync(join(dir, `${id}.json`))
    if (!claimed.isFile() || claimed.size !== 0) return false
  } catch {
    return false
  }
  const status = ['applied', 'rejected', 'declined'].includes(result?.status) ? result.status : 'rejected'
  const body = { status, ...(Number.isInteger(result?.rev) ? { rev: result.rev } : {}), ...(typeof result?.reason === 'string' ? { reason: result.reason.slice(0, 200) } : {}), at: Date.now() }
  writeAtomic(join(dir, `${id}.json`), JSON.stringify(body))
  return true
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [verb, arg = ''] = process.argv.slice(2)
  const home = desktopHome()
  try {
    if (verb === 'take') process.stdout.write(JSON.stringify(take(home, arg)))
    else if (verb === 'ack') process.exit(ack(home, arg, JSON.parse(readFileSync(0, 'utf8'))) ? 0 : 1)
    else process.exit(2)
  } catch {
    process.exit(1)
  }
}
