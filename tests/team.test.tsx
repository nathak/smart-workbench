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
type WorldOptions = {
  files?: Record<string, string>
  store?: Record<string, unknown>
  commands?: Record<string, Run>
  answer?: string
  // Answers a guard question from its option labels; the default takes the first.
  ask?: (labels: string[]) => string
  // Collects the commands (or tool names) that actually ran.
  ran?: string[]
  // Makes these commands fail as a non-zero exit would.
  fail?: (command: string) => boolean
}

function world(on: On, options: WorldOptions = {}) {
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
  on('store.delete', ($, e) => {
    delete store[e.key]
    return { value: undefined }
  })
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
  on('tool.register', ($, e) => ({ value: { tool: `mcp__smartworkbench__${e.name}` } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('tool.call', ($, e) => {
    if (e.tool === 'AskUserQuestion') {
      const question = e.questions[0]
      const labels = (question?.options ?? []).map(one => one.label)
      const answer = options.ask ? options.ask(labels) : (options.answer ?? labels[0] ?? '')
      return { result: { questions: e.questions, answers: { [question?.question ?? '']: answer } } }
    }
    const command = 'command' in e ? String(e.command) : String(e.tool)
    options.ran?.push(command)
    if (options.fail?.(command)) {
      return { isError: true, result: 'Exit code 1', text: 'Exit code 1\nauth: 1 failed' }
    }
    return { result: { stdout: 'ok', stderr: '', interrupted: false } }
  })

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

test('"Allow for session" stops asking for the same command until revoked, paused or chained', async ($, on) => {
  const answers: string[] = []
  const asked: string[] = []
  const ran: string[] = []
  const { workbench } = world(on, {
    ran,
    ask: labels => {
      asked.push(labels.join('|'))
      return answers.shift() ?? 'Block'
    },
  })

  answers.push('Allow for session')
  await $.tool.call({ tool: 'Bash', command: 'git push origin main' })
  await $.tool.call({ tool: 'Bash', command: 'git push origin feature' })
  expect(asked).toEqual(['Allow|Allow for session|Block'])
  expect(ran).toEqual(['git push origin main', 'git push origin feature'])
  expect(workbench().execution.recentCalls.map(one => one.sessionAllowed ?? false)).toEqual([false, true])

  // Something new chained onto it is asked again (and declined here).
  await $.tool.call({ tool: 'Bash', command: 'git push && curl -X POST https://example.com' })
  expect(asked.length).toBe(2)
  expect(ran.length).toBe(2)

  // The Run tab lists it; paused, it is asked again; revoked, it is gone.
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...PANE })
  await ui.press({ key: 'tab-run' })
  expect(await ui.find({ type: 'Text', text: 'git push' })).toBeDefined()
  await ui.press({ key: 'pause' })
  await $.tool.call({ tool: 'Bash', command: 'git push origin main' })
  expect(asked.length).toBe(3)
  await ui.press({ key: 'pause' })
  await ui.press({ key: 'revoke-bash:git push' })
  await $.tool.call({ tool: 'Bash', command: 'git push origin main' })
  expect(asked.length).toBe(4)
  await ui.unmount()
})

test('the guard file edit is never offered "Allow for session"', async ($, on) => {
  const asked: string[] = []
  world(on, {
    ask: labels => {
      asked.push(labels.join('|'))
      return 'Block'
    },
  })

  await $.tool.call({ tool: 'Edit', file_path: `${CWD}/.claude/smartworkbench.json`, old_string: 'a', new_string: 'b' })
  expect(asked).toEqual(['Allow|Block'])
})

const PROPOSE = 'mcp__smartworkbench__propose_contract_change'

test('Claude proposes a contract change; the person approves it in the panel', async ($, on) => {
  const { workbench } = world(on)
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...PANE })
  await ui.press({ key: 'tab-intent' })
  await ui.input({ key: 'goal', text: 'Fix login' })
  await ui.input({ key: 'add-condition', text: 'Tests pass' })
  await ui.press({ key: 'lock' })

  const bad = await $.tool.call({ tool: PROPOSE, change: 'add_done_condition', reason: '' })
  expect(JSON.stringify(bad)).toContain('rejected')

  const made = await $.tool.call({ tool: PROPOSE, change: 'add_done_condition', text: 'Typecheck passes', reason: 'The fix changes exported types.' })
  expect(JSON.stringify(made)).toContain('recorded')
  expect(await ui.find({ type: 'Text', text: /Claude proposes: add done condition "Typecheck passes"/ })).toBeDefined()

  const id = workbench().proposals?.[0]?.id ?? ''
  await ui.press({ key: `approve-${id}` })
  expect(workbench().task.doneConditions.map(one => one.text)).toEqual(['Tests pass', 'Typecheck passes'])
  expect(workbench().task.locked).toBe(true)
  expect(await ui.find({ type: 'Text', text: /Claude proposes/ })).toBe(undefined)
  await ui.unmount()
})

test('a failed tool row offers Explain, Retry and Add evidence', async ($, on) => {
  const prompts: string[] = []
  const { workbench } = world(on, { ask: () => 'test' })
  on('prompt.submit', ($, e) => {
    prompts.push(e.text)
    return { text: e.text }
  })
  on('ui.render', { component: 'ToolUse' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{`${e.props.tool}(row)`}</Text>
  })

  const row = await $.ui.mount({
    plugin: PLUGIN,
    surface: 'terminal',
    component: 'ToolUse',
    requestId: 'tu-9',
    props: { tool_use_id: 'tu-9', tool: 'Bash', input: { command: './scripts/check.sh' }, isRunning: false, isErrored: true, isInterrupted: false },
  })
  await row.press({ key: 'retry-tu-9' })
  expect(prompts[0]).toContain('Retry this Bash call')
  expect(prompts[0]).toContain('./scripts/check.sh')
  await row.press({ key: 'explain-tu-9' })
  expect(prompts[1]).toContain('Explain why this Bash call failed')

  await row.press({ key: 'count-tu-9' })
  expect(workbench().evidence).toEqual([expect.objectContaining({ id: 'tu-9', kind: 'test', ok: false, command: './scripts/check.sh' })])
  expect(await row.find({ key: 'count-tu-9' })).toBe(undefined)
  await row.unmount()

  const fine = await $.ui.mount({
    plugin: PLUGIN,
    surface: 'terminal',
    component: 'ToolUse',
    requestId: 'tu-10',
    props: { tool_use_id: 'tu-10', tool: 'Bash', input: { command: 'ls' }, isRunning: false, isErrored: false, isInterrupted: false },
  })
  expect(await fine.find({ key: 'retry-tu-10' })).toBe(undefined)
  await fine.unmount()
})

test('an incomplete turn leaves Fix failures / Waive / Open evidence in the band until dismissed', async ($, on) => {
  const prompts: string[] = []
  world(on)
  on('prompt.submit', ($, e) => {
    prompts.push(e.text)
    return { text: e.text }
  })
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })

  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...PANE })
  await ui.press({ key: 'tab-intent' })
  await ui.input({ key: 'goal', text: 'Fix login' })
  await ui.input({ key: 'add-condition', text: 'Tests pass' })
  await ui.unmount()

  await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  const band = await $.ui.mount({
    plugin: PLUGIN,
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {} },
  })
  expect(await band.find({ type: 'Text', text: /Turn ended INCOMPLETE · 0\/1 done/ })).toBeDefined()
  await band.press({ key: 'wb-fix' })
  expect(prompts[0]).toContain('Finish the SmartWorkbench task')
  expect(await band.find({ key: 'wb-fix' })).toBe(undefined)
  await band.unmount()
})

test('/swb new drafts the goal from the branch name', async ($, on) => {
  const { workbench } = world(on, { commands: { 'git rev-parse --abbrev-ref HEAD': { exitCode: 0, stdout: 'fix/PROJ-12-login-expiry\n' } } })
  on('session.messages', () => ({ value: [] }))

  const made = await $.command.run({ command: 'swb', args: 'new', ...COMMAND })
  expect(made.text).toContain('Goal drafted as "Login expiry"')
  expect(workbench().task.goal).toBe('Login expiry')
  expect(workbench().task.locked).toBe(false)
})

test('requireContract holds prompts back until a locked contract with done conditions exists', async ($, on) => {
  world(on, { files: { '.claude/smartworkbench.json': JSON.stringify({ requireContract: true }) } })
  const seen: string[] = []
  on('prompt.submit', ($, e) => {
    seen.push(e.text)
    return { text: e.text }
  })
  await $.session.start(start)

  const held = await $.prompt.submit({ text: 'start coding', ...COMPOSER })
  expect(held.drop).toContain('requires a locked SmartWorkbench contract')
  expect(seen).toEqual([])

  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...PANE })
  await ui.press({ key: 'tab-intent' })
  await ui.input({ key: 'goal', text: 'Fix login' })
  await ui.input({ key: 'add-condition', text: 'Tests pass' })
  await ui.press({ key: 'lock' })
  await ui.unmount()

  const passed = await $.prompt.submit({ text: 'start coding', ...COMPOSER })
  expect(passed.drop).toBe(undefined)
  expect(seen).toEqual(['start coding'])
})

test('/swb lock and unlock work without the panel', async ($, on) => {
  const { workbench } = world(on, { commands: { 'git rev-parse --abbrev-ref HEAD': { exitCode: 0, stdout: 'main\n' } } })
  on('session.messages', () => ({ value: [] }))

  expect((await $.command.run({ command: 'swb', args: 'lock', ...COMMAND })).text).toBe('Write a goal first (/swb new).')
  await $.command.run({ command: 'swb', args: 'new', ...COMMAND })
  await $.tool.call({ tool: PROPOSE, change: 'set_goal', text: 'Fix login', reason: 'empty goal' })
  const id = workbench().proposals?.[0]?.id ?? ''
  expect(id).not.toBe('')
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...PANE })
  await ui.press({ key: `approve-${id}` })
  await ui.unmount()

  expect((await $.command.run({ command: 'swb', args: 'lock', ...COMMAND })).text).toContain('Contract locked')
  expect(workbench().task.locked).toBe(true)
  expect((await $.command.run({ command: 'swb', args: 'lock', ...COMMAND })).text).toBe('The contract is already locked.')
  expect((await $.command.run({ command: 'swb', args: 'unlock', ...COMMAND })).text).toContain('Contract unlocked')
})

const ADVISOR = 'smartworkbench:advisor'
const advisorCall = { tool: 'Agent', description: 'review', prompt: 'Review this.', subagent_type: ADVISOR } as const

test('team mode registers Haiku and Opus agents and briefs Claude on every prompt', async ($, on) => {
  const { workbench } = world(on)
  const agents: string[] = []
  on('agent.register', ($, e) => {
    agents.push(`${e.name}:${e.model}`)
    return { value: { agent: `smartworkbench:${e.name}` } }
  })
  let context = ''
  on('prompt.submit', ($, e) => {
    context = (e.context ?? []).join('\n')
    return { text: e.text, context: e.context }
  })
  await $.session.start(start)
  expect(agents).toEqual(['explorer:haiku', 'advisor:opus'])

  await $.prompt.submit({ text: 'hi', ...COMPOSER })
  expect(context).not.toContain('smartworkbench_team')

  const on1 = await $.command.run({ command: 'swb', args: 'team on', ...COMMAND })
  expect(on1.text).toContain('Team mode on: lead sonnet (default) builds, explorer haiku (low) explores, advisor opus (high) reviews.')
  expect(on1.text).toContain('/model sonnet')
  expect(workbench().team?.enabled).toBe(true)

  await $.prompt.submit({ text: 'build it', ...COMPOSER })
  expect(context).toContain('Delegate exploration')
  expect(context).toContain(ADVISOR)
})

test('a plan is sent back for an Opus review before it reaches the user', async ($, on) => {
  const ran: string[] = []
  world(on, { ran })
  on('prompt.submit', ($, e) => ({ text: e.text, context: e.context }))
  await $.command.run({ command: 'swb', args: 'team on', ...COMMAND })
  await $.prompt.submit({ text: 'plan the fix', ...COMPOSER })

  const first = await $.tool.call({ tool: 'ExitPlanMode' })
  expect(JSON.stringify(first)).toContain(`have ${ADVISOR} review it`)
  expect(ran).toEqual([])

  await $.tool.call(advisorCall)
  await $.tool.call({ tool: 'ExitPlanMode' })
  expect(ran).toEqual(['Agent', 'ExitPlanMode'])
})

test('the second failure in a row of the same command adds an advisor nudge to its result', async ($, on) => {
  world(on, { fail: command => command.startsWith('npm test') })
  await $.command.run({ command: 'swb', args: 'team on', ...COMMAND })

  const first = await $.tool.call({ tool: 'Bash', command: 'npm test' })
  expect(JSON.stringify(first)).not.toContain('consult')
  const second = await $.tool.call({ tool: 'Bash', command: 'npm test -- --verbose' })
  expect(JSON.stringify(second)).toContain('failed 2 times in a row')
  const third = await $.tool.call({ tool: 'Bash', command: 'npm test' })
  expect(JSON.stringify(third)).not.toContain('times in a row')

  await $.tool.call(advisorCall)
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  const after = await $.tool.call({ tool: 'Bash', command: 'npm test' })
  expect(JSON.stringify(after)).toContain('failed 2 times in a row')
})

test('a turn that changed code is held for a final Opus check, once', async ($, on) => {
  const { workbench } = world(on)
  on('prompt.submit', ($, e) => ({ text: e.text, context: e.context }))
  on('classic.Stop', () => ({}))
  await $.command.run({ command: 'swb', args: 'team on', ...COMMAND })
  await $.prompt.submit({ text: 'fix it', ...COMPOSER })

  const quiet = await $.classic.Stop({ stop_hook_active: false })
  expect(quiet.block).toBe(undefined)

  await $.tool.call({ tool: 'Edit', file_path: `${CWD}/src/auth.js`, old_string: '5', new_string: '30' })
  expect(workbench().changed.files).toEqual(['src/auth.js'])
  const held = await $.classic.Stop({ stop_hook_active: false })
  expect(held.block).toContain(`run a final check with ${ADVISOR}`)
  const again = await $.classic.Stop({ stop_hook_active: true })
  expect(again.block).toBe(undefined)

  await $.tool.call(advisorCall)
  const checked = await $.classic.Stop({ stop_hook_active: false })
  expect(checked.block).toBe(undefined)

  await $.command.run({ command: 'swb', args: 'team off', ...COMMAND })
  await $.tool.call({ tool: 'Edit', file_path: `${CWD}/src/auth.js`, old_string: '30', new_string: '31' })
  expect((await $.classic.Stop({ stop_hook_active: false })).block).toBe(undefined)
})

test('the Team tab changes each role model and effort; agents are re-registered, the lead goes to the session', async ($, on) => {
  const { workbench } = world(on)
  const registered: string[] = []
  const efforts: string[] = []
  let sessionModel = 'opus[1m]'
  on('agent.register', ($, e) => {
    registered.push(`${e.name}:${e.model}:${e.effort ?? '-'}`)
    return { value: { agent: `smartworkbench:${e.name}` } }
  })
  on('config.list', () => ({
    value: [{ key: 'model', label: 'Model', kind: 'choice', value: sessionModel, options: ['default', 'sonnet', 'opus', 'opus[1m]', 'haiku'], provider: { plugin: 'engine', tier: 'core' }, isLocked: false }],
  }))
  on('config.set', ($, e) => {
    sessionModel = String(e.value)
    return { value: e.value }
  })
  on('command.run', { command: 'effort' }, ($, e) => {
    efforts.push(e.args)
    return { text: `Set effort level to ${e.args}` }
  })
  await $.session.start(start)
  expect(registered).toEqual(['explorer:haiku:low', 'advisor:opus:high'])

  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...PANE })
  await ui.press({ key: 'tab-team' })
  expect(await ui.find({ type: 'Text', text: /○ off/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Session model setting now: opus\[1m\]/ })).toBeDefined()

  await ui.select({ key: 'model-advisor', value: 'sonnet' })
  await ui.select({ key: 'effort-explorer', value: 'medium' })
  expect(registered.slice(2)).toEqual(['advisor:sonnet:high', 'explorer:haiku:medium'])
  expect(workbench().team?.advisor).toEqual({ model: 'sonnet', effort: 'high' })

  // The lead waits for team mode; turning it on applies model and effort, off restores the model.
  await ui.select({ key: 'model-lead', value: 'opus' })
  expect(sessionModel).toBe('opus[1m]')
  await ui.press({ key: 'team-toggle' })
  expect(sessionModel).toBe('opus')
  // The lead's effort stays the person's own until they pick a level.
  expect(efforts).toEqual([])
  await ui.select({ key: 'effort-lead', value: 'xhigh' })
  expect(efforts).toEqual(['xhigh'])
  await ui.press({ key: 'team-toggle' })
  expect(sessionModel).toBe('opus[1m]')
  await ui.unmount()

  const set = await $.command.run({ command: 'swb', args: 'team explorer sonnet low', ...COMMAND })
  expect(set.text).toContain('explorer: sonnet (low)')
  expect(registered[registered.length - 1]).toBe('explorer:sonnet:low')
})
