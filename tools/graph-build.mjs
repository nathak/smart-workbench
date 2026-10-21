// Builds the import graph of one project for the mod's import_graph tool: `node graph-build.mjs <root>`.
// stdin is optional: the cache a previous run printed, so only changed files are read again. Prints { graph, cache } as JSON.
// The mod cannot read files itself, and the engine is the one the live page uses (live-graph.mjs), so nothing is read that the page would not read.
import { buildGraph } from './live-graph.mjs'

const MAX_CACHE_BYTES = 2 * 1024 * 1024
const MAX_SPECS = 2000
const MAX_OUT_BYTES = 3 * 1024 * 1024

// A cache from outside is checked entry by entry; anything that does not fit is dropped and that file is read again.
function cacheFrom(text) {
  const out = new Map()
  let raw
  try {
    raw = JSON.parse(text)
  } catch {
    return out
  }
  if (!raw || raw.v !== 1 || !Array.isArray(raw.cache)) return out
  for (const pair of raw.cache.slice(0, 20000)) {
    if (!Array.isArray(pair) || typeof pair[0] !== 'string' || pair[0].length > 400) continue
    const one = pair[1]
    if (!one || typeof one !== 'object' || !Number.isFinite(one.size) || !Number.isFinite(one.mtimeMs) || !Array.isArray(one.specs) || one.specs.length > MAX_SPECS) continue
    if (!one.specs.every(s => Array.isArray(s) && typeof s[0] === 'string' && s[0].length <= 400 && /^[ird]$/.test(String(s[1])))) continue
    out.set(pair[0], { size: one.size, mtimeMs: one.mtimeMs, ctimeMs: Number.isFinite(one.ctimeMs) ? one.ctimeMs : undefined, ino: Number.isFinite(one.ino) ? one.ino : undefined, specs: one.specs.map(s => [s[0], s[1]]), big: one.big === true, stale: one.stale === true })
  }

  return out
}

const root = process.argv[2]
if (!root) {
  process.stderr.write('usage: graph-build.mjs <root>\n')
  process.exit(2)
}
let input = ''
if (!process.stdin.isTTY) for await (const chunk of process.stdin) input += chunk
try {
  const { graph, cache } = await buildGraph(root, cacheFrom(input))
  const out = { graph }
  const entries = [...cache]
  // The cache rides along only while the whole answer stays small (the caller reads a bounded stdout); without it the next run reads every file again.
  const graphText = JSON.stringify(graph)
  const cacheText = JSON.stringify({ v: 1, cache: entries })
  if (process.argv[3] !== 'nocache' && Buffer.byteLength(cacheText) <= MAX_CACHE_BYTES && Buffer.byteLength(graphText) + Buffer.byteLength(cacheText) <= MAX_OUT_BYTES) out.cache = { v: 1, cache: entries }
  process.stdout.write(JSON.stringify(out))
} catch {
  process.stderr.write('graph build failed\n')
  process.exit(1)
}
