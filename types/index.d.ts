export type TaskStatus = 'draft' | 'active' | 'verifying' | 'complete'

export type Constraint = {
  id: string
  text: string
  priority: 'hard' | 'soft'
  isActive: boolean
}

export type EvidenceKind = 'test' | 'build' | 'typecheck' | 'lint'

export type ConditionStatus = 'pending' | 'observed' | 'verified' | 'failed' | 'waived'

export type ManualMark = {
  status: 'verified' | 'failed' | 'waived'
  note: string
  at: number
}

export type DoneCondition = {
  id: string
  text: string
  link?: EvidenceKind
  manual?: ManualMark
}

export type LineRange = { from: number; to: number }

export type Snapshot = { text: string; sha256: string; at: number }

export type ContextPin =
  | { id: string; kind: 'file'; path: string; mode: 'live' | 'snapshot'; lines?: LineRange; snapshot?: Snapshot }
  | { id: string; kind: 'note'; text: string }

// A reusable task setup: the contract without its results, plus pins and guard profile.
export type Template = {
  name: string
  savedAt: number
  goal: string
  constraints: Constraint[]
  nonGoals: string[]
  doneConditions: { text: string; link?: EvidenceKind }[]
  pins: ContextPin[]
  profile: GuardProfile
}

export type Observed = { path: string; how: 'read' | 'edited' }

export type Risk = 'low' | 'medium' | 'high'

export type Policy = 'allow' | 'ask' | 'block'

export type GuardProfile = 'permissive' | 'balanced' | 'strict'

export type CallOutcome = 'running' | 'ok' | 'error' | 'blocked' | 'declined'

export type ToolCallRecord = {
  id: string
  tool: string
  summary: string
  risk: Risk
  policy: Policy
  reason?: string
  outcome: CallOutcome
  startedAt: number
  durationMs?: number
  agentId?: string
}

export type EvidenceRecord = {
  id: string
  kind: EvidenceKind
  command: string
  ok: boolean | null
  at: number
}

export type Task = {
  id: string
  status: TaskStatus
  locked: boolean
  goal: string
  constraints: Constraint[]
  nonGoals: string[]
  doneConditions: DoneCondition[]
}

export type Workbench = {
  schemaVersion: 1
  task: Task
  context: { pins: ContextPin[]; observed: Observed[] }
  execution: { profile: GuardProfile; isPaused: boolean; recentCalls: ToolCallRecord[] }
  evidence: EvidenceRecord[]
  changed: { files: string[]; added: number; removed: number }
}

export type Tab = 'intent' | 'context' | 'run' | 'evidence'

export type Live = {
  activeTab: Tab
  isPreviewOpen: boolean
  contextPercent?: number
  contextTokens?: number
  contextWindow?: number
  pinWarnings: string[]
  lastSummary?: string
}

declare module 'claude-code' {
  interface PluginState {
    smartworkbench: { wb: Workbench; live: Live; badges: Record<string, string> }
  }
}
