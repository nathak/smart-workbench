// Team mode: Sonnet builds, Haiku explores, Opus reviews. Pure decisions only;
// register.tsx registers the agents and applies these at the hooks.
import type { Track } from '../types'
import { commandPrefix, splitCommand } from './risk'

export const EXPLORER = 'smartworkbench:explorer'
export const ADVISOR = 'smartworkbench:advisor'

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
    'Senior reviewer (Opus). Use only to review a plan before building it, to break an error that keeps repeating, or for a final check that nothing is missing before you finish. Give it a focused brief (goal, plan or error, what you tried, relevant paths), not the whole conversation.',
  prompt: [
    'You are a senior engineer advising a lead who writes the code. You are called only for decisions that matter: a plan review, an error that keeps repeating, or a final check before finishing.',
    'Work from the brief you are given. Read only the files you need to confirm or refute a point; do not explore broadly and never edit.',
    'Answer in this shape:',
    'VERDICT: go / go with changes / stop',
    'BLOCKERS: what must change first, each with the reason and where (path:line). "none" if none.',
    'RISKS: what could still go wrong, most likely first.',
    'MISSING: requirements, edge cases, tests or done conditions not covered.',
    'Be specific and brief; skip praise and restating the brief.',
  ].join('\n'),
  tools: ['Read', 'Grep', 'Glob', 'LS'],
  model: 'opus',
  maxTurns: 15,
} as const

// Added to every prompt while team mode is on; fixed text, so the prompt cache keeps it.
export const TEAM_CONTEXT = [
  '<smartworkbench_team>',
  `  You lead this session and write the code. Delegate exploration (finding files, reading code, searching docs) to ${EXPLORER}, several in parallel when the questions are independent.`,
  `  Consult ${ADVISOR} (Opus) only to review a plan before building it, when an error keeps repeating, or for a final check before finishing. Give it a focused brief, not the conversation.`,
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
  `SmartWorkbench team mode: before presenting this plan, have ${ADVISOR} review it. Send it the goal, the plan and the files it touches; address its blockers, then call ExitPlanMode again with the revised plan.`

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
