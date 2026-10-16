// Decides which desktop notifications the hub's event stream calls for. Pure state, no Electron: the caller shows what it returns.
// A notice names the project folder and the tool, never a command or a prompt.
export const TOOL_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/
const ASK_SETTLE_MS = 2000
const QUIET_AFTER_MS = 60000
const PER_SESSION_GAP_MS = 30000
const GLOBAL_GAP_MS = 5000

export function makeNotices({ now = Date.now, enabled = () => ({ ask: true, quiet: true, end: true }) } = {}) {
  /** @type {Map<string, {project:string, pending:Map<string,{tool:string,at:number}>, quietAt:number, lastAt:number, muted:boolean, alive:boolean, quietSent:boolean}>} */
  const sessions = new Map()
  let lastGlobal = 0

  const own = id => {
    let one = sessions.get(id)
    if (!one) sessions.set(id, (one = { project: '', pending: new Map(), quietAt: 0, lastAt: 0, muted: false, alive: true, quietSent: false }))
    return one
  }

  /** The session list from the hub (`event: sessions`). Returns notices for sessions that ended. */
  function onSessions(rows) {
    const out = []
    const t = now()
    const seen = new Set()
    for (const row of rows) {
      seen.add(row.id)
      const fresh = !sessions.has(row.id)
      const one = own(row.id)
      // A row seen for the first time (the app just started) is already what it is: an old end is not news.
      if (fresh) one.alive = row.alive !== false
      one.project = typeof row.project === 'string' ? (row.project.split(/[\\/]/).filter(Boolean).pop() || '').replace(/[<>&]/g, '') : one.project
      if (row.quiet) {
        if (!one.quietAt) one.quietAt = t
      } else {
        one.quietAt = 0
        one.quietSent = false
      }
      if (one.alive && row.alive === false && !row.quiet) {
        one.alive = false
        out.push(...gate('end', row.id, { project: one.project }, t))
      }
      if (row.alive) one.alive = true
    }
    for (const id of [...sessions.keys()]) if (!seen.has(id)) sessions.delete(id)
    return out
  }

  /** One feed line (already parsed). Tracks tool.start without a following tool.end. */
  function onLine(id, event) {
    const one = own(id)
    one.lastAt = now()
    if (!event || typeof event !== 'object') return
    const key = typeof event.id === 'string' || typeof event.id === 'number' ? String(event.id) : undefined
    if (event.kind === 'tool.start' && key !== undefined && event.policy === 'ask') {
      // Asks replayed after a reconnect count only while they are recent.
      if (typeof event.at === 'number' && now() - event.at > 60000) return
      one.pending.set(key, { tool: typeof event.tool === 'string' && TOOL_PATTERN.test(event.tool) ? event.tool : 'tool', at: now() })
    } else if ((event.kind === 'tool.end' || event.kind === 'tool.denied') && key !== undefined) one.pending.delete(key)
  }

  /** Called on a timer. Returns the notices that came due. */
  function tick() {
    const out = []
    const t = now()
    for (const [id, one] of sessions) {
      for (const [key, ask] of one.pending) {
        if (t - ask.at < ASK_SETTLE_MS) continue
        // A notice held back by a throttle is tried again on the next tick, until the ask is answered or goes stale.
        if (t - ask.at > 60000) one.pending.delete(key)
        const got = gate('ask', id, { project: one.project, tool: ask.tool }, t)
        if (got.length) one.pending.delete(key)
        out.push(...got)
      }
      if (one.quietAt && !one.quietSent && t - one.quietAt >= QUIET_AFTER_MS) {
        one.quietSent = true
        out.push(...gate('quiet', id, { project: one.project }, t))
      }
    }
    return out
  }

  function gate(kind, id, data, t) {
    const one = own(id)
    if (one.muted || !enabled()[kind]) return []
    if (t - lastGlobal < GLOBAL_GAP_MS) return []
    if (kind !== 'end' && t - (one['sent_' + kind] ?? 0) < PER_SESSION_GAP_MS) return []
    one['sent_' + kind] = t
    lastGlobal = t
    return [{ kind, session: id, ...data }]
  }

  return { onSessions, onLine, tick, mute: (id, on = true) => void (own(id).muted = on), get size() { return sessions.size } }
}
