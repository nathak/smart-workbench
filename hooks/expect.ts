import { ANSI, bodyOf, kindOfSegment, MAVEN_TOTAL, segmentsOf, TAIL_LINES } from './evidence'
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

export function testFactsOf(command: string, streams: readonly string[]): EvidenceRecord['facts'] | undefined {
  const segments = segmentsOf(command)
  const runs = segments.filter(one => kindOfSegment(one.text) === 'test')
  if (runs.length !== 1) return undefined
  // Only the check itself, set-up before it and a filter after it: another command's lines are not this run's.
  const at = segments.findIndex(one => kindOfSegment(one.text) === 'test')
  for (let i = 0; i < at; i += 1) if (!/^(?:|cd(?:\s+\S+)?|(?:export|unset|set)(?:\s+\S+)+)$/.test(bodyOf(segments[i]?.text ?? ''))) return undefined
  for (let i = at; i < segments.length - 1; i += 1) if (segments[i]?.op !== '|' || !/^(?:tail|head|e?grep|fgrep|tee)(?=\s|$)/.test(bodyOf(segments[i + 1]?.text ?? ''))) return undefined
  // cargo prints one total per crate, so only a whole stream adds up; behind a filter it would be a part.
  const isFiltered = segments.length - 1 > at

  let counts: Counts | undefined
  let line: string | undefined
  let nodePass: number | undefined
  let nodeFail: number | undefined
  let bunPass: number | undefined
  let bunFail: number | undefined
  let cargo: { passed: number; failed: number } | undefined
  for (const stream of streams) {
    const all = stream.replace(ANSI, '').split(/\r\n|\r|\n/).map(one => one.trim())
    if (!isFiltered) {
      for (const text of all) {
        const m = CARGO.exec(text)
        if (m) cargo = { passed: (cargo?.passed ?? 0) + Number(m[1]), failed: (cargo?.failed ?? 0) + Number(m[2]) }
      }
    }
    while (all.length > 0 && all[all.length - 1] === '') all.pop()
    for (const text of all.slice(-TAIL_LINES)) {
      const got = readLine(text)
      if (got) {
        counts = got
        line = text
      }
      const np = NODE_PASS.exec(text)
      if (np) nodePass = Number(np[1])
      const nf = NODE_FAIL.exec(text)
      if (nf) nodeFail = Number(nf[1])
      const bp = BUN_PASS.exec(text)
      if (bp) bunPass = Number(bp[1])
      const bf = BUN_FAIL.exec(text)
      if (bf) bunFail = Number(bf[1])
    }
  }
  if (cargo) {
    counts = cargo
    line = `test result: ${cargo.passed} passed; ${cargo.failed} failed`
  } else if (nodePass !== undefined || nodeFail !== undefined) {
    counts = { passed: nodePass, failed: nodeFail }
    line = `${nodePass ?? '?'} pass, ${nodeFail ?? '?'} fail`
  } else if (bunPass !== undefined || bunFail !== undefined) {
    counts = { passed: bunPass, failed: bunFail }
    line = `${bunPass ?? '?'} pass, ${bunFail ?? '?'} fail`
  }
  if (!counts || (counts.passed === undefined && counts.failed === undefined)) return undefined

  return { ...(counts.passed !== undefined ? { passed: counts.passed } : {}), ...(counts.failed !== undefined ? { failed: counts.failed } : {}), ...(counts.total !== undefined ? { total: counts.total } : {}), ...(line ? { line: redact(line).slice(0, 160) } : {}) }
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
