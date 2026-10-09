# What SmartWorkbench can do on your machine

A mod runs with your own user rights and is not sandboxed. This page lists everything SmartWorkbench hooks, calls, reads, writes and runs, so you can review it before installing. `claude plugin validate .` prints the same hook and call list from the source.

[English](#english) · [한국어](#한국어)

## English

### Hooks (what it intercepts)

| Hook | Why | If the hook fails |
|---|---|---|
| `session.start` | register `/smartworkbench`, `/swb`, `/workbench` and the `propose_contract_change` tool; restore the project's state; read the guard file | the rest of the session runs without the mod |
| `prompt.submit` | add the locked contract and pins as model-only context; `requireContract` may hold a prompt back | the prompt goes through unchanged |
| `tool.call` | record each call, apply guard rules (allow, ask, block), collect check results | high-risk calls are refused, the rest run normally (fail closed for high risk only) |
| `turn.complete` | completion summary, `git diff -U0 HEAD`, context usage | skipped; the turn is unaffected |
| `command.run` | answer its own commands only | the command prints nothing |
| `ui.render` (`Pane`, `AbovePrompt`, `ToolUse`) | draw the panel, the band and one extra line under tool rows; Claude Code's own rows are kept | Claude Code draws its own |

### Engine calls

`$.clock`, `$.command.register`, `$.tool.register`, `$.state`, `$.store`, `$.fs` (read, write, stat, exists), `$.process.run`, `$.prompt.submit`, `$.session` (cwd, id, messages, usage), `$.ui` (ask, focus, log, open, resolve, toast). No `$.http`, no `$.model`.

### Files

| Reads | When |
|---|---|
| Files you pin | at each prompt (Live) or once (Snapshot) |
| `.claude/smartworkbench.json` | session start, `/swb policy`, after a tool edits it |
| `.claude/smartworkbench-task.json` | `/swb pickup` |
| The audit log | to append, and on `/swb audit` |

| Writes | When |
|---|---|
| `.claude/smartworkbench-handoff.md` (or your path) | `/swb export`, Export handoff |
| `.claude/smartworkbench-task.json` (or your path) | `/swb share` |
| `.claude/smartworkbench.json` | `/swb policy init`, only when absent |
| `.claude/smartworkbench-audit.jsonl` (+ `.1`) | only when the guard file sets `audit` |
| Its own store under `~/.claude/plugins/store/` | state per project, templates, context sets |

It never reads environment variables and never stores the conversation or Live pin contents.

### Processes (argument lists, no shell)

| Command | When |
|---|---|
| `git diff -U0 --no-color --no-ext-diff HEAD` | end of each turn |
| `git rev-parse --abbrev-ref HEAD` | `/swb new`, to draft a goal |
| `git config user.name` | session start, only when audit is on |
| `git rev-parse HEAD`, `git status --porcelain`, `gh run list …` | `/swb ci`, Check CI |
| `gh issue view …` | `/swb issue #n` |

### Network

None of its own. `gh` reaches GitHub only when you run `/swb ci` or `/swb issue` with a GitHub reference.

### Model

No extra model calls. Explain, Retry, Fix failures and Ask Claude to finish send a normal prompt in your session, only when you press them.

## 한국어

Mod는 사용자 권한 그대로 실행되며 샌드박스가 없습니다. 설치 전에 검토할 수 있도록 SmartWorkbench가 가로채는 것, 호출하는 것, 읽고 쓰는 파일, 실행하는 명령을 모두 적었습니다. `claude plugin validate .`도 소스에서 같은 hook·호출 목록을 출력합니다.

### Hook (가로채는 지점)

| Hook | 용도 | hook이 실패하면 |
|---|---|---|
| `session.start` | `/smartworkbench`·`/swb`·`/workbench` 명령과 `propose_contract_change` 툴 등록, 프로젝트 상태 복원, Guard 파일 읽기 | 이 세션은 Mod 없이 진행 |
| `prompt.submit` | 잠긴 계약과 Pin을 Claude만 읽는 컨텍스트로 추가, `requireContract`면 프롬프트 보류 | 프롬프트는 그대로 전송 |
| `tool.call` | 호출 기록, Guard 규칙 적용(허용·질문·차단), 검증 결과 수집 | 고위험 호출만 거부, 나머지는 정상 실행 |
| `turn.complete` | 완료 요약, `git diff -U0 HEAD`, 컨텍스트 사용량 | 건너뜀(턴에는 영향 없음) |
| `command.run` | 자기 명령에만 응답 | 명령 출력 없음 |
| `ui.render` (`Pane`, `AbovePrompt`, `ToolUse`) | 패널·밴드, 툴 행 아래 한 줄 추가(기본 행은 유지) | Claude Code 기본 화면 |

### 엔진 호출

`$.clock`, `$.command.register`, `$.tool.register`, `$.state`, `$.store`, `$.fs`(읽기·쓰기·stat·exists), `$.process.run`, `$.prompt.submit`, `$.session`(cwd·id·messages·usage), `$.ui`(ask·focus·log·open·resolve·toast). `$.http`와 `$.model`은 쓰지 않습니다.

### 파일

| 읽기 | 시점 |
|---|---|
| Pin한 파일 | 프롬프트마다(Live) 또는 한 번(Snapshot) |
| `.claude/smartworkbench.json` | 세션 시작, `/swb policy`, 툴이 이 파일을 고친 직후 |
| `.claude/smartworkbench-task.json` | `/swb pickup` |
| 감사 로그 | 덧붙일 때, `/swb audit` |

| 쓰기 | 시점 |
|---|---|
| `.claude/smartworkbench-handoff.md`(또는 지정 경로) | `/swb export`, Export handoff |
| `.claude/smartworkbench-task.json`(또는 지정 경로) | `/swb share` |
| `.claude/smartworkbench.json` | `/swb policy init`, 파일이 없을 때만 |
| `.claude/smartworkbench-audit.jsonl`(+ `.1`) | Guard 파일에서 `audit`을 켰을 때만 |
| `~/.claude/plugins/store/` 아래 자기 저장소 | 프로젝트별 상태, 템플릿, Context set |

환경 변수는 읽지 않고, 대화 내용과 Live Pin 파일 내용은 저장하지 않습니다.

### 실행하는 명령 (인자 배열, 셸 없음)

| 명령 | 시점 |
|---|---|
| `git diff -U0 --no-color --no-ext-diff HEAD` | 턴마다 |
| `git rev-parse --abbrev-ref HEAD` | `/swb new`(목표 초안) |
| `git config user.name` | 세션 시작, 감사 로그가 켜졌을 때만 |
| `git rev-parse HEAD`, `git status --porcelain`, `gh run list …` | `/swb ci`, Check CI |
| `gh issue view …` | `/swb issue #n` |

### 네트워크

자체 요청은 없습니다. `gh`가 GitHub에 접속하는 것은 `/swb ci` 또는 GitHub 이슈 번호로 `/swb issue`를 실행할 때뿐입니다.

### 모델

추가 모델 호출은 없습니다. Explain, Retry, Fix failures, Ask Claude to finish는 누를 때만 현재 세션에 일반 프롬프트를 보냅니다.
