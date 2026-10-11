# What SmartWorkbench can do on your machine

A mod runs with your own user rights and is not sandboxed. This page lists everything SmartWorkbench hooks, calls, reads, writes and runs, so you can review it before installing. `claude plugin validate .` prints the same hook and call list from the source.

[English](#english) · [한국어](#한국어)

## English

### Hooks (what it intercepts)

| Hook | Why | If the hook fails |
|---|---|---|
| `session.start` | register `/smartworkbench`, `/swb`, `/workbench` and the `propose_contract_change` tool; restore the project's state; read the guard file | the rest of the session runs without the mod |
| `prompt.submit` | add the locked contract and pins as model-only context; `requireContract` may hold a prompt back; a prompt you type ends a running `/swb loop` | the prompt goes through unchanged |
| `tool.call` | record each call, apply guard rules (allow, ask, block), collect check results | high-risk calls are refused, the rest run normally (fail closed for high risk only) |
| `turn.complete` | completion summary, `git diff -U0 HEAD`, context usage | skipped; the turn is unaffected |
| `classic.Stop` | team mode's final check: hold a turn that changed code once for an Opus review; `/swb loop` holds the stop to start the next pass | the turn ends normally |
| `command.run` | answer its own commands only | the command prints nothing |
| `ui.render` (`Pane`, `AbovePrompt`, `ToolUse`) | draw the panel, the band and one extra line under tool rows; Claude Code's own rows are kept | Claude Code draws its own |

### Engine calls

`$.clock`, `$.command.register`, `$.tool.register`, `$.agent.register`, `$.config` (list, set: only the model row, by team mode), `$.command.run` (only `/effort`, when you pick a lead effort in team mode; Claude Code keeps it as that model's default), `$.state`, `$.store`, `$.fs` (read, write, stat, exists), `$.process.run`, `$.process.spawn` (only `/swb live`), `$.plugin.root`, `$.prompt.submit`, `$.session` (cwd, id, messages, usage), `$.ui` (ask, focus, log, open, resolve, toast). No `$.http`, no `$.model`.

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
| `.claude/smartworkbench-live.jsonl` | `/swb live` creates it once the server is listening and removes it when the server ends; while it exists the mod appends one JSON line per event (prompt start, tool name and summary, guard decision, loop, turn). Do not commit it; one live view per project |
| Its own store under `~/.claude/plugins/store/` | state per project, templates, context sets |

It never reads environment variables and never stores the conversation or Live pin contents. The one exception is the live feed below: while you run `/swb live`, the start of each prompt (120 characters) and a summary of each tool call are appended to a file inside the project.

### Processes (argument lists, no shell)

| Command | When |
|---|---|
| `git diff -U0 --no-color --no-ext-diff HEAD` | end of each turn |
| `git rev-parse --abbrev-ref HEAD` | `/swb new`, to draft a goal |
| `git config user.name` | session start, only when audit is on |
| `git rev-parse HEAD`, `git status --porcelain`, `gh run list …` | `/swb ci`, Check CI |
| `gh issue view …` | `/swb issue #n` |
| `tee -a <project>/.claude/smartworkbench-live.jsonl` (the line goes in on stdin) | each event, only while the live feed file exists |
| `node <plugin>/tools/live.mjs <project> --port <n>` | `/swb live`; kept as a child and ended by `/swb live stop`, the end of the session or a reload |

### Network

None of its own. `/swb live` starts a local web server that listens on `127.0.0.1` only (default port 4317) and answers only requests whose Host is `127.0.0.1`, `localhost`, or a name listed in the `SWB_LIVE_HOSTS` environment variable (comma separated, none by default); it makes no outgoing requests. `gh` reaches GitHub only when you run `/swb ci` or `/swb issue` with a GitHub reference.

### Model

No extra model calls of its own. Explain, Retry, Fix failures and Ask Claude to finish send a normal prompt in your session, only when you press them. In team mode Claude runs the Haiku explorer and the Opus advisor as subagents; the mod only asks it to.

## 한국어

Mod는 사용자 권한 그대로 실행되며 샌드박스가 없습니다. 설치 전에 검토할 수 있도록 SmartWorkbench가 가로채는 것, 호출하는 것, 읽고 쓰는 파일, 실행하는 명령을 모두 적었습니다. `claude plugin validate .`도 소스에서 같은 hook·호출 목록을 출력합니다.

### Hook (가로채는 지점)

| Hook | 용도 | hook이 실패하면 |
|---|---|---|
| `session.start` | `/smartworkbench`·`/swb`·`/workbench` 명령과 `propose_contract_change` 툴 등록, 프로젝트 상태 복원, Guard 파일 읽기 | 이 세션은 Mod 없이 진행 |
| `prompt.submit` | 잠긴 계약과 Pin을 Claude만 읽는 컨텍스트로 추가, `requireContract`면 프롬프트 보류, 직접 입력한 프롬프트는 실행 중인 `/swb loop`를 종료 | 프롬프트는 그대로 전송 |
| `tool.call` | 호출 기록, Guard 규칙 적용(허용·질문·차단), 검증 결과 수집 | 고위험 호출만 거부, 나머지는 정상 실행 |
| `turn.complete` | 완료 요약, `git diff -U0 HEAD`, 컨텍스트 사용량 | 건너뜀(턴에는 영향 없음) |
| `classic.Stop` | 팀 모드 마무리 점검: 코드를 고친 턴을 Opus 검토 전에 한 번 붙잡음, `/swb loop`는 다음 회차를 시작하려고 종료를 붙잡음 | 턴이 정상 종료 |
| `command.run` | 자기 명령에만 응답 | 명령 출력 없음 |
| `ui.render` (`Pane`, `AbovePrompt`, `ToolUse`) | 패널·밴드, 툴 행 아래 한 줄 추가(기본 행은 유지) | Claude Code 기본 화면 |

### 엔진 호출

`$.clock`, `$.command.register`, `$.tool.register`, `$.agent.register`, `$.config`(list, set: 팀 모드가 모델 행만 바꿈), `$.command.run`(팀 모드에서 Lead effort를 고를 때의 `/effort`만. Claude Code가 그 모델의 기본값으로 저장), `$.state`, `$.store`, `$.fs`(읽기·쓰기·stat·exists), `$.process.run`, `$.process.spawn`(`/swb live`에서만), `$.plugin.root`, `$.prompt.submit`, `$.session`(cwd·id·messages·usage), `$.ui`(ask·focus·log·open·resolve·toast). `$.http`와 `$.model`은 쓰지 않습니다.

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
| `.claude/smartworkbench-live.jsonl` | `/swb live`의 서버가 포트를 연 뒤 만들고 종료할 때 지웁니다. 파일이 있는 동안 Mod가 이벤트(프롬프트 앞부분, 툴 이름·요약, Guard 판정, 루프, 턴)마다 JSON 한 줄을 덧붙입니다. 커밋하지 마세요. 프로젝트당 실시간 보기는 하나만 |
| `~/.claude/plugins/store/` 아래 자기 저장소 | 프로젝트별 상태, 템플릿, Context set |

환경 변수는 읽지 않고, 대화 내용과 Live Pin 파일 내용은 저장하지 않습니다. 예외는 아래의 실시간 피드뿐입니다. `/swb live`를 실행하는 동안에는 프롬프트 앞부분(120자)과 툴 호출 요약이 프로젝트 안의 파일에 덧붙습니다.

### 실행하는 명령 (인자 배열, 셸 없음)

| 명령 | 시점 |
|---|---|
| `git diff -U0 --no-color --no-ext-diff HEAD` | 턴마다 |
| `git rev-parse --abbrev-ref HEAD` | `/swb new`(목표 초안) |
| `git config user.name` | 세션 시작, 감사 로그가 켜졌을 때만 |
| `git rev-parse HEAD`, `git status --porcelain`, `gh run list …` | `/swb ci`, Check CI |
| `gh issue view …` | `/swb issue #n` |
| `tee -a <프로젝트>/.claude/smartworkbench-live.jsonl`(한 줄을 stdin으로 전달) | 이벤트마다, 실시간 피드 파일이 있을 때만 |
| `node <플러그인>/tools/live.mjs <프로젝트> --port <n>` | `/swb live`. 자식 프로세스로 두고 `/swb live stop`, 세션 종료, 리로드 때 끝남 |

### 네트워크

자체 요청은 없습니다. `/swb live`는 `127.0.0.1`에서만 듣는 로컬 웹 서버(기본 포트 4317)를 띄우며, Host가 `127.0.0.1`, `localhost`, 또는 환경변수 `SWB_LIVE_HOSTS`(쉼표 구분, 기본값 없음)에 적은 이름인 요청에만 응답하고 밖으로 나가는 요청은 없습니다. `gh`가 GitHub에 접속하는 것은 `/swb ci` 또는 GitHub 이슈 번호로 `/swb issue`를 실행할 때뿐입니다.

### 모델

자체 모델 호출은 없습니다. Explain, Retry, Fix failures, Ask Claude to finish는 누를 때만 현재 세션에 일반 프롬프트를 보냅니다. 팀 모드에서는 Claude가 Haiku 탐색 에이전트와 Opus 조언자를 서브에이전트로 실행하고, Mod는 그렇게 하도록 요청만 합니다.
