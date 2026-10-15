// The decision ledger: what was asked, answered, run and decided in a session, kept beside the repository so a later reader
// can see why a change was made, not only what changed. Pure functions only; register.tsx does the writing.

import { redact } from './risk'

export const LEDGER_VERSION = 1
// Free text kept per event. Prompts and replies are the conversation itself; tool input and output keep the feed's shorter limit.
export const LEDGER_TEXT_MAX = 20000

export type LedgerEvent = { v: number; seq: number; at: number; session: string; turn: number; kind: string; [key: string]: unknown }

export function ledgerLine(event: LedgerEvent): string {
  return JSON.stringify(event)
}

// One JSON object per line; a torn or foreign line is skipped, never an error.
export function parseLedger(text: string): LedgerEvent[] {
  const out: LedgerEvent[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '') continue
    try {
      const one = JSON.parse(line) as unknown
      if (typeof one === 'object' && one !== null && typeof (one as LedgerEvent).kind === 'string' && typeof (one as LedgerEvent).session === 'string') out.push(one as LedgerEvent)
    } catch {
      // A half-written line.
    }
  }

  return out
}

// `git commit` as a command of its own, after any shell separator or line break, with variables before it and git's own options (-C dir, -c k=v) before the subcommand.
const GIT_COMMIT = /(?:^|[;&|(\n]\s*)(?:\w+=\S*\s+)*git(?:\s+-\S+(?:\s+[^\s-]\S*)?)*\s+commit(?:\s|$)/

export function isGitCommit(command: string): boolean {
  return GIT_COMMIT.test(command)
}

export type WhyTarget = { kind: 'line'; file: string; line: number } | { kind: 'file'; file: string } | { kind: 'commit'; sha: string }

// `file:12`, `file` or a commit id. A word that is also a path in the repository is a path; the caller checks (`isPath`).
export function whyTarget(arg: string, isPath: (word: string) => boolean): WhyTarget | undefined {
  const word = arg.trim()
  if (word === '') return undefined
  const line = /^(.+):(\d+)$/.exec(word)
  if (line && !isPath(word)) return { kind: 'line', file: line[1] as string, line: Number(line[2]) }
  if (/^[0-9a-f]{7,40}$/i.test(word) && !isPath(word)) return { kind: 'commit', sha: word.toLowerCase() }

  return { kind: 'file', file: word }
}

const cut = (text: unknown, max: number): string => {
  const one = String(text ?? '').replace(/\s+/g, ' ').trim()

  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}

// What a reflog entry's message says moved HEAD: only these make a commit that was made here; a pull, checkout, merge-less move or reset brings in commits that are not this session's work.
export function isOwnCommit(message: string): boolean {
  return /^(?:commit|cherry-pick|revert)(?:\b|:|\s|$)/.test(message.trim())
}

export type Found = { session: string; turn: number; how: 'observed' | 'inferred'; sha: string }

// The turn a commit came from: the ledger saw it made (observed), or, for a commit it did not see, the last turn that edited one of its files before it (inferred).
export function locate(events: LedgerEvent[], sha: string, files: string[], committedAt: number | undefined): Found | undefined {
  const same = (a: string, b: string): boolean => a !== '' && b !== '' && (a.startsWith(b) || b.startsWith(a))
  const seen = events.find(one => one.kind === 'commit' && same(String(one.sha ?? ''), sha))
  // A commit noticed only at the next prompt may have been made by hand between turns: its turn is a guess.
  if (seen) return { session: seen.session, turn: seen.turn, how: seen.via === 'prompt' ? 'inferred' : 'observed', sha }
  if (committedAt === undefined || files.length === 0) return undefined
  const wanted = new Set(files)
  const edits = events.filter(one => one.kind === 'edit' && typeof one.file === 'string' && wanted.has(one.file) && one.at <= committedAt)
  const last = edits.sort((a, b) => b.at - a.at)[0]

  return last ? { session: last.session, turn: last.turn, how: 'inferred', sha } : undefined
}

// The turn laid out for a reader: the request, what was run, what the guard decided, the answer, and the commit.
export function turnReport(events: LedgerEvent[], found: Found, file?: string): string {
  const here = events.filter(one => one.session === found.session && one.turn === found.turn).sort((a, b) => a.at - b.at || a.seq - b.seq)
  const start = events.find(one => one.session === found.session && one.kind === 'session.start')
  const lines: string[] = []
  const when = (at: number): string => new Date(at).toISOString().slice(0, 16).replace('T', ' ')
  const first = here[0]
  lines.push(`Turn ${found.turn} of session ${found.session.slice(0, 8)}${start?.user || start?.shared ? ` (${[start?.user ? String(start.user) : '', start?.shared ? 'shared' : ''].filter(Boolean).join(', ')})` : ''}${first ? ` · ${when(first.at)}` : ''}`)
  if (found.sha !== '') lines.push(found.how === 'observed' ? `Commit ${found.sha.slice(0, 8)} was made in this turn.` : `Commit ${found.sha.slice(0, 8)} is matched by the files it touched (inferred; the ledger did not see it made).`)
  else lines.push('Not committed yet (matched by the edits made in this turn).')
  const contract = events.filter(one => one.session === found.session && one.kind === 'contract' && one.seq <= (first?.seq ?? Infinity)).at(-1)
  if (contract?.goal) lines.push(`Goal: ${cut(contract.goal, 240)}`)
  for (const one of here) {
    if (one.kind === 'prompt') lines.push('', `Asked: ${cut(one.text, 900)}`)
  }
  const starts = here.filter(one => one.kind === 'tool.start')
  if (starts.length > 0) {
    lines.push('', 'Actions:')
    for (const one of starts) {
      const end = here.find(item => item.kind === 'tool.end' && item.id === one.id)
      const mark = file !== undefined && String(one.summary ?? '').includes(file) ? ' ◆' : ''
      lines.push(`  ${String(one.tool)} ${cut(one.summary, 110)} → ${String(end?.outcome ?? 'no end')}${one.policy && one.policy !== 'allow' ? ` (guard: ${String(one.policy)})` : ''}${mark}`)
    }
  }
  const guards = here.filter(one => String(one.kind).startsWith('guard.'))
  if (guards.length > 0) {
    lines.push('', 'Guard:')
    for (const one of guards) lines.push(`  ${String(one.kind)} ${cut(one.input ?? one.summary ?? one.tool, 90)}${one.reason ? ` — ${cut(one.reason, 120)}` : ''}${one.answer ? ` [${String(one.answer)}]` : ''}`)
  }
  const reply = here.filter(one => one.kind === 'reply').at(-1)
  if (reply) lines.push('', `Answered: ${cut(reply.text, 900)}`)
  const commit = here.find(one => one.kind === 'commit')
  if (commit) lines.push('', `Commit: ${String(commit.sha).slice(0, 8)} ${cut(commit.subject, 120)}`)

  return lines.join('\n')
}

// Turns that edited a file, newest first: the answer for a line that is not committed yet.
export function editedTurns(events: LedgerEvent[], file: string): Found[] {
  const seen = new Set<string>()
  const out: Found[] = []
  for (const one of events.filter(item => item.kind === 'edit' && item.file === file).sort((a, b) => b.at - a.at)) {
    const key = `${one.session}:${one.turn}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ session: one.session, turn: one.turn, how: 'inferred', sha: '' })
  }

  return out
}

// ---- sharing: what leaves the machine, as little as a reader needs

const COMMON = ['v', 'seq', 'at', 'session', 'turn', 'kind']
// The fields each kind keeps when a session is published. A kind not listed (turn, turn.agent) and every tool input and output are left out.
export const SHARE_FIELDS: Record<string, readonly string[]> = {
  'session.start': ['user', 'branch', 'head'],
  prompt: ['text', 'origin'],
  reply: ['text'],
  contract: ['goal', 'done'],
  'tool.start': ['id', 'tool', 'summary', 'category', 'risk', 'policy', 'agent', 'subagent'],
  'tool.end': ['id', 'outcome', 'ms'],
  edit: ['file', 'tool'],
  commit: ['sha', 'subject', 'files', 'via'],
}
const GUARD_FIELDS = ['tool', 'input', 'reason', 'answer', 'rule', 'profile', 'scope']
const HOME = /(?:\/home\/[^/\s"']+|\/Users\/[^/\s"']+|[A-Za-z]:\\Users\\[^\\\s"']+)/g

function scrub(value: unknown, count: { n: number }): unknown {
  if (typeof value === 'string') {
    const out = redact(value).replace(HOME, '~')
    if (out !== value) count.n++

    return out
  }
  if (Array.isArray(value)) return value.map(one => scrub(one, count))

  return value
}

// The events of one session cut down to what is shared, with every text masked once more and home folders shortened; `masked` counts the fields that changed.
export function publishEvents(events: LedgerEvent[], session: string): { events: LedgerEvent[]; masked: number } {
  const count = { n: 0 }
  const out: LedgerEvent[] = []
  for (const one of events.filter(item => item.session === session).sort((a, b) => a.at - b.at || a.seq - b.seq)) {
    const keep = one.kind.startsWith('guard.') ? GUARD_FIELDS : SHARE_FIELDS[one.kind]
    if (!keep) continue
    const shared: Record<string, unknown> = {}
    for (const key of [...COMMON, ...keep]) if (one[key] !== undefined) shared[key] = scrub(one[key], count)
    out.push(shared as LedgerEvent)
  }

  return { events: out, masked: count.n }
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g
const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g
const IPV6 = /\b(?:[0-9a-f]{1,4}:){3,7}[0-9a-f]{1,4}\b/gi

export type Personal = { seq: number; kind: string; what: 'email' | 'ip'; snippet: string }

// Emails and IP addresses left in what is about to be shared, for the person to look at before agreeing.
export function personalHits(events: LedgerEvent[]): Personal[] {
  const out: Personal[] = []
  for (const one of events) {
    for (const [key, value] of Object.entries(one)) {
      if (typeof value !== 'string') continue
      for (const [pattern, what] of [[EMAIL, 'email'], [IPV4, 'ip'], [IPV6, 'ip']] as const) {
        for (const match of value.matchAll(new RegExp(pattern.source, pattern.flags))) {
          const at = match.index ?? 0
          out.push({ seq: one.seq, kind: `${one.kind}.${key}`, what, snippet: value.slice(Math.max(0, at - 20), at + match[0].length + 20).replace(/\s+/g, ' ') })
        }
      }
    }
  }

  return out
}

export function maskPersonal(events: LedgerEvent[]): LedgerEvent[] {
  const mask = (value: unknown): unknown => (typeof value === 'string' ? value.replace(EMAIL, '<email>').replace(IPV4, '<ip>').replace(IPV6, '<ip>') : Array.isArray(value) ? value.map(mask) : value)

  return events.map(one => Object.fromEntries(Object.entries(one).map(([key, value]) => [key, COMMON.includes(key) ? value : mask(value)])) as LedgerEvent)
}

// Where a published session lives on the shared branch: by the UTC month it started, so no folder grows without end.
export function sharedPaths(session: string, startedAt: number): { events: string; note: string } {
  const month = new Date(startedAt).toISOString().slice(0, 7)

  return { events: `sessions/${month}/${session}.jsonl`, note: `notes/${month}/${session}.md` }
}

const BLOCK_START = '<!-- swb:generated'
const BLOCK_END = '<!-- /swb:generated -->'
const day = (at: number): string => new Date(at).toISOString().slice(0, 10)

// The part of a session a reader wants first, built only from the events (no clock, no model), so the same events give the same text.
export function sessionNote(events: LedgerEvent[]): string {
  const list = [...events].sort((a, b) => a.at - b.at || a.seq - b.seq)
  const first = list[0]
  const session = first?.session ?? ''
  const start = list.find(one => one.kind === 'session.start')
  const lines = [`${BLOCK_START} session=${session} v=1 -->`, `# Session ${session.slice(0, 8)}${start?.user ? ` — ${String(start.user)}` : ''}${start || first ? ` · ${day((start ?? first)?.at ?? 0)}` : ''}`]
  if (start?.branch || start?.head) lines.push(`Branch: ${String(start.branch ?? '?')} · started at ${String(start.head ?? '?').slice(0, 8)}`)
  const goal = list.filter(one => one.kind === 'contract').at(-1)
  if (goal?.goal) lines.push(`Goal: ${cut(goal.goal, 300)}`)
  const turns = [...new Set(list.filter(one => one.turn > 0).map(one => one.turn))].sort((a, b) => a - b)
  if (turns.length > 0) lines.push('', '## Turns')
  const byFile = new Map<string, Set<number>>()
  for (const turn of turns) {
    const here = list.filter(one => one.turn === turn)
    const ask = here.find(one => one.kind === 'prompt')
    const reply = here.filter(one => one.kind === 'reply').at(-1)
    const tools = here.filter(one => one.kind === 'tool.start').length
    const bad = here.filter(one => one.kind === 'tool.end' && (one.outcome === 'blocked' || one.outcome === 'declined')).length
    const files = [...new Set(here.filter(one => one.kind === 'edit').map(one => String(one.file)))]
    for (const file of files) byFile.set(file, (byFile.get(file) ?? new Set()).add(turn))
    const commits = here.filter(one => one.kind === 'commit')
    lines.push('', `### Turn ${turn}`)
    if (ask) lines.push(`- Asked: ${cut(ask.text, 300)}`)
    if (reply) lines.push(`- Decided: ${cut(reply.text, 300)}`)
    lines.push(`- Actions: ${tools}${bad > 0 ? ` (${bad} blocked or declined)` : ''}`)
    if (files.length > 0) lines.push(`- Files: ${files.join(', ')}`)
    for (const one of commits) lines.push(`- Commit: ${String(one.sha).slice(0, 8)} ${cut(one.subject, 100)}${one.via === 'prompt' ? ' (noticed later)' : ''}`)
  }
  const guards = list.filter(one => one.kind.startsWith('guard.'))
  if (guards.length > 0) {
    lines.push('', '## Guard')
    for (const one of guards) lines.push(`- turn ${one.turn}: ${one.kind} ${cut(one.input ?? one.tool, 80)}${one.reason ? ` — ${cut(one.reason, 100)}` : ''}${one.answer ? ` [${String(one.answer)}]` : ''}`)
  }
  if (byFile.size > 0) {
    lines.push('', '## Files')
    for (const [file, set] of [...byFile].sort(([a], [b]) => a.localeCompare(b))) lines.push(`- ${file}: turn ${[...set].join(', ')}`)
  }
  lines.push(BLOCK_END)

  return lines.join('\n')
}

const notesOf = (text: string | undefined): string => {
  if (text === undefined) return ''
  const at = text.indexOf(BLOCK_END)

  return (at < 0 ? text : text.slice(at + BLOCK_END.length)).trim()
}
const withNotes = (block: string, notes: string): string => `${block}\n\n${notes.startsWith('## Notes') ? notes : `## Notes\n${notes}`}`.trimEnd() + '\n'

// The generated block is replaced; what a person wrote under it stays. A note with no block (written by hand) is kept whole under a heading.
export function mergeNote(existing: string | undefined, generated: string): string {
  if (existing === undefined || existing.trim() === '') return withNotes(generated, '## Notes\n')
  if (existing.includes(BLOCK_END)) return withNotes(generated, notesOf(existing) || '## Notes\n')

  return withNotes(generated, `## Notes (kept)\n${existing.trim()}`)
}

// Two people edited the same note: the generated block is the publisher's (ours); the notes under it are merged three ways and nothing is dropped.
export function mergeNotes(base: string | undefined, ours: string, theirs: string): string {
  const [b, o, t] = [notesOf(base), notesOf(ours), notesOf(theirs)]
  const notes = t === b || t === o ? o : o === b ? t : `${t}\n<!-- swb:both -->\n${o}`
  const at = ours.indexOf(BLOCK_END)

  return withNotes(at < 0 ? ours : ours.slice(0, at + BLOCK_END.length), notes || '## Notes\n')
}

// A session in both places is the local one (it has more); the rest come from the shared branch and are marked.
export function mergeLedgers(local: LedgerEvent[], shared: LedgerEvent[]): LedgerEvent[] {
  const mine = new Set(local.map(one => one.session))

  return [...local, ...shared.filter(one => !mine.has(one.session)).map(one => ({ ...one, shared: true }))]
}

export type SearchQuery = { words: string[]; user?: string; path?: string; kind?: string }

export function parseSearch(arg: string): SearchQuery {
  const query: SearchQuery = { words: [] }
  for (const match of arg.matchAll(/(?:(user|path|kind):)?(?:"([^"]*)"|(\S+))/g)) {
    const text = match[2] ?? match[3] ?? ''
    if (match[1]) query[match[1] as 'user' | 'path' | 'kind'] = text
    else if (text !== '') query.words.push(text.toLowerCase())
  }

  return query
}

const TEXT_KEYS = ['text', 'summary', 'subject', 'file', 'goal', 'reason', 'input', 'done'] as const

// Turns whose text holds every word, newest first, one line each.
export function searchLedger(events: LedgerEvent[], q: SearchQuery, limit = 20): { lines: string[]; more: number } {
  const users = new Map<string, string>()
  for (const one of events) if (one.kind === 'session.start' && typeof one.user === 'string') users.set(one.session, one.user)
  const turns = new Map<string, LedgerEvent[]>()
  for (const one of events) if (one.turn > 0) turns.set(`${one.session}\u0000${one.turn}`, [...(turns.get(`${one.session}\u0000${one.turn}`) ?? []), one])
  const hits: Array<{ at: number; line: string }> = []
  for (const here of turns.values()) {
    const session = here[0]?.session ?? ''
    if (q.user && !(users.get(session) ?? '').toLowerCase().includes(q.user.toLowerCase())) continue
    if (q.kind && !here.some(one => (q.kind === 'guard' ? one.kind.startsWith('guard.') : one.kind === q.kind))) continue
    if (q.path) {
      const want = q.path
      const touches = here.some(one => (typeof one.file === 'string' && one.file.startsWith(want)) || (Array.isArray(one.files) && one.files.some(file => String(file).startsWith(want))) || String(one.summary ?? '').includes(want))
      if (!touches) continue
    }
    const pieces = here.flatMap(one => TEXT_KEYS.filter(key => typeof one[key] === 'string').map(key => String(one[key])))
    const hay = pieces.join('\n').toLowerCase()
    if (!q.words.every(word => hay.includes(word))) continue
    const around = q.words[0] === undefined ? pieces[0] ?? '' : pieces.find(piece => piece.toLowerCase().includes(q.words[0] as string)) ?? ''
    const at = q.words[0] === undefined ? 0 : Math.max(0, around.toLowerCase().indexOf(q.words[0]) - 40)
    const last = Math.max(...here.map(one => one.at))
    const turn = here[0]?.turn ?? 0
    const kinds = [...new Set(here.map(one => (one.kind.startsWith('guard.') ? 'guard' : one.kind)).filter(kind => ['prompt', 'reply', 'edit', 'commit', 'guard'].includes(kind)))]
    hits.push({ at: last, line: `${new Date(last).toISOString().slice(0, 16).replace('T', ' ')}  ${users.get(session) ?? '?'}${here.some(one => one.shared) ? ' (shared)' : ''}  ${session.slice(0, 8)} t${turn}  [${kinds.join(',')}]  ${cut(around.slice(at), 120)}` })
  }
  hits.sort((a, b) => b.at - a.at)

  return { lines: hits.slice(0, limit).map(one => one.line), more: Math.max(0, hits.length - limit) }
}

export function pushOutcome(run: { exitCode: number; stdout: string; stderr: string }): 'ok' | 'rejected' | 'failed' {
  if (run.exitCode === 0) return 'ok'

  return /\[rejected\]|non-fast-forward|fetch first/i.test(`${run.stdout}\n${run.stderr}`) ? 'rejected' : 'failed'
}
