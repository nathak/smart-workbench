import { describe, expect, test } from 'claude-code/testing'

import { feedStateOf } from '../hooks/desktop'
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
