import { describe, expect, test } from 'claude-code/testing'

import * as crew from '../hooks/crew'
import * as codex from '../hooks/codex'

describe('team mode decisions', () => {
  test('the same command failing twice in a row points Claude at the advisor once', async () => {
    const key = crew.failureKey('Bash', { command: 'npm test -- auth' })
    expect(key).toBe('bash:npm test')
    let state = crew.trackResult(crew.EMPTY_TRACK, key, false)
    expect(state.nudge).toBe(false)
    state = crew.trackResult(state.track, key, false)
    expect(state.nudge).toBe(true)
    state = crew.trackResult(state.track, key, false)
    expect(state.nudge).toBe(false)
    expect(state.track.failures[key]).toBe(3)
    expect(crew.trackResult(state.track, key, true).track.failures[key]).toBe(undefined)
    expect(crew.advisorRan(state.track, 9)).toEqual({ failures: {}, nudged: [], lastAdvisorAt: 9, advisorRuns: 1 })
  })

  test('a plan needs a review from this turn; a final check follows the last code edit', async () => {
    const turn = { ...crew.EMPTY_TRACK, turnStartedAt: 100 }
    expect(crew.needsPlanReview(turn)).toBe(true)
    expect(crew.needsPlanReview({ ...turn, lastAdvisorAt: 50 })).toBe(true)
    expect(crew.needsPlanReview({ ...turn, lastAdvisorAt: 120 })).toBe(false)

    expect(crew.needsFinalCheck(turn, undefined, false)).toBe(false)
    expect(crew.needsFinalCheck(turn, 90, false)).toBe(false)
    expect(crew.needsFinalCheck(turn, 110, false)).toBe(true)
    expect(crew.needsFinalCheck(turn, 110, true)).toBe(false)
    expect(crew.needsFinalCheck({ ...turn, lastAdvisorAt: 130 }, 110, false)).toBe(false)
  })

  test('the agents are read-only and pinned to their models', async () => {
    expect(crew.EXPLORER_SPEC.model).toBe('haiku')
    expect(crew.ADVISOR_SPEC.model).toBe('opus')
    for (const spec of [crew.EXPLORER_SPEC, crew.ADVISOR_SPEC]) {
      expect(spec.tools.some(tool => ['Edit', 'Write', 'Bash', 'NotebookEdit'].includes(tool))).toBe(false)
    }
  })
})

describe('design first', () => {
  const turn = { ...crew.EMPTY_TRACK, turnStartedAt: 100 }
  const lines = (n: number) => Array.from({ length: n }, (_, i) => `l${i}`).join('\n')

  test('edit size counts the larger side, every edit of a MultiEdit, and bulk replacement', async () => {
    expect(crew.editSize('Edit', { old_string: lines(2), new_string: lines(7) }).lines).toBe(7)
    expect(crew.editSize('Edit', { old_string: '', new_string: '' })).toEqual({ lines: 0, chars: 0, isBulk: false })
    expect(crew.editSize('Edit', { old_string: 'a', new_string: 'b', replace_all: true }).isBulk).toBe(true)
    expect(crew.editSize('Write', { content: lines(10) }).lines).toBe(10)
    expect(crew.editSize('NotebookEdit', { new_source: lines(3) }).lines).toBe(3)
    expect(crew.editSize('MultiEdit', { edits: [{ old_string: 'a', new_string: lines(2) }, { old_string: lines(3), new_string: 'b' }] }).lines).toBe(5)
  })

  test('small means few lines, one file, and a small total for the turn', async () => {
    const size = (n: number) => crew.editSize('Edit', { old_string: 'a', new_string: lines(n) })
    expect(crew.isSmallEdit(turn, 'a.ts', size(6))).toBe(true)
    expect(crew.isSmallEdit(turn, 'a.ts', size(7))).toBe(false)
    expect(crew.isSmallEdit(turn, 'a.ts', crew.editSize('Edit', { old_string: 'a', new_string: 'b', replace_all: true }))).toBe(false)

    const edited = crew.noteEdit(turn, 'a.ts', 6)
    expect(crew.isSmallEdit(edited, 'a.ts', size(6))).toBe(true)
    expect(crew.isSmallEdit(edited, 'b.ts', size(1))).toBe(false)
    expect(crew.isSmallEdit(crew.noteEdit(edited, 'a.ts', 6), 'a.ts', size(6))).toBe(false)
  })

  test('a design from this turn covers big edits; a denial lets the next try through; carried designs persist', async () => {
    expect(crew.needsDesign(turn, true)).toBe(false)
    expect(crew.needsDesign(turn, false)).toBe(true)
    expect(crew.needsDesign({ ...turn, lastAdvisorAt: 90 }, false)).toBe(true)
    expect(crew.needsDesign({ ...turn, lastAdvisorAt: 120 }, false)).toBe(false)
    expect(crew.needsDesign({ ...turn, designDeniedAt: 110 }, false)).toBe(false)

    const next = crew.turnStart({ ...turn, lastAdvisorAt: 120, turnEdits: { files: ['a'], lines: 3 } }, 200, false)
    expect(next).toMatchObject({ turnStartedAt: 200, designFrom: 200 })
    expect(next.turnEdits).toBe(undefined)
    expect(crew.needsDesign(next, false)).toBe(true)

    const carried = crew.turnStart({ ...turn, designFrom: 100, lastAdvisorAt: 120 }, 200, true)
    expect(crew.needsDesign(carried, false)).toBe(false)
    expect(crew.planWasApproved({ ...turn, planApprovedAt: 150 })).toBe(true)
    expect(crew.planWasApproved({ ...turn, planApprovedAt: 50 })).toBe(false)
  })

  test('fixed prompt text has no dynamic values', async () => {
    expect(crew.TEAM_CONTEXT).toContain('designs; you implement')
    expect(crew.DESIGN_FIRST).toContain('Asked once per turn')
    expect(crew.ADVISOR_SPEC.prompt).toContain('DESIGN:')
  })
})


describe('codex plugin', () => {
  test('is off until the person turns it on, and only counts with team mode', () => {
    expect(codex.codexOf(undefined)).toEqual({ enabled: false, review: false, rescue: false })
    expect(codex.isCodexOn(codex.setCodex({ enabled: true }, { enabled: true, review: true }))).toBe(true)
    expect(codex.isCodexOn(codex.setCodex({ enabled: false }, { enabled: true }))).toBe(false)
    expect(codex.setCodex(undefined, { review: true }).enabled).toBe(false)
  })

  test('recognises the companion script and what it is asked to do', () => {
    expect(codex.codexCall('node /home/u/.claude/plugins/cache/openai-codex/codex/1.0.6/scripts/codex-companion.mjs review --wait')).toEqual({ op: 'review', write: false, background: false })
    expect(codex.codexCall('node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task --write --background "fix it"')).toEqual({ op: 'task', write: true, background: true })
    expect(codex.codexCall('node x.mjs review')).toBeUndefined()
    expect(codex.codexCall('node /a/codex-companion.mjs bogus')).toBeUndefined()
    expect(codex.codexCall('grep codex-companion.mjs README.md')).toBeUndefined()
  })

  test('finds the installed plugin and treats damage as unknown', () => {
    const json = JSON.stringify({ plugins: { 'other@x': [{ installPath: '/x' }], 'codex@openai-codex': [{ installPath: '/home/u/.claude/plugins/cache/openai-codex/codex/1.0.6' }] } })
    expect(codex.companionFrom(json)).toBe('/home/u/.claude/plugins/cache/openai-codex/codex/1.0.6/scripts/codex-companion.mjs')
    expect(codex.companionFrom('{not json')).toBeUndefined()
    expect(codex.companionFrom(JSON.stringify({ plugins: { 'codex@x': [{ installPath: 'relative' }] } }))).toBeUndefined()
  })

  test('one review per turn', () => {
    const track = { failures: {}, nudged: [], advisorRuns: 0, turnStartedAt: 100 }
    expect(codex.hasReviewedThisTurn(track)).toBe(false)
    const ran = codex.codexRan(track, 150)
    expect(codex.hasReviewedThisTurn(ran)).toBe(true)
    expect(ran.codexRuns).toBe(1)
    expect(codex.hasReviewedThisTurn({ ...ran, turnStartedAt: 200 })).toBe(false)
  })
  test('only a plain invocation of the detected script may be allowed unasked', () => {
    const path = '/home/u/.claude/plugins/cache/openai-codex/codex/1.0.6/scripts/codex-companion.mjs'
    const ok = (command: string) => codex.isPlainInvocation(command, path)
    expect(ok(`node ${path} review --wait`)).toBe(true)
    expect(ok(`node "${path}" adversarial-review --background`)).toBe(true)
    expect(ok(`node ${path} task "why does it fail; look at src | head"`)).toBe(true)
    expect(ok(`node ${path} review --wait; git push`)).toBe(false)
    expect(ok(`cd x && node ${path} review`)).toBe(false)
    expect(ok(`node ${path} review --wait && git push origin main`)).toBe(false)
    expect(ok(`node ${path} task "$(cat ~/.ssh/id_rsa)"`)).toBe(false)
    expect(ok(`node ${path} task \`id\``)).toBe(false)
    expect(ok(`node ${path} task --write "x"`)).toBe(false)
    for (const bad of [`task -write "x"`, `task "--write fix it"`, `task '--write' x`, `task "fix it --write"`, `task --wr\\ite x`, `task --model gpt-5 x`, `task -C /other "x"`, `review --base main`]) {
      expect([bad, ok(`node ${path} ${bad}`)]).toEqual([bad, false])
    }
    expect(ok(`node ${path} task "explain the failing test in src/a.ts"`)).toBe(true)
    expect(ok(`node ${path} review > out.txt`)).toBe(false)
    expect(ok(`node /other/codex-companion.mjs review`)).toBe(false)
    expect(ok(`node ${path} review\ngit push`)).toBe(false)
    expect(ok(`node ${path} review\n'git' 'push'`)).toBe(false)
    expect(ok(`node ${path} review --wait\r\n'git' 'push'`)).toBe(false)
    expect(ok(`node ${path} task "two\nlines"`)).toBe(false)
    expect(ok(`node\t${path}\treview\t--wait`)).toBe(true)
  })
})

describe('failure keys', () => {
  test('different scripts and wrapped commands keep their own count', async () => {
    expect(crew.failureKey('Bash', { command: 'npm run lint' })).not.toBe(crew.failureKey('Bash', { command: 'npm run test' }))
    expect(crew.failureKey('Bash', { command: 'timeout 60 pytest' })).not.toBe(crew.failureKey('Bash', { command: 'timeout 60 npm test' }))
    expect(crew.failureKey('Bash', { command: 'npm run lint -- --fix' })).toBe(crew.failureKey('Bash', { command: 'npm run lint' }))
  })

  test('the team context states the real size limits', async () => {
    expect(crew.TEAM_CONTEXT).toContain(`more than ${crew.SMALL_EDIT_LINES} lines`)
    expect(crew.DESIGN_FIRST).toContain(`${crew.SMALL_TURN_LINES} lines in this turn`)
  })
})
