import type { Task } from '../types'

// The tool Claude calls to ask for a contract change (registered by register.tsx).
export const PROPOSE_TOOL = 'mcp__smartworkbench__propose_contract_change'

export function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// Deterministic: the same contract always serializes to the same text, so the
// prompt cache is not invalidated by an unchanged contract.
export function serializeContract(task: Task): string | undefined {
  if (!task.locked || task.goal.trim() === '') {
    return undefined
  }

  const constraints = task.constraints.filter(one => one.isActive)
  const lines = ['<smartworkbench_contract version="1">', `  <goal>${escapeXml(task.goal.trim())}</goal>`]

  if (task.issue) {
    const url = task.issue.url ? ` url="${escapeXml(task.issue.url)}"` : ''
    lines.push(`  <issue ref="${escapeXml(task.issue.ref)}"${url}>${escapeXml(task.issue.title ?? '')}</issue>`)
  }

  if (constraints.length > 0) {
    lines.push('  <constraints>')
    for (const one of constraints) {
      lines.push(`    <constraint priority="${one.priority}">${escapeXml(one.text)}</constraint>`)
    }
    lines.push('  </constraints>')
  }

  if (task.nonGoals.length > 0) {
    lines.push('  <non_goals>')
    for (const one of task.nonGoals) {
      lines.push(`    <non_goal>${escapeXml(one)}</non_goal>`)
    }
    lines.push('  </non_goals>')
  }

  const conditions = task.doneConditions.filter(one => one.manual?.status !== 'waived')

  if (conditions.length > 0) {
    lines.push('  <done_conditions>')
    for (const one of conditions) {
      lines.push(`    <condition id="${one.id}">${escapeXml(one.text)}</condition>`)
    }
    lines.push('  </done_conditions>')
  }

  lines.push(
    `  <note>Set by the user in SmartWorkbench and locked. Follow it. If it should change, call ${PROPOSE_TOOL} and let the user decide; do not work around it. Completion is judged from test/build results, not from your summary.</note>`,
  )
  lines.push('</smartworkbench_contract>')

  return lines.join('\n')
}
