import { describe, expect, test } from 'claude-code/testing'

import { graphAnswer, graphDataOf, queryPath } from '../hooks/graph'
import * as model from '../hooks/model'

const ROOT = '/work/proj'
const node = (p: string, c = 'source', extra: Record<string, unknown> = {}) => ({ p, c, l: 'ts', s: 10, ext: 0, ...extra })
// auth -> db -> pool, login -> auth, auth.test -> auth (named), util is alone.
const raw = {
  v: 1,
  truncated: false,
  skipped: { secret: 1, generated: 0, big: 2, link: 0 },
  unresolved: 0,
  nodes: [node('src/auth.ts', 'source', { ext: 3 }), node('src/db.ts'), node('src/pool.ts'), node('src/login.ts'), node('src/auth.test.ts', 'test'), node('src/util.ts')],
  edges: [[0, 1, 'i'], [1, 2, 'i'], [3, 0, 'i'], [4, 0, 't']],
}
const wb = () => model.emptyWorkbench()
const data = () => graphDataOf(structuredClone(raw)) as NonNullable<ReturnType<typeof graphDataOf>>

describe('the graph answer', () => {
  test('a file lists what it imports, what imports it and its tests, sorted and without contents', () => {
    const text = graphAnswer(data(), 'src/auth.ts', 1, 'both', wb(), ROOT)
    expect(text).toContain('import_graph src/auth.ts (ts, source)')
    expect(text).toContain('imports (1): src/db.ts')
    expect(text).toContain('imported by (1): src/login.ts')
    expect(text).toContain('tests (1): src/auth.test.ts')
    expect(text).toContain('3 package imports')
    expect(text).toContain('skipped: 1 secret, 2 big')
  })

  test('depth 2 adds what the neighbours lean on with the file it came through; direction narrows the answer', () => {
    const text = graphAnswer(data(), 'src/auth.ts', 2, 'imports', wb(), ROOT)
    expect(text).toContain('imports (2, 2 steps): src/db.ts · src/pool.ts (via src/db.ts)')
    expect(text).not.toContain('imported by')
    expect(graphAnswer(data(), 'src/auth.ts', 1, 'importers', wb(), ROOT)).not.toContain('imports (')
  })

  test('a file that is not in the graph says why, and a partial graph says it may exist', () => {
    expect(graphAnswer(data(), 'src/none.ts', 1, 'both', wb(), ROOT)).toContain('not in the graph (no such JS/TS file')
    expect(graphAnswer(graphDataOf({ ...raw, truncated: { time: true } }) as never, 'src/none.ts', 1, 'both', wb(), ROOT)).toContain('graph partial: time; it may exist')
  })

  test('long lists are cut and the whole answer stays short', () => {
    const many = { ...raw, nodes: [node('src/hub.ts'), ...Array.from({ length: 60 }, (_, i) => node(`src/m${String(i).padStart(2, '0')}.ts`))], edges: Array.from({ length: 60 }, (_, i) => [i + 1, 0, 'i']) }
    const text = graphAnswer(graphDataOf(many) as never, 'src/hub.ts', 1, 'both', wb(), ROOT)
    expect(text).toContain('imported by (60):')
    expect(text).toContain('+20 more')
    expect(text.length).toBeLessThanOrEqual(4000)
  })

  test('what the session knows is added: changed and whether a check followed, pinned, read, and a test named by the last test run', () => {
    const state = wb()
    state.changed = { ...state.changed, files: ['src/db.ts'], edits: { 'src/db.ts': 100 } }
    state.evidence = [{ id: 'e1', kind: 'test', command: 'npx vitest src/auth.test.ts', ok: false, at: 200 }]
    state.context = { ...state.context, pins: [{ id: 'p1', kind: 'file', path: '/work/proj/src/auth.ts', mode: 'live' }], observed: [{ path: 'src/auth.ts', how: 'read', count: 3 }] }
    const text = graphAnswer(data(), 'src/auth.ts', 1, 'both', state, ROOT)
    expect(text).toContain('import_graph src/auth.ts (ts, source) [pinned, read×3]')
    expect(text).toContain('src/db.ts [changed:failing]')
    expect(text).toContain('src/auth.test.ts [in last test run:failed]')
    expect(text).toContain('session: last test run failed')
    expect(graphAnswer(data(), 'src/auth.ts', 1, 'both', wb(), ROOT)).not.toContain('session:')
  })
})

describe('which files may be asked about', () => {
  test('a project path, relative or absolute, is accepted and folded', () => {
    expect(queryPath('src/a.ts', ROOT)).toEqual({ ok: true, rel: 'src/a.ts' })
    expect(queryPath('./src/../src/a.tsx', ROOT)).toEqual({ ok: true, rel: 'src/a.tsx' })
    expect(queryPath('/work/proj/src/a.ts', ROOT)).toEqual({ ok: true, rel: 'src/a.ts' })
  })

  test('outside, secret, generated, non-code and odd inputs are refused without repeating the input', () => {
    const bad = ['../x.ts', '/etc/passwd.js', '/work/other/a.ts', '\\etc\\passwd.js', '\\\\srv\\s\\a.ts', '.ssh/id.ts', 'src/.env', 'src/a.key', 'dist/a.js', 'node_modules/x/i.js', 'README.md', 'a\nb.ts', `${'a'.repeat(301)}.ts`, '', '   ', 5, null, undefined, { file: 'x' }]
    for (const one of bad) {
      const out = queryPath(one, ROOT)
      expect(out.ok).toBe(false)
      if (!out.ok && typeof one === 'string' && one.trim() !== '') expect(out.reason).not.toContain(one.trim())
    }
  })
})

describe('the engine answer is not trusted', () => {
  test('anything but version 1 is refused; edges out of range and odd kinds are dropped; the node list is capped', () => {
    expect(graphDataOf(null)).toBeNull()
    expect(graphDataOf({ v: 2, nodes: [], edges: [] })).toBeNull()
    expect(graphDataOf({ v: 1, nodes: 'x', edges: [] })).toBeNull()
    const odd = graphDataOf({ v: 1, nodes: [node('a.ts'), { p: 5, c: 'evil', l: 'x', s: 'big' }], edges: [[0, 1, 'i'], [0, 9, 'i'], [0, 1, 'zz'], 'x', [-1, 0, 'i']], truncated: { time: true, junk: true }, skipped: { secret: 'x' } })
    expect(odd?.edges).toEqual([[0, 1, 'i']])
    expect(odd?.nodes[1]).toMatchObject({ p: '', c: 'source', l: 'js', s: 0 })
    expect(odd?.truncated).toEqual(['time'])
    expect(odd?.skipped.secret).toBe(0)
    expect(graphDataOf({ v: 1, nodes: Array.from({ length: 6000 }, (_, i) => node(`f${i}.ts`)), edges: [] })?.nodes).toHaveLength(5000)
  })
})

describe('what the answer does not claim', () => {
  test('a big file was not read: its imports are unknown, not none', () => {
    const big = graphDataOf({ ...raw, nodes: [...raw.nodes, node('src/huge.ts', 'source', { big: 1 })] }) as NonNullable<ReturnType<typeof graphDataOf>>
    const text = graphAnswer(big, 'src/huge.ts', 1, 'both', wb(), ROOT)
    expect(text).toContain('not read: over 256 KB')
    expect(text).toContain('imports (unknown): ?')
    expect(graphAnswer(big, 'src/none.ts', 1, 'both', wb(), ROOT)).not.toContain('skipped as big')
  })

  test('a test file counts as in the last run only when the command names it as a whole word', () => {
    const run = (command: string) => ({ ...wb(), evidence: [{ id: 'e', kind: 'test' as const, command, ok: true, at: 1 }] })
    expect(graphAnswer(data(), 'src/auth.test.ts', 1, 'both', run('npx vitest run src/live-auth.test.ts'), ROOT)).not.toContain('in last test run')
    expect(graphAnswer(data(), 'src/auth.test.ts', 1, 'both', run('npx vitest run auth.test.ts'), ROOT)).toContain('in last test run:passed')
  })
})
