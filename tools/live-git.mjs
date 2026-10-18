// The branch and short commit of the project a live feed belongs to, for the page's top bar.
// One short git call each, cached for ten seconds; no git, no repository or a path that is not absolute gives null.
import { execFileSync } from 'node:child_process'
import { isAbsolute } from 'node:path'

const TTL = 10_000
const cache = new Map()

function run(project, args) {
  return execFileSync('git', ['-C', project, ...args], { encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }).trim()
}

export function gitOf(project) {
  if (typeof project !== 'string' || !isAbsolute(project)) return null
  const hit = cache.get(project)
  if (hit && Date.now() - hit.at < TTL) return hit.value
  let value = null
  try {
    value = { branch: run(project, ['rev-parse', '--abbrev-ref', 'HEAD']).slice(0, 100), head: run(project, ['rev-parse', '--short', 'HEAD']).slice(0, 40) }
  } catch {
    value = null
  }
  if (cache.size > 50) cache.clear()
  cache.set(project, { at: Date.now(), value })
  return value
}
