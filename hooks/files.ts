import type { ContextPin, FileCategory, Observed } from '../types'

const RULES: readonly { category: FileCategory; pattern: RegExp }[] = [
  { category: 'secret', pattern: /(^|\/)(\.env(\.[^/]*)?|\.npmrc|\.netrc|credentials(\.json)?|id_rsa[^/]*|[^/]*\.(pem|key|p12))$/ },
  {
    category: 'generated',
    pattern: /(^|\/)(dist|build|out|coverage|node_modules|\.next|target|vendor)\/|(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Cargo\.lock|poetry\.lock|go\.sum)$|\.min\.(js|css)$|\.map$/,
  },
  {
    category: 'test',
    pattern: /(^|\/)(tests?|__tests__|spec|e2e)\/|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py)$|(^|\/)test_[^/]*\.py$|Test\.(java|kt|cs)$/,
  },
  { category: 'docs', pattern: /(^|\/)docs?\/|\.(md|mdx|rst|txt|adoc)$|(^|\/)(LICENSE|CHANGELOG)[^/]*$/i },
  {
    category: 'config',
    pattern: /(^|\/)(package\.json|tsconfig[^/]*\.json|Dockerfile|Makefile|\.gitignore|\.editorconfig|CLAUDE\.md)$|(^|\/)\.(github|claude|vscode|husky)\/|\.config\.[cm]?[jt]s$|\.(ya?ml|toml|ini|cfg|conf|properties)$|(^|\/)\.[^/]*rc(\.json|\.js)?$/,
  },
]

export function categoryOf(path: string): FileCategory {
  return RULES.find(rule => rule.pattern.test(path))?.category ?? 'source'
}

// Edits to these do not make a passing check stale.
export function affectsChecks(path: string): boolean {
  const category = categoryOf(path)

  return category !== 'docs' && category !== 'generated'
}

const WORTH_PINNING = new Set<FileCategory>(['source', 'test', 'config'])

// Files the work keeps coming back to: edited, or read at least twice; never secrets,
// generated files, what is already pinned, or what the person hid.
export function suggestionsOf(observed: readonly Observed[], pins: readonly ContextPin[], excluded: readonly string[]): Observed[] {
  const pinned = new Set(pins.flatMap(one => (one.kind === 'file' && !one.lines ? [one.path] : [])))
  const hidden = new Set(excluded)

  return observed
    .filter(one => !pinned.has(one.path) && !hidden.has(one.path) && WORTH_PINNING.has(categoryOf(one.path)))
    .filter(one => one.how === 'edited' || (one.count ?? 1) >= 2)
    .sort((a, b) => (b.how === 'edited' ? 1 : 0) - (a.how === 'edited' ? 1 : 0) || (b.count ?? 1) - (a.count ?? 1))
    .slice(0, 5)
}
