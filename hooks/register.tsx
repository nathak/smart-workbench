import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, Register, RenderElement } from 'claude-code'

import type { ConditionStatus, ContextPin, EvidenceKind, EvidenceRecord, GuardProfile, Live, Proposal, ProposalChange, Tab, TeamRoleName, Template, ToolCallRecord, Track, Workbench } from '../types'
import * as crew from './crew'
import * as loop from './loop'
import { PROPOSE_TOOL } from './intent'
import { estimateTokens, injectionOf, pinText, rangeLabel, sha256, type Injection, type PinContent } from './context'
import { coverageOf, hunkLabel, lastCheckedEdit, lastEdit as lastAnyEdit, parseDiff, type Coverage } from './diff'
import { checkOutcome, completionOf, evidenceKindOf, isStale, latestOf, markOf, statusOf, turnSummary } from './evidence'
import { affectsChecks, categoryOf, suggestionsOf } from './files'
import * as model from './model'
import { POLICY_PATH, POLICY_TEMPLATE, applyRule, matchRule, parsePolicy } from './policy'
import { SHARE_PATH, appendAudit, auditLine, ciEvidence, ciSummary, formatAudit, issueRef, parseIssueArg, readAudit, readShare, shareText, type GhRun } from './team'
import { badgeOf, handoffMarkdown } from './report'
import { classify, decide, sessionScope, summarize } from './risk'

type $ = EngineInterface
type Els = Elements['terminal'] | Elements['desktop'] | Elements['vscode']
type View = { els: Els; wb: Workbench; live: Live; width: number; room: number }

const PANE = 'smartworkbench'
const TABS: readonly Tab[] = ['intent', 'context', 'run', 'evidence', 'team']
const TAB_LABEL: Record<Tab, string> = { intent: 'Intent', context: 'Context', run: 'Run', evidence: 'Evidence', team: 'Team' }
const TAB_ARGS: Record<string, Tab> = { intent: 'intent', context: 'context', run: 'run', verify: 'evidence', evidence: 'evidence' }
const LINKS: readonly (EvidenceKind | 'none')[] = ['none', 'test', 'build', 'typecheck', 'lint', 'ci']
const STATUS_COLOR: Record<ConditionStatus, string | undefined> = {
  pending: undefined,
  observed: 'warning',
  verified: 'success',
  failed: 'error',
  waived: 'inactive',
}
const HELP = [
  'SmartWorkbench commands:',
  '  /smartworkbench            open the panel',
  '  /smartworkbench new        start a new task contract',
  '  /smartworkbench context    open the Context tab',
  '  /smartworkbench run        open the Run tab',
  '  /smartworkbench verify     open the Evidence tab',
  '  /smartworkbench lock | unlock   lock the contract (added to every prompt) or unlock it to edit',
  '  /smartworkbench team [on|off]   team mode: Opus designs and reviews, Sonnet builds, Haiku explores',
  '  /smartworkbench advise [topic]  ask the Opus advisor now',
  '  /smartworkbench loop <count|inf> <item>[; <item>...]   repeat a task; works with team mode (loop stop | loop status)',
  '  /smartworkbench status     text summary (works without UI)',
  '  /smartworkbench preview    show the context added to each prompt',
  '  /smartworkbench save <name>      save the contract, pins and guard as a template',
  '  /smartworkbench load <name>      start a task from a template',
  '  /smartworkbench templates        list templates and context sets',
  '  /smartworkbench export [path]    write a Markdown handoff (default .claude/smartworkbench-handoff.md)',
  '  /smartworkbench policy [init|reload]  show, create or re-read the project guard file (.claude/smartworkbench.json)',
  '  /smartworkbench ci               import CI results for the current commit (uses the gh CLI)',
  '  /smartworkbench issue <#n|url|KEY title>  link the task to an issue; issue clear unlinks',
  '  /smartworkbench share [path]     write the task to .claude/smartworkbench-task.json for another machine',
  '  /smartworkbench pickup [path]    take over a task shared that way',
  '  /smartworkbench audit [n]        show the last n audit entries (when the guard file turns audit on)',
  "  /smartworkbench clear      reset this project's workbench",
  'Alias: /swb (/workbench is deprecated).',
].join('\n')

const wbAtom = atom({ plugin: 'smartworkbench', key: 'wb' } as const, model.emptyWorkbench())
const liveAtom = atom({ plugin: 'smartworkbench', key: 'live' } as const, model.EMPTY_LIVE)
const badgesAtom = atom({ plugin: 'smartworkbench', key: 'badges' } as const, {} as Record<string, string>)
const MAX_BADGES = 200
const MAX_SNAPSHOT = 64 * 1024
const HANDOFF_PATH = '.claude/smartworkbench-handoff.md'

// ---- state: $.state for drawing, $.store (per project) to survive restarts

async function storeKey($: $): Promise<string> {
  return `ws:${await $.session.cwd()}`
}

async function load($: $): Promise<Workbench> {
  const restored = model.restore(await $.store.get(await storeKey($)))
  await update($, wbAtom, () => restored)

  return restored
}

// Every save builds on the newest copy: when another session of this project saved
// since this one last did, its state is taken first, so neither overwrites the other.
async function mutate($: $, change: (wb: Workbench) => Workbench): Promise<Workbench> {
  const key = await storeKey($)
  const saved = await $.store.get(key)
  const { sessionId } = await read($, liveAtom)
  const before = await read($, wbAtom)
  const savedRev = model.isWorkbench(saved) ? (saved.rev ?? 0) : 0
  const next = await update($, wbAtom, wb => {
    const base = model.isNewerElsewhere(saved, wb, sessionId) ? model.fill(saved) : wb
    const changed = model.withStatus(change(base))

    return { ...changed, rev: Math.max(base.rev ?? 0, savedRev) + 1, ...(sessionId ? { savedBy: sessionId } : {}) }
  })
  await $.store.set(key, next)

  if (before.task.status !== 'complete' && next.task.status === 'complete') {
    await audit($, 'task.complete', { goal: next.task.goal, conditions: next.task.doneConditions.length })
  }

  return next
}

// Takes another session's newer save before a prompt, so this one works from the same contract.
async function pull($: $): Promise<void> {
  const saved = await $.store.get(await storeKey($))
  const { sessionId } = await read($, liveAtom)

  if (model.isNewerElsewhere(saved, await read($, wbAtom), sessionId)) {
    await update($, wbAtom, () => model.fill(saved))
    $.ui.toast('SmartWorkbench: picked up changes made in another session')
  }
}

// Live feed for tools/live.mjs: one JSON line per event, written only while that server keeps the file in place.
// Never throws and costs one fs.exists per event when nobody watches.
const LIVE_FILE = '.claude/smartworkbench-live.jsonl'

async function emit($: $, kind: string, detail: Record<string, unknown> = {}): Promise<void> {
  try {
    const path = `${await $.session.cwd()}/${LIVE_FILE}`
    if (!(await $.fs.exists(path))) return
    const session = (await read($, liveAtom)).sessionId
    const line = JSON.stringify({ at: await $.clock.now(), kind, ...(session ? { session } : {}), ...detail })
    await $.process.run(['sh', '-c', 'printf "%s\\n" "$1" >> "$2"', 'sh', line, path])
  } catch {
    // The feed is optional.
  }
}

// Appends to the audit log when the project guard file turns it on; never throws, so a
// failed write can never let a guarded call through.
async function audit($: $, event: string, detail: Record<string, unknown> = {}): Promise<void> {
  await emit($, event, detail)
  try {
    const live = await read($, liveAtom)
    const config = live.policy?.audit
    if (!config) return
    const at = new Date(await $.clock.now()).toISOString()
    const line = auditLine({ at, event, ...(live.user ? { user: live.user } : {}), ...(live.sessionId ? { session: live.sessionId } : {}), ...detail })
    const { text, rotated } = appendAudit(await $.fs.read(config.path).catch(() => undefined), line)
    if (rotated !== undefined) {
      await $.fs.write(`${config.path}.1`, rotated)
    }
    await $.fs.write(config.path, text)
  } catch (error) {
    $.ui.log(`SmartWorkbench: audit write failed: ${error instanceof Error ? error.message : String(error)}`, { to: 'debug' })
  }
}

async function setLive($: $, change: (live: Live) => Live): Promise<void> {
  await update($, liveAtom, change)
}

// Reads each Live pin now, so the prompt carries the file as it is at send time.
async function injection($: $, wb: Workbench): Promise<Injection> {
  const contents: PinContent[] = []

  for (const pin of wb.context.pins) {
    if (pin.kind === 'note' || (pin.mode === 'snapshot' && pin.snapshot)) {
      contents.push({ pin })
      continue
    }
    try {
      contents.push({ pin, text: await $.fs.read(pin.path) })
    } catch (error) {
      contents.push({ pin, error: error instanceof Error ? error.message : String(error) })
    }
  }

  return injectionOf(wb.task, contents)
}

async function refreshUsage($: $): Promise<void> {
  const { context } = await $.session.usage()
  await setLive($, live => ({ ...live, contextPercent: context.percent, contextTokens: context.tokens, contextWindow: context.window }))
}

async function openPane($: $, tab?: Tab): Promise<boolean> {
  if (tab) {
    await setLive($, live => ({ ...live, activeTab: tab }))
  }

  return (await $.ui.open({ id: PANE, title: 'SmartWorkbench' })).isPlaced
}

async function stamp($: $, id: string, status: 'verified' | 'waived' | 'auto', note: string): Promise<void> {
  const at = await $.clock.now()
  const wb = await mutate($, current => model.markCondition(current, id, status, note, at))
  const condition = wb.task.doneConditions.find(one => one.id === id)
  await audit($, status === 'auto' ? 'condition.unmark' : `condition.${status}`, { condition: id, text: condition?.text ?? '', note })
}

// Panel fields are controlled: what is typed lives in session state, so a submit always
// clears the field and the keyboard stays on it for the next entry.
async function setDraft($: $, key: string, value: string | undefined): Promise<void> {
  await setLive($, live => {
    const { [key]: _old, ...rest } = live.drafts ?? {}
    return { ...live, drafts: value === undefined ? rest : { ...rest, [key]: value } }
  })
}

async function submitDraft($: $, key: string, action: () => Promise<unknown>): Promise<void> {
  await action()
  await setDraft($, key, undefined)
  await $.ui.focus({ requestId: PANE, key }).catch(() => undefined)
}

async function allowForSession($: $, key: string, label: string): Promise<void> {
  const at = await $.clock.now()
  await setLive($, live => ({
    ...live,
    sessionAllows: [...(live.sessionAllows ?? []).filter(one => one.key !== key), { key, label, at }],
  }))
}

async function revokeSessionAllow($: $, key: string): Promise<void> {
  const live = await read($, liveAtom)
  const gone = (live.sessionAllows ?? []).find(one => one.key === key)
  await setLive($, current => ({ ...current, sessionAllows: (current.sessionAllows ?? []).filter(one => one.key !== key) }))
  if (gone) await audit($, 'guard.session-revoke', { scope: gone.label })
}

const CHANGES: readonly ProposalChange[] = ['set_goal', 'add_constraint', 'remove_constraint', 'add_done_condition', 'remove_done_condition', 'add_non_goal']
const CHECK_KINDS: readonly EvidenceKind[] = ['test', 'build', 'typecheck', 'lint']

// Claude's side of a contract change: recorded as an open proposal for the person.
// The tool's result is a string: the engine checks plugin tool results against a text output.
async function propose($: $, input: Record<string, unknown>): Promise<{ result: string }> {
  const change = CHANGES.find(one => one === input.change)
  const text = typeof input.text === 'string' ? input.text.trim() : ''
  const target = typeof input.target_id === 'string' ? input.target_id.trim() : ''
  const reason = typeof input.reason === 'string' ? input.reason.trim() : ''
  const needsTarget = change === 'remove_constraint' || change === 'remove_done_condition'

  if (!change || reason === '' || (needsTarget ? target === '' : text === '')) {
    return { result: `rejected: give change (${CHANGES.join(', ')}), reason, and text (or target_id for a removal).` }
  }

  const proposal: Proposal = {
    id: model.newId('pr'),
    change,
    ...(text ? { text } : {}),
    ...(target ? { target } : {}),
    reason,
    at: await $.clock.now(),
    status: 'open',
  }
  await mutate($, wb => model.addProposal(wb, proposal))
  await audit($, 'contract.propose', { change, text, target, reason })
  $.ui.toast(`SmartWorkbench: Claude proposes a contract change (${change.replace(/_/g, ' ')}) · /swb to review`)

  return { result: `recorded as ${proposal.id}: the user will approve or reject it. Keep working within the current contract until they decide.` }
}

async function settleProposal($: $, id: string, approve: boolean): Promise<void> {
  const before = (await read($, wbAtom)).proposals?.find(one => one.id === id)
  await mutate($, wb => model.decideProposal(wb, id, approve))
  if (before) {
    await audit($, approve ? 'contract.proposal-approved' : 'contract.proposal-rejected', { change: before.change, text: before.text ?? before.target ?? '' })
  }
}

// Quick actions on a failed tool row: hand it back to Claude, or count it as a check by hand.
async function explainCall($: $, tool: string, summary: string): Promise<void> {
  await $.prompt.submit({ text: `Explain why this ${tool} call failed and what to do about it:\n${summary}` })
}

async function retryCall($: $, tool: string, summary: string): Promise<void> {
  await $.prompt.submit({ text: `Retry this ${tool} call as it was, then report the result:\n${summary}` })
}

async function countAsCheck($: $, id: string, command: string, isOk: boolean): Promise<void> {
  const kind = await $.ui
    .ask(`Count "${model.cut(command, 60)}" as which check?`, { header: 'Evidence', options: [...CHECK_KINDS] })
    .catch(() => undefined)
  const chosen = CHECK_KINDS.find(one => one === kind)
  if (!chosen) return
  const record: EvidenceRecord = { id, kind: chosen, command: command.slice(0, 200), ok: isOk, at: await $.clock.now() }
  await mutate($, wb => model.upsertEvidence(wb, [record]))
  await audit($, 'evidence.manual', { kind: chosen, command: record.command, ok: isOk })
}

async function clearTurnResult($: $): Promise<void> {
  await setLive($, ({ turnResult: _done, ...rest }) => rest)
}

async function waiveFromBand($: $): Promise<void> {
  const wb = await read($, wbAtom)
  const lastEdit = lastCheckedEdit(wb.changed)
  const unmet = wb.task.doneConditions.filter(one => {
    const status = statusOf(one, wb.evidence, lastEdit)
    return status !== 'verified' && status !== 'waived'
  })
  const [only] = unmet
  if (unmet.length === 1 && only) {
    await waive($, only.id, only.text)
    return
  }
  if (unmet.length === 0 || unmet.length > 4) {
    await openPane($, 'evidence')
    return
  }
  const picked = await $.ui
    .ask('Waive which condition?', { header: 'Waive', options: unmet.map(one => model.cut(one.text, 60)) })
    .catch(() => undefined)
  const condition = unmet.find(one => model.cut(one.text, 60) === picked)
  if (condition) await waive($, condition.id, condition.text)
}

async function updateTrack($: $, change: (track: Track) => Track): Promise<Track> {
  let next = crew.EMPTY_TRACK
  await setLive($, live => {
    next = change(live.track ?? crew.EMPTY_TRACK)
    return { ...live, track: next }
  })

  return next
}

// An agent role's definition carries its model and effort; registering again replaces it.
// A model that refuses the effort setting is registered without it.
async function registerRole($: $, role: 'explorer' | 'advisor'): Promise<string | undefined> {
  const spec = crew.agentSpec(role, (await read($, wbAtom)).team)
  try {
    await $.agent.register(spec)
    return undefined
  } catch (error) {
    const { effort: _effort, ...withoutEffort } = spec
    const retried = await $.agent.register(withoutEffort).then(() => true, () => false)
    $.ui.log(`SmartWorkbench: ${spec.name} with effort ${spec.effort}: ${String(error)}`, { to: 'debug' })
    return retried ? `${spec.model} does not take an effort setting here; ${role} runs at its default effort.` : `could not register ${spec.name}: ${String(error)}`
  }
}

// The session's own effort can only be set by /effort, and a command cannot run another
// command, so from a command it is queued to run right after.
async function applyLeadEffort($: $, effort: string, isDeferred: boolean): Promise<void> {
  if (effort === 'default') return
  const run = async () => {
    await $.command.run({ command: 'effort', args: effort }).catch(error => $.ui.log(`SmartWorkbench: /effort ${effort}: ${String(error)}`, { to: 'debug' }))
  }
  if (isDeferred) {
    $.clock.after(0, run)
  } else {
    await run()
  }
}

async function applyLeadModel($: $, value: string): Promise<boolean> {
  const set = await $.config.set({ key: 'model', value }).catch((error: unknown) => ({ deny: String(error) }))
  return !('deny' in set && set.deny)
}

async function modelRow($: $): Promise<{ value: string; options: string[] } | undefined> {
  const rows = await $.config.list().catch(() => [])
  const row = rows.find(one => one.key === 'model') as { value?: unknown; options?: unknown } | undefined
  if (!row) return undefined

  return { value: String(row.value ?? ''), options: Array.isArray(row.options) ? row.options.map(String) : [] }
}

// Team on: the automatic reviews start, the lead's model and effort become the session's,
// and the previous model is kept to put back when team mode goes off.
async function setTeam($: $, enabled: boolean, isFromCommand = false): Promise<string> {
  const wb = await mutate($, current => ({ ...current, team: { ...current.team, enabled } }))
  await audit($, enabled ? 'team.on' : 'team.off')
  const row = await modelRow($)

  if (!enabled) {
    const previous = await $.store.get('team:previousModel')
    if (row && previous !== undefined && previous !== null) {
      await applyLeadModel($, String(previous))
      await $.store.delete('team:previousModel')
      return `Team mode off: no automatic Opus reviews; the model is back to ${String(previous) || 'the default'}.`
    }
    return 'Team mode off: no automatic Opus reviews; the explorer and advisor agents stay available.'
  }

  const lead = crew.roleOf(wb.team, 'lead')
  if (row && (await $.store.get('team:previousModel')) === undefined) {
    await $.store.set('team:previousModel', row.value)
  }
  const isSet = row ? await applyLeadModel($, lead.model) : false
  await applyLeadEffort($, lead.effort, isFromCommand)
  const explorer = crew.roleOf(wb.team, 'explorer')
  const advisor = crew.roleOf(wb.team, 'advisor')

  return [
    `Team mode on: lead ${lead.model} (${lead.effort}) builds, explorer ${explorer.model} (${explorer.effort}) explores, advisor ${advisor.model} (${advisor.effort}) reviews.`,
    isSet ? 'The session model is set (team off puts the previous model back).' : `Switch the session model with /model ${lead.model}.`,
    `The advisor steps in before a plan is presented, after the same command fails ${crew.REPEAT_LIMIT} times in a row, and before finishing a turn that changed code. Change models and effort in the Team tab (/swb team).`,
  ].join('\n')
}

// From the Team tab or /swb team <role> ...: saved, then applied where it takes effect now.
async function changeRole($: $, role: TeamRoleName, change: { model?: string; effort?: string }, isFromCommand = false): Promise<string> {
  const wb = await mutate($, current => ({ ...current, team: crew.setRole(current.team, role, change) }))
  const now = crew.roleOf(wb.team, role)
  await audit($, 'team.role', { role, model: now.model, effort: now.effort })

  if (role !== 'lead') {
    const note = await registerRole($, role)
    return `${role}: ${now.model} (${now.effort}) from the next delegation${note ? `; ${note}` : '.'}`
  }
  if (!wb.team?.enabled) {
    return `lead: ${now.model} (${now.effort}), applied when team mode is turned on.`
  }
  const isSet = change.model ? await applyLeadModel($, now.model) : true
  if (change.effort) await applyLeadEffort($, now.effort, isFromCommand)
  const saved = change.effort && now.effort !== 'default' ? ` /effort ${now.effort} is kept as your default for this model.` : ''

  return `lead: ${now.model} (${now.effort})${isSet ? '' : `; the model setting refused it, use /model ${now.model}`}.${saved}`
}

async function toggleLock($: $): Promise<void> {
  const wb = await mutate($, model.toggleLock)
  await audit($, wb.task.locked ? 'contract.lock' : 'contract.unlock', { goal: wb.task.goal })
}

// Only on request: asks the local gh CLI for the workflow runs of HEAD.
async function importCi($: $): Promise<string> {
  const head = await $.process.run(['git', 'rev-parse', 'HEAD']).catch(() => undefined)
  if (head?.exitCode !== 0) return 'Not a git repository with a commit; nothing to check.'
  const sha = head.stdout.trim()
  const fields = 'databaseId,workflowName,name,status,conclusion,headSha,url'
  let runs = await $.process.run(['gh', 'run', 'list', '--commit', sha, '--json', fields, '--limit', '30']).catch(() => undefined)
  if (runs?.exitCode !== 0) {
    runs = await $.process.run(['gh', 'run', 'list', '--json', fields, '--limit', '50']).catch(() => undefined)
  }
  if (runs === undefined || runs.exitCode !== 0) {
    return `Could not read CI runs with gh${runs?.stderr ? `: ${runs.stderr.trim().split('\n')[0]}` : ' (is it installed and signed in?)'}`
  }

  let parsed: GhRun[]
  try {
    parsed = JSON.parse(runs.stdout) as GhRun[]
  } catch {
    return 'gh returned something that is not JSON.'
  }
  const status = await $.process.run(['git', 'status', '--porcelain']).catch(() => undefined)
  const hasLocalChanges = (status?.stdout ?? '').split('\n').some(line => line.trim() !== '' && affectsChecks(line.slice(3).trim()))
  const records = ciEvidence(parsed, sha, hasLocalChanges, await $.clock.now())
  await mutate($, wb => model.addCiEvidence(wb, records))

  return ciSummary(records, hasLocalChanges)
}

async function linkIssue($: $, args: string): Promise<string> {
  const wb = await read($, wbAtom)
  if (wb.task.locked) return 'The contract is locked; unlock it to change the issue.'
  if (args.trim() === 'clear') {
    await mutate($, current => model.setIssue(current, undefined))
    return 'Issue unlinked.'
  }

  const parsed = parseIssueArg(args)
  if (!parsed) return 'Usage: /smartworkbench issue <#123 | GitHub URL | KEY-1 title>'
  if (!parsed.isGitHub) {
    await mutate($, current => model.setIssue(current, { ref: parsed.ref, ...(parsed.title ? { title: parsed.title } : {}) }))
    return `Linked ${parsed.ref}${parsed.title ? `: ${parsed.title}` : ''}.`
  }

  const found = await $.process.run(['gh', 'issue', 'view', parsed.ref, '--json', 'number,title,url,body']).catch(() => undefined)
  if (found?.exitCode !== 0) {
    await mutate($, current => model.setIssue(current, { ref: parsed.ref }))
    return `Linked ${parsed.ref} without details (gh could not read it${found?.stderr ? `: ${found.stderr.trim().split('\n')[0]}` : ''}).`
  }
  let issue: { number?: number; title?: string; url?: string; body?: string }
  try {
    issue = JSON.parse(found.stdout) as typeof issue
  } catch {
    return 'gh returned something that is not JSON.'
  }
  const ref = issueRef(issue, parsed.ref)
  const body = (issue.body ?? '').trim()
  await mutate($, current => {
    const linked = model.setIssue(current, ref)
    return body ? model.pinNote(linked, `Issue ${ref.ref}: ${body.slice(0, 2000)}${body.length > 2000 ? '…' : ''}`) : linked
  })

  return `Linked ${ref.ref}: ${ref.title ?? ''}${body ? ' (its description is pinned as a note)' : ''}.`
}

async function waive($: $, id: string, text: string): Promise<void> {
  const reason = await $.ui
    .ask(`Why skip verifying "${model.cut(text, 60)}"?`, { header: 'Waive', options: ['Not applicable', 'Verified elsewhere'] })
    .catch(() => undefined)

  if (reason !== undefined) {
    await stamp($, id, 'waived', reason)
  }
}

async function askToFinish($: $, wb: Workbench): Promise<void> {
  const unmet = wb.task.doneConditions
    .map(one => ({ one, status: statusOf(one, wb.evidence, lastCheckedEdit(wb.changed)) }))
    .filter(({ status }) => status !== 'verified' && status !== 'waived')
    .map(({ one, status }) => `- [${status}] ${one.id}: ${one.text}${one.link ? ` (needs a passing ${one.link} run)` : ''}`)

  await $.prompt.submit({
    text: `Finish the SmartWorkbench task. These done conditions are not met yet:\n${unmet.join('\n')}\nFix what is failing and run the checks that prove each one.`,
  })
}

// Freezes a file pin at its current text; too large a file stays Live.
async function snapshotPin($: $, pin: ContextPin): Promise<void> {
  if (pin.kind !== 'file') return
  const text = await $.fs.read(pin.path).catch(() => undefined)

  if (text === undefined) {
    $.ui.toast(`SmartWorkbench: cannot read ${pin.path}`)
    return
  }
  if (text.length > MAX_SNAPSHOT) {
    $.ui.toast(`SmartWorkbench: ${pin.path} is over 64 KB; pin a line range to snapshot it`)
    return
  }
  const snapshot = { text, sha256: await sha256(text), at: await $.clock.now() }
  await mutate($, wb => model.setPinMode(wb, pin.id, snapshot))
}

async function pinSize($: $, pin: ContextPin): Promise<number> {
  if (pin.kind === 'note' || pin.snapshot) {
    return pinText(pin, undefined)?.length ?? 0
  }
  if (pin.lines) {
    const text = await $.fs.read(pin.path).catch(() => undefined)
    return text === undefined ? -1 : (pinText(pin, text)?.length ?? 0)
  }

  return $.fs.stat(pin.path).then(stat => stat.size, () => -1)
}

async function saveSet($: $, name: string): Promise<void> {
  const clean = name.trim()
  const wb = await read($, wbAtom)
  if (clean === '' || wb.context.pins.length === 0) return
  await $.store.set(`set:${clean}`, wb.context.pins)
  $.ui.toast(`SmartWorkbench: saved context set "${clean}" (${wb.context.pins.length} pins)`)
}

async function loadSet($: $, name: string): Promise<void> {
  const pins = await $.store.get(`set:${name}`)
  if (Array.isArray(pins)) {
    await mutate($, wb => model.applySet(wb, pins as ContextPin[]))
  }
}

async function savedNames($: $, prefix: 'set:' | 'tpl:'): Promise<string[]> {
  return (await $.store.keys()).filter(key => key.startsWith(prefix)).map(key => key.slice(prefix.length))
}

async function exportHandoff($: $, path: string): Promise<string> {
  const target = path.trim() || HANDOFF_PATH
  await $.fs.write(target, handoffMarkdown(await read($, wbAtom), await $.clock.now()))

  return target
}

// The line a tool row gets under it, from the call's record and any evidence it produced.
async function badge($: $, call: ToolCallRecord): Promise<void> {
  const wb = await read($, wbAtom)
  const text = badgeOf(call, wb.evidence.find(one => one.id === call.id), wb)
  if (text === undefined) return
  await update($, badgesAtom, all => Object.fromEntries([...Object.entries(all), [call.id, text]].slice(-MAX_BADGES)))
}

// Re-reads the checked-in guard file; no file means the person's own profile and the built-in rules.
async function loadPolicy($: $): Promise<void> {
  const text = await $.fs.read(POLICY_PATH).catch(() => undefined)
  const policy = text === undefined ? undefined : parsePolicy(text)
  await setLive($, ({ policy: _old, ...live }) => (policy ? { ...live, policy } : live))

  if (policy && policy.errors.length > 0) {
    $.ui.toast(`SmartWorkbench: ${POLICY_PATH}: ${policy.errors[0]}${policy.errors.length > 1 ? ` (+${policy.errors.length - 1} more)` : ''}`)
  }
}

function profileOf(wb: Workbench, live: Live): GuardProfile {
  return live.policy?.profile ?? wb.execution.profile
}

function policyText(live: Live): string {
  const policy = live.policy
  if (!policy) {
    return `No project guard file. /smartworkbench policy init writes a starter ${POLICY_PATH}.`
  }
  const rules = policy.rules.map(
    (one, i) =>
      `  ${i + 1}. ${one.policy.toUpperCase()} ${[one.tool && `tool=${one.tool}`, one.command && `command=/${one.command}/`, one.path && `path=${one.path}`].filter(Boolean).join(' ')}${one.reason ? ` — ${one.reason}` : ''}`,
  )

  return [
    `${policy.source}: profile ${policy.profile ?? '(not set)'}, ${policy.rules.length} rules`,
    ...rules,
    ...policy.errors.map(one => `  ⚠ ${one}`),
    'Project rules can tighten the built-in guard, never loosen a block or a secrets check.',
  ].join('\n')
}

// The last thing the person asked in this session, else the branch name, as a goal to edit.
async function goalDraftFor($: $): Promise<string | undefined> {
  const messages = await $.session.messages().catch(() => [])
  const lastPrompt = [...messages].reverse().find(one => one.role === 'user' && one.text.trim() !== '' && one.toolUses.length === 0)?.text
  const branch = await $.process.run(['git', 'rev-parse', '--abbrev-ref', 'HEAD']).catch(() => undefined)

  return model.goalDraft(lastPrompt, branch?.exitCode === 0 ? branch.stdout : undefined)
}

// ---- commands

function statusText(wb: Workbench, live: Live): string {
  const constraints = wb.task.constraints.filter(one => one.isActive).map(one => `  [${one.priority === 'hard' ? 'H' : 'S'}] ${one.text}`)
  const pins = wb.context.pins.map(one => `  ${one.kind === 'file' ? one.path : `Note: ${one.text}`}`)

  return [
    model.bandText(wb, live),
    `Goal: ${wb.task.goal || '—'} (${wb.task.locked ? 'locked' : 'unlocked'}, ${wb.task.status})`,
    ...(live.loop ? [loop.describe(live.loop).split('\n')[0]] : []),
    ...(constraints.length > 0 ? ['Constraints:', ...constraints] : []),
    ...(pins.length > 0 ? ['Pins:', ...pins] : []),
    ...(wb.team?.enabled ? [`Team mode: on (Opus reviews this session: ${live.track?.advisorRuns ?? 0})`] : []),
    ...((live.sessionAllows ?? []).length > 0 ? [`Allowed for this session: ${(live.sessionAllows ?? []).map(one => one.label).join(', ')}`] : []),
    ...(live.policy ? [`Guard file: ${live.policy.source} (${live.policy.rules.length} rules${live.policy.profile ? `, profile ${live.policy.profile}` : ''})`] : []),
    ...(wb.task.doneConditions.length > 0 ? [turnSummary(wb.task, wb.evidence, lastCheckedEdit(wb.changed))] : []),
  ].join('\n')
}

// The live view's web server (tools/live.mjs), a child of this session: it ends with /swb live stop, the session or a reload.
let liveServer: { url: string; stop: () => void } | undefined

async function liveCommand($: $, rest: string): Promise<{ text: string }> {
  const arg = rest.trim().toLowerCase()

  if (arg === 'stop' || arg === 'off') {
    if (!liveServer) return { text: 'The live view is not running.' }
    liveServer.stop()
    liveServer = undefined

    return { text: 'Live view stopped; the feed file is removed.' }
  }
  if (liveServer) return { text: `Live view: ${liveServer.url}\n/swb live stop to end it.` }

  const port = arg === '' ? 4317 : Number(arg)
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return { text: 'Usage: /swb live [port 1024-65535] | /swb live stop' }

  const url = `http://127.0.0.1:${port}`
  const child = $.process.spawn({ argv: ['node', `${$.plugin.root}/tools/live.mjs`, await $.session.cwd(), '--port', String(port)] })
  const iterator = child[Symbol.asyncIterator]()
  let output = ''
  const handle = { url, stop: () => void Promise.resolve(iterator.return?.()).catch(() => undefined) }

  const started = new Promise<boolean>(resolve => {
    void (async () => {
      try {
        for (;;) {
          const step = await iterator.next()
          if (step.done) break
          output += step.value.text
          if (output.includes('SmartWorkbench live:')) {
            liveServer = handle
            resolve(true)
          }
        }
      } catch (error) {
        output += error instanceof Error ? error.message : String(error)
      }
      if (liveServer === handle) liveServer = undefined
      resolve(false)
    })()
  })
  const timeout = $.clock.sleep(3000).then(() => false, () => false)

  if (await Promise.race([started, timeout])) {
    return { text: `Live view: ${url}\nOpen it in a browser. /swb live stop to end it. The feed holds prompt starts, so do not commit .claude/smartworkbench-live.jsonl.` }
  }
  handle.stop()

  return { text: `The live view did not start${output.trim() ? `: ${model.cut(output.trim().split('\n').pop() ?? '', 160)}` : ' (is node installed? is the port free?)'}` }
}

async function runCommand($: $, args: string): Promise<{ text: string }> {
  const word = (args.trim().split(/\s+/)[0] ?? '').toLowerCase()

  if (word === 'live') return liveCommand($, args.trim().slice(word.length))

  if (word === '' || word in TAB_ARGS) {
    const isPlaced = await openPane($, TAB_ARGS[word])

    return { text: isPlaced ? 'SmartWorkbench opened.' : statusText(await read($, wbAtom), await read($, liveAtom)) }
  }

  if (word === 'new') {
    const wb = await read($, wbAtom)
    if (wb.task.goal.trim() !== '') {
      const answer = await $.ui
        .ask('Start a new task? The current contract and its evidence are replaced.', ['Start new', 'Keep current'])
        .catch(() => 'Keep current')
      if (answer !== 'Start new') return { text: 'Kept the current task.' }
    }
    const team = (await read($, liveAtom)).policy
    const template = team?.templates.find(one => one.name === team.defaultTemplate)
    const draft = template?.goal ? undefined : await goalDraftFor($)
    await mutate($, current => {
      const fresh = template ? model.applyTeamTemplate(model.newTask(current), template) : model.newTask(current)
      return draft ? model.setGoal(fresh, draft) : fresh
    })
    await audit($, 'task.new', template ? { template: template.name } : {})
    await openPane($, 'intent')

    const from = template ? ` from the team template "${template.name}"` : ''
    const goal = draft ? ` Goal drafted as "${model.cut(draft, 60)}"; edit it if needed.` : ''

    return { text: `New SmartWorkbench task${from}.${goal} Add done conditions, then Lock.` }
  }

  if (word === 'team') {
    const [, sub = '', first, second] = args.trim().split(/\s+/)
    const verb = sub.toLowerCase()
    if (verb === 'on' || verb === 'off') return { text: await setTeam($, verb === 'on', true) }

    // /swb team <lead|explorer|advisor> <model> [effort], or an effort alone
    const role = crew.ROLES.find(one => one === verb)
    if (role && first) {
      const isEffort = (value: string) => ((role === 'lead' ? crew.LEAD_EFFORTS : crew.EFFORTS) as readonly string[]).includes(value)
      const change = isEffort(first) ? { effort: first } : { model: first, ...(second && isEffort(second) ? { effort: second } : {}) }
      return { text: await changeRole($, role, change, true) }
    }

    await openPane($, 'team')
    const wb = await read($, wbAtom)
    const track = (await read($, liveAtom)).track ?? crew.EMPTY_TRACK
    const roles = crew.ROLES.map(one => `${one} ${crew.roleOf(wb.team, one).model} (${crew.roleOf(wb.team, one).effort})`).join(' · ')

    return {
      text: `Team mode ${wb.team?.enabled ? 'on' : 'off'}: ${roles}. Opus reviews this session: ${track.advisorRuns}.\n/swb team on|off · /swb team <lead|explorer|advisor> <model> [effort]`,
    }
  }

  if (word === 'loop') {
    const command = loop.parse(args.trim().slice(word.length))
    const live = await read($, liveAtom)

    if (command.kind === 'error') return { text: command.text }
    if (command.kind === 'status') return { text: loop.describe(live.loop) }

    if (command.kind === 'stop') {
      if (!live.loop) return { text: 'No loop is running.' }
      await setLive($, current => ({ ...current, loop: undefined }))
      await audit($, 'loop.stop', { done: live.loop.done })

      return { text: `Loop stopped after ${live.loop.done} passes. The current turn finishes normally.` }
    }

    if (live.loop) return { text: 'A loop is already running. /swb loop stop first.' }
    const started = loop.begin(command.items, command.limit, await $.clock.now())
    await setLive($, current => ({ ...current, loop: started }))

    // The host refuses a prompt from inside a command; the first pass goes out when this command's turn completes.
    return { text: `Loop set: ${command.limit === null ? 'until stopped' : `${command.limit} passes`}. Pass 1 starts when this turn ends. /swb loop stop ends it.` }
  }

  if (word === 'advise') {
    // Sent when this command's turn ends: the host refuses a submit from inside a command.
    const text = crew.advisePrompt(args.trim().slice(word.length))
    await setLive($, current => ({ ...current, pendingPrompt: text }))
    return { text: 'Claude will consult the Opus advisor when this turn ends.' }
  }

  if (word === 'lock' || word === 'unlock') {
    const wb = await read($, wbAtom)
    if (word === 'lock' && wb.task.goal.trim() === '') return { text: 'Write a goal first (/swb new).' }
    if (wb.task.locked === (word === 'lock')) return { text: `The contract is already ${word}ed.` }
    await toggleLock($)

    return { text: word === 'lock' ? 'Contract locked: it is added to every prompt from now on.' : 'Contract unlocked: edit it in the Intent tab, then lock it again.' }
  }

  if (word === 'status') {
    return { text: statusText(await read($, wbAtom), await read($, liveAtom)) }
  }

  if (word === 'preview') {
    const { blocks, warnings } = await injection($, await read($, wbAtom))

    return {
      text:
        blocks.length === 0
          ? 'Nothing is added to prompts: lock the contract or pin something.'
          : [...blocks, ...warnings.map(one => `⚠ ${one}`)].join('\n\n'),
    }
  }

  if (word === 'clear') {
    const answer = await $.ui
      .ask("Clear this project's SmartWorkbench state (contract, pins, history, evidence)?", ['Clear', 'Cancel'])
      .catch(() => 'Cancel')
    if (answer !== 'Clear') return { text: 'Nothing cleared.' }
    await mutate($, model.clearAll)
    await audit($, 'task.clear')

    return { text: 'SmartWorkbench cleared.' }
  }

  const name = args.trim().slice(word.length).trim()

  if (word === 'save') {
    if (name === '') return { text: 'Usage: /smartworkbench save <name>' }
    const wb = await read($, wbAtom)
    await $.store.set(`tpl:${name}`, model.toTemplate(wb, name, await $.clock.now()))

    return { text: `Saved template "${name}": goal, ${wb.task.constraints.length} constraints, ${wb.task.doneConditions.length} done conditions, ${wb.context.pins.length} pins, guard ${wb.execution.profile}.` }
  }

  if (word === 'load') {
    const isTeamOnly = name.startsWith('team:')
    const bare = isTeamOnly ? name.slice(5) : name
    const mine = isTeamOnly || bare === '' ? undefined : ((await $.store.get(`tpl:${bare}`)) as Template | undefined)
    const team = mine ? undefined : (await read($, liveAtom)).policy?.templates.find(one => one.name === bare)
    if (!mine && !team) {
      const names = await savedNames($, 'tpl:')
      const teamNames = (await read($, liveAtom)).policy?.templates.map(one => `team:${one.name}`) ?? []
      const all = [...names, ...teamNames]
      return { text: `No template "${name}". Templates: ${all.length > 0 ? all.join(', ') : 'none'}` }
    }
    const wb = await read($, wbAtom)
    if (wb.task.goal.trim() !== '') {
      const answer = await $.ui
        .ask(`Replace the current task with template "${name}"? Its evidence is cleared.`, ['Load template', 'Keep current'])
        .catch(() => 'Keep current')
      if (answer !== 'Load template') return { text: 'Kept the current task.' }
    }
    await mutate($, current => (mine ? model.applyTemplate(current, mine) : team ? model.applyTeamTemplate(current, team) : current))
    await audit($, 'task.load', { template: mine ? bare : `team:${bare}` })
    await openPane($, 'intent')

    return { text: `Loaded ${mine ? 'template' : 'team template'} "${bare}". Review it, then Lock.` }
  }

  if (word === 'templates') {
    const templates = await savedNames($, 'tpl:')
    const sets = await savedNames($, 'set:')
    const team = (await read($, liveAtom)).policy
    const teamNames = team?.templates.map(one => `${one.name}${one.name === team.defaultTemplate ? ' (default for /swb new)' : ''}`) ?? []

    return {
      text: [
        `Templates: ${templates.length > 0 ? templates.join(', ') : 'none'}`,
        `Team templates (${POLICY_PATH}): ${teamNames.length > 0 ? teamNames.join(', ') : 'none'}`,
        `Context sets: ${sets.length > 0 ? sets.join(', ') : 'none'}`,
      ].join('\n'),
    }
  }

  if (word === 'ci') {
    return { text: await importCi($) }
  }

  if (word === 'issue') {
    return { text: await linkIssue($, name) }
  }

  if (word === 'share') {
    const target = name || SHARE_PATH
    const live = await read($, liveAtom)
    await $.fs.write(target, shareText(await read($, wbAtom), await $.clock.now(), live.user))
    await audit($, 'task.share', { path: target })

    return { text: `Task written to ${target}. Commit and push it; on the other machine run /smartworkbench pickup.` }
  }

  if (word === 'pickup') {
    const target = name || SHARE_PATH
    const text = await $.fs.read(target).catch(() => undefined)
    if (text === undefined) return { text: `No shared task at ${target}.` }
    const shared = readShare(text)
    if ('error' in shared) return { text: `${target}: ${shared.error}` }
    const wb = await read($, wbAtom)
    if (wb.task.goal.trim() !== '') {
      const answer = await $.ui
        .ask(`Replace the current task with the one shared${shared.sharedBy ? ` by ${shared.sharedBy}` : ''} at ${shared.sharedAt}?`, ['Pick up', 'Keep current'])
        .catch(() => 'Keep current')
      if (answer !== 'Pick up') return { text: 'Kept the current task.' }
    }
    await mutate($, current => model.applyShare(current, shared))
    await audit($, 'task.pickup', { path: target, sharedBy: shared.sharedBy ?? '' })
    await openPane($, 'intent')

    return { text: `Picked up "${shared.task.goal}" (${shared.task.doneConditions.length} done conditions, ${shared.pins.length} pins). Checks run on the other machine do not carry over; run them here.` }
  }

  if (word === 'audit') {
    const config = (await read($, liveAtom)).policy?.audit
    if (!config) return { text: `Audit is off. Turn it on with "audit": true in ${POLICY_PATH}.` }
    const text = await $.fs.read(config.path).catch(() => '')
    const entries = readAudit(text)
    const count = Math.max(1, Math.min(200, Number(name) || 20))

    return { text: entries.length === 0 ? `No audit entries in ${config.path} yet.` : `${config.path} (last ${Math.min(count, entries.length)} of ${entries.length}):\n${formatAudit(entries, count)}` }
  }

  if (word === 'policy') {
    if (name === 'init') {
      if (await $.fs.exists(POLICY_PATH)) {
        return { text: `${POLICY_PATH} already exists.\n${policyText(await read($, liveAtom))}` }
      }
      await $.fs.write(POLICY_PATH, POLICY_TEMPLATE)
      await loadPolicy($)

      return { text: `Wrote ${POLICY_PATH} with example rules; edit it and commit it so the team shares it.\n${policyText(await read($, liveAtom))}` }
    }
    await loadPolicy($)

    return { text: policyText(await read($, liveAtom)) }
  }

  if (word === 'export') {
    const target = await exportHandoff($, name)

    return { text: `Handoff written to ${target}.` }
  }

  return { text: HELP }
}

// ---- drawing

function seconds(ms: number | undefined): string {
  if (ms === undefined) return ''
  const s = Math.round(ms / 1000)

  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

function outcomeMark(call: ToolCallRecord): { mark: string; color?: string } {
  switch (call.outcome) {
    case 'running':
      return { mark: '◉', color: 'suggestion' }
    case 'ok':
      return { mark: '✓', color: 'success' }
    case 'error':
    case 'blocked':
      return { mark: '✕', color: 'error' }
    case 'declined':
      return { mark: '!', color: 'warning' }
  }
}

function intentTab($: $, { els, wb, live, width }: View): RenderElement {
  const { Box, Text, Button, Input } = els
  const { task } = wb
  const ro = task.locked

  return (
    <Box flexDirection="column">
      <Box gap={1}>
        <Text bold>STATUS</Text>
        <Text color={task.status === 'complete' ? 'success' : undefined}>
          {task.locked ? '● ' : '○ '}
          {task.status}
          {task.locked ? ' · locked' : ''}
        </Text>
        <Button
          key="lock"
          hotkey="l"
          variant={task.locked ? undefined : 'primary'}
          label={task.locked ? 'Unlock' : 'Lock'}
          onPress={() => void toggleLock($)}
        />
      </Box>
      {(wb.proposals ?? [])
        .filter(one => one.status === 'open')
        .map(one => (
          <Box key={`pr-${one.id}`} flexDirection="column" marginTop={1}>
            <Text color="suggestion" wrap="wrap">
              Claude proposes: {one.change.replace(/_/g, ' ')} {one.text ? `"${one.text}"` : one.target ?? ''}
            </Text>
            <Text dimColor wrap="wrap">
              {'  '}
              {one.reason}
            </Text>
            <Box gap={1} marginLeft={2}>
              <Button key={`approve-${one.id}`} plain label="Approve" onPress={() => void settleProposal($, one.id, true)} />
              <Button key={`reject-${one.id}`} plain dimColor label="Reject" onPress={() => void settleProposal($, one.id, false)} />
            </Box>
          </Box>
        ))}
      {task.issue && (
        <Box gap={1}>
          <Text dimColor>Issue</Text>
          <Text wrap="truncate-end">
            {task.issue.ref}
            {task.issue.title ? ` ${model.cut(task.issue.title, width - task.issue.ref.length - 10)}` : ''}
          </Text>
        </Box>
      )}
      <Box marginTop={1}>
        <Text bold>Goal</Text>
      </Box>
      {ro ? (
        <Text wrap="wrap">{task.goal || '—'}</Text>
      ) : (
        // The goal field shows the saved goal; the add fields below are drafts that clear on submit.
        <Input
          key="goal"
          placeholder="One core goal for this task"
          value={task.goal}
          submitLabel="save"
          onSubmit={value => void mutate($, wb => model.setGoal(wb, value))}
        />
      )}
      <Box marginTop={1}>
        <Text bold>Constraints</Text>
      </Box>
      {task.constraints.length === 0 && <Text dimColor>none</Text>}
      {task.constraints.map(one => (
        <Box key={`c-${one.id}`} gap={1}>
          <Button key={`cp-${one.id}`} plain label={one.priority === 'hard' ? '[H]' : '[S]'} onPress={() => void mutate($, wb => model.flipPriority(wb, one.id))} />
          <Button key={`ct-${one.id}`} plain label={one.isActive ? '✓' : '·'} onPress={() => void mutate($, wb => model.toggleConstraint(wb, one.id))} />
          <Text dimColor={!one.isActive} wrap="truncate-end">
            {model.cut(one.text, width - 14)}
          </Text>
          {!ro && <Button key={`cx-${one.id}`} plain dimColor label="×" onPress={() => void mutate($, wb => model.removeConstraint(wb, one.id))} />}
        </Box>
      ))}
      {!ro && (
        <Input
          key="add-constraint"
          placeholder="+ constraint (s: prefix = soft)"
          value={live.drafts?.['add-constraint'] ?? ''}
          submitLabel="add"
          onInput={value => void setDraft($, 'add-constraint', value)}
          onSubmit={value => void submitDraft($, 'add-constraint', () => mutate($, wb => model.addConstraint(wb, value)))}
        />
      )}
      <Box marginTop={1}>
        <Text bold>Done conditions</Text>
      </Box>
      {task.doneConditions.length === 0 && <Text dimColor>none</Text>}
      {task.doneConditions.map(one => {
        const status = statusOf(one, wb.evidence, lastCheckedEdit(wb.changed))

        return (
          <Box key={`d-${one.id}`} gap={1}>
            <Text color={STATUS_COLOR[status]}>{markOf(status)}</Text>
            <Text wrap="truncate-end">{model.cut(one.text, width - 8)}</Text>
            {!ro && <Button key={`dx-${one.id}`} plain dimColor label="×" onPress={() => void mutate($, wb => model.removeCondition(wb, one.id))} />}
          </Box>
        )
      })}
      {!ro && <Input
          key="add-condition"
          placeholder="+ done condition"
          value={live.drafts?.['add-condition'] ?? ''}
          submitLabel="add"
          onInput={value => void setDraft($, 'add-condition', value)}
          onSubmit={value => void submitDraft($, 'add-condition', () => mutate($, wb => model.addCondition(wb, value)))}
        />}
      <Box marginTop={1}>
        <Text bold>Non-goals</Text>
      </Box>
      {task.nonGoals.length === 0 && <Text dimColor>none</Text>}
      {task.nonGoals.map((one, i) => (
        <Box key={`n-${i}`} gap={1}>
          <Text dimColor>–</Text>
          <Text wrap="truncate-end">{model.cut(one, width - 6)}</Text>
          {!ro && <Button key={`nx-${i}`} plain dimColor label="×" onPress={() => void mutate($, wb => model.removeNonGoal(wb, i))} />}
        </Box>
      ))}
      {!ro && <Input
          key="add-nongoal"
          placeholder="+ non-goal"
          value={live.drafts?.['add-nongoal'] ?? ''}
          submitLabel="add"
          onInput={value => void setDraft($, 'add-nongoal', value)}
          onSubmit={value => void submitDraft($, 'add-nongoal', () => mutate($, wb => model.addNonGoal(wb, value)))}
        />}
      {ro && <Text dimColor>Locked: added to every prompt. Unlock to edit.</Text>}
    </Box>
  )
}

async function contextTab($: $, { els, wb, live, width, room }: View): Promise<RenderElement> {
  const { Box, Text, Button, Input, Markdown, Select } = els
  const added = await injection($, wb)
  const sets = await savedNames($, 'set:')
  const sizes = new Map<string, number>()

  // Sized from what the prompt carries: a note, a snapshot or a range, else the file on disk.
  for (const pin of wb.context.pins) {
    sizes.set(pin.id, await pinSize($, pin))
  }

  const usage =
    live.contextTokens !== undefined
      ? `${Math.round(live.contextTokens / 1000)}K / ${Math.round((live.contextWindow ?? 0) / 1000)}K`
      : 'usage after the first turn'
  const excluded = wb.context.excluded ?? []
  const suggested = suggestionsOf(wb.context.observed, wb.context.pins, excluded)
  const shown = new Set([...suggested.map(one => one.path), ...wb.context.pins.flatMap(one => (one.kind === 'file' && !one.lines ? [one.path] : []))])
  const observed = wb.context.observed
    .filter(one => !shown.has(one.path))
    .slice(-Math.max(3, room - wb.context.pins.length - suggested.length - 12))
    .reverse()

  return (
    <Box flexDirection="column">
      <Text>
        {usage} · SmartWorkbench adds {estimateTokens(added.chars)}
      </Text>
      <Box marginTop={1}>
        <Text bold>PINNED</Text>
      </Box>
      {wb.context.pins.length === 0 && <Text dimColor>nothing pinned</Text>}
      {wb.context.pins.map(pin => {
        const size = sizes.get(pin.id) ?? 0

        return (
          <Box key={`pin-${pin.id}`} gap={1}>
            <Text color={size < 0 ? 'error' : undefined}>{size < 0 ? '⚠' : '●'}</Text>
            <Text wrap="truncate-end">{model.cut(pin.kind === 'file' ? `${pin.path}${rangeLabel(pin.lines)}` : `Note: ${pin.text}`, width - 24)}</Text>
            <Text dimColor>{size < 0 ? 'missing' : estimateTokens(size)}</Text>
            {pin.kind === 'file' && (
              <Button
                key={`mode-${pin.id}`}
                plain
                dimColor={pin.mode === 'live'}
                label={pin.mode === 'snapshot' ? 'Snap' : 'Live'}
                onPress={() => void (pin.mode === 'snapshot' ? mutate($, wb => model.setPinMode(wb, pin.id, undefined)) : snapshotPin($, pin))}
              />
            )}
            <Button key={`unpin-${pin.id}`} plain dimColor label="×" onPress={() => void mutate($, wb => model.unpin(wb, pin.id))} />
          </Box>
        )
      })}
      <Input
          key="pin-file"
          placeholder="+ file to pin (path or path:10-40)"
          value={live.drafts?.['pin-file'] ?? ''}
          submitLabel="pin"
          onInput={value => void setDraft($, 'pin-file', value)}
          onSubmit={value => void submitDraft($, 'pin-file', () => mutate($, wb => model.pinFile(wb, value)))}
        />
      <Input
          key="pin-note"
          placeholder="+ note to pin"
          value={live.drafts?.['pin-note'] ?? ''}
          submitLabel="pin"
          onInput={value => void setDraft($, 'pin-note', value)}
          onSubmit={value => void submitDraft($, 'pin-note', () => mutate($, wb => model.pinNote(wb, value)))}
        />
      {suggested.length > 0 && (
        <Box marginTop={1}>
          <Text bold>SUGGESTED</Text>
        </Box>
      )}
      {suggested.map(one => (
        <Box key={`sug-${one.path}`} gap={1}>
          <Text color="suggestion">◇</Text>
          <Text wrap="truncate-end">{model.cut(one.path, width - 30)}</Text>
          <Text dimColor>
            {categoryOf(one.path)} · {one.how === 'edited' ? 'edited' : `read ×${one.count ?? 1}`}
          </Text>
          <Button key={`pinsug-${one.path}`} plain label="Pin" onPress={() => void mutate($, wb => model.pinFile(wb, one.path))} />
          <Button key={`hide-${one.path}`} plain dimColor label="Hide" onPress={() => void mutate($, wb => model.toggleExcluded(wb, one.path))} />
        </Box>
      ))}
      <Box marginTop={1}>
        <Text bold>OBSERVED</Text>
      </Box>
      {observed.length === 0 && <Text dimColor>nothing yet</Text>}
      {observed.map(one => {
        const category = categoryOf(one.path)
        const isHidden = excluded.includes(one.path)

        return (
          <Box key={`obs-${one.path}`} gap={1}>
            <Text dimColor>○</Text>
            <Text wrap="truncate-end" dimColor={isHidden}>
              {model.cut(one.path, width - 30)}
            </Text>
            <Text color={category === 'secret' ? 'warning' : undefined} dimColor={category !== 'secret'}>
              {category} · {one.how}
            </Text>
            {category !== 'secret' && category !== 'generated' && (
              <Button key={`pinobs-${one.path}`} plain label="Pin" onPress={() => void mutate($, wb => model.pinFile(wb, one.path))} />
            )}
            {isHidden && <Button key={`unhide-${one.path}`} plain dimColor label="Unhide" onPress={() => void mutate($, wb => model.toggleExcluded(wb, one.path))} />}
          </Box>
        )
      })}
      <Input
          key="save-set"
          placeholder="save pins as a context set: name"
          value={live.drafts?.['save-set'] ?? ''}
          submitLabel="save"
          onInput={value => void setDraft($, 'save-set', value)}
          onSubmit={value => void submitDraft($, 'save-set', () => saveSet($, value))}
        />
      {sets.length > 0 && (
        <Select key="load-set" label="Add set" value="" options={[{ value: '', label: '—' }, ...sets.map(value => ({ value }))]} onSelect={value => void (value !== '' && loadSet($, value))} />
      )}
      <Button
        key="preview"
        hotkey="p"
        label={live.isPreviewOpen ? 'Hide preview' : 'Preview'}
        onPress={() => void setLive($, state => ({ ...state, isPreviewOpen: !state.isPreviewOpen }))}
      />
      {live.isPreviewOpen && (
        <Markdown
          key="preview-text"
          text={
            added.blocks.length === 0
              ? '_Nothing is added: lock the contract or pin something._'
              : added.blocks.map(one => '```xml\n' + one.slice(0, 4000) + (one.length > 4000 ? '\n…' : '') + '\n```').join('\n')
          }
        />
      )}
    </Box>
  )
}

function runTab($: $, { els, wb, live, width, room }: View): RenderElement {
  const { Box, Text, Button, Select } = els
  const calls = wb.execution.recentCalls
  const running = calls.filter(one => one.outcome === 'running')
  const recent = calls
    .filter(one => one.outcome !== 'running')
    .slice(-Math.max(3, room - 10))
    .reverse()

  return (
    <Box flexDirection="column">
      {live.policy?.profile ? (
        <Text>
          Guard profile: <Text bold>{live.policy.profile}</Text> <Text dimColor>(set by {POLICY_PATH})</Text>
        </Text>
      ) : (
        <Select
          key="profile"
          label="Guard profile"
          value={wb.execution.profile}
          options={[
            { value: 'permissive', label: 'Permissive' },
            { value: 'balanced', label: 'Balanced' },
            { value: 'strict', label: 'Strict' },
          ]}
          onSelect={value => void mutate($, wb => model.setProfile(wb, value as GuardProfile))}
        />
      )}
      <Text dimColor={!wb.team?.enabled}>
        Team mode: {wb.team?.enabled ? `on · ${live.track?.advisorRuns ?? 0} advisor reviews` : 'off'} · tab 5
      </Text>
      {live.policy ? (
        <Text dimColor={live.policy.errors.length === 0} color={live.policy.errors.length > 0 ? 'warning' : undefined} wrap="truncate-end">
          {POLICY_PATH}: {live.policy.rules.length} rules{live.policy.errors.length > 0 ? ` · ⚠ ${live.policy.errors[0]}` : ''}
        </Text>
      ) : (
        <Text dimColor>No project guard file · /swb policy init</Text>
      )}
      {(live.sessionAllows ?? []).length > 0 && (
        <Box flexDirection="column">
          <Text bold>
            ALLOWED FOR THIS SESSION{wb.execution.isPaused ? <Text dimColor> (paused: asking again)</Text> : ''}
          </Text>
          {(live.sessionAllows ?? []).map(one => (
            <Box key={`allow-${one.key}`} gap={1}>
              <Text color="warning">✓</Text>
              <Text wrap="truncate-end">{model.cut(one.label, width - 8)}</Text>
              <Button key={`revoke-${one.key}`} plain dimColor label="×" onPress={() => void revokeSessionAllow($, one.key)} />
            </Box>
          ))}
        </Box>
      )}
      <Box marginTop={1}>
        <Text bold>RUNNING</Text>
      </Box>
      {running.length === 0 && <Text dimColor>idle</Text>}
      {running.map(one => (
        <Text key={`run-${one.id}`} color="suggestion" wrap="truncate-end">
          ◉ {one.tool} · {model.cut(one.summary, width - one.tool.length - 6)}
        </Text>
      ))}
      <Box marginTop={1}>
        <Text bold>RECENT</Text>
      </Box>
      {recent.length === 0 && <Text dimColor>no calls yet</Text>}
      {recent.map(one => {
        const { mark, color } = outcomeMark(one)
        const tag =
          one.outcome === 'blocked'
            ? 'BLOCKED'
            : one.outcome === 'declined'
              ? 'DECLINED'
              : one.sessionAllowed
                ? 'SESSION'
                : one.policy === 'ask'
                ? 'ASKED'
                : one.risk === 'low'
                  ? one.category?.startsWith('mcp-')
                    ? one.category.slice(4)
                    : ''
                  : one.risk.toUpperCase()

        return (
          <Box key={`call-${one.id}`} gap={1}>
            <Text color={color}>{mark}</Text>
            <Text wrap="truncate-end">
              {one.agentId ? '↳ ' : ''}
              {one.tool} · {model.cut(one.summary, Math.max(8, width - one.tool.length - tag.length - 16))}
            </Text>
            <Text dimColor>{seconds(one.durationMs)}</Text>
            {tag !== '' && <Text color={color}>{tag}</Text>}
          </Box>
        )
      })}
      <Box gap={1}>
        <Button key="pause" hotkey="r" label={wb.execution.isPaused ? 'Resume' : 'Pause risky calls'} onPress={() => void mutate($, model.togglePause)} />
        <Button key="clear-history" dimColor label="Clear history" onPress={() => void mutate($, model.clearHistory)} />
      </Box>
    </Box>
  )
}

function evidenceTab($: $, { els, wb, width }: View): RenderElement {
  const { Box, Text, Button, Select } = els
  const lastEdit = lastCheckedEdit(wb.changed)
  const { met, total, isComplete } = completionOf(wb.task, wb.evidence, lastEdit)
  const hasUnmet = met < total
  const coverage = coverageOf(wb.changed, wb.evidence)

  return (
    <Box flexDirection="column">
      <Text bold color={isComplete ? 'success' : total === 0 ? undefined : 'warning'}>
        Completion {met} / {total} · {total === 0 ? 'NO CONDITIONS' : isComplete ? 'COMPLETE' : 'INCOMPLETE'}
      </Text>
      {total === 0 && <Text dimColor>Add done conditions in the Intent tab.</Text>}
      {wb.task.doneConditions.map(one => {
        const status = statusOf(one, wb.evidence, lastEdit)
        const latest = one.link ? latestOf(wb.evidence, one.link) : undefined
        const detail = one.manual
          ? `manual ${one.manual.status}: ${one.manual.note}`
          : latest
            ? `${latest.ok === null ? 'ran' : latest.ok ? 'passed' : 'failed'} · ${latest.command}${isStale(latest, lastEdit) ? ' · code changed since, re-run' : ''}`
            : one.link
              ? `waiting for a ${one.link} run`
              : 'link evidence or verify by hand'

        return (
          <Box key={`ev-${one.id}`} flexDirection="column">
            <Box gap={1}>
              <Text color={STATUS_COLOR[status]}>{markOf(status)}</Text>
              <Text wrap="truncate-end">{model.cut(one.text, width - 4)}</Text>
            </Box>
            <Text dimColor wrap="truncate-end">
              {'  '}
              {model.cut(detail, width - 4)}
            </Text>
            <Box gap={1} marginLeft={2}>
              <Select
                key={`link-${one.id}`}
                label="Evidence"
                value={one.link ?? 'none'}
                options={LINKS.map(value => ({ value }))}
                onSelect={value => void mutate($, wb => model.linkCondition(wb, one.id, value as EvidenceKind | 'none'))}
              />
              {one.manual ? (
                <Button key={`auto-${one.id}`} plain dimColor label="Undo" onPress={() => void stamp($, one.id, 'auto', '')} />
              ) : (
                <Box gap={1}>
                  <Button key={`verify-${one.id}`} plain label="Verify" onPress={() => void stamp($, one.id, 'verified', 'checked by user')} />
                  <Button key={`waive-${one.id}`} plain dimColor label="Waive" onPress={() => void waive($, one.id, one.text)} />
                </Box>
              )}
            </Box>
          </Box>
        )
      })}
      <Text>
        Changed: {wb.changed.files.length} files
        {wb.changed.added + wb.changed.removed > 0 ? ` · +${wb.changed.added} −${wb.changed.removed}` : ''}
      </Text>
      {coverage.slice(-8).map(one => {
        const { mark, color, note } = coverageMark(one)
        const ranges = one.hunks.length > 0 ? ` ${hunkLabel(one.hunks)}` : ''

        return (
          <Box key={`chg-${one.path}`} flexDirection="column">
            <Box gap={1}>
              <Text color={color}>{mark}</Text>
              <Text wrap="truncate-start">{model.cut(one.path, width - 4)}</Text>
            </Box>
            <Text dimColor wrap="truncate-end">
              {'    '}
              {model.cut(`${note}${ranges}`, width - 4)}
            </Text>
          </Box>
        )
      })}
      <Box gap={1}>
        {hasUnmet && <Button key="finish" variant="primary" hotkey="f" label="Ask Claude to finish" onPress={() => void askToFinish($, wb)} />}
        <Button
          key="ci"
          hotkey="c"
          label="Check CI"
          onPress={() => void importCi($).then(text => $.ui.toast(`SmartWorkbench: ${text.split('\n')[0]}`))}
        />
        <Button
          key="export"
          hotkey="x"
          label="Export handoff"
          onPress={() => void exportHandoff($, '').then(target => $.ui.toast(`SmartWorkbench: handoff written to ${target}`))}
        />
      </Box>
    </Box>
  )
}

function coverageMark(one: Coverage): { mark: string; color?: string; note: string } {
  const added = one.hunks.reduce((sum, hunk) => sum + hunk.added, 0)
  const removed = one.hunks.reduce((sum, hunk) => sum + hunk.removed, 0)
  const size = one.hunks.length > 0 ? `+${added} −${removed} ·` : ''

  switch (one.state) {
    case 'proven':
      return { mark: '✓', color: 'success', note: `${size} ${one.provenBy?.kind} passed after the last edit`.trim() }
    case 'failing':
      return { mark: '✕', color: 'error', note: `${size} ${one.failedBy?.kind} failed after the last edit`.trim() }
    case 'unproven':
      return { mark: '!', color: 'warning', note: `${size} no check since the last edit`.trim() }
    case 'docs':
      return { mark: '·', note: `${size} docs/generated, no check needed`.trim() }
    case 'untracked':
      return { mark: '?', note: `${size} changed outside the tools`.trim() }
  }
}

const ROLE_LABEL: Record<TeamRoleName, string> = { lead: 'Lead', explorer: 'Explorer', advisor: 'Advisor' }
const ROLE_NOTE: Record<TeamRoleName, string> = {
  lead: 'this session: builds and writes the code',
  explorer: `${crew.EXPLORER}: read-only search`,
  advisor: `${crew.ADVISOR}: plan, repeated errors, final check`,
}

async function teamTab($: $, { els, wb, live, width }: View): Promise<RenderElement> {
  const { Box, Text, Button, Select } = els
  const row = await modelRow($)
  const isOn = wb.team?.enabled === true
  const track = live.track ?? crew.EMPTY_TRACK
  const leadModels = row && row.options.length > 0 ? row.options : ['sonnet', 'opus', 'haiku', 'fable']
  const optionsFor = (role: TeamRoleName, current: string) => {
    const list: readonly string[] = role === 'lead' ? leadModels : crew.AGENT_MODELS
    return (list.includes(current) ? list : [current, ...list]).map(value => ({ value }))
  }
  const toast = (text: string) => $.ui.toast(`SmartWorkbench: ${text}`)

  return (
    <Box flexDirection="column">
      <Box gap={1}>
        <Text bold>TEAM MODE</Text>
        <Text color={isOn ? 'success' : undefined}>{isOn ? '● on' : '○ off'}</Text>
        <Button key="team-toggle" variant={isOn ? undefined : 'primary'} label={isOn ? 'Turn off' : 'Turn on'} onPress={() => void setTeam($, !isOn).then(text => toast(text.split('\n')[0] ?? ''))} />
      </Box>
      <Text dimColor wrap="wrap">
        {isOn ? 'The advisor steps in before a plan, after a repeated error and before finishing.' : 'Turn on for automatic advisor reviews; the agents are available either way.'}
      </Text>
      {crew.ROLES.map(role => {
        const now = crew.roleOf(wb.team, role)

        return (
          <Box key={`role-${role}`} flexDirection="column" marginTop={1}>
            <Box gap={1}>
              <Text bold>{ROLE_LABEL[role]}</Text>
              <Text dimColor wrap="truncate-end">
                {model.cut(ROLE_NOTE[role], width - 12)}
              </Text>
            </Box>
            <Box gap={2} marginLeft={2}>
              <Select
                key={`model-${role}`}
                label="Model"
                value={now.model}
                options={optionsFor(role, now.model)}
                onSelect={value => void changeRole($, role, { model: value }).then(toast)}
              />
              <Select
                key={`effort-${role}`}
                label="Effort"
                value={now.effort}
                options={(role === 'lead' ? crew.LEAD_EFFORTS : crew.EFFORTS).map(value => ({ value }))}
                onSelect={value => void changeRole($, role, { effort: value }).then(toast)}
              />
            </Box>
          </Box>
        )
      })}
      <Box marginTop={1} flexDirection="column">
        <Text dimColor>Session model setting now: {row?.value || 'unknown'}</Text>
        <Text dimColor>
          Advisor reviews this session: {track.advisorRuns}
          {track.lastAdvisorAt !== undefined ? ` · last ${seconds(Math.max(0, (await $.clock.now()) - track.lastAdvisorAt))} ago` : ''}
        </Text>
        <Text dimColor wrap="wrap">
          Lead changes apply while team mode is on; agent changes from the next delegation. A lead effort other than default runs /effort, which
          Claude Code keeps as your default for that model.
        </Text>
      </Box>
    </Box>
  )
}

async function pane($: $, els: Els, width: number, rows: number): Promise<RenderElement> {
  const wb = await read($, wbAtom)
  const live = await read($, liveAtom)
  const { Box, Text, Button } = els
  const view: View = { els, wb, live, width, room: Math.max(8, rows - 6) }
  const tab = live.activeTab
  const body =
    tab === 'intent'
      ? intentTab($, view)
      : tab === 'context'
        ? await contextTab($, view)
        : tab === 'run'
          ? runTab($, view)
          : tab === 'team'
            ? await teamTab($, view)
            : evidenceTab($, view)

  return (
    <Box flexDirection="column">
      <Box gap={1}>
        {TABS.map((one, i) =>
          one === tab ? (
            <Button key={`tab-${one}`} hotkey={String(i + 1)} variant="primary" label={TAB_LABEL[one]} onPress={() => undefined} />
          ) : (
            <Button key={`tab-${one}`} hotkey={String(i + 1)} plain dimColor label={TAB_LABEL[one]} onPress={() => void setLive($, state => ({ ...state, activeTab: one }))} />
          ),
        )}
      </Box>
      {live.pinWarnings.length > 0 && (
        <Text color="warning" wrap="truncate-end">
          ⚠ {live.pinWarnings.join(' · ')}
        </Text>
      )}
      {body}
    </Box>
  )
}

// ---- hooks

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await setLive($, current => ({ ...current, loop: undefined })).catch(() => undefined)
    const argumentHint = '[new|team|advise|loop|lock|unlock|context|run|verify|status|preview|save|load|templates|export|policy|ci|issue|share|pickup|audit|clear]'
    const description = 'SmartWorkbench: task contract, context pins, guard and evidence'
    await $.command.register({ name: 'smartworkbench', description, argumentHint })
    await $.command.register({ name: 'swb', description, argumentHint })
    await $.command.register({ name: 'workbench', description: 'Deprecated alias of /smartworkbench', argumentHint })
    // Without the tool the rest still works; Claude then has no way to propose changes.
    await $.tool.register({
      name: 'propose_contract_change',
      description:
        "Propose a change to the user's SmartWorkbench task contract (goal, constraints, done conditions, non-goals) when the work shows it should change. You cannot change the contract yourself; the user approves or rejects the proposal in the SmartWorkbench panel. Keep working within the current contract meanwhile.",
      inputSchema: {
        type: 'object',
        properties: {
          change: { type: 'string', enum: [...CHANGES] },
          text: { type: 'string', description: 'The new goal, constraint, done condition or non-goal (prefix a constraint with "s:" for a soft one)' },
          target_id: { type: 'string', description: 'For a removal: the id of the constraint or done condition (e.g. dc-2)' },
          reason: { type: 'string', description: 'Why the contract should change, in one or two sentences' },
        },
        required: ['change', 'reason'],
      },
    }).catch(error => $.ui.log(`SmartWorkbench: could not register propose_contract_change: ${String(error)}`, { to: 'debug' }))
    const sessionId = await $.session.id().catch(() => undefined)
    if (sessionId) await setLive($, live => ({ ...live, sessionId }))
    await load($)
    await loadPolicy($)
    // Team mode's agents, with this project's chosen models: available to Claude at all times,
    // the automatic reviews only while team mode is on.
    await registerRole($, 'explorer')
    await registerRole($, 'advisor')

    if ((await read($, liveAtom)).policy?.audit) {
      const name = await $.process.run(['git', 'config', 'user.name']).catch(() => undefined)
      const user = name?.exitCode === 0 ? name.stdout.trim() : ''
      if (user) await setLive($, live => ({ ...live, user }))
      await audit($, 'session.start')
    }

    if (e.surface === null || e.surface === 'vscode') {
      $.ui.log('SmartWorkbench: no panel on this surface; the contract and guard still apply. Use /smartworkbench status.')
    }

    return next(e)
  })

  on('command.run', { command: 'smartworkbench' }, async ($, e) => runCommand($, e.args))
  on('command.run', { command: 'swb' }, async ($, e) => runCommand($, e.args))
  on('command.run', { command: 'workbench' }, async ($, e) => runCommand($, e.args))

  // Adds the locked contract and the pins as context the model alone reads;
  // the prompt text is left as typed. On failure the prompt goes through unchanged.
  on('prompt.submit', async ($, e, next) => {
    const startedAt = await $.clock.now()
    await pull($)
    const wb = await read($, wbAtom)
    const { policy } = await read($, liveAtom)

    // Opt-in team rule: no work without a locked contract that says when it is done.
    if (policy?.requireContract && e.origin.kind !== 'plugin' && !(wb.task.locked && wb.task.goal.trim() !== '' && wb.task.doneConditions.length > 0)) {
      return { drop: `This project requires a locked SmartWorkbench contract with at least one done condition (${POLICY_PATH}: requireContract). Run /swb new, fill it in and Lock.` }
    }

    const { blocks: contract, warnings } = await injection($, wb)
    const blocks = wb.team?.enabled ? [...contract, crew.TEAM_CONTEXT] : contract
    // A prompt the person types takes the session back: a running loop ends (its own passes come from the Stop hook).
    // A loop whose first pass never went out (no turn.complete after the command) rides on that prompt instead.
    let loopBlocks: string[] = []
    if (e.origin.kind !== 'plugin' && !e.text.trimStart().startsWith('/')) {
      const { loop: running } = await read($, liveAtom)
      if (running?.pending) {
        loopBlocks = [loop.iterationPrompt(running)]
        await setLive($, current => ({ ...current, loop: current.loop && { ...current.loop, pending: false } }))
      } else if (running) {
        await setLive($, current => ({ ...current, loop: undefined }))
        await audit($, 'loop.cancel', { done: running.done })
        $.ui.toast('SmartWorkbench: loop ended because you sent a prompt.')
      }
    }
    const carriesDesign = (e.origin.kind === 'plugin' && (await read($, liveAtom)).loop !== undefined) || crew.planWasApproved((await read($, liveAtom)).track ?? crew.EMPTY_TRACK)
    await updateTrack($, track => crew.turnStart(track, startedAt, carriesDesign))
    const { turnResult: _done, ...rest } = await read($, liveAtom)
    await setLive($, () => ({ ...rest, pinWarnings: warnings }))

    if (warnings.length > 0) {
      $.ui.toast(`SmartWorkbench: ${warnings.join(', ')}`)
    }

    // Own work only, for checking the performance targets with --debug.
    $.ui.log(`SmartWorkbench timing: prompt.submit ${(await $.clock.now()) - startedAt}ms before the prompt went on`, { to: 'debug' })

    await emit($, 'prompt', { origin: e.origin.kind, text: model.cut(e.text.replace(/\s+/g, ' '), 120), team: wb.team?.enabled === true, loop: loopBlocks.length > 0 })

    const all = [...blocks, ...loopBlocks]

    return all.length === 0 ? next(e) : next({ ...e, context: [...(e.context ?? []), ...all] })
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    // This mod's own calls (its guard and confirmation questions) are not Claude's work.
    if (next.origin.plugin === $.plugin.name) {
      return next(e)
    }
    if (e.tool === PROPOSE_TOOL) {
      return propose($, e as unknown as Record<string, unknown>)
    }
    const hookStart = await $.clock.now()
    const isTeam = (await read($, wbAtom)).team?.enabled === true

    if (isTeam && e.tool === 'ExitPlanMode' && crew.needsPlanReview((await read($, liveAtom)).track ?? crew.EMPTY_TRACK)) {
      await updateTrack($, current => ({ ...current, planReviewDeniedAt: hookStart }))
      await audit($, 'team.plan-review-required')
      return { deny: crew.PLAN_REVIEW }
    }
    // Design first: a big edit needs a design from the advisor; asked once per turn so it can never deadlock.
    if (isTeam && e.agentId === undefined && model.isEditTool(e.tool)) {
      const cwd = await $.session.cwd()
      const input = e as unknown as Record<string, unknown>
      const target = input.file_path ?? input.notebook_path
      const file = typeof target === 'string' ? target : undefined
      const inside = file?.startsWith(`${cwd}/`) ? file.slice(cwd.length + 1) : undefined
      const track = (await read($, liveAtom)).track ?? crew.EMPTY_TRACK

      if (inside !== undefined && crew.needsDesign(track, crew.isSmallEdit(track, inside, crew.editSize(e.tool, e as unknown as Record<string, unknown>)))) {
        await updateTrack($, current => ({ ...current, designDeniedAt: hookStart }))
        await audit($, 'team.design-required', { tool: e.tool })

        return { deny: crew.DESIGN_FIRST }
      }
    }
    const wb = await read($, wbAtom)
    const live = await read($, liveAtom)
    const cwd = await $.session.cwd()
    const verdict = applyRule(classify(e.tool, e), live.policy ? matchRule(live.policy.rules, e.tool, e, cwd) : undefined)
    const policy = decide(verdict, profileOf(wb, live), wb.execution.isPaused)
    const startedAt = await $.clock.now()
    let call: ToolCallRecord = {
      id: e.tool_use_id ?? `call-${startedAt}`,
      tool: e.tool,
      summary: summarize(e.tool, e),
      risk: verdict.risk,
      policy,
      category: verdict.category,
      ...(verdict.reason ? { reason: verdict.reason } : {}),
      outcome: 'running',
      startedAt,
      ...(e.agentId ? { agentId: e.agentId } : {}),
    }
    await mutate($, current => model.recordCall(current, call))
    const sub = (e as unknown as Record<string, unknown>).subagent_type
    await emit($, 'tool.start', {
      id: call.id,
      tool: e.tool,
      summary: call.summary,
      category: verdict.category,
      risk: verdict.risk,
      policy,
      ...(e.agentId ? { agent: e.agentId } : {}),
      ...(typeof sub === 'string' ? { subagent: sub } : {}),
    })

    if (policy === 'block') {
      await mutate($, current => model.recordCall(current, { ...call, outcome: 'blocked', durationMs: 0 }))
      await badge($, { ...call, outcome: 'blocked' })
      await audit($, 'guard.block', { tool: e.tool, input: call.summary, reason: verdict.reason, rule: verdict.category })

      return {
        deny: `SmartWorkbench blocked this ${e.tool} call: ${verdict.reason}. The user's guard policy forbids it; do not retry it another way. Ask the user if it is really needed.`,
      }
    }

    // "Allow for session" answers stand until the session ends, except while risky calls are paused.
    const scope = policy === 'ask' ? sessionScope(e.tool, e, verdict) : undefined
    const isSessionAllowed = scope !== undefined && !wb.execution.isPaused && (live.sessionAllows ?? []).some(one => one.key === scope.key)

    if (isSessionAllowed) {
      call = { ...call, policy: 'allow', sessionAllowed: true, reason: `${verdict.reason}; allowed for this session` }
      const allowed = call
      await mutate($, current => model.recordCall(current, allowed))
    } else if (policy === 'ask') {
      const options = scope ? ['Allow', 'Allow for session', 'Block'] : ['Allow', 'Block']
      const hint = scope ? ` ("Allow for session" stops asking for \`${model.cut(scope.label, 60)}\` until this session ends.)` : ''
      const answer = await $.ui
        .ask(`SmartWorkbench: ${verdict.reason}. Allow ${e.tool}: ${call.summary.slice(0, 80)}?${hint}`, { header: 'Guard', options })
        .catch(() => 'Block')

      if (answer !== 'Allow' && answer !== 'Allow for session') {
        const durationMs = (await $.clock.now()) - startedAt
        await mutate($, current => model.recordCall(current, { ...call, outcome: 'declined', durationMs }))
        await badge($, { ...call, outcome: 'declined' })
        await audit($, 'guard.ask', { tool: e.tool, input: call.summary, reason: verdict.reason, answer: 'declined' })

        return { deny: `The user declined this ${e.tool} call in SmartWorkbench (${verdict.reason}).` }
      }

      if (answer === 'Allow for session' && scope) {
        await allowForSession($, scope.key, scope.label)
      }
      await audit($, 'guard.ask', {
        tool: e.tool,
        input: call.summary,
        reason: verdict.reason,
        answer: answer === 'Allow' ? 'allowed' : 'allowed-session',
        ...(answer === 'Allow' || !scope ? {} : { scope: scope.label }),
      })
    }

    $.ui.log(`SmartWorkbench timing: tool.call guard ${(await $.clock.now()) - hookStart}ms for ${e.tool}`, { to: 'debug' })

    // Allow still goes through Claude Code's own permission check beneath.
    const ran = await next(e)
    const endedAt = await $.clock.now()
    const isOk = ran.deny === undefined && ran.isError !== true
    const outcome = ran.deny !== undefined ? 'blocked' : isOk ? 'ok' : 'error'
    const kind = e.tool === 'Bash' ? evidenceKindOf(e.command) : undefined
    const notebookPath = (e as unknown as Record<string, unknown>).notebook_path
    const rawPath =
      'file_path' in e && typeof e.file_path === 'string' ? e.file_path : typeof notebookPath === 'string' ? notebookPath : undefined
    const path = rawPath?.startsWith(`${cwd}/`) ? rawPath.slice(cwd.length + 1) : rawPath

    await mutate($, current => {
      let updated = model.recordCall(current, { ...call, outcome, durationMs: endedAt - startedAt })

      if (kind && e.tool === 'Bash' && ran.deny === undefined) {
        const result = (ran.isError ? undefined : ran.result) as { interrupted?: boolean; backgroundTaskId?: string } | undefined
        const isUnknown = result?.interrupted === true || result?.backgroundTaskId !== undefined
        const ok = isUnknown ? null : checkOutcome(e.command, kind, isOk)
        const record: EvidenceRecord = { id: call.id, kind, command: e.command.slice(0, 200), ok, at: endedAt }
        updated = model.addEvidence(updated, record)
      }

      return path && isOk ? model.observe(updated, e.tool, path, endedAt) : updated
    })

    const editedFile = rawPath
    if (isTeam && isOk && e.agentId === undefined && editedFile?.startsWith(`${cwd}/`) && model.isEditTool(e.tool)) {
      const lines = crew.editSize(e.tool, e as unknown as Record<string, unknown>).lines
      await updateTrack($, track => crew.noteEdit(track, editedFile.slice(cwd.length + 1), lines))
    }
    if (isTeam && isOk && e.tool === 'ExitPlanMode') {
      await updateTrack($, track => ({ ...track, planApprovedAt: endedAt }))
    }

    if (isOk && path === POLICY_PATH && model.isEditTool(e.tool)) {
      await loadPolicy($)
    }

    if (e.tool === 'Agent' && e.subagent_type === crew.ADVISOR && isOk) {
      await updateTrack($, track => crew.advisorRan(track, endedAt))
      await audit($, 'team.advisor', { description: e.description })
    } else if (isTeam && ran.deny === undefined && e.tool !== 'Agent') {
      const key = crew.failureKey(e.tool, e as unknown as Record<string, unknown>)
      let nudge = false
      const track = await updateTrack($, current => {
        const result = crew.trackResult(current, key, isOk)
        nudge = result.nudge
        return result.track
      })
      if (nudge) {
        await audit($, 'team.repeat-error', { tool: e.tool, input: call.summary, count: track.failures[key] ?? 0 })
        return { ...ran, context: [...(ran.context ?? []), crew.repeatNudge(track.failures[key] ?? crew.REPEAT_LIMIT)] }
      }
    }
    await badge($, { ...call, outcome })
    await emit($, 'tool.end', { id: call.id, outcome })

    return ran
  }).catch(($, e, next) => {
    if (next.called) {
      return next(e)
    }
    // The guard failed before deciding: high-risk calls fail closed, the rest go on as usual.
    try {
      return classify(e.tool, e).risk === 'high' ? { deny: 'SmartWorkbench guard failed; high-risk call not run.' } : next(e)
    } catch {
      return { deny: 'SmartWorkbench guard failed; call not run.' }
    }
  })

  on('turn.complete', async ($, e, next) => {
    const ran = await next(e)

    if (e.agentId !== undefined) {
      return ran
    }

    await refreshUsage($).catch(() => undefined)
    await emit($, 'turn', { aborted: e.isAborted === true })

    // The loop's first pass: a command cannot submit a prompt, the end of its turn can.
    // Not awaited: submit returns when the pass's turn ends, and this hook must not wait for a whole loop.
    const waiting = (await read($, liveAtom)).loop
    if (waiting?.pending && !e.isAborted) {
      await setLive($, current => ({ ...current, loop: current.loop && { ...current.loop, pending: false } }))
      await audit($, 'loop.start', { items: waiting.items.length, limit: waiting.limit ?? 'inf' }).catch(() => undefined)
      void Promise.resolve($.prompt.submit({ text: loop.iterationPrompt(waiting) })).catch(async () => {
        await setLive($, current => ({ ...current, loop: current.loop && { ...current.loop, pending: true } })).catch(() => undefined)
      })
    }

    // Esc takes the session back: a loop already running ends here, since an aborted turn sends no Stop.
    if (e.isAborted) {
      const running = (await read($, liveAtom)).loop
      if (running && !running.pending) {
        await setLive($, current => ({ ...current, loop: undefined }))
        await audit($, 'loop.stop', { done: running.done, by: 'abort' }).catch(() => undefined)
      }
    }

    const queued = (await read($, liveAtom)).pendingPrompt
    if (queued && !e.isAborted) {
      await setLive($, current => ({ ...current, pendingPrompt: undefined }))
      void Promise.resolve($.prompt.submit({ text: queued })).catch(() => undefined)
    }

    // Changed regions against HEAD, so the Evidence tab can say which ones a check has seen.
    const diff = await $.process.run(['git', 'diff', '-U0', '--no-color', '--no-ext-diff', 'HEAD']).catch(() => undefined)
    if (diff?.exitCode === 0) {
      const parsed = parseDiff(diff.stdout)
      await mutate($, current => model.applyDiff(current, parsed))
    }

    const wb = await read($, wbAtom)
    if (wb.task.goal.trim() !== '' && wb.task.doneConditions.length > 0 && !e.isAborted) {
      const lastEdit = lastCheckedEdit(wb.changed)
      const summary = turnSummary(wb.task, wb.evidence, lastEdit)
      const { met, total } = completionOf(wb.task, wb.evidence, lastEdit)
      const failing = wb.task.doneConditions.filter(one => statusOf(one, wb.evidence, lastEdit) === 'failed').length
      await setLive($, live => ({ ...live, lastSummary: summary, turnResult: { met, total, failing } }))
      // A log row is one line; each line of the summary gets its own.
      for (const line of summary.split('\n')) {
        $.ui.log(line)
      }
    }

    return ran
  }).catch(($, e, next) => next(e))

  // Two things can hold a turn here, in this order: team mode's final check (a turn that
  // changed code ends only after the advisor saw it, asked once per stop), then the loop's
  // next pass. A loop pass is counted only when the turn really ends.
  on('classic.Stop', async ($, e, next) => {
    const result = await next(e)
    const wb = await read($, wbAtom)
    const live = await read($, liveAtom)
    const running = live.loop

    if (wb.team?.enabled) {
      // A stop right after the loop held the turn starts a new pass, not a repeat of the same stop.
      const isRepeat = e.stop_hook_active && !running?.continuing
      const held = live.track ?? crew.EMPTY_TRACK
      // Later loop passes never go through prompt.submit, so the turn start is the start of this pass.
      const track = running?.passAt === undefined ? held : { ...held, turnStartedAt: Math.max(held.turnStartedAt ?? 0, running.passAt) }

      if (crew.needsFinalCheck(track, lastCheckedEdit(wb.changed), isRepeat)) {
        if (running?.continuing) await setLive($, current => ({ ...current, loop: current.loop && { ...current.loop, continuing: false } }))
        await audit($, 'team.final-check-required')

        return { ...result, block: crew.finalCheckReason(wb.task.goal, wb.task.doneConditions.map(one => one.text)) }
      }
    }

    // The command's own turn ends before pass 1 went out; that stop is not a pass.
    if (!running || running.pending) return result

    const lastEdit = lastAnyEdit(wb.changed)
    const step = loop.advance(running, lastEdit !== undefined && lastEdit >= (running.passAt ?? 0), await $.clock.now())
    await setLive($, current => ({ ...current, loop: step.loop }))
    await updateTrack($, ({ turnEdits: _passEdits, ...track }) => track)
    await audit($, step.loop ? 'loop.pass' : 'loop.done', { done: running.done + 1 }).catch(() => undefined)
    if (step.text) $.ui.toast(`SmartWorkbench: ${step.text}`)

    return step.reason ? { ...result, block: step.reason } : result
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    if (e.surface === 'mobile') {
      const { Markdown } = $.ui.resolve(e)
      const text = model.bandText(await read($, wbAtom), await read($, liveAtom))

      return <Markdown text={'```\n' + text + '\n```\nOpen the session in a terminal or the desktop app to edit.'} />
    }

    return pane($, $.ui.resolve(e), Math.max(24, e.props.bodyColumns ?? 48), e.viewport?.rows ?? 30)
  })

  // Keeps the engine's own tool row and adds one line of risk, policy and evidence under it.
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    const row = await next(e)
    const id = e.props.tool_use_id
    const text = (await read($, badgesAtom))[id]
    const isFailed = e.props.isErrored && !e.props.isRunning && !e.props.isInterrupted && e.props.tool !== PROPOSE_TOOL

    if (text === undefined && !isFailed) {
      return row
    }

    const { Box, Text, Button } = $.ui.resolve(e)
    const color = text && /Blocked|Declined|failed/.test(text) ? 'error' : text && /passed/.test(text) ? 'success' : 'warning'
    const input = (e.props.input ?? {}) as Record<string, unknown>
    const summary = summarize(e.props.tool, input)
    const command = typeof input.command === 'string' ? input.command : undefined
    const isCounted = (await read($, wbAtom)).evidence.some(one => one.id === id)

    return (
      <Box flexDirection="column">
        {row}
        {text !== undefined && (
          <Text color={color} dimColor wrap="truncate-end">
            {'  '}
            {text}
          </Text>
        )}
        {isFailed && (
          <Box gap={1} marginLeft={2}>
            <Button key={`explain-${id}`} plain dimColor label="Explain" onPress={() => void explainCall($, e.props.tool, summary)} />
            <Button key={`retry-${id}`} plain dimColor label="Retry" onPress={() => void retryCall($, e.props.tool, summary)} />
            {command !== undefined && !isCounted && (
              <Button key={`count-${id}`} plain dimColor label="Add evidence" onPress={() => void countAsCheck($, id, command, false)} />
            )}
          </Box>
        )}
      </Box>
    )
  }).catch(($, e, next) => next(e))

  // Composes with whatever else draws the band: ours goes under it, never over it.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    const wb = await read($, wbAtom)

    if (e.props.hasSurvey || (wb.task.goal.trim() === '' && wb.context.pins.length === 0)) {
      return below
    }

    const live = await read($, liveAtom)
    const { Box, Text, Button } = $.ui.resolve(e)
    const { isComplete } = completionOf(wb.task, wb.evidence, lastCheckedEdit(wb.changed))

    return (
      <Box flexDirection="column">
        {below}
        <Box gap={1}>
          <Text color={isComplete ? 'success' : wb.task.locked ? 'claude' : undefined} dimColor={!wb.task.locked} wrap="truncate-end">
            {model.bandText(wb, live)}
          </Text>
          <Button key="wb-open" plain label="Open" onPress={() => void openPane($)} />
        </Box>
        {live.turnResult && live.turnResult.total > 0 && live.turnResult.met < live.turnResult.total && (
          <Box gap={1}>
            <Text color="warning">
              Turn ended INCOMPLETE · {live.turnResult.met}/{live.turnResult.total} done
              {live.turnResult.failing > 0 ? ` · ${live.turnResult.failing} failing` : ''}
            </Text>
            <Button
              key="wb-fix"
              plain
              label={live.turnResult.failing > 0 ? 'Fix failures' : 'Ask Claude to finish'}
              onPress={() => void clearTurnResult($).then(() => askToFinish($, wb))}
            />
            <Button key="wb-waive" plain dimColor label="Waive" onPress={() => void waiveFromBand($)} />
            <Button key="wb-evidence" plain dimColor label="Open evidence" onPress={() => void openPane($, 'evidence')} />
            <Button key="wb-dismiss" plain dimColor label="×" onPress={() => void clearTurnResult($)} />
          </Box>
        )}
      </Box>
    )
  })
}
