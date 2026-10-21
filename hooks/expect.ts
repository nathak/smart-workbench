import { ANSI, bodyOf, EDIT_BEFORE, FILTER_AFTER, kindOfSegment, MAVEN_TOTAL, maskText, QUIET_BEFORE, segmentsOf, TAIL_LINES, withoutHeredocs } from './evidence'
import { redact } from './risk'
import type { DoneCondition, EvidenceRecord, Expectation } from '../types'

// The tool through which Claude sets what a done condition expects of its check.
export const EXPECT_TOOL = 'mcp__smartworkbench__set_condition_expectation'

export const EXPECT_DESCRIPTION =
  "Set what a done condition expects of its check, so the workbench judges it by the run's own numbers: for a condition linked to a test run, a minimum of tests passed (`min`), a limit of tests failed (`failed_max`, usually 0) and/or text the test command must contain (`cmd`, e.g. the package or filter). It can only make the verdict stricter: a condition is never verified by it, only failed or held for a re-run when the numbers fall short. Allowed on an unlocked contract, and on a locked one only for a condition that has a check link and no expectation yet; you cannot replace or remove one the person set, or any on a locked contract (use propose_contract_change). The finish is held once when an expectation is not met."

// Reads the summary line a test runner prints, as counts. Only the last lines are read (cargo's per-crate lines, all of the stream), only
// for one plain test run, and the last summary line wins. What is kept is the numbers and one masked, short line, never the output.
type Counts = { passed?: number; failed?: number; total?: number }

// "1 failed, 9 passed, 2 skipped" / "1 failed | 9 passed | 1 todo": the numbers by their words.
function words(text: string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const m of text.matchAll(/(\d+) (failed|passed|errors?|skipped|todo|deselected|xfailed|xpassed|warnings?)\b/g)) out[(m[2] ?? '').replace(/s$/, '')] = (out[(m[2] ?? '').replace(/s$/, '')] ?? 0) + Number(m[1])
  return out
}

function readLine(line: string): Counts | undefined {
  // jest: "Tests:       1 failed, 9 passed, 10 total"
  const jest = /^Tests:\s+(.*), (\d+) total$/.exec(line)
  if (jest) {
    const w = words(jest[1] ?? '')
    return { failed: w.failed ?? 0, passed: w.passed ?? 0, total: Number(jest[2]) }
  }
  // vitest (the label is right-aligned, so spaces come first): "Tests  1 failed | 9 passed | 1 todo (11)"
  const vitest = /^Tests\s+(.*) \((\d+)\)$/.exec(line)
  if (vitest) {
    const w = words(vitest[1] ?? '')
    return { failed: w.failed ?? 0, passed: w.passed ?? 0, total: Number(vitest[2]) }
  }
  // pytest, with or without the === border (-q): "2 failed, 7 passed, 1 skipped, 1 error in 0.52s"
  const pytest = /^(?:=+ )?((?:\d+ [a-z]+(?:, )?)+) in [\d.]+s(?: \([\d:]+\))?(?: =+)?$/.exec(line)
  if (pytest) {
    const w = words(pytest[1] ?? '')
    if (w.failed === undefined && w.passed === undefined && w.error === undefined) return undefined
    return { failed: (w.failed ?? 0) + (w.error ?? 0), passed: w.passed ?? 0 }
  }
  // Maven's total: "[INFO] Tests run: 12, Failures: 0, Errors: 0, Skipped: 1"
  const maven = MAVEN_TOTAL.exec(line)
  if (maven) return { failed: Number(maven[1]) + Number(maven[2]) }

  return undefined
}

const CARGO = /^test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed;/
// node:test (TAP "# pass 9" or the spec reporter's "ℹ pass 9"), and bun / `claude plugin test` (" 9 pass").
const NODE_PASS = /^(?:# |ℹ )pass (\d+)$/
const NODE_FAIL = /^(?:# |ℹ )fail (\d+)$/
const BUN_PASS = /^(\d+) pass$/
const BUN_FAIL = /^(\d+) fail$/

// What a test run's own output says: the counts, and (when the exit code cannot be trusted, because a pipe or `;` hides it)
// whether it passed. Read only for a command of this shape: an edit or set-up step before the run, the run itself (piped only
// into filters), and later checks that print no test summary. Anything else could put another command's lines in the output.
export type TestRead = { ok: boolean | null; facts?: EvidenceRecord['facts'] }

const NONE: TestRead = { ok: null }
// A later command that runs tests, or prints a summary line like one, would add lines that are not this run's.
const RUNNER = /^(?:npm|pnpm|yarn|bun|make|gradle|\.?\/?gradlew|mvn|\.?\/?mvnw)(?=\s|$)/
// Summaries that read as all passed while the run still fails.
const VETO = [/^Errors\s+\d+ errors?$/, /^\d+ errors?$/, /coverage threshold .* not met/i, /Required test coverage of .* not reached/i, /does not meet (?:global )?threshold/i, /^(?:# |ℹ )cancelled [1-9]\d*$/]
// jest and vitest print the suite (file) totals right before the test totals; a suite that failed to load leaves the test totals clean.
const SUITES = /^(?:Test Suites:\s+(.*), \d+ total|Test Files\s+(.*) \(\d+\))$/
// node:test and bun print pass and fail as two lines a few lines apart; a lone pass or fail line may be another command's.
const PAIR_GAP = 4

function shapeOf(text: string): { tests: number; isLast: boolean; canPass: boolean } | undefined {
  if (/\$\(|[<>]\(|`/.test(maskText(text))) return undefined
  const segments = segmentsOf(text)
  if (segments.some(one => one.op === '||' || one.op === '&')) return undefined
  let tests = 0
  let isLast = false
  // A git command runs hooks, which often run tests of their own: what they print is no proof of this run.
  let canPass = true

  for (let i = 0; i < segments.length; i += 1) {
    const head = segments[i]
    if (!head) continue
    const isHead = i === 0 || segments[i - 1]?.op !== '|'
    const body = bodyOf(head.text)
    if (/^\s*!/.test(head.text)) return undefined
    if (!isHead) {
      if (!FILTER_AFTER.test(body)) return undefined
      continue
    }
    const kind = kindOfSegment(head.text)
    if (kind === 'test') {
      tests += 1
      isLast = i === segments.length - 1
    } else if (body === '' || QUIET_BEFORE.test(body)) {
      continue
    } else if (EDIT_BEFORE.test(body) && tests === 0) {
      if (/^git\s/.test(body)) canPass = false
      continue
    } else if (tests > 0 && (kind === 'typecheck' || kind === 'lint' || (kind === 'build' && !RUNNER.test(body)))) {
      continue
    } else return undefined
  }

  return tests > 0 ? { tests, isLast, canPass } : undefined
}

export function readTestRun(command: string, streams: readonly string[]): TestRead {
  const text = withoutHeredocs(command)
  if (text === undefined) return NONE
  const shape = shapeOf(text)
  if (!shape) return NONE

  let counts: Counts | undefined
  let line: string | undefined
  let node: { pass?: [number, number, number]; fail?: [number, number, number] } = {}
  let bun: typeof node = {}
  let cargo: { passed: number; failed: number } | undefined
  let hasFailed = false
  let isVetoed = false
  let summaries = 0
  let isSuiteChecked = true
  for (const [at, stream] of streams.entries()) {
    const all = stream.replace(ANSI, '').split(/\r\n|\r|\n/).map(one => one.trim())
    // cargo prints one total per crate, so only a whole stream adds up; behind a filter or before another command it would be a part.
    if (shape.isLast && shape.tests === 1) {
      for (const one of all) {
        const m = CARGO.exec(one)
        if (m) cargo = { passed: (cargo?.passed ?? 0) + Number(m[1]), failed: (cargo?.failed ?? 0) + Number(m[2]) }
      }
    }
    while (all.length > 0 && all[all.length - 1] === '') all.pop()
    const tail = all.slice(-TAIL_LINES)
    for (const [row, one] of tail.entries()) {
      const suites = SUITES.exec(one)
      if (suites && (words(suites[1] ?? suites[2] ?? '').failed ?? 0) > 0) hasFailed = true
      const got = readLine(one)
      if (got) {
        counts = got
        line = one
        summaries += 1
        if ((got.failed ?? 0) > 0) hasFailed = true
        // jest and vitest: the line before is the suite totals (maven's and pytest's lines stand alone).
        if (/^Tests[: ]/.test(one)) isSuiteChecked = SUITES.test(tail[row - 1] ?? '')
      }
      const np = NODE_PASS.exec(one)
      if (np) node = { ...node, pass: [Number(np[1]), at, row] }
      const nf = NODE_FAIL.exec(one)
      if (nf) {
        node = { ...node, fail: [Number(nf[1]), at, row] }
        if (Number(nf[1]) > 0) hasFailed = true
      }
      const bp = BUN_PASS.exec(one)
      if (bp) bun = { ...bun, pass: [Number(bp[1]), at, row] }
      const bf = BUN_FAIL.exec(one)
      if (bf) {
        bun = { ...bun, fail: [Number(bf[1]), at, row] }
        if (Number(bf[1]) > 0) hasFailed = true
      }
      if (VETO.some(pattern => pattern.test(one))) isVetoed = true
    }
  }
  const isPaired = (pair: typeof node): boolean => pair.pass !== undefined && pair.fail !== undefined && pair.pass[1] === pair.fail[1] && pair.fail[2] > pair.pass[2] && pair.fail[2] - pair.pass[2] <= PAIR_GAP
  let isPairedRun = true
  if (cargo) {
    counts = cargo
    summaries = 1
    line = `test result: ${cargo.passed} passed; ${cargo.failed} failed`
    if (cargo.failed > 0) hasFailed = true
  } else if (node.pass !== undefined || node.fail !== undefined) {
    counts = { passed: node.pass?.[0], failed: node.fail?.[0] }
    line = `${node.pass?.[0] ?? '?'} pass, ${node.fail?.[0] ?? '?'} fail`
    isPairedRun = isPaired(node)
    summaries += 1
  } else if (bun.pass !== undefined || bun.fail !== undefined) {
    counts = { passed: bun.pass?.[0], failed: bun.fail?.[0] }
    line = `${bun.pass?.[0] ?? '?'} pass, ${bun.fail?.[0] ?? '?'} fail`
    isPairedRun = isPaired(bun)
    summaries += 1
  }
  // Two test runs in one command: no counts to keep (whose are they?), but a failure either printed is still a failure.
  if (shape.tests > 1) return { ok: hasFailed ? false : null }
  if (!counts || (counts.passed === undefined && counts.failed === undefined)) return NONE

  const facts = { ...(counts.passed !== undefined ? { passed: counts.passed } : {}), ...(counts.failed !== undefined ? { failed: counts.failed } : {}), ...(counts.total !== undefined ? { total: counts.total } : {}), ...(line ? { line: redact(line).slice(0, 160) } : {}) }
  // A pass needs both numbers, from one summary, with the failures at zero; a failure needs only itself.
  // More than one summary in the output (a recursive run over packages, a hook) says nothing about the whole run.
  const isPass = shape.canPass && summaries === 1 && isSuiteChecked && !hasFailed && !isVetoed && isPairedRun && (counts.passed ?? 0) > 0 && counts.failed === 0

  return { ok: hasFailed ? false : isPass ? true : null, facts }
}

export function testFactsOf(command: string, streams: readonly string[]): EvidenceRecord['facts'] | undefined {
  return readTestRun(command, streams).facts
}

const MAX_COUNT = 100000
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_COUNT

export type ExpectInput = { cmd?: string; tests?: { min?: number; failedMax?: number }; reason: string }

// The input of Claude's tool, checked and given its shape; the reason is text and may not be empty.
export function checkExpectInput(raw: Record<string, unknown>): { ok: true; value: ExpectInput } | { ok: false; reason: string } {
  const cmd = raw.cmd === undefined ? undefined : typeof raw.cmd === 'string' ? raw.cmd.trim() : null
  if (cmd === null || (cmd !== undefined && (cmd.length < 1 || cmd.length > 80 || /[\r\n\0]/.test(cmd)))) return { ok: false, reason: 'cmd must be one line of 1 to 80 characters' }
  if (raw.min !== undefined && !isCount(raw.min)) return { ok: false, reason: `min must be a whole number from 0 to ${MAX_COUNT}` }
  if (raw.failed_max !== undefined && !isCount(raw.failed_max)) return { ok: false, reason: `failed_max must be a whole number from 0 to ${MAX_COUNT}` }
  if (cmd === undefined && raw.min === undefined && raw.failed_max === undefined) return { ok: false, reason: 'give at least one of min, failed_max and cmd' }
  const reason = typeof raw.reason === 'string' ? redact(raw.reason).replace(/\s+/g, ' ').trim().slice(0, 200) : ''
  if (reason === '') return { ok: false, reason: 'give a reason in one sentence' }
  const tests = raw.min !== undefined || raw.failed_max !== undefined ? { ...(raw.min !== undefined ? { min: raw.min as number } : {}), ...(raw.failed_max !== undefined ? { failedMax: raw.failed_max as number } : {}) } : undefined

  return { ok: true, value: { ...(cmd !== undefined ? { cmd } : {}), ...(tests ? { tests } : {}), reason } }
}

// Whether Claude may set an expectation on this condition now. The person's own is never touched; a locked contract only takes a first one
// on a condition with a check link (a test count only on a test link); an expectation never loosens what the person decided.
export function canSet(isLocked: boolean, condition: DoneCondition | undefined, input: ExpectInput): { ok: true } | { ok: false; reason: string } {
  if (!condition) return { ok: false, reason: 'no such done condition' }
  if (condition.manual) return { ok: false, reason: 'the person has marked this condition themselves' }
  if (!condition.link) return { ok: false, reason: 'the condition has no check link, so there is nothing to judge a run by' }
  if (input.tests && condition.link !== 'test') return { ok: false, reason: 'test counts apply only to a condition linked to a test run' }
  if (condition.expect?.setBy === 'user') return { ok: false, reason: 'the person set this expectation; ask for a change with propose_contract_change' }
  if (isLocked && condition.expect) return { ok: false, reason: 'the contract is locked; an expectation already set can be changed only by the person' }

  return { ok: true }
}

export function expectOf(input: ExpectInput, at: number): Expectation {
  return { ...(input.cmd ? { cmd: input.cmd } : {}), ...(input.tests ? { tests: input.tests } : {}), setBy: 'claude', at, reason: input.reason }
}
