import { describe, expect, test } from 'claude-code/testing'

import { approvalPathOf, consentText, installPathFrom, maskUrl, parseStatus, sameTarget, shown, statusLine } from '../hooks/vhdb'

const line = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ upload: false, configured: true, ready: true, approved: false, reason: '', url: 'https://team.example/api', project: 'app', ledger: true, tokenSource: 'env', lastSentAt: null, sent: 0, error: null, backoffUntil: null, ...extra })

describe('the status vhdb prints', () => {
  test('a plain line is read; noise before it is tolerated; anything else is unreadable', () => {
    expect(parseStatus(line())).toMatchObject({ upload: false, ready: true, url: 'https://team.example/api', project: 'app', ledger: true })
    expect(parseStatus(`warming up\n${line({ upload: true, approved: true })}\n`)).toMatchObject({ upload: true, approved: true })
    expect(parseStatus('')).toBeUndefined()
    expect(parseStatus('not json')).toBeUndefined()
    expect(parseStatus('[1,2]')).toBeUndefined()
    expect(parseStatus('{"upload":')).toBeUndefined()
  })

  test('only a true value counts as on or ready; an unclear ledger field is shown as included', () => {
    expect(parseStatus(line({ upload: 'yes', ready: 1 }))).toMatchObject({ upload: false, ready: false })
    expect(parseStatus(line({ ledger: undefined }))?.ledger).toBe(true)
    expect(parseStatus(line({ ledger: 'no' }))?.ledger).toBe(true)
    expect(parseStatus(line({ ledger: false }))?.ledger).toBe(false)
  })

  test('text from the plugin cannot lay out a line of its own, a password in the address is hidden, and the approval path must be absolute and end where it should', () => {
    expect(shown('a\nb\x1b[31mc')).toBe('a b [31mc')
    expect(shown('x'.repeat(500)).length).toBe(200)
    expect(maskUrl('https://user:pw@host/p')).toBe('https://***@host/p')
    expect(parseStatus(line({ url: 'https://u:p@h/x', reason: 'a\nb' }))).toMatchObject({ url: 'https://***@h/x', reason: 'a b' })
    expect(parseStatus(line({ approvalPath: '/r/.git/vhdb/state/ui-approval' }))?.approvalPath).toBe('/r/.git/vhdb/state/ui-approval')
    for (const approvalPath of ['state/ui-approval', '/r/.git/vhdb/state/other', '/r/vhdb/state/ui-approval\n/etc/x', 5]) {
      expect(parseStatus(line({ approvalPath }))?.approvalPath).toBeUndefined()
    }
  })

  test('the status vhdb 0.2.1 prints with nothing set is read, and says nothing about the ledger', () => {
    const real =
      '{"upload":false,"approvalPath":"/r/.git/vhdb/state/ui-approval","configured":false,"ready":false,"approved":false,"reason":"설정 없음: node bin/vhdb.mjs remote set --url <주소> --project <이름>","url":null,"project":null,"ledger":null,"tokenSource":null,"lastSentAt":null,"sent":0,"error":null,"backoffUntil":null}'
    const read = parseStatus(real)
    expect(read).toMatchObject({ ready: false, upload: false, url: '', project: '', approvalPath: '/r/.git/vhdb/state/ui-approval' })
    expect(read?.reason).toContain('설정 없음')
    expect(statusLine(read!)).toContain('no server set')
    expect(statusLine(read!)).not.toContain('ledger')
  })

  test('the error and the retry time are carried', () => {
    const read = parseStatus(line({ error: { status: 503, text: 'busy', at: 't' }, backoffUntil: 'later', sent: 4, lastSentAt: 'then' }))
    expect(read?.error).toEqual({ status: '503', text: 'busy', at: 't' })
    expect(statusLine(read!)).toContain('last error 503 busy')
    expect(statusLine(read!)).toContain('4 sent, last then')
    expect(statusLine(read!)).toContain('retrying after later')
  })
})

describe('where vhdb is and where it keeps the approval', () => {
  const list = (plugins: Record<string, unknown>) => JSON.stringify({ version: 2, plugins })

  test('the plugin is found by its name; a missing, relative or damaged entry is not found', () => {
    expect(installPathFrom(list({ 'vhdb@market': [{ installPath: '/h/.claude/plugins/cache/vhdb/0.2.0' }] }))).toBe('/h/.claude/plugins/cache/vhdb/0.2.0/bin/vhdb.mjs')
    expect(installPathFrom(list({ 'other@market': [{ installPath: '/x' }] }))).toBeUndefined()
    expect(installPathFrom(list({ 'vhdb@market': [{ installPath: 'relative/path' }] }))).toBeUndefined()
    expect(installPathFrom(list({ 'vhdb@market': [] }))).toBeUndefined()
    expect(installPathFrom('{broken')).toBeUndefined()
  })

  test('VHDB_DIR wins over the git common dir; with neither there is no path', () => {
    expect(approvalPathOf('/r/.git', '')).toBe('/r/.git/vhdb/state/ui-approval')
    expect(approvalPathOf('/r/.git/', '  ')).toBe('/r/.git/vhdb/state/ui-approval')
    expect(approvalPathOf('/r/.git', '/data/vhdb/')).toBe('/data/vhdb/state/ui-approval')
    expect(approvalPathOf(undefined, '')).toBeUndefined()
  })
})

describe('the question and the second look', () => {
  const read = (extra: Record<string, unknown> = {}) => parseStatus(line(extra))!

  test('the question names the server, the project, what leaves and what turning off does not undo', () => {
    const text = consentText(read())
    expect(text).toContain('Server: https://team.example/api')
    expect(text).toContain('Project: app')
    expect(text).toContain('prompts')
    expect(text).toContain('History gathered so far is uploaded too')
    expect(text).toContain('must be deleted by the server admin')
    expect(consentText(read({ ledger: false }))).not.toContain('prompts')
    expect(consentText(read({ url: 'https://u:p@h/x' }))).not.toContain('u:p')
  })

  test('a changed server, project or ledger setting, or a status that is no longer ready, is not the same target', () => {
    expect(sameTarget(read(), read())).toBe(true)
    expect(sameTarget(read(), read({ url: 'https://evil.example' }))).toBe(false)
    expect(sameTarget(read(), read({ project: 'other' }))).toBe(false)
    expect(sameTarget(read(), read({ ledger: false }))).toBe(false)
    expect(sameTarget(read(), read({ ready: false }))).toBe(false)
    expect(sameTarget(read(), read({ tokenSource: 'file' }))).toBe(false)
  })

  test('the second look compares the raw values: a change past the shown length or in the address credentials is a change', () => {
    const long = 'p'.repeat(250)
    expect(sameTarget(read({ project: long }), read({ project: `${long}x` }))).toBe(false)
    expect(sameTarget(read({ url: 'https://a:1@h/x' }), read({ url: 'https://b:2@h/x' }))).toBe(false)
    expect(sameTarget(read({ project: long }), read({ project: long }))).toBe(true)
  })
})
