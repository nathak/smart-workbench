import type { EvidenceRecord, ToolCallRecord, Workbench } from '../types'
import { rangeLabel } from './context'
import { coverageOf, hunkLabel, lastCheckedEdit } from './diff'
import { completionOf, isStale, latestOf, markOf, statusOf } from './evidence'

function when(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 16)
}

// A handoff another session or developer can pick the task up from.
export function handoffMarkdown(wb: Workbench, now: number): string {
  const { task } = wb
  const lastEdit = lastCheckedEdit(wb.changed)
  const { met, total, isComplete } = completionOf(task, wb.evidence, lastEdit)
  const out: string[] = [
    `# SmartWorkbench handoff`,
    '',
    `- Exported: ${when(now)} UTC`,
    `- Status: ${task.status}${task.locked ? ' (contract locked)' : ''} · Done ${met}/${total}${total > 0 ? ` · ${isComplete ? 'COMPLETE' : 'INCOMPLETE'}` : ''}`,
    `- Guard: ${wb.execution.profile}${wb.execution.isPaused ? ' (risky calls paused)' : ''}`,
    ...(task.issue ? [`- Issue: ${task.issue.ref}${task.issue.title ? ` ${task.issue.title}` : ''}${task.issue.url ? ` (${task.issue.url})` : ''}`] : []),
    '',
    '## Goal',
    '',
    task.goal.trim() || '_none_',
  ]

  const constraints = task.constraints.filter(one => one.isActive)
  if (constraints.length > 0) {
    out.push('', '## Constraints', '', ...constraints.map(one => `- [${one.priority === 'hard' ? 'H' : 'S'}] ${one.text}`))
  }
  if (task.nonGoals.length > 0) {
    out.push('', '## Non-goals', '', ...task.nonGoals.map(one => `- ${one}`))
  }

  if (task.doneConditions.length > 0) {
    out.push('', '## Done conditions', '')
    for (const one of task.doneConditions) {
      const status = statusOf(one, wb.evidence, lastEdit)
      const latest = one.link ? latestOf(wb.evidence, one.link) : undefined
      const proof = one.manual
        ? `manual ${one.manual.status} (${when(one.manual.at)}): ${one.manual.note}`
        : latest
          ? `${latest.ok === null ? 'ran' : latest.ok ? 'passed' : 'failed'}: \`${latest.command}\`${isStale(latest, lastEdit) ? ' (code changed since; re-run)' : ''}`
          : one.link
            ? `no ${one.link} run yet`
            : 'not linked to evidence'
      out.push(`- ${markOf(status)} **${one.text}** — ${status}; ${proof}`)
    }
  }

  if (wb.context.pins.length > 0) {
    out.push('', '## Pinned context', '')
    for (const pin of wb.context.pins) {
      out.push(
        pin.kind === 'note'
          ? `- Note: ${pin.text}`
          : `- \`${pin.path}${rangeLabel(pin.lines)}\` (${pin.mode}${pin.snapshot ? `, sha256 ${pin.snapshot.sha256.slice(0, 12)}` : ''})`,
      )
    }
  }

  const coverage = coverageOf(wb.changed, wb.evidence)
  if (coverage.length > 0) {
    const stat = wb.changed.added + wb.changed.removed > 0 ? ` (+${wb.changed.added} −${wb.changed.removed})` : ''
    const say: Record<(typeof coverage)[number]['state'], string> = {
      proven: 'a check passed after the last edit',
      failing: 'a check failed after the last edit',
      unproven: 'no check since the last edit',
      docs: 'docs/generated',
      untracked: 'changed outside the tools',
    }
    out.push('', `## Changed files${stat}`, '')
    for (const one of coverage) {
      const ranges = one.hunks.length > 0 ? ` ${hunkLabel(one.hunks, 6)}` : ''
      const by = one.provenBy ? ` (\`${one.provenBy.command}\`)` : one.failedBy ? ` (\`${one.failedBy.command}\`)` : ''
      out.push(`- \`${one.path}\`${ranges} — ${say[one.state]}${by}`)
    }
  }

  const recent = wb.evidence.slice(-10).reverse()
  if (recent.length > 0) {
    out.push('', '## Recent verification runs', '', ...recent.map(one => `- ${when(one.at)} ${one.kind} ${one.ok === null ? '?' : one.ok ? '✓' : '✕'} \`${one.command}\``))
  }

  const stopped = wb.execution.recentCalls.filter(one => one.outcome === 'blocked' || one.outcome === 'declined').slice(-10)
  if (stopped.length > 0) {
    out.push('', '## Blocked or declined calls', '', ...stopped.map(one => `- ${one.outcome}: ${one.tool} \`${one.summary}\`${one.reason ? ` — ${one.reason}` : ''}`))
  }

  return `${out.join('\n')}\n`
}

// The line added under a tool's transcript row; undefined when there is nothing to say.
export function badgeOf(call: ToolCallRecord, evidence: EvidenceRecord | undefined, wb: Workbench): string | undefined {
  const parts: string[] = []

  if (call.risk !== 'low') parts.push(call.risk.toUpperCase())
  if (call.outcome === 'blocked') parts.push('Blocked')
  else if (call.outcome === 'declined') parts.push('Declined')
  else if (call.sessionAllowed) parts.push('Allowed for session')
  else if (call.policy === 'ask') parts.push('Asked → allowed')
  if (call.reason && call.risk !== 'low') parts.push(call.reason)

  if (evidence) {
    const linked = wb.task.doneConditions.filter(one => one.link === evidence.kind).map(one => one.id)
    const result = evidence.ok === null ? 'observed' : evidence.ok ? 'passed' : 'failed'
    parts.push(`${evidence.kind} ${result}${linked.length > 0 ? ` · evidence for ${linked.join(', ')}` : ''}`)
  }

  return parts.length === 0 ? undefined : `WB · ${parts.join(' · ')}`
}
