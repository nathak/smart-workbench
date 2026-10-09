import type { AuditConfig, EvidenceKind, GuardProfile, Policy, ProjectPolicy, ProjectRule, TeamTemplate } from '../types'
import type { Verdict } from './risk'

export const POLICY_PATH = '.claude/smartworkbench.json'
export const AUDIT_PATH = '.claude/smartworkbench-audit.jsonl'

const KINDS: readonly EvidenceKind[] = ['test', 'build', 'typecheck', 'lint', 'ci']

const PROFILES: readonly GuardProfile[] = ['permissive', 'balanced', 'strict']
const POLICIES: readonly Policy[] = ['allow', 'ask', 'block']
const RANK: Record<Policy, number> = { allow: 0, ask: 1, block: 2 }

export const POLICY_TEMPLATE = `${JSON.stringify(
  {
    profile: 'balanced',
    rules: [
      { tool: 'Bash', command: '\\\\bterraform\\\\s+apply\\\\b', policy: 'block', reason: 'infrastructure changes go through CI' },
      { tool: 'Edit|Write', path: 'migrations/**', policy: 'ask', reason: 'schema migrations need review' },
      { tool: 'Bash', command: '\\\\bnpm\\\\s+run\\\\s+deploy\\\\b', policy: 'block', reason: 'deploys run from CI only' },
    ],
    defaultTemplate: 'change',
    templates: {
      change: {
        constraints: ['Keep the public API compatible', 's: Keep the patch minimal'],
        doneConditions: [{ text: 'Related tests pass', link: 'test' }, { text: 'Typecheck passes', link: 'typecheck' }, { text: 'CI is green', link: 'ci' }],
      },
    },
    audit: true,
  },
  null,
  2,
)}\n`

// "src/**/*.ts", "migrations/**", "*.lock": ** crosses folders, * and ? stay inside one.
export function globToRegExp(glob: string): RegExp {
  let out = ''
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i] ?? ''
    if (char === '*' && glob[i + 1] === '*') {
      out += glob[i + 2] === '/' ? '(?:.*/)?' : '.*'
      i += glob[i + 2] === '/' ? 2 : 1
    } else if (char === '*') {
      out += '[^/]*'
    } else if (char === '?') {
      out += '[^/]'
    } else {
      out += char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }

  return new RegExp(`^${out}$`)
}

function isRegExp(source: string): boolean {
  try {
    new RegExp(source)
    return true
  } catch {
    return false
  }
}

// Reads the checked-in file; a broken rule is reported and skipped, never guessed at.
export function parsePolicy(text: string, source: string = POLICY_PATH): ProjectPolicy {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    return { source, rules: [], templates: [], errors: [`not valid JSON: ${error instanceof Error ? error.message : String(error)}`] }
  }

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { source, rules: [], templates: [], errors: ['expected an object with "profile" and "rules"'] }
  }

  const value = raw as { profile?: unknown; rules?: unknown }
  const errors: string[] = []
  const profile = PROFILES.find(one => one === value.profile)
  if (value.profile !== undefined && profile === undefined) {
    errors.push(`profile must be one of ${PROFILES.join(', ')}`)
  }

  const rules: ProjectRule[] = []
  const list = Array.isArray(value.rules) ? value.rules : []
  if (value.rules !== undefined && !Array.isArray(value.rules)) {
    errors.push('rules must be a list')
  }

  list.forEach((item, i) => {
    const rule = (item ?? {}) as Record<string, unknown>
    const policy = POLICIES.find(one => one === rule.policy)
    const strings = ['tool', 'command', 'path', 'reason'].every(key => rule[key] === undefined || typeof rule[key] === 'string')

    if (!policy || !strings) {
      errors.push(`rule ${i + 1}: needs "policy" (allow|ask|block) and string fields`)
      return
    }
    if (rule.tool === undefined && rule.command === undefined && rule.path === undefined) {
      errors.push(`rule ${i + 1}: needs at least one of "tool", "command", "path"`)
      return
    }
    const bad = (['tool', 'command'] as const).find(key => typeof rule[key] === 'string' && !isRegExp(rule[key] as string))
    if (bad) {
      errors.push(`rule ${i + 1}: "${bad}" is not a valid regular expression`)
      return
    }
    rules.push({
      policy,
      ...(typeof rule.tool === 'string' ? { tool: rule.tool } : {}),
      ...(typeof rule.command === 'string' ? { command: rule.command } : {}),
      ...(typeof rule.path === 'string' ? { path: rule.path } : {}),
      ...(typeof rule.reason === 'string' ? { reason: rule.reason } : {}),
    })
  })

  const templates = parseTemplates((value as { templates?: unknown }).templates, errors)
  const defaultTemplate = (value as { defaultTemplate?: unknown }).defaultTemplate
  if (defaultTemplate !== undefined && !templates.some(one => one.name === defaultTemplate)) {
    errors.push(`defaultTemplate "${String(defaultTemplate)}" is not one of the templates`)
  }
  const audit = parseAudit((value as { audit?: unknown }).audit, errors)
  const requireContract = (value as { requireContract?: unknown }).requireContract
  if (requireContract !== undefined && typeof requireContract !== 'boolean') {
    errors.push('requireContract must be true or false')
  }

  return {
    source,
    ...(profile ? { profile } : {}),
    rules,
    templates,
    ...(typeof defaultTemplate === 'string' && templates.some(one => one.name === defaultTemplate) ? { defaultTemplate } : {}),
    ...(audit ? { audit } : {}),
    ...(requireContract === true ? { requireContract: true } : {}),
    errors,
  }
}

// "templates": { "bugfix": { "goal"?, "constraints": ["...", "s: ..."], "nonGoals": [], "doneConditions": ["...", { "text", "link" }] } }
function parseTemplates(raw: unknown, errors: string[]): TeamTemplate[] {
  if (raw === undefined) return []
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    errors.push('templates must be an object of named templates')
    return []
  }

  const out: TeamTemplate[] = []
  for (const [name, body] of Object.entries(raw)) {
    const value = (body ?? {}) as Record<string, unknown>
    const list = (key: string): unknown[] => (Array.isArray(value[key]) ? (value[key] as unknown[]) : [])
    const constraints = list('constraints').flatMap(one => {
      if (typeof one !== 'string' || one.trim() === '') return []
      const soft = /^\s*s\s*:/i.test(one)
      return [{ text: one.replace(/^\s*[hs]\s*:\s*/i, '').trim(), priority: soft ? ('soft' as const) : ('hard' as const) }]
    })
    const doneConditions = list('doneConditions').flatMap(one => {
      if (typeof one === 'string' && one.trim() !== '') return [{ text: one.trim() }]
      const item = (one ?? {}) as { text?: unknown; link?: unknown }
      if (typeof item.text !== 'string' || item.text.trim() === '') return []
      const link = KINDS.find(kind => kind === item.link)
      return [{ text: item.text.trim(), ...(link ? { link } : {}) }]
    })
    const nonGoals = list('nonGoals').filter((one): one is string => typeof one === 'string' && one.trim() !== '')

    if (doneConditions.length === 0 && constraints.length === 0) {
      errors.push(`template "${name}": needs constraints or doneConditions`)
      continue
    }
    out.push({ name, ...(typeof value.goal === 'string' ? { goal: value.goal } : {}), constraints, nonGoals, doneConditions })
  }

  return out
}

// "audit": true for the default file, or { "path": "logs/agent-audit.jsonl" } inside the repository.
function parseAudit(raw: unknown, errors: string[]): AuditConfig | undefined {
  if (raw === undefined || raw === false) return undefined
  if (raw === true) return { path: AUDIT_PATH }

  const path = (raw as { path?: unknown } | null)?.path
  if (typeof path !== 'string' || path.trim() === '' || path.startsWith('/') || path.split('/').includes('..')) {
    errors.push('audit must be true or { "path": "<relative path inside the repository>" }')
    return undefined
  }

  return { path: path.trim() }
}

function relative(path: string, cwd: string): string {
  return path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path.replace(/^\.\//, '')
}

export function matchRule(rules: readonly ProjectRule[], tool: string, input: unknown, cwd: string): ProjectRule | undefined {
  const args = (input ?? {}) as Record<string, unknown>
  const command = typeof args.command === 'string' ? args.command : undefined
  const rawPath = args.file_path ?? args.notebook_path ?? args.path
  const path = typeof rawPath === 'string' ? relative(rawPath, cwd) : undefined

  return rules.find(rule => {
    if (rule.tool !== undefined && !new RegExp(`^(?:${rule.tool})$`).test(tool)) return false
    if (rule.command !== undefined && (command === undefined || !new RegExp(rule.command).test(command))) return false
    if (rule.path !== undefined && (path === undefined || !globToRegExp(rule.path).test(path))) return false

    return true
  })
}

// Built-in checks a checked-in file may tighten but never relax.
const UNRELAXABLE = new Set(['secret-output', 'secret-file', 'guard-policy'])

// A project rule may tighten anything, but cannot loosen a built-in block or a protected check.
export function applyRule(builtIn: Verdict, rule: ProjectRule | undefined): Verdict {
  if (!rule) {
    return builtIn
  }
  const loosens = RANK[rule.policy] < RANK[builtIn.policy]
  if (loosens && (builtIn.policy === 'block' || UNRELAXABLE.has(builtIn.category))) {
    return builtIn
  }
  const risk = rule.policy === 'block' ? 'high' : rule.policy === 'ask' && builtIn.risk === 'low' ? 'medium' : builtIn.risk

  return {
    category: 'project-rule',
    risk,
    policy: rule.policy,
    reason: rule.reason ?? (rule.policy === 'allow' ? 'allowed by project rule' : `project rule (${POLICY_PATH})`),
  }
}
