import { describe, expect, test } from 'claude-code/testing'

import { parsePolicy } from '../hooks/policy'
import { editPolicy, type PolicyEditOp } from '../hooks/policy-edit'

const add = (rule: { policy: 'ask' | 'block'; tool?: string; command?: string; path?: string; reason?: string }, base: string | null = 'h'): PolicyEditOp => ({ op: 'policy_add_rule', base, rule })
const remove = (index: number, policy: 'allow' | 'ask' | 'block'): PolicyEditOp => ({ op: 'policy_remove_rule', base: 'h', index, policy })
const profile = (value: 'permissive' | 'balanced' | 'strict' | null): PolicyEditOp => ({ op: 'policy_set_profile', base: 'h', profile: value })

const FILE = `${JSON.stringify({ profile: 'balanced', extra: { keep: 1 }, rules: [{ tool: 'Bash', command: 'a', policy: 'block' }, { tool: 'Bash', command: 'b', policy: 'allow' }] }, null, 2)}\n`

describe('editing the guard file', () => {
  test('a rule is added at the end, and what the file already holds is kept', () => {
    const out = editPolicy(FILE, add({ policy: 'ask', tool: 'Bash', command: 'x' }))
    if ('reason' in out) throw new Error(out.reason)
    const doc = JSON.parse(out.text)
    expect(doc.extra).toEqual({ keep: 1 })
    expect(doc.rules).toHaveLength(3)
    expect(doc.rules[2]).toEqual({ policy: 'ask', tool: 'Bash', command: 'x' })
    expect(Object.keys(doc)).toEqual(['profile', 'extra', 'rules'])
    expect(out.lowers).toBe(false)
    expect(out.text.endsWith('\n')).toBe(true)
  })

  test('indent, tabs, CRLF, BOM and the missing final newline are kept', () => {
    const tabs = editPolicy('{\n\t"rules": []\n}', add({ policy: 'block', tool: 'Bash' }))
    if ('reason' in tabs) throw new Error(tabs.reason)
    expect(tabs.text).toContain('\n\t"rules"')
    expect(tabs.text.endsWith('\n')).toBe(false)
    const four = editPolicy('{\n    "rules": []\n}\n', add({ policy: 'block', tool: 'Bash' }))
    if ('reason' in four) throw new Error(four.reason)
    expect(four.text).toContain('\n    "rules"')
    const crlf = editPolicy('﻿{\r\n  "rules": []\r\n}\r\n', add({ policy: 'block', tool: 'Bash' }))
    if ('reason' in crlf) throw new Error(crlf.reason)
    expect(crlf.text.startsWith('﻿{')).toBe(true)
    expect(crlf.text.replace(/\r\n/g, '')).not.toContain('\n')
  })

  test('with no file, a rule makes one; any other expectation of a missing file is stale', () => {
    const made = editPolicy(undefined, add({ policy: 'block', path: 'migrations/**' }, null))
    if ('reason' in made) throw new Error(made.reason)
    expect(parsePolicy(made.text).rules).toHaveLength(1)
    expect(editPolicy(undefined, remove(0, 'block'))).toEqual({ reason: 'stale' })
    expect(editPolicy(undefined, add({ policy: 'ask', tool: 'Bash' }, 'h'))).toEqual({ reason: 'stale' })
  })

  test('a rule is removed by its place in the file, also behind a rule that cannot be read', () => {
    const text = JSON.stringify({ rules: [{ policy: 'ask' }, { tool: 'Bash', command: 'a', policy: 'block' }, { tool: 'Bash', command: 'b', policy: 'allow' }] })
    // The first rule is broken (nothing to match), so the parsed list starts at the second.
    expect(parsePolicy(text).ruleAt).toEqual([1, 2])
    const out = editPolicy(text, remove(2, 'allow'))
    if ('reason' in out) throw new Error(out.reason)
    expect(JSON.parse(out.text).rules.map((one: { command?: string }) => one.command)).toEqual([undefined, 'a'])
    expect(editPolicy(text, remove(2, 'block'))).toEqual({ reason: 'stale' })
    expect(editPolicy(text, remove(9, 'block'))).toEqual({ reason: 'unknown rule' })
  })

  test('only an edit that makes the guard watch less is marked as lowering it', () => {
    expect(editPolicy(FILE, remove(1, 'allow'))).toMatchObject({ lowers: false })
    expect(editPolicy(FILE, remove(0, 'block'))).toMatchObject({ lowers: true })
    expect(editPolicy(FILE, profile('strict'))).toMatchObject({ lowers: false })
    expect(editPolicy(FILE, profile('balanced'))).toMatchObject({ lowers: false })
    expect(editPolicy(FILE, profile('permissive'))).toMatchObject({ lowers: true })
    expect(editPolicy(FILE, profile(null))).toMatchObject({ lowers: true })
    expect(editPolicy('{"rules":[]}', profile('permissive'))).toMatchObject({ lowers: false })
    expect(editPolicy('{"rules":[]}', profile(null))).toMatchObject({ lowers: false })
  })

  test('a profile that was not there is put first', () => {
    const out = editPolicy('{"rules":[]}', profile('strict'))
    if ('reason' in out) throw new Error(out.reason)
    expect(Object.keys(JSON.parse(out.text))).toEqual(['profile', 'rules'])
  })

  test('a file that does not parse, or is not an object, is never rewritten', () => {
    for (const text of ['{ not json', '[]', '"x"', '{"rules": 3}']) expect(editPolicy(text, add({ policy: 'ask', tool: 'Bash' }))).toEqual({ reason: 'policy file is broken' })
  })

  test('an edit that would leave a new error in the file is refused', () => {
    expect(editPolicy(FILE, add({ policy: 'ask', tool: 'Bash', command: '(' }))).toEqual({ reason: 'invalid' })
    // An error the file already had does not stop an unrelated edit.
    const sick = '{"profile":"loud","rules":[]}'
    expect(editPolicy(sick, add({ policy: 'ask', tool: 'Bash' }))).toHaveProperty('text')
  })

  test('the summary names what is removed and the profile before and after, so the question in the session can be understood', () => {
    expect(editPolicy(FILE, remove(0, 'block'))).toMatchObject({ summary: expect.stringContaining('command=a') })
    expect(editPolicy(FILE, profile('permissive'))).toMatchObject({ summary: 'profile balanced → permissive' })
    expect(editPolicy(FILE, profile(null))).toMatchObject({ summary: 'profile balanced → (none)' })
  })
})

describe('editing the templates of the guard file', () => {
  const tpl = (name: string, template: Extract<PolicyEditOp, { op: 'policy_set_template' }>['template'], base: string | null = 'h'): PolicyEditOp => ({ op: 'policy_set_template', base, name, template })
  const body = { goal: 'fix it', constraints: [{ text: 'no deps', priority: 'hard' as const }, { text: 'small diff', priority: 'soft' as const }], nonGoals: ['refactor'], doneConditions: [{ text: 'tests pass', link: 'test' as const }, { text: 'reviewed' }] }
  const WITH = `${JSON.stringify({ profile: 'strict', audit: true, requireContract: true, rules: [{ tool: 'Bash', command: 'a', policy: 'block' }], templates: { old: { constraints: ['x'] } }, defaultTemplate: 'old' }, null, 2)}\n`
  const guardOf = (text: string) => { const p = parsePolicy(text); return JSON.stringify([p.rules, p.profile, p.audit, p.requireContract]) }

  test('a template is added and read back; rules, profile and audit stay as they were', () => {
    const out = editPolicy(WITH, tpl('bugfix', body))
    if ('reason' in out) throw new Error(out.reason)
    const read = parsePolicy(out.text)
    expect(read.errors).toEqual([])
    expect(read.templates.map(one => one.name)).toEqual(['old', 'bugfix'])
    const got = read.templates.find(one => one.name === 'bugfix')
    expect(got?.constraints).toEqual([{ text: 'no deps', priority: 'hard' }, { text: 'small diff', priority: 'soft' }])
    expect(got?.doneConditions).toEqual([{ text: 'tests pass', link: 'test' }, { text: 'reviewed' }])
    expect(guardOf(out.text)).toBe(guardOf(WITH))
    expect(out.lowers).toBe(false)
  })

  test('a hard constraint that starts like a priority prefix keeps its meaning', () => {
    const out = editPolicy(WITH, tpl('t', { constraints: [{ text: 's: odd', priority: 'hard' }], nonGoals: [], doneConditions: [] }))
    if ('reason' in out) throw new Error(out.reason)
    expect(parsePolicy(out.text).templates.find(one => one.name === 't')?.constraints).toEqual([{ text: 's: odd', priority: 'hard' }])
  })

  test('a template is replaced in place and removed; the default one cannot be removed', () => {
    const replaced = editPolicy(WITH, tpl('old', body))
    if ('reason' in replaced) throw new Error(replaced.reason)
    expect(parsePolicy(replaced.text).templates).toHaveLength(1)
    expect(editPolicy(WITH, tpl('old', null))).toEqual({ reason: 'default template' })
    expect(editPolicy(WITH, tpl('nope', null))).toEqual({ reason: 'unknown template' })
    const added = editPolicy(WITH, tpl('b', body))
    if ('reason' in added) throw new Error(added.reason)
    const gone = editPolicy(added.text, tpl('b', null))
    if ('reason' in gone) throw new Error(gone.reason)
    expect(parsePolicy(gone.text).errors).toEqual([])
  })

  test('text that looks like a secret is refused, not changed', () => {
    const out = editPolicy(WITH, tpl('s', { constraints: [{ text: 'use ghp_abcdefghijklmnopqrstuvwxyz0123456789 here', priority: 'hard' }], nonGoals: [], doneConditions: [] }))
    expect(out).toEqual({ reason: 'looks like a secret' })
  })

  test('a name that is an object property is refused; a broken file is never rewritten; a missing file is made', () => {
    expect(editPolicy(WITH, tpl('__proto__', body))).toEqual({ reason: 'invalid' })
    expect(editPolicy('{ nope', tpl('t', body))).toEqual({ reason: 'policy file is broken' })
    expect(editPolicy(JSON.stringify({ templates: [] }), tpl('t', body))).toEqual({ reason: 'policy file is broken' })
    const made = editPolicy(undefined, tpl('t', body, null))
    if ('reason' in made) throw new Error(made.reason)
    expect(parsePolicy(made.text).templates.map(one => one.name)).toEqual(['t'])
    expect(editPolicy(undefined, tpl('t', null, null))).toEqual({ reason: 'stale' })
  })
})
