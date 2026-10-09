import { describe, expect, test } from 'claude-code/testing'

import * as crew from '../hooks/crew'

describe('team mode decisions', () => {
  test('the same command failing twice in a row points Claude at the advisor once', async () => {
    const key = crew.failureKey('Bash', { command: 'npm test -- auth' })
    expect(key).toBe('bash:npm test')
    let state = crew.trackResult(crew.EMPTY_TRACK, key, false)
    expect(state.nudge).toBe(false)
    state = crew.trackResult(state.track, key, false)
    expect(state.nudge).toBe(true)
    state = crew.trackResult(state.track, key, false)
    expect(state.nudge).toBe(false)
    expect(state.track.failures[key]).toBe(3)
    expect(crew.trackResult(state.track, key, true).track.failures[key]).toBe(undefined)
    expect(crew.advisorRan(state.track, 9)).toEqual({ failures: {}, nudged: [], lastAdvisorAt: 9, advisorRuns: 1 })
  })

  test('a plan needs a review from this turn; a final check follows the last code edit', async () => {
    const turn = { ...crew.EMPTY_TRACK, turnStartedAt: 100 }
    expect(crew.needsPlanReview(turn)).toBe(true)
    expect(crew.needsPlanReview({ ...turn, lastAdvisorAt: 50 })).toBe(true)
    expect(crew.needsPlanReview({ ...turn, lastAdvisorAt: 120 })).toBe(false)

    expect(crew.needsFinalCheck(turn, undefined, false)).toBe(false)
    expect(crew.needsFinalCheck(turn, 90, false)).toBe(false)
    expect(crew.needsFinalCheck(turn, 110, false)).toBe(true)
    expect(crew.needsFinalCheck(turn, 110, true)).toBe(false)
    expect(crew.needsFinalCheck({ ...turn, lastAdvisorAt: 130 }, 110, false)).toBe(false)
  })

  test('the agents are read-only and pinned to their models', async () => {
    expect(crew.EXPLORER_SPEC.model).toBe('haiku')
    expect(crew.ADVISOR_SPEC.model).toBe('opus')
    for (const spec of [crew.EXPLORER_SPEC, crew.ADVISOR_SPEC]) {
      expect(spec.tools.some(tool => ['Edit', 'Write', 'Bash', 'NotebookEdit'].includes(tool))).toBe(false)
    }
  })
})

describe('design first', () => {
  const turn = { ...crew.EMPTY_TRACK, turnStartedAt: 100 }
  const lines = (n: number) => Array.from({ length: n }, (_, i) => `l${i}`).join('\n')

  test('edit size counts the larger side, every edit of a MultiEdit, and bulk replacement', async () => {
    expect(crew.editSize('Edit', { old_string: lines(2), new_string: lines(7) }).lines).toBe(7)
    expect(crew.editSize('Edit', { old_string: '', new_string: '' })).toEqual({ lines: 0, chars: 0, isBulk: false })
    expect(crew.editSize('Edit', { old_string: 'a', new_string: 'b', replace_all: true }).isBulk).toBe(true)
    expect(crew.editSize('Write', { content: lines(10) }).lines).toBe(10)
    expect(crew.editSize('NotebookEdit', { new_source: lines(3) }).lines).toBe(3)
    expect(crew.editSize('MultiEdit', { edits: [{ old_string: 'a', new_string: lines(2) }, { old_string: lines(3), new_string: 'b' }] }).lines).toBe(5)
  })

  test('small means few lines, one file, and a small total for the turn', async () => {
    const size = (n: number) => crew.editSize('Edit', { old_string: 'a', new_string: lines(n) })
    expect(crew.isSmallEdit(turn, 'a.ts', size(6))).toBe(true)
    expect(crew.isSmallEdit(turn, 'a.ts', size(7))).toBe(false)
    expect(crew.isSmallEdit(turn, 'a.ts', crew.editSize('Edit', { old_string: 'a', new_string: 'b', replace_all: true }))).toBe(false)

    const edited = crew.noteEdit(turn, 'a.ts', 6)
    expect(crew.isSmallEdit(edited, 'a.ts', size(6))).toBe(true)
    expect(crew.isSmallEdit(edited, 'b.ts', size(1))).toBe(false)
    expect(crew.isSmallEdit(crew.noteEdit(edited, 'a.ts', 6), 'a.ts', size(6))).toBe(false)
  })

  test('a design from this turn covers big edits; a denial lets the next try through; carried designs persist', async () => {
    expect(crew.needsDesign(turn, true)).toBe(false)
    expect(crew.needsDesign(turn, false)).toBe(true)
    expect(crew.needsDesign({ ...turn, lastAdvisorAt: 90 }, false)).toBe(true)
    expect(crew.needsDesign({ ...turn, lastAdvisorAt: 120 }, false)).toBe(false)
    expect(crew.needsDesign({ ...turn, designDeniedAt: 110 }, false)).toBe(false)

    const next = crew.turnStart({ ...turn, lastAdvisorAt: 120, turnEdits: { files: ['a'], lines: 3 } }, 200, false)
    expect(next).toMatchObject({ turnStartedAt: 200, designFrom: 200 })
    expect(next.turnEdits).toBe(undefined)
    expect(crew.needsDesign(next, false)).toBe(true)

    const carried = crew.turnStart({ ...turn, designFrom: 100, lastAdvisorAt: 120 }, 200, true)
    expect(crew.needsDesign(carried, false)).toBe(false)
    expect(crew.planWasApproved({ ...turn, planApprovedAt: 150 })).toBe(true)
    expect(crew.planWasApproved({ ...turn, planApprovedAt: 50 })).toBe(false)
  })

  test('fixed prompt text has no dynamic values', async () => {
    expect(crew.TEAM_CONTEXT).toContain('designs; you implement')
    expect(crew.DESIGN_FIRST).toContain('Asked once per turn')
    expect(crew.ADVISOR_SPEC.prompt).toContain('DESIGN:')
  })
})

