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
  for (const one of items) ul.append(draw(one))
  box.append(ul)
  return box
}

function card(row, snap, L) {
  const s = el('section')
  s.append(el('h2', row.name || row.id))
  const state = row.quiet ? L.quiet : row.alive ? L.alive : L.ended
  if (!snap) {
    s.append(el('div', state, 'meta'), el('div', L.noSnapshot, 'empty'))
    return s
  }
  const t = snap.task
  s.append(el('div', `${state} · ${L.rev} ${snap.rev} · ${L.scope[snap.scope] ?? snap.scope} · ${L.status[t.status] ?? t.status}${t.locked ? ` · ${L.locked}` : ''}`, 'meta'))
  s.append(el('div', t.goal || L.noGoal, t.goal ? 'goal' : 'empty'))
  s.append(list(L.constraints, t.constraints, c => el('li', `${c.priority === 'hard' ? '' : `(${L.soft}) `}${c.text}${c.isActive ? '' : ` (${L.off})`}`)))
  s.append(list(L.done, t.doneConditions, d => el('li', `${L.cond[d.status] ?? d.status}: ${d.text}${d.link ? ` [${d.link}]` : ''}`, d.status)))
  s.append(list(L.nonGoals, t.nonGoals, n => el('li', n)))
  s.append(el('h3', L.team), el('div', `${snap.team.enabled ? L.on : L.off}${snap.team.codex ? ' · Codex' : ''}${snap.team.enabled ? ` · ${['lead', 'explorer', 'advisor'].map(r => `${r}=${snap.team.roles[r] ?? '-'}`).join(' ')}` : ''}`))
  s.append(el('h3', L.guard), el('div', `${snap.guard.profile}${snap.guard.paused ? ` · ${L.paused}` : ''}${snap.guard.fileProfile ? ` · ${L.fileProfile} ${snap.guard.fileProfile}` : ''} · ${L.rules} ${snap.guard.rules}`))
  s.append(list(L.evidence, snap.evidence, e => el('li', `${e.kind}: ${e.ok === true ? L.pass : e.ok === false ? L.fail : L.running}`, e.ok === true ? 'verified' : e.ok === false ? 'failed' : 'pending')))
  s.append(list(L.proposals, snap.proposals, p => el('li', `${p.change}${p.text ? `: ${p.text}` : ''} — ${p.reason}`)))
  return s
}

async function refresh() {
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
      main.append(card(row, Object.hasOwn(data.snaps, row.id) ? data.snaps[row.id] : undefined, L))
    } catch {
      main.append(el('div', row.name || row.id, 'empty'))
    }
  }
}

void refresh()
setInterval(() => void refresh(), 2000)
