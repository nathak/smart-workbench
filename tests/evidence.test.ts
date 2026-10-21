import { describe, expect, test } from 'claude-code/testing'

import type { EvidenceRecord, Task } from '../types'
import { parsePinSpec, sliceLines } from '../hooks/context'
import * as evidence from '../hooks/evidence'
import { checkOutcome, completionOf, evidenceKindOf, evidenceKindsOf, guessLink, statusOf, withoutHeredocs } from '../hooks/evidence'
import { serializeContract } from '../hooks/intent'

const task: Task = {
  id: 't',
  status: 'active',
  locked: true,
  goal: 'Fix login <session> expiry',
  constraints: [
    { id: 'c1', text: 'Do not change DB schema', priority: 'hard', isActive: true },
    { id: 'c2', text: 'Off for now', priority: 'soft', isActive: false },
  ],
  nonGoals: [],
  doneConditions: [
    { id: 'dc-1', text: 'Related tests pass', link: 'test' },
    { id: 'dc-2', text: 'Typecheck passes', link: 'typecheck' },
  ],
}

describe('evidence', () => {
  test('known verification commands are classified', async () => {
    expect(evidenceKindOf('npm test')).toBe('test')
    expect(evidenceKindOf('pnpm run test -- auth')).toBe('test')
    expect(evidenceKindOf('pytest -q')).toBe('test')
    expect(evidenceKindOf('npx tsc --noEmit')).toBe('typecheck')
    expect(evidenceKindOf('npm run build')).toBe('build')
    expect(evidenceKindOf('npx eslint .')).toBe('lint')
    expect(evidenceKindOf('ls -la')).toBe(undefined)
    expect(guessLink('관련 테스트 통과')).toBe('test')
    expect(guessLink('Typecheck passes')).toBe('typecheck')
  })

  test('status follows the latest result and keeps the history', async () => {
    const pass: EvidenceRecord = { id: 'a', kind: 'test', command: 'npm test', ok: true, at: 1 }
    const fail: EvidenceRecord = { id: 'b', kind: 'test', command: 'npm test', ok: false, at: 2 }
    const condition = task.doneConditions[0]!

    expect(statusOf(condition, [])).toBe('pending')
    expect(statusOf(condition, [pass])).toBe('verified')
    expect(statusOf(condition, [pass, fail])).toBe('failed')
    expect(statusOf(condition, [{ ...pass, ok: null }])).toBe('observed')
    expect(statusOf({ ...condition, manual: { status: 'waived', note: 'n/a', at: 3 } }, [fail])).toBe('waived')
  })

  test('completion needs every condition verified or waived', async () => {
    const ok: EvidenceRecord = { id: 'a', kind: 'test', command: 'npm test', ok: true, at: 1 }
    expect(completionOf(task, [ok])).toEqual({ met: 1, total: 2, isComplete: false })
    expect(completionOf(task, [ok, { ...ok, id: 'b', kind: 'typecheck' }]).isComplete).toBe(true)
  })

  test('the contract serializes deterministically and escapes text', async () => {
    const text = serializeContract(task)
    expect(text).toBe(serializeContract({ ...task }))
    expect(text).toContain('<goal>Fix login &lt;session&gt; expiry</goal>')
    expect(text).toContain('<constraint priority="hard">Do not change DB schema</constraint>')
    expect(text).not.toContain('Off for now')
    expect(text).toContain('<condition id="dc-2">Typecheck passes</condition>')
    expect(serializeContract({ ...task, locked: false })).toBe(undefined)
  })
})

describe('pins and reports', () => {
  test('pin specs parse paths and line ranges', async () => {
    expect(parsePinSpec('src/a.ts')).toEqual({ path: 'src/a.ts' })
    expect(parsePinSpec('src/a.ts:10-40')).toEqual({ path: 'src/a.ts', lines: { from: 10, to: 40 } })
    expect(parsePinSpec('src/a.ts#L12')).toEqual({ path: 'src/a.ts', lines: { from: 12, to: 12 } })
    expect(parsePinSpec('src/a.ts:40-10')).toEqual({ path: 'src/a.ts', lines: { from: 10, to: 40 } })
    expect(sliceLines('a\nb\nc', { from: 2, to: 3 })).toBe('b\nc')
  })
})

describe('exit codes the shell hides', () => {
  test('a pipe, || or ; after the check makes its result unknown', async () => {
    const { checkOutcome } = evidence
    expect(checkOutcome('npm test', 'test', false)).toBe(false)
    expect(checkOutcome('npm test 2>&1 | tail -20', 'test', true)).toBe(null)
    expect(checkOutcome('npm test || true', 'test', true)).toBe(null)
    expect(checkOutcome('npm test; echo done', 'test', true)).toBe(null)
    expect(checkOutcome('cd app && npm test', 'test', true)).toBe(true)
    expect(checkOutcome('npm test && npm run build', 'test', true)).toBe(true)
    expect(checkOutcome('npm test && npm run build', 'test', false)).toBe(null)
    expect(checkOutcome('set -o pipefail; npm test | tail -5', 'test', true)).toBe(true)
    expect(checkOutcome('npm test | tail -5; set -o pipefail', 'test', true)).toBe(null)
    expect(checkOutcome('set -o pipefail && npm test | tail -5', 'test', true)).toBe(true)
  })
})

describe('build tool output when the exit code cannot tell', () => {
  const { outcomeFromOutput: from, checkOutcome } = evidence
  const OK = '> Task :test\n\nBUILD SUCCESSFUL in 12s\n4 actionable tasks: 2 executed\n'
  const PIPED = './gradlew test 2>&1 | tail -30'

  test('a Gradle or Maven run piped into a filter is decided by its closing line', () => {
    expect(checkOutcome(PIPED, 'test', true)).toBe(null)
    expect(from(PIPED, 'test', [OK], true)).toBe(true)
    expect(from(PIPED, 'test', ['BUILD SUCCESSFUL in 1m 5s'], true)).toBe(true)
    expect(from(PIPED, 'test', ['BUILD SUCCESSFUL'], true)).toBe(true)
    expect(from(PIPED, 'test', ['a\r\nBUILD SUCCESSFUL in 2s\r\n'], true)).toBe(true)
    expect(from('cd app && ./gradlew test |& tail', 'test', [OK], true)).toBe(true)
    expect(from('./gradlew test | tee out.log | tail -40', 'test', [OK], true)).toBe(true)
    expect(from(PIPED, 'test', [OK, `${'warning\n'.repeat(50)}`], true)).toBe(true)
    expect(from('mvn -q test | tail', 'test', ['[\x1b[1;34mINFO\x1b[m] \x1b[1;32mBUILD SUCCESS\x1b[m'], true)).toBe(true)
    expect(from(PIPED, 'test', ['BUILD FAILED in 3s'], true)).toBe(false)
    expect(from(PIPED, 'test', ['BUILD FAILED in 3s'], false)).toBe(false)
    expect(from(PIPED, 'test', ['BUILD SUCCESSFUL in 1s\nBUILD FAILED in 3s'], true)).toBe(false)
    expect(from(PIPED, 'test', ['x', 'FAILURE: Build failed with an exception.\nBUILD FAILED in 2s'], true)).toBe(false)
    expect(from('mvn test | tail', 'test', [`[INFO] BUILD FAILURE\n${'[ERROR] x\n'.repeat(20)}`], true)).toBe(false)
  })

  test('Maven runs that ignore failures count a success line for nothing, but failing totals still fail', () => {
    const out = '[ERROR] Tests run: 5, Failures: 1, Errors: 0, Skipped: 0\n[INFO] BUILD SUCCESS'
    expect(from('mvn test -Dmaven.test.failure.ignore=true | tail -50', 'test', [out], true)).toBe(false)
    expect(from('mvn test -Dmaven.test.failure.ignore=true | tail -50', 'test', ['[INFO] Tests run: 5, Failures: 0, Errors: 0, Skipped: 0\n[INFO] BUILD SUCCESS'], true)).toBe(null)
    expect(from('mvn test -fn | tail', 'test', ['[INFO] BUILD SUCCESS'], true)).toBe(null)
  })

  test('anything that makes the line less than the tool\'s own verdict stays unknown', () => {
    expect(from(PIPED, 'test', [OK], false)).toBe(null)
    expect(from(PIPED, 'test', [''], true)).toBe(null)
    expect(from(PIPED, 'test', [], true)).toBe(null)
    expect(from('./gradlew test | head -5', 'test', ['> Task :compileJava'], true)).toBe(null)
    expect(from(PIPED, 'test', ['  BUILD SUCCESSFUL'], true)).toBe(null)
    expect(from(PIPED, 'test', ['echo: BUILD SUCCESSFUL in 1s'], true)).toBe(null)
    expect(from(PIPED, 'test', [`BUILD SUCCESSFUL\n${'x\n'.repeat(41)}`], true)).toBe(null)
    expect(from('npm test | tail', 'test', [OK], true)).toBe(null)
    expect(from(PIPED, 'test', ['[INFO] BUILD SUCCESS'], true)).toBe(null)
    expect(from('./gradlew build | tail', 'test', [OK], true)).toBe(null)
  })

  test('a command that is not one plain build run is not read', () => {
    for (const command of ['./gradlew clean; ./gradlew test | tail', './gradlew test; echo BUILD SUCCESSFUL', 'cat old.log; ./gradlew test | tail', './gradlew test | sed s/a/b/', './gradlew test -m | tail', 'echo $(./gradlew test)', '! ./gradlew test | tail', './gradlew test | cat - old.log', './gradlew test & ']) {
      expect(from(command, 'test', [OK], true)).toBe(null)
    }
  })
})

describe('which command counts as a check', () => {
  const { evidenceKindsOf, checkOutcome } = evidence

  test('words inside other commands prove nothing', () => {
    for (const command of ['pip install ruff', 'echo "npm test"', 'cat jest.config.js', 'npm install jest', 'grep -r vitest src', 'git commit -m "npm test"', 'make clean', 'echo x > tsc.log', 'npm run testing-data']) {
      expect(evidenceKindsOf(command)).toEqual([])
    }
  })

  test('a command that runs several checks yields each kind once', () => {
    expect(evidenceKindsOf('npm test && npm run lint')).toEqual(['test', 'lint'])
    expect(evidenceKindsOf('npm run test -- -t "a && b; npm run build"')).toEqual(['test'])
    expect(evidenceKindsOf('npm test; npm test')).toEqual(['test'])
  })

  test('workspace flags, build goals, launchers and env prefixes are read', () => {
    const cases: Record<string, string> = {
      'npm -w pkg test': 'test',
      'pnpm --filter web test:unit': 'test',
      'mvn clean test': 'test',
      'mvn -q clean package': 'build',
      'cargo nextest run': 'test',
      'cargo +nightly test': 'test',
      'make -C sub test': 'test',
      make: 'build',
      './gradlew clean test --info': 'test',
      'CI=1 npm test': 'test',
      'cd app && (npx vitest run)': 'test',
      'tsc -b': 'build',
      'tsc --noEmit': 'typecheck',
      'uv run pytest': 'test',
      'node_modules/.bin/jest': 'test',
      'go vet ./...': 'lint',
    }
    for (const [command, kind] of Object.entries(cases)) expect([command, evidenceKindsOf(command)[0]]).toEqual([command, kind])
  })

  test('negation, background and a check that may not have run are unknown', () => {
    expect(checkOutcome('! npm test', 'test', true)).toBe(null)
    expect(checkOutcome('npm test &', 'test', true)).toBe(null)
    expect(checkOutcome('npm test |& tail', 'test', true)).toBe(null)
    expect(checkOutcome('npm test || npm run lint', 'lint', true)).toBe(null)
    expect(checkOutcome('npm test 2>&1', 'test', false)).toBe(false)
    expect(checkOutcome('npm test &> out', 'test', true)).toBe(true)
  })

  test('a failure in an && chain is not blamed on a later check', () => {
    expect(checkOutcome('npm test && npm run lint', 'lint', false)).toBe(null)
    expect(checkOutcome('npm test && npm run lint', 'lint', true)).toBe(true)
    expect(checkOutcome('npm test; npm run lint', 'lint', false)).toBe(false)
    expect(checkOutcome('npm ci && npm test', 'test', false)).toBe(false)
  })
  test('comments, escapes and flags that skip the check do not make a pass', () => {
    expect(checkOutcome("npm test  # see what's broken\necho 'done'", 'test', true)).toBe(null)
    expect(checkOutcome('ls  # ; npm test', 'test', true)).toBe(null)
    expect(evidenceKindsOf('ls # ; npm test')).toEqual([])
    for (const command of ['npx tsc --version', 'tsc --init', 'mypy --version', 'ruff format .', 'cargo test --no-run', 'pytest --collect-only', 'jest --listTests', 'make -n test', './gradlew test --dry-run', 'mvn verify -DskipTests']) {
      expect([command, evidenceKindsOf(command)]).toEqual([command, []])
    }
    expect(evidenceKindsOf('pytest -n 4')).toEqual(['test'])
  })

  test('background after a digit, substitutions, late pipefail and negated pipelines are unknown', () => {
    expect(checkOutcome('npm run build > b.log 2>&1&', 'build', true)).toBe(null)
    expect(checkOutcome('echo $(cd a; npm test)', 'test', true)).toBe(null)
    expect(checkOutcome('npm test | tail && set -o pipefail', 'test', true)).toBe(null)
    expect(checkOutcome('echo "set -o pipefail"; npm test | tail', 'test', true)).toBe(null)
    expect(checkOutcome('! a | npm test', 'test', true)).toBe(null)
  })

  test('long runs of flags classify in linear time', () => {
    const start = performance.now()
    evidenceKindsOf(`npm ${'--a '.repeat(60)}x`)
    evidenceKindsOf(`npm ${'-w '.repeat(60)}x`)
    evidenceKindsOf(`make ${'-C '.repeat(60)}x`)
    expect(performance.now() - start).toBeLessThan(1500)
  })
})

describe('here-documents', () => {
  test('the body and closing line are dropped, whatever the delimiter looks like', () => {
    expect(withoutHeredocs("python3 - <<'E'\nnpm test\nE\nls")).toBe("python3 - <<'E'\nls")
    expect(withoutHeredocs('cat <<"END"\na\nEND\nls')).toBe('cat <<"END"\nls')
    expect(withoutHeredocs('cat <<-EOF\n\ta\n\tEOF\nls')).toBe('cat <<-EOF\nls')
    expect(withoutHeredocs('cat <<A; cat <<B\n1\nA\n2\nB\nls')).toBe('cat <<A; cat <<B\nls')
    expect(withoutHeredocs('cat <<< "a b"\nls')).toBe('cat <<< "a b"\nls')
    expect(withoutHeredocs("echo '<<E'\nls")).toBe("echo '<<E'\nls")
    expect(withoutHeredocs('ls')).toBe('ls')
  })

  test('a body that never closes or that the shell would expand is left for the caller to treat whole', () => {
    expect(withoutHeredocs("python3 - <<'E'\nnpm test")).toBeUndefined()
    expect(withoutHeredocs('cat <<E\n$(npm test)\nE')).toBeUndefined()
    expect(withoutHeredocs('cat <<E\n`npm test`\nE')).toBeUndefined()
    expect(withoutHeredocs("cat <<'E'\n$(npm test)\nE")).toBe("cat <<'E'")
  })

  test('a script body runs no check, and an odd quote in it does not hide the real one', () => {
    expect(evidenceKindsOf("python3 - <<'E'\nnpm test\nE")).toEqual([])
    expect(evidenceKindsOf("python3 - <<'E'\n# don't\nE\nnpm test")).toEqual(['test'])
    expect(checkOutcome("python3 - <<'E'\n`x`\nE\nnpm test", 'test', true)).toBe(true)
    expect(checkOutcome("python3 - <<'E'\nE\nnpm test | tail", 'test', true)).toBeNull()
  })
})
