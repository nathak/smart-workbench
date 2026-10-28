import { describe, expect, test } from 'claude-code/testing'

import { evidenceKindOf, guessLink } from '../hooks/evidence'
import * as model from '../hooks/model'
import { isUnlinked, projectChecks, suggestConditions, wordingSuggestions, type RootFiles } from '../hooks/suggest'
import type { ProjectCheck, Task } from '../types'

const root = (names: string[], texts: Record<string, string> = {}): RootFiles => ({ names, texts })
const pkg = (scripts: Record<string, string>, extra: Record<string, unknown> = {}) => JSON.stringify({ scripts, ...extra })
const commands = (files: RootFiles) => projectChecks(files).map(one => `${one.kind}=${one.command}`)
const task = (over: Partial<Task> = {}): Task => ({ ...model.newTask(model.emptyWorkbench()).task, ...over })

describe('checks found at the project root', () => {
  test('npm scripts give a check per kind, run the way the package manager runs them', () => {
    const scripts = { test: 'vitest', 'type-check': 'tsc', lint: 'eslint .', build: 'vite build' }
    expect(commands(root(['package.json'], { 'package.json': pkg(scripts) }))).toEqual(['test=npm test', 'typecheck=npm run type-check', 'lint=npm run lint', 'build=npm run build'])
    expect(commands(root(['package.json', 'pnpm-lock.yaml'], { 'package.json': pkg(scripts) }))[0]).toBe('test=pnpm test')
    expect(commands(root(['package.json', 'yarn.lock'], { 'package.json': pkg(scripts) }))[0]).toBe('test=yarn test')
    expect(commands(root(['package.json', 'bun.lock'], { 'package.json': pkg(scripts) }))[0]).toBe('test=bun run test')
    expect(commands(root(['package.json'], { 'package.json': pkg(scripts, { packageManager: 'pnpm@9.1.0' }) }))[0]).toBe('test=pnpm test')
  })

  test('the default npm test script and a broken package.json offer nothing', () => {
    expect(commands(root(['package.json'], { 'package.json': pkg({ test: 'echo "Error: no test specified" && exit 1' }) }))).toEqual([])
    expect(commands(root(['package.json'], { 'package.json': '{ not json' }))).toEqual([])
    expect(commands(root(['package.json'], { 'package.json': '[]' }))).toEqual([])
  })

  test('a tsconfig stands in for a missing typecheck script, and alone it offers nothing', () => {
    expect(commands(root(['package.json', 'tsconfig.json'], { 'package.json': pkg({ build: 'tsc -b' }) }))).toEqual(['typecheck=npx tsc --noEmit', 'build=npm run build'])
    expect(commands(root(['tsconfig.json']))).toEqual([])
  })

  test('python tools are found by their config', () => {
    expect(commands(root(['pytest.ini']))).toEqual(['test=pytest'])
    expect(commands(root(['pyproject.toml'], { 'pyproject.toml': '[tool.pytest.ini_options]\n[tool.mypy]\n[tool.ruff]' }))).toEqual(['test=pytest', 'typecheck=mypy .', 'lint=ruff check .'])
    expect(commands(root(['setup.cfg'], { 'setup.cfg': '[tool:pytest]' }))).toEqual(['test=pytest'])
    expect(commands(root(['tox.ini'], { 'tox.ini': '[pytest]' }))).toEqual(['test=pytest'])
  })

  test('cargo, go, gradle and maven roots', () => {
    expect(commands(root(['Cargo.toml']))).toEqual(['test=cargo test', 'build=cargo build'])
    expect(commands(root(['go.mod']))).toEqual(['test=go test ./...', 'build=go build ./...'])
    expect(commands(root(['gradlew', 'build.gradle.kts']))).toEqual(['test=./gradlew test', 'build=./gradlew build'])
    expect(commands(root(['build.gradle.kts']))).toEqual(['test=gradle test', 'build=gradle build'])
    expect(commands(root(['pom.xml', 'mvnw']))).toEqual(['test=./mvnw test'])
    expect(commands(root(['pom.xml']))).toEqual(['test=mvn test'])
  })

  test('make targets: test and build are found, lint, .PHONY and := are not', () => {
    expect(commands(root(['Makefile'], { Makefile: '.PHONY: test\nlint:\n\techo\ntest:\n\techo\nbuild:\n\techo' }))).toEqual(['test=make test', 'build=make build'])
    expect(commands(root(['Makefile'], { Makefile: 'lint:\n\techo\n.PHONY: test build\ntest := x' }))).toEqual([])
  })

  test('the makefile read is the one make runs: GNUmakefile, then makefile, then Makefile', () => {
    expect(commands(root(['Makefile', 'makefile'], { Makefile: 'test:\n\techo', makefile: 'build:\n\techo' }))).toEqual(['build=make build'])
    expect(commands(root(['Makefile', 'GNUmakefile'], { Makefile: 'test:\n\techo', GNUmakefile: 'check:\n\techo' }))).toEqual(['test=make check'])
  })

  test('a Claude Code plugin is checked with its own test and validate commands', () => {
    expect(commands(root(['.claude-plugin/plugin.json', 'tests']))).toEqual(['test=claude plugin test .', 'build=claude plugin validate .'])
    expect(commands(root(['.claude-plugin/plugin.json']))).toEqual(['build=claude plugin validate .'])
  })

  test('one check per kind: package.json wins over a Makefile', () => {
    expect(commands(root(['package.json', 'Makefile'], { 'package.json': pkg({ test: 'jest' }), Makefile: 'test:\n\techo' }))).toEqual(['test=npm test'])
  })

  test('an empty root offers nothing', () => {
    expect(projectChecks(root([]))).toEqual([])
  })

  test('every command offered is read as that kind of check, and its condition links to it', () => {
    const roots = [
      root(['package.json', 'tsconfig.json'], { 'package.json': pkg({ test: 'jest', lint: 'eslint', build: 'tsc' }) }),
      root(['package.json', 'bun.lock'], { 'package.json': pkg({ test: 'bun test', 'check-types': 'tsc' }) }),
      root(['pyproject.toml'], { 'pyproject.toml': '[tool.pytest]\n[tool.mypy]\n[tool.ruff]' }),
      root(['package.json', 'pnpm-lock.yaml'], { 'package.json': pkg({ test: 'vitest', tsc: 'tsc', lint: 'eslint', build: 'vite build' }) }),
      root(['package.json', 'yarn.lock'], { 'package.json': pkg({ test: 'jest', typecheck: 'tsc', lint: 'eslint', build: 'webpack' }) }),
      root(['Cargo.toml']),
      root(['go.mod']),
      root(['gradlew']),
      root(['build.gradle']),
      root(['pom.xml', 'mvnw']),
      root(['pom.xml']),
      root(['Makefile'], { Makefile: 'check:\n\techo\nall:\n\techo' }),
      root(['.claude-plugin/plugin.json', 'tests']),
    ]
    for (const files of roots) {
      const checks = projectChecks(files)
      expect(checks.length).toBeGreaterThan(0)
      for (const one of checks) expect(evidenceKindOf(one.command)).toBe(one.kind)
      for (const one of suggestConditions(task(), checks)) {
        expect(guessLink(one.text)).toBe(one.link)
      }
    }
  })
})

describe('conditions from the wording of the goal', () => {
  test('a review request gives a review condition in the goal\'s language', () => {
    const korean = wordingSuggestions('이 코드를 제출하기 전에 위험한 부분이 있는지 코드 리뷰해줘.')
    expect(korean.map(one => one.key)).toEqual(['review'])
    expect(korean[0]?.text.startsWith('리뷰:')).toBe(true)
    expect(wordingSuggestions('please review the auth change').map(one => one.text)).toEqual(['Review: risky spots listed with file:line, each fixed or accepted'])
  })

  test('a count of two or more gives a count condition; one, and a plain goal, give none', () => {
    expect(wordingSuggestions('run the loop 100 times').map(one => one.key)).toEqual(['count:100'])
    expect(wordingSuggestions('루프 100번 돌려').map(one => one.text)).toEqual(['100번 실행됨: 실행 결과에서 횟수 확인'])
    expect(wordingSuggestions('1번 고쳐줘')).toEqual([])
    for (const goal of ['이슈 123번 고쳐줘', 'PR 45번 리뷰 말고 실행 확인', '3번째 파일 실행 방식 수정', 'make it 2 times faster', 'fix issue #12 3 times', '게임을 5번 플레이 가능하게']) {
      expect(wordingSuggestions(goal).map(one => one.key).filter(key => key.startsWith('count'))).toEqual([])
    }
    expect(wordingSuggestions('테스트를 10회 반복 실행').map(one => one.key)).toEqual(['count:10'])
    expect(wordingSuggestions('run the failing test 5 times').map(one => one.key)).toEqual(['count:5'])
    expect(wordingSuggestions('Fix the login expiry')).toEqual([])
    expect(wordingSuggestions('')).toEqual([])
  })

  test('no wording suggestion is linked to a check by guessing', () => {
    for (const goal of ['코드 리뷰해줘 100번', 'review it 5 times']) {
      for (const one of wordingSuggestions(goal)) expect(guessLink(one.text)).toBeUndefined()
    }
  })
})

describe('what is offered for a task', () => {
  const checks: ProjectCheck[] = [{ kind: 'test', command: 'npm test', from: 'package.json' }, { kind: 'lint', command: 'npm run lint', from: 'package.json' }]
  const keys = (list: { key: string }[]) => list.map(one => one.key)

  test('the wording of the goal comes first, then the checks', () => {
    const offered = suggestConditions(task({ goal: 'review the change' }), checks)
    expect(keys(offered)).toEqual(['review', 'check:test', 'check:lint'])
    expect(offered[1]).toMatchObject({ text: 'Tests pass: npm test', link: 'test', command: 'npm test' })
  })

  test('nothing is offered once the contract is locked', () => {
    expect(suggestConditions(task({ locked: true, goal: 'review it' }), checks)).toEqual([])
  })

  test('what the contract already says is not offered again', () => {
    const have = (text: string, link?: 'test' | 'lint') => ({ id: 'dc-1', text, ...(link ? { link } : {}) })
    expect(keys(suggestConditions(task({ doneConditions: [have('Related tests pass', 'test')] }), checks))).toEqual(['check:lint'])
    expect(keys(suggestConditions(task({ goal: 'review it', doneConditions: [have('Code review done')] }), []))).toEqual([])
    expect(keys(suggestConditions(task({ goal: 'loop 100 times', doneConditions: [have('100 times run')] }), []))).toEqual([])
    expect(keys(suggestConditions(task({ goal: 'loop 100 times', doneConditions: [have('ran 5 times')] }), []))).toEqual(['count:100'])
    expect(keys(suggestConditions(task({ doneConditions: [have('Lint passes: npm run lint')] }), checks))).toEqual(['check:test'])
  })

  test('a hidden suggestion stays hidden', () => {
    expect(keys(suggestConditions(task({ goal: 'review it' }), checks, ['review', 'check:test']))).toEqual(['check:lint'])
  })
})

describe('adding offered conditions', () => {
  const checks: ProjectCheck[] = [{ kind: 'test', command: 'claude plugin test .', from: '.claude-plugin/plugin.json' }]

  test('a given link wins over the guess from the wording, and no link keeps the guess', () => {
    const wb = model.emptyWorkbench()
    expect(model.addCondition(wb, 'Tests pass: x', 'build').task.doneConditions[0]?.link).toBe('build')
    expect(model.addCondition(wb, 'Related tests pass').task.doneConditions[0]?.link).toBe('test')
    expect(model.addCondition(wb, 'Something else').task.doneConditions[0]?.link).toBeUndefined()
  })

  test('add all adds each with its link and ids in order; a locked contract changes nothing', () => {
    const wb = model.emptyWorkbench()
    const offered = suggestConditions({ ...wb.task, goal: '리뷰해줘' }, checks)
    const added = model.addSuggestions(wb, offered)
    expect(added.task.doneConditions.map(one => [one.id, one.link])).toEqual([['dc-1', undefined], ['dc-2', 'test']])
    const locked = { ...wb, task: { ...wb.task, locked: true } }
    expect(model.addSuggestions(locked, offered)).toEqual(locked)
  })

  test('add all skips a condition the contract already has, as a press on a stale list would repeat it', () => {
    const wb = model.emptyWorkbench()
    const offered = suggestConditions(wb.task, checks)
    const once = model.addSuggestions(wb, offered)
    expect(model.addSuggestions(once, offered).task.doneConditions).toHaveLength(1)
  })

  test('only a condition with neither link nor mark is unlinked', () => {
    expect(isUnlinked({ id: 'dc-1', text: 'a' })).toBe(true)
    expect(isUnlinked({ id: 'dc-1', text: 'a', link: 'test' })).toBe(false)
    expect(isUnlinked({ id: 'dc-1', text: 'a', manual: { status: 'verified', at: 1, note: '' } })).toBe(false)
  })
})
