// The Workflow tool as the live view shows it. Pure: the name and description are read from the script's text,
// never by running it, so they say what the script claims, not what it will do.
const SCAN = 8000
const META_WINDOW = 2000

export type WorkflowCall = { name?: string; description?: string; saved: boolean; resume: boolean; text?: string }

function clip(text: string, width: number): string {
  const one = text.replace(/\s+/g, ' ').trim()

  return one.length > width ? `${one.slice(0, width - 1)}…` : one
}

function field(window: string, key: string): string | undefined {
  const hit = new RegExp(`\\b${key}\\s*:\\s*(['"\`])((?:\\\\.|(?!\\1)[^\\\\\\n])*)\\1`).exec(window)
  // A template value with ${...} is code, not a label.
  if (!hit || (hit[1] === '`' && (hit[2] ?? '').includes('${'))) return undefined

  return (hit[2] ?? '').replace(/\\(.)/g, '$1')
}

function json(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? ''
  } catch {
    return '[unreadable]'
  }
}

export function workflowOf(input: unknown): WorkflowCall {
  const args = (input ?? {}) as Record<string, unknown>
  const saved = typeof args.name === 'string' && args.name !== ''
  const resume = typeof args.resumeFromRunId === 'string'
  const script = typeof args.script === 'string' ? args.script : ''
  const start = /export\s+const\s+meta\s*=\s*\{/.exec(script.slice(0, SCAN))
  const window = start ? script.slice(start.index + start[0].length, start.index + start[0].length + META_WINDOW) : ''
  const name = saved ? clip(args.name as string, 60) : field(window, 'name')
  const description = field(window, 'description')
  const text = [script, args.args !== undefined ? `args: ${json(args.args)}` : ''].filter(Boolean).join('\n\n')

  return {
    ...(name ? { name: clip(name, 60) } : {}),
    ...(description ? { description: clip(description, 120) } : {}),
    saved,
    resume,
    ...(text ? { text } : {}),
  }
}

// One line for the log, the audit and the tool row badge.
export function workflowLabel(input: unknown): string {
  const args = (input ?? {}) as Record<string, unknown>
  const wf = workflowOf(input)
  const base = wf.name ?? (typeof args.scriptPath === 'string' ? args.scriptPath.split(/[\\/]/).pop() : undefined) ?? 'inline script'

  return clip(`${base}${wf.description ? ` — ${wf.description}` : ''}`, 120)
}
