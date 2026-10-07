import type { ContextPin, Task } from '../types'
import { escapeXml, serializeContract } from './intent'

export type PinContent = { pin: ContextPin; text?: string; error?: string }

export function serializePins(contents: readonly PinContent[]): string | undefined {
  const parts: string[] = []

  for (const { pin, text } of contents) {
    if (pin.kind === 'note') {
      parts.push(`  <note>${escapeXml(pin.text)}</note>`)
    } else if (text !== undefined) {
      parts.push(`  <file path="${escapeXml(pin.path)}">\n${text}\n  </file>`)
    }
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
  const warnings = contents.flatMap(one => (one.error !== undefined && one.pin.kind === 'file' ? [`${one.pin.path}: cannot read`] : []))

  return { blocks, warnings, chars: blocks.reduce((sum, one) => sum + one.length, 0) }
}
