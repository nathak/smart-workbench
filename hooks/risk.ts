import type { GuardProfile, Policy, Risk } from '../types'

export type Verdict = {
  category: string
  risk: Risk
  policy: Policy
  reason: string
}

const re = (source: string, flags = ''): RegExp => new RegExp(source, flags)

// git with its global options skipped (git -C dir push, git -c k=v reset). A value never starts with "-" and every dash
// word has one reading, so the pattern cannot backtrack exponentially.
const GIT = String.raw`\bgit(?:\s+(?:-[Cc]\s+[^\s-]\S*|--(?:git-dir|work-tree|namespace|exec-path|super-prefix|config-env)\s+[^\s-]\S*|-[\w-]*(?:=\S*)?))*\s+`
// Where a command can start: after whitespace, a separator, a quote or a path (/bin/rm, \rm).
const AT = String.raw`(?:^|[\s;&|(\`"'/\\])`
// Any arguments before the one we look for, within the same simple command.
const ARGS = String.raw`(?:[^;&|\n]*\s)?`
const WORD_END = String.raw`(?=$|[\s;&|)])`
const SECRET_NAME = String.raw`(?:\w*(?:TOKEN|SECRET|PASSWORD|PASSWD)|(?:\w*_)?(?:API_?)?KEY)`

type Rule = { category: string; risk: Risk; policy: Policy; pattern: RegExp; reason: string; raw?: true }

// Checked in order; the first match decides. Regexes are a workflow guard, not a sandbox.
// A rule marked raw reads the command as typed; the others read it with message and search text blanked (see maskData).
const BASH_RULES: readonly Rule[] = [
  {
    category: 'destructive-git',
    risk: 'high',
    policy: 'block',
    pattern: re(String.raw`${GIT}push\b[^;&|\n]*(\s--force\b|\s-[a-zA-Z]*f|\s--force-with-lease\b|\s\+\S)`),
    reason: 'force push rewrites remote history',
  },
  {
    category: 'destructive-git',
    risk: 'high',
    policy: 'block',
    pattern: re(
      String.raw`${GIT}(?:reset\s+[^;&|\n]*--hard|clean\s+[^;&|\n]*-[a-z]*f|checkout\s+[^;&|\n]*--\s+\.|checkout\s+${ARGS}(?:\.|:\/)${WORD_END}|restore\s+(?!${ARGS}(?:--staged\b|-[a-zA-Z]*S))${ARGS}(?:\.|:\/)${WORD_END}|stash\s+clear\b|branch\s+(?:${ARGS}-[a-zA-Z]*D|(?=${ARGS}(?:--delete\b|-[a-zA-Z]*d))(?=${ARGS}(?:--force\b|-[a-zA-Z]*f))))`,
    ),
    reason: 'destructive git command discards work',
  },
  {
    category: 'broad-delete',
    risk: 'high',
    policy: 'block',
    pattern: re(String.raw`${AT}rm\s+${ARGS}(?:-[a-zA-Z]*[rR]|--recursive\b)|\bfind\b[^;&|\n]*\s-delete\b`),
    reason: 'recursive delete',
  },
  {
    category: 'device-write',
    risk: 'high',
    policy: 'block',
    pattern: re(
      String.raw`${AT}dd\s[^;&|\n]*\bof=\/dev\/(?!null\b|zero\b|stdout\b|stderr\b|tty\b|fd\/|shm\/)|${AT}mkfs(?:\.\w+)?\s+\S|>\s*\/dev\/(?:sd[a-z]|hd[a-z]|vd[a-z]|xvd[a-z]|nvme\d|mmcblk\d|disk\d)`,
    ),
    reason: 'overwrites a disk or device',
  },
  {
    category: 'remote-exec',
    risk: 'high',
    policy: 'ask',
    pattern: re(
      String.raw`\b(?:curl|wget)\b[^;&\n]*\|\s*(?:sudo\s+(?:-\S+\s+)*)?(?:ba|z|da|k)?sh\b|\b(?:(?:ba|z|da|k)?sh\s+(?:-\S+\s+)*|eval\s+)["']?(?:\$\(|<\()\s*(?:curl|wget)\b|(?:\bsource|${AT}\.)\s+<\(\s*(?:curl|wget)\b`,
    ),
    reason: 'runs a script downloaded from the network',
  },
  {
    category: 'guard-policy',
    risk: 'medium',
    policy: 'ask',
    raw: true,
    pattern: /\.claude\/smartworkbench\.json[^;&|\n]*(>|\|\s*tee\b)|(\btee\b|\bsed\s+-i\b|\brm\b|\bmv\b|\bcp\b|>)[^;&|\n]*\.claude\/smartworkbench\.json/,
    reason: 'changes the project guard policy',
  },
  {
    category: 'secret-output',
    risk: 'medium',
    policy: 'ask',
    raw: true,
    pattern: re(
      String.raw`(^|[;&|]\s*)(env|printenv|set)\s*($|[;&|])|\b(cat|less|head|tail|grep)\b[^;&|\n]*((^|[^\w.])\.env(?!\.(example|sample|template)\b)(\.[\w-]+)?(?=$|[^\w-])|credentials|\.npmrc|\.netrc|id_rsa|\.pem\b)|\$\{?${SECRET_NAME}|\bprintenv\s+(?:-\S+\s+)*${SECRET_NAME}|\bgh\s+auth\s+token\b`,
      'i',
    ),
    reason: 'may print secrets',
  },
  {
    category: 'external-send',
    risk: 'medium',
    policy: 'ask',
    pattern: re(
      String.raw`${GIT}push\b|\bgh\s+(pr\s+(create|merge)|release|issue\s+(create|comment)|api\s+[^;&|\n]*-X\s*(POST|PUT|PATCH|DELETE))|\b(npm|pnpm|yarn|cargo)\s+publish\b|\bcurl\b[^;&|\n]*(\s-X\s*(POST|PUT|PATCH|DELETE)|\s(-d|--data|-F|--form)\b)|\b(scp|sftp)\b|\brsync\b[^;&|\n]*\S+:|\bkubectl\s+(apply|delete)|\b(vercel|netlify|fly|firebase)\s+deploy|\b(?:docker|podman)\s+(?:image\s+)?push\b|\bdocker\s+buildx\s+build\b[^;&|\n]*\s--push\b|\b(?:terraform|tofu)(?:\s+-\S+)*\s+(?:apply|destroy)\b|\bpulumi\s+(?:up|destroy)\b|(^|[;&|(\`]\s*|\$\()((sudo|env|time|exec|xargs|nohup|bash|sh|zsh|node|python3?|ruby|npx|make|(npm|pnpm|yarn|bun)(\s+run)?)\s+)*[\w./-]*deploy[\w.-]*(\s|$)`,
    ),
    reason: 'sends to an external system',
  },
]

// Quoted text that is data, not a command, is blanked before the rules read it: the value of a message flag
// (git commit -m "..."), the pattern of a search (grep "rm -rf") and the body of a cat heredoc commit message.
// Every other quote keeps its content, so bash -c "...", eval, ssh host "..." and the like are still read.
const QUOTED = /\\[\s\S]|'[^']*'|"(?:[^"\\]|\\[\s\S])*"/g
const DATA_FLAG = /(?:^|\s)(?:-[a-zA-Z]*m|--(?:message|title|body|notes|subject|grep))=?$/
const SEARCH = /^\s*(?:\S*\/)?(?:[ef]?grep|rg|ag|ack)\s|^\s*git\b.*\sgrep\s/
// A message flag is read as data only for git and gh; a search that can run a program (rg --pre) keeps its quotes read.
const GIT_OR_GH = /^\s*(?:\S*\/)?(?:git|gh)\b/
// A search keeps a quoted pattern as data only when every option on its command is a known harmless one, so an option that
// runs a program (rg --pre, git grep -O) or an abbreviation of one keeps the quotes read. Options after the quote count too.
const SAFE_SHORT = /^-[inwFEPelrRHhcvsqxogtABC]+$/
const SAFE_LONG = /^--(?:$|(?:regexp|ignore-case|recursive|line-number|word-regexp|fixed-strings|extended-regexp|perl-regexp|count|files-with-matches|include|exclude|exclude-dir|glob|type|hidden|no-ignore|context|after-context|before-context|only-matching|invert-match|with-filename|no-filename)(?:=\S*)?$)/

function hasOnlySafeOptions(words: string): boolean {
  return words
    .replace(QUOTED, ' ')
    .split(/\s+/)
    .filter(word => word.startsWith('-') && word !== '-')
    .every(word => SAFE_SHORT.test(word) || SAFE_LONG.test(word))
}
const RUNNER = /\b(?:(?:ba|z|da|k)?sh|su|eval|ssh)\b/

// "$(cat <<'EOF' ... EOF ... )": only the heredoc body, with nothing but the closing ")" after it.
function isCatHeredoc(inner: string): boolean {
  const head = /^\$\(\s*cat\s+<<-?[ \t]*(['"])(\w+)\1[ \t]*\n/.exec(inner)
  if (!head) return false
  const lines = inner.slice(head[0].length).split('\n')
  const end = lines.findIndex(line => line.trim() === head[2])
  return end >= 0 && lines.slice(end + 1).join('\n').trim() === ')'
}

function maskData(command: string): string {
  return command.replace(QUOTED, (match: string, offset: number) => {
    if (match[0] === '\\') return match
    const inner = match.slice(1, -1)
    const isPlain = !inner.includes('\n') && !(match[0] === '"' && /\$\(|`/.test(inner))
    if (!isPlain && !(match[0] === '"' && isCatHeredoc(inner))) return match
    const before = command.slice(Math.max(0, offset - 256), offset)
    const segment = before.slice(Math.max(...[';', '&', '|', '\n'].map(one => before.lastIndexOf(one))) + 1)
    if (RUNNER.test(segment)) return match
    const isMessage = GIT_OR_GH.test(segment) && DATA_FLAG.test(before.trimEnd())
    if (isMessage) return match[0] + match[0]
    // Only a bounded stretch after the quote is checked; a longer one is treated as unsafe, not skipped.
    const after = command.slice(offset + match.length, offset + match.length + 257).split(/[;&|\n]/)[0] ?? ''
    return after.length <= 256 && SEARCH.test(segment) && hasOnlySafeOptions(segment + ' ' + after) ? match[0] + match[0] : match
  })
}

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
    // A backslash before a newline continues the command, as in bash; join it so a rule still reads one line.
    const command = String(args.command ?? '').replace(/\\\r?\n/g, ' ')
    const data = maskData(command)
    const rule = BASH_RULES.find(one => one.pattern.test(one.raw ? command : data))

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
const ALWAYS_ASK = new Set(['secret-output', 'secret-file', 'guard-policy', 'mcp-deploy', 'remote-exec'])

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
