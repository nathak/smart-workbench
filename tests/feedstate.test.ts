import { describe, expect, test } from 'claude-code/testing'

import { feedStateOf, SNAPSHOT_MAX_BYTES, snapshotText } from '../hooks/desktop'
import { parsePolicy } from '../hooks/policy'
import type { Live, Workbench } from '../types'

const base = (team: unknown) => ({ task: { goal: 'g', status: 'active', locked: false, doneConditions: [], constraints: [], nonGoals: [] }, execution: { profile: 'balanced', isPaused: false }, context: { pins: [] }, changed: { files: [], added: 0, removed: 0, edits: {} }, evidence: [], proposals: [], team }) as unknown as Workbench

describe('the team part of the live feed state', () => {
  test('roles, efforts and the codex switches come as short masked texts, and the gate limits as numbers', () => {
    const state = feedStateOf(base({ enabled: true, lead: { model: 'sonnet', effort: 'default' }, explorer: { model: 'haiku'.padEnd(90, 'x'), effort: 'low' }, advisor: { model: 'API_KEY=abc123secretvalue', effort: 'max' }, codex: { enabled: true, review: true, rescue: false } }), {} as Live)
    expect(state.roles.lead).toBe('sonnet')
    expect(state.roles.explorer).toHaveLength(40)
    expect(JSON.stringify(state.roles)).not.toContain('abc123secretvalue')
    expect(state.efforts).toEqual({ lead: 'default', explorer: 'low', advisor: 'max' })
    expect(state).toMatchObject({ codex: true, codexReview: true, codexRescue: false })
    expect(state.gates).toEqual({ editLines: 6, editChars: 400, turnLines: 15, repeat: 2 })
  })

  test('without a team every role is null and the switches are off', () => {
    const state = feedStateOf(base(undefined), {} as Live)
    expect(state.roles).toEqual({ lead: null, explorer: null, advisor: null })
    expect(state.efforts).toEqual({ lead: null, explorer: null, advisor: null })
    expect(state).toMatchObject({ team: false, codex: false, codexReview: false, codexRescue: false })
  })
})

describe('the guard file templates in the app snapshot', () => {
  const live = (templates: Record<string, unknown>) => ({ policy: { ...parsePolicy(JSON.stringify({ templates })), hash: 'a'.repeat(64) } }) as unknown as Live
  const filed = (text: string | undefined) => (text === undefined ? undefined : JSON.parse(text).guard.file)

  test('a template the app can write back whole is marked so; a cut, masked or oddly named one is not', () => {
    const long = 'x'.repeat(300)
    const file = filed(snapshotText(base(undefined), live({ ok: { constraints: ['small'] }, cut: { constraints: [long] }, masked: { constraints: ['token=abcdefghijklmnop123456'] }, 'ünï': { constraints: ['a'] } }), 0))
    const by = (name: string) => file.templates.find((one: { name: string }) => one.name === name)
    expect(by('ok')).toMatchObject({ nameOk: true, whole: true })
    expect(by('cut').whole).toBe(false)
    expect(by('masked').whole).toBe(false)
    expect(by('ünï').nameOk).toBe(false)
  })

  test('templates that would not fit are dropped from the snapshot, which stays whole and not editable', () => {
    const items = Array.from({ length: 20 }, (_, i) => `${'あ'.repeat(190)}${i}`)
    const many = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`t${i}`, { constraints: items, doneConditions: items }]))
    const text = snapshotText(base(undefined), live(many), 0)
    expect(text).toBeDefined()
    expect(new TextEncoder().encode(text ?? '').length).toBeLessThanOrEqual(SNAPSHOT_MAX_BYTES)
    expect(filed(text)).toMatchObject({ editable: false, templates: [] })
  })
})
