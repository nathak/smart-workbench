// The read-only picture of a session's workbench that the desktop app shows (tools/desktop-snapshot.mjs writes it).
// Nothing here is a command or a prompt: the contract's own words, the team and guard settings, and the evidence results.
import type { EvidenceRecord, Live, Workbench } from '../types'
import { statusOf } from './evidence'
import { codexOf } from './codex'
import { REPEAT_LIMIT, SMALL_EDIT_CHARS, SMALL_EDIT_LINES, SMALL_TURN_LINES } from './crew'
import * as model from './model'
import { isPolicyEditOp, type PolicyEditOp } from './policy-edit'
import { redact } from './risk'

export const SNAPSHOT_VERSION = 1
export const SNAPSHOT_MAX_BYTES = 64 * 1024
const TEXT_MAX = 600
const LIST_MAX = 40

const bytes = (text: string): number => new TextEncoder().encode(text).length
const clean = (text: string): string => redact(text).slice(0, TEXT_MAX)

export type Snapshot = ReturnType<typeof snapshotOf>

// The guard file as the app may edit it: the hash it must quote back, and each rule with its place in the file's own list.
// Only a file that parsed (hash known) can be edited; a broken one is shown, not offered.
function fileOf(live: Live) {
  const policy = live.policy
  if (!policy) return null
  const cut = (text: string | undefined): string | null => (text === undefined ? null : redact(text).slice(0, 200))

  return {
    hash: policy.hash ?? null,
    profile: policy.profile ?? null,
    editable: policy.hash !== undefined && policy.ruleAt !== undefined && !policy.errors.some(one => one.startsWith('not valid JSON') || one.startsWith('expected an object') || one.startsWith('rules must')),
    errors: policy.errors.length,
    rules: policy.rules.slice(0, LIST_MAX).map((one, at) => ({ i: policy.ruleAt?.[at] ?? at, policy: one.policy, tool: cut(one.tool), command: cut(one.command), path: cut(one.path), reason: cut(one.reason) })),
  }
}

/** A question the session is asking about a guarded call, as the app shows it: `remote` is true when the app may answer, else why not. */
export type AskView = { id: string; tool: string; reason: string; summary: string; remoteUntil: number; remote: true | string }

export function snapshotOf(wb: Workbench, live: Live, at: number, asks: readonly AskView[] = []) {
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
    team: { enabled: team?.enabled === true, codex: team?.codex?.enabled === true, roles: { lead: team?.lead?.model ?? null, explorer: team?.explorer?.model ?? null, advisor: team?.advisor?.model ?? null }, efforts: { lead: team?.lead?.effort ?? null, explorer: team?.explorer?.effort ?? null, advisor: team?.advisor?.effort ?? null }, codexReview: team?.codex?.review === true, codexRescue: team?.codex?.rescue === true },
    codexFound: typeof live.codexPath === 'string',
    guard: { profile: wb.execution.profile, paused: wb.execution.isPaused, fileProfile: live.policy?.profile ?? null, rules: live.policy?.rules.length ?? 0, file: fileOf(live) },
    // Which checks ran and how they ended; the command that ran is left out.
    evidence: evidence.slice(-20).map(one => ({ kind: one.kind, ok: one.ok, at: one.at })),
    proposals: (wb.proposals ?? []).filter(one => one.status === 'open').slice(0, 10).map(one => ({ id: one.id, change: one.change, text: one.text === undefined ? null : clean(one.text), reason: clean(one.reason) })),
    asks: asks.slice(0, 5).map(one => ({ id: one.id, tool: clean(one.tool), reason: clean(one.reason), summary: clean(one.summary), remoteUntil: one.remoteUntil, remote: one.remote })),
    pins: wb.context.pins.length,
    changed: { files: wb.changed.files.length, added: wb.changed.added, removed: wb.changed.removed },
  }
}

const FEED_CONDITIONS = 10
const FEED_TEXT = 120

/**
 * The contract and guard state as one live-feed line: what the live view shows in its header chips and its intent and evidence views.
 * Counts and short texts only (the goal up to 200 characters, each condition up to 120). The conditions are nested, and the feed masks
 * only top-level text, so each one is masked here.
 */
export function feedStateOf(wb: Workbench, live: Live) {
  const evidence: readonly EvidenceRecord[] = wb.evidence
  const lastEdit = Math.max(0, ...Object.values(wb.changed.edits ?? {}))
  const conds = wb.task.doneConditions.map(one => ({ id: one.id, t: redact(one.text).slice(0, FEED_TEXT), link: one.link ?? null, s: statusOf(one, evidence, lastEdit || undefined) }))

  return {
    goal: redact(wb.task.goal).slice(0, 200),
    status: wb.task.status,
    locked: wb.task.locked,
    met: conds.filter(one => one.s === 'verified').length,
    total: conds.length,
    conds: conds.slice(0, FEED_CONDITIONS),
    constraints: wb.task.constraints.filter(one => one.isActive).length,
    nonGoals: wb.task.nonGoals.length,
    proposals: (wb.proposals ?? []).filter(one => one.status === 'open').length,
    profile: wb.execution.profile,
    paused: wb.execution.isPaused,
    rules: live.policy?.rules.length ?? 0,
    pins: wb.context.pins.length,
    files: wb.changed.files.length,
    added: wb.changed.added,
    removed: wb.changed.removed,
    team: wb.team?.enabled === true,
    // The team page's cards. Nested texts are masked here, since the feed masks only top-level ones.
    roles: { lead: roleText(wb.team?.lead?.model, 40), explorer: roleText(wb.team?.explorer?.model, 40), advisor: roleText(wb.team?.advisor?.model, 40) },
    efforts: { lead: roleText(wb.team?.lead?.effort, 12), explorer: roleText(wb.team?.explorer?.effort, 12), advisor: roleText(wb.team?.advisor?.effort, 12) },
    codex: wb.team?.codex?.enabled === true,
    codexReview: wb.team?.codex?.review === true,
    codexRescue: wb.team?.codex?.rescue === true,
    gates: { editLines: SMALL_EDIT_LINES, editChars: SMALL_EDIT_CHARS, turnLines: SMALL_TURN_LINES, repeat: REPEAT_LIMIT },
  }
}

const roleText = (value: unknown, max: number): string | null => (typeof value === 'string' && value ? redact(value).slice(0, max) : null)

/** The snapshot as text, or undefined when it cannot be made to fit the limit. */
export function snapshotText(wb: Workbench, live: Live, at: number, asks: readonly AskView[] = []): string | undefined {
  const snap = snapshotOf(wb, live, at, asks)
  let text = JSON.stringify(snap)
  // The guard file's rules go first when the text is too big: they are the least needed to read the contract.
  if (bytes(text) > SNAPSHOT_MAX_BYTES && snap.guard.file) text = JSON.stringify({ ...snap, guard: { ...snap.guard, file: { ...snap.guard.file, editable: false, rules: [] } } })
  if (bytes(text) > SNAPSHOT_MAX_BYTES) text = JSON.stringify({ ...snap, evidence: [], proposals: [], guard: { ...snap.guard, file: snap.guard.file && { ...snap.guard.file, editable: false, rules: [] } }, task: { ...snap.task, constraints: snap.task.constraints.slice(0, 10), doneConditions: snap.task.doneConditions.slice(0, 10), nonGoals: [] } })

  if (bytes(text) > SNAPSHOT_MAX_BYTES) text = JSON.stringify({ ...snap, evidence: [], proposals: [], guard: { ...snap.guard, file: snap.guard.file && { ...snap.guard.file, editable: false, rules: [] } }, task: { ...snap.task, goal: snap.task.goal.slice(0, 200), constraints: [], doneConditions: snap.task.doneConditions.slice(0, 5).map(one => ({ ...one, text: one.text.slice(0, 100) })), nonGoals: [] } })

  return bytes(text) > SNAPSHOT_MAX_BYTES ? undefined : text
}

// ---- commands from the desktop app

export type SettingOp =
  | { op: 'team_enabled' | 'codex'; enabled: boolean }
  | { op: 'team_role'; role: 'lead' | 'explorer' | 'advisor'; model?: string; effort?: string }
  | { op: 'set_profile'; profile: 'off' | 'permissive' | 'balanced' | 'strict' }
  | { op: 'pause'; on: boolean }
  | { op: 'proposal_decide'; id: string; accept: boolean }
  | { op: 'ask_answer'; id: string; allow: boolean; by: 'app' | 'web' }
  | PolicyEditOp

export const isSettingOp = (one: { op: string }): one is SettingOp => isPolicyEditOp(one) || one.op === 'team_enabled' || one.op === 'codex' || one.op === 'team_role' || one.op === 'set_profile' || one.op === 'pause' || one.op === 'proposal_decide' || one.op === 'ask_answer'

const PROFILE_RANK = { off: 0, permissive: 1, balanced: 2, strict: 3 } as const

/** Whether a setting makes the guard watch less than it does now: those wait for the person's answer in the session. */
export function lowersGuard(wb: Workbench, one: SettingOp): boolean {
  // An edit of the guard file is judged against the file on disk (editPolicy), which this function cannot see.
  if (isPolicyEditOp(one)) return false
  if (one.op === 'set_profile') return PROFILE_RANK[one.profile] < PROFILE_RANK[wb.execution.profile]
  if (one.op === 'pause') return !one.on && wb.execution.isPaused

  return false
}

/**
 * Whether the person must answer in the session before a setting applies: it makes the guard watch less, directly (a lower profile,
 * resuming) or because it lets Codex's reviews run without asking (Codex on, or team mode on while Codex is already on).
 */
export function needsAnswer(wb: Workbench, one: SettingOp): boolean {
  if (isPolicyEditOp(one)) return false
  // Approving a change to a locked contract goes past the lock: the person confirms it in the session as well.
  if (one.op === 'proposal_decide') return one.accept && wb.task.locked
  if (lowersGuard(wb, one)) return true
  if (one.op === 'codex') return one.enabled && !codexOf(wb.team).enabled
  if (one.op === 'team_enabled') return one.enabled && wb.team?.enabled !== true && codexOf(wb.team).enabled

  return false
}

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
export function applyOps(wb: Workbench, ops: readonly (DeskOp | SettingOp)[]): { wb: Workbench; reason?: undefined } | { reason: string } {
  let cur = wb
  for (const one of ops) {
    if (isSettingOp(one)) return { reason: 'a setting goes alone' }
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
