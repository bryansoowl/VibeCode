// electron/main.js
const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, net, safeStorage, Notification } = require('electron')
const path = require('path')
const fs = require('fs')
const { spawn } = require('child_process')
const AutoLaunch = require('electron-auto-launch')
const { makeNotificationKey } = require('./utils')

const BACKEND_PORT = 3001
const BACKEND_URL = `http://localhost:${BACKEND_PORT}`
const SYNC_INTERVAL_MS = 60 * 1000              // 60 seconds — email sync (History API makes this cheap)
const NOTIFICATION_INTERVAL_MS = 60 * 60 * 1000 // 60 minutes — bill notification check
const SCHEDULER_STARTUP_DELAY_MS = 30 * 1000   // 30 seconds after launch
const NOTIFIED_FILE = path.join(app.getPath('userData'), 'notified.json')
const EMAIL_NOTIFIED_FILE = path.join(app.getPath('userData'), 'notified-emails.json')
const PREFS_FILE = path.join(app.getPath('userData'), 'prefs.json')
const GEMINI_KEY_FILE = path.join(app.getPath('userData'), 'gemini.enc')

let mainWindow = null
let tray = null
let backendProcess = null
let syncTimer = null
let notifTimer = null
let emailNotifEnabled = true  // in-memory cache — populated in app.whenReady

const autoLauncher = new AutoLaunch({ name: 'InboxMY' })

// ── Notified deduplication ──────────────────────────────────────────────────
function loadNotified() {
  try { return JSON.parse(fs.readFileSync(NOTIFIED_FILE, 'utf8')) } catch { return {} }
}
function saveNotified(map) {
  try { fs.writeFileSync(NOTIFIED_FILE, JSON.stringify(map)) }
  catch (e) { console.error('[notified] Failed to save:', e.message) }
}
function loadEmailNotified() {
  try { return JSON.parse(fs.readFileSync(EMAIL_NOTIFIED_FILE, 'utf8')) } catch { return {} }
}
function saveEmailNotified(map) {
  const keys = Object.keys(map)
  if (keys.length > 500) {
    const pruned = {}
    for (const k of keys.slice(keys.length - 500)) pruned[k] = true
    map = pruned
  }
  try { fs.writeFileSync(EMAIL_NOTIFIED_FILE, JSON.stringify(map)) }
  catch (e) { console.error('[email-notified] Failed to save:', e.message) }
}
function loadPrefs() {
  try { return { emailNotifications: true, ...JSON.parse(fs.readFileSync(PREFS_FILE, 'utf8')) } }
  catch { return { emailNotifications: true } }
}
function savePrefs(prefs) {
  try { fs.writeFileSync(PREFS_FILE, JSON.stringify(prefs)) }
  catch (e) { console.error('[prefs] Failed to save:', e.message) }
}

// ── Windows taskbar badge ───────────────────────────────────────────────────
function setWindowsBadge(win, count, label = 'unread') {
  if (!win || win.isDestroyed()) return
  if (count === 0) {
    win.setOverlayIcon(null, '')
    return
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16">
    <circle cx="8" cy="8" r="8" fill="#e05"/>
    <text x="8" y="12" text-anchor="middle" fill="white" font-size="10" font-family="Arial">${Math.min(count, 9)}</text>
  </svg>`
  const img = nativeImage.createFromDataURL(
    `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`
  )
  win.setOverlayIcon(img, `${count} ${label}`)
}

// ── Backend process ─────────────────────────────────────────────────────────
function startBackend() {
  const serverPath = path.join(__dirname, '..', 'inboxmy-backend', 'dist', 'server.js')
  const backendDir = path.join(__dirname, '..', 'inboxmy-backend')
  // Use the same data directory as standalone mode so existing connected accounts
  // and their OAuth tokens are available when running via Electron.
  const dataDir = path.join(backendDir, 'data')
  fs.mkdirSync(dataDir, { recursive: true })

  backendProcess = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(BACKEND_PORT),
      DATA_DIR: dataDir,
    },
    // Set cwd to inboxmy-backend so dotenv can find .env for SESSION_SECRET etc.
    cwd: backendDir,
    stdio: 'pipe',
  })

  backendProcess.stdout?.on('data', (d) => console.log('[backend]', d.toString().trim()))
  backendProcess.stderr?.on('data', (d) => console.error('[backend err]', d.toString().trim()))
  backendProcess.on('exit', (code) => console.log('[backend] exited with code', code))
}

async function waitForBackend(retries = 40) {
  for (let i = 0; i < retries; i++) {
    try {
      await new Promise((resolve, reject) => {
        const req = net.request({ url: `${BACKEND_URL}/health`, method: 'GET' })
        req.on('response', (res) => (res.statusCode === 200 ? resolve() : reject()))
        req.on('error', reject)
        req.end()
      })
      return true
    } catch {
      await new Promise((r) => setTimeout(r, 500))
    }
  }
  return false
}

// ── BrowserWindow ───────────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
    icon: path.join(__dirname, 'assets', 'icon.png'),
    titleBarStyle: 'default',
    autoHideMenuBar: true,
  })

  mainWindow.loadURL(`${BACKEND_URL}/`)
  mainWindow.once('ready-to-show', () => { mainWindow.show() })

  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault()
      mainWindow.hide()
    }
  })
}

// ── System tray ─────────────────────────────────────────────────────────────
function createTray() {
  const iconPath = path.join(__dirname, 'assets', 'tray-icon.png')
  const icon = nativeImage.createFromPath(iconPath)
  tray = new Tray(icon)

  const menu = Menu.buildFromTemplate([
    { label: 'Open InboxMY', click: () => mainWindow?.show() },
    { type: 'separator' },
    { label: 'Quit', click: () => { app.isQuitting = true; app.quit() } },
  ])

  tray.setToolTip('InboxMY')
  tray.setContextMenu(menu)
  tray.on('click', () => { mainWindow?.show(); mainWindow?.focus() })
}

// ── Scheduler ───────────────────────────────────────────────────────────────

// Sync emails for all connected accounts (runs every 60s)
async function runSyncTick() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const winSession = mainWindow.webContents.session
  const body = await new Promise((resolve) => {
    const payload = '{}'
    const req = net.request({
      url: `${BACKEND_URL}/api/sync/trigger`,
      method: 'POST',
      session: winSession,
    })
    req.on('response', (res) => {
      let buf = ''
      res.on('data', (chunk) => { buf += chunk })
      res.on('end', () => resolve(buf))
    })
    req.on('error', () => resolve(''))
    req.setHeader('Content-Type', 'application/json')
    req.setHeader('Content-Length', Buffer.byteLength(payload))
    req.write(payload)
    req.end()
  }).catch(() => '')

  let syncResult = {}
  try { syncResult = JSON.parse(body) } catch { /* empty or non-JSON response */ }

  const { added = 0, emails = [] } = syncResult

  // Fetch authoritative unread count → update taskbar badge + send emails to renderer
  if (added > 0 && mainWindow && !mainWindow.isDestroyed()) {
    await new Promise((resolve) => {
      const req2 = net.request({
        url: `${BACKEND_URL}/api/emails/unread-count`,
        method: 'GET',
        session: winSession,
      })
      req2.on('response', (res) => {
        let buf2 = ''
        res.on('data', (c) => { buf2 += c })
        res.on('end', () => {
          try {
            const unreadCount = JSON.parse(buf2).count ?? 0
            setWindowsBadge(mainWindow, unreadCount)
            if (!mainWindow.isDestroyed()) {
              // Send emails so renderer can fire Web Notifications
              mainWindow.webContents.send('new-emails', { added, unreadCount, emails })
            }
          } catch {}
          resolve()
        })
      })
      req2.on('error', () => resolve())
      req2.end()
    }).catch(() => {})
  }

  // Tell the renderer to refresh its email list after background sync
  if (!mainWindow.isDestroyed()) {
    mainWindow.webContents.send('sync-complete')
  }
}

// Check for due-soon bills and fire notifications (runs every 60 min)
async function runSchedulerTick() {
  if (!mainWindow || mainWindow.isDestroyed()) return

  const winSession = mainWindow.webContents.session

  // 1. Auto-mark overdue
  await new Promise((resolve) => {
    const req = net.request({
      url: `${BACKEND_URL}/api/bills/auto-mark-overdue`,
      method: 'PATCH',
      session: winSession,
    })
    req.on('response', () => resolve())
    req.on('error', () => resolve())
    req.end()
  })

  // 2. Fetch due-soon bills
  let bills = []
  try {
    bills = await new Promise((resolve, reject) => {
      const req = net.request({
        url: `${BACKEND_URL}/api/notifications/due-soon`,
        method: 'GET',
        session: winSession,
      })
      req.on('response', (res) => {
        if (res.statusCode === 401) { resolve([]); return }
        let body = ''
        res.on('data', (chunk) => { body += chunk })
        res.on('end', () => {
          try { resolve(JSON.parse(body).bills || []) } catch { resolve([]) }
        })
      })
      req.on('error', () => resolve([]))
      req.end()
    })
  } catch { bills = [] }

  if (!bills.length) { setWindowsBadge(mainWindow, 0, 'overdue'); return }

  // 3. Filter already-notified
  const notified = loadNotified()
  const now = Date.now()
  const fresh = bills.filter((b) => {
    const key = makeNotificationKey(b.id, now)
    return !notified[key]
  })

  // Always push current bills to renderer so the overdue banner stays current
  mainWindow.webContents.send('bill-alert', { overdue: bills.filter((b) => b.status === 'overdue') })

  if (!fresh.length) { setWindowsBadge(mainWindow, bills.length, 'overdue'); return }

  // 4. AI summary (optional — skip if no key)
  let results = fresh.map((b) => ({
    billId: b.id,
    shouldNotify: true,
    title: `${b.biller} — due soon`,
    body: b.amount_rm ? `RM${Number(b.amount_rm).toFixed(2)} due` : 'Payment due',
  }))

  const geminiKey = getGeminiKeyDecrypted()
  if (geminiKey) {
    try {
      const aiResults = await new Promise((resolve, reject) => {
        const payload = JSON.stringify({ bills: fresh, geminiKey })
        const req = net.request({
          url: `${BACKEND_URL}/api/notifications/ai-summary`,
          method: 'POST',
          session: winSession,
        })
        req.on('response', (res) => {
          let body = ''
          res.on('data', (chunk) => { body += chunk })
          res.on('end', () => {
            try { resolve(JSON.parse(body)) } catch { reject(new Error('parse failed')) }
          })
        })
        req.on('error', reject)
        req.setHeader('Content-Type', 'application/json')
        req.setHeader('Content-Length', Buffer.byteLength(payload))
        req.write(payload)
        req.end()
      })
      if (Array.isArray(aiResults)) results = aiResults
    } catch (e) {
      console.error('[scheduler] AI summary failed, using plain copy:', e.message)
    }
  }

  // 5. Fire toasts + mark notified
  let toastCount = 0
  for (const r of results) {
    if (!r.shouldNotify) continue
    const bill = fresh.find((b) => b.id === r.billId)
    if (!bill) continue

    const notif = new Notification({
      title: r.title,
      body: r.body,
      icon: path.join(__dirname, 'assets', 'icon.png'),
      actions: [{ type: 'button', text: 'View Bill' }],
    })
    notif.on('action', (_, index) => {
      if (index === 0) {
        mainWindow?.show()
        mainWindow?.focus()
        mainWindow?.webContents.send('navigate-to-bill', bill.id)
      }
    })
    notif.show()

    const key = makeNotificationKey(bill.id, now)
    notified[key] = true
    toastCount++
  }
  saveNotified(notified)

  // 6. Windows taskbar badge
  setWindowsBadge(mainWindow, bills.length, 'overdue')
}

// ── Gemini key (safeStorage) ─────────────────────────────────────────────────
function getGeminiKeyDecrypted() {
  try {
    if (!safeStorage.isEncryptionAvailable()) return null
    const enc = fs.readFileSync(GEMINI_KEY_FILE)
    return safeStorage.decryptString(enc)
  } catch { return null }
}

// ── IPC Handlers ─────────────────────────────────────────────────────────────
function setupIPC() {
  ipcMain.handle('fire-notification', (_, { title, body }) => {
    new Notification({ title, body }).show()
  })

  ipcMain.handle('save-gemini-key', (_, key) => {
    if (!safeStorage.isEncryptionAvailable()) return { ok: false, error: 'safeStorage unavailable' }
    const enc = safeStorage.encryptString(key)
    fs.writeFileSync(GEMINI_KEY_FILE, enc)
    return { ok: true }
  })

  ipcMain.handle('get-gemini-key', () => {
    const key = getGeminiKeyDecrypted()
    // Return masked key for UI status display — never return the raw key to renderer
    return key ? '••••••••' : null
  })

  ipcMain.handle('set-auto-launch', async (_, enabled) => {
    if (enabled) { await autoLauncher.enable() }
    else { await autoLauncher.disable() }
    return { ok: true }
  })

  ipcMain.handle('get-auto-launch', async () => {
    return autoLauncher.isEnabled()
  })

  // Deep link: renderer asks to navigate to a bill
  ipcMain.on('navigate-to-bill', (_, billId) => {
    mainWindow?.webContents.send('navigate-to-bill', billId)
  })

  ipcMain.handle('get-notif-pref', () => emailNotifEnabled)

  ipcMain.handle('set-notif-pref', (_, enabled) => {
    emailNotifEnabled = Boolean(enabled)
    const prefs = loadPrefs()
    prefs.emailNotifications = emailNotifEnabled
    savePrefs(prefs)
    return { ok: true }
  })
}

// ── App lifecycle ────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  startBackend()
  const ready = await waitForBackend()
  if (!ready) {
    console.error('[main] Backend failed to start')
    app.quit()
    return
  }

  app.setAppUserModelId('my.inbox.app')
  createWindow()
  createTray()
  setupIPC()
  emailNotifEnabled = loadPrefs().emailNotifications

  // Email sync: first run 30s after launch, then every 15 min
  syncTimer = setTimeout(() => {
    runSyncTick()
    syncTimer = setInterval(runSyncTick, SYNC_INTERVAL_MS)
  }, SCHEDULER_STARTUP_DELAY_MS)

  // Bill notifications: first check 60s after launch, then every 60 min
  notifTimer = setTimeout(() => {
    runSchedulerTick()
    notifTimer = setInterval(runSchedulerTick, NOTIFICATION_INTERVAL_MS)
  }, 60_000)
})

app.on('window-all-closed', () => {
  // Keep app alive in tray — do not quit
})

app.on('before-quit', () => {
  if (syncTimer)  { clearTimeout(syncTimer);  clearInterval(syncTimer) }
  if (notifTimer) { clearTimeout(notifTimer); clearInterval(notifTimer) }
  if (backendProcess) backendProcess.kill()
})

app.on('activate', () => {
  if (!mainWindow) createWindow()
  else mainWindow.show()
})
