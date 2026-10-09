export type TaskStatus = 'draft' | 'active' | 'verifying' | 'complete'

export type Constraint = {
  id: string
  text: string
  priority: 'hard' | 'soft'
  isActive: boolean
}

export type EvidenceKind = 'test' | 'build' | 'typecheck' | 'lint' | 'ci'

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

export type FileCategory = 'source' | 'test' | 'config' | 'docs' | 'generated' | 'secret'

export type Observed = { path: string; how: 'read' | 'edited'; count?: number; lastAt?: number }

// One changed region of a file against HEAD, in the file's new line numbers.
export type Hunk = { from: number; to: number; added: number; removed: number }

export type Changed = {
  files: string[]
  added: number
  removed: number
  // Last time SmartWorkbench saw each file edited by a tool call.
  edits?: Record<string, number>
  hunks?: Record<string, Hunk[]>
}

// A checked-in rule from .claude/smartworkbench.json; the first match decides.
export type ProjectRule = {
  tool?: string
  command?: string
  path?: string
  policy: Policy
  reason?: string
}

// A team template from the checked-in file: the contract without its results.
export type TeamTemplate = {
  name: string
  goal?: string
  constraints: { text: string; priority: 'hard' | 'soft' }[]
  nonGoals: string[]
  doneConditions: { text: string; link?: EvidenceKind }[]
}

export type AuditConfig = { path: string }

export type ProjectPolicy = {
  source: string
  profile?: GuardProfile
  templates: TeamTemplate[]
  defaultTemplate?: string
  audit?: AuditConfig
  // Prompts are held back until a locked contract with done conditions exists.
  requireContract?: boolean
  rules: ProjectRule[]
  errors: string[]
}

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
  category?: string
  reason?: string
  // Asked once, then allowed for the rest of the session.
  sessionAllowed?: true
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
  issue?: IssueRef
}

// A change Claude asked for through propose_contract_change; only the person applies it.
export type ProposalChange = 'set_goal' | 'add_constraint' | 'remove_constraint' | 'add_done_condition' | 'remove_done_condition' | 'add_non_goal'

export type Proposal = {
  id: string
  change: ProposalChange
  text?: string
  target?: string
  reason: string
  at: number
  status: 'open' | 'approved' | 'rejected'
}

// The tracker item a task is for: a GitHub issue or any tracker's key and title.
export type IssueRef = { ref: string; title?: string; url?: string }

export type Workbench = {
  schemaVersion: 1
  // Bumped on every save, with the session that saved, so sessions can see each other's changes.
  rev?: number
  savedBy?: string
  task: Task
  context: { pins: ContextPin[]; observed: Observed[]; excluded?: string[] }
  execution: { profile: GuardProfile; isPaused: boolean; recentCalls: ToolCallRecord[] }
  evidence: EvidenceRecord[]
  changed: Changed
  proposals?: Proposal[]
  // Team mode: Sonnet builds, Haiku explores, Opus reviews.
  team?: TeamConfig
}

export type TeamRoleName = 'lead' | 'explorer' | 'advisor'

// A model alias or id (sonnet, opus[1m], claude-haiku-4-5-20251001) and an effort level.
export type TeamRole = { model: string; effort: string }

export type TeamConfig = {
  enabled: boolean
  lead?: TeamRole
  explorer?: TeamRole
  advisor?: TeamRole
}

export type Tab = 'intent' | 'context' | 'run' | 'evidence' | 'team'

export type Live = {
  activeTab: Tab
  isPreviewOpen: boolean
  contextPercent?: number
  contextTokens?: number
  contextWindow?: number
  pinWarnings: string[]
  lastSummary?: string
  policy?: ProjectPolicy
  sessionId?: string
  user?: string
  // What the person chose "Allow for session" for; gone when the session ends.
  sessionAllows?: SessionAllow[]
  // Text typed into the panel's fields and not yet submitted, by field key.
  drafts?: Record<string, string>
  // The last turn's completion, shown in the band until dismissed or the next prompt.
  turnResult?: { met: number; total: number; failing: number }
  track?: Track
  // A running /swb loop; session-only, so a restart never resumes one by surprise.
  loop?: LoopState
  // A prompt a command wants sent; the host refuses a submit from inside a command, so the turn's end sends it.
  pendingPrompt?: string
}

// What /swb loop repeats. limit null = until stopped; continuing = the last stop was held for the next pass;
// pending = started by the command, first pass not sent yet (a command cannot submit a prompt itself).
export type LoopState = {
  items: string[]
  limit: number | null
  done: number
  startedAt: number
  continuing?: boolean
  pending?: boolean
  // When the current pass began, and how many passes in a row changed no file.
  passAt?: number
  idle?: number
}

export type SessionAllow = { key: string; label: string; at: number }

// What team mode watches in this session: repeated failures and when the advisor last ran.
export type Track = {
  failures: Record<string, number>
  // Keys Claude was already pointed at the advisor for; cleared when the advisor runs.
  nudged: string[]
  lastAdvisorAt?: number
  turnStartedAt?: number
  advisorRuns: number
  // Design first: the advisor run that counts as this work's design must be at or after designFrom.
  designFrom?: number
  designDeniedAt?: number
  planReviewDeniedAt?: number
  planApprovedAt?: number
  // Edits made in this turn without a design, to keep many small edits from adding up to a big one.
  turnEdits?: { files: string[]; lines: number }
}

declare module 'claude-code' {
  interface PluginState {
    smartworkbench: { wb: Workbench; live: Live; badges: Record<string, string> }
  }
}
