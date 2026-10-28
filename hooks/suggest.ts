// Done conditions offered to the person, never added by themselves: from the checks the project root shows and from the wording of
// the goal. Pure, so a test can feed it files. Every command offered is one the evidence collector reads as that kind of check, so
// running it puts a result on the condition it was offered for.
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
