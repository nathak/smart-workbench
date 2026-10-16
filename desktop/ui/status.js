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

function card(row, snap, L, acks) {
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
  s.append(el('div', `${state} · ${L.rev} ${snap.rev} · ${L.scope[snap.scope] ?? snap.scope} · ${L.status[t.status] ?? t.status}${t.locked ? ` · ${L.locked}` : ''}`, 'meta'))
  if (row.alive) {
    s.append(button(t.locked ? L.unlock : L.lock, () => op([{ op: t.locked ? 'unlock' : 'lock' }]), busy))
    if (t.locked) s.append(el('div', L.lockedNote, 'empty'))
  }
  s.append(el('div', t.goal || L.noGoal, t.goal ? 'goal' : 'empty'))
  if (row.alive) s.append(adder(`${row.id}:goal`, L.goalHint, L.set, text => op([{ op: 'set_goal', text }]), !editable || busy, 500))
  const small = (text, ops) => button(text, () => op(ops), !editable || busy)
  s.append(list(L.constraints, t.constraints, c => {
    const li = el('li', `${c.priority === 'hard' ? '' : `(${L.soft}) `}${c.text}${c.isActive ? '' : ` (${L.off})`} `)
    if (row.alive) li.append(small(c.isActive ? L.off : L.on, [{ op: 'set_active', id: c.id, isActive: !c.isActive }]), small(c.priority === 'hard' ? L.soft : L.hard, [{ op: 'set_priority', id: c.id, priority: c.priority === 'hard' ? 'soft' : 'hard' }]), small(L.remove, [{ op: 'remove_constraint', id: c.id, text: c.text }]))
    return li
  }))
  if (row.alive) s.append(adder(`${row.id}:c`, L.constraintHint, L.add, text => op([{ op: 'add_constraint', text }]), !editable || busy))
  s.append(list(L.done, t.doneConditions, d => {
    const li = el('li', `${L.cond[d.status] ?? d.status}: ${d.text}${d.link ? ` [${d.link}]` : ''} `, d.status)
    if (row.alive) li.append(small(L.remove, [{ op: 'remove_done_condition', id: d.id, text: d.text }]))
    return li
  }))
  if (row.alive) s.append(adder(`${row.id}:d`, L.doneHint, L.add, text => op([{ op: 'add_done_condition', text }]), !editable || busy))
  s.append(list(L.nonGoals, t.nonGoals, (n, i) => {
    const li = el('li', `${n} `)
    if (row.alive) li.append(small(L.remove, [{ op: 'remove_non_goal', index: i, text: n }]))
    return li
  }))
  if (row.alive) s.append(adder(`${row.id}:n`, L.nonGoalHint, L.add, text => op([{ op: 'add_non_goal', text }]), !editable || busy))
  s.append(note)
  const mine = (acks ?? []).filter(a => a.session === row.id).slice(-5)
  if (mine.length) s.append(list(L.sentTitle, mine, a => el('li', `${a.label} — ${a.ack ? (L[a.ack.status] ?? a.ack.status) + (a.ack.reason ? ` (${L.reasons[a.ack.reason] ?? a.ack.reason})` : '') : Date.now() - a.at > 10 * 60 * 1000 ? L.noAnswer : L.waiting}`)))
  s.append(el('h3', L.team), el('div', `${snap.team.enabled ? L.on : L.off}${snap.team.codex ? ' · Codex' : ''}${snap.team.enabled ? ` · ${['lead', 'explorer', 'advisor'].map(r => `${r}=${snap.team.roles[r] ?? '-'}`).join(' ')}` : ''}`))
  s.append(el('h3', L.guard), el('div', `${snap.guard.profile}${snap.guard.paused ? ` · ${L.paused}` : ''}${snap.guard.fileProfile ? ` · ${L.fileProfile} ${snap.guard.fileProfile}` : ''} · ${L.rules} ${snap.guard.rules}`))
  s.append(list(L.evidence, snap.evidence, e => el('li', `${e.kind}: ${e.ok === true ? L.pass : e.ok === false ? L.fail : L.running}`, e.ok === true ? 'verified' : e.ok === false ? 'failed' : 'pending')))
  s.append(list(L.proposals, snap.proposals, p => el('li', `${p.change}${p.text ? `: ${p.text}` : ''} — ${p.reason}`)))
  return s
}

async function refresh(force) {
  // Typing in a field must not be wiped by the next redraw.
  const active = document.activeElement
  if (!force && active && active.tagName === 'INPUT' && active.value !== '') return
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
  for (const row of data.rows) {
    try {
      main.append(card(row, Object.hasOwn(data.snaps, row.id) ? data.snaps[row.id] : undefined, L, data.acks))
    } catch {
      main.append(el('div', row.name || row.id, 'empty'))
    }
  }
}

void refresh()
setInterval(() => void refresh(), 2000)
