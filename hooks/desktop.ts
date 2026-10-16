// The read-only picture of a session's workbench that the desktop app shows (tools/desktop-snapshot.mjs writes it).
// Nothing here is a command or a prompt: the contract's own words, the team and guard settings, and the evidence results.
import type { EvidenceRecord, Live, Workbench } from '../types'
import { statusOf } from './evidence'
import * as model from './model'
import { redact } from './risk'

export const SNAPSHOT_VERSION = 1
export const SNAPSHOT_MAX_BYTES = 64 * 1024
const TEXT_MAX = 600
const LIST_MAX = 40

const bytes = (text: string): number => new TextEncoder().encode(text).length
const clean = (text: string): string => redact(text).slice(0, TEXT_MAX)

export type Snapshot = ReturnType<typeof snapshotOf>

export function snapshotOf(wb: Workbench, live: Live, at: number) {
  const lastEdit = Math.max(0, ...Object.values(wb.changed.edits ?? {}))
  const evidence: readonly EvidenceRecord[] = wb.evidence
  const team = wb.team

  return {
    v: SNAPSHOT_VERSION,
    at,
    session: live.sessionId ?? '',
    scope: live.scope === 'session' ? 'session' : 'project',
    rev: wb.rev ?? 0,
    task: {
      status: wb.task.status,
      locked: wb.task.locked,
      goal: clean(wb.task.goal),
      constraints: wb.task.constraints.slice(0, LIST_MAX).map(one => ({ id: one.id, text: clean(one.text), priority: one.priority, isActive: one.isActive })),
      nonGoals: wb.task.nonGoals.slice(0, LIST_MAX).map(clean),
      doneConditions: wb.task.doneConditions.slice(0, LIST_MAX).map(one => ({ id: one.id, text: clean(one.text), link: one.link ?? null, status: statusOf(one, evidence, lastEdit || undefined) })),
    },
    team: { enabled: team?.enabled === true, codex: team?.codex?.enabled === true, roles: { lead: team?.lead?.model ?? null, explorer: team?.explorer?.model ?? null, advisor: team?.advisor?.model ?? null } },
    guard: { profile: wb.execution.profile, paused: wb.execution.isPaused, fileProfile: live.policy?.profile ?? null, rules: live.policy?.rules.length ?? 0 },
    // Which checks ran and how they ended; the command that ran is left out.
    evidence: evidence.slice(-20).map(one => ({ kind: one.kind, ok: one.ok, at: one.at })),
    proposals: (wb.proposals ?? []).filter(one => one.status === 'open').slice(0, 10).map(one => ({ id: one.id, change: one.change, text: one.text === undefined ? null : clean(one.text), reason: clean(one.reason) })),
    pins: wb.context.pins.length,
    changed: { files: wb.changed.files.length, added: wb.changed.added, removed: wb.changed.removed },
  }
}

/** The snapshot as text, or undefined when it cannot be made to fit the limit. */
export function snapshotText(wb: Workbench, live: Live, at: number): string | undefined {
  const snap = snapshotOf(wb, live, at)
  let text = JSON.stringify(snap)
  if (bytes(text) > SNAPSHOT_MAX_BYTES) text = JSON.stringify({ ...snap, evidence: [], proposals: [], task: { ...snap.task, constraints: snap.task.constraints.slice(0, 10), doneConditions: snap.task.doneConditions.slice(0, 10), nonGoals: [] } })

  if (bytes(text) > SNAPSHOT_MAX_BYTES) text = JSON.stringify({ ...snap, evidence: [], proposals: [], team: { ...snap.team }, task: { ...snap.task, goal: snap.task.goal.slice(0, 200), constraints: [], doneConditions: snap.task.doneConditions.slice(0, 5).map(one => ({ ...one, text: one.text.slice(0, 100) })), nonGoals: [] } })

  return bytes(text) > SNAPSHOT_MAX_BYTES ? undefined : text
}

// ---- commands from the desktop app

export type DeskOp =
  | { op: 'set_goal' | 'add_constraint' | 'add_done_condition' | 'add_non_goal'; text: string }
  | { op: 'remove_constraint' | 'remove_done_condition'; id: string; text: string }
  | { op: 'set_active'; id: string; isActive: boolean }
  | { op: 'set_priority'; id: string; priority: 'hard' | 'soft' }
  | { op: 'remove_non_goal'; index: number; text: string }
  | { op: 'lock' | 'unlock' }

/**
 * The contract after the ops, or the reason none of them is applied (all or nothing).
 * A locked contract takes no edit unless an unlock came before it in the same batch, as in the panel.
 */
export function applyOps(wb: Workbench, ops: readonly DeskOp[]): { wb: Workbench; reason?: undefined } | { reason: string } {
  let cur = wb
  for (const one of ops) {
    if (one.op === 'lock' || one.op === 'unlock') {
      if (cur.task.locked !== (one.op === 'lock')) cur = model.toggleLock(cur)
      continue
    }
    if (cur.task.locked) return { reason: 'locked' }
    switch (one.op) {
      case 'set_goal':
        cur = model.setGoal(cur, one.text)
        break
      case 'add_constraint':
        cur = model.addConstraint(cur, one.text)
        break
      case 'add_done_condition':
        cur = model.addCondition(cur, one.text)
        break
      case 'add_non_goal':
        cur = model.addNonGoal(cur, one.text)
        break
      // Each of these names what it expects to find, so a command made from an old view is refused instead of changing another item.
      case 'remove_constraint':
      case 'set_active':
      case 'set_priority': {
        const item = cur.task.constraints.find(entry => entry.id === one.id)
        if (!item) return { reason: 'unknown constraint' }
        if (one.op === 'remove_constraint') {
          if (item.text !== one.text) return { reason: 'stale' }
          cur = model.removeConstraint(cur, item.id)
        } else if (one.op === 'set_active') {
          if (item.isActive !== one.isActive) cur = model.toggleConstraint(cur, item.id)
        } else if (item.priority !== one.priority) cur = model.flipPriority(cur, item.id)
        break
      }
      case 'remove_done_condition': {
        const item = cur.task.doneConditions.find(entry => entry.id === one.id)
        if (!item) return { reason: 'unknown condition' }
        if (item.text !== one.text) return { reason: 'stale' }
        cur = model.removeCondition(cur, item.id)
        break
      }
      case 'remove_non_goal':
        if (one.index >= cur.task.nonGoals.length) return { reason: 'unknown non-goal' }
        if (cur.task.nonGoals[one.index] !== one.text) return { reason: 'stale' }
        cur = model.removeNonGoal(cur, one.index)
        break
    }
  }

  return { wb: cur }
}
