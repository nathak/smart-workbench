// Draws the overview main sends. Every string from a snapshot goes in through textContent, never as markup.
const el = (tag, text, cls) => {
  const node = document.createElement(tag)
  if (text !== undefined) node.textContent = String(text)
  if (cls) node.className = cls
  return node
}
const list = (title, items, draw) => {
  const box = document.createDocumentFragment()
  if (!items.length) return box
  box.append(el('h3', title))
  const ul = el('ul')
  items.forEach((one, i) => ul.append(draw(one, i)))
  box.append(ul)
  return box
}

const send = async (session, ops, L, note) => {
  let result
  try {
    result = await window.swb.send(session, ops)
  } catch {
    result = { ok: false, reason: 'error' }
  }
  note.textContent = result.ok ? '' : `${L.sendFailed}: ${result.reason ?? ''}`
  if (result.ok) void refresh(true)

  return result.ok === true
}
const button = (text, onClick, disabled) => {
  const b = el('button', text)
  b.type = 'button'
  b.disabled = disabled === true
  b.addEventListener('click', onClick)
  return b
}
// Drafts survive the redraw; a field is cleared only once its text was sent.
const drafts = new Map()

// A text field with its button: Enter sends too (not while an IME is still composing).
const adder = (key, hint, label, onSend, disabled, max = 1000) => {
  const row = el('div', undefined, 'adder')
  const input = el('input')
  input.type = 'text'
  input.placeholder = hint
  input.maxLength = max
  input.disabled = disabled === true
  input.value = drafts.get(key) ?? ''
  input.addEventListener('input', () => drafts.set(key, input.value))
  const go = async () => {
    const text = input.value.trim()
    if (text && (await onSend(text))) {
      input.value = ''
      drafts.delete(key)
    }
  }
  input.addEventListener('keydown', e => e.key === 'Enter' && !e.isComposing && e.keyCode !== 229 && go())
  row.append(input, button(label, go, disabled))
  return row
}

// The shared guard file (.claude/smartworkbench.json). Every edit quotes the hash of the file this view was made from, so a file
// that changed since is refused. Only ask and block rules can be added; the plugin asks in the session before a rule is removed.
const RULE_KEYS = ['tool', 'command', 'path']

function ruleForm(session, L, op, base, disabled) {
  const box = el('div', undefined, 'adder')
  const policy = el('select')
  for (const name of ['ask', 'block']) {
    const option = el('option', name)
    option.value = name
    policy.append(option)
  }
  policy.disabled = disabled
  box.append(policy)
  const inputs = {}
  for (const key of [...RULE_KEYS, 'reason']) {
    const input = el('input')
    input.type = 'text'
    input.placeholder = L.ruleHints[key]
    input.maxLength = key === 'reason' ? 200 : 300
    input.disabled = disabled
    const draft = `${session}:rule:${key}`
    input.value = drafts.get(draft) ?? ''
    input.addEventListener('input', () => drafts.set(draft, input.value))
    inputs[key] = input
    box.append(input)
  }
  const go = async () => {
    const rule = { policy: policy.value }
    for (const key of [...RULE_KEYS, 'reason']) if (inputs[key].value.trim()) rule[key] = inputs[key].value.trim()
    if (!RULE_KEYS.some(key => rule[key])) return
    if (await op([{ op: 'policy_add_rule', base, rule }])) for (const key of Object.keys(inputs)) (inputs[key].value = ''), drafts.delete(`${session}:rule:${key}`)
  }
  box.append(button(L.addRule, go, disabled))
  return box
}

function guardFile(row, file, L, op, busy) {
  const box = el('div')
  box.append(el('h3', L.guardFile), el('div', `${file.profile ? `${L.fileProfile} ${file.profile}` : L.noFileProfile}${file.errors ? ` · ⚠ ${file.errors}` : ''}`))
  if (!row.alive) return box
  const off = busy || !file.editable || !file.hash
  const bar = el('div', undefined, 'bar')
  const rank = name => ['permissive', 'balanced', 'strict'].indexOf(name)
  for (const profile of ['permissive', 'balanced', 'strict']) bar.append(button(rank(profile) < rank(file.profile) ? `${profile} (${L.asksInSession})` : profile, () => op([{ op: 'policy_set_profile', base: file.hash, profile }]), off || file.profile === profile))
  if (file.profile) bar.append(button(`${L.clearProfile} (${L.asksInSession})`, () => op([{ op: 'policy_set_profile', base: file.hash, profile: null }]), off))
  box.append(bar)
  box.append(list(L.fileRules, file.rules, rule => {
    const text = RULE_KEYS.filter(key => rule[key]).map(key => `${key}=${rule[key]}`).join(' ')
    const li = el('li', `${rule.policy.toUpperCase()} ${text}${rule.reason ? ` — ${rule.reason}` : ''} `, rule.policy === 'block' ? 'failed' : undefined)
    li.append(button(rule.policy === 'allow' ? L.remove : `${L.remove} (${L.asksInSession})`, () => op([{ op: 'policy_remove_rule', base: file.hash, index: rule.i, policy: rule.policy }]), off))
    return li
  }))
  box.append(ruleForm(row.id, L, op, file.hash, off), el('div', L.policyNote, 'empty'))
  return box
}

// No guard file yet: a first rule creates it.
function guardFileNew(session, L, op, busy) {
  const box = el('div')
  box.append(el('h3', L.guardFile), el('div', L.noFile, 'empty'), ruleForm(session, L, op, null, busy))
  return box
}

const EFFORTS = ['', 'default', 'low', 'medium', 'high', 'xhigh', 'max']

// One team role: its model (free text) and effort, applied together.
function roleRow(session, role, snap, L, op, disabled) {
  const row = el('div', undefined, 'adder')
  row.append(el('span', `${role}: ${snap.team.roles[role] ?? '-'} (${snap.team.efforts?.[role] ?? '-'})`, 'rolename'))
  const model = el('input')
  model.type = 'text'
  model.placeholder = L.modelHint
  model.maxLength = 64
  model.disabled = disabled
  const key = `${session}:role:${role}`
  model.value = drafts.get(key) ?? ''
  model.addEventListener('input', () => drafts.set(key, model.value))
  const effort = el('select')
  for (const name of EFFORTS) {
    const option = el('option', name === '' ? L.effortHint : name)
    option.value = name
    effort.append(option)
  }
  effort.disabled = disabled
  effort.value = drafts.get(`${key}:effort`) ?? ''
  effort.addEventListener('change', () => drafts.set(`${key}:effort`, effort.value))
  const go = async () => {
    const m = model.value.trim()
    if (!m && !effort.value) return
    const ok = await op([{ op: 'team_role', role, ...(m ? { model: m } : {}), ...(effort.value ? { effort: effort.value } : {}) }])
    if (ok) {
      model.value = ''
      effort.value = ''
      drafts.delete(key)
      drafts.delete(`${key}:effort`)
    }
  }
  row.append(model, effort, button(L.set, go, disabled))
  return row
}

const TABS = ['intent', 'evidence', 'team', 'guard']
// The tab each session shows; a redraw only reads it back, so a click needs no redraw (focus and half-typed text stay).
const tabs = new Map()

function tabBar(id, index, L, panels) {
  const bar = el('div', undefined, 'tabs')
  bar.setAttribute('role', 'tablist')
  bar.setAttribute('aria-label', L.tabsLabel)
  const buttons = {}
  const show = name => {
    tabs.set(id, name)
    for (const tab of TABS) {
      panels[tab].hidden = tab !== name
      buttons[tab].setAttribute('aria-selected', String(tab === name))
    }
  }
  for (const tab of TABS) {
    const b = button(L.tabs[tab], () => show(tab))
    b.className = 'tab'
    b.setAttribute('role', 'tab')
    b.setAttribute('aria-controls', `p-${index}-${tab}`)
    panels[tab].id = `p-${index}-${tab}`
    panels[tab].setAttribute('role', 'tabpanel')
    buttons[tab] = b
    bar.append(b)
  }
  show(TABS.includes(tabs.get(id)) ? tabs.get(id) : 'intent')

  return bar
}

// One line of what matters at a glance: state, goal, done conditions met, guard profile.
function ribbon(row, snap, L) {
  const t = snap.task
  const met = t.doneConditions.filter(d => d.status === 'verified').length
  const state = row.quiet ? 'quiet' : row.alive ? 'alive' : 'ended'
  const box = el('div', undefined, 'ribbon')
  box.append(
    el('span', state === 'alive' ? '●' : state === 'quiet' ? '◐' : '◌', `dot ${state}`),
    el('span', t.goal || L.noGoal, 'r-goal'),
    el('span', `${L.ribbonDone} ${met}/${t.doneConditions.length}`, 'r-done'),
    el('span', `${L.guard} ${snap.guard.profile ? String(snap.guard.profile).toUpperCase() : '-'}${snap.guard.paused ? ` · ${L.paused}` : ''}`, snap.guard.paused ? 'r-guard warn' : 'r-guard'),
  )

  return box
}

// The guard questions this session is waiting on. The buttons answer once (Allow once or Block); a question the session will not take from outside says why.
function askBox(row, snap, L, op) {
  const open = (snap.asks ?? []).filter(a => a && typeof a.id === 'string')
  if (!row.alive || open.length === 0) return undefined
  const box = el('div', undefined, 'asks')
  for (const a of open) {
    const item = el('div', undefined, 'ask')
    item.append(el('div', `${L.askTitle}: ${a.tool} — ${a.reason}`, 'ask-t'), el('div', String(a.summary ?? ''), 'ask-s'))
    if (a.remote === true && Number(a.remoteUntil) > Date.now()) {
      // One answer per question: both buttons rest once one is pressed.
      const pair = []
      const answer = allow => () => {
        for (const one of pair) one.disabled = true
        op([{ op: 'ask_answer', id: a.id, allow, by: 'app' }])
      }
      pair.push(button(L.askAllow, answer(true), false), button(L.askBlock, answer(false), false))
      item.append(...pair)
    } else {
      const why = a.remote === true ? 'expired' : String(a.remote)
      item.append(el('div', `${L.askTerminal}${L.askWhy[why] ? ` (${L.askWhy[why]})` : ''}`, 'empty'))
    }
    box.append(item)
  }

  return box
}

function card(row, snap, L, acks, index = 0) {
  const s = el('section')
  s.append(el('h2', row.name || row.id))
  const state = row.quiet ? L.quiet : row.alive ? L.alive : L.ended
  if (!snap) {
    s.append(el('div', state, 'meta'), el('div', L.noSnapshot, 'empty'))
    return s
  }
  const t = snap.task
  const note = el('div', undefined, 'note')
  const editable = row.alive && !t.locked
  const pending = (acks ?? []).filter(a => a.session === row.id && !a.ack && Date.now() - a.at < 10 * 60 * 1000)
  // While an earlier change waits for its answer the buttons rest: a second click on a stale view would act on it twice.
  const busy = pending.length > 0
  const op = ops => send(row.id, ops, L, note)
  const panels = Object.fromEntries(TABS.map(tab => [tab, el('div', undefined, 'panel')]))
  const intent = panels.intent
  const evidence = panels.evidence
  const team = panels.team
  const guard = panels.guard

  s.append(ribbon(row, snap, L))
  const waiting = askBox(row, snap, L, op)
  if (waiting) s.append(waiting)
  s.append(el('div', `${state} · ${L.rev} ${snap.rev} · ${L.scope[snap.scope] ?? snap.scope} · ${L.status[t.status] ?? t.status}${t.locked ? ` · ${L.locked}` : ''}`, 'meta'))
  if (row.alive) {
    s.append(button(t.locked ? L.unlock : L.lock, () => op([{ op: t.locked ? 'unlock' : 'lock' }]), busy))
    if (t.locked) s.append(el('div', L.lockedNote, 'empty'))
  }
  s.append(tabBar(row.id, index, L, panels), ...TABS.map(tab => panels[tab]))

  intent.append(el('div', t.goal || L.noGoal, t.goal ? 'goal' : 'empty'))
  if (row.alive) intent.append(adder(`${row.id}:goal`, L.goalHint, L.set, text => op([{ op: 'set_goal', text }]), !editable || busy, 500))
  const small = (text, ops) => button(text, () => op(ops), !editable || busy)
  intent.append(list(L.constraints, t.constraints, c => {
    const li = el('li', `${c.priority === 'hard' ? '' : `(${L.soft}) `}${c.text}${c.isActive ? '' : ` (${L.off})`} `)
    if (row.alive) li.append(small(c.isActive ? L.off : L.on, [{ op: 'set_active', id: c.id, isActive: !c.isActive }]), small(c.priority === 'hard' ? L.soft : L.hard, [{ op: 'set_priority', id: c.id, priority: c.priority === 'hard' ? 'soft' : 'hard' }]), small(L.remove, [{ op: 'remove_constraint', id: c.id, text: c.text }]))
    return li
  }))
  if (row.alive) intent.append(adder(`${row.id}:c`, L.constraintHint, L.add, text => op([{ op: 'add_constraint', text }]), !editable || busy))
  intent.append(list(L.done, t.doneConditions, d => {
    const li = el('li', `${L.cond[d.status] ?? d.status}: ${d.text}${d.link ? ` [${d.link}]` : ''} `, d.status)
    if (row.alive) li.append(small(L.remove, [{ op: 'remove_done_condition', id: d.id, text: d.text }]))
    return li
  }))
  if (row.alive) intent.append(adder(`${row.id}:d`, L.doneHint, L.add, text => op([{ op: 'add_done_condition', text }]), !editable || busy))
  intent.append(list(L.nonGoals, t.nonGoals, (n, i) => {
    const li = el('li', `${n} `)
    if (row.alive) li.append(small(L.remove, [{ op: 'remove_non_goal', index: i, text: n }]))
    return li
  }))
  if (row.alive) intent.append(adder(`${row.id}:n`, L.nonGoalHint, L.add, text => op([{ op: 'add_non_goal', text }]), !editable || busy))
  // A decision goes to the session like any other change; on a locked contract the session asks the person to confirm an approval.
  intent.append(list(L.proposals, snap.proposals, p => {
    const li = el('li', `${p.change}${p.text ? `: ${p.text}` : ''} — ${p.reason} `)
    if (row.alive) li.append(button(L.approve, () => op([{ op: 'proposal_decide', id: p.id, accept: true }]), busy), button(L.rejectProposal, () => op([{ op: 'proposal_decide', id: p.id, accept: false }]), busy))
    return li
  }))
  if (snap.proposals.length) intent.append(el('div', L.proposalNote, 'empty'))

  evidence.append(list(L.done, t.doneConditions, d => el('li', `${L.cond[d.status] ?? d.status}: ${d.text}${d.link ? ` [${d.link}]` : ''}`, d.status)))
  evidence.append(list(L.evidence, snap.evidence, e => el('li', `${e.kind}: ${e.ok === true ? L.pass : e.ok === false ? L.fail : L.running}`, e.ok === true ? 'verified' : e.ok === false ? 'failed' : 'pending')))

  team.append(el('h3', L.team), el('div', `${snap.team.enabled ? L.on : L.off}${snap.team.codex ? ` · Codex (${snap.team.codexReview ? 'review' : '-'}${snap.team.codexRescue ? ', rescue' : ''})` : ''}`))
  if (row.alive) {
    const bar = el('div', undefined, 'bar')
    bar.append(button(snap.team.enabled ? L.teamOff : L.teamOn, () => op([{ op: 'team_enabled', enabled: !snap.team.enabled }]), busy))
    bar.append(button(snap.team.codex ? L.codexOff : L.codexOn, () => op([{ op: 'codex', enabled: !snap.team.codex }]), busy || (!snap.team.codex && snap.codexFound === false)))
    team.append(bar)
    for (const role of ['lead', 'explorer', 'advisor']) team.append(roleRow(row.id, role, snap, L, op, busy))
  } else team.append(el('div', ['lead', 'explorer', 'advisor'].map(r => `${r}=${snap.team.roles[r] ?? '-'}`).join(' ')))

  guard.append(el('h3', L.guard), el('div', `${snap.guard.profile}${snap.guard.paused ? ` · ${L.paused}` : ''}${snap.guard.fileProfile ? ` · ${L.fileProfile} ${snap.guard.fileProfile}` : ''} · ${L.rules} ${snap.guard.rules}`))
  if (row.alive) {
    const bar = el('div', undefined, 'bar')
    for (const profile of ['off', 'permissive', 'balanced', 'strict']) bar.append(button(profile, () => op([{ op: 'set_profile', profile }]), busy || snap.guard.profile === profile))
    bar.append(button(snap.guard.paused ? L.resume : L.pause, () => op([{ op: 'pause', on: !snap.guard.paused }]), busy))
    guard.append(bar, el('div', L.guardNote, 'empty'))
  }
  if (snap.guard.file) guard.append(guardFile(row, snap.guard.file, L, op, busy))
  else if (row.alive) guard.append(guardFileNew(row.id, L, op, busy))

  // The answers to what was sent stay in view whichever tab the change came from.
  const foot = el('div', undefined, 'foot')
  foot.append(note)
  const mine = (acks ?? []).filter(a => a.session === row.id).slice(-5)
  if (mine.length) foot.append(list(L.sentTitle, mine, a => el('li', `${a.label} — ${a.ack ? (L[a.ack.status] ?? a.ack.status) + (a.ack.reason ? ` (${L.reasons[a.ack.reason] ?? a.ack.reason})` : '') : Date.now() - a.at > 10 * 60 * 1000 ? L.noAnswer : L.waiting}`)))
  s.append(foot)

  return s
}

async function refresh(force) {
  // Typing in a field must not be wiped by the next redraw.
  const active = document.activeElement
  if (!force && active && ((active.tagName === 'INPUT' && active.value !== '') || active.tagName === 'SELECT')) return
  let data
  try {
    data = await window.swb.overview()
  } catch {
    return
  }
  const L = data.text
  document.documentElement.lang = data.lang
  document.getElementById('title').textContent = L.title
  document.getElementById('hub').textContent = data.hubUp ? L.hubUp : L.hubDown
  const main = document.getElementById('list')
  main.replaceChildren()
  if (!data.rows.length) main.append(el('div', L.none, 'empty'))
  for (const [index, row] of data.rows.entries()) {
    try {
      main.append(card(row, Object.hasOwn(data.snaps, row.id) ? data.snaps[row.id] : undefined, L, data.acks, index))
    } catch {
      main.append(el('div', row.name || row.id, 'empty'))
    }
  }
}

void refresh()
setInterval(() => void refresh(), 2000)
