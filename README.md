# SmartWorkbench for Claude Code

Claude에게 맡긴 작업의 **목표(Intent)·맥락(Context)·실행(Run)·검증(Evidence)** 을 Claude Code 안에서 직접 보고 통제하는 Mod입니다.
기획서: NAS `claude-mods/smart-workbench/smartworkbench-prd.md` (v0.1). P0(최초 공개 버전) 전체와 P1 일부를 구현했습니다.

## 설치

Claude Code 입력창에서:

```
/plugin install smartworkbench --marketplace nathak/smart-workbench
```

마켓플레이스 추가를 물으면 `y`, 설치 범위는 user를 고릅니다. 비공개 저장소이므로 그 컴퓨터의 git이 GitHub에 로그인되어 있어야 합니다(`gh auth login` 등). 업데이트는 `claude plugin update smartworkbench`.

## 사용법

| 명령 | 동작 |
|---|---|
| `/smartworkbench` (`/swb`) | 패널 열기 |
| `/smartworkbench new` | 새 작업 계약 시작 (기존 계약이 있으면 확인) |
| `/smartworkbench context` · `run` · `verify` | 해당 탭 열기 |
| `/smartworkbench status` | 텍스트 요약 (UI가 없는 환경용 폴백) |
| `/smartworkbench preview` | 프롬프트마다 추가되는 컨텍스트 그대로 보기 |
| `/smartworkbench save <name>` | 계약·Pin·Guard 프로필을 템플릿으로 저장 |
| `/smartworkbench load <name>` | 템플릿으로 새 작업 시작 (증거는 비움, 잠금 해제 상태) |
| `/smartworkbench templates` | 템플릿과 Context set 목록 |
| `/smartworkbench export [path]` | Markdown handoff 쓰기 (기본 `.claude/smartworkbench-handoff.md`) |
| `/smartworkbench clear` | 이 프로젝트의 상태 초기화 (확인 필요) |

`/workbench`는 한동안 유지되는 deprecated 별칭입니다.

- **Intent**: Goal, Constraints(`[H]`/`[S]`, 켜기/끄기, `s:` 접두어로 Soft 추가), Done conditions, Non-goals. **Lock** 하면 계약이 `<smartworkbench_contract>`로 매 프롬프트에 추가 컨텍스트로 붙습니다(사용자 메시지 본문은 그대로). 잠긴 동안은 편집할 수 없습니다.
- **Context**: 파일과 메모를 Pin. 파일은 `path:10-40`(또는 `path#L10-L40`)로 라인 범위만 Pin할 수 있고, Pin마다 `Live`(전송 시점에 다시 읽음)와 `Snap`(Pin한 시점의 내용과 SHA-256 보존, 64KB 이하)을 전환합니다. 현재 Pin 묶음을 이름 붙여 Context set으로 저장하고 다른 프로젝트에서 `Add set`으로 추가할 수 있습니다. Claude가 읽거나 수정한 파일은 OBSERVED에 표시되고 `Pin`으로 바로 고정할 수 있습니다. 토큰 수는 `~`가 붙은 추정치입니다. **Preview**는 실제로 주입되는 텍스트와 같은 함수로 만듭니다. 읽을 수 없는 Pin은 전송을 막지 않고 경고만 냅니다.
- **Run**: 모든 툴 호출을 기록하고 위험도를 매깁니다. Guard 프로필(Permissive / Balanced / Strict)과 `Pause risky calls`.
- **Evidence**: 테스트·빌드·타입 검사·린트 명령의 결과를 자동 수집하고, Done condition에 증거 종류를 연결합니다(조건 문구로 자동 추정, 변경 가능). `Verify`/`Waive`는 수동 표시이며 메모와 시각이 남습니다. 턴이 끝나면 완료 요약을 대화에 남깁니다. `Export handoff`로 다음 세션이나 다른 개발자에게 넘길 Markdown을 씁니다.
- **툴 행 배지**: 대화의 기본 툴 행은 그대로 두고, 위험도·정책 결과(Blocked/Declined/Asked)나 검증 결과(`test passed · evidence for dc-1`)가 있을 때만 한 줄을 덧붙입니다.

입력창 위 밴드: `WB ● 목표 │ Ctx +2 pins · 42% │ Done 1/2 │ Guard BALANCED [Open]`

## 기본 Guard 규칙 (Balanced)

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

## 완료 판정

- 종료 코드가 0인(오류 없는) 알려진 검증 명령만 성공 증거가 됩니다. 중단·백그라운드 실행은 `Observed`.
- Claude의 자연어 응답으로는 절대 `Verified`가 되지 않습니다.
- 증거는 이력으로 쌓이고, 조건 상태는 최신 결과를 따릅니다(실패가 성공으로 덮이지 않음).
- 모든 조건이 Verified 또는 Waived일 때만 `complete`가 됩니다.

## 신뢰와 저장

- 네트워크 요청 없음, 모델 추가 호출 없음, 텔레메트리 없음.
- 상태는 `$.store`에 프로젝트(작업 디렉터리)별로 저장되어 재시작 후 복원됩니다. 템플릿과 Context set은 프로젝트와 무관하게 저장됩니다. Live Pin 파일 내용, 환경 변수, 대화 기록은 저장하지 않습니다. 툴 기록 100개, 증거 200개로 제한합니다.
- 로컬 명령은 `git diff --numstat HEAD` 하나뿐이며 인자 배열로 실행합니다. 파일 쓰기는 사용자가 요청한 handoff 내보내기뿐입니다.
- 사용하는 hook과 호출 목록은 `claude plugin validate .`로 확인할 수 있습니다.

## 개발

```text
hooks/register.tsx   이벤트 hook, 명령, 패널·밴드 렌더링 ($를 쓰는 코드는 모두 여기)
hooks/model.ts       상태 변환 (순수 함수)
hooks/risk.ts        위험 규칙과 Guard 프로필
hooks/evidence.ts    검증 명령 분류, 조건 상태, 턴 요약
hooks/intent.ts      계약 직렬화 (결정적)
hooks/context.ts     Pin 범위·Snapshot·직렬화와 주입 조립
hooks/report.ts      handoff Markdown, 툴 행 배지 문구
types/index.d.ts     상태 타입 계약
tests/               claude plugin test
```

```bash
claude plugin validate .
claude plugin test .
claude --plugin-dir .      # 이 폴더를 불러와 세션 실행
```

Claude Code 2.1.292에서 개발·검증했습니다. Mods API는 초기 단계라 버전마다 바뀔 수 있습니다.

## 아직 안 된 것

- P1: 저장소에 두는 프로젝트별 Guard 프로필 파일, Observed 파일 자동 분류, Git diff 구간과 증거의 세부 연결
- P2: 팀 정책 파일, 조직 공통 템플릿, 감사 로그, CI/GitHub 연동
