import { describe, expect, test } from 'claude-code/testing'

import * as loop from '../hooks/loop'

describe('loop decisions', () => {
  test('parses a count or inf, then the items', async () => {
    expect(loop.parse('3 fix lint')).toEqual({ kind: 'start', limit: 3, items: ['fix lint'] })
    expect(loop.parse('inf watch; report')).toEqual({ kind: 'start', limit: null, items: ['watch', 'report'] })
    expect(loop.parse('무한 점검')).toEqual({ kind: 'start', limit: null, items: ['점검'] })
    expect(loop.parse('stop')).toEqual({ kind: 'stop' })
    expect(loop.parse('')).toEqual({ kind: 'status' })
  })

  test('rejects a missing task, a bad count and a count above the cap', async () => {
    expect(loop.parse('5').kind).toBe('error')
    expect(loop.parse('0 x').kind).toBe('error')
    expect(loop.parse(`${loop.MAX_COUNT + 1} x`).kind).toBe('error')
    expect(loop.parse('fix lint').kind).toBe('error')
    expect(loop.parse(`${loop.MAX_COUNT} x`).kind).toBe('start')
  })

  test('a counted loop holds the turn until the last pass, then ends', async () => {
    let state = loop.begin(['a'], 2, 0)
    const first = loop.advance(state)
    expect(first.loop).toEqual({ ...state, done: 1, continuing: true, pending: false })
    expect(first.reason).toContain('pass 2/2')

    state = first.loop!
    const last = loop.advance(state)
    expect(last.loop).toBe(undefined)
    expect(last.reason).toBe(undefined)
    expect(last.text).toContain('2 of 2')
  })

  test('an infinite loop never ends by itself', async () => {
    let state = loop.begin(['a', 'b'], null, 0)
    for (let i = 0; i < 50; i++) {
      const step = loop.advance(state)
      expect(step.reason).toBeTruthy()
      state = step.loop!
    }
    expect(state.done).toBe(50)
    expect(loop.iterationPrompt(state)).toContain('1. a\n2. b')
  })
})
