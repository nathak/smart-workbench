// SmartWorkbench desktop: a tray app that keeps the live-monitor hub running, shows it in its own window and
// raises desktop notifications when a session waits for an answer, goes quiet or ends.
import { Menu, Notification, Tray, BrowserWindow, app, ipcMain, nativeImage, session } from 'electron'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

import { beat, clear, desktopHome, ensureHome, ensureKey, readAck, sendCommand, tidy } from './channel.mjs'
import { followHub } from './events.mjs'
import { DEFAULT_PORT, superviseHub } from './hub.mjs'
import { writePair } from '../tools/desktop-channel.mjs'
import { randomBytes } from 'node:crypto'
import { pickLang, strings } from './i18n.mjs'
import { makeNotices } from './notices.mjs'
import { loadPrefs, savePrefs } from './prefs.mjs'
import { readSnapshots } from './snapshots.mjs'

// A second instance quits at once and touches nothing: it must not start a hub or remove the first one's heartbeat.
if (!app.requestSingleInstanceLock()) app.exit(0)

const PORT = Number(process.env.SWB_DESKTOP_PORT) || DEFAULT_PORT
let LANG = 'en'
let T = strings('en')
const live = new Set()
let followed = false
const prefsFile = join(app.getPath('userData'), 'prefs.json')
let prefs = loadPrefs(prefsFile)
let hubUp = false
let hubSeen = false
let rows = []
let tray
let win
let repairWin = () => {}
let home

const notices = makeNotices({ enabled: () => ({ ask: prefs.notifyAsk, quiet: prefs.notifyQuiet, end: prefs.notifyEnd }) })

const set = (key, value) => {
  prefs = { ...prefs, [key]: value }
  savePrefs(prefsFile, prefs)
  beatNow()
  refreshMenu()
}

// A filled circle: the tray icon needs no image file.
function icon() {
  const size = 32
  const buf = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const inside = (x - 15.5) ** 2 + (y - 15.5) ** 2 <= 14 ** 2
      const at = (y * size + x) * 4
      buf[at] = inside ? 0xf6 : 0 // B
      buf[at + 1] = inside ? 0x82 : 0 // G
      buf[at + 2] = inside ? 0x3b : 0 // R
      buf[at + 3] = inside ? 255 : 0
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size })
}

function show() {
  if (win && !win.isDestroyed()) {
    win.show()
    win.focus()
    return
  }
  const origin = `http://127.0.0.1:${PORT}`
  win = new BrowserWindow({ width: 1200, height: 800, title: 'SmartWorkbench', webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
  win.removeMenu()
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  const guard = (event, url) => {
    if (!url.startsWith(`${origin}/`) && url !== origin) event.preventDefault()
  }
  for (const name of ['will-navigate', 'will-redirect', 'will-frame-navigate']) win.webContents.on(name, guard)
  // The app's own window is paired with the hub by a one-time code in the address (its hash is left in the app's folder for a minute), so this window,
  // and no other page, may answer a guard question. The page trades the code for a token and removes it from the address at once.
  const load = () => {
    let code = ''
    try {
      if (home) {
        code = randomBytes(16).toString('hex')
        writePair(home, code)
      }
    } catch {
      code = ''
    }
    void win.loadURL(`${origin}/${code ? `#pair=${code}` : ''}`).catch(() => {})
  }
  // The hub may not be up yet when the window opens: try again a little later instead of staying on an error page.
  win.webContents.on('did-fail-load', (_event, code) => code !== -3 && setTimeout(() => !win.isDestroyed() && load(), 3000))
  load()
  // A hub that restarted has forgotten the token: the window loads again with a new code.
  repairWin = () => !win.isDestroyed() && load()
  // Closing hides: the app and its notifications go on from the tray.
  win.on('close', event => {
    if (!app.isQuitting) {
      event.preventDefault()
      win.hide()
    }
  })
}

let statusWin
const here = fileURLToPath(new URL('.', import.meta.url))

// The sessions and the read-only state each one's plugin wrote; the window only draws it.
function showStatus() {
  if (statusWin && !statusWin.isDestroyed()) {
    statusWin.show()
    statusWin.focus()
    return
  }
  statusWin = new BrowserWindow({ width: 760, height: 780, title: T.status, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, preload: join(here, 'preload.cjs') } })
  statusWin.removeMenu()
  statusWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  const stay = event => event.preventDefault()
  for (const name of ['will-navigate', 'will-redirect', 'will-frame-navigate']) statusWin.webContents.on(name, stay)
  void statusWin.loadFile(join(here, 'ui', 'status.html'))
}

// What was sent from the window and how the plugin answered: the window shows the last few per session.
const sent = new Map()
let key

const fromStatus = event => statusWin && !statusWin.isDestroyed() && event.sender === statusWin.webContents && event.senderFrame === statusWin.webContents.mainFrame

ipcMain.handle('swb:send', (event, sessionId, ops) => {
  if (!fromStatus(event) || !home) return { ok: false, reason: 'unavailable' }
  // Only a session the hub lists as running can be sent to.
  if (typeof sessionId !== 'string' || !rows.some(row => row.id === sessionId && row.alive)) return { ok: false, reason: 'unknown session' }
  try {
    key ??= ensureKey(home)
    const result = sendCommand(home, key, sessionId, ops)
    if (sent.size > 60) sent.delete(sent.keys().next().value)
    if (result.ok) sent.set(result.id, { session: sessionId, at: Date.now(), label: Array.isArray(ops) ? ops.map(one => String(one?.op).slice(0, 30)).join(', ') : '' })
    return result
  } catch {
    return { ok: false, reason: 'cannot write' }
  }
})

ipcMain.handle('swb:overview', event => {
  // Only the status window asks, and it asks for nothing but this.
  if (!fromStatus(event)) return null
  const snaps = home ? readSnapshots(home, Date.now(), new Set(rows.map(row => String(row.id)))) : {}
  return {
    lang: LANG,
    text: T.ui,
    hubUp,
    rows: rows.map(row => ({ id: String(row.id), name: String(row.name ?? ''), alive: row.alive === true, quiet: row.quiet === true })),
    acks: [...sent.entries()].slice(-30).map(([id, one]) => ({ id, session: one.session, label: one.label, at: one.at, ack: home ? readAck(home, id) : undefined })),
    snaps: Object.fromEntries(rows.filter(row => Object.hasOwn(snaps, row.id)).map(row => [row.id, snaps[row.id]])),
  }
})

function refreshMenu() {
  if (!tray) return
  const live = rows.filter(row => row.alive || row.quiet).length
  const check = (label, key) => ({ label, type: 'checkbox', checked: prefs[key], click: item => set(key, item.checked) })
  tray.setToolTip(`SmartWorkbench · ${hubUp ? T.sessions(live) : T.hubDown}`)
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: T.open, click: show },
      { label: T.status, click: showStatus },
      { label: hubUp ? T.sessions(live) : T.hubDown, enabled: false },
      { type: 'separator' },
      check(T.autoJoin, 'autoJoin'),
      check(T.livePrompts, 'livePrompts'),
      check(T.notifyAsk, 'notifyAsk'),
      check(T.notifyQuiet, 'notifyQuiet'),
      check(T.notifyEnd, 'notifyEnd'),
      // Start at login is not available through Electron on Linux.
      ...(process.platform === 'linux' ? [] : [{ label: T.login, type: 'checkbox', checked: app.getLoginItemSettings().openAtLogin, click: item => app.setLoginItemSettings({ openAtLogin: item.checked }) }]),
      { type: 'separator' },
      {
        label: T.quit,
        click: () => {
          app.isQuitting = true
          app.quit()
        },
      },
    ]),
  )
}

function notify(one) {
  if (!Notification.isSupported()) return
  const project = one.project || 'session'
  const text = {
    ask: { title: T.askTitle(project), body: T.askBody(one.tool ?? 'tool') },
    quiet: { title: T.quietTitle(project), body: T.quietBody },
    end: { title: T.endTitle(project), body: T.endBody },
  }[one.kind]
  const popup = new Notification({ ...text, silent: false })
  // Held until it closes: a collected notification loses its click handler.
  live.add(popup)
  popup.on('close', () => live.delete(popup))
  popup.on('click', show)
  popup.show()
}

// The plugin reads this file to find the hub and to know the app shows the ask notices itself.
const beatNow = () => {
  try {
    if (home) beat(home, { port: PORT, autoJoin: prefs.autoJoin, livePrompts: prefs.livePrompts, askNotify: prefs.notifyAsk && Notification.isSupported() && hubUp && followed ? 'desktop' : 'plugin' })
  } catch {
    // The heartbeat is a courtesy; sessions then keep their own behaviour.
  }
}

app.on('second-instance', show)
app.on('window-all-closed', () => {})
app.on('before-quit', () => {
  app.isQuitting = true
})

app.whenReady().then(() => {
  LANG = pickLang(app.getLocale())
  T = strings(LANG)
  // Nothing the monitor page asks for beyond showing itself is granted.
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, done) => done(false))
  session.defaultSession.setPermissionCheckHandler(() => false)
  try {
    home = ensureHome(desktopHome())
  } catch (error) {
    console.error(`desktop directory unusable: ${error.message}`)
  }
  tray = new Tray(icon())
  tray.on('click', show)
  refreshMenu()

  const hub = superviseHub({
    port: PORT,
    onState: state => {
      const back = state === 'up' && !hubUp && hubSeen
      hubUp = state === 'up'
      if (hubUp) hubSeen = true
      if (back) repairWin()
      refreshMenu()
    },
  })
  const follow = followHub({
    port: PORT,
    onSessions: list => {
      rows = list
      for (const one of notices.onSessions(list)) notify(one)
      refreshMenu()
    },
    onLine: (id, event) => notices.onLine(id, event),
    onState: up => {
      followed = up
      beatNow()
    },
  })
  const timers = [
    setInterval(() => {
      for (const one of notices.tick()) notify(one)
    }, 1000),
    setInterval(beatNow, 10000),
    setInterval(() => home && tidy(home), 10 * 60 * 1000),
  ]
  beatNow()
  app.on('quit', () => {
    for (const timer of timers) clearInterval(timer)
    follow.stop()
    hub.stop()
    if (home) clear(home)
  })
  if (process.argv.includes('--show')) show()
})
