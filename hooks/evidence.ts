import type { ConditionStatus, DoneCondition, EvidenceKind, EvidenceRecord, Task } from '../types'

const KINDS: readonly { kind: EvidenceKind; pattern: RegExp }[] = [
  {
    kind: 'typecheck',
    pattern: /\btsc\b(?![^;&|]*--build)|\bvue-tsc\b|\bmypy\b|\bpyright\b|\b(npm|pnpm|yarn|bun)\s+(run\s+)?(typecheck|type-check|check-types|tsc)\b|\bcargo\s+check\b/,
  },
  {
    kind: 'lint',
    pattern: /\beslint\b|\bbiome\s+(lint|check)\b|\bruff\b|\bflake8\b|\bpylint\b|\bgolangci-lint\b|\bcargo\s+clippy\b|\b(npm|pnpm|yarn|bun)\s+(run\s+)?lint\b/,
  },
  {
    kind: 'test',
    pattern: /\b(npm|pnpm|yarn|bun)\s+(run\s+)?test\b|\b(npm|pnpm|yarn)\s+t\b|\bnpx\s+(jest|vitest|mocha|playwright\s+test)\b|\b(jest|vitest|mocha|pytest|phpunit|rspec)\b|\bpython3?\s+-m\s+(pytest|unittest)\b|\b(go|cargo|deno|dotnet|mvn|gradle|\.\/gradlew)\s+test\b|\bclaude\s+plugin\s+test\b|\bmake\s+(test|check)\b/,
  },
  {
    kind: 'build',
    pattern: /\b(npm|pnpm|yarn|bun)\s+(run\s+)?build\b|\b(vite|next|webpack|esbuild|rollup)\s+build\b|\btsc\s+[^;&|]*--build\b|\b(go|cargo|dotnet|gradle|\.\/gradlew)\s+build\b|\bmvn\s+(package|install)\b|^\s*make\s*$|\bclaude\s+plugin\s+validate\b/,
  },
]

export function evidenceKindOf(command: string): EvidenceKind | undefined {
  return KINDS.find(one => one.pattern.test(command))?.kind
}

// A guess for a new condition's link, from its words; the person can change it.
export function guessLink(text: string): EvidenceKind | undefined {
  const lower = text.toLowerCase()

  if (/type\s*-?check|typecheck|타입/.test(lower)) return 'typecheck'
  if (/lint|린트/.test(lower)) return 'lint'
  if (/build|빌드|compile|컴파일/.test(lower)) return 'build'
  if (/test|테스트/.test(lower)) return 'test'

  return undefined
}

export function latestOf(evidence: readonly EvidenceRecord[], kind: EvidenceKind): EvidenceRecord | undefined {
  for (let i = evidence.length - 1; i >= 0; i -= 1) {
    const one = evidence[i]
    if (one?.kind === kind) return one
  }

  return undefined
}

// Never derived from the model's words: only recorded results or the person's own mark.
export function statusOf(condition: DoneCondition, evidence: readonly EvidenceRecord[]): ConditionStatus {
  if (condition.manual) {
    return condition.manual.status
  }

  if (!condition.link) {
    return 'pending'
  }

  const latest = latestOf(evidence, condition.link)

  if (!latest) return 'pending'
  if (latest.ok === null) return 'observed'

  return latest.ok ? 'verified' : 'failed'
}

export type Completion = { met: number; total: number; isComplete: boolean }

export function completionOf(task: Task, evidence: readonly EvidenceRecord[]): Completion {
  const statuses = task.doneConditions.map(one => statusOf(one, evidence))
  const total = statuses.length
  const met = statuses.filter(one => one === 'verified' || one === 'waived').length

  return { met, total, isComplete: total > 0 && met === total }
}

const MARK: Record<ConditionStatus, string> = {
  pending: '○',
  observed: '◐',
  verified: '✓',
  failed: '✕',
  waived: '–',
}

export function markOf(status: ConditionStatus): string {
  return MARK[status]
}

export function turnSummary(task: Task, evidence: readonly EvidenceRecord[]): string {
  const { isComplete } = completionOf(task, evidence)
  const lines = task.doneConditions.map(one => {
    const status = statusOf(one, evidence)
    const latest = one.link ? latestOf(evidence, one.link) : undefined
    const detail = one.manual ? ` (manual: ${one.manual.note})` : latest ? ` · ${latest.command.slice(0, 50)}` : ''

    return `${markOf(status)} ${one.text}${detail}`
  })

  return [`WORKBENCH · ${isComplete ? 'COMPLETE' : 'INCOMPLETE'}`, ...lines].join('\n')
}
