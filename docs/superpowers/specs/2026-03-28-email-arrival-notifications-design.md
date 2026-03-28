# Email Arrival Notifications — Design Spec
**Date:** 2026-03-28
**Status:** Draft

---

## Overview

When new emails arrive during a background sync, InboxMY fires Windows toast notifications (BlueMail-style: per-email for small batches, grouped for large) with the default system sound. A live unread badge appears in the app header and on the Windows taskbar overlay. Users can toggle email notifications on/off from the Settings modal; when off, a visible "Notifications are off" label appears in Settings. The unread badge always updates regardless of whether notifications are enabled.

---

## Requirements

1. **Toast notifications on new email arrival**
   - 1–3 new (non-deduped) emails: one individual `Notification` per email — title = senderName ?? sender, body = plaintext subject (max 100 chars)
   - 4+ new (non-deduped) emails: single grouped toast — title = "InboxMY", body = `"${fresh.length} new emails across ${accountCount} account(s)"` where `accountCount = new Set(fresh.map(e => e.accountId)).size`
   - Default Windows system sound (Electron `Notification` default — no custom sound file)
   - Toasts fire only if in-memory `emailNotifEnabled` flag is `true`
   - Deduplication: bare email ID stored as key in a **separate** `userData/notified-emails.json` file (never mixed with bill `notified.json`). Pruned to 500 most-recent entries after each save.

2. **Live unread badge**
   - HTML element `<span id="unread-badge">` in the top toolbar, adjacent to the profile avatar
   - Shows total unread inbox email count (excluding Promotions tab) across all accounts — matches the inbox list view filter
   - Initialised on app load via `GET /api/emails/unread-count`
   - After each sync, main process fetches `GET /api/emails/unread-count` once and sends the authoritative count to both the taskbar badge and the renderer via `new-emails { added, unreadCount }` IPC (single fetch, no duplication)
   - Renderer sets `unreadCount` directly from `unreadCount` field — no client-side increment
   - Decremented by 1 (clamped to 0) when user reads an individual email
   - On `sync-complete` IPC: re-fetches `GET /api/emails/unread-count` as a drift-correction fallback
   - `new-emails` IPC is sent whenever `added > 0`, **regardless** of `emailNotifEnabled`
   - Hidden (`display: none`) when count = 0

3. **Notification toggle in Settings**
   - Toggle row "Email notifications" in the existing Settings modal
   - Reads pref via `get-notif-pref` IPC on settings open; writes via `set-notif-pref` IPC on toggle change
   - Pref stored in `userData/prefs.json` as `{ "emailNotifications": true }`. All future prefs use the same spread merge (`{ defaults, ...diskValue }`).
   - When off: red "Notifications are off" label shown below the toggle in Settings
   - Default: `true` (on)

---

## Architecture

### Backend changes

**`src/email/sync-engine.ts`**

New exported interface:
```ts
export interface NewEmailSummary {
  id: string
  sender: string
  senderName: string | null
  subject: string   // plaintext from NormalizedEmail.subject (before encryption), sliced to 200 chars
  accountId: string
}
```

`syncAccount` return type: `{ added: number; errors: string[]; newEmails: NewEmailSummary[] }`.

Declare `const newEmails: NewEmailSummary[] = []` in the outer scope of `syncAccount`, before the `db.transaction` call. Inside the transaction loop, when `result.changes > 0`, push:
```ts
newEmails.push({
  id: email.id,
  sender: email.sender,
  senderName: email.senderName ?? null,
  subject: (email.subject ?? '').slice(0, 200),  // email.subject is the plaintext field on NormalizedEmail
  accountId,
})
```
After `syncAll(emails)`, return `{ added, errors, newEmails }`.

`syncAllAccounts` return type: `Promise<{ added: number; newEmails: NewEmailSummary[] }>`.

The **existing loop discards return values** — this must be changed:
```ts
// CURRENT (broken for our purposes — must change):
for (const acc of accounts) {
  await syncAccount(acc.id, dataKey)
}

// NEW:
let totalAdded = 0
const allNewEmails: NewEmailSummary[] = []
for (const acc of accounts) {
  const result = await syncAccount(acc.id, dataKey)
  totalAdded += result.added
  allNewEmails.push(...result.newEmails)
}
return { added: totalAdded, newEmails: allNewEmails }
```

**`src/routes/sync.ts`**

All-accounts path — capture the return value and use it:
```ts
// OLD:
await syncAllAccounts(user.id, user.dataKey)
res.json({ ok: true })

// NEW:
const result = await syncAllAccounts(user.id, user.dataKey)
res.json({ added: result.added, emails: result.newEmails })
```

Single-account path — `syncAccount` already returns a result; extend response:
```ts
// OLD:
const result = await syncAccount(accountId, user.dataKey)
res.json(result)

// NEW:
const result = await syncAccount(accountId, user.dataKey)
res.json({ added: result.added, emails: result.newEmails, errors: result.errors })
```

**`src/routes/emails.ts`**

Add `GET /api/emails/unread-count` — excludes Promotions to match inbox list view:
```ts
router.get('/unread-count', requireAuth, (req, res) => {
  const user = (req as any).user
  const row = db.prepare(`
    SELECT COUNT(*) as count FROM emails e
    JOIN accounts a ON a.id = e.account_id
    WHERE a.user_id = ? AND e.is_read = 0 AND e.folder = 'inbox' AND e.tab != 'promotions'
  `).get(user.id) as { count: number }
  res.json({ count: row.count })
})
```

**`src/db/migrations.ts`** — no schema changes needed.

---

### Electron main process (`electron/main.js`)

**Email notified deduplication** — new file, separate from bill `notified.json`:
```js
const EMAIL_NOTIFIED_FILE = path.join(app.getPath('userData'), 'notified-emails.json')

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
```

Also fix the existing `saveNotified` (bills) to add error handling — it currently has none and will throw on disk failure:
```js
function saveNotified(map) {
  try { fs.writeFileSync(NOTIFIED_FILE, JSON.stringify(map)) }
  catch (e) { console.error('[notified] Failed to save:', e.message) }
}
```

**Prefs helpers and in-memory cache:**
```js
const PREFS_FILE = path.join(app.getPath('userData'), 'prefs.json')
let emailNotifEnabled = true  // in-memory cache — avoid sync file read in hot path

function loadPrefs() {
  try { return { emailNotifications: true, ...JSON.parse(fs.readFileSync(PREFS_FILE, 'utf8')) } }
  catch { return { emailNotifications: true } }
}
function savePrefs(prefs) {
  try { fs.writeFileSync(PREFS_FILE, JSON.stringify(prefs)) }
  catch (e) { console.error('[prefs] Failed to save:', e.message) }
}
```
In `app.whenReady()`, after `setupIPC()`: `emailNotifEnabled = loadPrefs().emailNotifications`.

**`setWindowsBadge` — add label parameter:**

Change signature from `setWindowsBadge(win, count)` to `setWindowsBadge(win, count, label = 'unread')`. Change the accessibility string from the hardcoded `'${count} overdue'` to `` `${count} ${label}` ``.

The **three existing call sites** in `runSchedulerTick` currently pass no label argument and will silently default to `'unread'` — all three must be updated to pass `'overdue'` explicitly:
- Early-return guard when no bills: `setWindowsBadge(mainWindow, 0, 'overdue')`
- Early-return guard when no fresh bills: `setWindowsBadge(mainWindow, bills.length, 'overdue')`
- End of function: `setWindowsBadge(mainWindow, bills.length, 'overdue')`

The new call added in `runSyncTick` uses the default `'unread'` label (no third argument needed).

**`runSyncTick`** — full replacement of the sync request block:

The existing Promise drains the body without collecting it. Replace the entire `await new Promise(...)` block for the sync request with:

```js
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
```

After this block (still guarded by the `if (!mainWindow || mainWindow.isDestroyed()) return` at the top of `runSyncTick`):

```js
let syncResult = {}
try { syncResult = JSON.parse(body) } catch { /* parse failed — skip notifications */ }

const { added = 0, emails = [] } = syncResult

// 1. Fire arrival notifications (only if pref enabled)
if (added > 0 && emailNotifEnabled) {
  const emailNotified = loadEmailNotified()
  const fresh = emails.filter((e) => !emailNotified[e.id])

  if (fresh.length > 0) {
    const icon = path.join(__dirname, 'assets', 'icon.png')
    if (fresh.length <= 3) {
      for (const e of fresh) {
        new Notification({
          title: e.senderName ?? e.sender,
          body: e.subject.slice(0, 100),
          icon,
        }).show()
      }
    } else {
      const accountCount = new Set(fresh.map((e) => e.accountId)).size
      new Notification({
        title: 'InboxMY',
        body: `${fresh.length} new emails across ${accountCount} account(s)`,
        icon,
      }).show()
    }

    for (const e of fresh) emailNotified[e.id] = true
    saveEmailNotified(emailNotified)
  }
}

// 2. Fetch authoritative unread count (single fetch for both taskbar badge and renderer)
if (added > 0 && !mainWindow.isDestroyed()) {
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
          setWindowsBadge(mainWindow, unreadCount)  // uses default 'unread' label
          if (!mainWindow.isDestroyed()) {
            mainWindow.webContents.send('new-emails', { added, unreadCount })
          }
        } catch {}
        resolve()
      })
    })
    req2.on('error', () => resolve())
    req2.end()
  }).catch(() => {})
}
```

Note: `sync-complete` IPC is still sent unconditionally at the end of `runSyncTick` (existing line 162) as a drift-correction fallback. This is intentional.

**IPC handlers** (add to `setupIPC()`):
```js
ipcMain.handle('get-notif-pref', () => emailNotifEnabled)

ipcMain.handle('set-notif-pref', (_, enabled) => {
  emailNotifEnabled = Boolean(enabled)
  const prefs = loadPrefs()
  prefs.emailNotifications = emailNotifEnabled
  savePrefs(prefs)           // errors are logged and swallowed — UI is optimistic
  return { ok: true }
})
```

---

### Preload (`electron/preload.js`)

Add to `window.inboxmy`:
```js
onNewEmails: (cb) => ipcRenderer.on('new-emails', (_, data) => cb(data)),
getNotifPref: () => ipcRenderer.invoke('get-notif-pref'),
setNotifPref: (enabled) => ipcRenderer.invoke('set-notif-pref', enabled),
```
`onSyncComplete` already exists — no change.

---

### Frontend (`frontend/app.js`)

**HTML addition** (toolbar, adjacent to profile avatar):
```html
<span id="unread-badge" style="display:none"></span>
```

**Unread badge logic:**
```js
let unreadCount = 0

async function refreshUnreadCount() {
  try {
    const { count } = await apiFetch('/api/emails/unread-count')
    unreadCount = count
    renderUnreadBadge()
  } catch { /* silent */ }
}

function renderUnreadBadge() {
  const el = document.getElementById('unread-badge')
  if (!el) return
  if (unreadCount <= 0) { el.style.display = 'none'; return }
  el.textContent = unreadCount > 99 ? '99+' : String(unreadCount)
  el.style.display = ''
}
```

**Wire up on app load:**
```js
refreshUnreadCount()

if (window.inboxmy) {
  // new-emails carries the authoritative unreadCount from main — set directly, no increment
  window.inboxmy.onNewEmails(({ unreadCount: count }) => {
    unreadCount = count
    renderUnreadBadge()
  })
  // sync-complete is a drift-correction fallback (fires even when added = 0)
  window.inboxmy.onSyncComplete(() => refreshUnreadCount())
}
```

**When user reads an email** (in existing email-open handler):
```js
unreadCount = Math.max(0, unreadCount - 1)
renderUnreadBadge()
```

**Settings modal — notification toggle:**

HTML (inside the existing settings modal — use `<div>` not `<p>` for layout consistency with existing rows):
```html
<div class="settings-row">
  <label for="notif-toggle">Email notifications</label>
  <input type="checkbox" id="notif-toggle" onchange="handleNotifToggle(this.checked)">
</div>
<div id="notif-off-label" style="display:none; color: var(--color-danger, #e05); font-size: 0.85rem; padding: 4px 0 8px;">
  Notifications are off
</div>
```

JS:
```js
async function loadNotifSettings() {
  if (!window.inboxmy) return
  const enabled = await window.inboxmy.getNotifPref().catch(() => true)
  const toggle = document.getElementById('notif-toggle')
  const offLabel = document.getElementById('notif-off-label')
  if (toggle) toggle.checked = enabled
  if (offLabel) offLabel.style.display = enabled ? 'none' : ''
}

async function handleNotifToggle(enabled) {
  if (!window.inboxmy) return
  await window.inboxmy.setNotifPref(enabled)
  const offLabel = document.getElementById('notif-off-label')
  if (offLabel) offLabel.style.display = enabled ? 'none' : ''
}
```

Call `loadNotifSettings()` from `openSettings()`.

---

## Data Flow

```
[app.whenReady]
  → loadPrefs() → cache emailNotifEnabled in memory

[60s timer] runSyncTick
  → const body = await POST /api/sync/trigger   ← body collected, not drained
  → { added, emails: NewEmailSummary[] }
  → if added > 0 && emailNotifEnabled:
      load notified-emails.json, filter to fresh[]
      if fresh.length 1–3: individual toasts (title=sender, body=subject)
      if fresh.length 4+: grouped toast (count=fresh.length, not raw added)
      save notified-emails.json (pruned to 500)
  → if added > 0:
      GET /api/emails/unread-count (single fetch)
      → setWindowsBadge(mainWindow, count)          ← taskbar badge
      → send IPC 'new-emails' { added, unreadCount } ← renderer badge (always fires, not gated on pref)
  → send IPC 'sync-complete' (unconditional fallback)

[new-emails IPC — renderer]
  → unreadCount = unreadCount field (authoritative, not incremented)
  → renderUnreadBadge()

[sync-complete IPC — renderer]
  → refreshUnreadCount() re-fetches from API (drift correction)

[user reads email]
  → PATCH /api/emails/:id/read (existing)
  → unreadCount = max(0, unreadCount - 1), renderUnreadBadge()

[settings open]
  → getNotifPref IPC → reflect in toggle + off-label

[settings toggle]
  → setNotifPref IPC → emailNotifEnabled updated in memory + disk
  → show/hide "Notifications are off" label
```

---

## Error Handling

- `runSyncTick` body parse failure: log, skip notifications, continue
- `saveEmailNotified` write failure: logged, swallowed — worst case: duplicate toast on next tick
- `saveNotified` (bills) write failure: same pattern — fix existing code to add try/catch
- `savePrefs` write failure: logged, swallowed — IPC returns `{ ok: true }` (optimistic UI)
- `get-notif-pref` IPC failure in renderer: default toggle to checked (`.catch(() => true)`)
- `unread-count` fetch failure on load: badge stays at 0, silent
- `mainWindow` null/destroyed: all IPC sends guarded by `!mainWindow.isDestroyed()` check

---

## Out of Scope

- Per-account notification muting (future)
- Custom notification sound file (future)
- Notification history panel (future)

---

## Test Plan

1. **Unit** — `syncAccount` returns `{ added, errors, newEmails }` where each `newEmails[i].subject` matches `NormalizedEmail.subject` plaintext (not encrypted bytes)
2. **Unit** — `syncAllAccounts` captures each iteration's return value and accumulates `added` and `newEmails` correctly across multiple accounts
3. **Unit** — `GET /api/emails/unread-count` returns correct count: only `is_read=0`, `folder='inbox'`, `tab!='promotions'` rows included; Promotions-tab emails excluded
4. **Integration** — `POST /api/sync/trigger` (all-accounts, fixture with ≥1 account and ≥1 new email) responds `{ added: N, emails: [...] }` with N > 0 and non-empty array
5. **Electron manual** — 1–3 new emails: one toast per email fires with sender as title and subject (≤100 chars) as body
6. **Electron manual** — 4+ new emails: single grouped toast; body uses `fresh.length`, not raw `added`
7. **Electron manual** — toggle off in Settings → toasts suppressed on next sync; "Notifications are off" label visible; badge still updates
8. **Electron manual** — toggle on → toasts resume; label hidden
9. **Frontend manual** — unread badge set from authoritative `unreadCount` on `new-emails` IPC; decrements on read; hides at 0; shows `99+` above 99
10. **Frontend manual** — `sync-complete` re-fetches and corrects badge drift
