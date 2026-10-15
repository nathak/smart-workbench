import { expect, test } from 'claude-code/testing'

import { editedTurns, isGitCommit, isOwnCommit, ledgerLine, locate, maskPersonal, mergeLedgers, mergeNote, mergeNotes, parseLedger, parseSearch, personalHits, publishEvents, pushOutcome, searchLedger, sessionNote, sharedPaths, turnReport, whyTarget, type LedgerEvent } from '../hooks/ledger'
import { parsePolicy } from '../hooks/policy'

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
  const byHand = [...history, ev(12, 2500, 'commit', 2, { sha: 'dddd1234567', files: [], via: 'prompt' })]
  expect(locate(byHand, 'dddd1234567', [], undefined)?.how).toBe('inferred')
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

const rich = [
  ev(1, Date.UTC(2026, 9, 14, 9, 0), 'session.start', 0, { user: 'Kim', branch: 'main', head: 'abcdef123456' }),
  ev(2, 1100, 'prompt', 1, { text: 'mail kim@example.com from 10.0.0.5 using API_KEY=abc123', origin: 'user' }),
  ev(3, 1200, 'tool.start', 1, { id: 'c1', tool: 'Bash', summary: 'cat /home/kim/work/a.ts', policy: 'allow', toolIn: 'SECRET INPUT' }),
  ev(4, 1210, 'tool.end', 1, { id: 'c1', outcome: 'ok', ms: 5, toolOut: 'SECRET OUTPUT' }),
  ev(5, 1250, 'turn', 1, { aborted: false }),
  ev(6, 1300, 'guard.ask', 1, { tool: 'Bash', input: 'git push', reason: 'pushes', answer: 'declined', extra: 'drop me' }),
  ev(7, 1400, 'edit', 1, { file: 'src/a.ts', tool: 'Edit' }),
  ev(8, 1500, 'reply', 1, { text: 'Done in src/a.ts' }),
  ev(9, 1600, 'commit', 1, { sha: 'c0ffee1234', subject: 'Fix a', files: ['src/a.ts'], via: 'tool' }),
]

test('publishing keeps only the shared fields, masks again, shortens home folders and counts what changed', () => {
  const { events, masked } = publishEvents([...rich, ev(1, 5, 'prompt', 1, { text: 'other session' })].map(one => (one.at === 5 ? { ...one, session: 's2' } : one)), 's1')
  const text = JSON.stringify(events)
  expect(text).not.toContain('SECRET')
  expect(text).not.toContain('abc123')
  expect(text).not.toContain('/home/kim')
  expect(text).toContain('~/work/a.ts')
  expect(text).not.toContain('drop me')
  expect(events.some(one => one.kind === 'turn')).toBe(false)
  expect(events.some(one => one.session === 's2')).toBe(false)
  expect(masked).toBeGreaterThanOrEqual(2)
  expect(events.find(one => one.kind === 'guard.ask')?.reason).toBe('pushes')
})

test('emails and addresses left in a share are found and can be masked', () => {
  const { events } = publishEvents(rich, 's1')
  const hits = personalHits(events)
  expect(hits.map(one => one.what).sort()).toEqual(['email', 'ip'])
  const clean = JSON.stringify(maskPersonal(events))
  expect(clean).not.toContain('kim@example.com')
  expect(clean).not.toContain('10.0.0.5')
  expect(clean).toContain('<email>')
})

test('a shared session lives under its UTC month', () => {
  expect(sharedPaths('s1-abc', Date.UTC(2026, 9, 31, 23, 59))).toEqual({ events: 'sessions/2026-10/s1-abc.jsonl', note: 'notes/2026-10/s1-abc.md' })
  expect(sharedPaths('s1-abc', Date.UTC(2026, 10, 1, 0, 1)).events).toBe('sessions/2026-11/s1-abc.jsonl')
})

test('the note is the same for the same events and names the request, decision, files, commit and guard call', () => {
  const { events } = publishEvents(rich, 's1')
  const note = sessionNote(events)
  expect(sessionNote([...events].reverse())).toBe(note)
  expect(note).toContain('# Session s1 — Kim · 2026-10-14')
  expect(note).toContain('- Decided: Done in src/a.ts')
  expect(note).toContain('- Commit: c0ffee12 Fix a')
  expect(note).toContain('## Guard')
  expect(note).toContain('- src/a.ts: turn 1')
  expect(note.startsWith('<!-- swb:generated')).toBe(true)
  expect(note.endsWith('<!-- /swb:generated -->')).toBe(true)
})

test('regenerating a note replaces its block and keeps what people wrote; a hand-written note is kept whole', () => {
  const first = mergeNote(undefined, sessionNote(rich))
  expect(first).toContain('## Notes')
  const edited = first.replace('## Notes\n', '## Notes\nWe chose retry because of the flaky API.\n')
  const again = mergeNote(edited, sessionNote([...rich, ev(10, 1700, 'reply', 2, { text: 'later' })]))
  expect(again).toContain('We chose retry because of the flaky API.')
  expect(again).toContain('### Turn 2')
  expect(again.match(/swb:generated session/g)?.length).toBe(1)
  expect(mergeNote('Plain words by hand', sessionNote(rich))).toContain('## Notes (kept)\nPlain words by hand')
})

test('two edited notes are merged three ways and nothing is lost', () => {
  const block = sessionNote(rich)
  const base = mergeNote(undefined, block)
  const ours = base.replace('## Notes\n', '## Notes\nours\n')
  const theirs = base.replace('## Notes\n', '## Notes\ntheirs\n')
  expect(mergeNotes(base, ours, base)).toContain('ours')
  expect(mergeNotes(base, base, theirs)).toContain('theirs')
  const both = mergeNotes(base, ours, theirs)
  expect(both).toContain('theirs')
  expect(both).toContain('<!-- swb:both -->')
  expect(both).toContain('ours')
})

test('a session in both places is read from the local copy; the rest are marked shared', () => {
  const merged = mergeLedgers([ev(1, 1, 'prompt', 1, { text: 'local' })], [{ ...ev(1, 1, 'prompt', 1, { text: 'dup' }) }, { ...ev(1, 2, 'prompt', 1, { text: 'theirs' }), session: 's9' }])
  expect(merged.map(one => one.text)).toEqual(['local', 'theirs'])
  expect(merged[1]?.shared).toBe(true)
  expect(merged[0]?.shared).toBeUndefined()
})

test('search needs every word, filters by user, path and kind, sorts newest first and cuts at the limit', () => {
  const all = [...rich, { ...ev(1, 9000, 'prompt', 1, { text: 'retry the login' }), session: 's2' }, { ...ev(2, 9001, 'session.start', 0, { user: 'Lee' }), session: 's2' }]
  expect(parseSearch('retry "login page" user:Lee path:src/ kind:guard')).toEqual({ words: ['retry', 'login page'], user: 'Lee', path: 'src/', kind: 'guard' })
  expect(searchLedger(all, parseSearch('login')).lines.length).toBe(1)
  expect(searchLedger(all, parseSearch('login retry')).lines[0]).toContain('Lee')
  expect(searchLedger(all, parseSearch('login nonsense')).lines).toEqual([])
  expect(searchLedger(all, parseSearch('a.ts path:src/')).lines.length).toBe(1)
  expect(searchLedger(all, parseSearch('pushes kind:guard')).lines.length).toBe(1)
  expect(searchLedger(all, parseSearch('kim')).lines.length).toBe(1)
  const many = Array.from({ length: 25 }, (_, i) => ({ ...ev(1, 100 + i, 'prompt', 1, { text: 'same word' }), session: `x${i}` }))
  const result = searchLedger(many, parseSearch('same'), 20)
  expect(result.lines.length).toBe(20)
  expect(result.more).toBe(5)
  expect(result.lines[0]).toContain('x24')
})

test('a push is told apart as done, beaten by someone else, or failed', () => {
  expect(pushOutcome({ exitCode: 0, stdout: '', stderr: '' })).toBe('ok')
  expect(pushOutcome({ exitCode: 1, stdout: '!\trefs/heads/x:refs/heads/x\t[rejected] (fetch first)', stderr: '' })).toBe('rejected')
  expect(pushOutcome({ exitCode: 1, stdout: '', stderr: 'error: failed to push: non-fast-forward' })).toBe('rejected')
  expect(pushOutcome({ exitCode: 128, stdout: '', stderr: 'fatal: could not read from remote' })).toBe('failed')
})

test('the guard file can forbid publishing the ledger and can never switch it on by itself', () => {
  expect(parsePolicy('{"ledger":{"share":"off"}}', 'f').ledger).toEqual({ share: 'off' })
  expect(parsePolicy('{"ledger":{"share":"ask"}}', 'f').ledger).toBeUndefined()
  expect(parsePolicy('{"ledger":{"share":"auto"}}', 'f').errors[0]).toContain('ledger.share')
  expect(parsePolicy('{"ledger":"yes"}', 'f').errors[0]).toContain('ledger.share')
})

test('events from a shared session are trusted only in shape: a path-like id, a bad time or a short commit id is dropped', () => {
  const good = ledgerLine(ev(1, 5, 'prompt', 1, { text: 'ok' }))
  const lines = [
    good,
    JSON.stringify({ ...ev(2, 5, 'prompt', 1), session: 'zz99/../../../x' }),
    JSON.stringify({ ...ev(3, 5, 'prompt', 1), at: 'soon' }),
    JSON.stringify({ ...ev(4, 5, 'prompt', 1), at: null }),
    JSON.stringify({ ...ev(5, 5, 'commit', 1, { sha: 'a' }) }),
    JSON.stringify({ ...ev(6, 5, 'prompt', -1) }),
    JSON.stringify({ ...ev(7, 5, 'commit', 1, { sha: 'abcdef1' }) }),
  ].join('\n')
  expect(parseLedger(lines).map(one => one.seq)).toEqual([1, 7])
  const shared = parseLedger(lines)
  expect(() => searchLedger(shared, parseSearch('ok'))).not.toThrow()
})

test('emails inside a list (the files of a commit) are found too', () => {
  const hits = personalHits([ev(1, 1, 'commit', 1, { sha: 'abcdef1', files: ['docs/kim@example.com.md'] })])
  expect(hits.map(one => one.what)).toEqual(['email'])
})
