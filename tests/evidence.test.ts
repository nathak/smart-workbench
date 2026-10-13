import { describe, expect, test } from 'claude-code/testing'

import type { EvidenceRecord, Task } from '../types'
import { parsePinSpec, sliceLines } from '../hooks/context'
import * as evidence from '../hooks/evidence'
import { completionOf, evidenceKindOf, guessLink, statusOf } from '../hooks/evidence'
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
