import { coverageOf } from './diff'
import { latestOf } from './evidence'
import { categoryOf } from './files'
import { repoPath } from './policy'
import { normalisePath } from './risk'
import type { Workbench } from '../types'

// The import_graph tool: what a JS/TS file imports, what imports it and its tests, from the graph tools/graph-build.mjs makes
// (the live page's engine), with what this session knows about each file. Paths only, never contents.
export const GRAPH_TOOL = 'mcp__smartworkbench__import_graph'

export const GRAPH_DESCRIPTION =
  "Read-only import graph of this project's JS/TS files: what a file imports, what imports it, its tests, and what this session knows about each (changed and whether checked, pinned, read, last test result). Call it before editing a JS/TS file, before renaming or changing an export, and when asked what uses or depends on a file. Returns project paths only, no file contents."

const MAX_LIST = 40
const MAX_TEXT = 4000
const CODE_EXT = /\.(?:[cm]?[jt]s|[jt]sx)$/

type Kind = 'i' | 'r' | 'd' | 't'
export type GraphNode = { p: string; c: 'source' | 'test' | 'config' | 'docs'; l: string; s: number; big: boolean; ext: number }
export type GraphData = {
  nodes: GraphNode[]
  edges: [number, number, Kind][]
  truncated: string[]
  skipped: { secret: number; generated: number; big: number; link: number }
  unresolved: number
}
type Direction = 'both' | 'imports' | 'importers'
type Hop = { i: number; via: number; step: number }

const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)

// The graph engine's answer is not trusted to be well formed: every field gets a fixed shape, and anything but version 1 is refused.
export function graphDataOf(raw: unknown): GraphData | null {
  const g = raw as { v?: unknown; nodes?: unknown; edges?: unknown; truncated?: unknown; skipped?: unknown; unresolved?: unknown } | null
  if (!g || typeof g !== 'object' || g.v !== 1 || !Array.isArray(g.nodes) || !Array.isArray(g.edges)) return null
  const nodes = g.nodes.slice(0, 5000).map((one): GraphNode => {
    const n = (one && typeof one === 'object' ? one : {}) as Record<string, unknown>
    const c = String(n.c)

    return { p: typeof n.p === 'string' ? n.p.slice(0, 300) : '', c: c === 'test' || c === 'config' || c === 'docs' ? c : 'source', l: /^(ts|tsx|js)$/.test(String(n.l)) ? String(n.l) : 'js', s: num(n.s), big: n.big === 1, ext: num(n.ext) }
  })
  const edges: GraphData['edges'] = []
  for (const e of g.edges.slice(0, 20000)) {
    if (Array.isArray(e) && Number.isInteger(e[0]) && Number.isInteger(e[1]) && e[0] >= 0 && e[1] >= 0 && e[0] < nodes.length && e[1] < nodes.length && /^[irdt]$/.test(String(e[2]))) edges.push([e[0], e[1], e[2] as Kind])
  }
  const cut = g.truncated && typeof g.truncated === 'object' ? Object.keys(g.truncated).filter(key => /^(files|depth|bytes|time|edges)$/.test(key)) : []
  const sk = (g.skipped && typeof g.skipped === 'object' ? g.skipped : {}) as Record<string, unknown>

  return { nodes, edges, truncated: cut, skipped: { secret: num(sk.secret), generated: num(sk.generated), big: num(sk.big), link: num(sk.link) }, unresolved: num(g.unresolved) }
}

// A file the tool may be asked about: inside the project, JS/TS, not secret or generated (the rules the graph itself reads by).
// A reason never repeats the text it was given.
export function queryPath(raw: unknown, root: string): { ok: true; rel: string } | { ok: false; reason: string } {
  if (typeof raw !== 'string' || raw.trim() === '') return { ok: false, reason: 'give the project path of a JS/TS file as `file`' }
  if (raw.length > 300 || /[\0-\x1f]/.test(raw)) return { ok: false, reason: 'not a usable file path' }
  const text = raw.trim()
  let rel: string | undefined
  if (text.startsWith('/') || /^[A-Za-z]:[\\/]/.test(text)) rel = repoPath(text, root)
  else rel = normalisePath(text.replace(/\\/g, '/'))
  if (rel === undefined || rel === '' || rel === '..' || rel.startsWith('../') || rel.startsWith('/')) return { ok: false, reason: 'outside the project' }
  const category = categoryOf(rel)
  if (category === 'secret' || category === 'generated') return { ok: false, reason: `${category} files are not in the graph` }
  if (!CODE_EXT.test(rel)) return { ok: false, reason: 'not a JS/TS file' }

  return { ok: true, rel }
}

type Index = { out: [number, Kind][][]; inn: [number, Kind][][]; byPath: Map<string, number> }

function indexOf(d: GraphData): Index {
  const out: Index['out'] = d.nodes.map(() => [])
  const inn: Index['inn'] = d.nodes.map(() => [])
  const byPath = new Map<string, number>()
  d.nodes.forEach((n, i) => byPath.set(n.p, i))
  for (const [from, to, kind] of d.edges) {
    out[from]?.push([to, kind])
    inn[to]?.push([from, kind])
  }

  return { out, inn, byPath }
}

// The same walk as the live page's graphNeighbors: the files a file leans on, the files that lean on it and the tests that name or import it.
function neighborsOf(d: GraphData, ix: Index, start: number, depth: 1 | 2): { imports: Hop[]; by: Hop[]; tests: Hop[] } {
  const res = { imports: [] as Hop[], by: [] as Hop[], tests: [] as Hop[] }
  const walk = (dir: 'out' | 'inn', keep: (to: number, step: number) => boolean, list: Hop[]) => {
    const seen = new Set<number>([start])
    let level: number[] = [start]
    for (let step = 1; step <= depth; step++) {
      const next: number[] = []
      for (const from of level) {
        for (const [to] of (dir === 'out' ? ix.out : ix.inn)[from] ?? []) {
          if (seen.has(to) || !keep(to, step)) continue
          seen.add(to)
          list.push({ i: to, via: step === 1 ? -1 : from, step })
          next.push(to)
        }
      }
      level = next
    }
  }
  walk('out', (to, step) => step === 1 || d.nodes[to]?.c !== 'test', res.imports)
  walk('inn', to => d.nodes[to]?.c !== 'test', res.by)
  for (const [from] of ix.inn[start] ?? []) if (d.nodes[from]?.c === 'test') res.tests.push({ i: from, via: -1, step: 1 })

  return res
}

// A file name counts only as a whole word of the command (`graph.test.ts` is not in `live-graph.test.ts`).
const namedIn = (command: string, name: string): boolean => new RegExp(`(?:^|[\\s/'"=])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|[\\s'"])`).test(command)

// What the session knows about one file, as short tags in a fixed order. Only recorded facts, never a guess.
function marksOf(wb: Workbench, rel: string, root: string, isTest: boolean): string[] {
  const marks: string[] = []
  const same = (path: string) => (repoPath(path, root) ?? normalisePath(path)) === rel
  const coverage = coverageOf(wb.changed, wb.evidence).find(one => same(one.path))
  if (coverage || wb.changed.files.some(same)) marks.push(coverage && coverage.state !== 'docs' && coverage.state !== 'untracked' ? `changed:${coverage.state}` : 'changed')
  if (wb.context.pins.some(pin => pin.kind === 'file' && same(pin.path))) marks.push('pinned')
  const seen = wb.context.observed.find(one => same(one.path))
  if (seen) marks.push(seen.how === 'edited' ? 'edited' : `read×${seen.count ?? 1}`)
  if (isTest) {
    // Checks are recorded per command, not per file: a result is tied to a test file only when its command names the file.
    const run = latestOf(wb.evidence, 'test')
    const name = rel.slice(rel.lastIndexOf('/') + 1)
    if (run && run.ok !== null && (run.command.includes(rel) || namedIn(run.command, name))) marks.push(`in last test run:${run.ok ? 'passed' : 'failed'}`)
  }

  return marks
}

// The answer: deterministic, short, paths only. Lists are sorted by path and cut at MAX_LIST.
export function graphAnswer(d: GraphData, rel: string, depth: 1 | 2, direction: Direction, wb: Workbench, root: string): string {
  const ix = indexOf(d)
  const at = ix.byPath.get(rel)
  if (at === undefined) {
    return `import_graph ${rel}: not in the graph (${d.truncated.length ? `graph partial: ${d.truncated.join(', ')}; it may exist` : 'no such JS/TS file, or a secret, generated or linked file'})`
  }
  const node = d.nodes[at] as GraphNode
  const tag = (i: number) => {
    const one = d.nodes[i] as GraphNode
    const marks = marksOf(wb, one.p, root, one.c === 'test')

    return marks.length ? `${one.p} [${marks.join(', ')}]` : one.p
  }
  const list = (hops: Hop[]) => {
    const sorted = [...hops].sort((a, b) => a.step - b.step || ((d.nodes[a.i]?.p ?? '') < (d.nodes[b.i]?.p ?? '') ? -1 : 1))
    const shown = sorted.slice(0, MAX_LIST).map(hop => (hop.step === 1 ? tag(hop.i) : `${tag(hop.i)} (via ${d.nodes[hop.via]?.p ?? '?'})`))

    return shown.join(' · ') + (sorted.length > MAX_LIST ? ` · +${sorted.length - MAX_LIST} more` : '')
  }
  const near = neighborsOf(d, ix, at, depth)
  const own = marksOf(wb, rel, root, node.c === 'test')
  const lines = [`import_graph ${rel} (${node.l}, ${node.c})${own.length ? ` [${own.join(', ')}]` : ''}`]
  const run = latestOf(wb.evidence, 'test')
  if (run && run.ok !== null) lines.push(`session: last test run ${run.ok ? 'passed' : 'failed'}`)
  // A big file was not read: no import is known, which is not the same as none.
  if (node.big) lines.push('not read: over 256 KB, so what it imports is unknown')
  if (direction !== 'importers') lines.push(`imports (${node.big ? 'unknown' : near.imports.length}${depth === 2 ? ', 2 steps' : ''}): ${node.big ? '?' : list(near.imports) || '-'}`)
  if (direction !== 'imports') lines.push(`imported by (${near.by.length}${depth === 2 ? ', 2 steps' : ''}): ${list(near.by) || '-'}`)
  lines.push(`tests (${near.tests.length}): ${list(near.tests) || '-'}`)
  const notes = [
    ...(node.ext ? [`${node.ext} package imports`] : []),
    ...(d.truncated.length ? [`graph partial (${d.truncated.join(', ')})`] : []),
    ...(d.unresolved ? [`${d.unresolved} imports not resolved`] : []),
    ...(['secret', 'generated', 'big', 'link'] as const).filter(key => d.skipped[key] > 0).length ? [`skipped: ${(['secret', 'generated', 'big', 'link'] as const).filter(key => d.skipped[key] > 0).map(key => `${d.skipped[key]} ${key}`).join(', ')}`] : [],
  ]
  if (notes.length) lines.push(`notes: ${notes.join(' · ')}`)
  const text = lines.join('\n')

  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text
}
