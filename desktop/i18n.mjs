// UI strings of the app in Korean and English. The language follows the system locale; SWB_DESKTOP_LANG=ko|en overrides it.
const STRINGS = {
  en: {
    open: 'Open monitor',
    sessions: n => (n === 0 ? 'No sessions' : `${n} session${n === 1 ? '' : 's'}`),
    hubDown: 'Monitor server is restarting…',
    autoJoin: 'New sessions join automatically',
    livePrompts: 'Show full prompts in the monitor',
    notifyAsk: 'Notify when a question waits',
    notifyQuiet: 'Notify when a session goes quiet',
    notifyEnd: 'Notify when a session ends',
    login: 'Start at login',
    quit: 'Quit',
    askTitle: project => `${project}: waiting for your answer`,
    askBody: tool => `Tool: ${tool}`,
    quietTitle: project => `${project}: no activity`,
    quietBody: 'The session stopped reporting but its process still runs.',
    endTitle: project => `${project}: session ended`,
    endBody: 'The session is no longer running.',
    status: 'Sessions',
    ui: {
      title: 'SmartWorkbench sessions', hubUp: 'Monitor server running', hubDown: 'Monitor server not reachable', none: 'No session yet. Start Claude Code in a project.',
      alive: 'running', quiet: 'quiet', ended: 'ended', noSnapshot: 'No state yet (it appears after the first change in the session while this app runs).',
      rev: 'revision', locked: 'locked', soft: 'soft', off: 'off', on: 'on', noGoal: '(no goal yet)', constraints: 'Constraints', done: 'Done conditions', nonGoals: 'Non-goals',
      team: 'Team mode', guard: 'Guard', paused: 'paused', fileProfile: 'guard file:', rules: 'rules', evidence: 'Evidence', proposals: 'Proposals from Claude', pass: 'passed', fail: 'failed', running: 'running',
      scope: { session: 'own copy', project: 'shared by the project' },
      status: { draft: 'draft', active: 'active', verifying: 'verifying', complete: 'complete' },
      cond: { pending: 'pending', observed: 'observed', verified: 'verified', failed: 'failed', waived: 'waived' },
    },
  },
  ko: {
    open: '모니터 열기',
    sessions: n => (n === 0 ? '세션 없음' : `세션 ${n}개`),
    hubDown: '모니터 서버를 다시 시작하는 중…',
    autoJoin: '새 세션 자동 연결',
    livePrompts: '모니터에 프롬프트 전체 표시',
    notifyAsk: '확인 대기 시 알림',
    notifyQuiet: '세션이 조용해지면 알림',
    notifyEnd: '세션 종료 시 알림',
    login: '로그인 시 시작',
    quit: '종료',
    askTitle: project => `${project}: 답변을 기다리는 중`,
    askBody: tool => `도구: ${tool}`,
    quietTitle: project => `${project}: 활동 없음`,
    quietBody: '세션이 보고를 멈췄지만 프로세스는 아직 실행 중입니다.',
    endTitle: project => `${project}: 세션 종료`,
    endBody: '세션이 더 이상 실행되지 않습니다.',
    status: '세션 상태',
    ui: {
      title: 'SmartWorkbench 세션', hubUp: '모니터 서버 실행 중', hubDown: '모니터 서버에 연결할 수 없음', none: '아직 세션이 없습니다. 프로젝트에서 Claude Code를 시작하세요.',
      alive: '실행 중', quiet: '조용함', ended: '종료', noSnapshot: '아직 상태가 없습니다(앱이 켜진 동안 세션에서 첫 변경이 생기면 나타납니다).',
      rev: '리비전', locked: '잠김', soft: '권장', off: '꺼짐', on: '켜짐', noGoal: '(아직 목표 없음)', constraints: '제약', done: '완료 조건', nonGoals: '비목표',
      team: '팀 모드', guard: 'Guard', paused: '일시정지', fileProfile: 'guard 파일:', rules: '규칙', evidence: '증거', proposals: 'Claude의 제안', pass: '통과', fail: '실패', running: '실행 중',
      scope: { session: '세션 전용 사본', project: '프로젝트 공유' },
      status: { draft: '초안', active: '진행 중', verifying: '검증 중', complete: '완료' },
      cond: { pending: '대기', observed: '관찰됨', verified: '검증됨', failed: '실패', waived: '면제' },
    },
  },
}

export function pickLang(locale = '', override = process.env.SWB_DESKTOP_LANG) {
  if (override === 'ko' || override === 'en') return override
  return /^ko\b/i.test(locale) ? 'ko' : 'en'
}

export const strings = lang => STRINGS[lang === 'ko' ? 'ko' : 'en']
