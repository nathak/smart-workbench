// Team mode: Sonnet builds, Haiku explores, Opus reviews. Pure decisions only;
// register.tsx registers the agents and applies these at the hooks.
import type { TeamConfig, TeamRole, TeamRoleName, Track } from '../types'
import { commandPrefix, splitCommand } from './risk'

export const EXPLORER = 'smartworkbench:explorer'
export const ADVISOR = 'smartworkbench:advisor'

export const ROLES: readonly TeamRoleName[] = ['lead', 'explorer', 'advisor']

// The lead's effort is Claude Code's /effort, which it saves as the default for that model,
// so it starts at 'default' (left alone) and changes only when the person picks a level.
export const DEFAULT_ROLES: Record<TeamRoleName, TeamRole> = {
  lead: { model: 'sonnet', effort: 'default' },
  explorer: { model: 'haiku', effort: 'low' },
  advisor: { model: 'opus', effort: 'high' },
}

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export const LEAD_EFFORTS = ['default', ...EFFORTS] as const
export const AGENT_MODELS = ['haiku', 'sonnet', 'opus', 'fable', 'inherit'] as const

export function roleOf(team: TeamConfig | undefined, role: TeamRoleName): TeamRole {
  return team?.[role] ?? DEFAULT_ROLES[role]
}

export function setRole(team: TeamConfig | undefined, role: TeamRoleName, change: Partial<TeamRole>): TeamConfig {
  return { enabled: team?.enabled ?? false, ...team, [role]: { ...roleOf(team, role), ...change } }
}

// The agent definition for a role, with the model and effort the person chose.
export function agentSpec(role: 'explorer' | 'advisor', team: TeamConfig | undefined) {
  const base = role === 'explorer' ? EXPLORER_SPEC : ADVISOR_SPEC
  const { model, effort } = roleOf(team, role)

  return { ...base, model, effort }
}

// How many failures in a row of the same command before Claude is pointed at the advisor.
export const REPEAT_LIMIT = 2

export const EXPLORER_SPEC = {
  name: 'explorer',
  description:
    'Fast read-only explorer (Haiku). Delegate finding files, reading code and searching docs; launch several at once for independent questions. Returns findings with file paths and line numbers, never edits.',
  prompt: [
    'You are a fast, read-only explorer working for a lead engineer.',
    'Answer exactly the question you were given by reading files, searching code and, when asked, reading documentation.',
    'Report findings, not narration: file paths with line numbers, short quotes of the relevant code, and what you could not find.',
    'Keep it under 300 words unless the question needs a list. Never edit files and never guess at code you did not read.',
  ].join('\n'),
  tools: ['Read', 'Grep', 'Glob', 'LS', 'WebFetch', 'WebSearch'],
  model: 'haiku',
  maxTurns: 25,
} as const

export const ADVISOR_SPEC = {
  name: 'advisor',
  description:
    'Senior designer and reviewer (Opus). Ask it for a DESIGN before non-trivial edits, to break an error that keeps repeating, or for a final check before you finish. Give it a focused brief (goal, constraints, known paths, or the error and what you tried), not the whole conversation.',
  prompt: [
    'You are a senior engineer who designs the work; a lead implements exactly what you design.',
    'Read only the files you need to ground the answer in real code (cite path:line); never edit.',
    'If asked to design (or to re-design after the code did not match), answer in this shape:',
    'DESIGN:',
    'APPROACH: the chosen approach and why; one or two alternatives rejected.',
    'FILES: each path to change and what changes there.',
    'STEPS: ordered, each small enough to verify on its own.',
    'RISKS: what could break, most likely first.',
    'DONE: the checks that prove it works (commands, tests).',
    'If asked to diagnose an error or to check finished work, answer in this shape:',
    'VERDICT: go / go with changes / stop',
    'BLOCKERS: what must change first, each with the reason and where (path:line). "none" if none.',
    'RISKS: what could still go wrong, most likely first.',
    'MISSING: requirements, edge cases, tests or done conditions not covered.',
    'Be specific and brief; skip praise and restating the brief.',
  ].join('\n'),
  tools: ['Read', 'Grep', 'Glob', 'LS'],
  model: 'opus',
  maxTurns: 25,
} as const

// Added to every prompt while team mode is on; fixed text, so the prompt cache keeps it.
export const TEAM_CONTEXT = [
  '<smartworkbench_team>',
  `  You lead this session and write the code. Delegate exploration (finding files, reading code, searching docs) to ${EXPLORER}, several in parallel when the questions are independent.`,
  `  ${ADVISOR} (Opus) designs; you implement. Before any non-trivial edit (more than a few lines or more than one file), ask it for a DESIGN with a focused brief (goal, constraints, known paths) and follow it. If reality contradicts the design, go back to it instead of improvising. Also consult it when an error keeps repeating and for a final check before finishing.`,
  '</smartworkbench_team>',
].join('\n')

// Failures are counted per command (by command and subcommand) or per tool and target.
export function failureKey(tool: string, input: Record<string, unknown>): string {
  if (tool === 'Bash') {
    const prefixes = splitCommand(String(input.command ?? '')).map(commandPrefix).filter(Boolean)
    return `bash:${[...new Set(prefixes)].sort().join(' && ')}`
  }
  const target = input.file_path ?? input.notebook_path ?? input.url ?? input.pattern ?? ''

  return `${tool}:${String(target)}`
}

export const EMPTY_TRACK: Track = { failures: {}, nudged: [], advisorRuns: 0 }

// A failure counts toward the limit; a success of the same command clears it.
export function trackResult(track: Track, key: string, isOk: boolean): { track: Track; nudge: boolean } {
  if (isOk) {
    const { [key]: _gone, ...failures } = track.failures
    return { track: { ...track, failures, nudged: track.nudged.filter(one => one !== key) }, nudge: false }
  }

  const count = (track.failures[key] ?? 0) + 1
  const nudge = count >= REPEAT_LIMIT && !track.nudged.includes(key)

  return {
    track: { ...track, failures: { ...track.failures, [key]: count }, nudged: nudge ? [...track.nudged, key] : track.nudged },
    nudge,
  }
}

export function advisorRan(track: Track, at: number): Track {
  return { ...track, failures: {}, nudged: [], lastAdvisorAt: at, advisorRuns: track.advisorRuns + 1 }
}

export function repeatNudge(count: number): string {
  return `SmartWorkbench team mode: this has now failed ${count} times in a row. Before trying again, consult ${ADVISOR} with the exact error output, what you already tried and the relevant file paths, and follow its diagnosis.`
}

// A plan goes to the user only after the advisor looked at it in this turn.
export function needsPlanReview(track: Track): boolean {
  return (track.lastAdvisorAt ?? -1) < (track.turnStartedAt ?? 0)
}

export const PLAN_REVIEW =
  `SmartWorkbench team mode: plans come from ${ADVISOR}, not from you. If it has not designed this work yet, send it the goal, constraints and known paths and ask for a DESIGN. Present that design as the plan, with only the changes it agreed to, then call ExitPlanMode again.`

// The turn may end once code edited in it has been through a final advisor check.
export function needsFinalCheck(track: Track, lastEditAt: number | undefined, isRepeatStop: boolean): boolean {
  if (isRepeatStop || lastEditAt === undefined) return false
  if (lastEditAt < (track.turnStartedAt ?? 0)) return false

  return (track.lastAdvisorAt ?? 0) < lastEditAt
}

export function finalCheckReason(goal: string, conditions: readonly string[]): string {
  const what = goal.trim() ? ` Goal: ${goal.trim()}.` : ''
  const done = conditions.length > 0 ? ` Done conditions: ${conditions.join('; ')}.` : ''

  return `SmartWorkbench team mode: before finishing, run a final check with ${ADVISOR}.${what}${done} Give it the goal, the files you changed and the check results; fix what it finds or say why not, then finish.`
}

export function advisePrompt(topic: string): string {
  const about = topic.trim() || 'the current state of the task: is anything wrong, risky or missing?'

  return `Consult ${ADVISOR} (Opus) about: ${about}\nGive it a focused brief (goal, relevant decisions or errors, what you tried, file paths), then tell me its verdict and what you will do about it.`
}


// ---- design first: the lead implements, the advisor designs

// An edit this small needs no design; the limits also cap many small edits adding up to a big one.
export const SMALL_EDIT_LINES = 6
export const SMALL_EDIT_CHARS = 400
export const SMALL_TURN_LINES = 15

export type EditSize = { lines: number; chars: number; isBulk: boolean }

const lineCount = (text: unknown): number => (typeof text === 'string' && text !== '' ? text.split('\n').length : 0)
const charCount = (text: unknown): number => (typeof text === 'string' ? text.length : 0)

export function editSize(tool: string, input: Record<string, unknown>): EditSize {
  const bigger = (a: unknown, b: unknown) => ({ lines: Math.max(lineCount(a), lineCount(b)), chars: Math.max(charCount(a), charCount(b)) })

  if (tool === 'Write') return { lines: lineCount(input.content), chars: charCount(input.content), isBulk: false }
  if (tool === 'NotebookEdit') return { lines: lineCount(input.new_source), chars: charCount(input.new_source), isBulk: false }

  if (tool === 'MultiEdit') {
    const edits = Array.isArray(input.edits) ? (input.edits as Record<string, unknown>[]) : []
    const parts = edits.map(one => bigger(one.old_string, one.new_string))

    return { lines: parts.reduce((sum, one) => sum + one.lines, 0), chars: parts.reduce((sum, one) => sum + one.chars, 0), isBulk: edits.some(one => one.replace_all === true) }
  }

  return { ...bigger(input.old_string, input.new_string), isBulk: input.replace_all === true }
}

// One small edit to one file, and the edits made in this turn without a design stay small together.
export function isSmallEdit(track: Track, path: string, size: EditSize): boolean {
  if (size.isBulk || size.lines > SMALL_EDIT_LINES || size.chars > SMALL_EDIT_CHARS) return false

  const edits = track.turnEdits ?? { files: [], lines: 0 }
  const files = edits.files.includes(path) ? edits.files : [...edits.files, path]

  return files.length <= 1 && edits.lines + size.lines <= SMALL_TURN_LINES
}

// A design from this turn (or the one a plan approval or a loop carries forward) covers the edit;
// otherwise the first big edit of a turn is sent back once.
export function needsDesign(track: Track, isSmall: boolean): boolean {
  if (isSmall) return false
  if ((track.designDeniedAt ?? -1) >= (track.turnStartedAt ?? 0)) return false

  return (track.lastAdvisorAt ?? -1) < (track.designFrom ?? track.turnStartedAt ?? 0)
}

export function noteEdit(track: Track, path: string, lines: number): Track {
  const edits = track.turnEdits ?? { files: [], lines: 0 }

  return { ...track, turnEdits: { files: edits.files.includes(path) ? edits.files : [...edits.files, path], lines: edits.lines + lines } }
}

// keepDesign: this turn continues work that already has a design (a loop pass, the turn after a plan was approved).
export function turnStart(track: Track, at: number, keepDesign: boolean): Track {
  const { turnEdits: _cleared, ...rest } = track

  return { ...rest, turnStartedAt: at, designFrom: keepDesign ? (track.designFrom ?? at) : at }
}

export function planWasApproved(track: Track): boolean {
  return track.planApprovedAt !== undefined && track.planApprovedAt >= (track.turnStartedAt ?? 0)
}

export const DESIGN_FIRST =
  `SmartWorkbench team mode: this edit is not small (more than a few lines or a second file), and no design from ${ADVISOR} exists for this work. Ask it for a DESIGN: send the goal, constraints and the paths you know. Then implement that design step by step. If the code does not match it, stop and go back to the advisor with what differed. (Asked once per turn.)`
