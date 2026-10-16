// SmartWorkbench desktop: a tray app that keeps the live-monitor hub running, shows it in its own window and
// raises desktop notifications when a session waits for an answer, goes quiet or ends.
import { Menu, Notification, Tray, BrowserWindow, app, nativeImage, session } from 'electron'
import { join } from 'node:path'

import { beat, clear, desktopHome, ensureHome } from './channel.mjs'
import { followHub } from './events.mjs'
import { DEFAULT_PORT, superviseHub } from './hub.mjs'
import { pickLang, strings } from './i18n.mjs'
import { makeNotices } from './notices.mjs'
import { loadPrefs, savePrefs } from './prefs.mjs'

// A second instance quits at once and touches nothing: it must not start a hub or remove the first one's heartbeat.
if (!app.requestSingleInstanceLock()) app.exit(0)

const PORT = Number(process.env.SWB_DESKTOP_PORT) || DEFAULT_PORT
let T = strings('en')
const live = new Set()
let followed = false
const prefsFile = join(app.getPath('userData'), 'prefs.json')
let prefs = loadPrefs(prefsFile)
let hubUp = false
let rows = []
let tray
let win
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
  const load = () => void win.loadURL(`${origin}/`).catch(() => {})
  // The hub may not be up yet when the window opens: try again a little later instead of staying on an error page.
  win.webContents.on('did-fail-load', () => setTimeout(() => !win.isDestroyed() && load(), 3000))
  load()
  // Closing hides: the app and its notifications go on from the tray.
  win.on('close', event => {
    if (!app.isQuitting) {
      event.preventDefault()
      win.hide()
    }
  })
}

function refreshMenu() {
  if (!tray) return
  const live = rows.filter(row => row.alive || row.quiet).length
  const check = (label, key) => ({ label, type: 'checkbox', checked: prefs[key], click: item => set(key, item.checked) })
  tray.setToolTip(`SmartWorkbench · ${hubUp ? T.sessions(live) : T.hubDown}`)
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: T.open, click: show },
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
  T = strings(pickLang(app.getLocale()))
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
      hubUp = state === 'up'
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
