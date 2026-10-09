# SmartWorkbench sample project

A tiny project with one failing test, to try SmartWorkbench end to end in about a minute.

[English](#english) · [한국어](#한국어)

## English

```bash
cp -r examples/sample-project /tmp/swb-sample && cd /tmp/swb-sample
git init -q && git add -A && git commit -qm init
claude            # with SmartWorkbench installed (or: claude --plugin-dir <path to this repo>)
```

1. `/swb new`: the task starts from the team template `bugfix` in `.claude/smartworkbench.json` (two constraints, one done condition, one non-goal).
2. Write the goal, for example `Sessions last 30 minutes`, then `/swb lock`.
3. Ask Claude: `Fix the session expiry bug and run npm test.`
4. Watch the Run tab; `npm publish` would be blocked and an edit to `package.json` asked, by the project rules.
5. When the turn ends, the Evidence tab shows whether `Related tests pass` was verified, which changed regions of `src/auth.js` a passing test ran after, and the band offers the next step.
6. `/swb audit` shows what the guard decided; `/swb export` writes a handoff.

The test fails on purpose: `SESSION_TTL_MINUTES` is 5 where it should be 30.

## 한국어

```bash
cp -r examples/sample-project /tmp/swb-sample && cd /tmp/swb-sample
git init -q && git add -A && git commit -qm init
claude            # SmartWorkbench가 설치된 상태 (또는: claude --plugin-dir <이 저장소 경로>)
```

1. `/swb new`: `.claude/smartworkbench.json`의 팀 템플릿 `bugfix`로 시작합니다(제약 2개, 완료 조건 1개, 하지 않을 일 1개).
2. 목표를 씁니다(예: `Sessions last 30 minutes`). 그다음 `/swb lock`.
3. Claude에게 요청합니다: `세션 만료 버그 고치고 npm test 돌려줘`.
4. Run 탭을 봅니다. 프로젝트 규칙에 따라 `npm publish`는 차단되고 `package.json` 수정은 먼저 묻습니다.
5. 턴이 끝나면 Evidence 탭에서 `Related tests pass`가 검증됐는지, `src/auth.js`의 어느 변경 구간 뒤에 통과한 테스트가 있는지 보이고, 밴드가 다음 단계를 제안합니다.
6. `/swb audit`으로 Guard 판정 기록을, `/swb export`로 handoff를 봅니다.

테스트는 일부러 실패합니다. `SESSION_TTL_MINUTES`가 30이어야 하는데 5입니다.
