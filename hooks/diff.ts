import type { Changed, EvidenceRecord, Hunk } from '../types'
import { affectsChecks } from './files'

export type ParsedDiff = { hunks: Record<string, Hunk[]>; added: number; removed: number }

// git quotes a path with unusual characters in C style ("a\\303\\244.ts"): back to the real name.
export function unquotePath(text: string): string {
  if (text.length < 2 || !text.startsWith('"') || !text.endsWith('"')) return text
  const body = text.slice(1, -1)
  const bytes: number[] = []
  const encoder = new TextEncoder()
  for (let i = 0; i < body.length; i++) {
    const c = body.charAt(i)
    if (c !== '\\') {
      bytes.push(...encoder.encode(c))
      continue
    }
    const octal = /^[0-7]{1,3}/.exec(body.slice(i + 1))
    if (octal) {
      bytes.push(parseInt(octal[0], 8))
      i += octal[0].length
    } else {
      const next = body.charAt(++i)
      bytes.push(...encoder.encode(next === 'n' ? '\n' : next === 't' ? '\t' : next))
    }
  }

  return new TextDecoder().decode(Uint8Array.from(bytes))
}

// Reads `git diff -U0` output: per file, each changed region in the new file's lines.
export function parseDiff(text: string): ParsedDiff {
  const hunks: Record<string, Hunk[]> = {}
  let file: string | undefined
  let current: Hunk | undefined
  // The ---/+++ lines name the files only before the first hunk; after it they are a deleted "-- x" or an added "++ x".
  let inHeader = false
  let added = 0
  let removed = 0

  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      file = undefined
      current = undefined
      inHeader = true
    } else if (inHeader && line.startsWith('+++ ')) {
      const target = unquotePath(line.slice(4).trim().replace(/\t.*$/, ''))
      file = target === '/dev/null' ? undefined : target.replace(/^b\//, '')
      if (file) hunks[file] = hunks[file] ?? []
    } else if (inHeader && line.startsWith('--- ')) {
      // The old side; a deleted file keeps its old name.
      const source = unquotePath(line.slice(4).trim().replace(/\t.*$/, '')).replace(/^a\//, '')
      if (source !== '/dev/null') file = source
    } else if (line.startsWith('@@')) {
      inHeader = false
      const match = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line)
      if (!match || !file) continue
      const start = Number(match[2])
      const count = match[3] === undefined ? 1 : Number(match[3])
      current = { from: Math.max(1, start), to: Math.max(1, count === 0 ? start : start + count - 1), added: 0, removed: 0 }
      ;(hunks[file] = hunks[file] ?? []).push(current)
    } else if (current && line.startsWith('+')) {
      current.added += 1
      added += 1
    } else if (current && line.startsWith('-')) {
      current.removed += 1
      removed += 1
    }
  }

  return { hunks, added, removed }
}

export function hunkLabel(hunks: readonly Hunk[], max = 3): string {
  const ranges = hunks.map(one => (one.added === 0 ? `L${one.from} (del)` : one.from === one.to ? `L${one.from}` : `L${one.from}-${one.to}`))

  return ranges.length > max ? `${ranges.slice(0, max).join(', ')} +${ranges.length - max}` : ranges.join(', ')
}

// The most recent edit of any file, docs and generated files included: what a loop pass counts as work.
export function lastEdit(changed: Changed): number | undefined {
  const times = Object.values(changed.edits ?? {})

  return times.length === 0 ? undefined : Math.max(...times)
}

// The most recent edit that a check should have seen: docs and generated files do not count.
export function lastCheckedEdit(changed: Changed): number | undefined {
  const times = Object.entries(changed.edits ?? {})
    .filter(([path]) => affectsChecks(path))
    .map(([, at]) => at)

  return times.length === 0 ? undefined : Math.max(...times)
}

export type Coverage = {
  path: string
  hunks: Hunk[]
  editedAt?: number
  // The latest passing check that ran after this file's last edit, if any.
  provenBy?: EvidenceRecord
  // A check failed after the last edit and nothing has passed since.
  failedBy?: EvidenceRecord
  state: 'proven' | 'failing' | 'unproven' | 'untracked' | 'docs'
}

// Which changed regions have a check behind them: a check counts for a file when it ran after that file's last edit.
export function coverageOf(changed: Changed, evidence: readonly EvidenceRecord[]): Coverage[] {
  const paths = [...new Set([...changed.files, ...Object.keys(changed.hunks ?? {})])]

  return paths.map(path => {
    const hunks = changed.hunks?.[path] ?? []
    const editedAt = changed.edits?.[path]

    if (!affectsChecks(path)) {
      return { path, hunks, ...(editedAt !== undefined ? { editedAt } : {}), state: 'docs' as const }
    }
    if (editedAt === undefined) {
      return { path, hunks, state: 'untracked' as const }
    }

    const after = evidence.filter(one => one.at >= editedAt && one.ok !== null)
    const latest = after[after.length - 1]
    const provenBy = [...after].reverse().find(one => one.ok === true)
    const state = latest === undefined ? 'unproven' : latest.ok ? 'proven' : 'failing'

    return {
      path,
      hunks,
      editedAt,
      ...(provenBy ? { provenBy } : {}),
      ...(latest && !latest.ok ? { failedBy: latest } : {}),
      state,
    }
  })
}
