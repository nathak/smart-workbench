import type { ConditionStatus, DoneCondition, EvidenceKind, EvidenceRecord, Expectation, Task } from '../types'

// A check counts only when it is the command word of a segment (after env assignments, `time`, a launcher such as npx),
// so `pip install ruff`, `echo "npm test"` and `cat jest.config.js` prove nothing.
const PREFIX = /^(?:(?:time|exec|command|env|nice|timeout\s+\d+\w*)\s+|[A-Za-z_]\w*=(?:"[^"]*"|'[^']*'|\S*)\s+)*/
const LAUNCHER = String.raw`(?:(?:npx|bunx|pnpx|pnpm\s+(?:exec|dlx)|yarn(?:\s+exec)?|npm\s+exec|uv\s+run|poetry\s+run|pipenv\s+run)\s+(?:-\S+\s+)*|(?:\S*\/)?node_modules\/\.bin\/|\S*\.venv\/bin\/)?`
// npm-style script runners; -w pkg / --filter x / -C dir take a value, other flags do not.
const SCRIPT = (names: string) =>
  String.raw`(?:npm|pnpm|yarn|bun)\s+(?:(?:-w|--workspace|--filter|-F|-C|--prefix|--cwd|--dir)(?:=\S+|\s+[^\s-]\S*)\s+|--?\w[\w-]*\s+)*(?:run(?:-script)?\s+)?(?:${names})(?:[:-][\w:.-]*)?(?=\s|$)`
// Goals of a build tool come after any options: `mvn -q clean test`, `./gradlew :app:test`.
const GRADLE = String.raw`gradle|\.?/?gradlew`
const MAVEN = String.raw`mvn|\.?/?mvnw`
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
      `^(?:${LAUNCHER}(?:jest|vitest|mocha|pytest|phpunit|rspec|playwright\\s+test)|${SCRIPT('test')}|(?:npm|pnpm|yarn)\\s+t|python3?\\s+-m\\s+(?:pytest|unittest)|(?:go|deno|dotnet)\\s+test|cargo(?:\\s+\\+\\S+)?\\s+(?:test|t|nextest\\s+run)|claude\\s+plugin\\s+test|bun\\s+test|${GOAL(MAVEN, 'test|verify')}|${GOAL(GRADLE, 'test|check')}|make\\s+(?:(?:-C\\s+[^\\s-]\\S*|-\\S+)\\s+)*(?:test|tests|check))(?=\\s|$)`,
    ),
  },
  {
    kind: 'build',
    pattern: new RegExp(
      `^(?:${SCRIPT('build')}|(?:${LAUNCHER}(?:vite|next|webpack|esbuild|rollup))\\s+build|${LAUNCHER}tsc\\s+(?:\\S+\\s+)*?(?:--build|-b)|(?:go|dotnet)\\s+build|cargo(?:\\s+\\+\\S+)?\\s+(?:build|b)|${GOAL(MAVEN, 'package|install|compile')}|${GOAL(GRADLE, 'build|assemble')}|make\\s*$|make\\s+(?:(?:-C\\s+[^\\s-]\\S*|-\\S+)\\s+)*(?:build|all)|claude\\s+plugin\\s+validate)(?=\\s|$)`,
    ),
  },
]

// Quoted stretches, escaped characters and comments overwritten, so operators inside them split nothing.
function maskText(command: string): string {
  return command.replace(/\\[\s\S]|'[^']*'|"(?:[^"\\]|\\[\s\S])*"|(?<=^|[\s;&|()])#[^\n]*/g, one => 'x'.repeat(one.length))
}

// Flags that make a tool exit 0 without running its check (version, dry run, list only, format only, skipped tests).
const NO_CHECK = /(?:^|\s)(?:--version|--help|--init|--showConfig|--no-run|--collect-only|--co|--listTests|--dry-run|--just-print|-DskipTests|-Dmaven\.test\.skip(?:=true)?|--passWithNoTests|-list)(?=\s|=|$)|(?:^|\s)ruff\s+format\b|^make\s+(?:\S+\s+)*-[a-zA-Z]*n\b/

export type Segment = { text: string; op: string | undefined }

// Splits at ; & && | || |& and newlines, outside quotes. A lone & (background) is its own operator; 2>&1 and &> are not.
export function segmentsOf(command: string): Segment[] {
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

// A segment's command, without grouping, env assignments and launchers.
export function bodyOf(text: string): string {
  return text.trim().replace(/^[({]\s*/, '').replace(/[)}\s]+$/, '').replace(PREFIX, '')
}

export function kindOfSegment(text: string): EvidenceKind | undefined {
  const body = bodyOf(text)

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
  return judgeOf(condition, evidence, lastEditAt).status
}

export type Judged = { status: ConditionStatus; expected?: string; got?: string }

export function expectText(expect: Expectation): string {
  const parts: string[] = []
  if (expect.tests?.min !== undefined) parts.push(`≥${expect.tests.min} passed`)
  if (expect.tests?.failedMax !== undefined) parts.push(`≤${expect.tests.failedMax} failed`)
  if (expect.cmd) parts.push(`command has "${expect.cmd}"`)

  return parts.join(', ')
}

// The verdict with what was expected and what the run showed. An expectation can only lower a verified verdict (to failed or observed);
// it never raises one, and a person's mark or a condition without a check link is left as it is. The counts are read from the run's own
// summary line (see hooks/expect.ts); a command can print such a line, so this is no defence against a command that means to.
export function judgeOf(condition: DoneCondition, evidence: readonly EvidenceRecord[], lastEditAt?: number): Judged {
  const status = baseStatusOf(condition, evidence, lastEditAt)
  const expect = condition.expect
  if (!expect || condition.manual || !condition.link) return { status }
  const expected = expectText(expect)
  if (expected === '') return { status }
  const latest = latestOf(evidence, condition.link)
  if (!latest || (status !== 'verified' && status !== 'observed')) return { status, expected }
  const facts = latest.facts
  // A stored expectation is not trusted to be well formed: a value that is not a whole number counts for nothing.
  const count = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)
  const tests = expect.tests && { min: count(expect.tests.min), failedMax: count(expect.tests.failedMax) }
  // A failure count past the limit fails the condition even when a pipe hid the exit code (a lowering is always safe).
  if (tests?.failedMax !== undefined && facts?.failed !== undefined && facts.failed > tests.failedMax) return { status: 'failed', expected, got: `${facts.failed} failed` }
  if (status !== 'verified') return { status, expected }
  if (tests?.min !== undefined) {
    if (facts?.passed === undefined) return { status: 'observed', expected, got: 'no test count in the output (run it unfiltered)' }
    if (facts.passed < tests.min) return { status: 'failed', expected, got: `${facts.passed} passed` }
  }
  if (tests?.failedMax !== undefined && facts?.failed === undefined) return { status: 'observed', expected, got: 'no test count in the output (run it unfiltered)' }
  // The stored command is cut at 200 characters: a longer one cannot be judged by its text.
  if (typeof expect.cmd === 'string' && expect.cmd !== '' && latest.command.length < 200 && !latest.command.includes(expect.cmd)) return { status: 'observed', expected, got: `latest run: ${latest.command.slice(0, 60)}` }
  const got = [facts?.passed !== undefined ? `${facts.passed} passed` : '', facts?.failed !== undefined ? `${facts.failed} failed` : ''].filter(Boolean).join(', ')

  return { status, expected, ...(got ? { got } : {}) }
}

function baseStatusOf(condition: DoneCondition, evidence: readonly EvidenceRecord[], lastEditAt?: number): ConditionStatus {
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

// What a Gradle or Maven run's own output says when the exit code cannot (`./gradlew test 2>&1 | tail -30` exits with tail's code).
// Read only for a run of one build tool, after quiet set-up commands and piped only into filters, and only as the tool's own final
// line (not text the command or the model wrote): a failure line wins, a success line counts only when the call did not end in error.
// A quiet run, a marker cut off by `tail` and anything odd stay unknown. A barrier against accidents: a command can print the line.
export const TAIL_LINES = 40
const QUIET_BEFORE = /^(?:|cd(?:\s+\S+)?|(?:export|unset|set)(?:\s+\S+)+)$/
const FILTER_AFTER = /^(?:tail|head|e?grep|fgrep|tee)(?=\s|$)/
const GRADLE_MARK = /^BUILD (SUCCESSFUL|FAILED)(?: in \d+(?:\.\d+)?(?:ms|s|m|h)(?: \d+(?:\.\d+)?(?:ms|s|m|h))*)?$/
const MAVEN_MARK = /^\[INFO\] BUILD (SUCCESS|FAILURE)$/
export const MAVEN_TOTAL = /^\[(?:INFO|WARNING|ERROR)\] Tests run: \d+, Failures: (\d+), Errors: (\d+), Skipped: \d+(?:, Flakes: \d+)?$/
export const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g

export function outcomeFromOutput(command: string, kind: EvidenceKind, streams: readonly string[], isOk: boolean): boolean | null {
  const segments = segmentsOf(command)
  const at = segments.findIndex(one => kindOfSegment(one.text) === kind)
  if (at < 0) return null
  const body = bodyOf(segments[at]?.text ?? '')
  const tool = new RegExp(`^(?:${GRADLE})(?=\\s|$)`).test(body) ? 'gradle' : new RegExp(`^(?:${MAVEN})(?=\\s|$)`).test(body) ? 'maven' : undefined
  if (tool === undefined) return null
  if (/\$\(|[<>]\(|`/.test(maskText(command))) return null
  // One build run only: an earlier or later one leaves markers of its own.
  const runs = segments.filter(one => new RegExp(`^(?:${GRADLE}|${MAVEN})(?=\\s|$)`).test(bodyOf(one.text))).length
  if (runs !== 1) return null
  for (let i = 0; i < at; i += 1) {
    const op = segments[i]?.op
    if ((op !== '&&' && op !== ';') || !QUIET_BEFORE.test(bodyOf(segments[i]?.text ?? ''))) return null
  }
  if (/^\s*!/.test(segments[at]?.text ?? '')) return null
  for (let i = at; i < segments.length - 1; i += 1) {
    if (segments[i]?.op !== '|' || !FILTER_AFTER.test(bodyOf(segments[i + 1]?.text ?? ''))) return null
  }
  // -m skips the tasks and still prints BUILD SUCCESSFUL; Maven's ignore flags make a success line mean less.
  if (tool === 'gradle' && /(?:^|\s)(?:-m|--dry-run)(?=\s|$)/.test(body)) return null
  const trustSuccess = !(tool === 'maven' && /(?:^|\s)(?:-fn|--fail-never)(?=\s|$)|-Dmaven\.test\.(?:failure|error)\.ignore(?:=true)?(?=\s|$)/.test(body))

  let success = false
  let failure = false
  for (const stream of streams) {
    const lines = stream.replace(ANSI, '').split(/\r\n|\r|\n/).map(line => line.trimEnd())
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
    for (const line of lines.slice(-TAIL_LINES)) {
      const mark = (tool === 'gradle' ? GRADLE_MARK : MAVEN_MARK).exec(line)
      if (mark) {
        if (mark[1] === 'SUCCESSFUL' || mark[1] === 'SUCCESS') success = true
        else failure = true
      }
      const total = tool === 'maven' ? MAVEN_TOTAL.exec(line) : null
      if (total && Number(total[1]) + Number(total[2]) > 0) failure = true
    }
  }
  if (failure) return false
  if (success && trustSuccess && isOk) return true

  return null
}
