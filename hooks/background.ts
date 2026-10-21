// Background work: a call that returned at once with a task still running (a Bash run sent to the background, a background agent, a workflow,
// a monitor), and the notices that tell the session it ended. The live page pairs the two; what never ends is shown as having no end seen.

export type BgType = 'shell' | 'agent' | 'workflow' | 'monitor' | 'other'
export type BgStatus = 'completed' | 'failed' | 'killed' | 'other'

const ID = /^[\w-]{1,80}$/
const asId = (value: unknown): string | undefined => (typeof value === 'string' && ID.test(value) ? value : undefined)

// Whether a finished tool call left work running in the background, and the id its end will be reported under.
export function backgroundOf(tool: string, input: unknown, result: unknown, isOk: boolean): { btype: BgType; task?: string } | null {
  if (!isOk) return null
  const args = (input ?? {}) as Record<string, unknown>
  const out = (typeof result === 'object' && result !== null ? result : {}) as Record<string, unknown>
  if (tool === 'Bash') {
    const task = asId(out.backgroundTaskId)

    return task ? { btype: 'shell', task } : null
  }
  if (tool === 'Agent') {
    const task = asId(out.agentId)

    return args.run_in_background === true && task ? { btype: 'agent', task } : null
  }
  if (tool === 'Workflow') {
    // Without an id nothing could say when it ended, so it is not opened (it stays a started call).
    const task = asId(out.taskId ?? out.task_id ?? out.backgroundTaskId)

    return task ? { btype: 'workflow', task } : null
  }
  // Only the monitor tool among the rest: other tools put a task id in their result for other reasons (a to-do update, a stop request).
  const task = asId(out.backgroundTaskId ?? out.taskId ?? out.task_id)

  return task && /^Monitor$/.test(tool) ? { btype: 'monitor', task } : null
}

export type Notice = { task?: string; toolUseId?: string; status: BgStatus; summary?: string; ms?: number }

const MAX_BLOCKS = 20
const MAX_HEAD = 4000
const MAX_MS = 7 * 24 * 3600 * 1000
const STATUS = new Set<BgStatus>(['completed', 'failed', 'killed'])
// What a notice's status word says: a failure or a stop is not a neutral end.
function statusOf(word: string): BgStatus {
  const lower = word.toLowerCase()
  if (STATUS.has(lower as BgStatus)) return lower as BgStatus
  if (/^(?:complete|done|finished|ended|success|succeeded|ok)$/.test(lower)) return 'completed'
  if (/^(?:error|errored|timeout|timed[_ -]?out|failure)$/.test(lower)) return 'failed'
  if (/^(?:cancelled|canceled|stopped|aborted|terminated)$/.test(lower)) return 'killed'

  return 'other'
}
const tag = (body: string, name: string): string | undefined => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(body)?.[1]?.trim()

// The end of a block whose <result> starts at `result`: the closing tag that balances the opening one, counting the blocks the report quotes.
// It counts only if what comes right before it is the end of the notice's own parts (</result> or </usage>); a report that quotes a lone tag
// breaks the count, and then the first </result> followed by <usage> or the closing tag decides.
function closeOf(text: string, result: number, open: string, close: string): number {
  let depth = 1
  let at = result
  for (let tagAt = nextTag(text, at, open, close); tagAt; tagAt = nextTag(text, at, open, close)) {
    at = tagAt.at + tagAt.length
    depth += tagAt.isOpen ? 1 : -1
    if (depth === 0) return /(?:<\/result>|<\/usage>)\s*$/.test(text.slice(Math.max(0, tagAt.at - 40), tagAt.at)) ? tagAt.at : fallbackClose(text, result, close)
  }

  return fallbackClose(text, result, close)
}

function nextTag(text: string, from: number, open: string, close: string): { at: number; length: number; isOpen: boolean } | undefined {
  const a = text.indexOf(open, from)
  const b = text.indexOf(close, from)
  if (a < 0 && b < 0) return undefined
  if (b < 0 || (a >= 0 && a < b)) return { at: a, length: open.length, isOpen: true }

  return { at: b, length: close.length, isOpen: false }
}

function fallbackClose(text: string, result: number, close: string): number {
  const after = /<\/result>\s*(?:<usage>|<\/task-notification>|$)/.exec(text.slice(result))

  return text.indexOf(close, after ? result + after.index : result)
}

// The task notices a prompt carries: <task-notification> blocks with a task-id and/or a tool-use-id, a status and a summary.
// A background agent's notice carries its whole final report in <result>, which may quote other notices: only the head of a block (up to its
// <result> or its closing tag) is read, and the search goes on after the block's closing tag, so a quoted block closes nothing.
export function notificationsOf(text: string): Notice[] {
  const out: Notice[] = []
  const OPEN = '<task-notification>'
  const CLOSE = '</task-notification>'
  let from = 0
  while (out.length < MAX_BLOCKS) {
    const open = text.indexOf(OPEN, from)
    if (open < 0) break
    const bodyAt = open + OPEN.length
    let close = text.indexOf(CLOSE, bodyAt)
    const result = text.indexOf('<result>', bodyAt)
    // The report in <result> may quote notices of its own: the block goes on past its end tag, whatever it holds.
    if (result >= 0 && (close < 0 || result < close)) close = closeOf(text, result, OPEN, CLOSE)
    const end = close < 0 ? text.length : close
    const head = text.slice(bodyAt, Math.min(result >= 0 && result < end ? result : end, bodyAt + MAX_HEAD))
    from = close < 0 ? text.length : close + CLOSE.length
    const task = asId(tag(head, 'task-id'))
    const toolUseId = asId(tag(head, 'tool-use-id'))
    if (!task && !toolUseId) continue
    const word = tag(head, 'status') ?? ''
    // The duration is the notice's own, after the report: a number the report quotes is not it.
    const reportEnd = result >= 0 && result < end ? text.lastIndexOf('</result>', end) : -1
    const parts = text.slice(reportEnd > result ? reportEnd : bodyAt, end)
    const ms = Number(tag(parts, 'duration_ms') ?? tag(parts, 'duration-ms'))
    const summary = tag(head, 'summary')?.replace(/\s+/g, ' ').slice(0, 300)
    out.push({
      ...(task ? { task } : {}),
      ...(toolUseId ? { toolUseId } : {}),
      status: statusOf(word),
      ...(summary ? { summary } : {}),
      ...(Number.isFinite(ms) && ms >= 0 ? { ms: Math.min(ms, MAX_MS) } : {}),
    })
  }

  return out
}
