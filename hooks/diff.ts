import type { Changed, EvidenceRecord, Hunk } from '../types'
import { affectsChecks } from './files'

export type ParsedDiff = { hunks: Record<string, Hunk[]>; added: number; removed: number }

// Reads `git diff -U0` output: per file, each changed region in the new file's lines.
export function parseDiff(text: string): ParsedDiff {
  const hunks: Record<string, Hunk[]> = {}
  let file: string | undefined
  let current: Hunk | undefined
  let added = 0
  let removed = 0

  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      file = undefined
      current = undefined
    } else if (line.startsWith('+++ ')) {
      const target = line.slice(4).trim()
      file = target === '/dev/null' ? undefined : target.replace(/^b\//, '')
      if (file) hunks[file] = hunks[file] ?? []
    } else if (line.startsWith('--- ')) {
      // The old side; a deleted file keeps its old name.
      const source = line.slice(4).trim().replace(/^a\//, '')
      if (source !== '/dev/null') file = source
    } else if (line.startsWith('@@')) {
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
