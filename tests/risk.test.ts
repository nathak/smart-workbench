import { describe, expect, test } from 'claude-code/testing'

import { classify, decide } from '../hooks/risk'

describe('risk rules', () => {
  test('destructive git and recursive delete are blocked', async () => {
    for (const command of ['git push --force origin main', 'git push -f', 'git reset --hard HEAD~1', 'git clean -fdx', 'rm -rf build', 'cd x && rm -r dist', 'find . -name "*.o" -delete']) {
      const verdict = classify('Bash', { command })
      expect(verdict.policy).toBe('block')
      expect(verdict.risk).toBe('high')
    }
  })

  test('external sends and secret output are asked', async () => {
    for (const command of ['git push origin main', 'gh pr create --fill', 'npm publish', 'curl -X POST https://x', 'printenv', 'cat .env', 'echo $GITHUB_TOKEN']) {
      expect(classify('Bash', { command }).policy).toBe('ask')
    }
  })

  test('words that merely mention a secret file or a deploy are not asked', async () => {
    for (const command of ['grep -rn process.env src', 'grep -n "deploy" README.md', 'git commit -m "fix deploy script"', 'cat .env.example', 'head -5 docs/deploy.md']) {
      expect(classify('Bash', { command }).policy).toBe('allow')
    }
    for (const command of ['npm run deploy', 'make deploy', './scripts/deploy.sh prod', 'cd app && deploy', 'cat ./.env', 'grep KEY .env.local', 'bash scripts/deploy.sh', 'sudo make deploy', 'cat <.env', 'echo $(cat .env)', 'cat (.env)']) {
      expect(classify('Bash', { command }).policy).toBe('ask')
    }
  })

  test('ordinary work is allowed', async () => {
    expect(classify('Bash', { command: 'npm test -- auth' }).policy).toBe('allow')
    expect(classify('Bash', { command: 'rm notes.txt' }).policy).toBe('allow')
    expect(classify('Read', { file_path: 'src/a.ts' }).policy).toBe('allow')
    expect(classify('Edit', { file_path: 'src/a.ts' }).policy).toBe('allow')
    expect(classify('Edit', { file_path: 'config/.env' }).policy).toBe('ask')
  })

  test('profiles and pause adjust only what they should', async () => {
    const edit = classify('Edit', { file_path: 'src/a.ts' })
    const force = classify('Bash', { command: 'git push --force' })
    const push = classify('Bash', { command: 'git push' })

    expect(decide(edit, 'balanced', false)).toBe('allow')
    expect(decide(edit, 'strict', false)).toBe('ask')
    expect(decide(edit, 'balanced', true)).toBe('ask')
    expect(decide(force, 'permissive', false)).toBe('block')
    expect(decide(push, 'permissive', false)).toBe('allow')
  })
})
