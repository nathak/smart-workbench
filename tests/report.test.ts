import { describe, expect, test } from 'claude-code/testing'

import type { EvidenceRecord, ToolCallRecord } from '../types'
import { emptyWorkbench } from '../hooks/model'
import { badgeOf, handoffMarkdown } from '../hooks/report'

const NOW = Date.UTC(2026, 9, 11, 3, 4, 0)

const call = (extra: Partial<ToolCallRecord> = {}): ToolCallRecord => ({
  id: 'c1',
  tool: 'Bash',
  summary: 'npm test',
  risk: 'low',
  policy: 'allow',
  outcome: 'allowed',
  startedAt: NOW,
  ...extra,
})

const run = (extra: Partial<EvidenceRecord> = {}): EvidenceRecord => ({ id: 'e1', kind: 'test', command: 'npm test', ok: true, at: NOW, ...extra })

describe('handoff markdown', () => {
  test('an empty workbench still exports a status and a goal placeholder', async () => {
    const text = handoffMarkdown(emptyWorkbench(), NOW)
    expect(text).toContain('# SmartWorkbench handoff')
    expect(text).toContain('- Exported: 2026-10-11 03:04 UTC')
    expect(text).toContain('_none_')
    expect(text.endsWith('\n')).toBe(true)
  })

  test('lists the contract, each condition with its proof, and blocked calls', async () => {
    const wb = emptyWorkbench()
    wb.task.goal = 'Fix login expiry'
    wb.task.locked = true
    wb.task.constraints = [
      { id: 'k1', text: 'Keep the API', priority: 'hard', isActive: true },
      { id: 'k2', text: 'Off one', priority: 'soft', isActive: false },
    ]
    wb.task.nonGoals = ['No refactor']
    wb.task.doneConditions = [
      { id: 'dc-1', text: 'Related tests pass', link: 'test' },
      { id: 'dc-2', text: 'Typecheck passes', link: 'typecheck' },
    ]
    wb.evidence = [run()]
    wb.execution.recentCalls = [call({ outcome: 'blocked', tool: 'Bash', summary: 'rm -rf build', reason: 'broad delete' })]

    const text = handoffMarkdown(wb, NOW)
    expect(text).toContain('(contract locked)')
    expect(text).toContain('Fix login expiry')
    expect(text).toContain('- [H] Keep the API')
    expect(text).not.toContain('Off one')
    expect(text).toContain('- No refactor')
    expect(text).toContain('passed: `npm test`')
    expect(text).toContain('no typecheck run yet')
    expect(text).toContain('## Blocked or declined calls')
    expect(text).toContain('blocked: Bash `rm -rf build` — broad delete')
  })
})

describe('tool row badge', () => {
  const wb = emptyWorkbench()

  test('a plainly allowed low-risk call gets no badge', async () => {
    expect(badgeOf(call(), undefined, wb)).toBeUndefined()
  })

  test('a blocked call names the outcome, the risk and the reason', async () => {
    const text = badgeOf(call({ risk: 'high', policy: 'block', outcome: 'blocked', reason: 'broad delete' }), undefined, wb)
    expect(text).toBe('WB · HIGH · Blocked · broad delete')
  })

  test('a call allowed after an ask or for the session says so', async () => {
    expect(badgeOf(call({ risk: 'high', policy: 'ask' }), undefined, wb)).toContain('Asked → allowed')
    expect(badgeOf(call({ risk: 'high', policy: 'ask', sessionAllowed: true }), undefined, wb)).toContain('Allowed for session')
  })

  test('a check result names the conditions it is evidence for', async () => {
    const withTask = emptyWorkbench()
    withTask.task.doneConditions = [{ id: 'dc-1', text: 'Tests pass', link: 'test' }]
    expect(badgeOf(call(), run(), withTask)).toBe('WB · test passed · evidence for dc-1')
    expect(badgeOf(call(), run({ ok: false }), withTask)).toContain('test failed')
    expect(badgeOf(call(), run({ ok: null }), withTask)).toContain('test observed')
  })
})
