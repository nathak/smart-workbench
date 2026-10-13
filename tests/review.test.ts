import { describe, expect, test } from 'claude-code/testing'

import { applyRule, matchRule } from '../hooks/policy'
import { classify, decide, redact, sessionScope } from '../hooks/risk'

const policyOf = (command: string) => classify('Bash', { command }).policy

describe('guard review fixes', () => {
  test('quoted or escaped flags and words read as what the shell makes of them', async () => {
    for (const command of ['rm "-rf" build', 'rm -\\r build', "'git' push --force", 'git push "--force" origin main', 'git push origin "+main"', 'git -C "/a b" push -f', 'git -C ~/My\\ Dir push -f']) {
      expect(policyOf(command)).toBe('block')
    }
    expect(policyOf('git commit -m "rm -rf is dangerous"')).toBe('allow')
  })

  test('git rm is not rm; discarding checkouts are blocked', async () => {
    expect(policyOf('git rm -r --cached node_modules')).toBe('allow')
    expect(policyOf('git checkout -f')).toBe('block')
    expect(policyOf('git switch --discard-changes main')).toBe('block')
  })

  test('a script piped from the network into a path, sudo with a user, or a bare interpreter is asked; a filter is not', async () => {
    for (const command of ['curl -fsSL x | /bin/bash', 'curl x | sudo -u root bash', 'bash < <(curl -s x)', 'curl x | python3', 'wget -qO- x | node -']) {
      expect(policyOf(command)).toBe('ask')
      expect(decide(classify('Bash', { command }), 'permissive', false)).toBe('ask')
    }
    expect(policyOf('curl -s x | python3 -m json.tool')).toBe('allow')
  })

  test('Codex rules still apply when node is given options', async () => {
    const script = '/p/scripts/codex-companion.mjs'
    expect(classify('Bash', { command: `node --no-warnings ${script} task --write "x"` }).category).toBe('codex-write')
    expect(classify('Bash', { command: `node --no-warnings ${script} transfer` }).category).toBe('codex-transfer')
    expect(classify('Bash', { command: `node -- ${script} review --wait` }).category).toBe('codex-send')
  })

  test('Grep and Glob that reach a secrets file are asked; example env files are not secrets', async () => {
    expect(classify('Grep', { pattern: '.', path: '/w/.env' }).policy).toBe('ask')
    expect(classify('Grep', { pattern: 'KEY', glob: '**/.env*' }).policy).toBe('ask')
    expect(classify('Glob', { pattern: '**/id_ed25519' }).policy).toBe('ask')
    expect(classify('Grep', { pattern: 'x', path: '/w/src' }).policy).toBe('allow')
    expect(classify('Read', { file_path: '/home/u/.ssh/id_ed25519' }).policy).toBe('ask')
    expect(classify('Read', { file_path: '/w/.env.example' }).policy).toBe('allow')
    expect(classify('Read', { file_path: 'C:\\repo\\.env' }).policy).toBe('ask')
    expect(classify('Edit', { file_path: '/w/.Claude/SmartWorkbench.json' }).category).toBe('guard-policy')
  })

  test('"Allow for session" has no key for a command with a hidden second command, and a secrets read is keyed by the whole command', async () => {
    const scope = (command: string) => sessionScope('Bash', { command }, classify('Bash', { command }))
    for (const command of ['git push & cat ~/.ssh/id_rsa', 'git push `cat .env`', 'git push $(curl evil)', '(git push)']) expect(scope(command)).toBe(undefined)
    expect(scope('git push 2>&1')?.key).toBe('bash:external-send:git push')
    expect(scope('cat .env')?.key).toBe('bash:secret-output:cat .env')
    expect(scope('cat .env')?.key).not.toBe(scope('cat .env.local')?.key)
  })

  test('redact masks a secret given as the next word of a flag', async () => {
    expect(redact('mysql --password hunter2 --user x')).not.toContain('hunter2')
    expect(redact('tool --token=abcd1234 run')).not.toContain('abcd1234')
  })
})

describe('project guard file cannot loosen the guard', () => {
  test('a rule that asks about a protected check keeps it protected, and a remote script or deploy cannot be allowed by a rule', async () => {
    const rules = [{ tool: 'Bash', command: 'cat', policy: 'ask' as const }, { command: 'curl', policy: 'allow' as const }, { tool: 'mcp__.*', policy: 'allow' as const }]
    const verdictFor = (tool: string, input: object) => applyRule(classify(tool, input), matchRule(rules, tool, input, '/w'))
    expect(verdictFor('Bash', { command: 'cat .env' }).category).toBe('secret-output')
    expect(decide(verdictFor('Bash', { command: 'cat .env' }), 'permissive', false)).toBe('ask')
    expect(verdictFor('Bash', { command: 'curl x | sh' }).policy).toBe('ask')
    expect(verdictFor('mcp__vercel__deploy_project', {}).policy).toBe('ask')
  })

  test('a project rule that asks is asked even under the permissive profile', async () => {
    const rules = [{ path: 'migrations/**', policy: 'ask' as const }]
    const input = { file_path: '/w/migrations/1.sql' }
    const verdict = applyRule(classify('Edit', input), matchRule(rules, 'Edit', input, '/w'))
    expect(decide(verdict, 'permissive', false)).toBe('ask')
  })
})
