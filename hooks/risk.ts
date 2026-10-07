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

  if (tool.startsWith('mcp__') && SEND_TOOL.test(tool.split('__').pop() ?? '')) {
    return { category: 'external-send', risk: 'medium', policy: 'ask', reason: 'sends to an external system' }
  }

  return { category: 'other', ...LOW }
}

// Asked even under the permissive profile.
const ALWAYS_ASK = new Set(['secret-output', 'secret-file', 'guard-policy'])

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
