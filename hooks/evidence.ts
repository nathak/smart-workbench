import type { ConditionStatus, DoneCondition, EvidenceKind, EvidenceRecord, Task } from '../types'

// A check counts only when it is the command word of a segment (after env assignments, `time`, a launcher such as npx),
// so `pip install ruff`, `echo "npm test"` and `cat jest.config.js` prove nothing.
const PREFIX = /^(?:(?:time|exec|command|env|nice|timeout\s+\d+\w*)\s+|[A-Za-z_]\w*=(?:"[^"]*"|'[^']*'|\S*)\s+)*/
const LAUNCHER = String.raw`(?:(?:npx|bunx|pnpx|pnpm\s+(?:exec|dlx)|yarn(?:\s+exec)?|npm\s+exec|uv\s+run|poetry\s+run|pipenv\s+run)\s+(?:-\S+\s+)*|(?:\S*\/)?node_modules\/\.bin\/|\S*\.venv\/bin\/)?`
// npm-style script runners; -w pkg / --filter x / -C dir take a value, other flags do not.
const SCRIPT = (names: string) =>
  String.raw`(?:npm|pnpm|yarn|bun)\s+(?:(?:-w|--workspace|--filter|-F|-C|--prefix|--cwd|--dir)(?:=\S+|\s+[^\s-]\S*)\s+|--?\w[\w-]*\s+)*(?:run(?:-script)?\s+)?(?:${names})(?:[:-][\w:.-]*)?(?=\s|$)`
// Goals of a build tool come after any options: `mvn -q clean test`, `./gradlew :app:test`.
const GOAL = (tool: string, goals: string) => String.raw`(?:${tool})(?:\s+\S+)*?\s+(?:\S*:)?(?:${goals})(?=\s|$)`

const KINDS: readonly { kind: EvidenceKind; pattern: RegExp }[] = [
  {
    kind: 'typecheck',
    pattern: new RegExp(
      `^(?:${LAUNCHER}(?:tsc(?!\\s(?:\\S+\\s+)*?(?:--build|-b)(?=\\s|$))|vue-tsc|mypy|pyright)|${SCRIPT('typecheck|type-check|check-types|tsc')}|cargo(?:\\s+\\+\\S+)?\\s+check|python3?\\s+-m\\s+(?:mypy|pyright))(?=\\s|$)`,
    ),
  },
  {
    kind: 'lint',
    pattern: new RegExp(
      `^(?:${LAUNCHER}(?:eslint|biome\\s+(?:lint|check)|ruff|flake8|pylint|golangci-lint|stylelint)|cargo(?:\\s+\\+\\S+)?\\s+clippy|go\\s+vet|${SCRIPT('lint')}|python3?\\s+-m\\s+(?:ruff|flake8|pylint))(?=\\s|$)`,
    ),
  },
  {
    kind: 'test',
    pattern: new RegExp(
      `^(?:${LAUNCHER}(?:jest|vitest|mocha|pytest|phpunit|rspec|playwright\\s+test)|${SCRIPT('test')}|(?:npm|pnpm|yarn)\\s+t|python3?\\s+-m\\s+(?:pytest|unittest)|(?:go|deno|dotnet)\\s+test|cargo(?:\\s+\\+\\S+)?\\s+(?:test|t|nextest\\s+run)|claude\\s+plugin\\s+test|bun\\s+test|${GOAL('mvn|\\.?/?mvnw', 'test|verify')}|${GOAL('gradle|\\.?/?gradlew', 'test|check')}|make\\s+(?:(?:-C\\s+[^\\s-]\\S*|-\\S+)\\s+)*(?:test|tests|check))(?=\\s|$)`,
    ),
  },
  {
    kind: 'build',
    pattern: new RegExp(
      `^(?:${SCRIPT('build')}|(?:${LAUNCHER}(?:vite|next|webpack|esbuild|rollup))\\s+build|${LAUNCHER}tsc\\s+(?:\\S+\\s+)*?(?:--build|-b)|(?:go|dotnet)\\s+build|cargo(?:\\s+\\+\\S+)?\\s+(?:build|b)|${GOAL('mvn|\\.?/?mvnw', 'package|install|compile')}|${GOAL('gradle|\\.?/?gradlew', 'build|assemble')}|make\\s*$|make\\s+(?:(?:-C\\s+[^\\s-]\\S*|-\\S+)\\s+)*(?:build|all)|claude\\s+plugin\\s+validate)(?=\\s|$)`,
    ),
  },
]

// Quoted stretches, escaped characters and comments overwritten, so operators inside them split nothing.
function maskText(command: string): string {
  return command.replace(/\\[\s\S]|'[^']*'|"(?:[^"\\]|\\[\s\S])*"|(?<=^|[\s;&|()])#[^\n]*/g, one => 'x'.repeat(one.length))
}

// Flags that make a tool exit 0 without running its check (version, dry run, list only, format only, skipped tests).
const NO_CHECK = /(?:^|\s)(?:--version|--help|--init|--showConfig|--no-run|--collect-only|--co|--listTests|--dry-run|--just-print|-DskipTests|-Dmaven\.test\.skip(?:=true)?)(?=\s|=|$)|^ruff\s+format\b|^make\s+(?:\S+\s+)*-[a-zA-Z]*n\b/

type Segment = { text: string; op: string | undefined }

// Splits at ; & && | || |& and newlines, outside quotes. A lone & (background) is its own operator; 2>&1 and &> are not.
function segmentsOf(command: string): Segment[] {
  const masked = maskText(command)
  const result: Segment[] = []
  const operator = /\|\||&&|\|&|\||;|\n|(?<![<>&])&(?![>&])/g
  let from = 0

  for (let hit = operator.exec(masked); hit; hit = operator.exec(masked)) {
    result.push({ text: command.slice(from, hit.index), op: hit[0] === '|&' ? '|' : hit[0] })
    from = hit.index + hit[0].length
  }
  result.push({ text: command.slice(from), op: undefined })

  return result
}

function kindOfSegment(text: string): EvidenceKind | undefined {
  const body = text.trim().replace(/^[({]\s*/, '').replace(/[)}\s]+$/, '').replace(PREFIX, '')

  return NO_CHECK.test(body) ? undefined : KINDS.find(one => one.pattern.test(body))?.kind
}

export function evidenceKindsOf(command: string): EvidenceKind[] {
  const kinds = segmentsOf(command).map(one => kindOfSegment(one.text))

  return kinds.filter((kind, i): kind is EvidenceKind => kind !== undefined && kinds.indexOf(kind) === i)
}

export function evidenceKindOf(command: string): EvidenceKind | undefined {
  return evidenceKindsOf(command)[0]
}

// A guess for a new condition's link, from its words; the person can change it.
export function guessLink(text: string): EvidenceKind | undefined {
  const lower = text.toLowerCase()

  if (/\bci\b|pipeline|github actions|workflow|파이프라인|워크플로/.test(lower)) return 'ci'
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

// A pass that ran before the latest code edit no longer proves anything: it is only observed.
export function isStale(record: EvidenceRecord | undefined, lastEditAt: number | undefined): boolean {
  return record?.ok === true && lastEditAt !== undefined && record.at < lastEditAt
}

// Never derived from the model's words: only recorded results or the person's own mark.
export function statusOf(condition: DoneCondition, evidence: readonly EvidenceRecord[], lastEditAt?: number): ConditionStatus {
  if (condition.manual) {
    return condition.manual.status
  }

  if (!condition.link) {
    return 'pending'
  }

  const latest = latestOf(evidence, condition.link)

  if (!latest) return 'pending'
  if (latest.ok === null || isStale(latest, lastEditAt)) return 'observed'

  return latest.ok ? 'verified' : 'failed'
}

export type Completion = { met: number; total: number; isComplete: boolean }

export function completionOf(task: Task, evidence: readonly EvidenceRecord[], lastEditAt?: number): Completion {
  const statuses = task.doneConditions.map(one => statusOf(one, evidence, lastEditAt))
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

export function turnSummary(task: Task, evidence: readonly EvidenceRecord[], lastEditAt?: number): string {
  const { isComplete } = completionOf(task, evidence, lastEditAt)
  const lines = task.doneConditions.map(one => {
    const status = statusOf(one, evidence, lastEditAt)
    const latest = one.link ? latestOf(evidence, one.link) : undefined
    const stale = !one.manual && isStale(latest, lastEditAt) ? ' (code changed since; re-run)' : ''
    const detail = one.manual ? ` (manual: ${one.manual.note})` : latest ? ` · ${latest.command.slice(0, 50)}${stale}` : ''

    return `${markOf(status)} ${one.text}${detail}`
  })

  return [`WORKBENCH · ${isComplete ? 'COMPLETE' : 'INCOMPLETE'}`, ...lines].join('\n')
}


// What a finished run proves about its check. The shell reports the exit code of the last command only, so a pipe, `||`,
// `;` or a background `&` after the check hides its result (`npm test | tail` exits 0 when the tests fail). After `&&`
// only a success proves it. A check that may not have run (after `||`), a negated one (`! npm test`) and a failure that
// an earlier check in the same `&&` chain could have caused are unknown.
export function checkOutcome(command: string, kind: EvidenceKind, isOk: boolean): boolean | null {
  const segments = segmentsOf(command)
  const at = segments.findIndex(one => kindOfSegment(one.text) === kind)
  if (at < 0) return null
  // A check inside $( ), <( ) or backticks reports through another command's exit code.
  if (/\$\(|[<>]\(|`/.test(maskText(command))) return null
  // `!` negates a whole pipeline, so look back to its first segment.
  for (let i = at; i >= 0; i -= 1) {
    if (/^\s*!/.test(segments[i]?.text ?? '')) return null
    if (i > 0 && segments[i - 1]?.op !== '|') break
  }
  const hasPipefail = segments.slice(0, at).some(one => /^\s*set\s+(?:-[a-z]*o\s+pipefail|-o\s+pipefail)\b/.test(one.text))

  for (let i = at - 1; i >= 0; i -= 1) {
    const op = segments[i]?.op
    if (op !== '&&' && op !== '||') break
    if (op === '||') return null
    const earlier = kindOfSegment(segments[i]?.text ?? '')
    if (!isOk && earlier !== undefined && earlier !== kind) return null
  }

  const after = segments.slice(at).map(one => one.op).filter((op): op is string => op !== undefined).map(op => (op === '|' && hasPipefail ? '&&' : op))

  if (after.length === 0) return isOk
  if (after.every(op => op === '&&')) return isOk ? true : null

  return null
}
