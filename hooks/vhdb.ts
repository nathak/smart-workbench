// The vhdb plugin's upload to a team server, turned on and off from /swb vhdb. Pure parts only: the status the plugin prints, the
// question the person answers, and the paths. Nothing here reads a file or runs a process.

export const VHDB_FROM_NOW = 'Turn on from now only'
export const VHDB_WITH_PAST = 'Turn on with past history'
export const VHDB_CANCEL = 'Cancel'

export type VhdbStatus = {
  upload: boolean
  configured: boolean
  ready: boolean
  approved: boolean
  reason: string
  url: string
  project: string
  // Whether the decision ledger goes along. Anything but an explicit false counts as going: an unclear answer shows the wider reach.
  ledger: boolean
  tokenSource: string
  lastSentAt: string
  sent: number
  error?: { status: string; text: string; at: string }
  backoffUntil: string
  // Where the plugin looks for the approval, when it says so: the one place that cannot disagree with the plugin.
  approvalPath?: string
  // Where the upload goes, from the raw values (not the shortened, masked ones that are shown): the second look compares this.
  target: string
}

// Text from the plugin is shown to a person in a question: control characters are blanked so it cannot lay out a line of its own, and the length is capped.
export function shown(text: unknown, max = 200): string {
  const plain = typeof text === 'string' ? text : typeof text === 'number' || typeof text === 'boolean' ? String(text) : ''

  return plain.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, max)
}

// scheme://user:pass@host -> scheme://***@host
export function maskUrl(url: string): string {
  return url.replace(/(\b[a-z][\w+.-]{0,31}:\/\/)[^\s/@]+@/gi, '$1***@')
}

function parseObject(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text)

    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

// `remote show --json` prints one JSON line. Noise before it is tolerated (the last non-empty line is tried when the whole output is not JSON).
export function parseStatus(stdout: string): VhdbStatus | undefined {
  const whole = stdout.trim()
  const lines = whole.split('\n').filter(one => one.trim() !== '')
  const raw = parseObject(whole) ?? parseObject(lines[lines.length - 1] ?? '')
  if (!raw) return undefined

  const error = raw.error
  const errorObject = typeof error === 'object' && error !== null && !Array.isArray(error) ? (error as Record<string, unknown>) : undefined
  const path = typeof raw.approvalPath === 'string' ? raw.approvalPath : ''

  return {
    upload: raw.upload === true,
    configured: raw.configured === true,
    ready: raw.ready === true,
    approved: raw.approved === true,
    reason: shown(raw.reason),
    url: maskUrl(shown(raw.url)),
    project: shown(raw.project),
    ledger: raw.ledger !== false,
    tokenSource: shown(raw.tokenSource, 60),
    lastSentAt: shown(raw.lastSentAt, 40),
    sent: typeof raw.sent === 'number' && Number.isFinite(raw.sent) ? raw.sent : 0,
    ...(errorObject ? { error: { status: shown(errorObject.status, 20), text: shown(errorObject.text), at: shown(errorObject.at, 40) } } : {}),
    backoffUntil: shown(raw.backoffUntil, 40),
    target: JSON.stringify([raw.url, raw.project, raw.ledger !== false, raw.tokenSource]),
    ...(/^(?:[A-Za-z]:)?[\\/]/.test(path) && /[\\/]state[\\/]ui-approval$/.test(path) && !/[\x00-\x1f]/.test(path) ? { approvalPath: path } : {}),
  }
}

// The vhdb script of the installed vhdb plugin, from Claude Code's installed_plugins.json.
export function installPathFrom(installed: string): string | undefined {
  try {
    const plugins = (JSON.parse(installed) as { plugins?: Record<string, Array<{ installPath?: unknown }>> }).plugins ?? {}
    for (const [name, entries] of Object.entries(plugins)) {
      const path = name.startsWith('vhdb@') ? entries[0]?.installPath : undefined
      if (typeof path === 'string' && path.startsWith('/')) return `${path}/bin/vhdb.mjs`
    }
  } catch {
    // A missing or damaged file means vhdb is unknown, not an error.
  }

  return undefined
}

// <git common dir>/vhdb/state/ui-approval, or under VHDB_DIR when that is set.
export function approvalPathOf(commonDir: string | undefined, envDir: string): string | undefined {
  const env = envDir.trim().replace(/[\\/]+$/, '')
  if (env !== '') return `${env}/state/ui-approval`

  return commonDir ? `${commonDir.replace(/[\\/]+$/, '')}/vhdb/state/ui-approval` : undefined
}

// Whether two readings of the status name the same place to send to.
export function sameTarget(before: VhdbStatus, after: VhdbStatus): boolean {
  return after.ready && before.target === after.target
}

export function statusLine(s: VhdbStatus): string {
  const where = s.url ? `${s.url}${s.project ? ` / ${s.project}` : ''}` : 'no server set'
  const state = s.upload ? (s.approved ? 'on' : 'on, waiting for approval') : 'off'
  const parts = [
    `vhdb upload ${state}`,
    where,
    // Nothing to say about the ledger until a server is set (vhdb shows null there).
    s.url ? (s.ledger ? 'decision ledger included' : 'decision ledger not included') : '',
    s.sent > 0 ? `${s.sent} sent${s.lastSentAt ? `, last ${s.lastSentAt}` : ''}` : '',
    s.error ? `last error ${s.error.status} ${s.error.text}`.trim() : '',
    s.backoffUntil ? `retrying after ${s.backoffUntil}` : '',
    !s.ready && s.reason ? `not ready: ${s.reason}` : '',
  ]

  return `${parts.filter(Boolean).join('; ')}.`
}

// What the person reads before saying yes: where it goes, what leaves, and what turning it off does not undo.
export function consentText(s: VhdbStatus): string {
  return [
    'Turn on the vhdb upload to your team server?',
    '',
    `Server: ${s.url || '(none)'}`,
    `Project: ${s.project || '(none)'}`,
    s.ledger
      ? 'The decision ledger is included: your prompts, Claude\'s replies, tool summaries, edits and commits leave this machine.'
      : 'The decision ledger is not included; the vhdb records are sent.',
    "History gathered so far is uploaded too (choose 'from now only' to leave it out).",
    'Turning it off only stops later sends; data already uploaded must be deleted by the server admin.',
  ].join('\n')
}
