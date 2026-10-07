import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, Register, RenderElement } from 'claude-code'

import type { ConditionStatus, ContextPin, EvidenceKind, EvidenceRecord, GuardProfile, Live, Tab, Template, ToolCallRecord, Workbench } from '../types'
import { estimateTokens, injectionOf, pinText, rangeLabel, sha256, type Injection, type PinContent } from './context'
import { completionOf, evidenceKindOf, latestOf, markOf, statusOf, turnSummary } from './evidence'
import * as model from './model'
import { badgeOf, handoffMarkdown } from './report'
import { classify, decide, summarize } from './risk'

type $ = EngineInterface
type Els = Elements['terminal'] | Elements['desktop'] | Elements['vscode']
type View = { els: Els; wb: Workbench; live: Live; width: number; room: number }

const PANE = 'smartworkbench'
const TABS: readonly Tab[] = ['intent', 'context', 'run', 'evidence']
const TAB_LABEL: Record<Tab, string> = { intent: 'Intent', context: 'Context', run: 'Run', evidence: 'Evidence' }
const TAB_ARGS: Record<string, Tab> = { intent: 'intent', context: 'context', run: 'run', verify: 'evidence', evidence: 'evidence' }
const LINKS: readonly (EvidenceKind | 'none')[] = ['none', 'test', 'build', 'typecheck', 'lint']
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
  '  /smartworkbench status     text summary (works without UI)',
  '  /smartworkbench preview    show the context added to each prompt',
  '  /smartworkbench save <name>      save the contract, pins and guard as a template',
  '  /smartworkbench load <name>      start a task from a template',
  '  /smartworkbench templates        list templates and context sets',
  '  /smartworkbench export [path]    write a Markdown handoff (default .claude/smartworkbench-handoff.md)',
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

async function mutate($: $, change: (wb: Workbench) => Workbench): Promise<Workbench> {
  const next = await update($, wbAtom, wb => model.withStatus(change(wb)))
  await $.store.set(await storeKey($), next)

  return next
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
  await mutate($, wb => model.markCondition(wb, id, status, note, at))
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
    .map(one => ({ one, status: statusOf(one, wb.evidence) }))
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

// ---- commands

function statusText(wb: Workbench, live: Live): string {
  const constraints = wb.task.constraints.filter(one => one.isActive).map(one => `  [${one.priority === 'hard' ? 'H' : 'S'}] ${one.text}`)
  const pins = wb.context.pins.map(one => `  ${one.kind === 'file' ? one.path : `Note: ${one.text}`}`)

  return [
    model.bandText(wb, live),
    `Goal: ${wb.task.goal || '—'} (${wb.task.locked ? 'locked' : 'unlocked'}, ${wb.task.status})`,
    ...(constraints.length > 0 ? ['Constraints:', ...constraints] : []),
    ...(pins.length > 0 ? ['Pins:', ...pins] : []),
    ...(wb.task.doneConditions.length > 0 ? [turnSummary(wb.task, wb.evidence)] : []),
  ].join('\n')
}

async function runCommand($: $, args: string): Promise<{ text: string }> {
  const word = (args.trim().split(/\s+/)[0] ?? '').toLowerCase()

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
    await mutate($, model.newTask)
    await openPane($, 'intent')

    return { text: 'New SmartWorkbench task. Write the goal and done conditions, then Lock.' }
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
    const template = (await $.store.get(`tpl:${name}`)) as Template | undefined
    if (name === '' || template === undefined) {
      const names = await savedNames($, 'tpl:')
      return { text: `No template "${name}". Templates: ${names.length > 0 ? names.join(', ') : 'none'}` }
    }
    const wb = await read($, wbAtom)
    if (wb.task.goal.trim() !== '') {
      const answer = await $.ui
        .ask(`Replace the current task with template "${name}"? Its evidence is cleared.`, ['Load template', 'Keep current'])
        .catch(() => 'Keep current')
      if (answer !== 'Load template') return { text: 'Kept the current task.' }
    }
    await mutate($, current => model.applyTemplate(current, template))
    await openPane($, 'intent')

    return { text: `Loaded template "${name}". Review it, then Lock.` }
  }

  if (word === 'templates') {
    const templates = await savedNames($, 'tpl:')
    const sets = await savedNames($, 'set:')

    return { text: `Templates: ${templates.length > 0 ? templates.join(', ') : 'none'}\nContext sets: ${sets.length > 0 ? sets.join(', ') : 'none'}` }
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

function intentTab($: $, { els, wb, width }: View): RenderElement {
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
          onPress={() => void mutate($, model.toggleLock)}
        />
      </Box>
      <Text bold>Goal</Text>
      {ro ? (
        <Text wrap="wrap">{task.goal || '—'}</Text>
      ) : (
        <Input key="goal" placeholder="One core goal for this task" value={task.goal} submitLabel="save" onSubmit={value => void mutate($, wb => model.setGoal(wb, value))} />
      )}
      <Text bold>Constraints</Text>
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
        <Input key="add-constraint" placeholder="+ constraint (s: prefix = soft)" value="" submitLabel="add" onSubmit={value => void mutate($, wb => model.addConstraint(wb, value))} />
      )}
      <Text bold>Done conditions</Text>
      {task.doneConditions.length === 0 && <Text dimColor>none</Text>}
      {task.doneConditions.map(one => {
        const status = statusOf(one, wb.evidence)

        return (
          <Box key={`d-${one.id}`} gap={1}>
            <Text color={STATUS_COLOR[status]}>{markOf(status)}</Text>
            <Text wrap="truncate-end">{model.cut(one.text, width - 8)}</Text>
            {!ro && <Button key={`dx-${one.id}`} plain dimColor label="×" onPress={() => void mutate($, wb => model.removeCondition(wb, one.id))} />}
          </Box>
        )
      })}
      {!ro && <Input key="add-condition" placeholder="+ done condition" value="" submitLabel="add" onSubmit={value => void mutate($, wb => model.addCondition(wb, value))} />}
      <Text bold>Non-goals</Text>
      {task.nonGoals.length === 0 && <Text dimColor>none</Text>}
      {task.nonGoals.map((one, i) => (
        <Box key={`n-${i}`} gap={1}>
          <Text dimColor>–</Text>
          <Text wrap="truncate-end">{model.cut(one, width - 6)}</Text>
          {!ro && <Button key={`nx-${i}`} plain dimColor label="×" onPress={() => void mutate($, wb => model.removeNonGoal(wb, i))} />}
        </Box>
      ))}
      {!ro && <Input key="add-nongoal" placeholder="+ non-goal" value="" submitLabel="add" onSubmit={value => void mutate($, wb => model.addNonGoal(wb, value))} />}
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
  const pinned = new Set(wb.context.pins.flatMap(one => (one.kind === 'file' ? [one.path] : [])))
  const observed = wb.context.observed.filter(one => !pinned.has(one.path)).slice(-Math.max(3, room - wb.context.pins.length - 10))

  return (
    <Box flexDirection="column">
      <Text>
        {usage} · SmartWorkbench adds {estimateTokens(added.chars)}
      </Text>
      <Text bold>PINNED</Text>
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
      <Input key="pin-file" placeholder="+ file to pin (path or path:10-40)" value="" submitLabel="pin" onSubmit={value => void mutate($, wb => model.pinFile(wb, value))} />
      <Input key="pin-note" placeholder="+ note to pin" value="" submitLabel="pin" onSubmit={value => void mutate($, wb => model.pinNote(wb, value))} />
      <Text bold>OBSERVED</Text>
      {observed.length === 0 && <Text dimColor>nothing yet</Text>}
      {observed.map(one => (
        <Box key={`obs-${one.path}`} gap={1}>
          <Text dimColor>○</Text>
          <Text wrap="truncate-end">{model.cut(one.path, width - 18)}</Text>
          <Text dimColor>{one.how}</Text>
          <Button key={`pinobs-${one.path}`} plain label="Pin" onPress={() => void mutate($, wb => model.pinFile(wb, one.path))} />
        </Box>
      ))}
      <Input key="save-set" placeholder="save pins as a context set: name" value="" submitLabel="save" onSubmit={value => void saveSet($, value)} />
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

function runTab($: $, { els, wb, width, room }: View): RenderElement {
  const { Box, Text, Button, Select } = els
  const calls = wb.execution.recentCalls
  const running = calls.filter(one => one.outcome === 'running')
  const recent = calls
    .filter(one => one.outcome !== 'running')
    .slice(-Math.max(3, room - 10))
    .reverse()

  return (
    <Box flexDirection="column">
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
      <Text bold>RUNNING</Text>
      {running.length === 0 && <Text dimColor>idle</Text>}
      {running.map(one => (
        <Text key={`run-${one.id}`} color="suggestion" wrap="truncate-end">
          ◉ {one.tool} · {model.cut(one.summary, width - one.tool.length - 6)}
        </Text>
      ))}
      <Text bold>RECENT</Text>
      {recent.length === 0 && <Text dimColor>no calls yet</Text>}
      {recent.map(one => {
        const { mark, color } = outcomeMark(one)
        const tag =
          one.outcome === 'blocked'
            ? 'BLOCKED'
            : one.outcome === 'declined'
              ? 'DECLINED'
              : one.policy === 'ask'
                ? 'ASKED'
                : one.risk === 'low'
                  ? ''
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
  const { met, total, isComplete } = completionOf(wb.task, wb.evidence)
  const hasUnmet = met < total

  return (
    <Box flexDirection="column">
      <Text bold color={isComplete ? 'success' : total === 0 ? undefined : 'warning'}>
        Completion {met} / {total} · {total === 0 ? 'NO CONDITIONS' : isComplete ? 'COMPLETE' : 'INCOMPLETE'}
      </Text>
      {total === 0 && <Text dimColor>Add done conditions in the Intent tab.</Text>}
      {wb.task.doneConditions.map(one => {
        const status = statusOf(one, wb.evidence)
        const latest = one.link ? latestOf(wb.evidence, one.link) : undefined
        const detail = one.manual
          ? `manual ${one.manual.status}: ${one.manual.note}`
          : latest
            ? `${latest.ok === null ? 'ran' : latest.ok ? 'passed' : 'failed'} · ${latest.command}`
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
      {wb.changed.files.slice(-5).map(path => (
        <Text key={`chg-${path}`} dimColor wrap="truncate-start">
          {'  '}
          {model.cut(path, width - 2)}
        </Text>
      ))}
      <Box gap={1}>
        {hasUnmet && <Button key="finish" variant="primary" hotkey="f" label="Ask Claude to finish" onPress={() => void askToFinish($, wb)} />}
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

async function pane($: $, els: Els, width: number, rows: number): Promise<RenderElement> {
  const wb = await read($, wbAtom)
  const live = await read($, liveAtom)
  const { Box, Text, Button } = els
  const view: View = { els, wb, live, width, room: Math.max(8, rows - 6) }
  const tab = live.activeTab
  const body =
    tab === 'intent' ? intentTab($, view) : tab === 'context' ? await contextTab($, view) : tab === 'run' ? runTab($, view) : evidenceTab($, view)

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
    const argumentHint = '[new|context|run|verify|status|preview|save|load|templates|export|clear]'
    const description = 'SmartWorkbench: task contract, context pins, guard and evidence'
    await $.command.register({ name: 'smartworkbench', description, argumentHint })
    await $.command.register({ name: 'swb', description, argumentHint })
    await $.command.register({ name: 'workbench', description: 'Deprecated alias of /smartworkbench', argumentHint })
    await load($)

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
    const { blocks, warnings } = await injection($, await read($, wbAtom))
    await setLive($, live => ({ ...live, pinWarnings: warnings }))

    if (warnings.length > 0) {
      $.ui.toast(`SmartWorkbench: ${warnings.join(', ')}`)
    }

    return blocks.length === 0 ? next(e) : next({ ...e, context: [...(e.context ?? []), ...blocks] })
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    const verdict = classify(e.tool, e)
    const wb = await read($, wbAtom)
    const policy = decide(verdict, wb.execution.profile, wb.execution.isPaused)
    const startedAt = await $.clock.now()
    const call: ToolCallRecord = {
      id: e.tool_use_id ?? `call-${startedAt}`,
      tool: e.tool,
      summary: summarize(e.tool, e),
      risk: verdict.risk,
      policy,
      ...(verdict.reason ? { reason: verdict.reason } : {}),
      outcome: 'running',
      startedAt,
      ...(e.agentId ? { agentId: e.agentId } : {}),
    }
    await mutate($, current => model.recordCall(current, call))

    if (policy === 'block') {
      await mutate($, current => model.recordCall(current, { ...call, outcome: 'blocked', durationMs: 0 }))
      await badge($, { ...call, outcome: 'blocked' })

      return {
        deny: `SmartWorkbench blocked this ${e.tool} call: ${verdict.reason}. The user's guard policy forbids it; do not retry it another way. Ask the user if it is really needed.`,
      }
    }

    if (policy === 'ask') {
      const answer = await $.ui
        .ask(`SmartWorkbench: ${verdict.reason}. Allow ${e.tool}: ${call.summary.slice(0, 80)}?`, { header: 'Guard', options: ['Allow', 'Block'] })
        .catch(() => 'Block')

      if (answer !== 'Allow') {
        const durationMs = (await $.clock.now()) - startedAt
        await mutate($, current => model.recordCall(current, { ...call, outcome: 'declined', durationMs }))
        await badge($, { ...call, outcome: 'declined' })

        return { deny: `The user declined this ${e.tool} call in SmartWorkbench (${verdict.reason}).` }
      }
    }

    // Allow still goes through Claude Code's own permission check beneath.
    const ran = await next(e)
    const endedAt = await $.clock.now()
    const isOk = ran.deny === undefined && ran.isError !== true
    const outcome = ran.deny !== undefined ? 'blocked' : isOk ? 'ok' : 'error'
    const kind = e.tool === 'Bash' ? evidenceKindOf(e.command) : undefined
    const cwd = await $.session.cwd()
    const rawPath = 'file_path' in e && typeof e.file_path === 'string' ? e.file_path : undefined
    const path = rawPath?.startsWith(`${cwd}/`) ? rawPath.slice(cwd.length + 1) : rawPath

    await mutate($, current => {
      let updated = model.recordCall(current, { ...call, outcome, durationMs: endedAt - startedAt })

      if (kind && e.tool === 'Bash' && ran.deny === undefined) {
        const result = (ran.isError ? undefined : ran.result) as { interrupted?: boolean; backgroundTaskId?: string } | undefined
        const isUnknown = result?.interrupted === true || result?.backgroundTaskId !== undefined
        const record: EvidenceRecord = { id: call.id, kind, command: e.command.slice(0, 200), ok: isUnknown ? null : isOk, at: endedAt }
        updated = model.addEvidence(updated, record)
      }

      return path && isOk ? model.observe(updated, e.tool, path) : updated
    })
    await badge($, { ...call, outcome })

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
    const wb = await read($, wbAtom)

    if (wb.changed.files.length > 0) {
      const diff = await $.process.run(['git', 'diff', '--numstat', 'HEAD']).catch(() => undefined)
      if (diff?.exitCode === 0) {
        const totals = diff.stdout.split('\n').reduce(
          (sum, line) => {
            const [added, removed] = line.split('\t')
            return { added: sum.added + (Number(added) || 0), removed: sum.removed + (Number(removed) || 0) }
          },
          { added: 0, removed: 0 },
        )
        await mutate($, current => ({ ...current, changed: { ...current.changed, ...totals } }))
      }
    }

    if (wb.task.goal.trim() !== '' && wb.task.doneConditions.length > 0 && !e.isAborted) {
      const summary = turnSummary(wb.task, wb.evidence)
      await setLive($, live => ({ ...live, lastSummary: summary }))
      $.ui.log(`${summary}\n/smartworkbench verify → Evidence tab (Verify · Waive · Ask Claude to finish)`)
    }

    return ran
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
    const text = (await read($, badgesAtom))[e.props.tool_use_id]

    if (text === undefined) {
      return row
    }

    const { Box, Text } = $.ui.resolve(e)
    const color = /Blocked|Declined|failed/.test(text) ? 'error' : /passed/.test(text) ? 'success' : 'warning'

    return (
      <Box flexDirection="column">
        {row}
        <Text color={color} dimColor wrap="truncate-end">
          {'  '}
          {text}
        </Text>
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
    const { isComplete } = completionOf(wb.task, wb.evidence)

    return (
      <Box flexDirection="column">
        {below}
        <Box gap={1}>
          <Text color={isComplete ? 'success' : wb.task.locked ? 'claude' : undefined} dimColor={!wb.task.locked} wrap="truncate-end">
            {model.bandText(wb, live)}
          </Text>
          <Button key="wb-open" plain label="Open" onPress={() => void openPane($)} />
        </Box>
      </Box>
    )
  })
}
