// The decision ledger: what was asked, answered, run and decided in a session, kept beside the repository so a later reader
// can see why a change was made, not only what changed. Pure functions only; register.tsx does the writing.

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

// `git commit` as a command of its own, after any shell separator and with git's own options (-C dir, -c k=v) before the subcommand.
const GIT_COMMIT = /(?:^|[;&|(]\s*)git(?:\s+-\S+(?:\s+[^\s-]\S*)?)*\s+commit(?:\s|$)/

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
  lines.push(`Turn ${found.turn} of session ${found.session.slice(0, 8)}${start?.user ? ` (${String(start.user)})` : ''}${first ? ` · ${when(first.at)}` : ''}`)
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
