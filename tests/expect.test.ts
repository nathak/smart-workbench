import { describe, expect, test } from 'claude-code/testing'

import { canSet, checkExpectInput, expectOf, readTestRun, testFactsOf } from '../hooks/expect'
import { judgeOf, statusOf, turnSummary } from '../hooks/evidence'
import * as model from '../hooks/model'
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

describe('whether a test run passed, from its own summary', () => {
  const read = (command: string, ...streams: string[]) => readTestRun(command, streams)
  const HEREDOC = "python3 - <<'E'\np='a.ts'; s=open(p).read()  # don't\nx = `y` + \"a; npm test | b\"\nE\n"

  test('the summary decides when a filter hides the exit code: a failure shows, a pass needs both numbers', () => {
    const command = 'claude plugin test . 2>&1 | grep -E "^ [0-9]+ (pass|fail)"'
    expect(read(command, ' 370 pass\n 0 fail\n')).toMatchObject({ ok: true, facts: { passed: 370, failed: 0 } })
    expect(read(command, ' 369 pass\n 1 fail\n')).toMatchObject({ ok: false, facts: { passed: 369, failed: 1 } })
    expect(read(command, ' 5 pass\n').ok).toBeNull()
    expect(read(command, ' 0 fail\n').ok).toBeNull()
    expect(read(command, ' 0 pass\n 0 fail\n').ok).toBeNull()
    expect(read('npx jest 2>&1 | tail -5', 'Test Suites: 3 passed, 3 total\nTests:       9 passed, 9 total').ok).toBe(true)
    expect(read('npx jest 2>&1 | tail -5', 'Test Suites: 1 failed, 2 passed, 3 total\nTests:       1 failed, 9 passed, 10 total').ok).toBe(false)
    expect(read('pytest -q | tail -3', '9 passed in 0.12s').ok).toBe(true)
    expect(read('cargo test', 'test result: ok. 5 passed; 0 failed; 0 ignored').ok).toBe(true)
    expect(read('mvn test | tail -20', '[INFO] Tests run: 12, Failures: 0, Errors: 0, Skipped: 0').ok).toBeNull()
    expect(read('mvn test | tail -20', '[INFO] Tests run: 12, Failures: 1, Errors: 0, Skipped: 0').ok).toBe(false)
  })

  test('node and bun need the two lines from one summary, close together', () => {
    expect(read('bun test | tail', ' 5 pass\n 1 skip\n 0 fail\nRan 6 tests').ok).toBe(true)
    expect(read('bun test | tail', ' 0 fail\na\nb\nc\nd\n 5 pass').ok).toBeNull()
    expect(read('bun test | tail', ' 5 pass\na\nb\nc\nd\ne\n 0 fail').ok).toBeNull()
    expect(read('npm test | tail', '# pass 9\n# fail 0').ok).toBe(true)
    expect(read('npm test | tail', '# pass 9\n# fail 2').ok).toBe(false)
  })

  test('a summary that reads all passed while the run still fails is not a pass', () => {
    expect(read('npx vitest run | tail', ' Test Files  1 passed (1)\n      Tests  9 passed (9)\n      Errors  1 error').ok).toBeNull()
    expect(read('npx jest --coverage | tail', 'Tests:       9 passed, 9 total\nJest: "global" coverage threshold for lines (90%) not met: 80%').ok).toBeNull()
    expect(read('npx vitest run | tail', ' Test Files  1 passed (1)\n      Tests  9 passed (9)').ok).toBe(true)
    expect(read('pytest --cov | tail', 'FAIL Required test coverage of 80% not reached. Total coverage: 70.00%\n5 passed in 1.2s').ok).toBeNull()
    expect(read('npx vitest run --coverage | tail', ' Test Files  1 passed (1)\n      Tests  9 passed (9)\nERROR: Coverage for lines (70%) does not meet global threshold (80%)').ok).toBeNull()
    expect(read('node --test | tail', 'ℹ pass 9\nℹ fail 0\nℹ cancelled 1').ok).toBeNull()
  })

  test('an edit step before the run, and checks after it that print no test summary, are allowed', () => {
    expect(read(`${HEREDOC}claude plugin test . 2>&1 | tail -5`, ' 5 pass\n 0 fail\n').ok).toBe(true)
    expect(read(`${HEREDOC}claude plugin test . 2>&1 | tail -5`, ' 5 pass\n 1 fail\n').ok).toBe(false)
    const jest = 'Test Suites: 1 passed, 1 total\nTests: 9 passed, 9 total'
    expect(read('sed -i s/a/b/ f && npx jest 2>&1 | tail -5', jest).ok).toBe(true)
    expect(read('cp a b && mkdir d; npx jest | tail -5', jest).ok).toBe(true)
    expect(read("cat <<'E' > f\nx\nE\nnpx jest | tail -5", jest).ok).toBe(true)
    expect(read("cat >> f <<E\nx\nE\nnpx jest | tail -5", jest).ok).toBe(true)
    expect(read('cd app && npx jest | tail -5', jest).ok).toBe(true)
    expect(read('claude plugin test . 2>&1 | tail -3; claude plugin validate . 2>&1 | tail -1; tsc --noEmit | tail -2', ' 5 pass\n 0 fail\n').ok).toBe(true)
  })

  test('git add and git status after the run are allowed; a commit after it can only fail the run', () => {
    const jest = 'Test Suites: 1 passed, 1 total\nTests: 9 passed, 9 total'
    expect(read('npx jest | tail -3; git add -A', jest).ok).toBe(true)
    expect(read('claude plugin test . 2>&1 | tail -5; git status --short', ' 5 pass\n 0 fail\n').ok).toBe(true)
    const commit = 'claude plugin test . 2>&1 | tail -5; git add -A && git commit -qm x'
    expect(read(commit, ' 5 pass\n 0 fail\n')).toMatchObject({ ok: null, facts: { passed: 5, failed: 0 } })
    expect(read(commit, ' 4 pass\n 1 fail\n').ok).toBe(false)
  })

  test('a suite that failed to load, a cut suite line, several summaries or a git hook never make a pass', () => {
    const tests = 'Tests:       10 passed, 10 total'
    expect(read('npx jest 2>&1 | tail -20', `Test Suites: 1 failed, 3 passed, 4 total\n${tests}\nSnapshots:   0 total`).ok).toBe(false)
    expect(read('npx vitest run | tail -5', ' Test Files  1 failed | 3 passed (4)\n      Tests  10 passed (10)').ok).toBe(false)
    expect(read('npx jest | grep Tests', tests).ok).toBeNull()
    expect(read('npx jest | tail -3', `Test Suites: 4 passed, 4 total\nx\n${tests}`).ok).toBeNull()
    expect(read('pnpm -r test 2>&1 | tail -30', 'Failed\n5 passed in 0.3s\n6 passed in 0.3s').ok).toBeNull()
    expect(read('pnpm -r test 2>&1 | tail -30', '1 failed, 2 passed in 0.3s\n6 passed in 0.3s').ok).toBe(false)
    expect(read('git commit -qm x; npx jest | tail -3', `Test Suites: 1 passed, 1 total\n${tests}`).ok).toBeNull()
    expect(read('git commit -qm x; npx jest | tail -3', 'Test Suites: 1 passed, 1 total\nTests: 1 failed, 9 passed, 10 total').ok).toBe(false)
  })

  test('a lint, typecheck or other check before the run, or one that runs scripts after it, leaves it unknown', () => {
    expect(read('tsc --noEmit | tail -1; npx jest | tail -3', 'Test Suites: 1 passed, 1 total\nTests: 9 passed, 9 total').ok).toBeNull()
    expect(read('npx jest | tail -3; npm run lint | tail -2', 'Tests: 9 passed, 9 total').ok).toBeNull()
  })

  test('several summaries in one output keep no counts, and a failure far above the last summary is still seen', () => {
    const suite = (n: number) => `Test Suites: 1 passed, 1 total\nTests:       ${n} passed, ${n} total`
    expect(read('npm test --workspaces', `${suite(30)}\n${suite(20)}`)).toEqual({ ok: null })
    expect(read('npm test --workspaces 2>&1 | tail -80', `Test Suites: 1 failed, 1 total\nTests:       2 failed, 3 passed, 5 total\n${'noise\n'.repeat(60)}${suite(20)}`)).toEqual({ ok: false })
    expect(read('npx jest | tail -5', 'Test Suites: 2 skipped, 1 passed, 1 of 3 total\nTests:       4 skipped, 9 passed, 13 total').ok).toBe(true)
  })

  test('maven and gradle counts are read, but a build tool\'s totals do not make a pass', () => {
    expect(read('mvn test | tail -20', '[INFO] Tests run: 12, Failures: 1, Errors: 1, Skipped: 2')).toMatchObject({ ok: false, facts: { passed: 8, failed: 2, total: 12 } })
    expect(read('mvn test | tail -20', '[INFO] Tests run: 12, Failures: 0, Errors: 0, Skipped: 2')).toMatchObject({ ok: null, facts: { passed: 10, failed: 0 } })
    expect(read('./gradlew test | tail -20', '12 tests completed, 2 failed, 1 skipped')).toMatchObject({ ok: false, facts: { passed: 9, failed: 2, total: 12 } })
  })

  test('grep -v can drop the failing line, and only the git commands that run hooks lose the pass', () => {
    const tests = 'Test Suites: 1 passed, 1 total\nTests:       9 passed, 9 total'
    expect(read('npx jest | grep -v warn', tests)).toEqual({ ok: null })
    expect(read('npx jest | grep -nv warn', tests)).toEqual({ ok: null })
    expect(read('npx jest | grep -E "Tests|Suites"', tests).ok).toBe(true)
    expect(read('git add -A; npx jest | tail -3', tests).ok).toBe(true)
    expect(read('git stash && npx jest | tail -3', tests).ok).toBe(true)
    expect(read('git checkout x; npx jest | tail -3', tests).ok).toBeNull()
  })

  test('two test runs give no counts, only a failure either printed', () => {
    const command = 'claude plugin test . 2>&1 | grep -E "pass|fail"; claude plugin test . 2>&1 | grep -A12 "^(fail)"'
    expect(read(command, ' 5 pass\n 0 fail\n')).toEqual({ ok: null })
    expect(read(command, ' 4 pass\n 1 fail\n')).toEqual({ ok: false })
  })

  test('another command, or a shape the shell could change, leaves the result unknown and keeps no counts', () => {
    const out = 'Tests: 9 passed, 9 total'
    for (const command of [
      'cat old.log; npm test | tail',
      'git log -1; npm test | tail',
      'npm test | tail; echo 0 fail',
      'npm test | sed s/a/b/',
      '! npm test | tail',
      'echo $(npm test)',
      'npm test | tail; mvn package',
      'npm test | tail; ./gradlew build | tail',
      'npm test | tail; npm run build',
      'npm test | tail &',
      'cp a b || true; npm test | tail',
      'python3 - <<\'E\'\nprint(1)\nnpm test | tail',
      'cat > f <<E\n$(date)\nE\nnpm test | tail',
      'npm test | tail; cp a b',
      'npm test | tail; git add -p',
      'npm test | tail; git status -v',
      'npm test | tail; git commit --dry-run -v',
      'npm test | tail; git diff',
      'npm test | tail; git show',
      'npm test | tail; git -C x add .',
    ]) expect(read(command, out)).toEqual({ ok: null })
  })

  test('the facts a filtered run keeps are the same as before', () => {
    expect(testFactsOf('claude plugin test . 2>&1 | tail', [' 5 pass\n 0 fail'])).toMatchObject({ passed: 5, failed: 0 })
    expect(testFactsOf('npm test && npm run test:e2e', ['Tests: 9 passed, 9 total'])).toBeUndefined()
  })
})

const cond = (expectation?: Expectation, extra: Partial<DoneCondition> = {}): DoneCondition => ({ id: 'dc-1', text: 'Tests pass', link: 'test', ...(expectation ? { expect: expectation } : {}), ...extra })
const claude = (extra: Partial<Expectation> = {}): Expectation => ({ setBy: 'claude', at: 1, ...extra })
const run = (ok: boolean | null, facts?: EvidenceRecord['facts'], command = 'npm test', at = 10): EvidenceRecord => ({ id: `e${at}`, kind: 'test', command, ok, at, ...(facts ? { facts } : {}) })

describe('what Claude may expect, and what a link change keeps', () => {
  const input = { tests: { min: 5 }, reason: 'x' }
  test('a test count is refused when the last test run showed none the workbench can read', () => {
    expect(canSet(false, cond(), input, run(true)).ok).toBe(false)
    expect(canSet(false, cond(), input, run(true, { passed: 9, failed: 0 })).ok).toBe(true)
    expect(canSet(false, cond(), input, undefined)).toEqual({ ok: true })
    expect(canSet(false, cond(), { cmd: 'src/', reason: 'x' }, run(true)).ok).toBe(true)
  })

  test('linking a condition to what it already has keeps Claude\'s expectation; a different link drops it', () => {
    const wb = model.emptyWorkbench()
    const withCond = { ...wb, task: { ...wb.task, doneConditions: [cond(claude({ tests: { min: 5 } }))] } }
    expect(model.linkCondition(withCond, 'dc-1', 'test').task.doneConditions[0]?.expect).toBeDefined()
    expect(model.linkCondition(withCond, 'dc-1', 'build').task.doneConditions[0]?.expect).toBeUndefined()
  })

  test('the turn summary says what was expected and what the run showed', () => {
    const wb = model.emptyWorkbench()
    const task = { ...wb.task, goal: 'g', doneConditions: [cond(claude({ tests: { min: 12 } }))] }
    expect(turnSummary(task, [run(true, { passed: 9, failed: 0 })])).toContain('· expects ≥12 passed, got 9 passed')
    expect(turnSummary(task, [run(true, { passed: 12, failed: 0 })])).not.toContain('expects')
  })
})

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
