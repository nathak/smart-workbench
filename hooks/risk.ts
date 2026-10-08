import type { GuardProfile, Policy, Risk } from '../types'

export type Verdict = {
  category: string
  risk: Risk
  policy: Policy
  reason: string
}

type Rule = { category: string; risk: Risk; policy: Policy; pattern: RegExp; reason: string }

// Checked in order; the first match decides. Regexes are a workflow guard, not a sandbox.
const BASH_RULES: readonly Rule[] = [
  {
    category: 'destructive-git',
    risk: 'high',
    policy: 'block',
    pattern: /\bgit\s+push\b[^;&|]*(\s--force\b|\s-f\b|\s--force-with-lease\b|\s\+\S)/,
    reason: 'force push rewrites remote history',
  },
  {
    category: 'destructive-git',
    risk: 'high',
    policy: 'block',
    pattern: /\bgit\s+(reset\s+[^;&|]*--hard|clean\s+[^;&|]*-[a-z]*f|checkout\s+[^;&|]*--\s+\.|branch\s+[^;&|]*-D\b)/,
    reason: 'destructive git command discards work',
  },
  {
    category: 'broad-delete',
    risk: 'high',
    policy: 'block',
    pattern: /(^|[;&|(]\s*|\s)(sudo\s+)?rm\s+(-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)\b|\bfind\b[^;&|]*\s-delete\b/,
    reason: 'recursive delete',
  },
  {
    category: 'guard-policy',
    risk: 'medium',
    policy: 'ask',
    pattern: /\.claude\/smartworkbench\.json[^;&|]*(>|\|\s*tee\b)|(\btee\b|\bsed\s+-i\b|\brm\b|\bmv\b|\bcp\b|>)[^;&|]*\.claude\/smartworkbench\.json/,
    reason: 'changes the project guard policy',
  },
  {
    category: 'secret-output',
    risk: 'medium',
    policy: 'ask',
    pattern: /(^|[;&|]\s*)(env|printenv|set)\s*($|[;&|])|\b(cat|less|head|tail|grep)\b[^;&|]*(\.env\b|credentials|\.npmrc|\.netrc|id_rsa|\.pem\b)|\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD)\w*|\bgh\s+auth\s+token\b/i,
    reason: 'may print secrets',
  },
  {
    category: 'external-send',
    risk: 'medium',
    policy: 'ask',
    pattern: /\bgit\s+push\b|\bgh\s+(pr\s+(create|merge)|release|issue\s+(create|comment)|api\s+[^;&|]*-X\s*(POST|PUT|PATCH|DELETE))|\b(npm|pnpm|yarn|cargo)\s+publish\b|\bcurl\b[^;&|]*(\s-X\s*(POST|PUT|PATCH|DELETE)|\s(-d|--data|-F|--form)\b)|\b(scp|sftp)\b|\brsync\b[^;&|]*\S+:|\bkubectl\s+(apply|delete)|\b(vercel|netlify|fly|firebase)\s+deploy|\bdeploy\b/,
    reason: 'sends to an external system',
  },
]

const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'NotebookRead', 'WebSearch', 'WebFetch', 'ToolSearch', 'TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet'])
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const SECRET_PATH = /(^|\/)(\.env(\.[^/]*)?|\.npmrc|\.netrc|credentials(\.json)?|id_rsa[^/]*|[^/]*\.pem)$/
const GUARD_FILE = /(^|\/)\.claude\/smartworkbench\.json$/
const SEND_TOOL = /(^|_)(send|post|publish|deploy|create_pr|create_pull_request|share|comment|reply|message)/i

// MCP tools by what they touch, from the server and tool names: deploys and anything that
// changes an issue or an alert are asked; reads are allowed.
const MCP_DEPLOY = /deploy|release|rollout|rollback|promote|publish/i
const MCP_ISSUE = /issue|ticket|jira|linear|task|story|bug/i
const MCP_OBSERVE = /log|metric|trace|alert|incident|monitor|sentry|datadog|grafana|honeycomb|pagerduty|newrelic/i
const MCP_CHANGE = /(^|_)(create|update|edit|close|delete|remove|transition|assign|comment|resolve|ack|acknowledge|mute|silence|trigger|set|add)/i

export function classifyMcp(tool: string): Verdict {
  const [, server = '', name = ''] = tool.split('__')
  const both = `${server}__${name}`
  const changes = MCP_CHANGE.test(name)

  if (MCP_DEPLOY.test(name)) {
    return { category: 'mcp-deploy', risk: 'high', policy: 'ask', reason: 'deploys or releases through MCP' }
  }
  if (MCP_ISSUE.test(both)) {
    return changes
      ? { category: 'mcp-issue', risk: 'medium', policy: 'ask', reason: 'changes an issue tracker' }
      : { category: 'mcp-issue', risk: 'low', policy: 'allow', reason: '' }
  }
  if (MCP_OBSERVE.test(both)) {
    return changes
      ? { category: 'mcp-observe', risk: 'medium', policy: 'ask', reason: 'changes alerts or incidents' }
      : { category: 'mcp-observe', risk: 'low', policy: 'allow', reason: '' }
  }
  if (SEND_TOOL.test(name)) {
    return { category: 'external-send', risk: 'medium', policy: 'ask', reason: 'sends to an external system' }
  }

  return { category: 'mcp', risk: 'low', policy: 'allow', reason: '' }
}

const LOW: Omit<Verdict, 'category'> = { risk: 'low', policy: 'allow', reason: '' }

export function classify(tool: string, input: unknown): Verdict {
  const args = (input ?? {}) as Record<string, unknown>

  if (tool === 'Bash') {
    const command = String(args.command ?? '')
    const rule = BASH_RULES.find(one => one.pattern.test(command))

    return rule
      ? { category: rule.category, risk: rule.risk, policy: rule.policy, reason: rule.reason }
      : { category: 'shell', ...LOW }
  }

  if (EDIT_TOOLS.has(tool)) {
    const path = String(args.file_path ?? args.notebook_path ?? '')

    if (GUARD_FILE.test(path)) {
      return { category: 'guard-policy', risk: 'medium', policy: 'ask', reason: 'changes the project guard policy' }
    }

    return SECRET_PATH.test(path)
      ? { category: 'secret-file', risk: 'medium', policy: 'ask', reason: 'edits a secrets file' }
      : { category: 'workspace-edit', risk: 'medium', policy: 'allow', reason: '' }
  }

  if (READ_TOOLS.has(tool)) {
    const path = String(args.file_path ?? '')

    return tool === 'Read' && SECRET_PATH.test(path)
      ? { category: 'secret-output', risk: 'medium', policy: 'ask', reason: 'reads a secrets file' }
      : { category: 'read', ...LOW }
  }

  if (tool.startsWith('mcp__')) {
    return classifyMcp(tool)
  }

  return { category: 'other', ...LOW }
}

// Asked even under the permissive profile.
const ALWAYS_ASK = new Set(['secret-output', 'secret-file', 'guard-policy', 'mcp-deploy'])

// Applies the profile and the pause switch on top of the default (balanced) rule set.
export function decide(verdict: Verdict, profile: GuardProfile, isPaused: boolean): Policy {
  if (verdict.policy === 'block') {
    return 'block'
  }

  if (isPaused && verdict.risk !== 'low') {
    return 'ask'
  }

  if (profile === 'strict' && verdict.risk === 'medium') {
    return 'ask'
  }

  if (profile === 'permissive' && verdict.policy === 'ask' && !ALWAYS_ASK.has(verdict.category)) {
    return 'allow'
  }

  return verdict.policy
}

export function summarize(tool: string, input: unknown): string {
  const args = (input ?? {}) as Record<string, unknown>
  const text =
    args.command ?? args.file_path ?? args.notebook_path ?? args.pattern ?? args.url ?? args.query ?? args.description ?? ''

  return String(text).replace(/\s+/g, ' ').trim().slice(0, 120)
}

// ---- "Allow for session"

// Commands whose meaning sits in two subcommand words (gh pr create, kubectl rollout restart).
const TWO_WORDS = new Set(['gh', 'kubectl', 'docker', 'aws', 'gcloud', 'az', 'helm', 'fly', 'vercel', 'firebase'])
const WRAPPERS = new Set(['sudo', 'env', 'command', 'nohup', 'time', 'exec'])

// "FOO=1 sudo git push origin main" → "git push"; flags and later arguments are dropped.
export function commandPrefix(segment: string): string | undefined {
  const words = segment.trim().split(/\s+/).filter(Boolean)
  while (words.length > 0 && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0] ?? '') || WRAPPERS.has(words[0] ?? ''))) {
    words.shift()
  }
  const [command, ...rest] = words
  if (!command) return undefined

  const subcommands = rest.filter(word => !word.startsWith('-')).slice(0, TWO_WORDS.has(command) ? 2 : 1)

  return [command, ...subcommands].join(' ')
}

export function splitCommand(command: string): string[] {
  return command
    .split(/&&|\|\||[;|\n]/)
    .map(one => one.trim())
    .filter(Boolean)
}

export type SessionScope = { key: string; label: string }

// What one "Allow for session" answer covers. A chain is covered only as the same set of
// commands, so `git push && curl ...` is asked again after allowing `git push`.
// The guard file's own protection is never allowed for a session.
export function sessionScope(tool: string, input: unknown, verdict: Verdict): SessionScope | undefined {
  if (verdict.category === 'guard-policy' || verdict.policy === 'block') {
    return undefined
  }
  const args = (input ?? {}) as Record<string, unknown>

  if (tool === 'Bash') {
    const prefixes = splitCommand(String(args.command ?? '')).map(commandPrefix)
    if (prefixes.length === 0 || prefixes.some(one => one === undefined)) return undefined
    const unique = [...new Set(prefixes as string[])].sort()

    return { key: `bash:${unique.join(' && ')}`, label: unique.join(' && ') }
  }

  const path = args.file_path ?? args.notebook_path
  if (typeof path === 'string' && path !== '') {
    const kind = EDIT_TOOLS.has(tool) ? 'edit' : tool.toLowerCase()
    return { key: `${kind}:${path}`, label: `${EDIT_TOOLS.has(tool) ? 'edits of' : tool} ${path}` }
  }

  return { key: `tool:${tool}`, label: tool }
}
