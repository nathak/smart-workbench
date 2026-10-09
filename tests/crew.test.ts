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
