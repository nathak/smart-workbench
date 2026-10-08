# SmartWorkbench for Claude Code

[English](#english) · [한국어](#한국어)

---

## English

A Claude Code mod for seeing and steering the **Intent, Context, Run and Evidence** of the work you hand to Claude, without leaving Claude Code.
Implements P0 (first public release), P1 (product hardening) and P2 (team features) of the product spec (v0.1).

### Install

At the Claude Code prompt:

```
/plugin install smartworkbench --marketplace nathak/smart-workbench
```

Answer `y` to add the marketplace and choose the user scope. The repository is private, so git on that machine must be signed in to GitHub (`gh auth login` or similar). Update with `claude plugin update smartworkbench`.

### Quick start

1. **Start a task**: run `/swb new`. The panel opens on the Intent tab.
2. **Write the contract**: type the goal in the Goal field and press Enter. Add constraints (prefix `s:` for a soft one) and done conditions such as `Related tests pass` or `Typecheck passes`; each condition is linked to the matching kind of check from its wording.
3. **Lock it**: press `Lock` (hotkey `l`). From now on the contract rides along with every prompt as context only Claude reads.
4. **Pin context** (optional): in the Context tab, pin files (`src/auth.ts` or `src/auth.ts:10-40`) and notes. `Preview` shows exactly what Claude will receive.
5. **Work as usual**: ask Claude in the normal prompt. The Run tab lists each tool call; risky ones are asked or blocked by the guard.
6. **Check the result**: when the turn ends a completion summary is posted. Open the Evidence tab (`/swb verify`) to see which conditions passed, which files have a check behind them, and use `Verify`, `Waive`, `Ask Claude to finish` or `Export handoff`.
7. **Pick it up later**: state is restored when you reopen the project, and sessions open on the same project share it. On another machine, `/swb share` here and `/swb pickup` there. Save a setup you reuse with `/swb save <name>`.

To use the panel from the keyboard, focus it with `ctrl+x tab` (or click it). Hotkeys: `1`–`4` tabs, `l` Lock/Unlock, `p` Preview, `r` Pause risky calls, `f` Ask Claude to finish, `c` Check CI, `x` Export handoff.

### Commands

`/swb` is the short alias of `/smartworkbench`; `/workbench` is a deprecated alias kept for now. An unknown argument prints the command list.

| Command | Summary |
|---|---|
| `/swb` | Open the panel |
| `/swb new` | Start a new task contract |
| `/swb intent` · `context` · `run` · `verify` | Open that tab |
| `/swb status` | Text summary |
| `/swb preview` | Show what is added to each prompt |
| `/swb save <name>` | Save the setup as a template |
| `/swb load <name>` | Start a task from a template |
| `/swb templates` | List templates and context sets |
| `/swb export [path]` | Write a Markdown handoff |
| `/swb policy [init\|reload]` | Show, create or re-read the project guard file |
| `/swb ci` | Import CI results for the current commit |
| `/swb issue <ref>` | Link the task to an issue |
| `/swb share [path]` · `/swb pickup [path]` | Hand the task to another machine through git |
| `/swb audit [n]` | Show the audit log |
| `/swb clear` | Reset this project's state |

#### `/swb`
Opens the SmartWorkbench panel on the last tab used. Where no panel can be shown, it prints the same text as `/swb status` instead.

#### `/swb new`
Starts a fresh task contract and opens the Intent tab; when the project guard file names a `defaultTemplate`, the new task starts from that team template. If a goal is already set it asks first (`Start new` / `Keep current`). The goal, constraints, non-goals, done conditions, evidence and changed-file record are cleared and the contract is unlocked. Pins, tool call history and the guard profile are kept.

#### `/swb intent` · `/swb context` · `/swb run` · `/swb verify`
Open the panel on that tab. `/swb evidence` is the same as `/swb verify`.

#### `/swb status`
Prints a text summary: the band line, the goal with its lock and status, active constraints, pins, the project guard file if there is one, and every done condition with its result. Use it where no UI is drawn (VS Code chat, `claude -p`, remote surfaces) or to paste the state somewhere.

#### `/swb preview`
Prints exactly the context SmartWorkbench adds to each prompt: the locked contract (`<smartworkbench_contract>`) and the pinned files and notes (`<smartworkbench_pins>`), plus a warning for any pin that cannot be read. An unlocked contract is not added, so with nothing locked or pinned it says nothing is added. The Context tab's `Preview` button shows the same text.

#### `/swb save <name>`
Saves the current setup as a template: goal, constraints, non-goals, done conditions (wording and evidence link), pins and guard profile. Results (evidence, history, changed files) are not saved. Templates are shared by all your projects, and saving under an existing name replaces it.

#### `/swb load <name>`
Starts a task from a template and opens the Intent tab. If a goal is already set it asks first (`Load template` / `Keep current`). The task comes in unlocked with no evidence, and the template's pins and guard profile **replace** the current ones. Your own templates are looked up first, then the team templates in the guard file; `team:<name>` picks the team one. A team template sets the contract only and leaves pins and the guard profile alone. With an unknown name it lists the templates you have.

#### `/swb templates`
Lists your templates, the team templates from the guard file (marking the default) and context sets. Context sets are saved and added from the Context tab (`save pins as a context set`, `Add set`); adding a set merges its pins into the current ones and skips any already pinned.

#### `/swb export [path]`
Writes a Markdown handoff for the next session or developer, by default to `.claude/smartworkbench-handoff.md` (the Evidence tab's `Export handoff` does the same). It holds the status, goal, constraints and non-goals; each done condition with its result and the command or manual note behind it, flagged when code changed after it passed; pinned context; changed files with their regions and whether a check passed after the last edit; the last 10 verification runs; and blocked or declined calls. Exporting again overwrites the file. It lands inside the project, so add it to `.gitignore` or pass another path if it should not be committed.

#### `/swb policy [init|reload]`
- `/swb policy` (or `reload`): re-reads `.claude/smartworkbench.json` and prints its profile, rules and any errors.
- `/swb policy init`: writes an example file when none exists, then shows it. Edit and commit it to share the rules with the team (see *Project guard file*).

#### `/swb ci`
Asks the local `gh` CLI for the GitHub Actions runs of the current commit (`git rev-parse HEAD`) and records the latest run of each workflow as `ci` evidence: success counts as passed, failure/cancelled/timed out as failed, a running workflow as observed. While code changes are uncommitted, CI did not test what is on disk, so every result counts only as observed. Running the command again updates the same run's record. Link a done condition to `ci` (conditions mentioning CI are linked automatically). The Evidence tab's `Check CI` button (hotkey `c`) does the same. This is the only feature that reaches the network, and only when you run it.

#### `/swb issue <ref>`
Links the task to an issue; it becomes part of the contract (`<issue>`) and the handoff.
- `#42`, `42` or a GitHub issue URL: read with `gh issue view`; the title fills an empty goal and the description is pinned as a note.
- Anything else, such as `LIN-12 Fix login timeout`: kept as typed, for Linear, Jira or any tracker.
- `/swb issue clear` unlinks it. The issue changes only while the contract is unlocked.

#### `/swb share [path]` · `/swb pickup [path]`
State is kept per machine, so to continue on another computer:
1. `/swb share` writes the contract (with manual marks and the issue) and the pins to `.claude/smartworkbench-task.json`. Commit and push it.
2. On the other machine, pull and run `/swb pickup`. It asks before replacing a current task.
Evidence does not carry over: checks run on one machine say nothing about another's working tree, so run them again there. Several sessions on the same machine and project need neither command: each save builds on the newest copy, and a change saved by another session is picked up before the next prompt.

#### `/swb audit [n]`
Shows the last `n` (default 20) entries of the audit log, when the guard file turns it on (see *Audit log*).

#### `/swb clear`
After asking (`Clear` / `Cancel`), resets this project's workbench: contract, pins, observed files, tool call history, evidence and changed files. The guard profile and pause switch, templates, context sets and other projects are left alone.

### Panel

- **Intent**: goal, constraints (`[H]`/`[S]`, on/off, prefix `s:` to add a soft one), done conditions and non-goals. **Lock** adds the contract to every prompt as model-only context (`<smartworkbench_contract>`); the message you typed is left as is. A locked contract cannot be edited.
- **Context**: pin files and notes. Pin a line range with `path:10-40` (or `path#L10-L40`). Each file pin switches between `Live` (re-read at send time) and `Snap` (keeps the text and SHA-256 as pinned, up to 64 KB). Save the current pins as a named context set and add it to any project with `Add set`.
  - Files Claude reads or edits are classified as source, test, config, docs, generated or secret. Source, test and config files that were edited or read at least twice show up under **SUGGESTED**: `Pin` accepts one, `Hide` dismisses it. Secret and generated files are never suggested. The rest are listed under OBSERVED.
  - Token sizes are estimates marked with `~`. **Preview** is built by the same function that builds the injected text. A pin that cannot be read warns but never blocks the prompt.
- **Run**: every tool call is recorded with a risk level. Guard profiles (Permissive / Balanced / Strict) and `Pause risky calls`.
- **Evidence**: results of test, build, typecheck and lint commands are collected and linked to done conditions (guessed from the wording, changeable). `Verify` and `Waive` are manual marks that keep a note and a time. Each turn ends with a completion summary, and `Export handoff` writes Markdown for the next session or developer.
  - At the end of each turn `git diff -U0 HEAD` gives the changed regions per file (`L10-24, L41 (del)`), and each file shows whether a check passed **after** its last edit (✓ passed · ✕ failed · ! no check · · docs).
  - If code changes after a passing test, that condition drops to `observed` (re-run needed) and no longer counts as done. Edits to docs and generated files are exempt.
- **Tool row badges**: Claude Code's own tool rows stay as they are; one line is added only when there is a risk, a policy outcome (Blocked/Declined/Asked) or a check result (`test passed · evidence for dc-1`).

Band above the prompt: `WB ● Goal │ Ctx +2 pins · 42% │ Done 1/2 │ Guard BALANCED [Open]`

### Built-in guard rules (Balanced)

| Category | Examples | Policy |
|---|---|---|
| Read | Read, Grep, search | Allow |
| Workspace edit | Edit, Write | Allow (Ask under Strict) |
| External send | `git push`, `gh pr create`, `npm publish`, `curl -X POST`, deploys | Ask |
| Possible secrets | `printenv`, `cat .env`, `$..._TOKEN`, editing `.env` | Ask |
| Destructive git | `push --force`, `reset --hard`, `clean -f`, `branch -D` | Block |
| Broad delete | `rm -r`, `find -delete` | Block |
| MCP deploy/release | `mcp__vercel__deploy_project` | Ask (even under Permissive) |
| MCP issue/alert changes | `mcp__linear__create_issue`, `mcp__pagerduty__acknowledge_incident` | Ask |
| MCP issue/observability reads | `mcp__linear__list_issues`, `mcp__sentry__search_events` | Allow |

- Ask uses Claude Code's own question dialog (`$.ui.ask`) with **Allow**, **Allow for session** and **Block**; an allowed call still goes through Claude Code's own permission check.
- **Allow for session** stops asking for the same thing until the session ends: a shell command by its command and subcommand (`git push`, `npm publish`, `gh pr create`), a file edit by its path, an MCP tool by its name. A chain counts only as the same set of commands, so `git push && curl -X POST …` is asked again after allowing `git push`. It never lifts a Block, is not offered for editing the guard file, and is ignored while `Pause risky calls` is on. The Run tab lists these under ALLOWED FOR THIS SESSION, each with `×` to revoke; such calls show `SESSION` there.
- Block does not run the tool and tells Claude why.
- If the guard itself fails, only high-risk calls are refused (fail closed); everything else falls back to the normal flow.
- This is a regex-based workflow control, not a security sandbox.

### Project guard file

Commit `.claude/smartworkbench.json` and the whole team shares the same rules. `/smartworkbench policy init` writes an example.

```json
{
  "profile": "strict",
  "rules": [
    { "tool": "Bash", "command": "\\bterraform\\s+apply\\b", "policy": "block", "reason": "infra changes go through CI" },
    { "tool": "Edit|Write", "path": "migrations/**", "policy": "ask", "reason": "schema migrations need review" }
  ],
  "defaultTemplate": "change",
  "templates": {
    "change": {
      "constraints": ["Keep the public API compatible", "s: Keep the patch minimal"],
      "doneConditions": ["Related tests pass", "Typecheck passes", { "text": "CI is green", "link": "ci" }]
    }
  },
  "audit": true
}
```

- A `profile` there replaces the personal setting (shown as `STRICT*` in the band).
- Rules are checked top to bottom and the first match applies. `tool` and `command` are regular expressions; `path` is a glob (`**`, `*`, `?`).
- The file can only **tighten** the guard. A built-in Block, a secrets Ask and the Ask on editing this file cannot be loosened by an `allow` rule.
- It is read at session start and right after a tool edits it. After editing it by hand, run `/smartworkbench policy reload`.
- Broken rules are skipped and reported, never guessed at.
- `templates` are the team's shared done conditions: each has `constraints` (prefix `s:` for soft), `doneConditions` (text, or `{ "text", "link" }`), optional `goal` and `nonGoals`. `defaultTemplate` seeds `/swb new`; `/swb load <name>` or `team:<name>` loads one.
- `audit` turns on the audit log (below).

### Audit log

With `"audit": true` (or `{ "path": "logs/agent-audit.jsonl" }`, a path inside the repository) every session appends one JSON line per event to `.claude/smartworkbench-audit.jsonl`: `session.start`, `guard.block`, `guard.ask` (allowed, allowed for session or declined), `guard.session-revoke`, `contract.lock` / `contract.unlock`, `condition.verified` / `condition.waived` / `condition.unmark`, `task.complete`, `task.new` / `task.load` / `task.clear`, `task.share` / `task.pickup`. Each line carries the time, the git `user.name`, the session id and the details (tool, input summary, reason, note). Past 1 MB the log moves to `.1` and a new one starts. Read it with `/swb audit [n]`; commit it if the team wants a shared record, or ignore it to keep it local. A failed write never lets a guarded call through.

### How completion is judged

- Only known verification commands that finish without error count as passing evidence. Interrupted or backgrounded runs are `Observed`.
- Claude's own words never make a condition `Verified`.
- Evidence is kept as history and a condition follows the latest result (a failure is never overwritten by an older pass).
- The task becomes `complete` only when every condition is Verified or Waived.

### Trust and storage

- No network requests of its own, no extra model calls, no telemetry. `/swb ci` and `/swb issue #n` run the local `gh` CLI only when you call them.
- State is kept in `$.store` per project (working directory) and restored on restart; state saved by an earlier version is filled in on load. Templates and context sets are kept across projects. Live pin contents, environment variables and the conversation are not stored. History is capped at 100 tool calls and 200 evidence records.
- Local commands run with argument lists: `git diff -U0 HEAD` at turn end, `git config user.name` when audit is on, and `git`/`gh` for `/swb ci` and `/swb issue`. Files are written only for the handoff, `policy init`, `share` and the audit log the guard file turns on.
- `claude plugin validate .` lists every hook and call the mod uses.

### Development

```text
hooks/register.tsx   event hooks, commands, panel and band drawing (all code that uses $)
hooks/model.ts       state transitions (pure)
hooks/risk.ts        risk rules and guard profiles
hooks/evidence.ts    verification command kinds, condition status, turn summary
hooks/intent.ts      contract serialization (deterministic)
hooks/context.ts     pin ranges, snapshots, serialization and injection
hooks/report.ts      handoff Markdown, tool row badge text
hooks/policy.ts      project guard file parsing, globs, rule application
hooks/files.ts       file classification, suggestions
hooks/diff.ts        git diff region parsing, per-file evidence links
hooks/team.ts        audit lines, CI results, issue refs, shared task file
types/index.d.ts     state type contract
tests/               claude plugin test
```

```bash
claude plugin validate .
claude plugin test .
claude --plugin-dir .      # start a session with this folder loaded
```

Developed and checked on Claude Code 2.1.292. The mods API is early access and may change between releases.

### Not yet

- Policy distribution beyond one repository (organization-wide managed settings, signed releases), a central audit store, and CI/PR write actions; SmartWorkbench reads CI and issues but never pushes to them.

---

## 한국어

Claude에게 맡긴 작업의 **목표(Intent)·맥락(Context)·실행(Run)·검증(Evidence)** 을 Claude Code 안에서 직접 보고 통제하는 Mod입니다.
기획서: NAS `claude-mods/smart-workbench/smartworkbench-prd.md` (v0.1). P0(최초 공개 버전), P1(제품성 강화), P2(팀 기능)를 구현했습니다.

### 설치

Claude Code 입력창에서:

```
/plugin install smartworkbench --marketplace nathak/smart-workbench
```

마켓플레이스 추가를 물으면 `y`, 설치 범위는 user를 고릅니다. 비공개 저장소이므로 그 컴퓨터의 git이 GitHub에 로그인되어 있어야 합니다(`gh auth login` 등). 업데이트는 `claude plugin update smartworkbench`.

### 기본 사용법

1. **작업 시작**: `/swb new`를 실행하면 패널이 Intent 탭으로 열립니다.
2. **계약 작성**: Goal 칸에 목표를 쓰고 Enter. 제약(앞에 `s:`를 붙이면 Soft)과 완료 조건(`관련 테스트 통과`, `타입 검사 통과` 등)을 추가합니다. 완료 조건은 문구를 보고 맞는 검증 종류(test/build/typecheck/lint)에 자동 연결됩니다.
3. **잠금**: `Lock`(단축키 `l`)을 누르면 이때부터 계약이 매 프롬프트에 Claude만 읽는 컨텍스트로 붙습니다.
4. **자료 고정**(선택): Context 탭에서 파일(`src/auth.ts` 또는 `src/auth.ts:10-40`)과 메모를 Pin합니다. `Preview`로 Claude에게 실제로 전달될 내용을 확인합니다.
5. **평소처럼 작업**: 기본 입력창에서 Claude에게 요청합니다. Run 탭에 툴 호출이 쌓이고, 위험한 호출은 Guard가 묻거나 막습니다.
6. **결과 확인**: 턴이 끝나면 완료 요약이 대화에 남습니다. Evidence 탭(`/swb verify`)에서 어떤 조건이 통과했는지, 어떤 파일 변경 뒤에 검증이 있었는지 보고 `Verify`, `Waive`, `Ask Claude to finish`, `Export handoff`를 씁니다.
7. **다음에 이어 하기**: 프로젝트를 다시 열면 상태가 복원되고, 같은 프로젝트를 연 다른 세션과도 상태가 공유됩니다. 다른 컴퓨터에서는 여기서 `/swb share`, 거기서 `/swb pickup`. 자주 쓰는 설정은 `/swb save <이름>`으로 저장해 둡니다.

키보드로 패널을 쓰려면 `ctrl+x tab`(또는 클릭)으로 패널에 포커스를 옮깁니다. 단축키: `1`–`4` 탭 전환, `l` 잠금/해제, `p` Preview, `r` 위험 호출 일시정지, `f` Ask Claude to finish, `c` Check CI, `x` Export handoff.

### 명령어

`/swb`는 `/smartworkbench`의 짧은 별칭이고, `/workbench`는 한동안 유지되는 deprecated 별칭입니다. 모르는 인자를 주면 명령 목록을 보여 줍니다.

| 명령 | 요약 |
|---|---|
| `/swb` | 패널 열기 |
| `/swb new` | 새 작업 계약 시작 |
| `/swb intent` · `context` · `run` · `verify` | 해당 탭 열기 |
| `/swb status` | 텍스트 요약 |
| `/swb preview` | 프롬프트에 붙는 내용 보기 |
| `/swb save <name>` | 현재 설정을 템플릿으로 저장 |
| `/swb load <name>` | 템플릿으로 작업 시작 |
| `/swb templates` | 템플릿·Context set 목록 |
| `/swb export [path]` | Markdown handoff 쓰기 |
| `/swb policy [init\|reload]` | 프로젝트 Guard 파일 보기·생성·다시 읽기 |
| `/swb ci` | 현재 커밋의 CI 결과 가져오기 |
| `/swb issue <ref>` | 작업에 이슈 연결 |
| `/swb share [path]` · `/swb pickup [path]` | git을 통해 다른 컴퓨터로 작업 넘기기 |
| `/swb audit [n]` | 감사 로그 보기 |
| `/swb clear` | 이 프로젝트 상태 초기화 |

#### `/swb`
SmartWorkbench 패널을 마지막에 보던 탭으로 엽니다. 패널을 띄울 수 없는 환경에서는 대신 `/swb status`와 같은 텍스트를 보여 줍니다.

#### `/swb new`
새 작업 계약을 시작하고 Intent 탭을 엽니다. 프로젝트 Guard 파일에 `defaultTemplate`이 있으면 그 팀 템플릿으로 시작합니다. 이미 목표가 있으면 먼저 묻습니다(`Start new` / `Keep current`). 목표·제약·하지 않을 일·완료 조건·증거·변경 파일 기록을 비우고 잠금을 풉니다. Pin, 툴 호출 기록, Guard 프로필은 유지됩니다.

#### `/swb intent` · `/swb context` · `/swb run` · `/swb verify`
해당 탭으로 패널을 엽니다. `/swb evidence`는 `/swb verify`와 같습니다.

#### `/swb status`
텍스트 요약을 출력합니다. 밴드 줄, 목표와 잠금·진행 상태, 켜진 제약, Pin 목록, 프로젝트 Guard 파일(있을 때), 완료 조건별 결과가 들어갑니다. UI가 없는 환경(VS Code 채팅, `claude -p`, 원격 화면)이나 상태를 어딘가에 붙여 넣을 때 씁니다.

#### `/swb preview`
SmartWorkbench가 매 프롬프트에 붙이는 내용을 그대로 보여 줍니다. 잠긴 계약(`<smartworkbench_contract>`)과 Pin한 파일·메모(`<smartworkbench_pins>`), 읽을 수 없는 Pin에 대한 경고가 나옵니다. 잠기지 않은 계약은 붙지 않으므로, 잠금도 Pin도 없으면 붙는 것이 없다고 알려 줍니다. Context 탭의 `Preview` 버튼과 같은 내용입니다.

#### `/swb save <name>`
현재 설정을 템플릿으로 저장합니다. 목표, 제약, 하지 않을 일, 완료 조건(문구와 증거 연결), Pin, Guard 프로필이 들어가고, 결과(증거·기록·변경 파일)는 저장하지 않습니다. 템플릿은 모든 프로젝트에서 공유되며, 같은 이름으로 저장하면 덮어씁니다.

#### `/swb load <name>`
템플릿으로 작업을 시작하고 Intent 탭을 엽니다. 이미 목표가 있으면 먼저 묻습니다(`Load template` / `Keep current`). 작업은 잠금 해제·증거 없음 상태로 들어오고, 템플릿의 Pin과 Guard 프로필이 현재 것을 **대체**합니다. 개인 템플릿을 먼저 찾고, 없으면 Guard 파일의 팀 템플릿을 찾습니다. `team:<이름>`은 팀 템플릿을 지정합니다. 팀 템플릿은 계약만 채우고 Pin과 Guard 프로필은 그대로 둡니다. 없는 이름이면 가진 템플릿 목록을 보여 줍니다.

#### `/swb templates`
개인 템플릿, Guard 파일의 팀 템플릿(기본 템플릿 표시), Context set 목록을 보여 줍니다. Context set은 Context 탭에서 저장(`save pins as a context set`)하고 추가(`Add set`)합니다. Set을 추가하면 현재 Pin에 합쳐지고, 이미 Pin된 것은 건너뜁니다.

#### `/swb export [path]`
다음 세션이나 다른 개발자에게 넘길 Markdown handoff를 씁니다. 기본 위치는 `.claude/smartworkbench-handoff.md`이고, Evidence 탭의 `Export handoff` 버튼과 같습니다. 진행 상태, 목표·제약·하지 않을 일, 완료 조건별 결과와 근거(명령 또는 수동 메모, 통과 뒤 코드가 바뀌었으면 표시), Pin한 자료, 변경 파일별 구간과 마지막 수정 뒤 검증 여부, 최근 검증 실행 10건, 차단·거절된 호출이 들어갑니다. 다시 내보내면 덮어씁니다. 프로젝트 안에 저장되므로 커밋하지 않으려면 `.gitignore`에 넣거나 다른 경로를 지정하세요.

#### `/swb policy [init|reload]`
- `/swb policy`(또는 `reload`): `.claude/smartworkbench.json`을 다시 읽고 프로필, 규칙, 오류를 보여 줍니다.
- `/swb policy init`: 파일이 없을 때 예시 파일을 만들고 내용을 보여 줍니다. 고쳐서 커밋하면 팀이 같은 규칙을 씁니다(아래 *프로젝트 Guard 파일* 참고).

#### `/swb ci`
로컬 `gh` CLI로 현재 커밋(`git rev-parse HEAD`)의 GitHub Actions 실행을 조회해, 워크플로마다 가장 최근 실행을 `ci` 증거로 기록합니다. 성공은 통과, 실패·취소·시간 초과는 실패, 실행 중은 observed입니다. 커밋되지 않은 코드 변경이 있으면 CI가 지금 디스크의 코드를 검사한 것이 아니므로 모든 결과를 observed로만 칩니다. 다시 실행하면 같은 실행의 기록을 갱신합니다. 완료 조건을 `ci`에 연결하세요(CI를 언급한 조건은 자동 연결). Evidence 탭의 `Check CI` 버튼(단축키 `c`)도 같습니다. 네트워크를 쓰는 유일한 기능이며, 직접 실행할 때만 동작합니다.

#### `/swb issue <ref>`
작업에 이슈를 연결합니다. 이슈는 계약(`<issue>`)과 handoff에 들어갑니다.
- `#42`, `42`, GitHub 이슈 URL: `gh issue view`로 읽어서, 제목은 비어 있는 목표를 채우고 본문은 메모로 Pin합니다.
- 그 밖의 형식(예: `LIN-12 Fix login timeout`): 입력한 그대로 저장합니다. Linear, Jira 등 어떤 트래커든 쓸 수 있습니다.
- `/swb issue clear`로 연결을 해제합니다. 계약이 잠겨 있으면 바꿀 수 없습니다.

#### `/swb share [path]` · `/swb pickup [path]`
상태는 컴퓨터마다 따로 저장되므로, 다른 컴퓨터에서 이어 하려면:
1. `/swb share`가 계약(수동 표시·이슈 포함)과 Pin을 `.claude/smartworkbench-task.json`에 씁니다. 커밋하고 푸시합니다.
2. 다른 컴퓨터에서 pull한 뒤 `/swb pickup`을 실행합니다. 진행 중인 작업이 있으면 바꾸기 전에 묻습니다.
증거는 넘어가지 않습니다. 한 컴퓨터의 검사 결과는 다른 컴퓨터의 작업 트리를 보증하지 않으므로 거기서 다시 실행합니다. 같은 컴퓨터에서 같은 프로젝트를 연 여러 세션은 이 명령이 필요 없습니다. 저장할 때마다 가장 새 상태 위에 쌓고, 다른 세션이 바꾼 내용은 다음 프롬프트 전에 반영합니다.

#### `/swb audit [n]`
Guard 파일에서 감사 로그를 켰을 때 최근 `n`개(기본 20개) 항목을 보여 줍니다(아래 *감사 로그* 참고).

#### `/swb clear`
먼저 확인(`Clear` / `Cancel`)한 뒤 이 프로젝트의 계약, Pin, 관찰 파일, 툴 호출 기록, 증거, 변경 파일을 모두 초기화합니다. Guard 프로필과 일시정지 설정, 템플릿, Context set, 다른 프로젝트는 건드리지 않습니다.

### 패널

- **Intent**: Goal, Constraints(`[H]`/`[S]`, 켜기/끄기, `s:` 접두어로 Soft 추가), Done conditions, Non-goals. **Lock** 하면 계약이 `<smartworkbench_contract>`로 매 프롬프트에 추가 컨텍스트로 붙습니다(사용자 메시지 본문은 그대로). 잠긴 동안은 편집할 수 없습니다.
- **Context**: 파일과 메모를 Pin. 파일은 `path:10-40`(또는 `path#L10-L40`)로 라인 범위만 Pin할 수 있고, Pin마다 `Live`(전송 시점에 다시 읽음)와 `Snap`(Pin한 시점의 내용과 SHA-256 보존, 64KB 이하)을 전환합니다. 현재 Pin 묶음을 이름 붙여 Context set으로 저장하고 다른 프로젝트에서 `Add set`으로 추가할 수 있습니다.
  - Claude가 읽거나 수정한 파일은 source/test/config/docs/generated/secret으로 자동 분류됩니다. 수정했거나 두 번 이상 읽은 source·test·config 파일은 **SUGGESTED**로 제안되며 `Pin`으로 승인하거나 `Hide`로 숨깁니다. secret·generated 파일은 제안하지 않습니다. 나머지는 OBSERVED에 표시됩니다.
  - 토큰 수는 `~`가 붙은 추정치입니다. **Preview**는 실제로 주입되는 텍스트와 같은 함수로 만듭니다. 읽을 수 없는 Pin은 전송을 막지 않고 경고만 냅니다.
- **Run**: 모든 툴 호출을 기록하고 위험도를 매깁니다. Guard 프로필(Permissive / Balanced / Strict)과 `Pause risky calls`.
- **Evidence**: 테스트·빌드·타입 검사·린트 명령의 결과를 자동 수집하고, Done condition에 증거 종류를 연결합니다(조건 문구로 자동 추정, 변경 가능). `Verify`/`Waive`는 수동 표시이며 메모와 시각이 남습니다. 턴이 끝나면 완료 요약을 대화에 남기고, `Export handoff`로 다음 세션이나 다른 개발자에게 넘길 Markdown을 씁니다.
  - 턴이 끝날 때 `git diff -U0 HEAD`로 파일별 변경 구간(`L10-24, L41 (del)`)을 모으고, 파일마다 마지막 수정 **이후에** 통과한 검증이 있는지 표시합니다(✓ 통과 · ✕ 실패 · ! 검증 없음 · · 문서).
  - 통과한 테스트 뒤에 코드가 다시 바뀌면 그 조건은 `observed`(다시 실행 필요)로 내려가고 완료로 치지 않습니다. 문서·생성 파일 수정은 예외입니다.
- **툴 행 배지**: 대화의 기본 툴 행은 그대로 두고, 위험도·정책 결과(Blocked/Declined/Asked)나 검증 결과(`test passed · evidence for dc-1`)가 있을 때만 한 줄을 덧붙입니다.

입력창 위 밴드: `WB ● 목표 │ Ctx +2 pins · 42% │ Done 1/2 │ Guard BALANCED [Open]`

### 기본 Guard 규칙 (Balanced)

| 범주 | 예 | 정책 |
|---|---|---|
| 읽기 | Read, Grep, 검색 | Allow |
| 워크스페이스 편집 | Edit, Write | Allow (Strict에서는 Ask) |
| 외부 전송 | `git push`, `gh pr create`, `npm publish`, `curl -X POST`, 배포 | Ask |
| 비밀 가능 출력 | `printenv`, `cat .env`, `$..._TOKEN`, `.env` 편집 | Ask |
| 파괴적 Git | `push --force`, `reset --hard`, `clean -f`, `branch -D` | Block |
| 광범위 삭제 | `rm -r`, `find -delete` | Block |
| MCP 배포·릴리스 | `mcp__vercel__deploy_project` | Ask (Permissive에서도) |
| MCP 이슈·알림 변경 | `mcp__linear__create_issue`, `mcp__pagerduty__acknowledge_incident` | Ask |
| MCP 이슈·관측 조회 | `mcp__linear__list_issues`, `mcp__sentry__search_events` | Allow |

- Ask는 Claude Code의 공식 질문 창(`$.ui.ask`)으로 **Allow**, **Allow for session**, **Block** 중에서 고르게 하고, 허용해도 Claude Code 기존 권한 검사를 그대로 거칩니다.
- **Allow for session**을 고르면 세션이 끝날 때까지 같은 대상은 다시 묻지 않습니다. Bash는 명령과 하위 명령(`git push`, `npm publish`, `gh pr create`), 파일 편집은 경로, MCP 툴은 툴 이름 단위입니다. 연결된 명령은 같은 명령 묶음일 때만 해당하므로, `git push`를 허용했어도 `git push && curl -X POST …`는 다시 묻습니다. Block은 풀리지 않고, Guard 파일 수정에는 이 선택지가 없으며, `Pause risky calls`가 켜져 있으면 무시됩니다. Run 탭의 ALLOWED FOR THIS SESSION에 목록이 나오고 `×`로 취소합니다. 이렇게 통과한 호출은 Run 탭에 `SESSION`으로 표시됩니다.
- Block은 툴을 실행하지 않고 이유를 Claude에게 돌려줍니다.
- Guard 내부 오류 시 High-risk 호출만 막고(fail closed) 나머지는 기본 흐름으로 돌아갑니다.
- 정규식 기반의 작업 흐름 통제 장치이며 보안 샌드박스가 아닙니다.

### 프로젝트 Guard 파일

저장소에 `.claude/smartworkbench.json`을 커밋하면 팀이 같은 규칙을 씁니다. `/smartworkbench policy init`이 예시를 만들어 줍니다.

```json
{
  "profile": "strict",
  "rules": [
    { "tool": "Bash", "command": "\\bterraform\\s+apply\\b", "policy": "block", "reason": "infra changes go through CI" },
    { "tool": "Edit|Write", "path": "migrations/**", "policy": "ask", "reason": "schema migrations need review" }
  ],
  "defaultTemplate": "change",
  "templates": {
    "change": {
      "constraints": ["Keep the public API compatible", "s: Keep the patch minimal"],
      "doneConditions": ["Related tests pass", "Typecheck passes", { "text": "CI is green", "link": "ci" }]
    }
  },
  "audit": true
}
```

- `profile`이 있으면 개인 설정 대신 그 프로필을 씁니다(밴드에 `STRICT*`로 표시).
- 규칙은 위에서부터 처음 맞는 것 하나가 적용됩니다. `tool`·`command`는 정규식, `path`는 glob(`**`, `*`, `?`)입니다.
- 저장소 파일은 Guard를 **강화만** 할 수 있습니다. 기본 Block, 비밀값 관련 Ask, 이 파일 자체의 수정에 대한 Ask는 `allow` 규칙으로 풀리지 않습니다.
- 세션 시작 시와 툴로 이 파일을 수정한 직후 다시 읽습니다. 직접 고쳤다면 `/smartworkbench policy reload`.
- 잘못된 규칙은 건너뛰고 오류를 표시합니다(추측해서 적용하지 않음).
- `templates`는 팀 공통 완료 조건입니다. 템플릿마다 `constraints`(`s:` 접두어는 Soft), `doneConditions`(문자열 또는 `{ "text", "link" }`), 선택적인 `goal`, `nonGoals`를 둡니다. `defaultTemplate`은 `/swb new`의 시작점이 되고, `/swb load <이름>` 또는 `team:<이름>`으로 불러옵니다.
- `audit`은 감사 로그를 켭니다(아래).

### 감사 로그

`"audit": true`(또는 저장소 안 경로를 지정한 `{ "path": "logs/agent-audit.jsonl" }`)이면 모든 세션이 사건마다 JSON 한 줄을 `.claude/smartworkbench-audit.jsonl`에 덧붙입니다. 기록하는 사건은 `session.start`, `guard.block`, `guard.ask`(허용·세션 허용·거절), `guard.session-revoke`, `contract.lock` / `contract.unlock`, `condition.verified` / `condition.waived` / `condition.unmark`, `task.complete`, `task.new` / `task.load` / `task.clear`, `task.share` / `task.pickup`입니다. 줄마다 시각, git `user.name`, 세션 ID, 세부 내용(툴, 입력 요약, 이유, 메모)이 들어갑니다. 1MB를 넘으면 기존 로그를 `.1`로 옮기고 새로 시작합니다. `/swb audit [n]`으로 봅니다. 팀이 함께 보려면 커밋하고, 로컬에만 두려면 `.gitignore`에 넣습니다. 기록에 실패해도 Guard가 막은 호출이 통과되는 일은 없습니다.

### 완료 판정

- 종료 코드가 0인(오류 없는) 알려진 검증 명령만 성공 증거가 됩니다. 중단·백그라운드 실행은 `Observed`.
- Claude의 자연어 응답으로는 절대 `Verified`가 되지 않습니다.
- 증거는 이력으로 쌓이고, 조건 상태는 최신 결과를 따릅니다(실패가 성공으로 덮이지 않음).
- 모든 조건이 Verified 또는 Waived일 때만 `complete`가 됩니다.

### 신뢰와 저장

- 자체 네트워크 요청 없음, 모델 추가 호출 없음, 텔레메트리 없음. `/swb ci`와 `/swb issue #n`만 직접 실행할 때 로컬 `gh` CLI를 씁니다.
- 상태는 `$.store`에 프로젝트(작업 디렉터리)별로 저장되어 재시작 후 복원됩니다. 이전 버전에서 저장한 상태도 새 필드를 채워 그대로 읽습니다. 템플릿과 Context set은 프로젝트와 무관하게 저장됩니다. Live Pin 파일 내용, 환경 변수, 대화 기록은 저장하지 않습니다. 툴 기록 100개, 증거 200개로 제한합니다.
- 로컬 명령은 모두 인자 배열로 실행합니다. 턴 종료 시 `git diff -U0 HEAD`, 감사 로그가 켜져 있으면 `git config user.name`, `/swb ci`·`/swb issue`에서 `git`/`gh`. 파일 쓰기는 handoff, `policy init`, `share`, 그리고 Guard 파일이 켠 감사 로그뿐입니다.
- 사용하는 hook과 호출 목록은 `claude plugin validate .`로 확인할 수 있습니다.

### 개발

```text
hooks/register.tsx   이벤트 hook, 명령, 패널·밴드 렌더링 ($를 쓰는 코드는 모두 여기)
hooks/model.ts       상태 변환 (순수 함수)
hooks/risk.ts        위험 규칙과 Guard 프로필
hooks/evidence.ts    검증 명령 분류, 조건 상태, 턴 요약
hooks/intent.ts      계약 직렬화 (결정적)
hooks/context.ts     Pin 범위·Snapshot·직렬화와 주입 조립
hooks/report.ts      handoff Markdown, 툴 행 배지 문구
hooks/policy.ts      프로젝트 Guard 파일 파싱, glob, 규칙 적용
hooks/files.ts       파일 분류, Suggested 선정
hooks/diff.ts        git diff 구간 파싱, 파일별 증거 연결
hooks/team.ts        감사 로그, CI 결과, 이슈 참조, 공유 작업 파일
types/index.d.ts     상태 타입 계약
tests/               claude plugin test
```

```bash
claude plugin validate .
claude plugin test .
claude --plugin-dir .      # 이 폴더를 불러와 세션 실행
```

Claude Code 2.1.292에서 개발·검증했습니다. Mods API는 초기 단계라 버전마다 바뀔 수 있습니다.

### 아직 안 된 것

- 저장소 하나를 넘는 정책 배포(조직 관리형 설정, 서명된 배포), 중앙 감사 저장소, CI·PR 쓰기 동작. SmartWorkbench는 CI와 이슈를 읽기만 하고 쓰지 않습니다.
