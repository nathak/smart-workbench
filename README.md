# SmartWorkbench for Claude Code

[English](#english) · [한국어](#한국어)

---

## English

A Claude Code mod for seeing and steering the **Intent, Context, Run and Evidence** of the work you hand to Claude, without leaving Claude Code.
Implements P0 (first public release) and P1 (product hardening) of the product spec (v0.1).

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
7. **Pick it up later**: state is restored when you reopen the project. Save a setup you reuse with `/swb save <name>`.

To use the panel from the keyboard, focus it with `ctrl+x tab` (or click it). Hotkeys: `1`–`4` tabs, `l` Lock/Unlock, `p` Preview, `r` Pause risky calls, `f` Ask Claude to finish, `x` Export handoff.

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
| `/swb clear` | Reset this project's state |

#### `/swb`
Opens the SmartWorkbench panel on the last tab used. Where no panel can be shown, it prints the same text as `/swb status` instead.

#### `/swb new`
Starts a fresh task contract and opens the Intent tab. If a goal is already set it asks first (`Start new` / `Keep current`). The goal, constraints, non-goals, done conditions, evidence and changed-file record are cleared and the contract is unlocked. Pins, tool call history and the guard profile are kept.

#### `/swb intent` · `/swb context` · `/swb run` · `/swb verify`
Open the panel on that tab. `/swb evidence` is the same as `/swb verify`.

#### `/swb status`
Prints a text summary: the band line, the goal with its lock and status, active constraints, pins, the project guard file if there is one, and every done condition with its result. Use it where no UI is drawn (VS Code chat, `claude -p`, remote surfaces) or to paste the state somewhere.

#### `/swb preview`
Prints exactly the context SmartWorkbench adds to each prompt: the locked contract (`<smartworkbench_contract>`) and the pinned files and notes (`<smartworkbench_pins>`), plus a warning for any pin that cannot be read. An unlocked contract is not added, so with nothing locked or pinned it says nothing is added. The Context tab's `Preview` button shows the same text.

#### `/swb save <name>`
Saves the current setup as a template: goal, constraints, non-goals, done conditions (wording and evidence link), pins and guard profile. Results (evidence, history, changed files) are not saved. Templates are shared by all your projects, and saving under an existing name replaces it.

#### `/swb load <name>`
Starts a task from a template and opens the Intent tab. If a goal is already set it asks first (`Load template` / `Keep current`). The task comes in unlocked with no evidence, and the template's pins and guard profile **replace** the current ones. With an unknown name it lists the templates you have.

#### `/swb templates`
Lists saved templates and context sets. Context sets are saved and added from the Context tab (`save pins as a context set`, `Add set`); adding a set merges its pins into the current ones and skips any already pinned.

#### `/swb export [path]`
Writes a Markdown handoff for the next session or developer, by default to `.claude/smartworkbench-handoff.md` (the Evidence tab's `Export handoff` does the same). It holds the status, goal, constraints and non-goals; each done condition with its result and the command or manual note behind it, flagged when code changed after it passed; pinned context; changed files with their regions and whether a check passed after the last edit; the last 10 verification runs; and blocked or declined calls. Exporting again overwrites the file. It lands inside the project, so add it to `.gitignore` or pass another path if it should not be committed.

#### `/swb policy [init|reload]`
- `/swb policy` (or `reload`): re-reads `.claude/smartworkbench.json` and prints its profile, rules and any errors.
- `/swb policy init`: writes an example file when none exists, then shows it. Edit and commit it to share the rules with the team (see *Project guard file*).

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

- Ask uses Claude Code's own question dialog (`$.ui.ask`); an allowed call still goes through Claude Code's own permission check.
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
  ]
}
```

- A `profile` there replaces the personal setting (shown as `STRICT*` in the band).
- Rules are checked top to bottom and the first match applies. `tool` and `command` are regular expressions; `path` is a glob (`**`, `*`, `?`).
- The file can only **tighten** the guard. A built-in Block, a secrets Ask and the Ask on editing this file cannot be loosened by an `allow` rule.
- It is read at session start and right after a tool edits it. After editing it by hand, run `/smartworkbench policy reload`.
- Broken rules are skipped and reported, never guessed at.

### How completion is judged

- Only known verification commands that finish without error count as passing evidence. Interrupted or backgrounded runs are `Observed`.
- Claude's own words never make a condition `Verified`.
- Evidence is kept as history and a condition follows the latest result (a failure is never overwritten by an older pass).
- The task becomes `complete` only when every condition is Verified or Waived.

### Trust and storage

- No network requests, no extra model calls, no telemetry.
- State is kept in `$.store` per project (working directory) and restored on restart; state saved by an earlier version is filled in on load. Templates and context sets are kept across projects. Live pin contents, environment variables and the conversation are not stored. History is capped at 100 tool calls and 200 evidence records.
- The only local command is `git diff -U0 HEAD`, run with an argument list. The only file written is the handoff you ask for (and the guard file on `policy init`).
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

- P2: team audit log, shared done-condition templates, CI/GitHub integration, MCP-based issue and deploy tools, sharing state between sessions

---

## 한국어

Claude에게 맡긴 작업의 **목표(Intent)·맥락(Context)·실행(Run)·검증(Evidence)** 을 Claude Code 안에서 직접 보고 통제하는 Mod입니다.
기획서: NAS `claude-mods/smart-workbench/smartworkbench-prd.md` (v0.1). P0(최초 공개 버전)와 P1(제품성 강화)을 구현했습니다.

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
7. **다음에 이어 하기**: 프로젝트를 다시 열면 상태가 복원됩니다. 자주 쓰는 설정은 `/swb save <이름>`으로 저장해 둡니다.

키보드로 패널을 쓰려면 `ctrl+x tab`(또는 클릭)으로 패널에 포커스를 옮깁니다. 단축키: `1`–`4` 탭 전환, `l` 잠금/해제, `p` Preview, `r` 위험 호출 일시정지, `f` Ask Claude to finish, `x` Export handoff.

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
| `/swb clear` | 이 프로젝트 상태 초기화 |

#### `/swb`
SmartWorkbench 패널을 마지막에 보던 탭으로 엽니다. 패널을 띄울 수 없는 환경에서는 대신 `/swb status`와 같은 텍스트를 보여 줍니다.

#### `/swb new`
새 작업 계약을 시작하고 Intent 탭을 엽니다. 이미 목표가 있으면 먼저 묻습니다(`Start new` / `Keep current`). 목표·제약·하지 않을 일·완료 조건·증거·변경 파일 기록을 비우고 잠금을 풉니다. Pin, 툴 호출 기록, Guard 프로필은 유지됩니다.

#### `/swb intent` · `/swb context` · `/swb run` · `/swb verify`
해당 탭으로 패널을 엽니다. `/swb evidence`는 `/swb verify`와 같습니다.

#### `/swb status`
텍스트 요약을 출력합니다. 밴드 줄, 목표와 잠금·진행 상태, 켜진 제약, Pin 목록, 프로젝트 Guard 파일(있을 때), 완료 조건별 결과가 들어갑니다. UI가 없는 환경(VS Code 채팅, `claude -p`, 원격 화면)이나 상태를 어딘가에 붙여 넣을 때 씁니다.

#### `/swb preview`
SmartWorkbench가 매 프롬프트에 붙이는 내용을 그대로 보여 줍니다. 잠긴 계약(`<smartworkbench_contract>`)과 Pin한 파일·메모(`<smartworkbench_pins>`), 읽을 수 없는 Pin에 대한 경고가 나옵니다. 잠기지 않은 계약은 붙지 않으므로, 잠금도 Pin도 없으면 붙는 것이 없다고 알려 줍니다. Context 탭의 `Preview` 버튼과 같은 내용입니다.

#### `/swb save <name>`
현재 설정을 템플릿으로 저장합니다. 목표, 제약, 하지 않을 일, 완료 조건(문구와 증거 연결), Pin, Guard 프로필이 들어가고, 결과(증거·기록·변경 파일)는 저장하지 않습니다. 템플릿은 모든 프로젝트에서 공유되며, 같은 이름으로 저장하면 덮어씁니다.

#### `/swb load <name>`
템플릿으로 작업을 시작하고 Intent 탭을 엽니다. 이미 목표가 있으면 먼저 묻습니다(`Load template` / `Keep current`). 작업은 잠금 해제·증거 없음 상태로 들어오고, 템플릿의 Pin과 Guard 프로필이 현재 것을 **대체**합니다. 없는 이름이면 가진 템플릿 목록을 보여 줍니다.

#### `/swb templates`
저장된 템플릿과 Context set 목록을 보여 줍니다. Context set은 Context 탭에서 저장(`save pins as a context set`)하고 추가(`Add set`)합니다. Set을 추가하면 현재 Pin에 합쳐지고, 이미 Pin된 것은 건너뜁니다.

#### `/swb export [path]`
다음 세션이나 다른 개발자에게 넘길 Markdown handoff를 씁니다. 기본 위치는 `.claude/smartworkbench-handoff.md`이고, Evidence 탭의 `Export handoff` 버튼과 같습니다. 진행 상태, 목표·제약·하지 않을 일, 완료 조건별 결과와 근거(명령 또는 수동 메모, 통과 뒤 코드가 바뀌었으면 표시), Pin한 자료, 변경 파일별 구간과 마지막 수정 뒤 검증 여부, 최근 검증 실행 10건, 차단·거절된 호출이 들어갑니다. 다시 내보내면 덮어씁니다. 프로젝트 안에 저장되므로 커밋하지 않으려면 `.gitignore`에 넣거나 다른 경로를 지정하세요.

#### `/swb policy [init|reload]`
- `/swb policy`(또는 `reload`): `.claude/smartworkbench.json`을 다시 읽고 프로필, 규칙, 오류를 보여 줍니다.
- `/swb policy init`: 파일이 없을 때 예시 파일을 만들고 내용을 보여 줍니다. 고쳐서 커밋하면 팀이 같은 규칙을 씁니다(아래 *프로젝트 Guard 파일* 참고).

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

- Ask는 Claude Code의 공식 질문 창(`$.ui.ask`)으로 묻고, Allow여도 Claude Code 기존 권한 검사를 그대로 거칩니다.
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
  ]
}
```

- `profile`이 있으면 개인 설정 대신 그 프로필을 씁니다(밴드에 `STRICT*`로 표시).
- 규칙은 위에서부터 처음 맞는 것 하나가 적용됩니다. `tool`·`command`는 정규식, `path`는 glob(`**`, `*`, `?`)입니다.
- 저장소 파일은 Guard를 **강화만** 할 수 있습니다. 기본 Block, 비밀값 관련 Ask, 이 파일 자체의 수정에 대한 Ask는 `allow` 규칙으로 풀리지 않습니다.
- 세션 시작 시와 툴로 이 파일을 수정한 직후 다시 읽습니다. 직접 고쳤다면 `/smartworkbench policy reload`.
- 잘못된 규칙은 건너뛰고 오류를 표시합니다(추측해서 적용하지 않음).

### 완료 판정

- 종료 코드가 0인(오류 없는) 알려진 검증 명령만 성공 증거가 됩니다. 중단·백그라운드 실행은 `Observed`.
- Claude의 자연어 응답으로는 절대 `Verified`가 되지 않습니다.
- 증거는 이력으로 쌓이고, 조건 상태는 최신 결과를 따릅니다(실패가 성공으로 덮이지 않음).
- 모든 조건이 Verified 또는 Waived일 때만 `complete`가 됩니다.

### 신뢰와 저장

- 네트워크 요청 없음, 모델 추가 호출 없음, 텔레메트리 없음.
- 상태는 `$.store`에 프로젝트(작업 디렉터리)별로 저장되어 재시작 후 복원됩니다. 이전 버전에서 저장한 상태도 새 필드를 채워 그대로 읽습니다. 템플릿과 Context set은 프로젝트와 무관하게 저장됩니다. Live Pin 파일 내용, 환경 변수, 대화 기록은 저장하지 않습니다. 툴 기록 100개, 증거 200개로 제한합니다.
- 로컬 명령은 `git diff -U0 HEAD` 하나뿐이며 인자 배열로 실행합니다. 파일 쓰기는 사용자가 요청한 handoff 내보내기(와 `policy init`의 Guard 파일)뿐입니다.
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

- P2: 팀 감사 로그, 조직 공통 Done Condition 템플릿 배포, CI/GitHub 연동, MCP 기반 이슈·배포 도구 연동, 여러 세션 간 상태 교환
