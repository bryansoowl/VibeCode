# Plan 6 — Electron Shell + Overdue Detection + Windows Notifications + AI

**Date:** 2026-03-27
**Status:** Approved
**Builds on:** Plan 5 (Account Management UI) — 88 tests passing

---

## Goal

Convert InboxMY from a browser web app into a BlueMail-style Electron desktop app.
Add overdue bill detection, Windows toast notifications with deep links, a background
scheduler that runs even when the window is closed, and AI-powered notification copy
via Gemini 2.0 Flash. User supplies their own Gemini API key (stored encrypted via
Electron `safeStorage`). README updated; tests cleaned up.

---

## Product Vision

InboxMY follows BlueMail's hybrid model:

| Phase | Plan | Model |
|---|---|---|
| MVP Core | Plan 6 (this) | Local Electron app, user-supplied Gemini key |
| MVP Real-time | Plan 7 | Gmail Pub/Sub + Outlook Graph webhooks |
| Premium | Plan 8 | InboxMY subscription + hosted AI proxy (no user key needed) |
| Cloud | Plan 9 | Optional settings sync across devices |
| Teams | Plan 10 | Shared inbox for Malaysian SMEs |

---

## Architecture Overview

```
VibeCode/                         ← git root
  electron/
    main.js                       ← Main process: BrowserWindow, tray, scheduler, IPC
    preload.js                    ← contextBridge: window.inboxmy.*
    assets/
      tray-icon.png               ← 16×16 tray icon
  package.json                    ← NEW: root Electron package
  inboxmy-backend/
    src/
      ai/
        notifier.ts               ← NEW: Gemini 2.0 Flash integration
      routes/
        bills.ts                  ← MODIFIED: add auto-mark-overdue endpoint
        notifications.ts          ← NEW: due-soon query endpoint
    tests/
      routes/
        notifications.test.ts     ← NEW: tests for new endpoints
  frontend/
    index.html                    ← MODIFIED: overdue banner + settings AI key section
    app.js                        ← MODIFIED: banner render, key save/load via IPC
  README.md                       ← MODIFIED: Electron architecture + new scripts
  SETUP.md                        ← MODIFIED: Gemini API key section
```

---

## Section 1: Electron Shell

### Root `package.json` (new)

```json
{
  "name": "inboxmy",
  "version": "0.6.0",
  "main": "electron/main.js",
  "scripts": {
    "electron:dev": "concurrently \"npm run start --prefix inboxmy-backend\" \"wait-on http://localhost:3000/health && electron .\"",
    "build": "npm run build --prefix inboxmy-backend && electron-builder",
    "dist": "npm run build --prefix inboxmy-backend && electron-builder --publish never"
  },
  "devDependencies": {
    "electron": "^31.0.0",
    "electron-builder": "^24.0.0",
    "concurrently": "^9.0.0",
    "wait-on": "^8.0.0"
  },
  "dependencies": {
    "electron-auto-launch": "^5.0.6",
    "electron-updater": "^6.0.0"
  },
  "build": {
    "appId": "my.inbox.app",
    "productName": "InboxMY",
    "win": {
      "target": "nsis",
      "icon": "electron/assets/icon.ico"
    },
    "nsis": {
      "oneClick": false,
      "allowToChangeInstallationDirectory": true
    },
    "files": [
      "electron/**/*",
      "frontend/**/*",
      "inboxmy-backend/dist/**/*",
      "inboxmy-backend/node_modules/**/*",
      "inboxmy-backend/package.json"
    ],
    "extraResources": [
      { "from": "inboxmy-backend/data", "to": "data" }
    ]
  }
}
```

### `electron/main.js`

**Startup sequence:**
1. Spawn `inboxmy-backend` as a child process (`node dist/server.js`)
2. Poll `GET /health` every 500ms (up to 20s) until ready
3. Create `BrowserWindow` (`contextIsolation: true`, `webSecurity: true`, loads `http://localhost:3000`)
4. Create system tray with `tray-icon.png`
5. Register `electron-auto-launch` to start InboxMY with Windows
6. Start the notification scheduler (fires 30s after launch, then every 60 min)

**Window behaviour (BlueMail-style):**
- `close` event → `event.preventDefault()` + `mainWindow.hide()` (app stays alive in tray)
- Tray left-click → `mainWindow.show()` + `mainWindow.focus()`
- Tray context menu: "Open InboxMY" / "---" / "Quit"
- Quit → kill backend child process, then `app.exit(0)`

**IPC handlers in main process:**

| Channel | Direction | Purpose |
|---|---|---|
| `fire-notification` | renderer → main | Manual notify trigger from frontend |
| `bill-alert` | main → renderer | Push bill data to frontend when scheduler fires |
| `navigate-to-bill` | main → renderer | Deep link after notification click |
| `save-gemini-key` | renderer → main | Encrypt + persist key via `safeStorage` |
| `get-gemini-key` | renderer → main | Decrypt + return key |

**Taskbar badge:**
- After each scheduler run, call `app.setBadgeCount(n)` where `n` = count of overdue + due-within-3-days bills

### `electron/preload.js`

```js
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('inboxmy', {
  notify:           (title, body) => ipcRenderer.invoke('fire-notification', { title, body }),
  onBillAlert:      (cb) => ipcRenderer.on('bill-alert', (_, data) => cb(data)),
  onNavigateToBill: (cb) => ipcRenderer.on('navigate-to-bill', (_, billId) => cb(billId)),
  saveGeminiKey:    (key) => ipcRenderer.invoke('save-gemini-key', key),
  getGeminiKey:     () => ipcRenderer.invoke('get-gemini-key'),
})
```

---

## Section 2: Overdue Detection

### Backend: `PATCH /api/bills/auto-mark-overdue`

- Finds all `parsed_bills` where `status = 'unpaid'` AND `due_date < Date.now()` AND the email belongs to the authenticated user
- Sets `status = 'overdue'`
- Returns `{ marked: number }` (count of rows updated)
- Called by the Electron scheduler before each notification check; also callable by the frontend on page load

### Frontend: Overdue Banner

- On `loadBills()`, if any bill has `status = 'overdue'`:
  - Insert a coral banner at the top of `#right-panel`:
    ```
    ⚠ You have {n} overdue bill(s) — Total RM{x}   [View all ×]
    ```
  - "View all" calls `setFolder('bills')` to switch to the Bills folder
  - `×` dismisses the banner and sets `sessionStorage.setItem('overdue-banner-dismissed', '1')`
  - Banner does not re-appear until next page load (after dismiss)
- If no overdue bills: banner is not rendered

---

## Section 3: Windows Notifications

### Notification Scheduler (in `electron/main.js`)

Runs 30s after app launch, then every 60 minutes:

```
1. PATCH /api/bills/auto-mark-overdue  (mark any newly overdue bills)
2. GET /api/notifications/due-soon     (fetch bills: overdue OR due within 72h)
3. POST /api/notifications/ai-summary  (if Gemini key set — get smart copy)
4. For each bill not in notified.json:
     - Fire native Notification (see below)
     - Write billId + monthYear key to userData/notified.json
5. app.setBadgeCount(n) with total alert count
6. mainWindow.webContents.send('bill-alert', { overdue, dueSoon })
```

**Session cookie:** Electron's `BrowserWindow` session shares cookies with the HTTP requests made via `net.request()`. The scheduler uses `net.request()` (Electron's built-in HTTP client) with the `session` cookie automatically attached — no separate auth flow needed.

### `notified.json` (deduplication)

Stored at `app.getPath('userData')/notified.json`. Format:
```json
{
  "bill_abc123_2026-03": true,
  "bill_def456_2026-03": true
}
```
Key = `billId + '_' + YYYY-MM`. This means each bill notifies once per monthly cycle.
On a new month the key changes, so the bill notifies again for the new invoice.

### Native Windows Toast (BlueMail-style)

```js
const notification = new Notification({
  title: 'TNB eBill — Due in 2 days',
  body: 'RM142.80 due Friday. Your usual monthly bill.',
  icon: path.join(__dirname, 'assets/icon.png'),
  actions: [{ type: 'button', text: 'View Bill' }],
  closeButtonText: 'Dismiss'
})

notification.on('action', () => {
  mainWindow.show()
  mainWindow.focus()
  mainWindow.webContents.send('navigate-to-bill', bill.id)
})

notification.show()
```

### `GET /api/notifications/due-soon`

New Express endpoint in `src/routes/notifications.ts`:
- Returns bills where: `status = 'overdue'` OR (`status = 'unpaid'` AND `due_date BETWEEN now AND now+72h`)
- Joins `emails → accounts` to enforce `user_id` check
- Response: `{ bills: [{ id, biller, amount_rm, due_date, status }] }`

---

## Section 4: AI Notifications (Gemini 2.0 Flash)

### `src/ai/notifier.ts`

**Input:**
```ts
interface BillForNotification {
  id: string
  biller: string
  amountRm: number | null
  dueDateMs: number | null
  status: 'unpaid' | 'overdue'
  daysUntilDue: number   // negative = overdue
}
```

**Output:**
```ts
interface NotificationResult {
  billId: string
  shouldNotify: boolean
  title: string   // max 60 chars
  body: string    // max 120 chars
}
```

**System prompt:**
```
You are a notification assistant for InboxMY, a Malaysian email app.
Given a list of bills, decide which ones are worth a Windows toast notification
and write concise copy. Rules:
- ALWAYS notify: TNB, Unifi, Celcom, Maxis, Digi, TnG, LHDN, any amount > RM50
- SUPPRESS: Shopee/Lazada promotional emails, amounts < RM10
- For overdue bills: lead with urgency ("overdue", "unpaid")
- For due-soon: mention days remaining and amount
- Title: max 60 chars. Body: max 120 chars. Friendly, Malaysian English.
Return a JSON array: [{ billId, shouldNotify, title, body }]
```

**Model:** `gemini-2.0-flash`
**SDK:** `@google/generative-ai`

**Fallback:** If the Gemini call throws (network down, invalid key, quota exceeded):
- Log the error
- Return plain copy for all bills: `shouldNotify: true`, `title: "{biller} — Due in {n} days"`, `body: "RM{amount} due on {date}"`
- Never suppress notifications due to AI failure

### `POST /api/notifications/ai-summary`

- Accepts: `{ bills: BillForNotification[], geminiKey: string }`
- Calls `notifier.ts`
- Returns: `NotificationResult[]`
- The Gemini key is passed per-request from the Electron main process (not stored server-side)

### Gemini Key Storage

- Stored via `safeStorage.encryptString(key)` → written to `app.getPath('userData')/inboxmy-settings.json`
- Read back via `safeStorage.decryptString(encrypted)`
- Windows DPAPI is used under the hood — key is tied to the Windows user account
- The key is never stored in SQLite, `.env`, or sent to the backend permanently

### Settings UI

New "AI Notifications" section in the Settings modal (`frontend/index.html`):

```
AI Notifications
─────────────────────────────────────────
Gemini API Key   [••••••••••••••••] [Save]
Status           ● Active  (or) ○ Not configured

Get a free key at aistudio.google.com
```

- On "Save": calls `window.inboxmy.saveGeminiKey(key)` → IPC → `safeStorage`
- On modal open: calls `window.inboxmy.getGeminiKey()` → shows masked value if set
- "Active" / "Not configured" badge shown based on whether key is present

---

## Section 5: Deep Link Navigation

When a user clicks "View Bill" on a Windows toast:
1. `notification.on('action')` → `mainWindow.show()` + `mainWindow.focus()`
2. `mainWindow.webContents.send('navigate-to-bill', billId)`
3. Preload fires `onNavigateToBill` callback in renderer
4. `app.js` calls `setFolder('bills')` then scrolls to + highlights the bill row with that `id`

---

## Section 6: README + SETUP Updates

### README changes
- Replace "How to Run" with Electron-first instructions:
  - `npm install` (root)
  - `npm run electron:dev` (dev mode)
  - `npm run dist` (build installer)
- Update "What's Built" table to include Electron shell, AI notifier
- Add "Business Model" section — local-first, user-supplied API key, future premium tier
- Remove references to `node server.js` as the primary run method

### SETUP.md changes
- Add "AI Notifications (Optional)" section:
  1. Go to `aistudio.google.com` → create API key (free)
  2. Open InboxMY → Settings → AI Notifications → paste key → Save
  3. Notifications will use AI copy on next scheduler run

---

## Section 7: Scheduler Stub Update

`src/scheduler.ts` currently contains a stub with a disabled comment. Update the comment to:
```ts
// Background scheduling has moved to electron/main.js (Plan 6).
// This stub is retained so server.ts compiles without changes.
```

No functional change — the stub stays as-is, comment updated for clarity.

---

## File Map

| File | Action | What changes |
|---|---|---|
| `package.json` (root) | **Create** | Electron app package, build config, scripts |
| `electron/main.js` | **Create** | Main process: BrowserWindow, tray, scheduler, IPC, notifications |
| `electron/preload.js` | **Create** | contextBridge: window.inboxmy.* |
| `electron/assets/tray-icon.png` | **Create** | 16×16 tray icon |
| `electron/assets/icon.ico` | **Create** | Windows app icon |
| `src/ai/notifier.ts` | **Create** | Gemini 2.0 Flash integration, fallback copy |
| `src/routes/notifications.ts` | **Create** | GET /api/notifications/due-soon, POST /api/notifications/ai-summary |
| `tests/routes/notifications.test.ts` | **Create** | Tests for both new notification endpoints |
| `tests/ai/notifier.test.ts` | **Create** | Unit tests for notifier (mocked Gemini SDK) |
| `src/routes/bills.ts` | **Modify** | Add PATCH /api/bills/auto-mark-overdue |
| `src/server.ts` | **Modify** | Mount notificationsRouter at /api/notifications |
| `src/scheduler.ts` | **Modify** | Update comment only |
| `inboxmy-backend/package.json` | **Modify** | Add @google/generative-ai dependency |
| `frontend/index.html` | **Modify** | Overdue banner HTML, Settings AI key section |
| `frontend/app.js` | **Modify** | Banner render logic, key save/load IPC, deep link handler |
| `README.md` | **Modify** | Electron-first docs, business model section |
| `SETUP.md` | **Modify** | Gemini API key setup instructions |

---

## Testing

### New test files
- `tests/routes/notifications.test.ts` — `GET /api/notifications/due-soon` (bills due within 72h returned, overdue returned, paid excluded); `PATCH /api/bills/auto-mark-overdue` (unpaid past due_date → overdue, future bills unchanged, paid bills unchanged)
- `tests/ai/notifier.test.ts` — Gemini success path returns AI copy; Gemini failure falls back to plain copy; suppresses Shopee promos; always notifies TNB/LHDN

### Modified test files
- `tests/routes/bills.test.ts` — add test for new `auto-mark-overdue` endpoint

### Electron main/preload
Not unit-tested (Electron E2E is out of scope for MVP). IPC handlers are verified manually.

### Target
**110+ tests passing** after Plan 6.

---

## Data Flow Summary

```
[Windows boot]
  → Electron auto-launch
  → main.js spawns inboxmy-backend
  → BrowserWindow loads http://localhost:3000
  → 30s delay → scheduler fires

[Scheduler tick]
  → PATCH /api/bills/auto-mark-overdue
  → GET /api/notifications/due-soon
  → (if Gemini key) POST /api/notifications/ai-summary
  → new Notification({ title, body, actions: ['View Bill'] })
  → app.setBadgeCount(n)
  → webContents.send('bill-alert', data)

[User clicks toast]
  → notification 'action' event
  → mainWindow.show() + focus()
  → webContents.send('navigate-to-bill', billId)
  → renderer: setFolder('bills') + highlight bill

[User opens Settings]
  → Settings modal → AI Notifications section
  → window.inboxmy.getGeminiKey() → masked display
  → user pastes key → Save → window.inboxmy.saveGeminiKey(key)
  → main.js: safeStorage.encryptString() → userData/inboxmy-settings.json
```

---

## Out of Scope (Future Plans)

- Real-time push sync (Gmail Pub/Sub, Outlook Graph webhooks) → Plan 7
- InboxMY Premium subscription + hosted AI proxy → Plan 8
- Settings sync across devices → Plan 9
- macOS / Linux support (Plan 6 targets Windows only)
- E2E Electron tests (Playwright/Spectron)
