// Pure state transitions: no engine access, so the engine-facing code in
// register.tsx stays the only place `$` is used.
import type {
  ContextPin,
  EvidenceKind,
  EvidenceRecord,
  GuardProfile,
  Live,
  ManualMark,
  Task,
  TaskStatus,
  ToolCallRecord,
  Workbench,
} from '../types'
import { completionOf, guessLink } from './evidence'

export const MAX_CALLS = 100
export const MAX_EVIDENCE = 200
export const MAX_OBSERVED = 50

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

export function newId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}`
}

export function emptyTask(): Task {
  return { id: newId('task'), status: 'draft', locked: false, goal: '', constraints: [], nonGoals: [], doneConditions: [] }
}

export function emptyWorkbench(): Workbench {
  return {
    schemaVersion: 1,
    task: emptyTask(),
    context: { pins: [], observed: [] },
    execution: { profile: 'balanced', isPaused: false, recentCalls: [] },
    evidence: [],
    changed: { files: [], added: 0, removed: 0 },
  }
}

export const EMPTY_LIVE: Live = { activeTab: 'intent', isPreviewOpen: false, pinWarnings: [] }

export function isWorkbench(value: unknown): value is Workbench {
  return typeof value === 'object' && value !== null && (value as Workbench).schemaVersion === 1
}

// What a saved workbench becomes on load: a call still running when the session ended never finished.
export function restore(saved: unknown): Workbench {
  const wb = isWorkbench(saved) ? { ...emptyWorkbench(), ...saved } : emptyWorkbench()
  const recentCalls = wb.execution.recentCalls.map(one => (one.outcome === 'running' ? { ...one, outcome: 'error' as const } : one))

  return withStatus({ ...wb, execution: { ...wb.execution, recentCalls } })
}

// Complete only when every condition is verified or waived; never from the model's words.
export function withStatus(wb: Workbench): Workbench {
  const { task } = wb
  const { isComplete } = completionOf(task, wb.evidence)
  const isVerifying = task.doneConditions.some(one => one.manual || (one.link && wb.evidence.some(ev => ev.kind === one.link)))
  const status: TaskStatus = task.goal.trim() === '' ? 'draft' : isComplete ? 'complete' : isVerifying ? 'verifying' : 'active'

  return status === task.status ? wb : { ...wb, task: { ...task, status } }
}

// Every intent edit goes through here: a locked contract is read-only until unlocked.
function editTask(wb: Workbench, change: (task: Task) => Task): Workbench {
  return wb.task.locked ? wb : { ...wb, task: change(wb.task) }
}

export function setGoal(wb: Workbench, goal: string): Workbench {
  return editTask(wb, task => ({ ...task, goal: goal.trim().slice(0, 500) }))
}

// "s: keep it small" adds a soft constraint; anything else is hard.
export function addConstraint(wb: Workbench, text: string): Workbench {
  const priority = /^\s*\[?s\]?\s*[:：]/i.test(text) ? 'soft' : 'hard'
  const clean = text.replace(/^\s*\[?[hs]\]?\s*[:：]\s*/i, '').trim()

  return clean === ''
    ? wb
    : editTask(wb, task => ({ ...task, constraints: [...task.constraints, { id: newId('c'), text: clean, priority, isActive: true }] }))
}

export function toggleConstraint(wb: Workbench, id: string): Workbench {
  return editTask(wb, task => ({
    ...task,
    constraints: task.constraints.map(one => (one.id === id ? { ...one, isActive: !one.isActive } : one)),
  }))
}

export function flipPriority(wb: Workbench, id: string): Workbench {
  return editTask(wb, task => ({
    ...task,
    constraints: task.constraints.map(one => (one.id === id ? { ...one, priority: one.priority === 'hard' ? 'soft' : 'hard' } : one)),
  }))
}

export function removeConstraint(wb: Workbench, id: string): Workbench {
  return editTask(wb, task => ({ ...task, constraints: task.constraints.filter(one => one.id !== id) }))
}

export function addNonGoal(wb: Workbench, text: string): Workbench {
  return text.trim() === '' ? wb : editTask(wb, task => ({ ...task, nonGoals: [...task.nonGoals, text.trim()] }))
}

export function removeNonGoal(wb: Workbench, index: number): Workbench {
  return editTask(wb, task => ({ ...task, nonGoals: task.nonGoals.filter((_, i) => i !== index) }))
}

export function addCondition(wb: Workbench, text: string): Workbench {
  if (text.trim() === '') {
    return wb
  }

  return editTask(wb, task => {
    const n = task.doneConditions.reduce((max, one) => Math.max(max, Number(one.id.replace('dc-', '')) || 0), 0) + 1
    const link = guessLink(text)

    return { ...task, doneConditions: [...task.doneConditions, { id: `dc-${n}`, text: text.trim(), ...(link ? { link } : {}) }] }
  })
}

export function removeCondition(wb: Workbench, id: string): Workbench {
  return editTask(wb, task => ({ ...task, doneConditions: task.doneConditions.filter(one => one.id !== id) }))
}

// Linking evidence and marking results is verification, allowed while locked.
export function linkCondition(wb: Workbench, id: string, link: EvidenceKind | 'none'): Workbench {
  const doneConditions = wb.task.doneConditions.map(one => {
    if (one.id !== id) return one
    const { link: _old, ...rest } = one

    return link === 'none' ? rest : { ...rest, link }
  })

  return { ...wb, task: { ...wb.task, doneConditions } }
}

// A manual mark always carries a note and a time: the audit trail for a hand-set status.
export function markCondition(wb: Workbench, id: string, status: ManualMark['status'] | 'auto', note: string, at: number): Workbench {
  const doneConditions = wb.task.doneConditions.map(one => {
    if (one.id !== id) return one
    const { manual: _old, ...rest } = one

    return status === 'auto' ? rest : { ...rest, manual: { status, note, at } }
  })

  return { ...wb, task: { ...wb.task, doneConditions } }
}

export function toggleLock(wb: Workbench): Workbench {
  return { ...wb, task: { ...wb.task, locked: !wb.task.locked } }
}

export function newTask(wb: Workbench): Workbench {
  return { ...wb, task: emptyTask(), evidence: [], changed: { files: [], added: 0, removed: 0 } }
}

export function clearAll(wb: Workbench): Workbench {
  return { ...emptyWorkbench(), execution: { ...wb.execution, recentCalls: [] } }
}

export function pinFile(wb: Workbench, path: string): Workbench {
  const clean = path.trim()
  if (clean === '' || wb.context.pins.some(one => one.kind === 'file' && one.path === clean)) {
    return wb
  }
  const pin: ContextPin = { id: newId('p'), kind: 'file', path: clean, mode: 'live' }

  return { ...wb, context: { ...wb.context, pins: [...wb.context.pins, pin] } }
}

export function pinNote(wb: Workbench, text: string): Workbench {
  if (text.trim() === '') {
    return wb
  }
  const pin: ContextPin = { id: newId('p'), kind: 'note', text: text.trim() }

  return { ...wb, context: { ...wb.context, pins: [...wb.context.pins, pin] } }
}

export function unpin(wb: Workbench, id: string): Workbench {
  return { ...wb, context: { ...wb.context, pins: wb.context.pins.filter(one => one.id !== id) } }
}

export function setProfile(wb: Workbench, profile: GuardProfile): Workbench {
  return { ...wb, execution: { ...wb.execution, profile } }
}

export function togglePause(wb: Workbench): Workbench {
  return { ...wb, execution: { ...wb.execution, isPaused: !wb.execution.isPaused } }
}

export function clearHistory(wb: Workbench): Workbench {
  return { ...wb, execution: { ...wb.execution, recentCalls: [] } }
}

export function recordCall(wb: Workbench, call: ToolCallRecord): Workbench {
  const others = wb.execution.recentCalls.filter(one => one.id !== call.id)

  return { ...wb, execution: { ...wb.execution, recentCalls: [...others, call].slice(-MAX_CALLS) } }
}

export function addEvidence(wb: Workbench, record: EvidenceRecord): Workbench {
  return { ...wb, evidence: [...wb.evidence, record].slice(-MAX_EVIDENCE) }
}

export function observe(wb: Workbench, tool: string, path: string): Workbench {
  const how = EDIT_TOOLS.has(tool) ? 'edited' : 'read'
  const was = wb.context.observed.find(one => one.path === path)
  const others = wb.context.observed.filter(one => one.path !== path)
  const observed = [...others, { path, how: was?.how === 'edited' ? 'edited' : how } as const].slice(-MAX_OBSERVED)
  const files = how === 'edited' && !wb.changed.files.includes(path) ? [...wb.changed.files, path] : wb.changed.files

  return { ...wb, context: { ...wb.context, observed }, changed: { ...wb.changed, files } }
}

export function isEditTool(tool: string): boolean {
  return EDIT_TOOLS.has(tool)
}

export function cut(text: string, width: number): string {
  return text.length <= width ? text : `${text.slice(0, Math.max(1, width - 1))}…`
}

export function guardLabel(wb: Workbench): string {
  return wb.execution.isPaused ? 'PAUSED' : wb.execution.profile.toUpperCase()
}

export function bandText(wb: Workbench, live: Live): string {
  const { met, total } = completionOf(wb.task, wb.evidence)
  const dot = wb.task.locked ? '●' : '○'
  const title = wb.task.goal.trim() === '' ? 'No goal set' : wb.task.goal.trim()
  const ctx = live.contextPercent === undefined ? '' : ` · ${live.contextPercent}%`
  const warn = live.pinWarnings.length > 0 ? ` ⚠${live.pinWarnings.length}` : ''

  return `WB ${dot} ${cut(title, 28)} │ Ctx +${wb.context.pins.length} pins${ctx}${warn} │ Done ${met}/${total} │ Guard ${guardLabel(wb)}`
}
