import { expect, test } from 'claude-code/testing'

import { editedTurns, isGitCommit, isOwnCommit, ledgerLine, locate, parseLedger, turnReport, whyTarget, type LedgerEvent } from '../hooks/ledger'

const ev = (seq: number, at: number, kind: string, turn: number, rest: Record<string, unknown> = {}): LedgerEvent => ({ v: 1, seq, at, session: 's1', turn, kind, ...rest })

test('a ledger line round-trips and a torn or foreign line is skipped', () => {
  const one = ev(1, 5, 'prompt', 1, { text: 'hi' })
  expect(parseLedger(`\n${ledgerLine(one)}\n{"half":\n[1]\nnot json\n${ledgerLine(ev(2, 6, 'reply', 1))}\n`)).toEqual([one, ev(2, 6, 'reply', 1)])
})

test('git commit is found as a command, with git options and after separators, not inside other words', () => {
  for (const yes of ['git commit -m x', 'git -C sub commit -am "x"', 'git -c user.name=a commit', 'npm test && git commit -m x', 'cd a; git commit', 'git add .\ngit commit -m x', 'GIT_AUTHOR_DATE=now git commit -m x']) expect(isGitCommit(yes)).toBe(true)
  for (const no of ['git log --oneline', 'git commit-tree abc', 'echo git commit', 'git status']) expect(isGitCommit(no)).toBe(false)
})

test('why reads file:line, a file, or a commit id, and a word that is a path stays a path', () => {
  const none = () => false
  expect(whyTarget('src/a.ts:12', none)).toEqual({ kind: 'line', file: 'src/a.ts', line: 12 })
  expect(whyTarget('src/a.ts', none)).toEqual({ kind: 'file', file: 'src/a.ts' })
  expect(whyTarget('ABCDEF1', none)).toEqual({ kind: 'commit', sha: 'abcdef1' })
  expect(whyTarget('abcdef1', word => word === 'abcdef1')).toEqual({ kind: 'file', file: 'abcdef1' })
  expect(whyTarget('  ', none)).toBeUndefined()
})

const history = [
  ev(1, 1000, 'session.start', 0, { user: 'Kim' }),
  ev(2, 1100, 'contract', 1, { goal: 'Fix login' }),
  ev(3, 1200, 'prompt', 1, { text: 'login fails after timeout' }),
  ev(4, 1300, 'tool.start', 1, { id: 'c1', tool: 'Bash', summary: 'git push origin main', policy: 'ask' }),
  ev(5, 1310, 'guard.ask', 1, { id: 'c1', input: 'git push origin main', reason: 'pushes', answer: 'declined' }),
  ev(6, 1320, 'tool.end', 1, { id: 'c1', outcome: 'declined' }),
  ev(7, 1400, 'edit', 1, { file: 'src/login.ts', tool: 'Edit' }),
  ev(8, 1500, 'reply', 1, { text: 'Fixed the timeout handling' }),
  ev(9, 1600, 'commit', 1, { sha: 'abc1234567', subject: 'Fix login timeout', files: ['src/login.ts'], via: 'tool' }),
  ev(10, 2000, 'prompt', 2, { text: 'another task' }),
  ev(11, 2100, 'edit', 2, { file: 'src/other.ts', tool: 'Edit' }),
]

test('a commit the ledger saw made is observed; one it did not is matched by its files and says so', () => {
  expect(locate(history, 'abc1234567', [], undefined)).toEqual({ session: 's1', turn: 1, how: 'observed', sha: 'abc1234567' })
  expect(locate(history, 'abc1234', [], undefined)?.how).toBe('observed')
  expect(locate(history, 'ffff', ['src/other.ts'], 3000)).toEqual({ session: 's1', turn: 2, how: 'inferred', sha: 'ffff' })
  expect(locate(history, 'ffff', ['src/other.ts'], 1500)).toBeUndefined()
  expect(locate(history, 'ffff', [], 3000)).toBeUndefined()
  const byHand = [...history, ev(12, 2500, 'commit', 2, { sha: 'dddd', files: [], via: 'prompt' })]
  expect(locate(byHand, 'dddd', [], undefined)?.how).toBe('inferred')
})

test('the report names the request, the goal, the actions with the guard decision, the answer and the commit', () => {
  const text = turnReport(history, { session: 's1', turn: 1, how: 'observed', sha: 'abc1234567' }, 'src/login.ts')
  expect(text).toContain('Kim')
  expect(text).toContain('Goal: Fix login')
  expect(text).toContain('Asked: login fails after timeout')
  expect(text).toContain('Bash git push origin main → declined (guard: ask)')
  expect(text).toContain('guard.ask git push origin main — pushes [declined]')
  expect(text).toContain('Answered: Fixed the timeout handling')
  expect(text).toContain('Commit: abc12345 Fix login timeout')
  expect(text).not.toContain('another task')
})

test('uncommitted edits are found by file, newest turn first', () => {
  expect(editedTurns(history, 'src/other.ts')).toEqual([{ session: 's1', turn: 2, how: 'inferred', sha: '' }])
  expect(turnReport(history, { session: 's1', turn: 2, how: 'inferred', sha: '' })).toContain('Not committed yet')
  expect(editedTurns(history, 'nope.ts')).toEqual([])
})

test('only a commit, an amend, a cherry-pick or a revert is a commit made here; a pull, checkout or reset is not', () => {
  for (const yes of ['commit: Fix it', 'commit (amend): Fix it', 'commit (merge): x', 'commit (initial): x', 'cherry-pick: x', 'revert: x']) expect(isOwnCommit(yes)).toBe(true)
  for (const no of ['pull --rebase (finish): returning to refs/heads/main', 'checkout: moving from a to b', 'reset: moving to HEAD~1', 'merge feature: Fast-forward', 'rebase (pick): theirs', '']) expect(isOwnCommit(no)).toBe(false)
})
