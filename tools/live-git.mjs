// The branch and short commit of the project a live feed belongs to, for the page's top bar.
// gitOf answers at once from a cache and starts a refresh in the background (git never blocks the server); the first answer for a project is null and the page's next poll has it.
// No git, no repository or a path that is not absolute gives null.
import { execFile } from 'node:child_process'
import { isAbsolute } from 'node:path'

const TTL = 10_000
const cache = new Map()
const pending = new Map()

function run(project, args) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', project, ...args], { encoding: 'utf8', timeout: 1000, windowsHide: true, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }, (error, stdout) => error ? reject(error) : resolve(stdout.trim()))
  })
}

export function gitRefresh(project) {
  if (typeof project !== 'string' || !isAbsolute(project)) return Promise.resolve(null)
  const running = pending.get(project)
  if (running) return running
  const job = (async () => {
    let value = null
    try {
      const [branch, head] = await Promise.all([run(project, ['rev-parse', '--abbrev-ref', 'HEAD']), run(project, ['rev-parse', '--short', 'HEAD'])])
      value = { branch: branch.slice(0, 100), head: head.slice(0, 40) }
    } catch {
      value = null
    }
    if (cache.size > 50) cache.clear()
    cache.set(project, { at: Date.now(), value })
    return value
  })().finally(() => pending.delete(project))
  pending.set(project, job)
  return job
}

export function gitOf(project) {
  if (typeof project !== 'string' || !isAbsolute(project)) return null
  const hit = cache.get(project)
  if (!hit || Date.now() - hit.at >= TTL) void gitRefresh(project)
  return hit ? hit.value : null
}
