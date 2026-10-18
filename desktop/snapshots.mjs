// Reads the read-only snapshots the plugin writes into <home>/state/<sessionId>.json. Nothing in them is trusted:
// a file must be a plain file of ours, small, recent and shaped like a snapshot, and the renderer shows it with textContent only.
import { lstatSync, readFileSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

const MAX_BYTES = 64 * 1024
const MAX_AGE_MS = 24 * 3600 * 1000
const NAME = /^([A-Za-z0-9_-]{1,64})\.json$/

const list = value => (Array.isArray(value) ? value : [])
const obj = value => (typeof value === 'object' && value !== null ? value : {})

/** Gives a snapshot of any shape the arrays and objects the window reads, so one odd file cannot break the whole window. */
function shaped(snap) {
  const task = obj(snap.task)
  const team = obj(snap.team)
  return {
    ...snap,
    task: { ...task, constraints: list(task.constraints), nonGoals: list(task.nonGoals), doneConditions: list(task.doneConditions) },
    team: { ...team, roles: obj(team.roles) },
    guard: obj(snap.guard),
    evidence: list(snap.evidence),
    proposals: list(snap.proposals),
    asks: list(snap.asks),
  }
}

/** Reads the snapshots of the sessions in `only` (all when absent) and removes the ones older than a day. */
export function readSnapshots(home, now = Date.now(), only) {
  const out = Object.create(null)
  const dir = join(home, 'state')
  let names = []
  try {
    const info = lstatSync(dir)
    if (!info.isDirectory() || (typeof process.getuid === 'function' && info.uid !== process.getuid())) return out
    names = readdirSync(dir)
  } catch {
    return out
  }
  for (const name of names) {
    const match = NAME.exec(name)
    if (!match) continue
    if (only && !only.has(match[1])) continue
    try {
      const file = join(dir, name)
      const info = lstatSync(file)
      if (!info.isFile()) continue
      if (now - info.mtimeMs > MAX_AGE_MS) {
        try {
          unlinkSync(file)
        } catch {
          // Another process may have removed it.
        }
        continue
      }
      if (info.size > MAX_BYTES) continue
      if (typeof process.getuid === 'function' && info.uid !== process.getuid()) continue
      const snap = JSON.parse(readFileSync(file, 'utf8'))
      if (snap?.v !== 1 || snap.session !== match[1] || typeof snap.task !== 'object' || snap.task === null) continue
      out[match[1]] = shaped(snap)
    } catch {
      // A file that cannot be read or parsed is skipped.
    }
  }
  return out
}
