import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { Workbench } from '../types'

const CWD = '/work'
const PLUGIN = 'smartworkbench'
const COMPOSER = { wait: false, origin: { kind: 'composer' } } as const
const COMMAND = { origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } } as const
const PANE = {
  component: 'Pane',
  requestId: 'smartworkbench',
  props: { title: 'SmartWorkbench', isFocused: true, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const
const GUARD = {
  profile: 'balanced',
  defaultTemplate: 'change',
  templates: {
    change: { constraints: ['Keep the API compatible'], doneConditions: ['Related tests pass', { text: 'CI is green', link: 'ci' }] },
    hotfix: { constraints: ['s: Smallest possible patch'], doneConditions: ['Repro test exists'] },
  },
  audit: true,
}

type Run = { exitCode: number; stdout: string; stderr?: string }

// A project folder, a store the test can read, a clock, and answers for local commands.
function world(on: On, options: { files?: Record<string, string>; store?: Record<string, unknown>; commands?: Record<string, Run>; answer?: string } = {}) {
  const files = options.files ?? {}
  const store = options.store ?? {}
  const commands = options.commands ?? {}
  const fileAt = (path: string) => Object.keys(files).find(name => path === name || path.endsWith(`/${name}`))

  mock.clock(on, { now: Date.UTC(2026, 9, 8, 1, 0, 0) })
  on('store.get', ($, e) => ({ value: store[e.key] }))
  on('store.set', ($, e) => {
    store[e.key] = JSON.parse(JSON.stringify(e.value))
    return { value: undefined }
  })
  on('store.keys', () => ({ value: Object.keys(store) }))
  on('session.cwd', () => ({ value: CWD }))
  on('session.id', () => ({ value: 'session-a' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: [] } }))
  on('fs.read', ($, e) => {
    const name = fileAt(e.path)
    if (name === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: files[name] ?? '' }
  })
  on('fs.exists', ($, e) => ({ value: fileAt(e.path) !== undefined }))
  on('fs.stat', ($, e) => {
    const name = fileAt(e.path)
    if (name === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: { kind: 'file', size: (files[name] ?? '').length, mtimeMs: 0, isLink: false } }
  })
  on('fs.write', ($, e) => {
    files[fileAt(e.path) ?? e.path] = e.text
    return { value: undefined }
  })
  on('process.run', ($, e) => {
    const run = commands[e.argv.join(' ')] ?? { exitCode: 1, stdout: '', stderr: `unexpected: ${e.argv.join(' ')}` }
    return { value: { exitCode: run.exitCode, stdout: run.stdout, stderr: run.stderr ?? '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('tool.call', ($, e) =>
    e.tool === 'AskUserQuestion'
      ? { result: { questions: e.questions, answers: { [e.questions[0]?.question ?? '']: options.answer ?? e.questions[0]?.options[0]?.label ?? '' } } }
      : { result: { stdout: 'ok', stderr: '', interrupted: false } },
  )

  // The engine hands fs hooks absolute paths; read back by project-relative name.
  const file = (name: string) => Object.entries(files).find(([key]) => key === name || key.endsWith(`/${name}`))?.[1]

  return { file, store, workbench: () => store[`ws:${CWD}`] as Workbench }
}

const start = { cwd: CWD, surface: 'terminal', isInteractive: true } as const

test('the team default template seeds /swb new; team templates load by name', async ($, on) => {
  const { workbench } = world(on, {
    files: { '.claude/smartworkbench.json': JSON.stringify(GUARD) },
    commands: { 'git config user.name': { exitCode: 0, stdout: 'Kim\n' } },
  })
  await $.session.start(start)

  const created = await $.command.run({ command: 'swb', args: 'new', ...COMMAND })
  expect(created.text).toContain('team template "change"')
  expect(workbench().task.constraints.map(one => one.text)).toEqual(['Keep the API compatible'])
  expect(workbench().task.doneConditions.map(one => one.link)).toEqual(['test', 'ci'])

  const listed = await $.command.run({ command: 'swb', args: 'templates', ...COMMAND })
  expect(listed.text).toContain('change (default for /swb new), hotfix')

  await $.command.run({ command: 'swb', args: 'load team:hotfix', ...COMMAND })
  expect(workbench().task.constraints).toEqual([expect.objectContaining({ text: 'Smallest possible patch', priority: 'soft' })])
})

test('the audit log records guard decisions, contract locks, manual marks and completion', async ($, on) => {
  const { file } = world(on, {
    files: { '.claude/smartworkbench.json': JSON.stringify(GUARD) },
    commands: { 'git config user.name': { exitCode: 0, stdout: 'Kim\n' } },
  })
  await $.session.start(start)

  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...PANE })
  await ui.press({ key: 'tab-intent' })
  await ui.input({ key: 'goal', text: 'Fix login' })
  await ui.input({ key: 'add-condition', text: 'Mobile layout checked' })
  await ui.press({ key: 'lock' })
  await $.tool.call({ tool: 'Bash', command: 'git reset --hard' })
  await $.tool.call({ tool: 'Bash', command: 'git push origin main' })
  await ui.press({ key: 'tab-evidence' })
  await ui.press({ key: 'verify-dc-1' })
  await ui.unmount()

  const log = file('.claude/smartworkbench-audit.jsonl') ?? ''
  const events = log
    .trim()
    .split('\n')
    .map(line => JSON.parse(line) as { event: string; user?: string; session?: string })
  expect(events.map(one => one.event)).toEqual(['session.start', 'contract.lock', 'guard.block', 'guard.ask', 'task.complete', 'condition.verified'])
  expect(events.every(one => one.user === 'Kim' && one.session === 'session-a')).toBe(true)

  const shown = await $.command.run({ command: 'swb', args: 'audit 3', ...COMMAND })
  expect(shown.text).toContain('(last 3 of 6)')
  expect(shown.text).toContain('Kim condition.verified')
})

test('/swb ci imports the runs of HEAD as ci evidence', async ($, on) => {
  const sha = 'abc1234def5678'
  const runs = [
    { databaseId: 10, workflowName: 'test', status: 'completed', conclusion: 'success', headSha: sha, url: 'u' },
    { databaseId: 11, workflowName: 'lint', status: 'completed', conclusion: 'failure', headSha: sha, url: 'u' },
  ]
  const { workbench } = world(on, {
    commands: {
      'git rev-parse HEAD': { exitCode: 0, stdout: `${sha}\n` },
      [`gh run list --commit ${sha} --json databaseId,workflowName,name,status,conclusion,headSha,url --limit 30`]: { exitCode: 0, stdout: JSON.stringify(runs) },
      'git status --porcelain': { exitCode: 0, stdout: ' M README.md\n' },
    },
  })

  const ran = await $.command.run({ command: 'swb', args: 'ci', ...COMMAND })
  expect(ran.text).toBe('✓ CI: test @ abc1234\n✕ CI: lint @ abc1234')
  expect(workbench().evidence.map(one => [one.kind, one.ok])).toEqual([
    ['ci', true],
    ['ci', false],
  ])
})

test('/swb issue links a GitHub issue, fills the goal and pins its description', async ($, on) => {
  const { workbench } = world(on, {
    commands: {
      'gh issue view 42 --json number,title,url,body': {
        exitCode: 0,
        stdout: JSON.stringify({ number: 42, title: 'Login expires early', url: 'https://github.com/o/r/issues/42', body: 'Sessions end after 5 minutes.' }),
      },
    },
  })

  const linked = await $.command.run({ command: 'swb', args: 'issue #42', ...COMMAND })
  expect(linked.text).toContain('Linked #42: Login expires early')
  const wb = workbench()
  expect(wb.task.goal).toBe('Login expires early')
  expect(wb.task.issue).toEqual({ ref: '#42', title: 'Login expires early', url: 'https://github.com/o/r/issues/42' })
  expect(wb.context.pins).toEqual([expect.objectContaining({ kind: 'note', text: 'Issue #42: Sessions end after 5 minutes.' })])

  const other = await $.command.run({ command: 'swb', args: 'issue clear', ...COMMAND })
  expect(other.text).toBe('Issue unlinked.')
})

test('share writes the task for another machine; pickup takes it over', async ($, on) => {
  const { file, workbench } = world(on)

  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...PANE })
  await ui.press({ key: 'tab-intent' })
  await ui.input({ key: 'goal', text: 'Port the cache' })
  await ui.input({ key: 'add-condition', text: 'Tests pass' })
  await ui.unmount()
  await $.tool.call({ tool: 'Bash', command: 'npm test' })

  const shared = await $.command.run({ command: 'swb', args: 'share', ...COMMAND })
  expect(shared.text).toContain('.claude/smartworkbench-task.json')
  expect(file('.claude/smartworkbench-task.json')).toContain('"goal": "Port the cache"')

  await $.command.run({ command: 'swb', args: 'new', ...COMMAND })
  expect(workbench().task.goal).toBe('')

  const picked = await $.command.run({ command: 'swb', args: 'pickup', ...COMMAND })
  expect(picked.text).toContain('Picked up "Port the cache"')
  expect(workbench().task.goal).toBe('Port the cache')
  expect(workbench().evidence).toEqual([])
})

test('a change saved by another session of the project is picked up before the next prompt', async ($, on) => {
  const { store, workbench } = world(on)
  let context = ''
  on('prompt.submit', ($, e) => {
    context = (e.context ?? []).join('\n')
    return { text: e.text, context: e.context }
  })
  await $.session.start(start)

  // Another session locks a contract and saves it with a higher revision.
  const other: Workbench = {
    ...workbench(),
    schemaVersion: 1,
    rev: (workbench()?.rev ?? 0) + 5,
    savedBy: 'session-b',
    task: { id: 't', status: 'active', locked: true, goal: 'Set elsewhere', constraints: [], nonGoals: [], doneConditions: [] },
    context: { pins: [], observed: [], excluded: [] },
    execution: { profile: 'balanced', isPaused: false, recentCalls: [] },
    evidence: [],
    changed: { files: [], added: 0, removed: 0 },
  }
  store[`ws:${CWD}`] = other

  await $.prompt.submit({ text: 'continue', ...COMPOSER })
  expect(context).toContain('<goal>Set elsewhere</goal>')

  // This session's next save builds on that copy rather than overwriting it.
  await $.tool.call({ tool: 'Read', file_path: `${CWD}/src/a.ts` })
  expect(workbench().task.goal).toBe('Set elsewhere')
  expect(workbench().savedBy).toBe('session-a')
})
