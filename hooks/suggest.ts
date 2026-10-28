// Done conditions offered to the person, never added by themselves: from the checks the project root shows and from the wording of
// the goal. Pure, so a test can feed it files. Every command offered is one the evidence collector reads as that kind of check, so
// running it puts a result on the condition it was offered for.
import { redact } from './risk'
import type { ConditionSuggestion, DoneCondition, EvidenceKind, ProjectCheck, Task } from '../types'

// The root files read for their text; the rest of a root only matters by name.
export const ROOT_READS = ['package.json', 'pyproject.toml', 'setup.cfg', 'tox.ini', 'Makefile', 'makefile', 'GNUmakefile'] as const

export type RootFiles = { names: readonly string[]; texts: Readonly<Partial<Record<string, string>>> }

const KIND_LABEL: Record<EvidenceKind, string> = { test: 'Tests pass', typecheck: 'Typecheck passes', lint: 'Lint passes', build: 'Build passes', ci: 'CI is green' }

function runnerOf(root: RootFiles, manifest: Record<string, unknown>): 'npm' | 'pnpm' | 'yarn' | 'bun' {
  const declared = typeof manifest.packageManager === 'string' ? manifest.packageManager.split('@')[0] : ''
  if (declared === 'pnpm' || declared === 'yarn' || declared === 'bun' || declared === 'npm') return declared
  if (root.names.includes('pnpm-lock.yaml')) return 'pnpm'
  if (root.names.includes('yarn.lock')) return 'yarn'
  if (root.names.includes('bun.lock') || root.names.includes('bun.lockb')) return 'bun'

  return 'npm'
}

function nodeChecks(root: RootFiles): ProjectCheck[] {
  const text = root.texts['package.json']
  if (text === undefined) return []
  let manifest: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return []
    manifest = parsed as Record<string, unknown>
  } catch {
    return []
  }
  const scripts = typeof manifest.scripts === 'object' && manifest.scripts !== null ? (manifest.scripts as Record<string, unknown>) : {}
  const runner = runnerOf(root, manifest)
  // bun's own `bun test` is a different runner, so a script is always run as `bun run`.
  const run = (key: string) => (key === 'test' ? (runner === 'bun' ? 'bun run test' : `${runner} test`) : `${runner} run ${key}`)
  const out: ProjectCheck[] = []
  const test = scripts.test
  if (typeof test === 'string' && !/no test specified/.test(test)) out.push({ kind: 'test', command: run('test'), from: 'package.json' })
  const typeKey = ['typecheck', 'type-check', 'check-types', 'tsc'].find(key => typeof scripts[key] === 'string')
  if (typeKey) out.push({ kind: 'typecheck', command: run(typeKey), from: 'package.json' })
  else if (root.names.includes('tsconfig.json')) out.push({ kind: 'typecheck', command: 'npx tsc --noEmit', from: 'tsconfig.json' })
  if (typeof scripts.lint === 'string') out.push({ kind: 'lint', command: run('lint'), from: 'package.json' })
  if (typeof scripts.build === 'string') out.push({ kind: 'build', command: run('build'), from: 'package.json' })

  return out
}

function pythonChecks(root: RootFiles): ProjectCheck[] {
  const has = (name: string, marker: RegExp) => marker.test(root.texts[name] ?? '')
  const out: ProjectCheck[] = []
  if (root.names.includes('pytest.ini') || has('pyproject.toml', /\[tool\.pytest/) || has('setup.cfg', /\[tool:pytest\]/) || has('tox.ini', /\[pytest\]/)) {
    out.push({ kind: 'test', command: 'pytest', from: root.names.includes('pytest.ini') ? 'pytest.ini' : 'pyproject.toml' })
  }
  if (root.names.includes('mypy.ini') || has('pyproject.toml', /\[tool\.mypy\]/)) out.push({ kind: 'typecheck', command: 'mypy .', from: root.names.includes('mypy.ini') ? 'mypy.ini' : 'pyproject.toml' })
  if (root.names.includes('ruff.toml') || root.names.includes('.ruff.toml') || has('pyproject.toml', /\[tool\.ruff/)) {
    out.push({ kind: 'lint', command: 'ruff check .', from: root.names.includes('pyproject.toml') ? 'pyproject.toml' : 'ruff.toml' })
  }

  return out
}

function nativeChecks(root: RootFiles): ProjectCheck[] {
  const out: ProjectCheck[] = []
  if (root.names.includes('Cargo.toml')) out.push({ kind: 'test', command: 'cargo test', from: 'Cargo.toml' }, { kind: 'build', command: 'cargo build', from: 'Cargo.toml' })
  if (root.names.includes('go.mod')) out.push({ kind: 'test', command: 'go test ./...', from: 'go.mod' }, { kind: 'build', command: 'go build ./...', from: 'go.mod' })
  // A Windows `gradlew.bat test` is not read as a check, so the shell form is always the one offered.
  if (root.names.includes('gradlew')) out.push({ kind: 'test', command: './gradlew test', from: 'gradlew' }, { kind: 'build', command: './gradlew build', from: 'gradlew' })
  else if (root.names.includes('build.gradle') || root.names.includes('build.gradle.kts')) {
    const from = root.names.includes('build.gradle') ? 'build.gradle' : 'build.gradle.kts'
    out.push({ kind: 'test', command: 'gradle test', from }, { kind: 'build', command: 'gradle build', from })
  }
  if (root.names.includes('pom.xml')) out.push({ kind: 'test', command: root.names.includes('mvnw') ? './mvnw test' : 'mvn test', from: 'pom.xml' })

  return out
}

function makeChecks(root: RootFiles): ProjectCheck[] {
  // The file make itself runs when several exist: GNUmakefile, then makefile, then Makefile.
  const name = ['GNUmakefile', 'makefile', 'Makefile'].find(one => root.texts[one] !== undefined)
  if (!name) return []
  const text = root.texts[name] ?? ''
  const out: ProjectCheck[] = []
  const test = /^(test|tests|check)[ \t]*:(?!=)/m.exec(text)?.[1]
  const build = /^(build|all)[ \t]*:(?!=)/m.exec(text)?.[1]
  if (test) out.push({ kind: 'test', command: `make ${test}`, from: name })
  if (build) out.push({ kind: 'build', command: `make ${build}`, from: name })

  return out
}

function pluginChecks(root: RootFiles): ProjectCheck[] {
  if (!root.names.includes('.claude-plugin/plugin.json')) return []

  return [
    ...(root.names.includes('tests') ? [{ kind: 'test' as const, command: 'claude plugin test .', from: '.claude-plugin/plugin.json' }] : []),
    { kind: 'build', command: 'claude plugin validate .', from: '.claude-plugin/plugin.json' },
  ]
}

// One check per kind; the first rule that finds one wins.
export function projectChecks(root: RootFiles): ProjectCheck[] {
  const out: ProjectCheck[] = []
  for (const one of [...nodeChecks(root), ...pythonChecks(root), ...nativeChecks(root), ...makeChecks(root), ...pluginChecks(root)]) {
    if (!out.some(have => have.kind === one.kind)) out.push(one)
  }

  return out
}

const REVIEW = /리뷰|검토|\breview|\baudit/i
// A count is a request to repeat only with a verb of repeating beside it, and not an issue or PR number ("이슈 123번") or an ordinal ("3번째").
const COUNT = /(?<![#\d]|이슈\s?|PR\s?|issue\s?|pr\s?)(\d{1,6})\s*(번|회|times?\b|iterations?\b|rounds?\b|runs?\b)(?!\s*째)/i
const REPEAT = /반복|돌려|돌리|돌았|돌아|실행|수행|\bruns?\b|\bloop|repeat|iterat|\brounds?\b/i

// Conditions no command can verify, from what the goal asks for. They carry no link: the person marks them with Verify.
export function wordingSuggestions(goal: string): ConditionSuggestion[] {
  const korean = /[가-힣]/.test(goal)
  const out: ConditionSuggestion[] = []
  if (REVIEW.test(goal)) {
    out.push({ key: 'review', text: korean ? '리뷰: 위험한 부분을 file:line과 함께 나열하고 각각 수정 또는 수용으로 표시' : 'Review: risky spots listed with file:line, each fixed or accepted' })
  }
  const count = REPEAT.test(goal) ? COUNT.exec(goal) : null
  const n = count ? Number(count[1]) : 0
  if (count && n >= 2) {
    out.push({ key: `count:${n}`, text: korean ? `${n}번 실행됨: 실행 결과에서 횟수 확인` : `Ran ${n} times: count confirmed from the run's output` })
  }

  return out
}

function plain(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ')
}

// Offered only while the contract can still be edited, and never what it already says.
export function suggestConditions(task: Task, checks: readonly ProjectCheck[], hidden: readonly string[] = []): ConditionSuggestion[] {
  if (task.locked) return []
  const have = task.doneConditions
  const taken = new Set(have.map(one => plain(one.text)))
  const wording = wordingSuggestions(task.goal).filter(one => {
    if (one.key === 'review') return !have.some(item => REVIEW.test(item.text))
    const n = one.key.slice('count:'.length)

    return !have.some(item => new RegExp(`${n}\\s*(?:번|회|times?\\b|iterations?\\b|rounds?\\b|runs?\\b)`, 'i').test(item.text))
  })
  const kinds: ConditionSuggestion[] = checks.map(one => ({ key: `check:${one.kind}`, text: `${KIND_LABEL[one.kind]}: ${one.command}`, link: one.kind, command: one.command }))

  return [...wording, ...kinds.filter(one => !have.some(item => item.link === one.link))].filter(one => !hidden.includes(one.key) && !taken.has(plain(one.text)))
}

// A condition nothing can verify but the person: no linked check and no manual mark yet.
export function isUnlinked(one: DoneCondition): boolean {
  return !one.link && !one.manual
}

// ---- conditions Claude sets for the task at hand
//
// The offered list above is made of what the project root shows, so it cannot know what THIS request needs (a design document has no
// test run). Claude knows the request; the workbench knows which checks exist and when it is asked. So Claude sets the conditions, through
// a tool, and the tool checks them against the project as it is at that moment.

export const AUTO_TOOL = 'mcp__smartworkbench__set_done_conditions'
export const CHECK_KINDS: readonly EvidenceKind[] = ['test', 'typecheck', 'lint', 'build', 'ci']
export const MAX_AUTO = 4
// How many prompts of one task are given the reminder before it is left alone.
export const NUDGE_LIMIT = 3

export const AUTO_DESCRIPTION =
  "Set the done conditions of this task: a one-line goal and 1 to 4 conditions that would prove THIS request is done. Link a condition to a check kind (`test`, `typecheck`, `lint`, `build`, `ci`) only when running that check proves it and the project has it (the call is refused otherwise, naming the checks found); a condition no command proves (a document's content, a count, a review) gets no link and the person verifies it. Allowed only while the contract is unlocked and has no done condition; afterwards use propose_contract_change. The contract stays unlocked, so the person can edit, undo or lock it. Do not call it for questions, explanations or chat."

export function nudgeText(checks: readonly ProjectCheck[], hasCi: boolean): string {
  const found = [...checks.map(one => `${one.kind} (${one.command})`), ...(hasCi && !checks.some(one => one.kind === 'ci') ? ['ci (GitHub Actions)'] : [])]
  const have = found.length > 0 ? `checks this project has: {${found.join(', ')}}.` : 'this project has no check the workbench detects, so give no link.'

  return [
    '<smartworkbench_done_conditions>',
    `  This task's contract has no done conditions. If this request asks you to change files, call ${AUTO_TOOL} once, before your first edit: a one-line goal and 1-4 conditions that would prove THIS request is done. Link a condition only when running that check proves it; ${have} A condition no command proves (a document's content, a count, a review) gets no link; the person verifies it. Do not call it for questions, explanations or chat.`,
    '</smartworkbench_done_conditions>',
  ].join('\n')
}

export type AutoInput = { goal: string; conditions: { text: string; link?: EvidenceKind }[] }

function oneLine(value: unknown): string {
  return typeof value === 'string' ? redact(value).replace(/\s+/g, ' ').trim() : ''
}

// `kinds` are the check kinds the project has right now. A link to another kind refuses the whole call, naming what exists, so the
// condition is never left saying "tests pass" with nothing that could prove it.
export function checkAutoInput(raw: Record<string, unknown>, kinds: readonly EvidenceKind[], checks: readonly ProjectCheck[] = []): { ok: true; value: AutoInput } | { ok: false; reason: string } {
  const goal = oneLine(raw.goal)
  if (goal.length < 1 || goal.length > 200) return { ok: false, reason: 'goal must be one line of 1 to 200 characters' }
  const list = raw.conditions
  if (!Array.isArray(list) || list.length < 1 || list.length > MAX_AUTO) return { ok: false, reason: `give 1 to ${MAX_AUTO} conditions` }
  const seen = new Set<string>()
  const conditions: AutoInput['conditions'] = []
  for (const item of list) {
    const entry = typeof item === 'object' && item !== null ? (item as Record<string, unknown>) : {}
    if (typeof entry.text === 'string' && /[\r\n\0]/.test(entry.text.trim())) return { ok: false, reason: 'each condition text must be one line' }
    const text = oneLine(entry.text)
    if (text.length < 3 || text.length > 160) return { ok: false, reason: 'each condition text must be 3 to 160 characters' }
    if (seen.has(plain(text))) return { ok: false, reason: `"${text}" is given twice` }
    seen.add(plain(text))
    if (entry.link === undefined) {
      conditions.push({ text })
      continue
    }
    const link = CHECK_KINDS.find(one => one === entry.link)
    if (!link) return { ok: false, reason: `link must be one of ${CHECK_KINDS.join(', ')}` }
    if (!kinds.includes(link)) {
      const found = checks.map(one => `${one.kind} (${one.command})`).join(', ')
      return { ok: false, reason: `link "${link}" has no check in this project (found: ${found || 'none'}); give that condition no link, or a kind that was found` }
    }
    conditions.push({ text, link })
  }

  return { ok: true, value: { goal, conditions } }
}

// Only a task nobody has put a condition on: a person's own conditions are not added to by Claude, and a locked contract is the person's.
export function canAutoSet(task: Task): { ok: true } | { ok: false; reason: string } {
  if (task.locked) return { ok: false, reason: 'the contract is locked; use propose_contract_change' }
  if (task.doneConditions.length > 0) return { ok: false, reason: 'the contract already has done conditions; use propose_contract_change to add one' }

  return { ok: true }
}

// The conditions Claude set that are still as it set them: same id and same words, so one the person removed and wrote again is theirs.
export function autoMade(task: Task, set: { task: string; ids: readonly string[]; texts: readonly string[] } | undefined): DoneCondition[] {
  if (!set || set.task !== task.id) return []

  return task.doneConditions.filter(one => set.ids.some((id, i) => id === one.id && set.texts[i] === one.text))
}

// Whether a prompt carries the reminder: an open, empty contract that Claude has not set yet, for the first few prompts of the task.
export function shouldNudge(task: Task, nudge: { task: string; asked: number } | undefined, autoSetTask: string | undefined): boolean {
  return !task.locked && task.doneConditions.length === 0 && autoSetTask !== task.id && (nudge?.task !== task.id || nudge.asked < NUDGE_LIMIT)
}
