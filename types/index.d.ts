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

// What a condition expects of the run that checks it. It only ever makes the verdict stricter: a condition is never verified by it.
// A person's own mark and a missing link are not touched. setBy tells who wrote it; Claude may not change one the person wrote.
export type Expectation = {
  // The latest run of the linked kind must contain this plain text in its command (no pattern), up to 80 characters.
  cmd?: string
  // Test counts from the run's own summary line: at least `min` passed, at most `failedMax` failed.
  tests?: { min?: number; failedMax?: number }
  setBy: 'user' | 'claude'
  at: number
  // Claude's one line on why, masked.
  reason?: string
}

export type DoneCondition = {
  id: string
  text: string
  link?: EvidenceKind
  manual?: ManualMark
  expect?: Expectation
}

export type LineRange = { from: number; to: number }

// sliced: text holds only the pin's line range, not the whole file.
export type Snapshot = { text: string; sha256: string; at: number; sliced?: true }

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
  // "ledger": { "share": "off" } forbids publishing the decision ledger; no setting publishes by itself.
  ledger?: { share?: 'off'; wiki?: 'off' }
  rules: ProjectRule[]
  // Where each parsed rule sits in the file's own "rules" list (a broken rule is skipped, so the two differ), and the file's sha256.
  ruleAt?: number[]
  hash?: string
  errors: string[]
}

export type Risk = 'low' | 'medium' | 'high'

export type Policy = 'allow' | 'ask' | 'block'

// 'off' is only ever the person's own choice: a guard file, a template or a shared task cannot set it.
export type GuardProfile = 'off' | 'permissive' | 'balanced' | 'strict'

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
  // Test counts read from the run's own summary line (never the output itself), for a test run whose outcome was settled.
  facts?: { passed?: number; failed?: number; total?: number; line?: string }
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
  // When a per-session copy was last saved (session scope only); old copies are swept.
  savedAt?: number
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

// A model alias or id (sonnet, opus[1m], claude-haiku-5-5) and an effort level.
export type TeamRole = { model: string; effort: string }

// What team mode may do with the OpenAI Codex plugin. Off by default: Codex sends code to OpenAI.
export type CodexConfig = { enabled: boolean; review: boolean; rescue: boolean }

export type TeamConfig = {
  enabled: boolean
  codex?: CodexConfig
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
  // The evidence ids of failed expectations the finish check already held a turn for (a repeat is not held again).
  expectHeld?: string[]
  // The last stop was held for an expectation alone: the stop after it is not a repeat of a final check.
  expectHoldOnly?: boolean
  // The subscription rate-limit windows the last response reported (empty off a subscription), as the live feed carries them.
  rateLimits?: { kind: 'five_hour' | 'seven_day' | 'spend_limit'; pct: number; resetsAt?: number }[]
  // Why the live feed could not be written, while it cannot; session-only.
  feedError?: string
  // /swb live --no-prompts: the feed keeps only the 120-character start of a prompt, not its text.
  livePrompts?: false
  pinWarnings: string[]
  lastSummary?: string
  policy?: ProjectPolicy
  sessionId?: string
  // Whether this session keeps its own workbench and live feed (/swb scope); fixed at session start.
  scope?: 'project' | 'session'
  user?: string
  // The Codex plugin's companion script found at session start (null = looked, not found); session-only.
  codexPath?: string | null
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
  // Hash of the git working tree when the last pass ended (infinite loops in a git repository only), to see edits made by shell commands.
  treeHash?: string
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
  // The last Codex review this session and how many ran.
  codexAt?: number
  // HEAD when the turn started: what a Codex review of work that was committed in the turn compares against (--base).
  turnHead?: string
  codexRuns?: number
  // The last Codex rescue task, at most one per turn.
  codexTaskAt?: number
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
