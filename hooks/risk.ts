import type { GuardProfile, Policy, Risk } from '../types'
import { workflowLabel } from './workflow'

export type Verdict = {
  category: string
  risk: Risk
  policy: Policy
  reason: string
}

const re = (source: string, flags = ''): RegExp => new RegExp(source, flags)

// git with its global options skipped (git -C dir push, git -c k=v reset). A value never starts with "-" and every dash
// word has one reading, so the pattern cannot backtrack exponentially.
const GIT_VALUE = String.raw`(?:"[^"]*"|'[^']*'|(?:\\.|[^\s"'\\-])(?:\\.|[^\s\\])*)`
const GIT = String.raw`\bgit(?:\s+(?:-[Cc]\s+${GIT_VALUE}|--(?:git-dir|work-tree|namespace|exec-path|super-prefix|config-env)\s+${GIT_VALUE}|-[\w-]*(?:=\S*)?))*\s+`
// Where a command can start: after whitespace, a separator, a quote or a path (/bin/rm, \rm).
const AT = String.raw`(?:^|[\s;&|(\`"'/\\])`
// Any arguments before the one we look for, within the same simple command.
const ARGS = String.raw`(?:[^;&|\n]*\s)?`
// Like ARGS, but it stops at a command substitution, whose own flags are not the outer command's.
const FLAT_ARGS = String.raw`(?:(?:[^;&|\n(\`]|(?<!\$)\()*\s)?`
const WORD_END = String.raw`(?=$|[\s;&|)])`
// A lone "." (the whole tree) or the repository root, with or without quotes.
const WHOLE_TREE = String.raw`(?:["']?\.(?:\/+\.?)*\/*["']?|["']?:\/["']?)`
// Where a command word can stand: at the start, after a separator, or after a wrapper such as sudo; with or without a path.
const CMD = String.raw`(?:^|[;&|(\`]\s*|\b(?:sudo|exec|nohup|time|env)\s+(?:-\S+\s+)*)(?:\S*\/)?`
const SECRET_NAME = String.raw`(?:\w*(?:TOKEN|SECRET|PASSWORD|PASSWD)|(?:\w*_)?(?:API_?)?KEY)`

// Hides what looks like a secret in text that leaves for the live feed. A heuristic, not a guarantee: a value under a name that
// does not look secret (DB=xyz) and a bare pasted token without a known prefix stay visible.
export function redact(text: string): string {
  return text
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g, '[private key]')
    .replace(/(\b[a-z][\w+.-]{0,31}:\/\/)[^\s/:@]+:[^\s/]+@/gi, '$1***@')
    // The token must hold a digit, so "Basic authentication" stays and "Bearer abc123xyz9" does not.
    .replace(/\b(Bearer|Basic)\s+(?=[A-Za-z0-9._~+/=-]*\d)[A-Za-z0-9._~+/=-]{8,}/gi, '$1 ***')
    .replace(
      /\b(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}|(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|npm_[A-Za-z0-9]{30,}|hf_[A-Za-z0-9]{30,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/g,
      '***',
    )
    // The name may be quoted, as in JSON: "api_key": "abc".
    .replace(new RegExp(String.raw`\b(${SECRET_NAME})(["']?\s*[:=]\s*)("[^"\n]*"|'[^'\n]*'|[^\s,;]+)`, 'gi'), '$1$2***')
    // A flag that carries the secret as the next word: --password hunter2, --token=abc.
    .replace(/(\s--?(?:password|passwd|pass|token|secret|api-?key|auth)(?:\s+|=))("[^"\n]*"|'[^'\n]*'|[^\s;|&]+)/gi, '$1***')
}

// stripped: also read the command with its command substitutions removed, so "rm $(x) -rf d" is seen while the flags
// inside "rm -f $(ls -tr)" are not taken for rm's own.
type Rule = { category: string; risk: Risk; policy: Policy; pattern: RegExp; reason: string; raw?: true; stripped?: true }

function withoutSubstitutions(text: string): string {
  let out = text
  for (let i = 0; i < 4; i++) {
    const next = out.replace(/\$\([^()]*\)|`[^`]*`/g, ' ')
    if (next === out) break
    out = next
  }
  return out
}

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
      String.raw`${GIT}(?:reset\s+[^;&|\n]*--hard|checkout\s+${ARGS}(?:-[a-zA-Z]*f\b|--force\b)|switch\s+${ARGS}(?:--discard-changes\b|-[a-zA-Z]*f\b)|clean\s+[^;&|\n]*-[a-z]*f|checkout\s+[^;&|\n]*--\s+${WHOLE_TREE}${WORD_END}|checkout\s+${ARGS}${WHOLE_TREE}${WORD_END}|restore\s+(?!(?=${ARGS}(?:--staged\b|-[a-zA-Z]*S))(?!${ARGS}(?:--worktree\b|-[a-zA-Z]*W)))${ARGS}${WHOLE_TREE}${WORD_END}|stash\s+clear\b|branch\s+(?:${ARGS}-[a-zA-Z]*D|(?=${ARGS}(?:--delete\b|-[a-zA-Z]*d))(?=${ARGS}(?:--force\b|-[a-zA-Z]*f))))`,
    ),
    reason: 'destructive git command discards work',
  },
  {
    category: 'broad-delete',
    risk: 'high',
    policy: 'block',
    stripped: true,
    pattern: re(String.raw`${AT}(?<!\bgit[ \t]+)rm["']?\s+${FLAT_ARGS}(?:-[a-zA-Z]*[rR]|--recursive\b)|\bfind\b[^;&|\n]*\s-delete\b`),
    reason: 'recursive delete',
  },
  {
    category: 'device-write',
    risk: 'high',
    policy: 'block',
    pattern: re(
      String.raw`${AT}dd\s[^;&|\n]*\bof=\/dev\/(?!null\b|zero\b|stdout\b|stderr\b|tty\b|fd\/|shm\/)|${CMD}mkfs(?:\.\w+)?\s+(?!(?:-h|--help|-V|--version)(?:\s|$))[^\s;&|]|>\s*\/dev\/(?:sd[a-z]|hd[a-z]|vd[a-z]|xvd[a-z]|nvme\d|mmcblk\d|disk\d)`,
    ),
    reason: 'overwrites a disk or device',
  },
  {
    category: 'remote-exec',
    risk: 'high',
    policy: 'ask',
    pattern: re(
      String.raw`\b(?:curl|wget)\b[^;\n]*\|\s*(?:(?:sudo|env|exec|command)\s+(?:-\S+(?:\s+[^\s|;&-]\S*)?\s+)*)?(?:\S*\/)?(?:(?:ba|z|da|k)?sh\b|(?:python[\d.]*|perl|ruby|node)(?=\s*(?:-\s*)?(?:$|[;&|)])))|\b(?:ba|z|da|k)?sh\s*<\s*<\(\s*(?:curl|wget)\b|\b(?:(?:ba|z|da|k)?sh\s+(?:-\S+\s+)*|eval\s+)["']?(?:\$\(|<\()\s*(?:curl|wget)\b|(?:\bsource|${AT}\.)\s+<\(\s*(?:curl|wget)\b`,
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
      String.raw`(^|[;&|]\s*)(env|printenv|set)\s*($|[;&|])|\b(cat|less|head|tail|grep)\b[^;&|\n]*((^|[^\w.])\.env(?!\.(example|sample|template)\b)(\.[\w-]+)?(?=$|[^\w-])|credentials|\.npmrc|\.netrc|id_(?:rsa|dsa|ecdsa|ed25519)|\.git-credentials|\.envrc|\.pgpass|\.pypirc|\.pem\b)|\$\{?${SECRET_NAME}|\bprintenv\s+(?:-\S+\s+)*${SECRET_NAME}|\bgh\s+auth\s+token\b`,
      'i',
    ),
    reason: 'may print secrets',
  },
  {
    category: 'codex-transfer',
    risk: 'medium',
    policy: 'ask',
    raw: true,
    pattern: /\bnode\b[^;&|\n]*?codex-companion\.mjs["']?\s+transfer\b/,
    reason: 'sends this Claude session transcript to OpenAI Codex',
  },
  {
    category: 'codex-write',
    risk: 'medium',
    policy: 'ask',
    raw: true,
    pattern: /\bnode\b[^;&|\n]*?codex-companion\.mjs["']?\s+task\b[\s\S]*?(?:^|[\s"'])--?w\\?r\\?i\\?t\\?e\b/,
    reason: 'lets Codex edit files outside the guard',
  },
  {
    category: 'codex-send',
    risk: 'medium',
    policy: 'ask',
    raw: true,
    pattern: /\bnode\b[^;&|\n]*?codex-companion\.mjs["']?\s+(?:review|adversarial-review|task)\b/,
    reason: "sends this repository's code to OpenAI Codex",
  },
  {
    category: 'external-send',
    risk: 'medium',
    policy: 'ask',
    pattern: re(
      String.raw`${GIT}push\b|\bgh\s+(pr\s+(create|merge)|release|issue\s+(create|comment)|repo\s+(delete|create)|gist\s+create|api\s+[^;&|\n]*(?:-X\s*|--method[\s=])(POST|PUT|PATCH|DELETE))|\b(npm|pnpm|yarn|cargo)\s+publish\b|\bcurl\b[^;&|\n]*(\s-[a-zA-Z]*X\s*(POST|PUT|PATCH|DELETE)|\s--request[\s=](POST|PUT|PATCH|DELETE)|\s(-d|--data|-F|--form|-T|--upload-file|--json)\b)|\b(scp|sftp)\b|\brsync\b[^;&|\n]*\S+:|\bkubectl\s+(apply|delete)|\b(vercel|netlify|fly|firebase)\s+deploy|\b(?:docker|podman)\s+(?:image\s+)?push\b|\bdocker\s+buildx\s+build\b[^;&|\n]*\s--push\b|\b(?:terraform|tofu)(?:\s+-\S+)*\s+(?:apply|destroy)\b|\bpulumi\s+(?:up|destroy)\b|(^|[;&|(\`]\s*|\$\()((sudo|env|time|exec|xargs|nohup|bash|sh|zsh|node|python3?|ruby|npx|make|(npm|pnpm|yarn|bun)(\s+run)?)\s+)*[\w./-]*deploy[\w.-]*(\s|$)`,
    ),
    reason: 'sends to an external system',
  },
]

// Quoted text that is data, not a command, is blanked before the rules read it. Only two shapes count as data, each on a
// command that cannot be redefined by an alias (builtin subcommands, no global options): the value of a message flag
// (git commit -m "...", gh pr create --body "...") and the pattern of a search (grep "rm -rf", git grep "..."). Every
// other quote keeps its content, so bash -c "...", eval, ssh host "..." and the like are still read.
const QUOTED = /\\[\s\S]|'[^']*'|"(?:[^"\\]|\\[\s\S])*"/g
const DATA_FLAG = /(?:^|\s)(?:-[a-zA-Z]*m|--(?:message|title|body|notes|subject))=?$/
const MESSAGE_COMMAND = /^\s*(?:git\s+(?:commit|tag|merge|revert|notes\s+\w+|stash\s+(?:push|save))|gh\s+(?:pr|issue|release)\s+\w+)\b/
const SEARCH_COMMAND = /^\s*(?:[ef]?grep|rg|ag|ack|git\s+grep)\s/
// A search keeps a quoted pattern as data only when every option on its command is a known harmless one, so an option that
// runs a program (rg --pre, git grep -O) or an abbreviation of one keeps the quotes read. Options after the quote count too.
const SAFE_SHORT = /^-[inwFEPelrRHhcvsqxogtABC]+$/
const SAFE_LONG = /^--(?:$|(?:regexp|ignore-case|recursive|line-number|word-regexp|fixed-strings|extended-regexp|perl-regexp|count|files-with-matches|include|exclude|exclude-dir|glob|type|hidden|no-ignore|context|after-context|before-context|only-matching|invert-match|with-filename|no-filename)(?:=\S*)?$)/

function hasOnlySafeOptions(words: string): boolean {
  // A quote or backslash inside an option word (--pr"e"=x) can spell an option the list does not show; fail closed.
  if (/(^|\s)-[^\s]*['"\\]/.test(words)) return false
  return words
    // Quoted words count as typed: "--pre=x" is still an option once the shell removes the quotes.
    .replace(QUOTED, quoted => (quoted[0] === '\\' ? quoted.slice(1) : ` ${quoted.slice(1, -1)} `))
    .split(/\s+/)
    .filter(word => word.startsWith('-') && word !== '-')
    .every(word => SAFE_SHORT.test(word) || SAFE_LONG.test(word))
}

// Words that run text they are given: shells, eval, ssh, su, other shells, and an interpreter's inline-code flag. A name
// inside a longer word (build.sh, ~/.ssh, --type sh) is not one.
const RUNNER = /(?<![\w.\/-])(?:(?:ba|z|da|k|c|tc|a|mk|fi)?sh|su|eval|ssh|(?:python|node|perl|ruby|php)[\d.]*\s+-[a-zA-Z]*[ce]\b|watch|flock|script)(?![\w.-])/

// "$(cat <<'EOF' ... EOF ... )": only the heredoc body, with nothing but the closing ")" after it.
function isCatHeredoc(inner: string): boolean {
  const head = /^\$\(\s*cat\s+<<(-?)[ \t]*(['"])(\w+)\2[ \t]*\n/.exec(inner)
  if (!head) return false
  const lines = inner.slice(head[0].length).split('\n')
  // The delimiter line must match exactly; only <<- lets leading tabs go.
  const end = lines.findIndex(line => (head[1] === '-' ? line.replace(/^\t+/, '') : line) === head[3])
  return end >= 0 && lines.slice(end + 1).join('\n').trim() === ')'
}

// Quote pairing here is flat, so any construct that makes bash pair quotes differently, or run text as code, makes the
// pairing untrustworthy: a comment (a # that starts a word, also after a bracket), a heredoc, $'...', a backtick, a quote
// left unpaired, a line continuation, a function definition, a command substitution inside double quotes (other than the
// cat heredoc commit message), or a RUNNER word outside quotes. The whole command is then read as typed.
function isPairingSafe(command: string, hadContinuation: boolean): boolean {
  if (hadContinuation) return false
  const outside = command.replace(QUOTED, ' ')
  if (/(^|[\s;&|()<>])#|<<|`|['"]/.test(outside) || command.includes("$'") || RUNNER.test(outside)) return false
  if (/(?<![\w.-])[\w.-]+\s*\(\s*\)|\bfunction\s/.test(outside)) return false
  const doubles = command.match(/"(?:[^"\\]|\\[\s\S])*"/g) ?? []
  return doubles.every(one => !/\$\(|\$\{|`/.test(one) || isCatHeredoc(one.slice(1, -1)))
}

// A command this long is not typed by a person: it is read as it stands (stricter) instead of spending seconds masking it inside a hook.
const MASK_LIMIT = 20000

function maskData(command: string, hadContinuation = false): string {
  if (command.length > MASK_LIMIT || !isPairingSafe(command, hadContinuation)) return command
  // Same text with every quoted stretch overwritten by spaces: separators are found here, so a ; or | inside quotes
  // never starts a new command.
  const filled = command.replace(QUOTED, one => ' '.repeat(one.length))
  return command.replace(QUOTED, (match: string, offset: number) => {
    if (match[0] === '\\') return match
    const inner = match.slice(1, -1)
    const isPlain = !inner.includes('\n') && !(match[0] === '"' && /\$\(|`/.test(inner))
    if (!isPlain && !(match[0] === '"' && isCatHeredoc(inner))) return match
    const from = Math.max(0, offset - 256)
    const before = command.slice(from, offset)
    const separator = Math.max(...[';', '&', '|', '\n'].map(one => filled.lastIndexOf(one, offset - 1)))
    // The command word must be in view: a segment cut by the 256-character window starts mid-command, so it is not trusted.
    if (separator + 1 < from) return match
    const segment = command.slice(separator + 1, offset)
    const bare = filled.slice(separator + 1, offset)
    // A subshell, process substitution or command substitution outside quotes can hold another command whose quoted
    // arguments would be mistaken for ours; any "(" in the segment (or just after the quote) turns blanking off here.
    const tail = filled.slice(offset + match.length, offset + match.length + 257).search(/[;&|\n]/)
    const bareAfter = filled.slice(offset + match.length, tail < 0 ? offset + match.length + 257 : offset + match.length + tail)
    if (bare.includes('(') || bareAfter.includes('(')) return match
    // The segment starts with git or a search, so a runner word is only a risk outside quotes (a "script" in a title is not one).
    if (RUNNER.test(bare)) return match
    if (MESSAGE_COMMAND.test(segment) && DATA_FLAG.test(before.trimEnd())) return match[0] + match[0]
    // A pattern is a word of its own: one that starts with a dash, or is glued to the word before or after it, is not blanked.
    const end = offset + match.length
    if (inner.trimStart().startsWith('-') || /\S$/.test(before) || /^[^\s;&|)]/.test(command.slice(end, end + 1))) return match
    // Only a bounded stretch after the quote is checked; a longer one is treated as unsafe, not skipped.
    const stop = filled.slice(end, end + 257).search(/[;&|\n]/)
    const after = command.slice(end, stop < 0 ? end + 257 : end + stop)
    return after.length <= 256 && SEARCH_COMMAND.test(segment) && hasOnlySafeOptions(`${segment} ${after}`) ? match[0] + match[0] : match
  })
}

const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'NotebookRead', 'WebSearch', 'WebFetch', 'ToolSearch', 'TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet'])
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
// .env.example and its kin hold no secrets by convention. Keys and credential files of the usual tools are listed by name.
const SECRET_PATH = /(^|\/)(\.env(?:\.(?!(?:example|sample|template|dist)$)[^/]*)?|\.envrc|\.npmrc|\.netrc|\.pgpass|\.pypirc|\.git-credentials|credentials(\.json)?|id_(?:rsa|dsa|ecdsa|ed25519)[^/]*|[^/]*\.(?:pem|pfx|p12)|\.kube\/config|\.ssh\/(?!known_hosts$|config$)[^/]+)$/i
const GUARD_FILE = /(^|\/)\.claude\/smartworkbench\.json$/i
// A glob that reaches for secrets files (**/.env*, **/id_*, *.pem).
const SECRET_GLOB = /(^|[/*])\.env(?!\.(?:example|sample|template|dist)\b)|\.envrc|\.npmrc|\.netrc|\.pgpass|\.pypirc|\.git-credentials|credentials|id_(?:rsa|dsa|ecdsa|ed25519|\*)|\*\.(?:pem|pfx|p12)\b|\.ssh\/\*/i
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
    const typed = String(args.command ?? '')
    const command = typed.replace(/\\\r?\n/g, ' ')
    // Bash joins a line only at an odd run of backslashes and never across \r, so a continuation is not trusted for pairing.
    const data = maskData(command, /\\\r?\n/.test(typed))
    const plain = withoutSubstitutions(data)
    // The same command with its quotes and escapes removed, so "-rf", '-'r and git "push" read as the flags and words they become in the shell.
    const unquoted = data.replace(/\\(?=\S)/g, '').replace(/["']/g, '')
    const rule = BASH_RULES.find(one => {
      if (one.raw) return one.pattern.test(command)
      return one.pattern.test(data) || one.pattern.test(unquoted) || (one.stripped === true && one.pattern.test(plain))
    })

    return rule
      ? { category: rule.category, risk: rule.risk, policy: rule.policy, reason: rule.reason }
      : { category: 'shell', ...LOW }
  }

  if (EDIT_TOOLS.has(tool)) {
    const path = normalisePath(String(args.file_path ?? args.notebook_path ?? ''))

    if (GUARD_FILE.test(path)) {
      return { category: 'guard-policy', risk: 'medium', policy: 'ask', reason: 'changes the project guard policy' }
    }

    return SECRET_PATH.test(path)
      ? { category: 'secret-file', risk: 'medium', policy: 'ask', reason: 'edits a secrets file' }
      : { category: 'workspace-edit', risk: 'medium', policy: 'allow', reason: '' }
  }

  if (READ_TOOLS.has(tool)) {
    // Read names one file; Grep and Glob can point at a secrets file too, by path or by glob.
    const named = [args.file_path, tool === 'Grep' || tool === 'Glob' ? args.path : undefined, tool === 'Grep' ? args.glob : tool === 'Glob' ? args.pattern : undefined]
    const touchesSecret = named.some(one => typeof one === 'string' && (SECRET_PATH.test(normalisePath(one)) || (tool !== 'Read' && SECRET_GLOB.test(one))))

    return (tool === 'Read' || tool === 'Grep' || tool === 'Glob') && touchesSecret
      ? { category: 'secret-output', risk: 'medium', policy: 'ask', reason: 'reads a secrets file' }
      : { category: 'read', ...LOW }
  }

  if (tool.startsWith('mcp__')) {
    return classifyMcp(tool)
  }

  return { category: 'other', ...LOW }
}

// Asked even under the permissive profile.
export const ALWAYS_ASK = new Set(['project-rule', 'secret-output', 'secret-file', 'guard-policy', 'mcp-deploy', 'remote-exec', 'codex-send', 'codex-write', 'codex-transfer'])

const PROFILE_RANK: Record<GuardProfile, number> = { off: -1, permissive: 0, balanced: 1, strict: 2 }

// A checked-in guard file may only tighten the person's own setting: the stricter of the two applies.
export function effectiveProfile(own: GuardProfile, file: GuardProfile | undefined): GuardProfile {
  return file !== undefined && PROFILE_RANK[file] > PROFILE_RANK[own] ? file : own
}

// Applies the profile and the pause switch on top of the default (balanced) rule set.
export function decide(verdict: Verdict, profile: GuardProfile, isPaused: boolean): Policy {
  // Off: nothing the built-in rules find is stopped. A rule the project wrote itself still holds, and so does the pause switch.
  if (profile === 'off') {
    if (verdict.category === 'project-rule') return verdict.policy

    return isPaused && verdict.risk !== 'low' ? 'ask' : 'allow'
  }

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
  if (tool === 'Workflow') return workflowLabel(input)
  const args = (input ?? {}) as Record<string, unknown>
  const text =
    args.command ?? args.file_path ?? args.notebook_path ?? args.pattern ?? args.url ?? args.query ?? args.description ?? ''

  return String(text).replace(/\s+/g, ' ').trim().slice(0, 120)
}

// ---- "Allow for session"

// Commands whose meaning sits in two subcommand words (gh pr create, kubectl rollout restart).
const TWO_WORDS = new Set(['gh', 'kubectl', 'docker', 'aws', 'gcloud', 'az', 'helm', 'fly', 'vercel', 'firebase'])
const WRAPPERS = new Set(['sudo', 'env', 'command', 'nohup', 'time', 'exec', 'timeout', 'nice'])

// Folds `.`, empty segments and `..` out of a path as text, so `.claude/./x` and `src/../secrets/k` cannot dodge a path rule.
// No file system access: symlinks are not followed.
export function normalisePath(raw: string): string {
  // A Windows path (C:\repo\.env) is read with its backslashes as separators, so path rules and secret names see it as they would a posix one.
  const path = /^[A-Za-z]:[\\/]|^\\\\/.test(raw) ? raw.replace(/\\/g, '/') : raw
  const absolute = path.startsWith('/') || /^[A-Za-z]:\//.test(path)
  const out: string[] = []
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue
    if (part !== '..') out.push(part)
    else if (out.length > 0 && out[out.length - 1] !== '..') out.pop()
    else if (!absolute) out.push('..')
  }

  return (absolute ? '/' : '') + out.join('/')
}

// Wrappers take flags (some with a value) and sometimes a duration before the command they run.
const FLAG_VALUE: Record<string, RegExp> = {
  timeout: /^(?:-[sk]|--(?:signal|kill-after))$/,
  nice: /^(?:-n|--adjustment)$/,
  sudo: /^(?:-[ughCDprRtT]|--(?:user|group|host|chdir|prompt|role|type|chroot))$/,
  env: /^(?:-[uCS]|--(?:unset|chdir|split-string))$/,
  exec: /^-a$/,
  time: /^(?:-[fo]|--(?:format|output))$/,
}

function dropWrapper(words: string[]): void {
  const wrapper = words.shift() ?? ''
  while (words.length > 0 && (words[0] ?? '').startsWith('-')) {
    const flag = words.shift() ?? ''
    if (FLAG_VALUE[wrapper]?.test(flag)) words.shift()
  }
  if (wrapper === 'timeout' && /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?[smhd]?$/.test(words[0] ?? '')) words.shift()
}

// "FOO=1 sudo git push origin main" → "git push"; flags and later arguments are dropped.
export function commandPrefix(segment: string): string | undefined {
  const words = segment.trim().split(/\s+/).filter(Boolean)
  while (words.length > 0 && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0] ?? '') || WRAPPERS.has(words[0] ?? ''))) {
    if (WRAPPERS.has(words[0] ?? '')) dropWrapper(words)
    else words.shift()
  }
  const [command, ...rest] = words
  // A flag where the command should be means a wrapper option this code does not know: no prefix, so nothing is remembered for it.
  if (!command || command.startsWith('-')) return undefined

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
  // remote-exec is asked every time, so allowing one script for the session never covers the next.
  // The same goes for Codex: the key stops at the script, so one allowed review would cover a write or a transcript transfer.
  if (verdict.category === 'guard-policy' || verdict.category === 'remote-exec' || verdict.category.startsWith('codex-') || verdict.policy === 'block') {
    return undefined
  }
  const args = (input ?? {}) as Record<string, unknown>

  if (tool === 'Bash') {
    const text = String(args.command ?? '')
    // A background "&", a command substitution or a subshell hides a second command that the prefix does not name.
    if (/(?<![&>\d])&(?!&)|`|\$\(|[<>]\(|(^|[;&|]\s*)\(/.test(text.replace(/\d*[<>]&[\d-]*/g, ''))) return undefined
    // What is asked about secrets is asked about each time: the key is the whole command.
    if (verdict.category === 'secret-output' || verdict.category === 'secret-file') return { key: `bash:${verdict.category}:${text.trim()}`, label: text.trim().slice(0, 60) }
    const prefixes = splitCommand(text).map(commandPrefix)
    if (prefixes.length === 0 || prefixes.some(one => one === undefined)) return undefined
    const unique = [...new Set(prefixes as string[])].sort()

    return { key: `bash:${verdict.category}:${unique.join(' && ')}`, label: unique.join(' && ') }
  }

  // A secrets check of Grep, Glob or Read is asked each time: a key by tool or by path would let one answer open the next file too.
  if (verdict.category === 'secret-output' || verdict.category === 'secret-file') return undefined
  const rawPath = args.file_path ?? args.notebook_path
  const path = typeof rawPath === 'string' ? normalisePath(rawPath) : rawPath
  if (typeof path === 'string' && path !== '') {
    const kind = EDIT_TOOLS.has(tool) ? 'edit' : tool.toLowerCase()
    return { key: `${kind}:${path}`, label: `${EDIT_TOOLS.has(tool) ? 'edits of' : tool} ${path}` }
  }

  return { key: `tool:${tool}`, label: tool }
}
