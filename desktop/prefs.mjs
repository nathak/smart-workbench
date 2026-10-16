// The app's own settings: one small JSON file, read whole and written whole.
import { readFileSync, renameSync, writeFileSync } from 'node:fs'

export const DEFAULTS = { autoJoin: true, livePrompts: false, notifyAsk: true, notifyQuiet: true, notifyEnd: false, mutedSessions: [] }

export function loadPrefs(file) {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    return { ...DEFAULTS, ...Object.fromEntries(Object.keys(DEFAULTS).filter(key => key in raw && typeof raw[key] === typeof DEFAULTS[key]).map(key => [key, raw[key]])) }
  } catch {
    return { ...DEFAULTS }
  }
}

export function savePrefs(file, prefs) {
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(prefs, null, 2), { mode: 0o600 })
  renameSync(tmp, file)
}
