import type { ContextPin, LineRange, Task } from '../types'
import { escapeXml, serializeContract } from './intent'

export type PinContent = { pin: ContextPin; text?: string; error?: string }

// "src/a.ts", "src/a.ts:10-40", "src/a.ts:12" or "src/a.ts#L10-L40".
export function parsePinSpec(spec: string): { path: string; lines?: LineRange } {
  const clean = spec.trim()
  const match = /^(.*?)(?::|#L)(\d+)(?:-L?(\d+))?$/.exec(clean)

  if (!match || match[1] === '') {
    return { path: clean }
  }
  const from = Number(match[2])
  const to = match[3] === undefined ? from : Number(match[3])

  return { path: match[1] ?? clean, lines: { from: Math.max(1, Math.min(from, to)), to: Math.max(from, to) } }
}

export function rangeLabel(lines: LineRange | undefined): string {
  return lines ? (lines.from === lines.to ? `:${lines.from}` : `:${lines.from}-${lines.to}`) : ''
}

export function sliceLines(text: string, lines: LineRange | undefined): string {
  return lines ? text.split('\n').slice(lines.from - 1, lines.to).join('\n') : text
}

export async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))

  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

// What a pin puts in the prompt: a snapshot's saved text, or the file as read now.
export function pinText(pin: ContextPin, live: string | undefined): string | undefined {
  if (pin.kind === 'note') return pin.text
  const source = pin.mode === 'snapshot' && pin.snapshot ? pin.snapshot.text : live

  return source === undefined ? undefined : sliceLines(source, pin.lines)
}

export function serializePins(contents: readonly PinContent[]): string | undefined {
  const parts: string[] = []

  for (const { pin, text } of contents) {
    if (pin.kind === 'note') {
      parts.push(`  <note>${escapeXml(pin.text)}</note>`)
      continue
    }
    const body = pinText(pin, text)
    if (body === undefined) continue
    const lines = pin.lines ? ` lines="${pin.lines.from}-${pin.lines.to}"` : ''
    const snapshot = pin.mode === 'snapshot' && pin.snapshot ? ` snapshot_sha256="${pin.snapshot.sha256.slice(0, 12)}"` : ''
    parts.push(`  <file path="${escapeXml(pin.path)}"${lines}${snapshot}>\n${body}\n  </file>`)
  }

  if (parts.length === 0) {
    return undefined
  }

  return ['<smartworkbench_pins version="1">', ...parts, '</smartworkbench_pins>'].join('\n')
}

// A character-based guess (~4 chars per token); shown with "~", never as exact.
export function estimateTokens(chars: number): string {
  const tokens = chars / 4

  return tokens >= 1000 ? `~${(tokens / 1000).toFixed(1)}K` : `~${Math.max(1, Math.round(tokens))}`
}

export type Injection = { blocks: string[]; warnings: string[]; chars: number }

// The one place the added context is assembled: the prompt hook and the Preview both use it.
export function injectionOf(task: Task, contents: readonly PinContent[]): Injection {
  const blocks = [serializeContract(task), serializePins(contents)].filter((one): one is string => one !== undefined)
  const warnings = contents.flatMap(one =>
    one.error !== undefined && one.pin.kind === 'file' && !(one.pin.mode === 'snapshot' && one.pin.snapshot)
      ? [`${one.pin.path}: cannot read`]
      : [],
  )

  return { blocks, warnings, chars: blocks.reduce((sum, one) => sum + one.length, 0) }
}
