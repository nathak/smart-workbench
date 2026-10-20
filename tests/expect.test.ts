import { describe, expect, test } from 'claude-code/testing'

import { canSet, checkExpectInput, expectOf, testFactsOf } from '../hooks/expect'
import { judgeOf, statusOf } from '../hooks/evidence'
import type { DoneCondition, EvidenceRecord, Expectation } from '../types'

describe('the counts a test run prints', () => {
  const facts = (command: string, ...streams: string[]) => testFactsOf(command, streams)

  test('each runner\'s summary line is read as passed and failed', () => {
    expect(facts('npx jest', 'Tests:       1 failed, 9 passed, 10 total\nTime: 2s')).toMatchObject({ passed: 9, failed: 1, total: 10 })
    expect(facts('npx vitest run', '      Tests  1 failed | 9 passed (10)\n   Duration  1.2s')).toMatchObject({ passed: 9, failed: 1, total: 10 })
    expect(facts('npx vitest run', '      Tests  3 failed (3)')).toMatchObject({ passed: 0, failed: 3, total: 3 })
    expect(facts('npx vitest run', '      Tests  1 failed | 9 passed | 1 todo (11)')).toMatchObject({ passed: 9, failed: 1, total: 11 })
    expect(facts('npx jest', 'Tests:       1 failed, 2 skipped, 1 todo, 9 passed, 13 total')).toMatchObject({ passed: 9, failed: 1, total: 13 })
    expect(facts('pytest', '=== 2 failed, 7 passed, 1 skipped in 0.52s ===')).toMatchObject({ passed: 7, failed: 2 })
    expect(facts('pytest -q', '9 passed in 0.12s')).toMatchObject({ passed: 9, failed: 0 })
    expect(facts('pytest -q', '1 failed, 8 passed, 1 error in 1.20s')).toMatchObject({ passed: 8, failed: 2 })
    expect(facts('pytest', '=== 2 passed, 3 warnings in 0.01s ===')).toMatchObject({ passed: 2, failed: 0 })
    expect(facts('cargo test', 'test result: ok. 5 passed; 0 failed; 0 ignored; 0 measured\ntest result: FAILED. 2 passed; 1 failed; 0 ignored; 0 measured')).toMatchObject({ passed: 7, failed: 1 })
    expect(facts('npm test', '# tests 10\n# pass 9\n# fail 1')).toMatchObject({ passed: 9, failed: 1 })
    expect(facts('npm test', 'ℹ tests 10\nℹ pass 9\nℹ fail 1\nℹ duration_ms 120')).toMatchObject({ passed: 9, failed: 1 })
    expect(facts('bun test', ' 9 pass\n 1 fail\nRan 10 tests')).toMatchObject({ passed: 9, failed: 1 })
    expect(facts('claude plugin test .', '\n 320 pass\n 0 fail\nRan 320 tests across 14 files. [18.18s]')).toMatchObject({ passed: 320, failed: 0 })
    expect(facts('mvn test | tail', '[INFO] Tests run: 12, Failures: 1, Errors: 1, Skipped: 0')).toMatchObject({ failed: 2 })
    expect(facts('npx jest', '\x1b[32mTests:       9 passed, 9 total\x1b[0m')).toMatchObject({ passed: 9, failed: 0 })
  })

  test('a quiet run, an unknown format, two test runs or a cut summary give no counts', () => {
    expect(facts('npx jest', 'PASS src/a.test.ts')).toBeUndefined()
    expect(facts('npx jest', '')).toBeUndefined()
    expect(facts('npm test && npm run test:e2e', 'Tests: 9 passed, 9 total')).toBeUndefined()
    expect(facts('npm test; echo done', 'Tests: 9 passed, 9 total')).toBeUndefined()
    expect(facts('cat old.log; npm test | tail', 'Tests: 9 passed, 9 total')).toBeUndefined()
    expect(facts('npx jest', `Tests: 9 passed, 9 total\n${'x\n'.repeat(41)}`)).toBeUndefined()
    expect(facts('echo "Tests: 9 passed, 9 total"', 'Tests: 9 passed, 9 total')).toBeUndefined()
  })

  test('cargo adds up the crates of a whole stream, however long, and gives nothing behind a filter', () => {
    const crates = Array.from({ length: 30 }, (_, i) => `running 3 tests\ntest a${i} ... ok\ntest b${i} ... ok\ntest result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out`).join('\n\n')
    expect(facts('cargo test --workspace', crates)).toMatchObject({ passed: 90, failed: 0 })
    expect(facts('cargo test --workspace | tail -5', crates)).toBeUndefined()
  })

  test('only the numbers and one short masked line are kept', () => {
    const got = testFactsOf('npx jest', ['Tests:       9 passed, 9 total'])
    expect(got?.line).toBe('Tests:       9 passed, 9 total')
    expect(Object.keys(got ?? {}).sort()).toEqual(['failed', 'line', 'passed', 'total'])
  })
})

const cond = (expectation?: Expectation, extra: Partial<DoneCondition> = {}): DoneCondition => ({ id: 'dc-1', text: 'Tests pass', link: 'test', ...(expectation ? { expect: expectation } : {}), ...extra })
const claude = (extra: Partial<Expectation> = {}): Expectation => ({ setBy: 'claude', at: 1, ...extra })
const run = (ok: boolean | null, facts?: EvidenceRecord['facts'], command = 'npm test', at = 10): EvidenceRecord => ({ id: `e${at}`, kind: 'test', command, ok, at, ...(facts ? { facts } : {}) })

describe('an expectation judges a run by its numbers', () => {
  test('too few tests passed fails the condition and says what it saw; enough keeps it verified', () => {
    const ex = claude({ tests: { min: 12 } })
    expect(judgeOf(cond(ex), [run(true, { passed: 9, failed: 0 })])).toMatchObject({ status: 'failed', expected: '≥12 passed', got: '9 passed' })
    expect(judgeOf(cond(ex), [run(true, { passed: 12, failed: 0 })])).toMatchObject({ status: 'verified', got: '12 passed, 0 failed' })
  })

  test('failures past the limit fail it even when a pipe hid the exit code', () => {
    const ex = claude({ tests: { failedMax: 0 } })
    expect(judgeOf(cond(ex), [run(null, { passed: 9, failed: 1 })]).status).toBe('failed')
    expect(judgeOf(cond(ex), [run(null, { passed: 9, failed: 0 })]).status).toBe('observed')
    expect(judgeOf(cond(ex), [run(true, { passed: 9, failed: 0 })]).status).toBe('verified')
  })

  test('a run without counts, or another command, holds a verified condition as observed', () => {
    expect(judgeOf(cond(claude({ tests: { min: 1 } })), [run(true)])).toMatchObject({ status: 'observed' })
    expect(judgeOf(cond(claude({ cmd: 'auth' })), [run(true, undefined, 'npm test -- other')])).toMatchObject({ status: 'observed' })
    expect(judgeOf(cond(claude({ cmd: 'auth' })), [run(true, undefined, 'npm test -- auth')]).status).toBe('verified')
  })

  test('an expectation never raises a verdict: the invariant over every combination', () => {
    const expectations: (Expectation | undefined)[] = [undefined, claude({ tests: { min: 0 } }), claude({ tests: { failedMax: 100 } }), claude({ cmd: 'npm' }), claude({ tests: { min: 5, failedMax: 0 }, cmd: 'test' })]
    const runs: EvidenceRecord[][] = [[], [run(true)], [run(false)], [run(null)], [run(true, { passed: 5, failed: 0 })], [run(null, { passed: 5, failed: 0 })], [run(false, { passed: 9, failed: 0 })], [run(true, { passed: 1, failed: 3 })]]
    const rank = { pending: 0, observed: 1, failed: 1, verified: 2, waived: 2 } as const
    for (const ex of expectations) {
      for (const evidence of runs) {
        for (const lastEdit of [undefined, 5, 20]) {
          const plain = statusOf(cond(undefined), evidence, lastEdit)
          const judged = statusOf(cond(ex), evidence, lastEdit)
          if (judged === 'verified') expect(plain).toBe('verified')
          if (plain !== 'verified') expect(judged).toBe(plain === 'observed' && judged === 'failed' ? 'failed' : plain)
          expect(rank[judged]).toBeLessThanOrEqual(rank[plain] === 2 ? 2 : Math.max(rank[plain], 1))
        }
      }
    }
  })

  test('a person\'s mark, a condition without a link and a stale pass are left to the plain rules', () => {
    const ex = claude({ tests: { min: 99 } })
    expect(judgeOf(cond(ex, { manual: { status: 'verified', note: 'seen', at: 1 } }), [run(true, { passed: 1, failed: 0 })]).status).toBe('verified')
    expect(judgeOf(cond(ex, { link: undefined }), [run(true, { passed: 1, failed: 0 })]).status).toBe('pending')
    expect(judgeOf(cond(ex), [run(true, { passed: 99, failed: 0 })], 20).status).toBe('observed')
  })
})

describe('what Claude may set', () => {
  const input = { tests: { min: 5 }, reason: 'the suite has 5' }

  test('an unlocked contract takes a first or a replaced expectation of Claude\'s own', () => {
    expect(canSet(false, cond(), input)).toEqual({ ok: true })
    expect(canSet(false, cond(claude({ tests: { min: 1 } })), input)).toEqual({ ok: true })
  })

  test('a locked contract takes only a first one on a linked condition; the person\'s own is never touched', () => {
    expect(canSet(true, cond(), input)).toEqual({ ok: true })
    expect(canSet(true, cond(claude({ tests: { min: 1 } })), input).ok).toBe(false)
    expect(canSet(false, cond({ setBy: 'user', at: 1, tests: { min: 1 } }), input).ok).toBe(false)
    expect(canSet(true, cond({ setBy: 'user', at: 1, tests: { min: 1 } }), input).ok).toBe(false)
  })

  test('no condition, a person\'s mark, no link or a test count on another kind are refused', () => {
    expect(canSet(false, undefined, input).ok).toBe(false)
    expect(canSet(false, cond(undefined, { manual: { status: 'waived', note: 'x', at: 1 } }), input).ok).toBe(false)
    expect(canSet(false, cond(undefined, { link: undefined }), input).ok).toBe(false)
    expect(canSet(false, cond(undefined, { link: 'build' }), input).ok).toBe(false)
    expect(canSet(false, cond(undefined, { link: 'build' }), { cmd: 'gradlew', reason: 'x' })).toEqual({ ok: true })
  })

  test('the input is checked: whole numbers in range, one line of command, a reason, at least one value', () => {
    expect(checkExpectInput({ min: 5, failed_max: 0, cmd: 'auth', reason: 'why' })).toEqual({ ok: true, value: { cmd: 'auth', tests: { min: 5, failedMax: 0 }, reason: 'why' } })
    for (const bad of [{ reason: 'x' }, { min: -1, reason: 'x' }, { min: 1.5, reason: 'x' }, { min: 1e9, reason: 'x' }, { min: '5', reason: 'x' }, { cmd: '', reason: 'x' }, { cmd: 'a\nb', reason: 'x' }, { cmd: 'x'.repeat(81), reason: 'x' }, { min: 1 }, { min: 1, reason: '   ' }, { cmd: 5, reason: 'x' }]) {
      expect(checkExpectInput(bad as Record<string, unknown>).ok).toBe(false)
    }
    const masked = checkExpectInput({ min: 1, reason: 'token=abcdefghijklmnop123456 is set' })
    expect(masked.ok && masked.value.reason).not.toContain('abcdefghijklmnop123456')
  })

  test('an expectation Claude sets is marked as Claude\'s', () => {
    expect(expectOf({ tests: { min: 5 }, reason: 'r' }, 7)).toEqual({ tests: { min: 5 }, setBy: 'claude', at: 7, reason: 'r' })
  })
})

describe('an expectation and the commands it is judged by', () => {
  test('a command cut at 200 characters is not judged by its text, and a stored value that is not a number counts for nothing', () => {
    const long = `npm test -- ${'x'.repeat(190)}`
    expect(judgeOf(cond(claude({ cmd: 'auth' })), [run(true, undefined, long.slice(0, 200))]).status).toBe('verified')
    const odd = { setBy: 'claude', at: 1, tests: { min: '5', failedMax: null } } as unknown as Expectation
    expect(judgeOf(cond(odd), [run(true, { passed: 1, failed: 0 })]).status).toBe('verified')
  })
})
