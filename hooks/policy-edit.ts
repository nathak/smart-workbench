import type { GuardProfile, Policy } from '../types'
import { parsePolicy } from './policy'
import { redact } from './risk'

export type PolicyEditOp =
  | { op: 'policy_add_rule'; base: string | null; rule: { policy: 'ask' | 'block'; tool?: string; command?: string; path?: string; reason?: string } }
  | { op: 'policy_remove_rule'; base: string; index: number; policy: Policy }
  | { op: 'policy_set_profile'; base: string | null; profile: Exclude<GuardProfile, 'off'> | null }
  | { op: 'policy_set_template'; base: string | null; name: string; template: EditableTemplate | null }

export type EditableTemplate = {
  goal?: string
  constraints: { text: string; priority: 'hard' | 'soft' }[]
  nonGoals: string[]
  doneConditions: { text: string; link?: 'test' | 'build' | 'typecheck' | 'lint' | 'ci' }[]
}
const TEMPLATES_MAX = 30
const FORBIDDEN_NAMES = new Set(['__proto__', 'constructor', 'prototype'])
const has = (object: object, key: string): boolean => Object.prototype.hasOwnProperty.call(object, key)

export type PolicyEdit = { text: string; lowers: boolean; summary: string } | { reason: string }

const PROFILE_RANK: Record<string, number> = { permissive: 0, balanced: 1, strict: 2 }
const rank = (profile: unknown): number => (typeof profile === 'string' ? (PROFILE_RANK[profile] ?? -1) : -1)

export function isPolicyEditOp(one: { op: string }): one is PolicyEditOp {
  return one.op === 'policy_add_rule' || one.op === 'policy_remove_rule' || one.op === 'policy_set_profile' || one.op === 'policy_set_template'
}

// The first indented line of the file decides the indent; a file with none gets two spaces.
function indentOf(text: string): string | number {
  const found = /^([ \t]+)\S/m.exec(text)

  return found?.[1]?.includes('\t') ? '\t' : (found?.[1]?.length ?? 2)
}

/**
 * The text the guard file has after one app edit, and whether the edit makes the guard watch less (it is then asked in the session).
 * Whether the edit loosens is worked out here from the file as it is on disk, never from what the app says.
 * Unknown keys and their order are kept; a file that does not parse is never rewritten.
 */
export function editPolicy(original: string | undefined, op: PolicyEditOp): PolicyEdit {
  const bom = original?.startsWith('﻿') ? '﻿' : ''
  const body = original === undefined ? undefined : original.slice(bom.length)
  const crlf = body !== undefined && body.includes('\r\n')
  const finalNewline = body === undefined || /\n$/.test(body)

  let doc: Record<string, unknown>
  if (body === undefined) {
    if (op.base !== null || op.op === 'policy_remove_rule' || (op.op === 'policy_set_template' && op.template === null)) return { reason: 'stale' }
    doc = {}
  } else {
    let parsed: unknown
    try {
      parsed = JSON.parse(body)
    } catch {
      return { reason: 'policy file is broken' }
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { reason: 'policy file is broken' }
    doc = parsed as Record<string, unknown>
    if (doc.rules !== undefined && !Array.isArray(doc.rules)) return { reason: 'policy file is broken' }
  }

  let lowers = false
  let summary: string
  if (op.op === 'policy_add_rule') {
    const rules = Array.isArray(doc.rules) ? [...doc.rules] : []
    rules.push({ policy: op.rule.policy, ...(op.rule.tool !== undefined ? { tool: op.rule.tool } : {}), ...(op.rule.command !== undefined ? { command: op.rule.command } : {}), ...(op.rule.path !== undefined ? { path: op.rule.path } : {}), ...(op.rule.reason !== undefined ? { reason: op.rule.reason } : {}) })
    doc = { ...doc, rules }
    summary = `add ${op.rule.policy} rule`
  } else if (op.op === 'policy_remove_rule') {
    const rules = Array.isArray(doc.rules) ? [...doc.rules] : []
    const target = rules[op.index] as { policy?: unknown } | null | undefined
    if (target === undefined || typeof target !== 'object' || target === null) return { reason: 'unknown rule' }
    if (target.policy !== op.policy) return { reason: 'stale' }
    // Anything that is not an allow rule watches something; a rule that cannot be read is treated the same.
    lowers = target.policy !== 'allow'
    rules.splice(op.index, 1)
    doc = { ...doc, rules }
    const rule = target as { tool?: unknown; command?: unknown; path?: unknown }
    const shown = (['tool', 'command', 'path'] as const).flatMap(key => (typeof rule[key] === 'string' ? [`${key}=${rule[key]}`] : [])).join(' ')
    summary = `remove ${op.policy} rule ${op.index + 1} (${redact(shown).slice(0, 120)})`
  } else if (op.op === 'policy_set_template') {
    if (FORBIDDEN_NAMES.has(op.name)) return { reason: 'invalid' }
    if (doc.templates !== undefined && (typeof doc.templates !== 'object' || doc.templates === null || Array.isArray(doc.templates))) return { reason: 'policy file is broken' }
    const templates = { ...((doc.templates as Record<string, unknown> | undefined) ?? {}) }
    if (op.template === null) {
      if (!has(templates, op.name)) return { reason: 'unknown template' }
      // The default would point at nothing, and the file would then carry an error it did not have.
      if (doc.defaultTemplate === op.name) return { reason: 'default template' }
      delete templates[op.name]
      summary = `remove template ${op.name}`
    } else {
      if (!has(templates, op.name) && Object.keys(templates).length >= TEMPLATES_MAX) return { reason: 'too many templates' }
      const written = {
        ...(op.template.goal !== undefined ? { goal: op.template.goal } : {}),
        // parseTemplates reads a leading "h:" or "s:" as the priority, so a hard text that starts like one is written with its own prefix.
        constraints: op.template.constraints.map(one => (one.priority === 'soft' ? `s: ${one.text}` : /^\s*[hs]\s*:/i.test(one.text) ? `h: ${one.text}` : one.text)),
        nonGoals: op.template.nonGoals,
        doneConditions: op.template.doneConditions.map(one => (one.link ? { text: one.text, link: one.link } : one.text)),
      }
      // A shared file is read by the team: text that looks like a secret is refused, not quietly changed. Each text is checked as it is
      // (escaping inside a JSON string could hide a pattern), and so is the name.
      const texts = [op.name, op.template.goal ?? '', ...op.template.constraints.map(one => one.text), ...op.template.nonGoals, ...op.template.doneConditions.map(one => one.text)]
      if (texts.some(text => redact(text) !== text)) return { reason: 'looks like a secret' }
      templates[op.name] = written
      summary = `save template ${op.name}`
    }
    doc = { ...doc, templates }
  } else {
    const before = doc.profile
    if (op.profile === null) {
      const { profile: _gone, ...rest } = doc
      doc = rest
      lowers = before !== undefined
    } else {
      lowers = rank(op.profile) < rank(before)
      doc = 'profile' in doc ? { ...doc, profile: op.profile } : { profile: op.profile, ...doc }
    }
    summary = `profile ${typeof before === 'string' ? before : '(none)'} → ${op.profile ?? '(none)'}`
  }

  let out = JSON.stringify(doc, null, indentOf(body ?? ''))
  if (finalNewline) out += '\n'
  if (crlf) out = out.replace(/\r?\n/g, '\r\n')
  out = bom + out

  // The result must not carry an error the file did not have: a rule that cannot be read would be skipped, and the guard would watch less.
  // (Counted, not compared by text: a message names the rule's number, which a removal shifts.)
  // A template edit leaves everything else of the guard exactly as it was: the rules, profile, audit and contract settings read the same.
  if (op.op === 'policy_set_template') {
    const guardOf = (text: string): string => {
      const read = parsePolicy(text)
      return JSON.stringify([read.rules, read.profile, read.audit, read.requireContract, read.ledger])
    }
    if (guardOf(body ?? '{}') !== guardOf(out.slice(bom.length))) return { reason: 'invalid' }
  }

  const had = original === undefined ? 0 : parsePolicy(body ?? '').errors.length
  if (parsePolicy(out.slice(bom.length)).errors.length > had) return { reason: 'invalid' }

  return { text: out, lowers, summary }
}
