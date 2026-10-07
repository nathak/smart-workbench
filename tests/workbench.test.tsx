import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { Workbench } from '../types'

const CWD = '/work'
const PLUGIN = 'smartworkbench'
const PANE = {
  component: 'Pane',
  requestId: 'smartworkbench',
  props: { title: 'SmartWorkbench', isFocused: true, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

const COMPOSER = { wait: false, origin: { kind: 'composer' } } as const
const COMMAND = { origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } } as const

// The world beneath the plugin: a project folder, a store the test can read, a clock.
function world(on: On, store: Record<string, unknown> = {}, files: Record<string, string> = { 'src/auth.ts': 'export const ttl = 30' }) {
  mock.clock(on, { now: 1000 })
  on('store.get', ($, e) => ({ value: store[e.key] }))
  on('store.set', ($, e) => {
    store[e.key] = JSON.parse(JSON.stringify(e.value))
    return { value: undefined }
  })
  on('store.keys', () => ({ value: Object.keys(store) }))
  on('fs.write', ($, e) => {
    files[e.path] = e.text
    return { value: undefined }
  })
  on('session.cwd', () => ({ value: CWD }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 84000, window: 200000, percent: 42 }, rateLimits: [] } }))
  // The engine hands fs hooks absolute paths; match the project-relative name.
  const fileAt = (path: string) => Object.entries(files).find(([name]) => path === name || path.endsWith(`/${name}`))?.[1]
  on('fs.read', ($, e) => {
    const text = fileAt(e.path)
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text }
  })
  on('fs.stat', ($, e) => {
    const text = fileAt(e.path)
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: { kind: 'file', size: text.length, mtimeMs: 0, isLink: false } }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))

  return () => store[`ws:${CWD}`] as Workbench
}

test('a locked contract and pins reach the model as context, the prompt text untouched', async ($, on) => {
  world(on)
  let seen: { text: string; context?: readonly string[] } | undefined
  on('prompt.submit', ($, e) => {
    seen = { text: e.text, context: e.context }
    return { text: e.text, context: e.context }
  })

  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...PANE })
  await ui.input({ key: 'goal', text: 'Fix login session expiry' })
  await ui.input({ key: 'add-constraint', text: 'Do not change DB schema' })
  await ui.input({ key: 'add-condition', text: 'Related tests pass' })

  // Unlocked: nothing about the contract is added yet.
  await $.prompt.submit({ text: 'go', ...COMPOSER })
  expect(seen?.context ?? []).toEqual([])

  await ui.press({ key: 'lock' })
  await ui.press({ key: 'tab-context' })
  await ui.input({ key: 'pin-file', text: 'src/auth.ts' })
  await ui.input({ key: 'pin-file', text: 'gone.ts' })

  await $.prompt.submit({ text: 'fix it', ...COMPOSER })
  expect(seen?.text).toBe('fix it')
  const context = (seen?.context ?? []).join('\n')
  expect(context).toContain('<goal>Fix login session expiry</goal>')
  expect(context).toContain('<constraint priority="hard">Do not change DB schema</constraint>')
  expect(context).toContain('<condition id="dc-1">Related tests pass</condition>')
  expect(context).toContain('export const ttl = 30')

  // Same contract, same text: stable for the prompt cache.
  const first = seen?.context
  await $.prompt.submit({ text: 'again', ...COMPOSER })
  expect(seen?.context).toEqual(first)

  // A missing pinned file warns without stopping the prompt.
  await ui.press({ key: 'tab-intent' })
  expect(await ui.find({ type: 'Text', text: /gone\.ts: cannot read/ })).toBeDefined()

  // A locked contract cannot be edited from the panel.
  expect(await ui.find({ key: 'goal' })).toBe(undefined)
  await ui.unmount()
})

test('blocked calls never run; allowed calls are recorded with evidence', async ($, on) => {
  const workbench = world(on)
  const ran: string[] = []
  let testPasses = true
  on('tool.call', ($, e) => {
    const command = 'command' in e ? String(e.command) : String(e.tool)
    ran.push(command)
    if (command === 'npm test' && !testPasses) {
      return { isError: true, result: 'exit 1', text: 'Exit code 1' }
    }
    return { result: { stdout: 'ok', stderr: '', interrupted: false } }
  })

  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...PANE })
  await ui.input({ key: 'goal', text: 'Fix it' })
  await ui.input({ key: 'add-condition', text: 'Related tests pass' })

  const blocked = await $.tool.call({ tool: 'Bash', command: 'git reset --hard HEAD~1' })
  expect(ran).toEqual([])
  expect(JSON.stringify(blocked)).toContain('SmartWorkbench blocked')

  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  expect(ran).toEqual(['npm test'])
  let wb = workbench()
  expect(wb.task.status).toBe('complete')
  expect(wb.execution.recentCalls.map(one => one.outcome)).toEqual(['blocked', 'ok'])

  // A later failure is the latest state; the earlier pass stays in the history.
  testPasses = false
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  wb = workbench()
  expect(wb.evidence.map(one => one.ok)).toEqual([true, false])
  expect(wb.task.status).toBe('verifying')
  await ui.unmount()
})

test('state survives a restart through the store', async ($, on) => {
  const saved: Workbench = {
    schemaVersion: 1,
    task: { id: 't', status: 'active', locked: true, goal: 'Saved goal', constraints: [], nonGoals: [], doneConditions: [] },
    context: { pins: [{ id: 'p', kind: 'note', text: 'API response unchanged' }], observed: [] },
    execution: { profile: 'strict', isPaused: false, recentCalls: [] },
    evidence: [],
    changed: { files: [], added: 0, removed: 0 },
  }
  const workbench = world(on, { [`ws:${CWD}`]: saved })
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  let seen: readonly string[] | undefined
  on('prompt.submit', ($, e) => {
    seen = e.context
    return { text: e.text, context: e.context }
  })

  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ text: 'continue', ...COMPOSER })

  expect(workbench().execution.profile).toBe('strict')
  expect((seen ?? []).join('\n')).toContain('<goal>Saved goal</goal>')
  expect((seen ?? []).join('\n')).toContain('<note>API response unchanged</note>')
})

test('the panel and band draw on terminal and desktop', async ($, on) => {
  world(on)
  // The engine's own band beneath ours draws nothing here.
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, ...PANE })
    await ui.press({ key: 'tab-intent' })
    await ui.input({ key: 'goal', text: `Goal on ${surface}` })
    await ui.press({ key: 'tab-run' })
    expect(await ui.find({ key: 'profile' })).toBeDefined()
    await ui.press({ key: 'tab-evidence' })
    expect(await ui.find({ type: 'Text', text: /NO CONDITIONS/ })).toBeDefined()
    await ui.unmount()

    const band = await $.ui.mount({
      plugin: PLUGIN,
      surface,
      component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 10 }, view: {} },
    })
    expect(await band.find({ type: 'Text', text: new RegExp(`WB ○ Goal on ${surface}`) })).toBeDefined()
    await band.unmount()
  }
})

test('ask rules wait for the person: Allow runs the call, Block does not', async ($, on) => {
  const workbench = world(on)
  const ran: string[] = []
  let choice = 'Allow'
  on('tool.call', ($, e) => {
    if (e.tool === 'AskUserQuestion') {
      const question = e.questions[0]?.question ?? ''
      return { result: { questions: e.questions, answers: { [question]: choice } } }
    }
    ran.push('command' in e ? String(e.command) : e.tool)
    return { result: { stdout: '', stderr: '', interrupted: false } }
  })

  await $.tool.call({ tool: 'Bash', command: 'git push origin main' })
  expect(ran).toEqual(['git push origin main'])

  choice = 'Block'
  const declined = await $.tool.call({ tool: 'Bash', command: 'git push origin main' })
  expect(ran).toEqual(['git push origin main'])
  expect(JSON.stringify(declined)).toContain('declined')
  expect(workbench().execution.recentCalls.map(one => one.outcome)).toEqual(['ok', 'declined'])
})

test('line-range and snapshot pins carry exactly the text they promise', async ($, on) => {
  const files: Record<string, string> = { 'src/auth.ts': 'line1\nline2\nline3\nline4', 'src/config.ts': 'ttl = 30' }
  world(on, {}, files)
  let context = ''
  on('prompt.submit', ($, e) => {
    context = (e.context ?? []).join('\n')
    return { text: e.text, context: e.context }
  })

  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...PANE })
  await ui.press({ key: 'tab-context' })
  await ui.input({ key: 'pin-file', text: 'src/auth.ts:2-3' })
  await ui.input({ key: 'pin-file', text: 'src/config.ts' })

  await $.prompt.submit({ text: 'go', ...COMPOSER })
  expect(context).toContain('<file path="src/auth.ts" lines="2-3">\nline2\nline3\n  </file>')
  expect(context).not.toContain('line4')

  // Freeze config.ts, then change it on disk: the prompt keeps the pinned text.
  const modeKey = (await ui.findAll({ type: 'Button', text: 'Live' }))[1]?.key ?? ''
  await ui.press({ key: modeKey })
  expect(await ui.find({ type: 'Button', text: 'Snap' })).toBeDefined()
  files['src/config.ts'] = 'ttl = 60'

  await $.prompt.submit({ text: 'go again', ...COMPOSER })
  expect(context).toContain('ttl = 30')
  expect(context).not.toContain('ttl = 60')
  expect(context).toMatch(/snapshot_sha256="[0-9a-f]{12}"/)
  await ui.unmount()
})

test('templates save and load the setup without its results; export writes a handoff', async ($, on) => {
  const files: Record<string, string> = { 'src/auth.ts': 'x' }
  const store: Record<string, unknown> = {}
  const workbench = world(on, store, files)
  on('tool.call', ($, e) =>
    e.tool === 'AskUserQuestion'
      ? { result: { questions: e.questions, answers: { [e.questions[0]?.question ?? '']: 'Load template' } } }
      : { result: { stdout: 'ok', stderr: '', interrupted: false } },
  )

  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...PANE })
  await ui.press({ key: 'tab-intent' })
  await ui.input({ key: 'goal', text: 'Ship auth fix' })
  await ui.input({ key: 'add-constraint', text: 's: keep the patch small' })
  await ui.input({ key: 'add-condition', text: 'Tests pass' })
  await ui.press({ key: 'tab-context' })
  await ui.input({ key: 'pin-note', text: 'API unchanged' })
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  expect(workbench().task.status).toBe('complete')

  const saved = await $.command.run({ command: 'swb', args: 'save auth-fix', ...COMMAND })
  expect(saved.text).toContain('Saved template "auth-fix"')

  await $.command.run({ command: 'swb', args: 'load auth-fix', ...COMMAND })
  const wb = workbench()
  expect(wb.task.goal).toBe('Ship auth fix')
  expect(wb.task.constraints[0]?.priority).toBe('soft')
  expect(wb.task.doneConditions.map(one => one.link)).toEqual(['test'])
  expect(wb.evidence).toEqual([])
  expect(wb.task.status).toBe('active')
  expect(wb.task.locked).toBe(false)

  const listed = await $.command.run({ command: 'swb', args: 'templates', ...COMMAND })
  expect(listed.text).toContain('auth-fix')

  const exported = await $.command.run({ command: 'swb', args: 'export', ...COMMAND })
  expect(exported.text).toContain('.claude/smartworkbench-handoff.md')
  const handoff = Object.entries(files).find(([name]) => name.endsWith('smartworkbench-handoff.md'))?.[1] ?? ''
  expect(handoff).toContain('## Goal\n\nShip auth fix')
  expect(handoff).toContain('[S] keep the patch small')
  expect(handoff).toContain('Note: API unchanged')
  await ui.unmount()
})

test('tool rows keep the engine row and gain a risk or evidence line', async ($, on) => {
  const workbench = world(on)
  on('tool.call', () => ({ result: { stdout: 'ok', stderr: '', interrupted: false } }))
  on('ui.render', { component: 'ToolUse' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>Bash(row)</Text>
  })

  await $.tool.call({ tool: 'Bash', command: 'git reset --hard' })
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  // The engine mints each call's id; the rows are looked up by it.
  const [resetId = '', testId = '', lsId = ''] = workbench().execution.recentCalls.map(one => one.id)

  const row = (id: string, command: string) => ({
    plugin: PLUGIN,
    surface: 'terminal' as const,
    component: 'ToolUse' as const,
    requestId: id,
    props: { tool_use_id: id, tool: 'Bash', input: { command }, isRunning: false, isErrored: false, isInterrupted: false },
  })
  const blocked = await $.ui.mount(row(resetId, 'git reset --hard'))
  expect(await blocked.find({ type: 'Text', text: 'Bash(row)' })).toBeDefined()
  expect(await blocked.find({ type: 'Text', text: /WB · HIGH · Blocked/ })).toBeDefined()
  await blocked.unmount()

  const tested = await $.ui.mount(row(testId, 'npm test'))
  expect(await tested.find({ type: 'Text', text: /WB · test passed/ })).toBeDefined()
  await tested.unmount()

  const plain = await $.ui.mount(row(lsId, 'ls'))
  expect(await plain.find({ type: 'Text', text: /WB ·/ })).toBe(undefined)
  await plain.unmount()
})
