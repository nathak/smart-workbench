import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

import { strings } from '../i18n.mjs'

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'ui', 'status.js'), 'utf8')

// Just enough of a DOM to build the page and click its buttons.
class Node {
  constructor(tag) {
    this.tag = tag
    this.children = []
    this.listeners = {}
    this.textContent = ''
    this.disabled = false
    this.value = ''
  }
  append(...items) {
    for (const item of items) this.children.push(item)
  }
  replaceChildren() {
    this.children = []
  }
  setAttribute(name, value) {
    this.attrs = { ...this.attrs, [name]: String(value) }
  }
  addEventListener(name, fn) {
    this.listeners[name] = fn
  }
  *walk() {
    yield this
    for (const child of this.children) if (child instanceof Node) yield* child.walk()
  }
}

function load(overview) {
  const sent = []
  const main = new Node('main')
  const document = {
    activeElement: null,
    documentElement: new Node('html'),
    createElement: tag => new Node(tag),
    createDocumentFragment: () => new Node('fragment'),
    getElementById: id => (id === 'list' ? main : new Node(id)),
  }
  const window = {
    swb: {
      overview: async () => overview,
      send: async (session, ops) => (sent.push(ops), { ok: true }),
    },
  }
  const ctx = { document, window, setInterval: () => 0, Date, Map, Object, String, Array, JSON, console }
  vm.runInNewContext(source, ctx)
  return { main, sent, ctx }
}

// Objects made inside the vm are of another realm.
const plain = value => JSON.parse(JSON.stringify(value))
const settle = () => new Promise(done => setTimeout(done, 20))
const buttons = main => [...main.walk()].filter(node => node.tag === 'button')
// The guard file's buttons come after the session guard's own profile buttons of the same names.
const labelled = (main, text) => buttons(main).filter(node => node.textContent.startsWith(text)).at(-1)

const snap = file => ({
  rev: 1, scope: 'project',
  task: { status: 'open', locked: false, goal: 'g', constraints: [], nonGoals: [], doneConditions: [] },
  team: { enabled: false, codex: false, roles: {}, efforts: {} },
  guard: { profile: 'balanced', paused: false, fileProfile: file?.profile ?? null, rules: file?.rules.length ?? 0, file },
  evidence: [], proposals: [],
})
const overview = (file, extra = {}) => ({ lang: 'en', text: strings('en').ui, hubUp: true, rows: [{ id: 's1', name: 'p', alive: true, quiet: false }], snaps: { s1: snap(file) }, acks: [], ...extra })
const HASH = 'a'.repeat(64)
const FILE = { hash: HASH, profile: 'balanced', editable: true, errors: 0, rules: [{ i: 2, policy: 'block', tool: 'Bash', command: 'x', path: null, reason: 'why' }, { i: 3, policy: 'allow', tool: 'Bash', command: 'y', path: null, reason: null }] }

test('the guard file block sends edits that quote the hash and the raw place of the rule, and says which ones are asked in the session', async () => {
  const { main, sent } = load(overview(FILE))
  await settle()
  const remove = buttons(main).filter(node => node.textContent.startsWith('Remove'))
  const block = remove.find(node => node.textContent.includes('confirmed in the session'))
  assert.ok(block)
  await block.listeners.click()
  assert.deepEqual(plain(sent.at(-1)), [{ op: 'policy_remove_rule', base: HASH, index: 2, policy: 'block' }])
  const allow = remove.find(node => !node.textContent.includes('confirmed'))
  await allow.listeners.click()
  assert.deepEqual(plain(sent.at(-1)), [{ op: 'policy_remove_rule', base: HASH, index: 3, policy: 'allow' }])
  await labelled(main, 'strict').listeners.click()
  assert.deepEqual(plain(sent.at(-1)), [{ op: 'policy_set_profile', base: HASH, profile: 'strict' }])
  assert.ok(labelled(main, 'permissive').textContent.includes('confirmed in the session'))
  assert.ok(!labelled(main, 'strict').textContent.includes('confirmed'))
  assert.ok(labelled(main, 'remove profile').textContent.includes('confirmed in the session'))
})

test('a file that cannot be edited, a pending answer or an ended session leaves the guard file buttons off', async () => {
  for (const [file, extra] of [[{ ...FILE, editable: false }, {}], [FILE, { acks: [{ id: 'c', session: 's1', label: 'lock', at: Date.now() }] }]]) {
    const { main } = load(overview(file, extra))
    await settle()
    const mine = buttons(main).filter(node => /^(Remove|permissive \(|remove profile|Add rule)/.test(node.textContent))
    assert.ok(mine.length >= 4)
    assert.ok(mine.every(node => node.disabled), JSON.stringify(mine.map(node => node.textContent)))
  }
  const ended = load(overview(FILE, { rows: [{ id: 's1', name: 'p', alive: false, quiet: false }] }))
  await settle()
  assert.equal(buttons(ended.main).filter(node => node.textContent.startsWith('Remove')).length, 0)
})

test('with no guard file the form creates one with a null base, and the rule form offers only ask and block', async () => {
  const { main, sent } = load(overview(null))
  await settle()
  const nodes = [...main.walk()]
  const policy = nodes.find(node => node.tag === 'select' && node.children.some(option => option.value === 'ask'))
  assert.deepEqual(policy.children.map(option => option.value), ['ask', 'block'])
  const inputs = nodes.filter(node => node.tag === 'input' && node.placeholder === strings('en').ui.ruleHints.tool)
  inputs[0].value = 'Bash'
  policy.value = 'block'
  await labelled(main, 'Add rule').listeners.click()
  assert.deepEqual(plain(sent.at(-1)), [{ op: 'policy_add_rule', base: null, rule: { policy: 'block', tool: 'Bash' } }])
})

const panels = main => [...main.walk()].filter(node => node.attrs?.role === 'tabpanel')
const tabButtons = main => buttons(main).filter(node => node.attrs?.role === 'tab')

test('a card shows one tab at a time, a click switches it without a redraw, and a redraw keeps the chosen tab', async () => {
  const { main, ctx } = load(overview(FILE))
  await settle()
  assert.deepEqual(tabButtons(main).map(node => node.textContent), ['Intent', 'Evidence', 'Team', 'Guard'])
  assert.deepEqual(panels(main).map(node => node.hidden), [false, true, true, true])
  await tabButtons(main)[3].listeners.click()
  assert.deepEqual(panels(main).map(node => node.hidden), [true, true, true, false])
  assert.deepEqual(tabButtons(main).map(node => node.attrs['aria-selected']), ['false', 'false', 'false', 'true'])
  await ctx.refresh(true)
  assert.deepEqual(panels(main).map(node => node.hidden), [true, true, true, false])
})

test('while an answer is pending the tabs stay usable and the change buttons rest', async () => {
  const { main } = load(overview(FILE, { acks: [{ id: 'c', session: 's1', label: 'lock', at: Date.now() }] }))
  await settle()
  assert.ok(tabButtons(main).every(node => !node.disabled))
  assert.ok(buttons(main).filter(node => node.textContent === 'Add').every(node => node.disabled))
})

test('a proposal from Claude can be approved or rejected from the app, by its id, and an ended session offers neither', async () => {
  const data = overview(FILE)
  data.snaps.s1.proposals = [{ id: 'pr-abc123', change: 'add_constraint', text: 'keep logs', reason: 'audit' }]
  const { main, sent } = load(data)
  await settle()
  const texts = [...main.walk()].map(node => node.textContent)
  assert.ok(texts.some(text => text.includes('keep logs')))
  assert.ok(texts.includes(strings('en').ui.proposalNote))
  await buttons(main).find(node => node.textContent === 'Approve').listeners.click()
  assert.deepEqual(plain(sent.at(-1)), [{ op: 'proposal_decide', id: 'pr-abc123', accept: true }])
  await buttons(main).find(node => node.textContent === 'Reject').listeners.click()
  assert.deepEqual(plain(sent.at(-1)), [{ op: 'proposal_decide', id: 'pr-abc123', accept: false }])

  const ended = load({ ...data, rows: [{ id: 's1', name: 'p', alive: false, quiet: false }] })
  await settle()
  assert.ok(!buttons(ended.main).some(node => node.textContent === 'Approve' || node.textContent === 'Reject'))
})

test('the ribbon counts the verified done conditions', async () => {
  const data = overview(FILE)
  data.snaps.s1.task.doneConditions = [{ id: 'a', text: 't', link: null, status: 'verified' }, { id: 'b', text: 'u', link: null, status: 'pending' }]
  const { main } = load(data)
  await settle()
  assert.ok([...main.walk()].some(node => node.textContent === 'Done 1/2'))
})
