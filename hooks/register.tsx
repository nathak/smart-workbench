import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, Register, RenderElement } from 'claude-code'

import type { ConditionStatus, ContextPin, EvidenceKind, EvidenceRecord, GuardProfile, Live, Proposal, ProposalChange, Tab, TeamRoleName, Template, ToolCallRecord, Track, Workbench } from '../types'
import * as codex from './codex'
import * as crew from './crew'
import * as loop from './loop'
import { LEDGER_TEXT_MAX, LEDGER_VERSION, editedTurns, isGitCommit, isOwnCommit, ledgerLine, locate, commitBase, frameData, isSharedEvent, maskPersonal, mergeLedgers, mergeNote, mergeNotes, parseLedger, parseSearch, personalHits, publishEvents, pushOutcome, searchLedger, sessionNote, sharedPaths, turnReport, whyTarget, wikiMerge, wikiPage, wikiProject, wikiTarget, type Found, type LedgerEvent } from './ledger'
import { editPolicy, isPolicyEditOp, type PolicyEditOp } from './policy-edit'
import { applyOps, feedStateOf, isSettingOp, needsAnswer, snapshotText, type AskView, type DeskOp, type SettingOp } from './desktop'
import { PROPOSE_TOOL } from './intent'
import { estimateTokens, injectionOf, pinText, rangeLabel, sha256, sliceLines, type Injection, type PinContent } from './context'
import { coverageOf, hunkLabel, lastCheckedEdit, lastEdit as lastAnyEdit, parseDiff, type Coverage } from './diff'
import { checkOutcome, completionOf, evidenceKindsOf, isStale, latestOf, markOf, statusOf, turnSummary } from './evidence'
import { affectsChecks, categoryOf, suggestionsOf } from './files'
import * as model from './model'
import { AUDIT_PATH, POLICY_PATH, POLICY_TEMPLATE, applyRule, matchRule, parsePolicy, repoPath } from './policy'
import { SHARE_PATH, appendAudit, auditLine, ciEvidence, ciSummary, formatAudit, issueRef, parseIssueArg, readAudit, readShare, shareText, type GhRun } from './team'
import { badgeOf, handoffMarkdown } from './report'
import { ALWAYS_ASK, classify, decide, effectiveProfile, redact, sessionScope, summarize } from './risk'
import { workflowOf } from './workflow'

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
  '  /smartworkbench intent     open the Intent tab',
  '  /smartworkbench context    open the Context tab',
  '  /smartworkbench run        open the Run tab',
  '  /smartworkbench verify     open the Evidence tab (also: evidence)',
  '  /smartworkbench lock | unlock   lock the contract (added to every prompt) or unlock it to edit',
  '  /smartworkbench team [on|off]   team mode: Opus designs and reviews, Sonnet builds, Haiku explores',
  '  /smartworkbench team <lead|explorer|advisor> <model> [effort]   set a role\'s model and effort',
  '  /smartworkbench team codex on|off|check|review on|off|rescue on|off   optional Codex second opinion',
  '  /smartworkbench live [port|stop] [--no-prompts]   live web view of the request flow (stop: off)',
  '  /smartworkbench advise [topic]  ask the Opus advisor now',
  '  /smartworkbench loop <count|inf> <item>[; <item>...]   repeat a task; works with team mode (loop stop | loop status)',
  '  /smartworkbench status     text summary (works without UI)',
  '  /smartworkbench preview    show the context added to each prompt',
  '  /smartworkbench save <name>      save the contract, pins and guard as a template',
  '  /smartworkbench load <name>      start a task from a template',
  '  /smartworkbench templates        list templates and context sets',
  '  /smartworkbench export [path]    write a Markdown handoff (default .claude/smartworkbench-handoff.md)',
  '  /smartworkbench ledger [on|off]  record conversation, actions and guard decisions beside the repository (off until turned on)',
  '  /smartworkbench ledger publish|fetch|search|forget  share sessions through the swb-ledger branch, read teammates\' sessions, search, delete',
  '  /smartworkbench why <file[:line]|commit>  show the turn, decisions and guard calls behind a change',
  '  /smartworkbench scope [session|project]  keep this project\'s workbench and live view per session, or shared by all sessions ',
  '  /smartworkbench notify [on|off|test]  send a notification when the guard waits for your answer (on by default; uses your terminal\'s notification channel)',
  '  /smartworkbench guard [high|medium|low|off]   how strict the guard is (medium is the default)',
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
const EDIT_TOOL_NAMES = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

// ---- state: $.state for drawing, $.store (per project) to survive restarts

const SESSION_ID = /^[A-Za-z0-9_-]{1,64}$/
const SESSION_COPY_DAYS = 30
const SCOPE_TAKE = "Take the project's workbench"
const SCOPE_WRITE = 'Overwrite project with this session'

async function projectKey($: $): Promise<string> {
  return `ws:${await $.session.root()}`
}

async function scopeKey($: $): Promise<string> {
  return `wsscope:${await $.session.root()}`
}

// The session's own copy while it keeps one (/swb scope session), else the project's shared copy.
async function activeKey($: $): Promise<string> {
  const { scope, sessionId } = await read($, liveAtom)

  return scope === 'session' && sessionId !== undefined ? `wss:${sessionId}:${await $.session.root()}` : projectKey($)
}

async function isSessionScope($: $): Promise<boolean> {
  return (await read($, liveAtom)).scope === 'session'
}

async function load($: $): Promise<Workbench> {
  const restored = model.restore(await $.store.get(await activeKey($)))
  await update($, wbAtom, () => restored)

  return restored
}

// The session id inside a per-session key of this project, or undefined for any other key.
function sessionKeyId(key: string, root: string): string | undefined {
  if (!key.startsWith('wss:')) return undefined
  const rest = key.slice(4)
  const cut = rest.indexOf(':')

  return cut >= 1 && rest.slice(cut + 1) === root ? rest.slice(0, cut) : undefined
}

// Decides the scope for this session and, for a session scope (the default), starts it from a one-time copy of the
// workbench the project last had: the newest copy another session saved, else the project's own. Called once at session
// start, after the session id is known.
async function startScope($: $, sessionId: string | undefined): Promise<void> {
  const choice = await $.store.get(await scopeKey($)).catch(() => undefined)
  const usable = sessionId !== undefined && SESSION_ID.test(sessionId)

  if (choice === 'project' || !usable) {
    // The state outlives a /clear: a scope another session switched off since must not stay on here.
    await setLive($, live => ({ ...live, scope: undefined }))
    if (choice === 'session') $.ui.toast('SmartWorkbench: this session has no usable id, so it shares the project workbench')
    if (sessionId !== undefined) await sweepSessions($, sessionId)
    return
  }

  await setLive($, live => ({ ...live, scope: 'session' }))
  const own = await activeKey($)

  if ((await $.store.get(own)) === undefined) {
    const root = await $.session.root()
    let source: unknown = await $.store.get(await projectKey($))
    let newest = -1
    for (const key of await $.store.keys().catch(() => [] as string[])) {
      const id = sessionKeyId(key, root)
      if (id === undefined || id === sessionId) continue
      const saved = await $.store.get(key).catch(() => undefined)
      const at = model.isWorkbench(saved) ? (saved.savedAt ?? 0) : -1
      if (at > newest) {
        newest = at
        source = saved
      }
    }
    await $.store.set(own, model.sessionCopy(model.fill(source), sessionId, await $.clock.now()))
  }

  await sweepSessions($, sessionId)
}

// Another session's copy for this project that nobody has saved to for a month is gone for good.
async function sweepSessions($: $, ownId: string): Promise<void> {
  const root = await $.session.root()
  const limit = (await $.clock.now()) - SESSION_COPY_DAYS * 86_400_000
  const keys = await $.store.keys().catch(() => [] as string[])

  for (const key of keys) {
    const id = sessionKeyId(key, root)
    if (id === undefined || id === ownId) continue
    const saved = await $.store.get(key).catch(() => undefined)
    const at = model.isWorkbench(saved) ? saved.savedAt : undefined
    if (typeof at === 'number' && at < limit) await $.store.delete(key).catch(() => undefined)
  }
}

// A project path as the engine reads it: relative paths and commands follow the shell's directory, which a `cd` moves,
// so what belongs to the project is always given from the project root.
async function rooted($: $, path: string): Promise<string> {
  return path.startsWith('/') || path.startsWith('\\\\') || /^[A-Za-z]:[\\/]/.test(path) ? path : `${await $.session.root()}/${path}`
}

// Every save builds on the newest copy: when another session of this project saved
// since this one last did, its state is taken first, so neither overwrites the other.
async function mutate($: $, change: (wb: Workbench) => Workbench): Promise<Workbench> {
  const key = await activeKey($)
  const { sessionId, scope } = await read($, liveAtom)
  const own = scope === 'session'
  const saved = own ? undefined : await $.store.get(key)
  const before = await read($, wbAtom)
  const savedRev = model.isWorkbench(saved) ? (saved.rev ?? 0) : 0
  const stamp = own ? await $.clock.now() : undefined
  const next = await update($, wbAtom, wb => {
    // A session's own copy is only ever saved by that session, so there is no newer one to take.
    const base = model.isNewerElsewhere(saved, wb, sessionId) ? model.fill(saved) : wb
    const changed = model.withStatus(change(base))

    return { ...changed, rev: Math.max(base.rev ?? 0, savedRev) + 1, ...(sessionId ? { savedBy: sessionId } : {}), ...(stamp !== undefined ? { savedAt: stamp } : {}) }
  })
  await $.store.set(key, next)
  scheduleSnapshot($)

  if (before.task.status !== 'complete' && next.task.status === 'complete') {
    await audit($, 'task.complete', { goal: next.task.goal, conditions: next.task.doneConditions.length })
  }

  return next
}

// Takes another session's newer save before a prompt, so this one works from the same contract.
async function pull($: $): Promise<void> {
  if (await isSessionScope($)) return
  const saved = await $.store.get(await projectKey($))
  const { sessionId } = await read($, liveAtom)

  if (model.isNewerElsewhere(saved, await read($, wbAtom), sessionId)) {
    await update($, wbAtom, () => model.fill(saved))
    $.ui.toast('SmartWorkbench: picked up changes made in another session')
    scheduleSnapshot($)
  }
}

// Live feed for tools/live.mjs: one JSON line per event, written only while that server keeps the file in place.
// Never throws and costs one fs.exists per event when nobody watches.
const LIVE_FILE = '.claude/smartworkbench-live.jsonl'
const PID_FILE = '.claude/smartworkbench-live.pid'

// The feed and process note this session writes: the project's pair, or the session's own pair in session scope.
async function liveFiles($: $): Promise<{ feed: string; note: string; feedRel: string; noteRel: string }> {
  const root = await $.session.root()
  const { scope, sessionId } = await read($, liveAtom)
  const own = scope === 'session' && sessionId !== undefined
  const feedRel = own ? `.claude/smartworkbench-live/${sessionId}.jsonl` : LIVE_FILE
  const noteRel = own ? `.claude/smartworkbench-live/${sessionId}.pid` : PID_FILE

  return { feed: `${root}/${feedRel}`, note: `${root}/${noteRel}`, feedRel, noteRel }
}

// tee is the cheap way to append one line; where it is missing (Windows without a Unix shell) or fails, node does it, for the rest of the session.
const APPEND_SCRIPT = "require('fs').appendFileSync(process.argv[1], require('fs').readFileSync(0))"
let appender: 'tee' | 'node' = 'tee'

async function appendLine($: $, path: string, text: string): Promise<void> {
  if (appender === 'tee') {
    const ran = await $.process.run(['tee', '-a', path], { stdin: text }).catch(() => undefined)
    if (ran?.exitCode === 0) return
    appender = 'node'
  }
  const ran = await $.process.run(['node', '-e', APPEND_SCRIPT, '--', path], { stdin: text })
  if (ran.exitCode !== 0) throw new Error(ran.stderr.trim().split('\n').pop() || `node exited with ${ran.exitCode}`)
}

// Feed writes that failed since the last good one; the person is told once per session, and the page gets a line when writes work again.
let feedMissed = 0
let isFeedNoted = false
// Whether anyone can answer a question in this session (false for `claude -p` and the SDK), and when the last notification went out.
let isAskable = true
let lastAskNotice = 0
const ASK_NOTICE_GAP_MS = 5000

// The text a prompt event carries for the live view's per-segment list: secrets masked, cut, with its real length.
// Only the first PROMPT_SCAN characters are scanned for secrets, so a huge paste cannot make the masking slow; nothing past PROMPT_MAX is kept.
const PROMPT_MAX = 2000
const PROMPT_SCAN = 8000

// A scan window that ends inside a word would leave half a token below its length limits, so the cut word is dropped.
function scanned(text: string): string {
  return text.length <= PROMPT_SCAN ? text : text.slice(0, PROMPT_SCAN).replace(/\S*$/, '')
}

// key: 'prompt' for what is sent to a model, 'output' for what a subagent sent back; the Length, Cut and Scanned fields follow it.
function promptOf(live: Live, text: string, key: 'prompt' | 'output' | 'toolIn' | 'toolOut' = 'prompt'): Record<string, unknown> {
  if (live.livePrompts === false) return {}
  const masked = redact(scanned(text))

  return {
    [key]: model.cut(masked, PROMPT_MAX),
    [`${key}Length`]: text.length,
    // Masking alone can shorten a text, so "cut" and "only the start was scanned" are sent as facts, not guessed from lengths.
    ...(masked.length > PROMPT_MAX ? { [`${key}Cut`]: true } : {}),
    ...(text.length > PROMPT_SCAN ? { [`${key}Scanned`]: PROMPT_SCAN } : {}),
  }
}

// The input and the result of an ordinary tool call, as text for the call's input and output tabs. Agent, Workflow and Codex calls carry their own fields.
// A call that touches a secrets file shows neither, and every text goes through the same masking and length limits as a prompt.
const NO_IO = new Set(['secret-output', 'secret-file', 'guard-policy', 'desktop-channel'])

function inputText(input: unknown): string {
  const args = (input ?? {}) as Record<string, unknown>
  if (typeof args.command === 'string') return args.command
  const shown = Object.fromEntries(Object.entries(args).filter(([key]) => key !== 'tool' && key !== 'tool_use_id' && key !== 'agentId').map(([key, value]) => [key, typeof value === 'string' && value.length > 4000 ? `${value.slice(0, 4000)}…` : value]))

  return JSON.stringify(shown, null, 2)
}

function resultText(result: unknown): string {
  if (typeof result === 'string') return result
  if (typeof result !== 'object' || result === null) return ''
  const one = result as Record<string, unknown>
  const streams = [one.stdout, one.stderr].filter((part): part is string => typeof part === 'string' && part !== '')
  if (streams.length > 0) return streams.join('\n')
  const content = one.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map(part => (typeof part === 'object' && part !== null && typeof (part as { text?: unknown }).text === 'string' ? (part as { text: string }).text : '')).filter(Boolean).join('\n')
  const file = one.file
  if (typeof file === 'object' && file !== null && typeof (file as { content?: unknown }).content === 'string') return (file as { content: string }).content
  try {
    return JSON.stringify(result, null, 2).slice(0, 20000)
  } catch {
    return ''
  }
}

// What the live view shows of a Workflow call: its name and description as the script states them, and the script with its args as the input.
function workflowFields(live: Live, input: unknown): Record<string, unknown> {
  const wf = workflowOf(input)

  return {
    ...(wf.name ? { workflow: wf.name } : {}),
    ...(wf.description ? { workflowDesc: wf.description } : {}),
    ...(wf.saved ? { workflowSaved: true } : {}),
    ...(wf.resume ? { workflowResume: true } : {}),
    ...(wf.text ? promptOf(live, wf.text) : {}),
  }
}

// What each subagent answered at the end of its run, until the Agent call that started it returns and carries it to the page.
const agentAnswers = new Map<string, Record<string, unknown>>()
// Advisors started in the background, by agent id, until their run ends.
const backgroundAdvisors = new Map<string, { id: string; description: string }>()

// The answer of the subagent an Agent call ran: from the run's own last turn (found by the agent id in the call's record), or the
// result itself when the tool returned plain text.
async function agentOutput($: $, result: unknown): Promise<Record<string, unknown>> {
  const id = typeof result === 'object' && result !== null ? (result as { agentId?: unknown }).agentId : undefined
  if (typeof id === 'string' && agentAnswers.has(id)) {
    const held = agentAnswers.get(id) ?? {}
    agentAnswers.delete(id)

    return { agentRun: id, ...held }
  }
  if (typeof result === 'string' && result !== '') return promptOf(await read($, liveAtom), result, 'output')

  return typeof id === 'string' ? { agentRun: id } : {}
}

// Recorded where they happen (the prompt) or only for the live view (the state line and the evidence results), never in the ledger.
const FEED_ONLY = new Set(['prompt', 'wb', 'evidence'])
let stateLast = ''

// The contract and guard state for the live view's header and its intent and evidence views; a line only when something changed.
async function emitState($: $): Promise<void> {
  try {
    const state = feedStateOf(await read($, wbAtom), await read($, liveAtom))
    const text = JSON.stringify(state)
    if (text === stateLast) return
    // Remembered only once the line is written: state computed while no live view runs is still owed to the next one.
    if (await emit($, 'wb', state)) stateLast = text
  } catch {
    // The feed is optional.
  }
}

// True when the line reached the feed.
async function emit($: $, kind: string, detail: Record<string, unknown> = {}): Promise<boolean> {
  // The prompt's full text is recorded where it is received; every other event is the feed's event.
  if (ledger && !FEED_ONLY.has(kind)) await record($, kind, detail).catch(() => undefined)
  try {
    const { feed: path, note } = await liveFiles($)
    // The feed is written only while a live server owns it: its process note must be beside it, so a feed file that was committed to the repository is never appended to.
    if (!(await $.fs.exists(path)) || !(await $.fs.exists(note))) return false
    const session = (await read($, liveAtom)).sessionId
    // Every text the feed carries is masked here, so a command summary or a URL cannot carry a secret around the prompt masking.
    const masked = Object.fromEntries(Object.entries(detail).map(([key, value]) => [key, typeof value === 'string' ? redact(scanned(value)) : value]))
    const at = await $.clock.now()
    const line = JSON.stringify({ at, kind, ...(session ? { session } : {}), ...masked })
    try {
      // A newline first: a line that an earlier, failed write left half finished ends there instead of swallowing this one.
      await appendLine($, path, `\n${line}\n`)
    } catch (error) {
      const why = model.cut(error instanceof Error ? error.message : String(error), 120)
      // Every new failed stretch is shown by /swb live; the toast is only for the first.
      if (feedMissed === 0) await setLive($, current => ({ ...current, feedError: why })).catch(() => undefined)
      feedMissed++
      if (!isFeedNoted) {
        isFeedNoted = true
        $.ui.toast(`SmartWorkbench: the live feed cannot be written (${why}); the live view will miss events.`)
      }
      return false
    }
    if (feedMissed > 0) {
      const missed = feedMissed
      // The count is cleared only once the line that reports it is written, so a failure of that line does not lose it.
      const noted = await appendLine($, path, `\n${JSON.stringify({ at, kind: 'feed.recovered', missed })}\n`).then(() => true, () => false)
      if (noted) {
        feedMissed -= missed
        await setLive($, current => ({ ...current, feedError: undefined })).catch(() => undefined)
      }
    }
    return true
  } catch {
    // The feed is optional.
    return false
  }
}

// Appends to the audit log when the project guard file turns it on; never throws, so a
// failed write can never let a guarded call through.
async function audit($: $, event: string, detail: Record<string, unknown> = {}): Promise<void> {
  await emit($, event, detail)
  if (/^(task|contract|condition|guard\.(profile|pause|session)|team\.(on|off))/.test(event)) await emitState($)
  try {
    const live = await read($, liveAtom)
    const config = live.policy?.audit
    if (!config) return
    const at = new Date(await $.clock.now()).toISOString()
    // The log is committed by some teams: a command with a token in it must not reach it as typed.
    const masked = Object.fromEntries(Object.entries(detail).map(([key, value]) => [key, typeof value === 'string' ? redact(value) : value]))
    const line = auditLine({ at, event, ...(live.user ? { user: live.user } : {}), ...(live.sessionId ? { session: live.sessionId } : {}), ...masked })
    const { text, rotated } = appendAudit(await $.fs.read(await rooted($, config.path)).catch(() => undefined), line)
    if (rotated !== undefined) {
      await $.fs.write(await rooted($, `${config.path}.1`), rotated)
    }
    await $.fs.write(await rooted($, config.path), text)
  } catch (error) {
    $.ui.log(`SmartWorkbench: audit write failed: ${error instanceof Error ? error.message : String(error)}`, { to: 'debug' })
  }
}

// ---- decision ledger: off until /swb ledger on. One JSON line per event in a file of its own for each run of a session, beside the repository's
// git data (so it is never committed by accident), kept as the source of truth; later readers (/swb why) only read it.
type LedgerState = { dir: string; session: string; seq: number; turn: number; head?: string; goal?: string }
let ledger: LedgerState | undefined
let isLedgerNoted = false

async function ledgerDirOf($: $): Promise<string> {
  const root = await $.session.root()
  const ran = await $.process.run(['git', 'rev-parse', '--git-common-dir'], { cwd: root }).catch(() => undefined)
  const out = ran?.exitCode === 0 ? ran.stdout.trim() : ''
  if (out === '') return `${root}/.claude/swb-ledger`

  return `${/^(?:[A-Za-z]:)?[\\/]/.test(out) ? out : `${root}/${out}`}/swb-ledger`
}

const MKDIR_SCRIPT = "require('fs').mkdirSync(process.argv[1], { recursive: true })"
// The newest session files, whole, up to a size: the reader never holds the whole history.
const READ_LEDGER_SCRIPT =
  "const fs=require('fs'),p=require('path');const d=p.join(process.argv[1],'sessions');let out=[],used=0;try{const files=fs.readdirSync(d).filter(f=>f.endsWith('.jsonl')).map(f=>({f,t:fs.statSync(p.join(d,f)).mtimeMs})).sort((a,b)=>b.t-a.t);for(const {f} of files){let text=fs.readFileSync(p.join(d,f),'utf8');if(text.length>8e6)text=text.slice(-8e6).replace(/^[^\\n]*\\n/,'');used+=text.length;if(used>8e6)break;out.push(text)}}catch{}process.stdout.write(out.join('\\n'))"

const ledgerText = (text: string): string => redact(text.length <= LEDGER_TEXT_MAX ? text : text.slice(0, LEDGER_TEXT_MAX).replace(/\S*$/, ''))

async function gitOut($: $, argv: string[]): Promise<string | undefined> {
  const ran = await $.process.run(['git', '-c', 'core.quotePath=false', ...argv], { cwd: await $.session.root() }).catch(() => undefined)

  return ran?.exitCode === 0 ? ran.stdout : undefined
}

// Never throws: a ledger that cannot be written is told once and the work goes on.
async function record($: $, kind: string, detail: Record<string, unknown> = {}): Promise<void> {
  const one = ledger
  if (!one) return
  try {
    const masked = Object.fromEntries(Object.entries(detail).map(([key, value]) => [key, typeof value === 'string' ? ledgerText(value) : value]))
    const event: LedgerEvent = { ...masked, v: LEDGER_VERSION, seq: ++one.seq, at: await $.clock.now(), session: one.session, turn: one.turn, kind }
    await appendLine($, `${one.dir}/sessions/${one.session}.jsonl`, `\n${ledgerLine(event)}\n`)
  } catch (error) {
    if (!isLedgerNoted) {
      isLedgerNoted = true
      $.ui.toast(`SmartWorkbench: the ledger cannot be written (${model.cut(error instanceof Error ? error.message : String(error), 120)}); this session's history will have gaps.`)
    }
  }
}

async function ledgerStart($: $, force = false): Promise<void> {
  ledger = undefined
  isLedgerNoted = false
  const dir = await ledgerDirOf($)
  if (!force && !(await $.fs.exists(`${dir}/enabled`))) return
  await $.process.run(['node', '-e', MKDIR_SCRIPT, '--', `${dir}/sessions`]).catch(() => undefined)
  // Where git's own directory cannot be found the ledger sits in the work tree: it ignores itself, so one `git add -A` cannot publish a conversation.
  if (!(await $.fs.exists(`${dir}/.gitignore`))) await $.fs.write(`${dir}/.gitignore`, '*\n').catch(() => undefined)
  const live = await read($, liveAtom)
  const now = await $.clock.now()
  const head = (await gitOut($, ['rev-parse', 'HEAD']))?.trim()
  ledger = { dir, session: `${(live.sessionId ?? 'local').slice(0, 8)}-${now.toString(36)}`, seq: 0, turn: 0, ...(head ? { head } : {}) }
  const name = (await gitOut($, ['config', 'user.name']))?.trim()
  const branch = (await gitOut($, ['rev-parse', '--abbrev-ref', 'HEAD']))?.trim()
  await record($, 'session.start', { ...(name ? { user: name } : {}), ...(branch ? { branch } : {}), ...(head ? { head } : {}) })
}

// Commits made since the last look, with the files each one touched. Only what the reflog says was committed (commit, amend, cherry-pick, revert) is
// recorded as made here; a pull, checkout, merge or reset moves HEAD over other people's commits, which are not this session's work.
// `via` says where it was noticed (a commit noticed at the next prompt may have been made by hand).
async function noteCommits($: $, via: 'tool' | 'turn' | 'prompt'): Promise<void> {
  const one = ledger
  if (!one) return
  const sha = (await gitOut($, ['rev-parse', 'HEAD']))?.trim()
  if (!sha || sha === one.head) return
  const before = one.head
  one.head = sha
  const reflog = await gitOut($, ['log', '-g', '--format=%H%x09%gs', '-n', '50', 'HEAD'])
  if (reflog === undefined) return
  const made: string[] = []
  for (const row of reflog.split('\n')) {
    const [id, ...rest] = row.split('\t')
    if (!id) continue
    if (id === before) break
    if (isOwnCommit(rest.join('\t'))) made.push(id)
  }
  for (const id of made.reverse()) {
    const subject = (await gitOut($, ['log', '-1', '--format=%s', id]))?.trim() ?? ''
    const files = (await gitOut($, ['diff-tree', '--no-commit-id', '--name-only', '-r', '--root', '--relative', id]))?.split('\n').filter(Boolean).slice(0, 50) ?? []
    await record($, 'commit', { sha: id, subject, files, via })
  }
}

async function readLedger($: $, dir: string): Promise<LedgerEvent[]> {
  const ran = await $.process.run(['node', '-e', READ_LEDGER_SCRIPT, '--', dir]).catch(() => undefined)

  return ran?.exitCode === 0 ? parseLedger(ran.stdout) : []
}

async function ledgerCommand($: $, args: string): Promise<{ text: string }> {
  const [first = '', ...more] = args.trim().split(/\s+/)
  const name = first.toLowerCase()
  const rest = more.join(' ')
  if (name === 'publish') return publishCommand($, rest)
  if (name === 'fetch') return fetchCommand($)
  if (name === 'search') return searchCommand($, rest)
  if (name === 'forget') return forgetCommand($, rest)
  if (name === 'export-wiki') return exportWikiCommand($, rest)
  const dir = await ledgerDirOf($)
  const isOn = await $.fs.exists(`${dir}/enabled`)
  if (name === 'on') {
    await $.process.run(['node', '-e', MKDIR_SCRIPT, '--', `${dir}/sessions`])
    await $.fs.write(`${dir}/enabled`, '1\n')
    await ledgerStart($, true)

    return { text: `Ledger on. From now on this session's prompts, answers, actions, guard decisions, edits and commits are written to ${dir}/sessions (masked; local only, never committed). /swb why <file[:line]|commit> reads it. /swb ledger off stops recording and keeps what was written (other sessions already running stop at their next start).` }
  }
  if (name === 'off') {
    await $.process.run(['node', '-e', REMOVE_SCRIPT, '--', `${dir}/enabled`]).catch(() => undefined)
    ledger = undefined

    return { text: `Ledger off. What was written stays in ${dir}/sessions.` }
  }
  if (name !== '' && name !== 'status') return { text: 'Usage: /swb ledger [on|off|status|publish [session]|fetch|search <words>|forget <session>|export-wiki [path]]' }
  const events = isOn ? await readLedger($, dir) : []
  const sessions = new Set(events.map(one => one.session)).size

  return { text: `Ledger: ${isOn ? 'on' : 'off'} (${dir}).${isOn ? ` ${events.length} events from ${sessions} session runs; this run ${ledger?.session ?? 'is not recording'}.` : '\n/swb ledger on records the conversation, actions and guard decisions of this project beside its git data, so /swb why can say why a change was made.'}` }
}

// ---- sharing the ledger through a branch of the repository's own: `swb-ledger`, written with git plumbing and a temporary index, so the
// work tree and the current branch are never touched. A published session is a summary (no tool input or output), shown to the person first.
const BRANCH = 'swb-ledger'
const SHARE_TIMEOUT = 60000
const GIT = ['git', '-c', 'core.quotePath=false']

async function gitRun($: $, argv: string[], init: { stdin?: string; env?: Record<string, string>; timeoutMs?: number } = {}): Promise<{ ok: boolean; out: string; err: string; code: number }> {
  const ran = await $.process.run([...GIT, ...argv], { cwd: await $.session.root(), ...init }).catch(error => ({ exitCode: 1, stdout: '', stderr: String(error) }))

  return { ok: ran.exitCode === 0, out: ran.stdout, err: ran.stderr, code: ran.exitCode }
}

async function remoteOf($: $): Promise<string | undefined> {
  const chosen = (await gitRun($, ['config', '--get', `branch.${BRANCH}.remote`])).out.trim()
  if (chosen) return chosen
  const list = (await gitRun($, ['remote'])).out.split('\n').map(one => one.trim()).filter(Boolean)

  return list.includes('origin') ? 'origin' : list.length === 1 ? list[0] : undefined
}

// The remote's branch is kept only as refs/remotes/<remote>/swb-ledger, so fetching needs no merge.
async function fetchShared($: $, remote: string): Promise<'ok' | 'missing' | string> {
  const ran = await gitRun($, ['fetch', '--no-tags', '--quiet', remote, `+refs/heads/${BRANCH}:refs/remotes/${remote}/${BRANCH}`], { timeoutMs: SHARE_TIMEOUT })
  if (ran.ok) return 'ok'

  return /couldn't find remote ref/i.test(ran.err) ? 'missing' : model.cut(ran.err.trim().split('\n').pop() ?? `git exited with ${ran.code}`, 160)
}

type SharedEntry = { sha: string; path: string; size: number }

// Every session file on the local and the fetched branches, newest month first, up to a size; the events are read in one cat-file call.
async function readShared($: $): Promise<{ events: LedgerEvent[]; entries: SharedEntry[] }> {
  // A fetched branch is read before the local one: when both hold a session's file, the fetched one is the newer publication.
  const refs = (await gitRun($, ['for-each-ref', '--format=%(refname)', `refs/heads/${BRANCH}`, `refs/remotes/*/${BRANCH}`])).out.split('\n').map(one => one.trim()).filter(Boolean).sort((a, b) => Number(a.startsWith('refs/heads/')) - Number(b.startsWith('refs/heads/')))
  const seen = new Map<string, SharedEntry>()
  for (const ref of refs) {
    for (const row of (await gitRun($, ['ls-tree', '-r', '-l', ref, '--', 'sessions/'])).out.split('\n')) {
      const match = /^\d+ blob (\w+)\s+(\d+)\t(.+)$/.exec(row)
      if (match && !seen.has(match[3] as string)) seen.set(match[3] as string, { sha: match[1] as string, size: Number(match[2]), path: match[3] as string })
    }
  }
  const entries = [...seen.values()].sort((a, b) => b.path.localeCompare(a.path))
  const picked: SharedEntry[] = []
  let used = 0
  for (const one of entries) {
    if (used + one.size > 8e6) break
    used += one.size
    picked.push(one)
  }
  if (picked.length === 0) return { events: [], entries }
  const read = await gitRun($, ['cat-file', '--batch'], { stdin: `${picked.map(one => one.sha).join('\n')}\n` })

  return { events: read.ok ? parseLedger(read.out, isSharedEvent) : [], entries }
}

async function allLedger($: $, dir: string): Promise<LedgerEvent[]> {
  return mergeLedgers(await readLedger($, dir), (await readShared($)).events)
}

async function branchTip($: $, ref: string): Promise<string | undefined> {
  const ran = await gitRun($, ['rev-parse', '-q', '--verify', `${ref}^{commit}`])

  return ran.ok && ran.out.trim() ? ran.out.trim() : undefined
}

async function blobAt($: $, commit: string | undefined, path: string): Promise<string | undefined> {
  if (!commit) return undefined
  const ran = await gitRun($, ['cat-file', 'blob', `${commit}:${path}`])

  return ran.ok ? ran.out : undefined
}

type Change = { path: string; text?: string; merge?: (existing: string | undefined, theirs: string | undefined, base: string | undefined) => string; remove?: boolean }

// One commit on the branch with these files changed, on top of the local and the fetched tips (joined if they diverged). The result is
// 'unchanged' when the tree does not move, or the new commit; the local branch is moved only if it still is where it was read (a compare-and-swap).
async function commitShared($: $, remote: string | undefined, changes: Change[], message: string, tag: string): Promise<{ status: 'unchanged'; ahead: boolean } | { status: 'committed'; commit: string } | { status: 'failed'; why: string }> {
  const local = await branchTip($, `refs/heads/${BRANCH}`)
  const far = remote ? await branchTip($, `refs/remotes/${remote}/${BRANCH}`) : undefined
  let base = local ?? far
  let other: string | undefined
  let mb: string | undefined
  if (local && far && local !== far) {
    if ((await gitRun($, ['merge-base', '--is-ancestor', local, far])).ok) base = far
    else if ((await gitRun($, ['merge-base', '--is-ancestor', far, local])).ok) base = local
    else {
      base = far
      other = local
      mb = (await gitRun($, ['merge-base', local, far])).out.trim() || undefined
    }
  }
  const index = `${(await ledgerDirOf($))}/publish-${tag}.index`
  const env = { GIT_INDEX_FILE: index }
  const fail = async (why: string) => {
    await $.process.run(['node', '-e', REMOVE_SCRIPT, '--', index]).catch(() => undefined)

    return { status: 'failed' as const, why }
  }
  const read = await gitRun($, base ? ['read-tree', base] : ['read-tree', '--empty'], { env })
  if (!read.ok) return fail(read.err)
  if (other && base) {
    const moved = (await gitRun($, ['diff-tree', '-r', '--name-only', '--diff-filter=ACMRT', mb ?? base, other])).out.split('\n').filter(Boolean)
    const dropped = (await gitRun($, ['diff-tree', '-r', '--name-only', '--diff-filter=D', mb ?? base, other])).out.split('\n').filter(Boolean)
    for (const path of dropped) {
      const gone = await gitRun($, ['update-index', '--force-remove', path], { env })
      if (!gone.ok) return fail(gone.err)
    }
    if (moved.length > 0) {
      const info = (await gitRun($, ['ls-tree', other, '--', ...moved])).out
        .split('\n')
        .map(row => /^(\d+) blob (\w+)\t(.+)$/.exec(row))
        .filter((one): one is RegExpExecArray => one !== null)
        .map(one => `${one[1]} ${one[2]}\t${one[3]}`)
        .join('\n')
      if (info) {
        const merged = await gitRun($, ['update-index', '--index-info'], { env, stdin: `${info}\n` })
        if (!merged.ok) return fail(merged.err)
      }
    }
  }
  for (const change of changes) {
    if (change.remove) {
      const gone = await gitRun($, ['update-index', '--force-remove', change.path], { env })
      if (!gone.ok) return fail(gone.err)
      continue
    }
    const mine = await blobAt($, base, change.path)
    const text = change.merge ? change.merge(mine, other ? await blobAt($, other, change.path) : undefined, other ? await blobAt($, mb, change.path) : undefined) : (change.text ?? '')
    const blob = await gitRun($, ['hash-object', '-w', '--no-filters', '--stdin'], { stdin: text })
    if (!blob.ok) return fail(blob.err)
    const put = await gitRun($, ['update-index', '--add', '--cacheinfo', `100644,${blob.out.trim()},${change.path}`], { env })
    if (!put.ok) return fail(put.err)
  }
  const tree = await gitRun($, ['write-tree'], { env })
  if (!tree.ok) return fail(tree.err)
  const treeId = tree.out.trim()
  if (base && (await gitRun($, ['rev-parse', `${base}^{tree}`])).out.trim() === treeId && !other) return fail('').then(() => ({ status: 'unchanged' as const, ahead: local !== undefined && base === local && local !== far }))
  const parents = [base, other].filter((one): one is string => one !== undefined).flatMap(one => ['-p', one])
  const made = await gitRun($, ['commit-tree', treeId, ...parents, '-m', message])
  if (!made.ok) return fail(made.err.trim().split('\n').pop() ?? 'commit-tree failed')
  const commit = made.out.trim()
  const moved = await gitRun($, ['update-ref', '-m', 'swb ledger publish', `refs/heads/${BRANCH}`, commit, local ?? ''])
  if (!moved.ok) return fail(moved.err.trim().split('\n').pop() ?? 'update-ref failed')
  await $.process.run(['node', '-e', REMOVE_SCRIPT, '--', index]).catch(() => undefined)

  return { status: 'committed', commit }
}

// Fetch, commit, push; a push that was beaten by someone else starts again from the fetch, three times at most. Never forced.
async function shareChange($: $, changes: Change[], message: string, tag: string): Promise<string> {
  const remote = await remoteOf($)
  for (let attempt = 0; attempt < 3; attempt++) {
    if (remote) {
      const got = await fetchShared($, remote)
      if (got !== 'ok' && got !== 'missing') {
        const local = await commitShared($, undefined, changes, message, tag)

        return local.status === 'failed' ? `Not published: ${local.why}` : `Written to the local ${BRANCH} branch only (fetch failed: ${got}; not pushed).`
      }
    }
    const made = await commitShared($, remote, changes, message, tag)
    if (made.status === 'failed') return `Not published: ${made.why}`
    // Nothing new to commit, but a local branch that is ahead of the remote (an earlier push failed) still has to go out.
    if (made.status === 'unchanged' && !(made.ahead && remote)) return 'Already published: nothing changed.'
    if (!remote) return `Written to the local ${BRANCH} branch. No remote is set; share it with: git push <remote> ${BRANCH}`
    const pushed = await gitRun($, ['push', '--porcelain', '--no-verify', remote, `refs/heads/${BRANCH}:refs/heads/${BRANCH}`], { timeoutMs: SHARE_TIMEOUT })
    const result = pushOutcome({ exitCode: pushed.code, stdout: pushed.out, stderr: pushed.err })
    if (result === 'ok') return `Published to ${remote}/${BRANCH}.`
    if (result === 'failed') return `Committed to the local ${BRANCH} branch, but the push failed: ${model.cut(pushed.err.trim().split('\n').pop() ?? '', 160)}. Retry with /swb ledger publish.`
  }

  return `Committed to the local ${BRANCH} branch, but the push was refused three times because others published meanwhile. Run /swb ledger publish again.`
}

async function sharingRefusal($: $): Promise<string | undefined> {
  const live = await read($, liveAtom)
  if (live.policy?.ledger?.share === 'off') return `Publishing is off for this project (${POLICY_PATH}: ledger.share).`
  if ((live.policy?.errors.length ?? 0) > 0) return `The guard file has errors; fix them first (/swb policy): ${live.policy?.errors[0]}`
  if ((await ledgerDirOf($)).endsWith('/.claude/swb-ledger')) return 'Publishing needs a git repository.'
  const trees = (await gitRun($, ['worktree', 'list', '--porcelain'])).out
  if (new RegExp(`^branch refs/heads/${BRANCH}$`, 'm').test(trees)) return `The ${BRANCH} branch is checked out in a work tree; publishing would move it under that work tree.`

  return undefined
}

async function publishCommand($: $, arg: string): Promise<{ text: string }> {
  const refused = await sharingRefusal($)
  if (refused) return { text: refused }
  const dir = await ledgerDirOf($)
  const local = await readLedger($, dir)
  const starts = [...new Set(local.map(one => one.session))]
  const wanted = arg.trim()
  const latest = starts.sort((a, b) => Math.max(...local.filter(one => one.session === b).map(one => one.at)) - Math.max(...local.filter(one => one.session === a).map(one => one.at)))[0]
  const matching = starts.includes(wanted) ? [wanted] : starts.filter(one => one.startsWith(wanted))
  if (wanted !== '' && matching.length > 1) return { text: `More than one session starts with ${wanted}; give the whole id:\n${matching.join('\n')}` }
  const session = wanted === '' ? (ledger?.session && starts.includes(ledger.session) ? ledger.session : latest) : matching[0]
  if (!session) return { text: wanted === '' ? 'There is no recorded session to publish. Turn the ledger on with /swb ledger on.' : `No recorded session matches ${wanted}.` }
  const { events, masked } = publishEvents(local, session)
  if (events.length === 0) return { text: 'Nothing in this session can be shared.' }
  const start = events.find(one => one.kind === 'session.start')
  const user = typeof start?.user === 'string' && start.user !== '' ? start.user : (await gitRun($, ['config', 'user.name'])).out.trim()
  const hits = personalHits(events)
  const turns = new Set(events.filter(one => one.turn > 0).map(one => one.turn)).size
  const commits = events.filter(one => one.kind === 'commit').length
  const files = new Set(events.filter(one => one.kind === 'edit').map(one => one.file)).size
  const preview = `${dir}/outbox/${session}.preview.md`
  await $.process.run(['node', '-e', MKDIR_SCRIPT, '--', `${dir}/outbox`]).catch(() => undefined)
  await $.fs.write(preview, `${sessionNote(events)}\n\n## What is sent (JSON lines)\n\n${events.map(ledgerLine).join('\n')}\n${hits.length > 0 ? `\n## Emails and addresses still in it\n\n${hits.slice(0, 8).map(one => `- event ${one.seq} ${one.kind} ${one.what}: …${one.snippet}…`).join('\n')}\n` : ''}`).catch(() => undefined)
  const question = `Publish session ${session} (${user || 'unknown'}) to the shared ${BRANCH} branch? ${turns} turns, ${events.length} events, ${files} files, ${commits} commits. Prompts, answers, tool summaries (the first 120 characters of each command) and guard decisions go out; tool input and output do not. ${masked > 0 ? `${masked} fields were masked again. ` : ''}${hits.length > 0 ? `${hits.length} emails or addresses remain: ${hits.slice(0, 3).map(one => one.snippet.trim()).join(' | ')}. ` : ''}Everyone with access to the repository can read it, and the branch keeps it in its history. Full preview: ${preview}`
  const options = hits.length > 0 ? ['Publish', 'Publish, mask emails and addresses', 'Cancel'] : ['Publish', 'Cancel']
  const answer = await $.ui.ask(model.cut(question, 900), { header: 'Ledger', options }).catch(() => 'Cancel')
  // The preview holds the unmasked texts; it is not kept once the person has decided.
  await $.process.run(['node', '-e', REMOVE_SCRIPT, '--', preview]).catch(() => undefined)
  if (answer === 'Cancel' || !options.includes(answer)) return { text: 'Not published.' }
  const sent = answer === 'Publish' ? events : maskPersonal(events)
  const paths = sharedPaths(session, events[0]?.at ?? 0)
  const generated = sessionNote(sent)
  const body = `${sent.map(ledgerLine).join('\n')}\n`
  const result = await shareChange(
    $,
    [
      { path: paths.events, text: body },
      { path: paths.note, merge: (existing, theirs, base) => (theirs !== undefined ? mergeNotes(base, mergeNote(existing, generated), theirs) : mergeNote(existing, generated)) },
    ],
    `ledger: ${session} by ${user || 'unknown'}`,
    session,
  )

  return { text: `${result}\nSession ${session}: ${paths.events}, note ${paths.note}.` }
}

async function fetchCommand($: $): Promise<{ text: string }> {
  const remote = await remoteOf($)
  if (!remote) return { text: `No remote is set; shared sessions are read from the local ${BRANCH} branch only.` }
  const before = (await readShared($)).entries.length
  const got = await fetchShared($, remote)
  if (got === 'missing') return { text: `${remote} has no ${BRANCH} branch yet. Someone publishes first with /swb ledger publish.` }
  if (got !== 'ok') return { text: `Fetch failed: ${got}` }
  const after = (await readShared($)).entries.length

  return { text: `Fetched ${remote}/${BRANCH}: ${after} shared session files (${Math.max(0, after - before)} new). /swb why and /swb ledger search read them.` }
}

async function searchCommand($: $, arg: string): Promise<{ text: string }> {
  const query = parseSearch(arg)
  if (query.words.length === 0 && !query.user && !query.path && !query.kind) return { text: 'Usage: /swb ledger search <words> [user:name] [path:prefix] [kind:prompt|reply|edit|commit|guard]' }
  const events = await allLedger($, await ledgerDirOf($))
  if (events.length === 0) return { text: 'The ledger has no entries yet.' }
  const { lines, more } = searchLedger(events, query)
  if (lines.length === 0) return { text: `No turn matches ${arg.trim()}.` }

  const sessions = [...new Set(events.filter(one => one.shared === true).map(one => one.session))]

  return { text: `${framed(events, sessions, `${lines.join('\n')}${more > 0 ? `\n${more} more; narrow with path: or user:` : ''}`)}\nOpen one with /swb why <file[:line]|commit>.` }
}

// ---- export to the user's llm-wiki: the sessions as pages of content/qa-log/<project>/, written as files and nothing more (the wiki's git is the person's to run)
const WIKI_CHECK_SCRIPT =
  "const fs=require('fs'),p=require('path'),os=require('os');const out=r=>process.stdout.write(JSON.stringify(r));(function(){const inp=JSON.parse(fs.readFileSync(0,'utf8'));let w=inp.wiki;if(w==='~'||w.startsWith('~/'))w=p.join(os.homedir(),w.slice(1));try{w=fs.realpathSync(w)}catch{return out({ok:false,why:'the path does not exist'})}if(!fs.statSync(w).isDirectory())return out({ok:false,why:'the path is not a directory'});if(!fs.existsSync(p.join(w,'content'))||!fs.existsSync(p.join(w,'scripts','lint-content.mjs')))return out({ok:false,why:'it does not look like the llm-wiki (content/ and scripts/lint-content.mjs are missing)'});let repo=inp.repo;try{repo=fs.realpathSync(repo)}catch{}const sep=p.sep;if(w===repo||repo.startsWith(w+sep)||w.startsWith(repo+sep)||w===os.homedir()||w===fs.realpathSync(os.homedir())||w===p.parse(w).root)return out({ok:false,why:'the wiki must be a folder of its own, apart from this project'});const files={};for(const rel of inp.targets){const full=p.join(w,rel);try{const l=fs.lstatSync(full);files[rel]=l.isSymbolicLink()?{symlink:true}:{text:fs.readFileSync(full,'utf8')}}catch{files[rel]=null}}const exists=inp.exists.filter(rel=>fs.existsSync(p.join(w,rel)));out({ok:true,wiki:w,files,exists})})()"
const WIKI_WRITE_SCRIPT =
  "const fs=require('fs'),p=require('path');const inp=JSON.parse(fs.readFileSync(0,'utf8'));const base=p.join(inp.wiki,'content','qa-log');const done=[],failed=[];for(const f of inp.files){let tmp='';try{if(!/^content\\/qa-log\\/[a-z0-9-]+\\/[\\w.-]+\\.md$/.test(f.rel))throw new Error('path not allowed');const dir=p.join(inp.wiki,p.dirname(f.rel));for(const part of ['content','content/qa-log',p.dirname(f.rel)]){try{if(fs.lstatSync(p.join(inp.wiki,part)).isSymbolicLink())throw new Error(part+' is a link')}catch(e){if(e.code!=='ENOENT')throw e}}fs.mkdirSync(dir,{recursive:true});const real=fs.realpathSync(dir);if(!(real+p.sep).startsWith(base+p.sep))throw new Error('outside content/qa-log');const full=p.join(real,p.basename(f.rel));try{if(fs.lstatSync(full).isSymbolicLink())throw new Error('is a link')}catch(e){if(e.code!=='ENOENT')throw e}tmp=full+'.swb-'+process.pid+'-'+Date.now()+'.tmp';fs.writeFileSync(tmp,f.text,{flag:'wx'});fs.renameSync(tmp,full);tmp='';done.push(f.rel)}catch(e){if(tmp){try{fs.unlinkSync(tmp)}catch{}}failed.push(f.rel+': '+e.message)}}process.stdout.write(JSON.stringify({done,failed}))"

async function exportWikiCommand($: $, arg: string): Promise<{ text: string }> {
  const live = await read($, liveAtom)
  if (live.policy?.ledger?.wiki === 'off' || live.policy?.ledger?.share === 'off') return { text: `Exporting to the wiki is off for this project (${POLICY_PATH}: ledger).` }
  const fromEnv = (await $.process.run(['printenv', 'SWB_LEDGER_WIKI']).catch(() => undefined))?.stdout.trim() ?? ''
  const wiki = arg.trim() || fromEnv
  if (wiki === '') return { text: 'Usage: /swb ledger export-wiki <path of the llm-wiki folder> (or set SWB_LEDGER_WIKI). It writes content/qa-log/<project>/<date>-swb-<session>.md pages and runs no git in the wiki.' }
  const root = await $.session.root()
  const project = wikiProject(root)
  if (!project) return { text: 'The project folder name cannot be a wiki slug (lower-case letters, digits and "-", at most 41 characters).' }
  const dir = await ledgerDirOf($)
  const local = await readLedger($, dir)
  const now = await $.clock.now()
  // The day a session belongs to is the day it started in the person's own zone as it was then (a later change of summer time must not move it).
  const offsetOf = (events: LedgerEvent[]): number => -new Date((events.find(one => one.kind === 'session.start') ?? events[0])?.at ?? now).getTimezoneOffset()
  const sessions = [...new Set(local.map(one => one.session))]
    .map(one => publishEvents(local, one).events)
    .filter(events => events.some(one => one.turn > 0))
    .map(events => maskPersonal(events))
    .sort((a, b) => (a[0]?.at ?? 0) - (b[0]?.at ?? 0))
    .slice(-100)
  if (sessions.length === 0) return { text: 'There is no recorded session with a turn to export. Turn the ledger on with /swb ledger on.' }
  const remote = (await gitRun($, ['config', '--get', 'remote.origin.url'])).out
  const base = commitBase(remote)
  const options = { project, ...(base ? { commitBase: base } : {}) }
  const targets = sessions.map(events => wikiTarget(events, { ...options, offsetMinutes: offsetOf(events) }))
  const checked = await $.process.run(['node', '-e', WIKI_CHECK_SCRIPT], { stdin: JSON.stringify({ wiki, repo: root, targets: targets.map(one => one.file), exists: [...new Set(targets.map(one => `content/project-work/${project}/${one.date}.md`))] }) }).catch(() => undefined)
  let check: { ok: boolean; why?: string; wiki?: string; files?: Record<string, { text?: string; symlink?: boolean } | null>; exists?: string[] }
  try {
    check = JSON.parse(checked?.stdout ?? '')
  } catch {
    return { text: 'Could not check the wiki folder.' }
  }
  if (!check.ok || !check.wiki) return { text: `Not exported: ${check.why ?? 'the folder was refused'}.` }
  const pages: Array<{ rel: string; text: string; state: 'new' | 'updated' }> = []
  const skipped: string[] = []
  sessions.forEach((events, at) => {
    const target = targets[at] as { id: string; file: string; date: string }
    const sameDay = check.exists?.includes(`content/project-work/${project}/${target.date}.md`) ? `project-work/${project}/${target.date}` : undefined
    const prev = at > 0 ? (targets[at - 1] as { id: string }).id : undefined
    const page = wikiPage(events, { ...options, offsetMinutes: offsetOf(events), ...(prev ? { prev } : {}), ...(sameDay ? { sameDay } : {}) })
    const held = check.files?.[target.file]
    if (held?.symlink) return void skipped.push(`${target.file} (a link)`)
    const merged = wikiMerge(held?.text, page, events[0]?.session ?? '')
    if (merged === undefined) return void skipped.push(`${target.file} (a page that is not ours)`)
    if (held?.text === merged) return
    pages.push({ rel: target.file, text: merged, state: held ? 'updated' : 'new' })
  })
  if (pages.length === 0) return { text: `Nothing to write: ${sessions.length} sessions are already up to date in ${check.wiki}${skipped.length > 0 ? `; skipped: ${skipped.join(', ')}` : ''}.` }
  const preview = `${dir}/outbox/wiki-export.preview.md`
  await $.process.run(['node', '-e', MKDIR_SCRIPT, '--', `${dir}/outbox`]).catch(() => undefined)
  await $.fs.write(preview, pages.map(one => `<!-- ${one.state}: ${one.rel} -->\n${one.text}`).join('\n\n')).catch(() => undefined)
  const newCount = pages.filter(one => one.state === 'new').length
  const answer = await $.ui.ask(`Write ${pages.length} pages (${newCount} new, ${pages.length - newCount} updated) into ${check.wiki}/content/qa-log/${project}/? Only files are written (summary level: no tool input or output; emails and addresses masked); no git is run in the wiki. Preview: ${preview}`, { header: 'Ledger', options: ['Export', 'Cancel'] }).catch(() => 'Cancel')
  await $.process.run(['node', '-e', REMOVE_SCRIPT, '--', preview]).catch(() => undefined)
  if (answer !== 'Export') return { text: 'Not exported.' }
  const wrote = await $.process.run(['node', '-e', WIKI_WRITE_SCRIPT], { stdin: JSON.stringify({ wiki: check.wiki, files: pages.map(one => ({ rel: one.rel, text: one.text })) }) }).catch(() => undefined)
  let result: { done: string[]; failed: string[] }
  try {
    result = JSON.parse(wrote?.stdout ?? '')
  } catch {
    return { text: 'Writing to the wiki failed.' }
  }

  return { text: `Wrote ${result.done.length} pages to ${check.wiki}/content/qa-log/${project}/${result.failed.length > 0 ? `; failed: ${result.failed.join('; ')}` : ''}${skipped.length > 0 ? `; skipped: ${skipped.join(', ')}` : ''}.\nNot committed. In ${check.wiki}: node scripts/lint-content.mjs, then git add and commit.` }
}

async function forgetCommand($: $, arg: string): Promise<{ text: string }> {
  const wanted = arg.trim()
  if (wanted === '') return { text: 'Usage: /swb ledger forget <session id>' }
  const dir = await ledgerDirOf($)
  const local = await readLedger($, dir)
  const shared = await readShared($)
  const known = [...new Set([...local, ...shared.events].map(one => one.session))]
  const matches = known.includes(wanted) ? [wanted] : known.filter(one => one.startsWith(wanted))
  if (matches.length === 0) return { text: `No session matches ${wanted}.` }
  if (matches.length > 1) return { text: `More than one session starts with ${wanted}; give the whole id:\n${matches.join('\n')}` }
  const session = matches[0] as string
  const me = (await gitRun($, ['config', 'user.name'])).out.trim()
  const published = shared.entries.filter(one => one.path.endsWith(`/${session}.jsonl`))
  const owner = shared.events.find(one => one.session === session && one.kind === 'session.start')?.user
  const canRemove = published.length > 0 && owner !== undefined && owner === me && (await sharingRefusal($)) === undefined
  const answer = await $.ui.ask(`Delete session ${session} from this machine${canRemove ? ' and from the shared branch' : ''}? ${published.length > 0 && !canRemove ? 'It is on the shared branch under another name or the project forbids publishing, so only your local copy goes. ' : ''}The branch keeps it in its history; erasing that needs the branch rewritten.`, { header: 'Ledger', options: ['Delete', 'Cancel'] }).catch(() => 'Cancel')
  if (answer !== 'Delete') return { text: 'Kept.' }
  await $.process.run(['node', '-e', REMOVE_SCRIPT, '--', `${dir}/sessions/${session}.jsonl`]).catch(() => undefined)
  if (!canRemove) return { text: `Deleted the local copy of ${session}.` }
  const month = (published[0]?.path ?? '').split('/')[1] ?? ''
  const result = await shareChange($, [{ path: `sessions/${month}/${session}.jsonl`, remove: true }, { path: `notes/${month}/${session}.md`, remove: true }], `ledger: remove ${session}`, session)

  return { text: `Deleted the local copy. ${result}\nThe branch's history still holds the earlier version; removing it for good needs the branch rewritten.` }
}

// What comes from other people is shown in a frame with a one-time marker: it is data to read, never orders. Own sessions are shown as they are.
function framed(events: LedgerEvent[], sessions: string[], body: string): string {
  const shared = new Set(sessions.filter(one => events.some(item => item.session === one && item.shared === true)))
  if (shared.size === 0) return body
  const authors = [...new Set(events.filter(one => shared.has(one.session) && one.kind === 'session.start' && typeof one.user === 'string').map(one => String(one.user)))]
  const nonce = (globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)).replace(/-/g, '').slice(0, 8)

  return frameData(body, nonce, authors)
}

async function whyCommand($: $, arg: string): Promise<{ text: string }> {
  const dir = await ledgerDirOf($)
  const events = await allLedger($, dir)
  if (events.length === 0) return { text: `The ledger has no entries (${dir}). It records only from the moment /swb ledger on is run.` }
  const root = await $.session.root()
  const paths = new Map<string, boolean>()
  for (const word of [arg.trim(), arg.trim().replace(/:\d+$/, '')]) paths.set(word, word !== '' && (await $.fs.exists(await rooted($, word))))
  const target = whyTarget(arg, word => paths.get(word) === true)
  if (!target) return { text: 'Usage: /swb why <file[:line]|commit>' }
  const fileOf = (file: string): string => repoPath(file, root) ?? file
  const shas: string[] = []
  const file = target.kind === 'commit' ? undefined : fileOf(target.file)
  const found: Found[] = []
  if (target.kind === 'line') {
    const blamed = await gitOut($, ['blame', '-L', `${target.line},${target.line}`, '--porcelain', '--', file as string])
    const sha = blamed?.split('\n')[0]?.split(' ')[0] ?? ''
    if (/^0+$/.test(sha)) found.push(...editedTurns(events, file as string).slice(0, 1))
    else if (sha) shas.push(sha)
    else return { text: `git blame could not read ${target.file}:${target.line}.` }
  } else if (target.kind === 'file') {
    const dirty = (await gitOut($, ['status', '--porcelain', '--', file as string]))?.trim() !== ''
    if (dirty) found.push(...editedTurns(events, file as string).slice(0, 1))
    shas.push(...((await gitOut($, ['log', '-n', '5', '--format=%H', '--', file as string])) ?? '').split('\n').filter(Boolean))
  } else {
    const full = (await gitOut($, ['rev-parse', '--verify', `${target.sha}^{commit}`]))?.trim()
    if (!full) return { text: `${target.sha} is not a commit in this repository.` }
    shas.push(full)
  }
  for (const sha of shas) {
    const files = ((await gitOut($, ['diff-tree', '--no-commit-id', '--name-only', '-r', '--root', '--relative', sha])) ?? '').split('\n').filter(Boolean)
    const stamp = Number((await gitOut($, ['show', '-s', '--format=%ct', sha]))?.trim()) * 1000
    const at = locate(events, sha, files, Number.isFinite(stamp) ? stamp : undefined)
    if (at) found.push(at)
  }
  const seen = new Set<string>()
  const reports = found.filter(one => !seen.has(`${one.session}:${one.turn}`) && seen.add(`${one.session}:${one.turn}`)).map(one => turnReport(events, one, file))

  const body = reports.join('\n\n────────\n\n')

  return { text: reports.length === 0 ? `No ledger entry explains ${arg.trim()}: its commits were made before the ledger was turned on, outside a recorded session, or on another machine.` : framed(events, found.map(one => one.session), body) }
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
      contents.push({ pin, text: await $.fs.read(await rooted($, pin.path)) })
    } catch (error) {
      contents.push({ pin, error: error instanceof Error ? error.message : String(error) })
    }
  }

  return injectionOf(wb.task, contents)
}

type ContextNumbers = { contextPercent?: number; contextTokens?: number; contextWindow?: number }

// One look at the working tree: git's changed paths with each one's size and modification time, so a further edit to a file that was
// already modified or untracked (a binary too) shows. undefined outside a repository or when git fails.
type TreeState = { status: string; stats: Map<string, string> }
const STAT_SCRIPT = "const fs=require('fs');for(const p of fs.readFileSync(0,'utf8').split('\\n')){if(!p)continue;let r;try{const s=fs.statSync(p);r=s.size+':'+Math.round(s.mtimeMs)}catch(e){r='gone'}console.log(p+'\\t'+r)}"
let treeRoot: string | undefined

async function treeState($: $): Promise<TreeState | undefined> {
  // --no-optional-locks: this read-only look must not take index.lock from a Codex job or another session.
  const status = await $.process.run(['git', '--no-optional-locks', 'status', '--porcelain=v1', '-z', '-uall'], { cwd: await $.session.root() }).catch(() => undefined)
  if (status?.exitCode !== 0) return undefined
  if (treeRoot === undefined) {
    const top = await $.process.run(['git', 'rev-parse', '--show-toplevel'], { cwd: await $.session.root() }).catch(() => undefined)
    treeRoot = top?.exitCode === 0 ? top.stdout.trim() : ''
  }
  // The mod's own files change whenever it works (the live feed on every event, the audit log on every pass): they are not the task's work.
  const auditPath = (await read($, liveAtom)).policy?.audit?.path
  const own = [LIVE_FILE, PID_FILE, '.claude/smartworkbench-live', HANDOFF_PATH, AUDIT_PATH, ...(auditPath ? [auditPath] : [])].flatMap(one => [one, `${one}.1`])
  const isOwn = (path: string) => own.some(one => path === one || path.endsWith(`/${one}`))
  const paths = codex.porcelainPaths(status.stdout).filter(path => !path.includes('\n') && !isOwn(path))
  const stats = new Map(paths.map(path => [path, ''] as const))
  if (paths.length > 0) {
    const ran = await $.process.run(['node', '-e', STAT_SCRIPT], { stdin: paths.join('\n'), ...(treeRoot ? { cwd: treeRoot } : {}) }).catch(() => undefined)
    if (ran?.exitCode === 0) {
      for (const line of ran.stdout.split('\n')) {
        const at = line.lastIndexOf('\t')
        if (at > 0 && stats.has(line.slice(0, at))) stats.set(line.slice(0, at), line.slice(at + 1))
      }
    }
  }

  // The fingerprint reads the filtered paths, not git's raw text, which still names the mod's files.
  return { status: paths.join('\0'), stats }
}

// A fingerprint of the working tree for the loop's "did anything change" check.
async function workTreeHash($: $): Promise<string | undefined> {
  const state = await treeState($)

  return state && loop.treeHash(`${state.status}\0${[...state.stats].map(([path, stat]) => `${path}\t${stat}`).join('\n')}`)
}

async function refreshUsage($: $): Promise<ContextNumbers> {
  const { context } = await $.session.usage()
  const numbers: ContextNumbers = { contextPercent: context.percent, contextTokens: context.tokens, contextWindow: context.window }
  await setLive($, live => ({ ...live, ...numbers }))

  return numbers
}

// What one turn cost, for the live feed: only numbers the engine reported.
function usageOf(usage: unknown): Record<string, unknown> {
  const u = (usage ?? {}) as Record<string, unknown>
  const n = (key: string) => (typeof u[key] === 'number' ? (u[key] as number) : 0)
  const input = n('input_tokens') + n('cache_read_input_tokens') + n('cache_creation_input_tokens')

  return {
    ...(input > 0 ? { tokensIn: input } : {}),
    ...(n('output_tokens') > 0 ? { tokensOut: n('output_tokens') } : {}),
    ...(typeof u.model === 'string' ? { model: u.model } : {}),
  }
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
  // Decided inside the update, so a decision made meanwhile (the panel, the app) is not audited twice.
  let isDecided = false
  await mutate($, wb => {
    isDecided = (wb.proposals ?? []).some(one => one.id === id && one.status === 'open')
    return model.decideProposal(wb, id, approve)
  })
  if (before && isDecided) {
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

// Where the Codex plugin's companion script is, from Claude Code's own plugin list; null when it cannot be found.
// Only the list is read (and HOME asked for when the plugin root does not show the plugins folder): a missing or
// unreadable list just means Codex is unknown, and the feature stays off.
async function detectCodex($: $): Promise<string | null> {
  try {
    const root = String($.plugin.root)
    const marker = root.indexOf('/plugins/')
    let base = marker >= 0 ? root.slice(0, marker + '/plugins/'.length) : undefined
    if (!base) {
      // A custom config folder (CLAUDE_CONFIG_DIR) holds the plugin list; without one it is ~/.claude.
      const config = await $.process.run(['printenv', 'CLAUDE_CONFIG_DIR']).catch(() => undefined)
      const dir = config?.exitCode === 0 ? config.stdout.trim().replace(/\/$/, '') : ''
      if (dir) base = `${dir}/plugins/`
      else {
        const home = await $.process.run(['printenv', 'HOME'])
        base = home.exitCode === 0 && home.stdout.trim() ? `${home.stdout.trim()}/.claude/plugins/` : undefined
      }
    }
    if (!base) return null
    const path = codex.companionFrom(await $.fs.read(`${base}installed_plugins.json`))

    return path && (await $.fs.exists(path)) ? path : null
  } catch {
    return null
  }
}

async function codexCommand($: $, words: string[], from = ''): Promise<string> {
  const [first = '', second = ''] = words.map(one => one.toLowerCase())
  const live = await read($, liveAtom)
  const wb = await read($, wbAtom)
  const config = codex.codexOf(wb.team)
  const path = live.codexPath
  const state = `Codex ${config.enabled ? 'on' : 'off'}${config.enabled ? ` (cross-review ${config.review ? 'on' : 'off'}, rescue ${config.rescue ? 'on' : 'off'})` : ''}${wb.team?.enabled ? '' : '; it only acts while team mode is on'}.`

  if (first === 'check') {
    if (!path) return 'The Codex plugin was not found, so SmartWorkbench cannot use it. Install it first (/plugin install codex@openai-codex).'
    const ran = await $.process.run(['node', path, 'setup', '--json']).catch(() => undefined)
    if (!ran || ran.exitCode !== 0) return `Codex setup check failed to run: ${(ran?.stderr ?? '').trim().slice(0, 200) || 'no output'}`
    try {
      const report = JSON.parse(ran.stdout) as { ready?: boolean; auth?: { loggedIn?: boolean; detail?: string }; codex?: { detail?: string } }
      return `Codex ${report.ready ? 'reports ready' : 'is not ready'}: ${report.codex?.detail ?? 'no version'}; ${report.auth?.detail ?? (report.auth?.loggedIn ? 'logged in' : 'not logged in')}. ${state}`
    } catch {
      return `Codex setup check printed something unreadable. ${state}`
    }
  }

  if (first === 'on') {
    if (!path) return 'The Codex plugin was not found, so it stays off. Install it first (/plugin install codex@openai-codex).'
    const answer = await $.ui.ask(`${from}${codex.CODEX_CONSENT}`, { header: from ? 'Desktop app' : 'Codex', options: ['Turn on', 'Cancel'] }).catch(() => 'Cancel')
    if (answer !== 'Turn on') return 'Codex stays off.'
    await mutate($, current => ({ ...current, team: codex.setCodex(current.team, { enabled: true, review: true }) }))
    await audit($, 'team.codex', { on: true })

    return `Codex on: after code changes the lead runs one read-only Codex review per turn and gives it to the advisor. ${wb.team?.enabled ? '' : 'Team mode is off, so turn it on with /swb team on. '}Rescue is separate: /swb team codex rescue on.`
  }

  if (first === 'off') {
    await mutate($, current => ({ ...current, team: codex.setCodex(current.team, { enabled: false }) }))
    await audit($, 'team.codex', { on: false })

    return 'Codex off: Claude is no longer told to use it, and its commands ask again.'
  }

  if ((first === 'review' || first === 'rescue') && (second === 'on' || second === 'off')) {
    if (!config.enabled) return 'Turn Codex on first: /swb team codex on.'
    await mutate($, current => ({ ...current, team: codex.setCodex(current.team, { [first]: second === 'on' }) }))
    await audit($, 'team.codex', { [first]: second === 'on' })

    return `Codex ${first === 'review' ? 'cross-review' : 'rescue'} ${second}.`
  }

  return `${state} ${path ? 'Plugin found.' : 'Plugin not found.'}\n/swb team codex on|off|check · /swb team codex review|rescue on|off`
}

// Team on: the automatic reviews start, the lead's model and effort become the session's,
// and the previous model is kept to put back when team mode goes off.
async function setTeam($: $, enabled: boolean, isFromCommand = false): Promise<string> {
  const wb = await mutate($, current => ({ ...current, team: { ...current.team, enabled } }))
  await audit($, enabled ? 'team.on' : 'team.off')
  const row = await modelRow($)

  if (!enabled) {
    const previousKey = `team:previousModel:${await $.session.root()}`
    const previous = await $.store.get(previousKey)
    if (row && previous !== undefined && previous !== null) {
      await applyLeadModel($, String(previous))
      await $.store.delete(previousKey)
      return `Team mode off: no automatic Opus reviews; the model is back to ${String(previous) || 'the default'}.`
    }
    return 'Team mode off: no automatic Opus reviews; the explorer and advisor agents stay available.'
  }

  const lead = crew.roleOf(wb.team, 'lead')
  const previousKey = `team:previousModel:${await $.session.root()}`
  if (row && (await $.store.get(previousKey)) === undefined) {
    await $.store.set(previousKey, row.value)
  }
  const isSet = row ? await applyLeadModel($, lead.model) : false
  await applyLeadEffort($, lead.effort, isFromCommand)
  const explorer = crew.roleOf(wb.team, 'explorer')
  const advisor = crew.roleOf(wb.team, 'advisor')

  return [
    `Team mode on: lead ${lead.model} (${lead.effort}) builds, explorer ${explorer.model} (${explorer.effort}) explores, advisor ${advisor.model} (${advisor.effort}) reviews.`,
    isSet ? 'The session model is set (team off puts the previous model back).' : `Switch the session model with /model ${lead.model}.`,
    `The advisor designs before a big edit and before a plan is presented, and steps in after the same command fails ${crew.REPEAT_LIMIT} times in a row, and before finishing a turn that changed code. Change models and effort in the Team tab (/swb team).`,
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
  const head = await $.process.run(['git', 'rev-parse', 'HEAD'], { cwd: await $.session.root() }).catch(() => undefined)
  if (head?.exitCode !== 0) return 'Not a git repository with a commit; nothing to check.'
  const sha = head.stdout.trim()
  const fields = 'databaseId,workflowName,name,status,conclusion,headSha,url'
  let runs = await $.process.run(['gh', 'run', 'list', '--commit', sha, '--json', fields, '--limit', '30'], { cwd: await $.session.root() }).catch(() => undefined)
  if (runs?.exitCode !== 0) {
    runs = await $.process.run(['gh', 'run', 'list', '--json', fields, '--limit', '50'], { cwd: await $.session.root() }).catch(() => undefined)
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
  const status = await $.process.run(['git', 'status', '--porcelain'], { cwd: await $.session.root() }).catch(() => undefined)
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

  const found = await $.process.run(['gh', 'issue', 'view', parsed.ref, '--json', 'number,title,url,body'], { cwd: await $.session.root() }).catch(() => undefined)
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
  const text = await $.fs.read(await rooted($, pin.path)).catch(() => undefined)

  if (text === undefined) {
    $.ui.toast(`SmartWorkbench: cannot read ${pin.path}`)
    return
  }
  // Only the pinned range is kept (and measured), so a range of a large file can be frozen.
  const kept = sliceLines(text, pin.lines)
  if (kept.length > MAX_SNAPSHOT) {
    $.ui.toast(`SmartWorkbench: ${pin.path}${pin.lines ? ' in that range' : ''} is over ${MAX_SNAPSHOT.toLocaleString('en-US')} characters; ${pin.lines ? 'pin a smaller line range' : 'pin a line range'} to snapshot it`)
    return
  }
  const snapshot = { text: kept, sha256: await sha256(kept), at: await $.clock.now(), ...(pin.lines ? { sliced: true as const } : {}) }
  await mutate($, wb => model.setPinMode(wb, pin.id, snapshot))
}

async function pinSize($: $, pin: ContextPin): Promise<number> {
  if (pin.kind === 'note' || pin.snapshot) {
    return pinText(pin, undefined)?.length ?? 0
  }
  if (pin.lines) {
    const text = await $.fs.read(await rooted($, pin.path)).catch(() => undefined)
    return text === undefined ? -1 : (pinText(pin, text)?.length ?? 0)
  }

  return $.fs.stat(await rooted($, pin.path)).then(stat => stat.size, () => -1)
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

// A file the person names is written only inside the project and never over a file that already exists (the default path is ours to rewrite).
async function writableTarget($: $, path: string, fallback: string): Promise<string | { refused: string }> {
  const target = path.trim() || fallback
  if (target === fallback) return target
  if (repoPath(target, await $.session.root()) === undefined) return { refused: `${target} is outside the project; give a path inside it.` }
  if (await $.fs.exists(await rooted($, target)).catch(() => false)) return { refused: `${target} already exists; give another name or delete it first.` }

  return target
}

async function exportHandoff($: $, path: string): Promise<{ written: string } | { refused: string }> {
  const target = await writableTarget($, path, HANDOFF_PATH)
  if (typeof target !== 'string') return target
  // The handoff is meant to be read by someone else, so a command with a token in it is masked.
  await $.fs.write(await rooted($, target), redact(handoffMarkdown(await read($, wbAtom), await $.clock.now(), (await read($, liveAtom)).policy?.profile)))

  return { written: target }
}

// The line a tool row gets under it, from the call's record and any evidence it produced.
async function badge($: $, call: ToolCallRecord): Promise<void> {
  const wb = await read($, wbAtom)
  const text = badgeOf(call, wb.evidence.find(one => one.id === call.id), wb)
  if (text === undefined) return
  await update($, badgesAtom, all => Object.fromEntries([...Object.entries(all), [call.id, text]].slice(-MAX_BADGES)))
}

// A task with anything in it (not only a goal) is lost by new, load and pickup, so those ask first.
function isTaskInUse(wb: Workbench): boolean {
  const task = wb.task

  return task.goal.trim() !== '' || task.constraints.length > 0 || task.nonGoals.length > 0 || task.doneConditions.length > 0 || wb.evidence.length > 0
}

// Re-reads the checked-in guard file; no file means the person's own profile and the built-in rules.
// onlyIfChanged (a background look): nothing happens when the file is as it was, and a file that does not parse (an editor may be in the
// middle of saving) leaves the rules in force as they were, since a broken file would read as no rules at all.
async function loadPolicy($: $, opts: { onlyIfChanged?: boolean } = {}): Promise<boolean> {
  const text = await $.fs.read(await rooted($, POLICY_PATH)).catch(() => undefined)
  const hash = text === undefined ? undefined : await sha256(text)
  if (opts.onlyIfChanged) {
    const known = (await read($, liveAtom)).policy
    if (hash === known?.hash) return false
    // A file that is gone or does not parse is not "no rules": the rules in force stay, and only the hash goes, so the app sees the file
    // as not editable and the next good read replaces them. Only a full load (session start, /swb policy reload) drops them.
    if (known && (text === undefined || parsePolicy(text).errors.some(one => one.startsWith('not valid JSON')))) {
      await setLive($, live => (live.policy ? { ...live, policy: { ...live.policy, hash: undefined } } : live))
      if (known.hash !== undefined) $.ui.toast(`SmartWorkbench: ${POLICY_PATH} is missing or not valid JSON; the rules stay as they were until it is fixed (/swb policy reload drops them)`)
      return false
    }
    if (text !== undefined && parsePolicy(text).errors.some(one => one.startsWith('not valid JSON'))) return false
  }
  const policy = text === undefined ? undefined : { ...parsePolicy(text), hash }
  await setLive($, ({ policy: _old, ...live }) => (policy ? { ...live, policy } : live))

  if (policy && policy.errors.length > 0) {
    $.ui.toast(`SmartWorkbench: ${POLICY_PATH}: ${policy.errors[0]}${policy.errors.length > 1 ? ` (+${policy.errors.length - 1} more)` : ''}`)
  }

  return true
}

// A checked-in guard file may only tighten the person's own setting: the stricter of the two applies.
function profileOf(wb: Workbench, live: Live): GuardProfile {
  return effectiveProfile(wb.execution.profile, live.policy?.profile)
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
  const branch = await $.process.run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], { cwd: await $.session.root() }).catch(() => undefined)

  return model.goalDraft(lastPrompt, branch?.exitCode === 0 ? branch.stdout : undefined)
}

// ---- commands

// The desktop app's heartbeat (tools/desktop-state.mjs), or undefined when it does not run. Never throws.
async function desktopState($: $): Promise<{ home: string; port: number; autoJoin: boolean; livePrompts: boolean; askNotify: 'desktop' | 'plugin' } | undefined> {
  try {
    const out = await $.process.run(['node', `${$.plugin.root}/tools/desktop-state.mjs`], { timeoutMs: 3000 })
    if (out.exitCode !== 0 || !out.stdout.trim()) return undefined
    const raw = JSON.parse(out.stdout) as { home?: unknown; port?: unknown; autoJoin?: unknown; livePrompts?: unknown; askNotify?: unknown }
    const port = Number(raw.port)
    if (!Number.isInteger(port) || port < 1024 || port > 65535) return undefined

    return { home: typeof raw.home === 'string' ? raw.home : '', port, autoJoin: raw.autoJoin === true, livePrompts: raw.livePrompts !== false, askNotify: raw.askNotify === 'desktop' ? 'desktop' : 'plugin' }
  } catch {
    return undefined
  }
}

// The desktop app's read-only picture of this session, written at most every few seconds and only while the app runs.
let snapshotPending = false
// A change that arrived while a snapshot was being written: one more is written when that one is done.
let snapshotDirty = false
let snapshotGen = 0
let snapshotLast = ''
let deskCache: { at: number; state: Awaited<ReturnType<typeof desktopState>> } | undefined
const SNAPSHOT_DELAY_MS = 2000
const DESK_CACHE_MS = 10000
// While no app runs the check is repeated rarely: it costs a process.
const DESK_ABSENT_CACHE_MS = 30000

async function deskFresh($: $): ReturnType<typeof desktopState> {
  const at = await $.clock.now()
  if (deskCache && at - deskCache.at < (deskCache.state ? DESK_CACHE_MS : DESK_ABSENT_CACHE_MS)) return deskCache.state
  const state = await desktopState($)
  deskCache = { at, state }

  return state
}

// ---- questions that the app or the live page may answer too
// A guard question is asked in the session; while it waits, the app (and the live page, through the app's hub) may answer it once, as Allow once or Block.
// The answer arrives as a signed command, but a file can be written by anything that runs as the person, the model's Bash included. So a remote answer
// is taken only if nothing could have written one: no Bash or MCP call ran since the question opened, none was started in the background lately,
// and the question is not one of the always-asked kinds. The question in the session has no such limit.
type PendingAsk = { id: string; callId: string; tool: string; category: string; reason: string; summary: string; openedAt: number; remoteUntil: number; runsAtOpen: number; busyAtOpen: boolean; settle: (answer: { allow: boolean; by: 'app' | 'web' }) => void }
const pendingAsks = new Map<string, PendingAsk>()
const settledAsks: string[] = []
const REMOTE_ASK_MS = 120_000
const BACKGROUND_WINDOW_MS = 60 * 60 * 1000
let runCount = 0
// Calls of this session that are running now; a question opened while one runs cannot be answered from outside.
let inFlight = 0
let lastBackgroundAt = 0

// A command is taken to be able to leave a process behind unless it is a plain, short inspection: no shell operators or substitutions, and a command known
// to finish and do nothing else. Anything else (a script, an interpreter, a build tool, a trailing &) may write an answer later.
const SHORT_SAFE = /^\s*(?:ls|pwd|cat|head|tail|wc|echo|printf|stat|file|which|date|whoami|tree|diff|grep|rg|find|git\s+(?:status|diff|log|show|branch|rev-parse|ls-files|remote|add|commit|stash|checkout|switch|fetch|pull|push|merge|rebase|tag|blame|config\s+--get))\b[^;&|`$()<>\n]*$/
const mayDetach = (command: string): boolean => !SHORT_SAFE.test(command) || /\s-exec\b|\s--exec\b|\s-delete\b/.test(command)

// Why a question cannot be answered from outside, or undefined when it can.
function remoteRefusal(ask: PendingAsk, wb: Workbench, now: number): string | undefined {
  if (wb.execution.isPaused) return 'paused'
  if (ALWAYS_ASK.has(ask.category)) return 'terminal only'
  if (ask.busyAtOpen) return 'a command was running'
  if (runCount !== ask.runsAtOpen) return 'a command ran meanwhile'
  if (lastBackgroundAt !== 0 && now - lastBackgroundAt < BACKGROUND_WINDOW_MS) return 'a background command was started'

  return undefined
}

async function asksView($: $): Promise<AskView[]> {
  const now = await $.clock.now()
  const wb = await read($, wbAtom)

  return [...pendingAsks.values()].map(one => ({ id: one.id, tool: one.tool, reason: one.reason, summary: one.summary, remoteUntil: one.remoteUntil, remote: now > one.remoteUntil ? 'expired' : (remoteRefusal(one, wb, now) ?? true) }))
}

async function answerAsk($: $, one: { id: string; allow: boolean; by: 'app' | 'web' }): Promise<{ status: 'applied' | 'rejected'; reason?: string }> {
  const ask = pendingAsks.get(one.id)
  if (!ask) return { status: 'rejected', reason: settledAsks.includes(one.id) ? 'settled' : 'no such ask' }
  const now = await $.clock.now()
  if (now > ask.remoteUntil) return { status: 'rejected', reason: 'expired' }
  const why = remoteRefusal(ask, await read($, wbAtom), now)
  if (why) {
    await emit($, 'ask.remote', { id: ask.id, refused: why })
    return { status: 'rejected', reason: why }
  }
  // The checks above waited; the session, the app or the page may have answered meanwhile.
  if (pendingAsks.get(one.id) !== ask) return { status: 'rejected', reason: 'settled' }
  pendingAsks.delete(ask.id)
  ask.settle({ allow: one.allow, by: one.by })

  return { status: 'applied' }
}

function scheduleSnapshot($: $): void {
  if (snapshotPending) {
    snapshotDirty = true
    return
  }
  snapshotPending = true
  const gen = snapshotGen
  void (async () => {
    try {
      await $.clock.sleep(SNAPSHOT_DELAY_MS)
      const desk = await deskFresh($)
      // Only a session the app can list (it is on the app's hub) is worth a file.
      if (!isAskable || !desk || !liveServer?.url.startsWith(`http://127.0.0.1:${desk.port}`)) return
      const live = await read($, liveAtom)
      if (!live.sessionId) return
      const at = await $.clock.now()
      const text = snapshotText(await read($, wbAtom), live, at, await asksView($))
      // Nothing changed since the last one: no process is started for it.
      const same = text?.replace(/"at":\d+/, '')
      if (text && same !== snapshotLast) {
        snapshotLast = same ?? ''
        await $.process.run(['node', `${$.plugin.root}/tools/desktop-snapshot.mjs`, live.sessionId], { stdin: text, timeoutMs: 5000 })
      }
    } catch {
      // The snapshot is a courtesy to the app; the workbench does not depend on it.
    } finally {
      if (gen === snapshotGen) {
        snapshotPending = false
        if (snapshotDirty) {
          snapshotDirty = false
          scheduleSnapshot($)
        }
      }
    }
  })()
}

// ---- commands from the desktop app (tools/desktop-channel.mjs checks who sent them; the contract is changed here, as the panel would)
let inboxGen = 0
const INBOX_POLL_MS = 2000

async function ackDesktop($: $, id: string, result: { status: 'applied' | 'rejected' | 'declined'; rev?: number; reason?: string }): Promise<void> {
  await $.process.run(['node', `${$.plugin.root}/tools/desktop-channel.mjs`, 'ack', id], { stdin: JSON.stringify(result), timeoutMs: 5000 }).catch(() => undefined)
}

let inboxBusy = false

// One setting from the app, through the same code as its command. A setting that makes the guard watch less is asked here first,
// in the session, so a command file alone never loosens it. The question gives up when the command expires.
async function applySetting($: $, one: SettingOp, expiresAt: number, gen: number, batch: { asked: boolean } = { asked: false }): Promise<{ status: 'applied' | 'rejected' | 'declined'; reason?: string }> {
  const wb = await read($, wbAtom)
  const FROM = 'The desktop app asks: '
  if (one.op === 'ask_answer') return answerAsk($, one)
  if (isPolicyEditOp(one)) return applyPolicyEdit($, one, expiresAt, gen, batch)
  if (needsAnswer(wb, one) && !(one.op === 'set_profile' && one.profile === 'off') && one.op !== 'codex') {
    const what = one.op === 'proposal_decide' ? `approve a proposed change to the locked contract${(() => { const found = wb.proposals.find(p => p.id === one.id); return found ? `: ${model.cut(redact(scanned(found.text ?? found.change)), 120)}` : '' })()}` : one.op === 'set_profile' ? `lower the guard from ${wb.execution.profile} to ${one.profile}` : one.op === 'pause' ? 'resume risky calls' : 'turn team mode on (Codex is on, so its reviews will then run without asking)'
    const waited = Number.isFinite(expiresAt) ? Math.max(0, expiresAt - (await $.clock.now())) : 10 * 60 * 1000
    const answer = await Promise.race([
      $.ui.ask(`${FROM}${what}. Allow it?`, { header: 'Desktop app', options: ['Allow', 'Decline'] }).catch(() => 'Decline'),
      $.clock.sleep(waited).then(() => 'Decline', () => 'Decline'),
    ])
    if (answer !== 'Allow') return { status: 'declined' }
  }
  // The session may have ended while the question waited; the answer belongs to the one that asked.
  if (gen !== inboxGen) return { status: 'declined' }
  switch (one.op) {
    case 'team_enabled':
      await setTeam($, one.enabled)
      return { status: 'applied' }
    case 'team_role':
      // changeRole says in its text when the host's model setting refused the lead's model; the app is told so, not that it worked.
      const said = await changeRole($, one.role, { ...(one.model !== undefined ? { model: one.model } : {}), ...(one.effort !== undefined ? { effort: one.effort } : {}) })
      return said.includes('setting refused it') ? { status: 'rejected', reason: 'model refused' } : { status: 'applied' }
    case 'codex': {
      const before = codex.codexOf(wb.team).enabled
      if (one.enabled && !before && !(await read($, liveAtom)).codexPath) return { status: 'rejected', reason: 'codex not found' }
      await codexCommand($, [one.enabled ? 'on' : 'off'], one.enabled && !before ? FROM : '')
      const now = codex.codexOf((await read($, wbAtom)).team).enabled
      return now === one.enabled ? { status: 'applied' } : { status: 'declined' }
    }
    case 'set_profile':
      return (await chooseGuard($, one.profile, FROM)) ? { status: 'applied' } : { status: 'declined' }
    case 'proposal_decide': {
      if (!(await read($, wbAtom)).proposals?.some(item => item.id === one.id && item.status === 'open')) return { status: 'rejected', reason: 'no such proposal' }
      await settleProposal($, one.id, one.accept)
      return { status: 'applied' }
    }
    case 'pause':
      // The target state, not a flip: the person may have changed it in the panel while the question waited.
      await mutate($, current => (current.execution.isPaused === one.on ? current : model.togglePause(current)))
      await audit($, 'guard.pause', { on: one.on })
      return { status: 'applied' }
  }
}

// An edit of the guard file from the app. The file is read here, the edit is made on its text (hooks/policy-edit.ts) and written back
// by this plugin; the app never writes it. Whether the edit loosens the guard is worked out from the file as it is on disk.
async function applyPolicyEdit($: $, one: PolicyEditOp, expiresAt: number, gen: number, batch: { asked: boolean }): Promise<{ status: 'applied' | 'rejected' | 'declined'; reason?: string }> {
  const path = await rooted($, POLICY_PATH)
  const readNow = async (): Promise<{ text: string | undefined; hash: string | null }> => {
    const text = await $.fs.read(path).catch(() => undefined)

    return { text, hash: text === undefined ? null : await sha256(text) }
  }
  const first = await readNow()
  if (first.hash !== one.base) {
    await loadPolicy($, { onlyIfChanged: true })
    return { status: 'rejected', reason: 'stale' }
  }
  const edit = editPolicy(first.text, one)
  if ('reason' in edit) return { status: 'rejected', reason: edit.reason }

  if (edit.lowers) {
    // One question per batch, as for the other settings.
    if (batch.asked) return { status: 'rejected', reason: 'busy' }
    batch.asked = true
    const waited = Number.isFinite(expiresAt) ? Math.max(0, expiresAt - (await $.clock.now())) : 10 * 60 * 1000
    const answer = await Promise.race([
      $.ui
        .ask(`The desktop app asks: ${edit.summary} in ${POLICY_PATH} (the team shares this file; the guard will watch less). Allow it?`, { header: 'Desktop app', options: ['Allow', 'Decline'] })
        .catch(() => 'Decline'),
      $.clock.sleep(waited).then(() => 'Decline', () => 'Decline'),
    ])
    if (answer !== 'Allow') return { status: 'declined' }
    // The session may have ended, or the file changed (the model, a pull, an editor), while the question waited.
    if (gen !== inboxGen) return { status: 'declined' }
  } else if (gen !== inboxGen) return { status: 'declined' }

  // The script checks the file again right before it renames the new one into place (the file may have changed while the person was asked)
  // and writes nothing else; there is no fallback to a plain write, which would bring the gap back.
  const ran = await $.process.run(['node', `${$.plugin.root}/tools/desktop-policy-write.mjs`, await $.session.root(), first.hash ?? 'none'], { stdin: edit.text, timeoutMs: 5000 }).catch(() => undefined)
  if (ran?.exitCode === 3) {
    await loadPolicy($, { onlyIfChanged: true })
    return { status: 'rejected', reason: 'stale' }
  }
  if (ran?.exitCode !== 0) {
    // A script that timed out may still have renamed the file: what is there decides.
    const plain = (text: string | undefined): string | undefined => text?.replace(/^\uFEFF/, '').replace(/\r/g, '')
    if (plain(await $.fs.read(path).catch(() => undefined)) !== plain(edit.text)) {
      await loadPolicy($, { onlyIfChanged: true })
      $.ui.toast(`SmartWorkbench: ${POLICY_PATH} could not be written as the desktop app asked; check the file`)
      return { status: 'rejected', reason: 'error' }
    }
  }
  await loadPolicy($)
  await audit($, 'desktop.policy', { op: one.op, from: (first.hash ?? 'none').slice(0, 12), to: (await sha256(edit.text)).slice(0, 12) })
  $.ui.toast(`SmartWorkbench: the desktop app changed ${POLICY_PATH} (${edit.summary}); commit it to share`)

  return { status: 'applied' }
}

async function pollInbox($: $): Promise<void> {
  // While a command waits for the person's answer the inbox is busy; an answer to a guard question must still get through, so it is read then too.
  const wasBusy = inboxBusy
  if (wasBusy && pendingAsks.size === 0) return
  inboxBusy = true
  const gen = inboxGen
  const batch = { asked: false }
  try {
    const desk = await deskFresh($)
    const { sessionId } = await read($, liveAtom)
    if (!desk?.home || !sessionId) return
    const entries = await $.fs.list(`${desk.home}/inbox/${sessionId}`).catch(() => [])
    if (!entries.some(one => one.name.endsWith('.json'))) return
    const taken = await $.process.run(['node', `${$.plugin.root}/tools/desktop-channel.mjs`, 'take', sessionId], { timeoutMs: 5000 })
    if (taken.exitCode !== 0) return
    const found = JSON.parse(taken.stdout) as { commands?: Array<{ id: string; expiresAt: number; ops: Array<DeskOp | SettingOp> }>; rejected?: Array<{ id: string; reason: string }> }
    for (const one of found.rejected ?? []) await ackDesktop($, one.id, { status: 'rejected', reason: one.reason })
    // Answers to questions go first: they are the ones that wait for someone.
    const commands = [...(found.commands ?? [])].sort((a, b) => Number(b.ops[0]?.op === 'ask_answer') - Number(a.ops[0]?.op === 'ask_answer'))
    for (const command of commands) {
      // The command was taken (its file is gone): whatever happens now, the app gets an answer.
      try {
        const first = command.ops[0]
        if (wasBusy && first?.op !== 'ask_answer') {
          await ackDesktop($, command.id, { status: 'rejected', reason: 'busy' })
          continue
        }
        if (first && isSettingOp(first)) {
          // One question per batch: a pile of them would only teach the person to click through.
          // (An edit of the guard file decides this itself, once it has read the file.)
          if (needsAnswer(await read($, wbAtom), first)) {
            if (batch.asked) {
              await ackDesktop($, command.id, { status: 'rejected', reason: 'busy' })
              continue
            }
            batch.asked = true
          }
          const done = await applySetting($, first, command.expiresAt, gen, batch)
          await ackDesktop($, command.id, done)
          if (done.status === 'declined') await audit($, 'desktop.declined', { id: command.id, ops: first.op })
          // (A guard file edit has its own toast and audit entry.)
          if (done.status === 'applied' && !isPolicyEditOp(first) && first.op !== 'ask_answer') {
            $.ui.toast(`SmartWorkbench: the desktop app changed a setting (${first.op})`)
            await audit($, 'desktop.apply', { id: command.id, ops: first.op })
          }
          continue
        }
        let failed: string | undefined
        const next = await mutate($, current => {
          const result = applyOps(current, command.ops)
          failed = result.reason

          return result.reason === undefined ? result.wb : current
        })
        if (failed !== undefined) {
          await ackDesktop($, command.id, { status: 'rejected', reason: failed })
          $.ui.toast(`SmartWorkbench: the desktop app's change was not applied (${failed})`)
          continue
        }
        await ackDesktop($, command.id, { status: 'applied', rev: next.rev })
        $.ui.toast(`SmartWorkbench: the desktop app changed the contract (${command.ops.length} change${command.ops.length === 1 ? '' : 's'})`)
        await audit($, 'desktop.apply', { id: command.id, ops: command.ops.map(one => one.op).join(',') })
      } catch {
        await ackDesktop($, command.id, { status: 'rejected', reason: 'error' })
      }
    }
  } finally {
    if (gen === inboxGen && !wasBusy) inboxBusy = false
  }
}

// Looks for commands every few seconds while the session lives; a session that ends ends its sleep.
function startInbox($: $): void {
  const gen = ++inboxGen
  inboxBusy = false
  pendingAsks.clear()
  void (async () => {
    for (let tick = 1; ; tick += 1) {
      try {
        await $.clock.sleep(INBOX_POLL_MS)
      } catch {
        return
      }
      if (gen !== inboxGen) return
      // About every ten seconds the guard file is looked at too, so a rule added by another session or the app reaches a session that is working.
      if (tick % 5 === 0) await loadPolicy($, { onlyIfChanged: true }).catch(() => undefined)
      // Not awaited: a command waiting for the person's answer would hold the loop, and an answer to a guard question has to get through meanwhile.
      if (isAskable) void pollInbox($).catch(() => undefined)
    }
  })()
}

// A notification for a guard question: only where someone can answer, at most one every few seconds (parallel agents ask in bursts),
// read from the store each time so a choice made in another session counts. Never throws and never waits for the channel.
async function notifyAsk($: $, reason: string, tool: string): Promise<void> {
  try {
    if (!isAskable || (await $.store.get('notify').catch(() => undefined)) === 'off') return
    const at = await $.clock.now()
    if (at - lastAskNotice < ASK_NOTICE_GAP_MS) return
    // The desktop app, while it runs, has taken over ask notices and sees this session's feed (this session is on its hub), shows them itself.
    const desk = await desktopState($)
    if (desk?.askNotify === 'desktop' && liveServer?.url.startsWith(`http://127.0.0.1:${desk.port}`)) return
    lastAskNotice = at
    void Promise.resolve($.ui.notify(`Waiting for your answer: ${model.cut(reason, 100)} (${tool})`, { title: 'SmartWorkbench' })).catch(() => undefined)
  } catch {
    // A notification is a courtesy; the question itself is asked either way.
  }
}

// Whether a guard question also reaches the person's notification channel. One choice for every project of this user.
async function notifyCommand($: $, args: string): Promise<{ text: string }> {
  const wanted = args.trim().toLowerCase()
  if (wanted === 'on' || wanted === 'off') await $.store.set('notify', wanted)
  else if (wanted !== '' && wanted !== 'status' && wanted !== 'test') return { text: 'Usage: /swb notify [on|off|test]' }
  const on = (await $.store.get('notify').catch(() => undefined)) !== 'off'
  const sent = wanted === 'test' ? await $.ui.notify('Test from SmartWorkbench', { title: 'SmartWorkbench' }).catch(() => undefined) : undefined
  const result = sent ? (sent.isSent ? ` (test sent through ${sent.channel})` : ` (test not sent: ${sent.reason})`) : ''

  return { text: `Ask notifications: ${on ? 'on' : 'off'}${result}. A notification names the tool and the reason, never the command.\n/swb notify on | off | test` }
}

// Whether the workbench and the live view are kept per session (/swb scope). Off by default: sessions of a project share both.
function scopeLine(live: Live): string {
  return live.scope === 'session'
    ? 'Scope: session (this session keeps its own workbench and live view; if another session switches back to project, this one returns to the shared workbench at its next start)'
    : 'Scope: project (every session of this project shares the workbench and the live view; /swb scope session for your own)'
}

async function scopeCommand($: $, args: string): Promise<{ text: string }> {
  const wanted = args.trim().toLowerCase()
  const live = await read($, liveAtom)

  if (wanted === '' || wanted === 'status') {
    const shared = (await $.store.get(await scopeKey($)).catch(() => undefined)) === 'project'

    return { text: `${scopeLine(live)}\nNew sessions of this project start ${shared ? 'on the shared workbench' : 'with their own workbench, copied from the one the project last had'}.\n/swb scope session | project` }
  }
  if (wanted !== 'session' && wanted !== 'project') return { text: 'Usage: /swb scope [session|project|status]' }
  if (wanted === (live.scope ?? 'project')) return { text: scopeLine(live) }
  // The live files change place with the scope; a view that is running would be left writing to the old ones.
  // Only this session's own files count: another session's shared view does not stand in the way of leaving the shared feed.
  if (liveServer || (live.scope === 'session' && (await foreignView($)).state === 'alive')) return { text: 'A live view is running for this session: /swb live stop first, then change the scope.' }

  if (wanted === 'session') {
    const sessionId = live.sessionId
    if (sessionId === undefined || !SESSION_ID.test(sessionId)) return { text: 'This session has no usable id, so it cannot keep its own workbench.' }
    // The workbench as it is now moves along whole, evidence included: it is this session's own work.
    const mine = await read($, wbAtom)
    await $.store.set(await scopeKey($), 'session')
    await setLive($, one => ({ ...one, scope: 'session' }))
    const own = model.sessionCopy(mine, sessionId, await $.clock.now(), true)
    await $.store.set(await activeKey($), own)
    await update($, wbAtom, () => own)
    await audit($, 'scope.session')

    return { text: 'Scope: session. This session now keeps its own workbench and live view; the project\'s workbench is left as it was. Sessions opened from now on start from a copy of the project\'s. /swb live starts a view of this session only.' }
  }

  const answer = await $.ui
    .ask("Back to one workbench for the whole project? This session's own workbench is replaced by the project's, or written over it.", { header: 'Scope', options: [SCOPE_TAKE, SCOPE_WRITE, 'Cancel'] })
    .catch(() => 'Cancel')
  if (answer !== SCOPE_TAKE && answer !== SCOPE_WRITE) return { text: 'Scope unchanged.' }

  const ownKey = await activeKey($)
  const mine = await read($, wbAtom)
  const project = await $.store.get(await projectKey($))
  await $.store.set(await scopeKey($), 'project')
  await setLive($, one => ({ ...one, scope: undefined }))
  if (answer === SCOPE_WRITE) {
    // A revision above the project's own, so sessions that share it take this one at their next prompt.
    const rev = (model.isWorkbench(project) ? (project.rev ?? 0) : 0) + 1
    const written = { ...mine, rev, ...(live.sessionId ? { savedBy: live.sessionId } : {}) }
    await $.store.set(await projectKey($), written)
    await update($, wbAtom, () => written)
  } else {
    await update($, wbAtom, () => model.restore(project))
  }
  await $.store.delete(ownKey).catch(() => undefined)
  await audit($, 'scope.project')

  return { text: 'Scope: project. Every session of this project shares the workbench and the live view again.' }
}

function statusText(wb: Workbench, live: Live): string {
  const constraints = wb.task.constraints.filter(one => one.isActive).map(one => `  [${one.priority === 'hard' ? 'H' : 'S'}] ${one.text}`)
  const pins = wb.context.pins.map(one => `  ${one.kind === 'file' ? one.path : `Note: ${one.text}`}`)

  return [
    model.bandText(wb, live),
    `Goal: ${wb.task.goal || '—'} (${wb.task.locked ? 'locked' : 'unlocked'}, ${wb.task.status})`,
    ...(live.loop ? [loop.describe(live.loop).split('\n')[0]] : []),
    ...(constraints.length > 0 ? ['Constraints:', ...constraints] : []),
    ...(pins.length > 0 ? ['Pins:', ...pins] : []),
    ...(live.scope === 'session' ? [scopeLine(live)] : []),
    ...(wb.team?.enabled ? [`Team mode: on (Opus reviews this session: ${live.track?.advisorRuns ?? 0})`] : []),
    ...((live.sessionAllows ?? []).length > 0 ? [`Allowed for this session: ${(live.sessionAllows ?? []).map(one => one.label).join(', ')}`] : []),
    ...(live.policy ? [`Guard file: ${live.policy.source} (${live.policy.rules.length} rules${live.policy.profile ? `, profile ${live.policy.profile}` : ''})`] : []),
    ...(wb.task.doneConditions.length > 0 ? [turnSummary(wb.task, wb.evidence, lastCheckedEdit(wb.changed))] : []),
  ].join('\n')
}

// The live view's web server (tools/live.mjs), a child of this session: it ends with /swb live stop, the session or a reload.
let liveServer: { url: string; stop: () => void } | undefined

// Exit 0 = the process runs, 1 = it does not, 2 = the note was written on another machine or container, so its pid means nothing here.
const ALIVE_SCRIPT = "if(process.argv[1]!==require('os').hostname())process.exit(2);try{process.kill(Number(process.argv[2]),0)}catch(e){process.exit(e.code==='EPERM'?0:1)}"
const REMOVE_SCRIPT = "for(const f of process.argv.slice(1))require('fs').rmSync(f,{force:true})"

// A live view this session did not start: whether its feed file is there and whether the process that made it still runs.
async function foreignView($: $): Promise<{ state: 'none' | 'alive' | 'dead' | 'unknown'; pid?: string }> {
  const files = await liveFiles($)
  if (!(await $.fs.exists(files.feed))) return { state: 'none' }
  // The note is a file of the project, so its words are untrusted: a host that begins with a dash would be read by node as an option.
  const note = /^([A-Za-z0-9][A-Za-z0-9._-]*) (\d+)$/.exec(await $.fs.read(files.note).then(text => text.trim(), () => ''))
  if (!note) return { state: 'unknown' }
  const ran = await $.process.run(['node', '-e', ALIVE_SCRIPT, '--', note[1] ?? '', note[2] ?? '']).catch(() => undefined)

  return ran?.exitCode === 2 ? { state: 'unknown' } : { state: ran?.exitCode === 0 ? 'alive' : 'dead', pid: note[2] }
}

// A line for /swb live when the feed cannot be written, so the page's silence is not mistaken for an idle session.
async function feedNote($: $): Promise<string> {
  const why = (await read($, liveAtom)).feedError

  return why ? `\nLive feed: not writing (${why}); the live view is missing events.` : ''
}

async function liveCommand($: $, rest: string): Promise<{ text: string }> {
  const noPrompts = /(?:^|\s)--no-prompts\b/.test(rest)
  const arg = rest.replace(/(?:^|\s)--no-prompts\b/, ' ').trim().toLowerCase()

  if (arg === 'stop' || arg === 'off') {
    if (!liveServer) {
      const other = await foreignView($)
      if (other.state === 'dead') {
        const files = await liveFiles($)
        await $.process.run(['node', '-e', REMOVE_SCRIPT, '--', files.feed, files.note]).catch(() => undefined)

        return { text: 'Removed a feed left behind by a live view that is no longer running.' }
      }
      if (other.state === 'alive') return { text: `A live view started elsewhere (process ${other.pid}) serves this project's feed; stop it where it runs. If it is not running, delete ${(await liveFiles($)).feedRel} and ${(await liveFiles($)).noteRel}.` }
      if (other.state === 'unknown') return { text: `The live view is not running in this session, but ${(await liveFiles($)).feedRel} exists (no process note beside it). Delete it if no live view is running.` }

      return { text: 'The live view is not running.' }
    }
    liveServer.stop()
    liveServer = undefined
    stateLast = ''
    await setLive($, live => ({ ...live, livePrompts: undefined }))
    // Ending a child is a signal on Linux and macOS, where the server removes its own files; on Windows it is a hard kill and nothing runs.
    // Once the process is gone, the files it would have removed are removed here.
    for (let wait = 0; wait < 4; wait++) {
      const gone = await foreignView($)
      if (gone.state === 'dead') {
        const files = await liveFiles($)
        await $.process.run(['node', '-e', REMOVE_SCRIPT, '--', files.feed, files.note]).catch(() => undefined)
        break
      }
      if (gone.state !== 'alive') break
      await $.clock.sleep(300).catch(() => undefined)
    }

    return { text: 'Left the live view; this session\'s feed file is removed. The view stays up while other sessions use it.' }
  }
  if (liveServer) {
    if (noPrompts) {
      await setLive($, live => ({ ...live, livePrompts: false }))

      return { text: `Live view: ${liveServer.url}\nFrom now on the feed keeps only the first 120 characters of a prompt (lines already written stay).` }
    }

    return { text: `Live view: ${liveServer.url}\n/swb live stop to end it.${await feedNote($)}` }
  }

  const isAuto = arg === ''
  const port = isAuto ? 4317 : Number(arg)
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return { text: 'Usage: /swb live [port 1024-65535] [--no-prompts] | /swb live stop' }

  const other = await foreignView($)
  if (other.state === 'alive') return { text: `A live view started elsewhere (process ${other.pid}) already serves this project's feed; a second one would empty it. Stop that one first, or delete ${(await liveFiles($)).feedRel} and ${(await liveFiles($)).noteRel} if it is not running.` }

  feedMissed = 0
  isFeedNoted = false
  stateLast = ''
  await setLive($, live => ({ ...live, livePrompts: noPrompts ? false : undefined, feedError: undefined }))
  // All sessions on a port share one hub and are its tabs; with no port given, a port that something else holds is skipped.
  const { sessionId, scope } = await read($, liveAtom)
  let url = `http://127.0.0.1:${port}`
  const child = $.process.spawn({ argv: ['node', `${$.plugin.root}/tools/live.mjs`, await $.session.root(), '--join', ...(sessionId ? ['--session', sessionId] : []), ...(sessionId && scope === 'session' ? ['--per-session'] : []), '--port', String(port), ...(isAuto ? ['--auto'] : []), '--watch-parent'] })
  const iterator = child[Symbol.asyncIterator]()
  let output = ''
  const handle = { url, stop: () => void Promise.resolve(iterator.return?.()).catch(() => undefined) }

  // The first of "the server printed its address" and "3 seconds passed" decides, so a late address cannot revive a start that was reported as failed.
  let isSettled = false
  const started = new Promise<boolean>(resolve => {
    void (async () => {
      try {
        for (;;) {
          const step = await iterator.next()
          if (step.done) break
          output += step.value.text
          const shown = /SmartWorkbench live: (http:\/\/127\.0\.0\.1:\d+(?:\/#s=[A-Za-z0-9_-]{1,64})?)/.exec(output)
          if (!isSettled && shown) {
            url = shown[1] ?? url
            handle.url = url
            isSettled = true
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
  // Windows can take a while to start node the first time (a virus scanner reads it), so the wait is generous.
  const timeout = $.clock.sleep(15000).then(
    () => {
      isSettled = true
      return false
    },
    () => {
      isSettled = true
      return false
    },
  )

  if (await Promise.race([started, timeout])) {
    return { text: `Live view: ${url}\nOpen it in a browser. /swb live stop to end it. The feed holds prompts up to 2000 characters with secrets masked (a heuristic); /swb live --no-prompts keeps only their first 120 characters. Do not commit .claude/smartworkbench-live.jsonl.` }
  }
  handle.stop()

  return { text: `The live view did not start${output.trim() ? `: ${model.cut(output.trim().split('\n').pop() ?? '', 160)}` : ' (is node installed? is the port free?)'}` }
}

// The one way the guard level changes, from the command and from the panel. Turning it off is the person's decision, asked once,
// so nothing that only types a command can do it silently; every change is written to the audit log.
async function chooseGuard($: $, wanted: GuardProfile, from = ''): Promise<boolean> {
  const wb = await read($, wbAtom)
  if (wanted === 'off' && wb.execution.profile !== 'off') {
    const answer = await $.ui.ask(`${from}Turn the SmartWorkbench guard off? No call is asked about or blocked by the built-in rules until you set it back (/swb guard medium).`, { header: from ? 'Desktop app' : 'Guard off', options: ['Turn off', 'Cancel'] }).catch(() => 'Cancel')
    if (answer !== 'Turn off') return false
  }
  await mutate($, current => model.setProfile(current, wanted))
  await audit($, 'guard.profile', { profile: wanted })

  return true
}

async function runCommand($: $, args: string): Promise<{ text: string }> {
  const word = (args.trim().split(/\s+/)[0] ?? '').toLowerCase()

  if (word === 'live') return liveCommand($, args.trim().slice(word.length))

  if (word === '' || Object.hasOwn(TAB_ARGS, word)) {
    const isPlaced = await openPane($, TAB_ARGS[word])

    return { text: isPlaced ? 'SmartWorkbench opened.' : statusText(await read($, wbAtom), await read($, liveAtom)) }
  }

  if (word === 'new') {
    const wb = await read($, wbAtom)
    if (isTaskInUse(wb)) {
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
    if (verb === 'codex') return { text: await codexCommand($, args.trim().split(/\s+/).slice(2)) }
    if (verb === 'on' || verb === 'off') return { text: await setTeam($, verb === 'on', true) }

    // /swb team <lead|explorer|advisor> <model> [effort], or an effort alone
    const role = crew.ROLES.find(one => one === verb)
    if (role && first) {
      const isEffort = (value: string) => ((role === 'lead' ? crew.LEAD_EFFORTS : crew.EFFORTS) as readonly string[]).includes(value.toLowerCase())
      const change = isEffort(first) ? { effort: first.toLowerCase() } : { model: first, ...(second && isEffort(second) ? { effort: second.toLowerCase() } : {}) }
      return { text: await changeRole($, role, change, true) }
    }

    await openPane($, 'team')
    const wb = await read($, wbAtom)
    const track = (await read($, liveAtom)).track ?? crew.EMPTY_TRACK
    const roles = crew.ROLES.map(one => `${one} ${crew.withVersion(crew.roleOf(wb.team, one).model)} (${crew.roleOf(wb.team, one).effort})`).join(' · ')

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
    const started = { ...loop.begin(command.items, command.limit, await $.clock.now()), ...(command.limit === null ? { treeHash: await workTreeHash($) } : {}) }
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
    if (isTaskInUse(wb)) {
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
    const target = await writableTarget($, name, SHARE_PATH)
    if (typeof target !== 'string') return { text: target.refused }
    const live = await read($, liveAtom)
    await $.fs.write(await rooted($, target), shareText(await read($, wbAtom), await $.clock.now(), live.user))
    await audit($, 'task.share', { path: target })

    return { text: `Task written to ${target}. Commit and push it; on the other machine run /smartworkbench pickup.` }
  }

  if (word === 'pickup') {
    const target = name || SHARE_PATH
    const text = await $.fs.read(await rooted($, target)).catch(() => undefined)
    if (text === undefined) return { text: `No shared task at ${target}.` }
    const shared = readShare(text)
    if ('error' in shared) return { text: `${target}: ${shared.error}` }
    const wb = await read($, wbAtom)
    if (isTaskInUse(wb)) {
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
    const text = await $.fs.read(await rooted($, config.path)).catch(() => '')
    const entries = readAudit(text)
    const count = Math.max(1, Math.min(200, Number(name) || 20))

    return { text: entries.length === 0 ? `No audit entries in ${config.path} yet.` : `${config.path} (last ${Math.min(count, entries.length)} of ${entries.length}):\n${formatAudit(entries, count)}` }
  }

  if (word === 'ledger') return ledgerCommand($, name)
  if (word === 'scope') return scopeCommand($, name)
  if (word === 'notify') return notifyCommand($, name)

  if (word === 'why') return whyCommand($, args.trim().slice(word.length))

  if (word === 'guard') {
    const names: Record<string, GuardProfile> = { high: 'strict', strict: 'strict', 상: 'strict', medium: 'balanced', mid: 'balanced', balanced: 'balanced', 중: 'balanced', low: 'permissive', permissive: 'permissive', 하: 'permissive', off: 'off' }
    const label: Record<GuardProfile, string> = { strict: 'high (strict)', balanced: 'medium (balanced)', permissive: 'low (permissive)', off: 'off' }
    const wanted = names[name.toLowerCase()]
    const wb = await read($, wbAtom)
    const live = await read($, liveAtom)
    if (name === '') {
      const file = live.policy?.profile
      return { text: `Guard sensitivity: ${label[wb.execution.profile]}${file ? ` · the guard file sets at least ${file}, so ${label[effectiveProfile(wb.execution.profile, file)]} applies` : ''}.\n/swb guard high|medium|low|off to change it.\nhigh asks about medium-risk calls too; medium is the default; low skips most questions (secrets, remote scripts, Codex, project rules and blocks stay); off lets every call through (only rules your project file wrote and the pause switch still apply).` }
    }
    if (!wanted) return { text: 'Usage: /swb guard [high|medium|low|off]' }
    if (!(await chooseGuard($, wanted))) return { text: 'Guard unchanged.' }
    const file = (await read($, liveAtom)).policy?.profile
    const applied = effectiveProfile(wanted, file)

    return { text: `Guard sensitivity: ${label[wanted]}${applied !== wanted ? ` (the guard file sets ${file}, which is stricter, so ${label[applied]} applies)` : ''}.${wanted === 'off' ? '\nThe guard is off: no call is asked about or blocked by the built-in rules. Turn it back on with /swb guard medium.' : ''}` }
  }

  if (word === 'policy') {
    if (name === 'init') {
      if (await $.fs.exists(await rooted($, POLICY_PATH))) {
        return { text: `${POLICY_PATH} already exists.\n${policyText(await read($, liveAtom))}` }
      }
      await $.fs.write(await rooted($, POLICY_PATH), POLICY_TEMPLATE)
      await loadPolicy($)

      return { text: `Wrote ${POLICY_PATH} with example rules; edit it and commit it so the team shares it.\n${policyText(await read($, liveAtom))}` }
    }
    await loadPolicy($)

    return { text: policyText(await read($, liveAtom)) }
  }

  if (word === 'export') {
    const done = await exportHandoff($, name)

    return { text: 'refused' in done ? done.refused : `Handoff written to ${done.written}.` }
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
            { value: 'off', label: 'Off (no checks)' },
            { value: 'permissive', label: 'Low (permissive)' },
            { value: 'balanced', label: 'Medium (balanced)' },
            { value: 'strict', label: 'High (strict)' },
          ]}
          onSelect={value => void chooseGuard($, value as GuardProfile)}
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
          onPress={() => void exportHandoff($, '').then(done => $.ui.toast(`SmartWorkbench: ${'refused' in done ? done.refused : `handoff written to ${done.written}`}`))}
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
    return (list.includes(current) ? list : [current, ...list]).map(value => ({ value, label: crew.withVersion(value) }))
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
        {isOn ? 'The advisor designs before big edits, reviews the plan, and steps in after a repeated error and before finishing.' : 'Turn on for automatic advisor reviews; the agents are available either way.'}
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
      {(() => {
        const cx = codex.codexOf(wb.team)
        const found = typeof live.codexPath === 'string'
        const say = (words: string[]) => void codexCommand($, words).then(text => toast(text.split('\n')[0] ?? ''))

        return (
          <Box key="codex" flexDirection="column" marginTop={1}>
            <Box gap={1}>
              <Text bold>CODEX (OpenAI)</Text>
              <Text color={cx.enabled ? 'success' : undefined}>{cx.enabled ? '● on' : '○ off'}</Text>
              <Button key="codex-toggle" variant={cx.enabled ? undefined : 'primary'} label={cx.enabled ? 'Turn off' : 'Turn on'} onPress={() => say([cx.enabled ? 'off' : 'on'])} />
              <Button key="codex-check" label="Check" onPress={() => say(['check'])} />
            </Box>
            <Text dimColor wrap="wrap">
              {found
                ? 'Plugin found; login is not checked until you press Check.'
                : 'Codex plugin not found, so this stays off. Install it with /plugin install codex@openai-codex.'}{' '}
              Codex sends the diff and the files it reads to OpenAI under your Codex account. Off by default.
            </Text>
            {cx.enabled && (
              <Box gap={2} marginLeft={2}>
                <Select key="codex-review" label="Cross-review" value={cx.review ? 'on' : 'off'} options={[{ value: 'on' }, { value: 'off' }]} onSelect={value => say(['review', value])} />
                <Select key="codex-rescue" label="Rescue" value={cx.rescue ? 'on' : 'off'} options={[{ value: 'on' }, { value: 'off' }]} onSelect={value => say(['rescue', value])} />
              </Box>
            )}
            <Text dimColor wrap="wrap">
              {isOn ? 'Cross-review: one read-only Codex review per turn before the advisor\'s final check. Rescue: one Codex task after a repeated error. ' : 'Acts only while team mode is on. '}
              Known --write and transfer forms ask. Runs this session: {track.codexRuns ?? 0}
            </Text>
          </Box>
        )
      })()}
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
    agentAnswers.clear()
    snapshotGen++
    snapshotPending = false
    snapshotDirty = false
    snapshotLast = ''
    deskCache = undefined
    appender = 'tee'
    feedMissed = 0
    isFeedNoted = false
    treeRoot = undefined
    ledger = undefined
    await setLive($, current => ({ ...current, loop: undefined })).catch(() => undefined)
    const argumentHint = '[new|team|advise|loop|live|lock|unlock|intent|context|run|verify|status|preview|save|load|templates|export|guard|ledger|scope|notify|why|policy|ci|issue|share|pickup|audit|clear]'
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
    isAskable = e.isInteractive !== false
    await startScope($, sessionId)
    await load($)
    await loadPolicy($)
    // Team mode's agents, with this project's chosen models: available to Claude at all times,
    // the automatic reviews only while team mode is on.
    await registerRole($, 'explorer')
    await registerRole($, 'advisor')
    const codexPath = await detectCodex($)
    await setLive($, live => ({ ...live, codexPath }))
    await ledgerStart($).catch(() => undefined)
    // With the desktop app running and asked to, this session joins its always-on hub (the same join /swb live makes).
    startInbox($)
    if (isAskable) {
      const desk = await desktopState($)
      if (desk?.autoJoin && !liveServer) {
        // A slow or missing hub must not hold the session start for the whole join wait.
        await Promise.race([liveCommand($, `${desk.port}${desk.livePrompts ? '' : ' --no-prompts'}`).catch(() => undefined), $.clock.sleep(4000).catch(() => undefined)])
        scheduleSnapshot($)
        if (liveServer) $.ui.log(`SmartWorkbench: joined the desktop app's live view at ${liveServer.url}${desk.livePrompts ? ' (full prompts are shown there; /swb live --no-prompts to shorten them)' : ''}.`)
      }
    }

    if ((await read($, liveAtom)).policy?.audit) {
      const name = await $.process.run(['git', 'config', 'user.name'], { cwd: await $.session.root() }).catch(() => undefined)
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
    // A change another session or the desktop app made to the guard file is in force from this prompt on.
    await loadPolicy($, { onlyIfChanged: true }).catch(() => undefined)
    const wb = await read($, wbAtom)
    const { policy } = await read($, liveAtom)

    // Opt-in team rule: no work without a locked contract that says when it is done.
    if (policy?.requireContract && e.origin.kind !== 'plugin' && !/^\/(?:swb|smartworkbench|workbench)(?:\s|$)/.test(e.text.trimStart()) && !(wb.task.locked && wb.task.goal.trim() !== '' && wb.task.doneConditions.length > 0)) {
      return { drop: `This project requires a locked SmartWorkbench contract with at least one done condition (${POLICY_PATH}: requireContract). Run /swb new, fill it in and Lock.` }
    }

    const { blocks: contract, warnings } = await injection($, wb)
    const codexPath = (await read($, liveAtom)).codexPath
    const codexConfig = codex.codexOf(wb.team)
    // Never inside a loop: a review per pass would run on the person's Codex account without anyone watching.
    const codexBlock = codex.isCodexOn(wb.team) && codexPath && !((await read($, liveAtom)).loop && e.origin.kind === 'plugin') ? [codex.codexContext(codexPath, codexConfig)] : []
    const blocks = wb.team?.enabled ? [...contract, crew.TEAM_CONTEXT, ...codexBlock] : contract
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
        $.ui.toast('SmartWorkbench: Loop ended because you sent a prompt.')
      }
    }
    const carriesDesign = (e.origin.kind === 'plugin' && (await read($, liveAtom)).loop !== undefined) || crew.planWasApproved((await read($, liveAtom)).track ?? crew.EMPTY_TRACK)
    await updateTrack($, track => crew.turnStart(track, startedAt, carriesDesign))
    await setLive($, current => {
      const { turnResult: _done, ...rest } = current

      return { ...rest, pinWarnings: warnings }
    })

    if (warnings.length > 0) {
      $.ui.toast(`SmartWorkbench: ${warnings.join(', ')}`)
    }

    // Own work only, for checking the performance targets with --debug.
    $.ui.log(`SmartWorkbench timing: prompt.submit ${(await $.clock.now()) - startedAt}ms before the prompt went on`, { to: 'debug' })

    if (ledger) {
      await noteCommits($, 'prompt')
      ledger.turn++
      const goal = wb.task.goal.trim()
      if (goal !== '' && goal !== ledger.goal) {
        ledger.goal = goal
        await record($, 'contract', { goal, done: wb.task.doneConditions.map(one => one.text).join(' | ') })
      }
      await record($, 'prompt', { origin: e.origin.kind, text: e.text })
    }
    await emit($, 'prompt', { origin: e.origin.kind, text: model.cut(redact(scanned(e.text)).replace(/\s+/g, ' '), 120), ...promptOf(await read($, liveAtom), e.text), team: wb.team?.enabled === true, loop: loopBlocks.length > 0, codex: codex.isCodexOn(wb.team) })

    // A loop pass that rides on a typed prompt carries no Codex brief either.
    const kept = loopBlocks.length > 0 ? blocks.filter(one => !codexBlock.includes(one)) : blocks
    const all = [...kept, ...loopBlocks]

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
      const cwd = await $.session.root()
      const input = e as unknown as Record<string, unknown>
      const target = input.file_path ?? input.notebook_path
      const file = typeof target === 'string' ? target : undefined
      const inside = file === undefined ? undefined : repoPath(file, cwd)
      const track = (await read($, liveAtom)).track ?? crew.EMPTY_TRACK

      if (inside !== undefined && crew.needsDesign(track, crew.isSmallEdit(track, inside, crew.editSize(e.tool, e as unknown as Record<string, unknown>)))) {
        await updateTrack($, current => ({ ...current, designDeniedAt: hookStart }))
        await audit($, 'team.design-required', { tool: e.tool })

        return { deny: crew.DESIGN_FIRST }
      }
    }
    const wb = await read($, wbAtom)
    const live = await read($, liveAtom)
    const cwd = await $.session.root()
    const verdict = applyRule(classify(e.tool, e), live.policy ? matchRule(live.policy.rules, e.tool, e, cwd) : undefined)
    // Codex through the companion script: the person's team setting lets a read-only review (or a rescue task) run without
    // asking, once per turn. A write, a transfer, a paused session and a project rule that blocks still decide for themselves.
    const codexRun = e.tool === 'Bash' ? codex.codexCall(e.command) : undefined
    const codexConfig = codex.codexOf(wb.team)
    const isCodexUse = isTeam && codexConfig.enabled && codexRun !== undefined
    const heldTrack = live.track ?? crew.EMPTY_TRACK
    if (isCodexUse && verdict.category === 'codex-send' && !codexRun.write && (codexRun.op === 'task' ? codex.hasTaskedThisTurn(heldTrack) : codex.hasReviewedThisTurn(heldTrack))) {
      await audit($, 'team.codex-repeat')

      return { deny: 'SmartWorkbench team mode: Codex already ran this turn; use its findings instead of running it again.' }
    }
    // Image generation is the one write allowed unasked: a plain task whose brief names one picture file under an asset folder.
    const isImage =
      isCodexUse &&
      codexRun.write &&
      verdict.category === 'codex-write' &&
      !wb.execution.isPaused &&
      typeof live.codexPath === 'string' &&
      e.tool === 'Bash' &&
      codex.isImageTask(e.command, live.codexPath)
    const isCodexAllowed =
      isImage ||
      (isCodexUse &&
        verdict.category === 'codex-send' &&
        !wb.execution.isPaused &&
        typeof live.codexPath === 'string' &&
        e.tool === 'Bash' &&
        // A review per pass would run on the person's Codex account with nobody watching, so inside a loop it is asked.
        live.loop === undefined &&
        codex.isPlainInvocation(e.command, live.codexPath) &&
        (codexRun.op === 'task' ? codexConfig.rescue : codexConfig.review))
    const policy = isCodexAllowed ? 'allow' : decide(verdict, profileOf(wb, live), wb.execution.isPaused)
    const startedAt = await $.clock.now()
    let call: ToolCallRecord = {
      id: e.tool_use_id ?? `call-${startedAt}`,
      tool: e.tool,
      summary: summarize(e.tool, e),
      risk: verdict.risk,
      policy,
      category: verdict.category,
      ...(verdict.reason ? { reason: isCodexAllowed ? 'allowed by the team Codex setting' : verdict.reason } : {}),
      outcome: 'running',
      startedAt,
      ...(e.agentId ? { agentId: e.agentId } : {}),
    }
    // The record is bookkeeping: if the store fails the decision below still stands, so a call to be asked about is asked about.
    await mutate($, current => model.recordCall(current, call)).catch(() => undefined)
    const sub = (e as unknown as Record<string, unknown>).subagent_type
    // "Allow for session" answers stand until the session ends, except while risky calls are paused.
    const scope = policy === 'ask' ? sessionScope(e.tool, e, verdict) : undefined
    const isSessionAllowed = scope !== undefined && !wb.execution.isPaused && (live.sessionAllows ?? []).some(one => one.key === scope.key)
    await emit($, 'tool.start', {
      id: call.id,
      tool: e.tool,
      summary: call.summary,
      category: verdict.category,
      risk: verdict.risk,
      policy: isSessionAllowed ? 'allow' : policy,
      ...(e.agentId ? { agent: e.agentId } : {}),
      ...(typeof sub === 'string' ? { subagent: sub } : {}),
      ...(codexRun ? { codex: codexRun.op, ...(codexRun.background ? { codexBg: true } : {}), ...(codexRun.write ? { codexWrite: true } : {}) } : {}),
      ...(e.tool === 'Agent' && typeof (e as unknown as Record<string, unknown>).prompt === 'string' ? promptOf(live, (e as unknown as Record<string, string>).prompt as string) : {}),
      ...(codexRun && e.tool === 'Bash' ? promptOf(live, e.command) : {}),
      ...(e.tool === 'Workflow' ? workflowFields(live, e) : {}),
      ...(e.tool !== 'Agent' && e.tool !== 'Workflow' && !codexRun && !NO_IO.has(verdict.category) ? promptOf(live, inputText(e), 'toolIn') : {}),
    })

    if (policy === 'block') {
      await mutate($, current => model.recordCall(current, { ...call, outcome: 'blocked', durationMs: 0 }))
      await badge($, { ...call, outcome: 'blocked' })
      await audit($, 'guard.block', { id: call.id, tool: e.tool, input: call.summary, reason: verdict.reason, rule: verdict.category })
      await emit($, 'tool.end', { id: call.id, outcome: 'blocked', ms: 0 })

      return {
        deny: `SmartWorkbench blocked this ${e.tool} call: ${verdict.reason}. The user's guard policy forbids it; do not retry it another way. Ask the user if it is really needed.`,
      }
    }

    if (isSessionAllowed) {
      call = { ...call, policy: 'allow', sessionAllowed: true, reason: `${verdict.reason}; allowed for this session` }
      const allowed = call
      await mutate($, current => model.recordCall(current, allowed))
    } else if (policy === 'ask') {
      const options = scope ? ['Allow', 'Allow for session', 'Block'] : ['Allow', 'Block']
      const hint = scope ? ` ("Allow for session" stops asking for \`${model.cut(scope.label, 60)}\` until this session ends.)` : ''
      // The question is on screen in this window; a notification reaches the person who is looking at another one. It carries the tool and the reason, never the command.
      await notifyAsk($, verdict.reason, e.tool)
      const askedAt = await $.clock.now()
      const askId = `a-${call.id.slice(0, 20)}-${askedAt.toString(36)}`.slice(0, 40)
      const summary = model.cut(redact(scanned(call.summary)), 120)
      const remote = new Promise<{ allow: boolean; by: 'app' | 'web' }>(resolve => {
        pendingAsks.set(askId, { id: askId, callId: call.id, tool: e.tool, category: verdict.category, reason: verdict.reason, summary, openedAt: askedAt, remoteUntil: askedAt + REMOTE_ASK_MS, runsAtOpen: runCount, busyAtOpen: inFlight > 0, settle: resolve })
      })
      await emit($, 'ask.open', { id: askId, callId: call.id, tool: e.tool, reason: verdict.reason, summary, until: askedAt + REMOTE_ASK_MS })
      scheduleSnapshot($)
      const terminal = $.ui
        .ask(`SmartWorkbench: ${verdict.reason}. Allow ${e.tool}: ${call.summary.slice(0, 80)}?${hint} (The desktop app or the live page can answer once too; the first answer counts.)`, { header: 'Guard', options })
        .catch(() => 'Block')
      const first = await Promise.race([terminal.then(text => ({ text })), remote.then(r => ({ remote: r }))])
      const wasRemote = 'remote' in first
      pendingAsks.delete(askId)
      settledAsks.push(askId)
      if (settledAsks.length > 50) settledAsks.shift()
      const answer: string = 'text' in first ? first.text : first.remote.allow ? 'Allow' : 'Block'
      await emit($, 'ask.close', { id: askId, by: wasRemote ? first.remote.by : 'terminal', allow: answer !== 'Block' })
      scheduleSnapshot($)
      if (wasRemote) {
        // The session's own question cannot be taken back: whatever it is answered with later is not applied.
        void terminal.then(async () => {
          $.ui.toast('SmartWorkbench: that question was already answered from the desktop app or the live page; the answer given here was not applied.')
          await audit($, 'guard.ask-late', { id: call.id, tool: e.tool }).catch(() => undefined)
        })
      }

      if (answer !== 'Allow' && answer !== 'Allow for session') {
        const durationMs = (await $.clock.now()) - startedAt
        await mutate($, current => model.recordCall(current, { ...call, outcome: 'declined', durationMs }))
        await badge($, { ...call, outcome: 'declined' })
        await audit($, 'guard.ask', { id: call.id, tool: e.tool, input: call.summary, reason: verdict.reason, answer: 'declined', ...(wasRemote ? { by: first.remote.by } : {}) })
        await emit($, 'tool.end', { id: call.id, outcome: 'declined', ms: durationMs })

        return { deny: `The user declined this ${e.tool} call in SmartWorkbench (${verdict.reason}).` }
      }

      if (answer === 'Allow for session' && scope) {
        await allowForSession($, scope.key, scope.label)
      }
      await audit($, 'guard.ask', {
        id: call.id,
        tool: e.tool,
        input: call.summary,
        reason: verdict.reason,
        answer: answer === 'Allow' ? 'allowed' : 'allowed-session',
        ...(wasRemote ? { by: first.remote.by } : {}),
        ...(answer === 'Allow' || !scope ? {} : { scope: scope.label }),
      })
    }

    $.ui.log(`SmartWorkbench timing: tool.call guard ${(await $.clock.now()) - hookStart}ms for ${e.tool}`, { to: 'debug' })

    // An image run is allowed unasked, so what it changed is checked afterwards: warned about, never reverted.
    const isBackgroundImage = isImage && /\s--background\b/.test(e.command)
    const imageBefore = isImage && !isBackgroundImage ? await treeState($) : undefined

    // Anything that could write a command file counts, for the questions that wait for an answer from outside: a command or an MCP tool (which may leave a
    // process behind, so for an hour no answer from outside is taken), a file write (a watcher may run the new code), and Codex run in the background.
    if (e.tool === 'Bash' || e.tool.startsWith('mcp__') || EDIT_TOOL_NAMES.has(e.tool)) {
      runCount++
      const isOwnTool = e.tool.startsWith('mcp__smartworkbench__')
      const isBackground = e.tool === 'Bash' ? (e as unknown as { run_in_background?: unknown }).run_in_background === true || mayDetach(e.command) || codexRun?.background === true : e.tool.startsWith('mcp__') && !isOwnTool
      if (isBackground) lastBackgroundAt = await $.clock.now()
    }
    inFlight++
    // Allow still goes through Claude Code's own permission check beneath.
    const ran = await next(e).finally(() => {
      inFlight--
    })
    try {
    const endedAt = await $.clock.now()
    if (isImage && ran.deny === undefined) {
      const after = imageBefore ? await treeState($) : undefined
      const stray = imageBefore && after ? codex.strayWrites(imageBefore.stats, after.stats) : []
      if (isBackgroundImage) await audit($, 'codex.write-check', { id: call.id, skipped: 'background' }).catch(() => undefined)
      if (stray.length > 0) {
        const paths = stray.slice(0, 10).join(', ')
        await audit($, 'codex.write-check', { id: call.id, count: stray.length, paths }).catch(() => undefined)
        $.ui.toast(`SmartWorkbench: the Codex image run also changed files outside the image folders: ${model.cut(paths, 200)}. Nothing was reverted; check git diff.`)
      }
    }
    const isOk = ran.deny === undefined && ran.isError !== true
    const outcome = ran.deny !== undefined ? 'blocked' : isOk ? 'ok' : 'error'
    const kinds = e.tool === 'Bash' ? evidenceKindsOf(e.command) : []
    // A finished Workflow call only means the run started in the background; nothing here tells when or how it ends.
    const bg = e.tool === 'Workflow' && ran.deny === undefined && !ran.isError ? { workflowBg: true } : {}
    const agentOut = e.tool === 'Agent' && ran.deny === undefined && !ran.isError ? await agentOutput($, ran.result) : {}
    const toolOut = e.tool !== 'Agent' && e.tool !== 'Workflow' && !codexRun && !NO_IO.has(verdict.category) && ran.deny === undefined && resultText(ran.result) !== '' ? promptOf(await read($, liveAtom), resultText(ran.result), 'toolOut') : {}
    const notebookPath = (e as unknown as Record<string, unknown>).notebook_path
    const rawPath =
      'file_path' in e && typeof e.file_path === 'string' ? e.file_path : typeof notebookPath === 'string' ? notebookPath : undefined
    const inRepo = rawPath === undefined ? undefined : repoPath(rawPath, cwd)
    const path = inRepo ?? rawPath
    if (ledger && isOk && path !== undefined && model.isEditTool(e.tool)) await record($, 'edit', { file: path, tool: e.tool })
    if (ledger && isOk && e.tool === 'Bash' && isGitCommit(e.command)) await noteCommits($, 'tool')
    // A Bash run that was interrupted or sent to the background has no known outcome: it neither counts as a failure nor clears one.
    const bashResult = e.tool === 'Bash' && !ran.isError ? (ran.result as { interrupted?: boolean; backgroundTaskId?: string } | undefined) : undefined
    const isUnsettled = bashResult?.interrupted === true || bashResult?.backgroundTaskId !== undefined

    const fresh: EvidenceRecord[] = []
    await mutate($, current => {
      let updated = model.recordCall(current, { ...call, outcome, durationMs: endedAt - startedAt })

      if (kinds.length > 0 && e.tool === 'Bash' && ran.deny === undefined) {
        // One record per kind a command runs; the first keeps the call id, which the badge and the counts look up.
        kinds.forEach((kind, i) => {
          const ok = isUnsettled ? null : checkOutcome(e.command, kind, isOk)
          const record: EvidenceRecord = { id: i === 0 ? call.id : `${call.id}#${kind}`, kind, command: e.command.slice(0, 200), ok, at: endedAt }
          updated = model.addEvidence(updated, record)
          fresh.push(record)
        })
      }

      // A file outside the project is neither pinned nor counted as the task's change: it must not trigger the final check or stale a passing test.
      return path && isOk && (inRepo !== undefined || !EDIT_TOOL_NAMES.has(e.tool)) ? model.observe(updated, e.tool, path, endedAt) : updated
    })

    for (const record of fresh) await emit($, 'evidence', { id: record.id, ekind: record.kind, command: model.cut(redact(scanned(record.command)), 120), ok: record.ok })
    if (fresh.length > 0) await emitState($)

    if (isTeam && isOk && e.agentId === undefined && inRepo !== undefined && model.isEditTool(e.tool)) {
      const lines = crew.editSize(e.tool, e as unknown as Record<string, unknown>).lines
      await updateTrack($, track => crew.noteEdit(track, inRepo, lines))
    }
    if (isTeam && isOk && e.tool === 'ExitPlanMode') {
      await updateTrack($, track => ({ ...track, planApprovedAt: endedAt }))
    }

    if (isOk && path === POLICY_PATH && model.isEditTool(e.tool)) {
      await loadPolicy($)
    }

    if (isTeam && codexRun?.op === 'task' && ran.deny === undefined) {
      const isImageRun = codexRun.write && typeof live.codexPath === 'string' && codex.isImageTask(e.command, live.codexPath)
      await updateTrack($, track => (isImageRun ? track : codex.codexTasked(track, endedAt)))
    }
    if (isTeam && isOk && codexRun && (codexRun.op === 'review' || codexRun.op === 'adversarial-review')) {
      await updateTrack($, track => codex.codexRan(track, endedAt))
      await audit($, 'team.codex-review', { id: call.id })
    }

    if (e.tool === 'Agent' && e.subagent_type === crew.ADVISOR && isOk) {
      const launched = (ran.result as { agentId?: unknown } | undefined)?.agentId
      if ((e as unknown as { run_in_background?: unknown }).run_in_background === true && typeof launched === 'string') {
        // Launching a background advisor is not its review: the design and final-check gates open when its run ends.
        backgroundAdvisors.set(launched, { id: call.id, description: String(e.description ?? '') })
      } else {
        await updateTrack($, track => crew.advisorRan(track, endedAt))
        await audit($, 'team.advisor', { id: call.id, description: e.description })
      }
    } else if (isTeam && e.agentId === undefined && ran.deny === undefined && !isUnsettled && e.tool !== 'Agent' && e.tool !== 'Workflow') {
      const key = crew.failureKey(e.tool, e as unknown as Record<string, unknown>)
      let nudge = false
      const track = await updateTrack($, current => {
        const result = crew.trackResult(current, key, isOk)
        nudge = result.nudge
        return result.track
      })
      if (nudge) {
        await audit($, 'team.repeat-error', { tool: e.tool, input: call.summary, count: track.failures[key] ?? 0 })
        // This branch returns early, so the badge and the end of the call are recorded here.
        await badge($, { ...call, outcome })
        await emit($, 'tool.end', { id: call.id, outcome, ms: endedAt - startedAt, ...agentOut, ...toolOut, ...bg })
        return { ...ran, context: [...(ran.context ?? []), crew.repeatNudge(track.failures[key] ?? crew.REPEAT_LIMIT)] }
      }
    }
    await badge($, { ...call, outcome })
    await emit($, 'tool.end', { id: call.id, outcome, ms: endedAt - startedAt, ...agentOut, ...toolOut, ...bg })

    return ran
    } catch {
      // The call already ran; a failure in the records after it must not run it a second time. The live view is told it ended.
      await emit($, 'tool.end', { id: call.id, outcome: ran.deny === undefined && ran.isError !== true ? 'ok' : 'error', ms: 0 }).catch(() => undefined)
      return ran
    }
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
    // A session the app started after it may not have changed anything yet; the end of a turn is a good time to show where it stands.
    scheduleSnapshot($)

    if (e.agentId !== undefined) {
      const advisor = backgroundAdvisors.get(e.agentId)
      if (advisor) {
        backgroundAdvisors.delete(e.agentId)
        await updateTrack($, track => crew.advisorRan(track, Date.now()))
        await audit($, 'team.advisor', { id: advisor.id, description: advisor.description, background: true })
      }
      await emit($, 'turn.agent', { agent: e.agentId, ...usageOf(e.usage) })
      if (typeof e.answer === 'string' && e.answer !== '') {
        agentAnswers.set(e.agentId, promptOf(await read($, liveAtom), e.answer, 'output'))
        if (agentAnswers.size > 50) agentAnswers.delete(agentAnswers.keys().next().value as string)
      }

      return ran
    }

    if (ledger && typeof e.answer === 'string' && e.answer !== '') await record($, 'reply', { text: e.answer })
    if (ledger) await noteCommits($, 'turn')
    const ctx = await refreshUsage($).catch(() => ({}))
    await emit($, 'turn', { aborted: e.isAborted === true, ...ctx, ...usageOf(e.usage) })
    await emitState($)

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

    // Esc takes the session back: a loop running (or set and waiting for pass 1) ends here, since an aborted turn sends no Stop.
    if (e.isAborted) {
      const running = (await read($, liveAtom)).loop
      if (running) {
        await setLive($, current => ({ ...current, loop: undefined }))
        await audit($, 'loop.stop', { done: running.done, by: 'abort' }).catch(() => undefined)
        if (running.pending) $.ui.toast('SmartWorkbench: Loop cancelled before pass 1 because the turn was interrupted.')
      }
    }

    const queued = (await read($, liveAtom)).pendingPrompt
    if (queued && !e.isAborted) {
      await setLive($, current => ({ ...current, pendingPrompt: undefined }))
      void Promise.resolve($.prompt.submit({ text: queued })).catch(() => undefined)
    }

    // Changed regions against HEAD, so the Evidence tab can say which ones a check has seen.
    const diff = await $.process.run(['git', '-c', 'core.quotePath=false', 'diff', '-U0', '--relative', '--no-color', '--no-ext-diff', 'HEAD'], { cwd: await $.session.root() }).catch(() => undefined)
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

        const wantsCodex = codex.isCodexOn(wb.team) && codex.codexOf(wb.team).review && !!live.codexPath && !running && !codex.hasReviewedThisTurn(track)

        return { ...result, block: crew.finalCheckReason(wb.task.goal, wb.task.doneConditions.map(one => one.text), wantsCodex) }
      }
    }

    // The command's own turn ends before pass 1 went out; that stop is not a pass.
    if (!running || running.pending) return result

    const lastEdit = lastAnyEdit(wb.changed)
    // An infinite loop that only edits through the shell still counts as working when the git working tree changed.
    const hash = running.limit === null ? await workTreeHash($) : undefined
    const isTreeChanged = hash !== undefined && running.treeHash !== undefined && hash !== running.treeHash
    const step = loop.advance(running, (lastEdit !== undefined && lastEdit >= (running.passAt ?? 0)) || isTreeChanged, await $.clock.now(), hash)
    // A /swb loop stop that came in while this hook awaited must stay stopped.
    let isGone = false
    await setLive($, current => {
      isGone = current.loop?.startedAt !== running.startedAt
      return isGone ? current : { ...current, loop: step.loop }
    })
    if (isGone) return result
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
