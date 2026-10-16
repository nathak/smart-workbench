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
  },
}

export function pickLang(locale = '', override = process.env.SWB_DESKTOP_LANG) {
  if (override === 'ko' || override === 'en') return override
  return /^ko\b/i.test(locale) ? 'ko' : 'en'
}

export const strings = lang => STRINGS[lang === 'ko' ? 'ko' : 'en']
