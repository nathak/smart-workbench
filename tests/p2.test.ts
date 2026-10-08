import { describe, expect, test } from 'claude-code/testing'

import type { Workbench } from '../types'
import { serializeContract } from '../hooks/intent'
import * as model from '../hooks/model'
import { AUDIT_PATH, parsePolicy } from '../hooks/policy'
import * as risk from '../hooks/risk'
import { classifyMcp, decide } from '../hooks/risk'
import { AUDIT_MAX_CHARS, appendAudit, auditLine, ciEvidence, formatAudit, parseIssueArg, readAudit, readShare, shareText } from '../hooks/team'

describe('team templates and audit settings', () => {
  test('templates parse from the guard file with soft constraints and links', async () => {
    const policy = parsePolicy(
      JSON.stringify({
        defaultTemplate: 'bugfix',
        templates: {
          bugfix: { constraints: ['No schema change', 's: Small patch'], doneConditions: ['Repro test exists', { text: 'CI is green', link: 'ci' }] },
          empty: {},
        },
        audit: true,
      }),
    )
    expect(policy.templates.map(one => one.name)).toEqual(['bugfix'])
    expect(policy.templates[0]?.constraints).toEqual([
      { text: 'No schema change', priority: 'hard' },
      { text: 'Small patch', priority: 'soft' },
    ])
    expect(policy.templates[0]?.doneConditions[1]).toEqual({ text: 'CI is green', link: 'ci' })
    expect(policy.defaultTemplate).toBe('bugfix')
    expect(policy.audit).toEqual({ path: AUDIT_PATH })
    expect(policy.errors).toEqual(['template "empty": needs constraints or doneConditions'])
  })

  test('audit paths must stay inside the repository; the default must exist', async () => {
    expect(parsePolicy(JSON.stringify({ audit: { path: '../outside.jsonl' } })).errors[0]).toContain('inside the repository')
    expect(parsePolicy(JSON.stringify({ audit: { path: '/tmp/x' } })).audit).toBe(undefined)
    expect(parsePolicy(JSON.stringify({ audit: { path: 'logs/a.jsonl' } })).audit).toEqual({ path: 'logs/a.jsonl' })
    expect(parsePolicy(JSON.stringify({ defaultTemplate: 'nope' })).errors[0]).toContain('defaultTemplate')
  })

  test('a team template starts a fresh unlocked task and keeps pins', async () => {
    const wb: Workbench = { ...model.emptyWorkbench(), context: { pins: [{ id: 'p', kind: 'note', text: 'keep me' }], observed: [] } }
    const template = parsePolicy(JSON.stringify({ templates: { t: { goal: 'G', doneConditions: ['Tests pass'] } } })).templates[0]!
    const next = model.applyTeamTemplate(wb, template)
    expect(next.task.goal).toBe('G')
    expect(next.task.doneConditions).toEqual([{ id: 'dc-1', text: 'Tests pass', link: 'test' }])
    expect(next.context.pins.length).toBe(1)
  })
})

describe('audit log', () => {
  test('appends, rotates past the cap and skips broken lines', async () => {
    const line = auditLine({ at: '2026-10-08T01:02:03.000Z', event: 'guard.block', user: 'kim', tool: 'Bash' })
    expect(appendAudit(undefined, line).text).toBe(line)
    const big = 'x'.repeat(AUDIT_MAX_CHARS)
    expect(appendAudit(big, line)).toEqual({ text: line, rotated: big })

    const entries = readAudit(`${line}not json\n${line}`)
    expect(entries.length).toBe(2)
    expect(formatAudit(entries, 1)).toBe('2026-10-08 01:02:03 kim guard.block tool=Bash')
  })
})

describe('CI results', () => {
  const sha = 'abc1234def'
  const runs = [
    { databaseId: 1, workflowName: 'test', status: 'completed', conclusion: 'failure', headSha: sha },
    { databaseId: 2, workflowName: 'test', status: 'completed', conclusion: 'success', headSha: sha },
    { databaseId: 3, workflowName: 'lint', status: 'in_progress', conclusion: null, headSha: sha },
    { databaseId: 4, workflowName: 'test', status: 'completed', conclusion: 'success', headSha: 'other' },
  ]

  test('take the latest run per workflow on this exact commit', async () => {
    expect(ciEvidence(runs, sha, false, 9)).toEqual([
      { id: 'ci-2', kind: 'ci', command: 'CI: test @ abc1234', ok: true, at: 9 },
      { id: 'ci-3', kind: 'ci', command: 'CI: lint @ abc1234 (running)', ok: null, at: 9 },
    ])
  })

  test('count only as observed while code changes are uncommitted', async () => {
    expect(ciEvidence(runs, sha, true, 9).map(one => one.ok)).toEqual([null, null])
  })

  test('a re-imported run replaces its own record', async () => {
    const first = model.addCiEvidence(model.emptyWorkbench(), ciEvidence(runs, sha, false, 1))
    const done = runs.map(one => (one.databaseId === 3 ? { ...one, status: 'completed', conclusion: 'failure' } : one))
    const next = model.addCiEvidence(first, ciEvidence(done, sha, false, 2))
    expect(next.evidence.map(one => [one.id, one.ok])).toEqual([
      ['ci-2', true],
      ['ci-3', false],
    ])
  })
})

describe('issues and MCP tools', () => {
  test('issue arguments: GitHub refs go through gh, other trackers are kept as typed', async () => {
    expect(parseIssueArg('#42')).toEqual({ ref: '42', isGitHub: true })
    expect(parseIssueArg('https://github.com/o/r/issues/7')).toEqual({ ref: 'https://github.com/o/r/issues/7', isGitHub: true })
    expect(parseIssueArg('LIN-12 Fix login timeout')).toEqual({ ref: 'LIN-12', title: 'Fix login timeout', isGitHub: false })
    expect(parseIssueArg('  ')).toBe(undefined)
  })

  test('a linked issue joins the contract and fills an empty goal', async () => {
    const wb = model.setIssue(model.emptyWorkbench(), { ref: '#42', title: 'Login expires early', url: 'https://github.com/o/r/issues/42' })
    expect(wb.task.goal).toBe('Login expires early')
    const text = serializeContract({ ...wb.task, locked: true })
    expect(text).toContain('<issue ref="#42" url="https://github.com/o/r/issues/42">Login expires early</issue>')
    expect(model.setIssue(model.toggleLock(wb), undefined).task.issue).toBeDefined()
  })

  test('MCP tools are grouped into deploy, issue and observability', async () => {
    expect(classifyMcp('mcp__vercel__deploy_project')).toEqual(expect.objectContaining({ category: 'mcp-deploy', policy: 'ask', risk: 'high' }))
    expect(classifyMcp('mcp__linear__create_issue')).toEqual(expect.objectContaining({ category: 'mcp-issue', policy: 'ask' }))
    expect(classifyMcp('mcp__linear__list_issues')).toEqual(expect.objectContaining({ category: 'mcp-issue', policy: 'allow' }))
    expect(classifyMcp('mcp__sentry__search_events')).toEqual(expect.objectContaining({ category: 'mcp-observe', policy: 'allow' }))
    expect(classifyMcp('mcp__pagerduty__acknowledge_incident')).toEqual(expect.objectContaining({ category: 'mcp-observe', policy: 'ask' }))
    expect(classifyMcp('mcp__slack__send_message').category).toBe('external-send')
    expect(decide(classifyMcp('mcp__vercel__deploy_project'), 'permissive', false)).toBe('ask')
  })
})

describe('sharing between sessions and machines', () => {
  test('a shared task round-trips; checks do not carry over, manual marks do', async () => {
    let wb = model.addCondition(model.setGoal(model.emptyWorkbench(), 'Ship it'), 'Tests pass')
    wb = model.markCondition(wb, 'dc-1', 'waived', 'covered by e2e', 5)
    wb = model.addEvidence(wb, { id: 'e', kind: 'test', command: 'npm test', ok: true, at: 6 })
    wb = model.pinNote(wb, 'API unchanged')

    const shared = readShare(shareText(wb, Date.UTC(2026, 9, 8), 'kim'))
    if ('error' in shared) throw new Error(shared.error)
    expect(shared.sharedBy).toBe('kim')

    const picked = model.applyShare(model.emptyWorkbench(), shared)
    expect(picked.task.goal).toBe('Ship it')
    expect(picked.task.doneConditions[0]?.manual?.note).toBe('covered by e2e')
    expect(picked.evidence).toEqual([])
    expect(picked.context.pins.map(one => (one.kind === 'note' ? one.text : ''))).toEqual(['API unchanged'])
    expect(readShare('{"format":"other"}')).toEqual({ error: 'not a SmartWorkbench task file (format/version)' })
  })

  test('a newer save from another session wins; this session\'s own does not count', async () => {
    const mine = { ...model.emptyWorkbench(), rev: 3, savedBy: 'a' }
    expect(model.isNewerElsewhere({ ...mine, rev: 4, savedBy: 'b' }, mine, 'a')).toBe(true)
    expect(model.isNewerElsewhere({ ...mine, rev: 4, savedBy: 'a' }, mine, 'a')).toBe(false)
    expect(model.isNewerElsewhere({ ...mine, rev: 3, savedBy: 'b' }, mine, 'a')).toBe(false)
  })
})

describe('allow for session', () => {
  test('commands are remembered by their command and subcommand', async () => {
    const { commandPrefix, splitCommand } = risk
    expect(commandPrefix('git push origin main')).toBe('git push')
    expect(commandPrefix('FOO=1 sudo git push --force-with-lease')).toBe('git push')
    expect(commandPrefix('gh pr create --fill')).toBe('gh pr create')
    expect(commandPrefix('cat .env')).toBe('cat .env')
    expect(commandPrefix('printenv')).toBe('printenv')
    expect(splitCommand('npm test && git push; echo done | tee log')).toEqual(['npm test', 'git push', 'echo done', 'tee log'])
  })

  test('a chain is covered only as the same set of commands; the guard file never', async () => {
    const scope = (command: string) => risk.sessionScope('Bash', { command }, risk.classify('Bash', { command }))
    expect(scope('git push origin main')).toEqual({ key: 'bash:git push', label: 'git push' })
    expect(scope('git push origin feature')?.key).toBe('bash:git push')
    expect(scope('git push && curl -X POST https://x')?.key).toBe('bash:curl POST && git push')
    expect(scope('echo {} > .claude/smartworkbench.json')).toBe(undefined)
    expect(risk.sessionScope('Edit', { file_path: '/w/.env' }, risk.classify('Edit', { file_path: '/w/.env' }))).toEqual({
      key: 'edit:/w/.env',
      label: 'edits of /w/.env',
    })
    expect(risk.sessionScope('mcp__linear__create_issue', {}, risk.classifyMcp('mcp__linear__create_issue'))?.key).toBe('tool:mcp__linear__create_issue')
  })
})
