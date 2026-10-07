import { describe, expect, test } from 'claude-code/testing'

import type { EvidenceRecord, Task } from '../types'
import { parsePinSpec, sliceLines } from '../hooks/context'
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
