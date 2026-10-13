import { describe, expect, test } from 'claude-code/testing'

import { parseDiff, unquotePath } from '../hooks/diff'
import { categoryOf } from '../hooks/files'
import * as model from '../hooks/model'
import { readShare, shareText } from '../hooks/team'

describe('diff reading', () => {
  test('a deleted "-- x" line or an added "++ x" line is content, not a file header', async () => {
    const text = ['diff --git a/db/q.sql b/db/q.sql', '--- a/db/q.sql', '+++ b/db/q.sql', '@@ -3 +3,0 @@', '--- comment', '@@ -9,0 +9 @@', '+++ x'].join('\n')
    const parsed = parseDiff(text)
    expect(Object.keys(parsed.hunks)).toEqual(['db/q.sql'])
    expect(parsed.hunks['db/q.sql']?.length).toBe(2)
    expect(parsed.removed).toBe(1)
    expect(parsed.added).toBe(1)
  })

  test('a quoted path with unusual characters is read as the real name', async () => {
    expect(unquotePath('"b/\\355\\225\\234.ts"')).toBe('b/한.ts')
    expect(unquotePath('"a\\tb\\"c"')).toBe('a\tb"c')
    expect(unquotePath('plain.ts')).toBe('plain.ts')
    const parsed = parseDiff(['diff --git "a/\\355\\225\\234.ts" "b/\\355\\225\\234.ts"', '--- "a/\\355\\225\\234.ts"', '+++ "b/\\355\\225\\234.ts"', '@@ -1 +1 @@', '-a', '+b'].join('\n'))
    expect(Object.keys(parsed.hunks)).toEqual(['한.ts'])
  })
})

describe('file classes', () => {
  test('keys and credential files are secrets, example env files and requirements are not', async () => {
    for (const path of ['id_ed25519', 'home/.ssh/id_ecdsa', '.git-credentials', '.envrc', 'cert.pfx', 'C:\\repo\\.env']) expect(categoryOf(path)).toBe('secret')
    expect(categoryOf('.env.example')).not.toBe('secret')
    expect(categoryOf('requirements.txt')).toBe('source')
    expect(categoryOf('notes.txt')).toBe('docs')
  })
})

describe('what a shared file or a template may bring', () => {
  const task = { id: 't', status: 'active', locked: true, goal: 'g', constraints: [], nonGoals: [], doneConditions: [{ id: 'dc-1', text: 'x' }] }
  const file = (extra: object) => JSON.stringify({ format: 'smartworkbench-task', version: 1, sharedAt: 'now', task: { ...task, ...extra }, pins: [] })

  test('damaged elements are dropped or rebuilt instead of reaching the panel', async () => {
    const shared = readShare(file({ doneConditions: [{}, null, 3, { id: 5, text: 'ok', link: 'bogus' }], constraints: [{ isActive: true }, { text: 'keep', priority: 'soft' }], nonGoals: ['a', 4] }))
    if ('error' in shared) throw new Error(shared.error)
    expect(shared.task.doneConditions.map(one => one.text)).toEqual(['ok'])
    expect(shared.task.doneConditions[0]?.link).toBe(undefined)
    expect(shared.task.constraints.map(one => one.text)).toEqual(['keep'])
    expect(shared.task.nonGoals).toEqual(['a'])
  })

  test('a shared task comes in unlocked, with open proposals cleared and no pin of a secrets or outside file', async () => {
    const raw = JSON.stringify({
      format: 'smartworkbench-task',
      version: 1,
      sharedAt: 'now',
      task,
      pins: [
        { kind: 'file', path: '/home/u/.ssh/id_ed25519', mode: 'live' },
        { kind: 'file', path: '.env', mode: 'live' },
        { kind: 'file', path: '../other/x.ts', mode: 'live' },
        { kind: 'file', path: 'src/ok.ts', mode: 'live' },
        { kind: 'note', text: 'hi' },
      ],
    })
    const shared = readShare(raw)
    if ('error' in shared) throw new Error(shared.error)
    const base = model.addProposal(model.emptyWorkbench(), { id: 'a', change: 'remove_done_condition', target: 'dc-1', reason: 'r', at: 1, status: 'open' })
    const wb = model.applyShare(base, shared)
    expect(wb.task.locked).toBe(false)
    expect(wb.proposals.length).toBe(0)
    expect(wb.context.pins.map(one => (one.kind === 'file' ? one.path : one.text))).toEqual(['src/ok.ts', 'hi'])
  })

  test('a pin typed or loaded must be a project path that is not a secrets file; new and clear behave', async () => {
    let wb = model.emptyWorkbench()
    for (const spec of ['.env', '/etc/passwd', '../x', 'C:\\x\\a.ts', 'id_rsa']) wb = model.pinFile(wb, spec)
    expect(wb.context.pins.length).toBe(0)
    wb = model.pinFile(wb, 'src/a.ts:1-5')
    expect(wb.context.pins.length).toBe(1)
    const withProposal = model.addProposal(wb, { id: 'p', change: 'remove_done_condition', target: 'dc-1', reason: 'r', at: 1, status: 'open' })
    expect(model.newTask(withProposal).proposals.length).toBe(0)
    const team = { enabled: true, codex: { enabled: true, review: true, rescue: false } }
    expect(model.clearAll({ ...wb, team }).team).toEqual(team)
    expect(shareText(wb, 0, undefined)).toContain('src/a.ts')
  })
})
