// Team features that touch no engine API: audit lines, CI results, issue refs and
// the shared task file. register.tsx does the reading, writing and process runs.
import type { ContextPin, EvidenceRecord, IssueRef, Task, Workbench } from '../types'

// ---- audit log

export const AUDIT_MAX_CHARS = 1_000_000

export type AuditEntry = {
  at: string
  event: string
  session?: string
  user?: string
  [detail: string]: unknown
}

export function auditLine(entry: AuditEntry): string {
  return `${JSON.stringify(entry)}\n`
}

// Appends a line; past the size cap the old log moves aside whole and a new one starts.
export function appendAudit(existing: string | undefined, line: string): { text: string; rotated?: string } {
  const current = existing ?? ''

  if (current.length > 0 && current.length + line.length > AUDIT_MAX_CHARS) {
    return { text: line, rotated: current }
  }

  return { text: current + line }
}

export function readAudit(text: string): AuditEntry[] {
  return text.split('\n').flatMap(line => {
    if (line.trim() === '') return []
    try {
      const entry = JSON.parse(line) as AuditEntry
      return typeof entry.event === 'string' && typeof entry.at === 'string' ? [entry] : []
    } catch {
      return []
    }
  })
}

export function formatAudit(entries: readonly AuditEntry[], count: number): string {
  return entries
    .slice(-count)
    .map(({ at, event, session: _session, user, ...detail }) => {
      const rest = Object.entries(detail)
        .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
        .join(' ')
      return `${at.replace('T', ' ').slice(0, 19)} ${user ?? '?'} ${event}${rest ? ` ${rest}` : ''}`
    })
    .join('\n')
}

// ---- CI (GitHub Actions through the local gh CLI)

export type GhRun = {
  databaseId: number
  workflowName?: string
  name?: string
  status: string
  conclusion: string | null
  headSha: string
  url?: string
}

const FAILED = new Set(['failure', 'cancelled', 'timed_out', 'startup_failure', 'action_required'])

// One record per workflow, its latest run on this exact commit. With uncommitted code
// changes the run did not test what is on disk, so it only counts as observed.
export function ciEvidence(runs: readonly GhRun[], sha: string, hasLocalChanges: boolean, at: number): EvidenceRecord[] {
  const latest = new Map<string, GhRun>()

  for (const run of runs) {
    if (run.headSha !== sha) continue
    const name = run.workflowName ?? run.name ?? 'workflow'
    const seen = latest.get(name)
    if (!seen || run.databaseId > seen.databaseId) latest.set(name, run)
  }

  return [...latest.entries()].map(([name, run]) => {
    const done = run.status === 'completed'
    const ok = !done || hasLocalChanges || run.conclusion === 'skipped' || run.conclusion === 'neutral' ? null : run.conclusion === 'success' ? true : FAILED.has(run.conclusion ?? '') ? false : null

    return { id: `ci-${run.databaseId}`, kind: 'ci' as const, command: `CI: ${name} @ ${sha.slice(0, 7)}${done ? '' : ' (running)'}`, ok, at }
  })
}

export function ciSummary(records: readonly EvidenceRecord[], hasLocalChanges: boolean): string {
  if (records.length === 0) {
    return 'No CI runs found for the current commit (push it, or wait for the workflow to start).'
  }
  const lines = records.map(one => `${one.ok === null ? '◐' : one.ok ? '✓' : '✕'} ${one.command}`)
  const note = hasLocalChanges ? ['Uncommitted code changes: CI results count as observed until you commit and push.'] : []

  return [...lines, ...note].join('\n')
}

// ---- issues

// "#123", "123" or a GitHub issue URL go through gh; anything else ("LIN-42 Fix login") is kept as typed.
export function parseIssueArg(args: string): { ref: string; title?: string; isGitHub: boolean } | undefined {
  const text = args.trim()
  if (text === '') return undefined

  const url = /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/(?:issues|pull)\/\d+/.exec(text)
  if (url) return { ref: url[0], isGitHub: true }

  const number = /^#?(\d+)$/.exec(text)
  if (number) return { ref: number[1] ?? text, isGitHub: true }

  const [ref = text, ...rest] = text.split(/\s+/)
  const title = rest.join(' ').trim()

  return { ref, ...(title ? { title } : {}), isGitHub: false }
}

export function issueRef(found: { number?: number; title?: string; url?: string }, ref: string): IssueRef {
  return {
    ref: found.number !== undefined ? `#${found.number}` : ref,
    ...(found.title ? { title: found.title } : {}),
    ...(found.url ? { url: found.url } : {}),
  }
}

// ---- the shared task file (one machine shares, another picks up, through git)

export const SHARE_PATH = '.claude/smartworkbench-task.json'

export type SharedTask = {
  format: 'smartworkbench-task'
  version: 1
  sharedAt: string
  sharedBy?: string
  task: Task
  pins: ContextPin[]
}

export function shareText(wb: Workbench, sharedAt: number, sharedBy: string | undefined): string {
  const shared: SharedTask = {
    format: 'smartworkbench-task',
    version: 1,
    sharedAt: new Date(sharedAt).toISOString(),
    ...(sharedBy ? { sharedBy } : {}),
    task: wb.task,
    pins: wb.context.pins,
  }

  return `${JSON.stringify(shared, null, 2)}\n`
}

export function readShare(text: string): SharedTask | { error: string } {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { error: 'not valid JSON' }
  }
  const value = raw as Partial<SharedTask>

  if (value?.format !== 'smartworkbench-task' || value.version !== 1) {
    return { error: 'not a SmartWorkbench task file (format/version)' }
  }
  if (typeof value.task !== 'object' || value.task === null || typeof value.task.goal !== 'string' || !Array.isArray(value.task.doneConditions)) {
    return { error: 'the task is missing or malformed' }
  }

  return { ...(value as SharedTask), pins: Array.isArray(value.pins) ? value.pins : [] }
}
