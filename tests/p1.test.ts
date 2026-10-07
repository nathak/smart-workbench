import { describe, expect, test } from 'claude-code/testing'

import type { Changed, EvidenceRecord } from '../types'
import { coverageOf, hunkLabel, lastCheckedEdit, parseDiff } from '../hooks/diff'
import { statusOf } from '../hooks/evidence'
import { categoryOf, suggestionsOf } from '../hooks/files'
import { applyRule, globToRegExp, matchRule, parsePolicy } from '../hooks/policy'
import { classify, decide } from '../hooks/risk'

describe('project guard file', () => {
  test('parses rules and reports broken ones without guessing', async () => {
    const policy = parsePolicy(
      JSON.stringify({
        profile: 'strict',
        rules: [
          { tool: 'Bash', command: 'terraform\\s+apply', policy: 'block', reason: 'CI only' },
          { policy: 'ask' },
          { tool: 'Bash', command: '([', policy: 'ask' },
          { path: 'migrations/**', policy: 'nope' },
        ],
      }),
    )
    expect(policy.profile).toBe('strict')
    expect(policy.rules.length).toBe(1)
    expect(policy.errors.length).toBe(3)
    expect(parsePolicy('{ broken').errors[0]).toContain('not valid JSON')
  })

  test('globs match paths the way a .gitignore reader expects', async () => {
    expect(globToRegExp('migrations/**').test('migrations/2026/01_init.sql')).toBe(true)
    expect(globToRegExp('src/**/*.ts').test('src/a.ts')).toBe(true)
    expect(globToRegExp('src/**/*.ts').test('src/auth/session.ts')).toBe(true)
    expect(globToRegExp('*.lock').test('sub/yarn.lock')).toBe(false)
  })

  test('rules tighten freely but never loosen a block or a secrets check', async () => {
    const rules = parsePolicy(
      JSON.stringify({
        rules: [
          { tool: 'Edit|Write', path: 'migrations/**', policy: 'ask', reason: 'needs review' },
          { tool: 'Bash', command: 'reset --hard', policy: 'allow' },
          { tool: 'Bash', command: 'printenv', policy: 'allow' },
          { tool: 'Bash', command: 'git push', policy: 'allow' },
        ],
      }),
    ).rules
    const verdictFor = (tool: string, input: object) => applyRule(classify(tool, input), matchRule(rules, tool, input, '/w'))

    expect(verdictFor('Edit', { file_path: '/w/migrations/001.sql' })).toEqual(
      expect.objectContaining({ policy: 'ask', reason: 'needs review' }),
    )
    expect(verdictFor('Edit', { file_path: '/w/src/a.ts' }).policy).toBe('allow')
    expect(verdictFor('Bash', { command: 'git reset --hard' }).policy).toBe('block')
    expect(verdictFor('Bash', { command: 'printenv' }).policy).toBe('ask')
    expect(verdictFor('Bash', { command: 'git push origin main' }).policy).toBe('allow')
  })

  test('changing the guard file itself is always asked', async () => {
    expect(classify('Edit', { file_path: '/w/.claude/smartworkbench.json' }).policy).toBe('ask')
    expect(classify('Bash', { command: 'echo {} > .claude/smartworkbench.json' }).policy).toBe('ask')
    expect(classify('Bash', { command: 'cat .claude/smartworkbench.json' }).policy).toBe('allow')
    expect(decide(classify('Edit', { file_path: '.claude/smartworkbench.json' }), 'permissive', false)).toBe('ask')
  })
})

describe('observed files', () => {
  test('are classified by path', async () => {
    expect(categoryOf('src/auth/session.ts')).toBe('source')
    expect(categoryOf('src/auth/session.test.ts')).toBe('test')
    expect(categoryOf('tests/auth.py')).toBe('test')
    expect(categoryOf('package.json')).toBe('config')
    expect(categoryOf('.github/workflows/ci.yml')).toBe('config')
    expect(categoryOf('docs/guide.md')).toBe('docs')
    expect(categoryOf('pnpm-lock.yaml')).toBe('generated')
    expect(categoryOf('dist/index.js')).toBe('generated')
    expect(categoryOf('config/.env.local')).toBe('secret')
  })

  test('suggest what the work keeps returning to, never secrets or hidden files', async () => {
    const observed = [
      { path: 'src/a.ts', how: 'edited' as const, count: 1 },
      { path: 'src/b.ts', how: 'read' as const, count: 3 },
      { path: 'src/c.ts', how: 'read' as const, count: 1 },
      { path: '.env', how: 'read' as const, count: 5 },
      { path: 'README.md', how: 'read' as const, count: 4 },
      { path: 'src/d.ts', how: 'read' as const, count: 2 },
    ]
    const pins = [{ id: 'p', kind: 'file' as const, path: 'src/d.ts', mode: 'live' as const }]

    expect(suggestionsOf(observed, pins, []).map(one => one.path)).toEqual(['src/a.ts', 'src/b.ts'])
    expect(suggestionsOf(observed, pins, ['src/b.ts']).map(one => one.path)).toEqual(['src/a.ts'])
  })
})

describe('diff regions and evidence', () => {
  const DIFF = [
    'diff --git a/src/auth.ts b/src/auth.ts',
    'index 1..2 100644',
    '--- a/src/auth.ts',
    '+++ b/src/auth.ts',
    '@@ -10,2 +10,3 @@ export function login() {',
    '-  const ttl = 30',
    '-  return ttl',
    '+  const ttl = 60',
    '+  log(ttl)',
    '+  return ttl',
    '@@ -40 +41,0 @@',
    '-  legacy()',
    'diff --git a/docs/auth.md b/docs/auth.md',
    '--- a/docs/auth.md',
    '+++ b/docs/auth.md',
    '@@ -1 +1 @@',
    '-old',
    '+new',
  ].join('\n')

  test('git diff -U0 output becomes per-file regions', async () => {
    const parsed = parseDiff(DIFF)
    expect(parsed.hunks['src/auth.ts']).toEqual([
      { from: 10, to: 12, added: 3, removed: 2 },
      { from: 41, to: 41, added: 0, removed: 1 },
    ])
    expect(parsed.added).toBe(4)
    expect(parsed.removed).toBe(4)
    expect(hunkLabel(parsed.hunks['src/auth.ts'] ?? [])).toBe('L10-12, L41 (del)')
  })

  test('a file counts as proven only by a check that ran after its last edit', async () => {
    const changed: Changed = {
      files: ['src/auth.ts', 'docs/auth.md', 'src/other.ts'],
      added: 0,
      removed: 0,
      edits: { 'src/auth.ts': 100, 'docs/auth.md': 300, 'src/other.ts': 250 },
      hunks: parseDiff(DIFF).hunks,
    }
    const evidence: EvidenceRecord[] = [
      { id: 'a', kind: 'test', command: 'npm test', ok: true, at: 200 },
      { id: 'b', kind: 'typecheck', command: 'tsc', ok: false, at: 260 },
    ]
    const states = Object.fromEntries(coverageOf(changed, evidence).map(one => [one.path, one.state]))

    expect(states).toEqual({ 'src/auth.ts': 'failing', 'docs/auth.md': 'docs', 'src/other.ts': 'failing' })
    expect(coverageOf(changed, evidence.slice(0, 1)).find(one => one.path === 'src/auth.ts')?.state).toBe('proven')
    expect(coverageOf(changed, evidence.slice(0, 1)).find(one => one.path === 'src/other.ts')?.state).toBe('unproven')
    // Docs edits do not make checks stale.
    expect(lastCheckedEdit(changed)).toBe(250)
  })

  test('a pass older than the latest code edit is only observed', async () => {
    const condition = { id: 'dc-1', text: 'Tests pass', link: 'test' as const }
    const pass: EvidenceRecord = { id: 'a', kind: 'test', command: 'npm test', ok: true, at: 200 }

    expect(statusOf(condition, [pass], 100)).toBe('verified')
    expect(statusOf(condition, [pass], 250)).toBe('observed')
    expect(statusOf(condition, [pass, { ...pass, id: 'b', at: 300 }], 250)).toBe('verified')
  })
})
