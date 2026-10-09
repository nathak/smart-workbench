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
    const first = loop.advance(state, true, 1)
    expect(first.loop).toEqual({ ...state, done: 1, idle: 0, passAt: 1, continuing: true, pending: false })
    expect(first.reason).toContain('pass 2/2')

    state = first.loop!
    const last = loop.advance(state, true, 1)
    expect(last.loop).toBe(undefined)
    expect(last.reason).toBe(undefined)
    expect(last.text).toContain('2 of 2')
  })

  test('an infinite loop ends after IDLE_LIMIT passes that changed no file; a counted one does not', async () => {
    let state = loop.begin(['a'], null, 0)
    for (let i = 1; i < loop.IDLE_LIMIT; i++) state = loop.advance(state, false, i).loop!
    expect(loop.advance(state, true, 9).loop?.idle).toBe(0)
    const ended = loop.advance(state, false, 10)
    expect(ended.loop).toBe(undefined)
    expect(ended.text).toContain('changed no file')

    let counted = loop.begin(['a'], 9, 0)
    for (let i = 1; i < 8; i++) counted = loop.advance(counted, false, i).loop!
    expect(counted.done).toBe(7)
  })

  test('an escaped semicolon stays inside its item', async () => {
    expect(loop.parse('2 run a\\; b; c')).toEqual({ kind: 'start', limit: 2, items: ['run a; b', 'c'] })
  })

  test('an infinite loop never ends by itself while it keeps editing', async () => {
    let state = loop.begin(['a', 'b'], null, 0)
    for (let i = 0; i < 50; i++) {
      const step = loop.advance(state, true, 1)
      expect(step.reason).toBeTruthy()
      state = step.loop!
    }
    expect(state.done).toBe(50)
    expect(loop.iterationPrompt(state)).toContain('1. a\n2. b')
  })
})
