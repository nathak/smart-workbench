// Loop: repeat a task a set number of times or until stopped. Pure decisions only;
// register.tsx starts it from /swb loop and applies these at classic.Stop, the same
// place team mode's final check holds a turn, so the two work together.
import type { LoopState } from '../types'

// A mistyped count cannot run for days; "inf" is the only way to ask for no limit.
export const MAX_COUNT = 1000
const MAX_ITEMS = 20
// An infinite loop ends when this many passes in a row changed no file; a counted loop always runs its count.
export const IDLE_LIMIT = 3

const INFINITE = new Set(['inf', 'infinite', 'forever', '∞', '무한'])

export type LoopCommand =
  | { kind: 'start'; limit: number | null; items: string[] }
  | { kind: 'stop' }
  | { kind: 'status' }
  | { kind: 'error'; text: string }

export const USAGE =
  '/swb loop <count|inf> <item>[; <item>...]  ·  /swb loop stop  ·  /swb loop status'

// args is what follows "loop": "5 fix the lint errors; run the tests", "inf watch the queue", "stop".
export function parse(args: string): LoopCommand {
  const text = args.trim()
  const [first = '', ...rest] = text.split(/\s+/)
  const word = first.toLowerCase()

  if (word === 'stop' || word === 'off') return { kind: 'stop' }
  if (word === '' || word === 'status') return { kind: 'status' }

  const body = text.slice(first.length).trim()
  const isInfinite = INFINITE.has(word)
  const count = /^\d+$/.test(word) ? Number(word) : NaN

  if (!isInfinite && !Number.isInteger(count)) {
    return { kind: 'error', text: `The first word is how many times: a number or "inf". ${USAGE}` }
  }
  if (!isInfinite && (count < 1 || count > MAX_COUNT)) {
    return { kind: 'error', text: `Count must be 1 to ${MAX_COUNT}; use "inf" to run until stopped.` }
  }

  // "\;" keeps a semicolon inside an item.
  const items = body.split(/\s*(?<!\\);\s*/).map(one => one.replaceAll('\\;', ';').trim()).filter(Boolean)
  if (items.length === 0 || rest.length === 0) return { kind: 'error', text: `Say what to do each time. ${USAGE}` }
  if (items.length > MAX_ITEMS) return { kind: 'error', text: `At most ${MAX_ITEMS} items.` }

  return { kind: 'start', limit: isInfinite ? null : count, items }
}

export function begin(items: string[], limit: number | null, at: number): LoopState {
  return { items, limit, done: 0, startedAt: at, passAt: at, idle: 0, pending: true }
}

function label(loop: LoopState, n: number): string {
  return loop.limit === null ? `${n}` : `${n}/${loop.limit}`
}

// The task as Claude reads it on every pass.
export function iterationPrompt(loop: LoopState): string {
  const n = loop.done + 1
  const list = loop.items.length === 1 ? loop.items[0] : loop.items.map((one, i) => `${i + 1}. ${one}`).join('\n')
  const ends =
    loop.limit === null
      ? `It repeats until the person runs /swb loop stop, or until ${IDLE_LIMIT} passes in a row change no file (an edit tool, or in a git repository any change to the working tree).`
      : `${loop.limit} passes in all.`

  return [
    `SmartWorkbench loop, pass ${label(loop, n)}. ${ends}`,
    loop.items.length === 1 ? `Do this:\n${list}` : `Do all of these, in order:\n${list}`,
    'Finish the pass with a one-line result. If there is nothing left to do, say so; do not invent work.',
  ].join('\n')
}

export type Step = { loop: LoopState | undefined; reason?: string; text?: string }

// A turn ended with a loop running: count the pass and either hold the turn for the next one or end the loop.
// edited = the pass changed a file; an infinite loop that changes nothing IDLE_LIMIT times in a row ends.
// A short fingerprint of text (FNV-1a), for comparing two states of the working tree.
export function treeHash(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }

  return `${text.length}:${hash.toString(16)}`
}

// hash: the working tree after this pass, kept for the next comparison.
export function advance(loop: LoopState, edited: boolean, now: number, hash?: string): Step {
  const idle = edited ? 0 : (loop.idle ?? 0) + 1
  const next: LoopState = { ...loop, done: loop.done + 1, idle, passAt: now, continuing: true, pending: false, ...(hash !== undefined ? { treeHash: hash } : {}) }

  if (loop.limit !== null && next.done >= loop.limit) {
    return { loop: undefined, text: `Loop finished: ${next.done} of ${loop.limit} passes done.` }
  }
  if (loop.limit === null && idle >= IDLE_LIMIT) {
    return { loop: undefined, text: `Loop stopped after ${next.done} passes: the last ${IDLE_LIMIT} changed no file (no edit-tool edit and, in a git repository, no change to the working tree).` }
  }

  return { loop: next, reason: iterationPrompt(next) }
}

export function describe(loop: LoopState | undefined): string {
  if (!loop) return 'No loop is running. ' + USAGE

  const what = loop.items.length === 1 ? loop.items[0] : `${loop.items.length} items`
  const where = loop.limit === null ? `${loop.done} passes done, no limit` : `${loop.done} of ${loop.limit} passes done`

  return `${loop.pending ? 'Loop set, pass 1 not started' : 'Loop running'}: ${where}. ${what}\n/swb loop stop to end it.`
}
