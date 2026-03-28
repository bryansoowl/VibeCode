# Email Arrival Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fire BlueMail-style Windows toast notifications when new emails arrive, show a live unread badge in the toolbar, and let users toggle notifications on/off from Settings.

**Architecture:** The backend sync engine returns new email summaries; the sync route exposes them; the Electron main process fires toasts and fetches the authoritative unread count, sending both to the renderer via IPC. The renderer owns the badge display and settings toggle. Prefs are stored in `userData/prefs.json` with an in-memory cache to avoid hot-path disk reads.

**Tech Stack:** TypeScript + Vitest (backend), Electron 31 `Notification` API + `net.request` (main), vanilla JS (renderer), better-sqlite3 (DB)

---

## File Map

| File | Change |
|------|--------|
| `inboxmy-backend/src/email/sync-engine.ts` | Export `NewEmailSummary`; update `syncAccount` return; update `syncAllAccounts` loop |
| `inboxmy-backend/src/routes/sync.ts` | Return `{ added, emails }` from all-accounts and single-account paths |
| `inboxmy-backend/src/routes/emails.ts` | Add `GET /api/emails/unread-count` |
| `inboxmy-backend/tests/email/sync-engine.test.ts` | Add `newEmails` return tests |
| `inboxmy-backend/tests/routes/sync.test.ts` | New file — test sync trigger response shape |
| `inboxmy-backend/tests/routes/emails.test.ts` | New file — test unread-count endpoint |
| `electron/main.js` | Prefs cache, email dedup helpers, `setWindowsBadge` label param, IPC handlers, `runSyncTick` body collection + notification logic, bill call site fixes |
| `electron/preload.js` | Add `onNewEmails`, `getNotifPref`, `setNotifPref` |
| `frontend/index.html` | Add `#unread-badge` span in toolbar; add notification toggle in Settings modal |
| `frontend/app.js` | `refreshUnreadCount`, `renderUnreadBadge`, IPC wiring, read-decrement, `loadNotifSettings`, `handleNotifToggle` |

---

## Task 1: `syncAccount` returns `newEmails`

**Files:**
- Modify: `inboxmy-backend/src/email/sync-engine.ts`
- Modify: `inboxmy-backend/tests/email/sync-engine.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `tests/email/sync-engine.test.ts` after the existing `describe` block:

```ts
describe('syncAccount — newEmails return', () => {
  beforeEach(() => { vi.resetAllMocks() })

  it('returns newEmails with plaintext subject and sender for each newly inserted email', async () => {
    const id = randomUUID()
    seedAccount(id, 'gmail')

    const email: import('../../src/email/types').NormalizedEmail = {
      id: randomUUID(),
      accountId: id,
      threadId: null,
      subject: 'Your TNB bill is ready',
      sender: 'billing@tnb.com.my',
      senderName: 'TNB Billing',
      receivedAt: Date.now(),
      isRead: false,
      folder: 'inbox',
      tab: 'primary',
      isImportant: false,
      category: 'bill',
      bodyHtml: null,
      bodyText: null,
      snippet: null,
      rawSize: 100,
    }

    vi.mocked(mockGmailFetch).mockResolvedValue({ emails: [email], newHistoryId: null })

    const result = await syncAccount(id, TEST_KEY)

    expect(result.added).toBe(1)
    expect(result.newEmails).toHaveLength(1)
    expect(result.newEmails[0].id).toBe(email.id)
    expect(result.newEmails[0].sender).toBe('billing@tnb.com.my')
    expect(result.newEmails[0].senderName).toBe('TNB Billing')
    expect(result.newEmails[0].subject).toBe('Your TNB bill is ready')
    expect(result.newEmails[0].accountId).toBe(id)
  })

  it('returns empty newEmails when no new emails are fetched', async () => {
    const id = randomUUID()
    seedAccount(id, 'gmail')
    vi.mocked(mockGmailFetch).mockResolvedValue({ emails: [], newHistoryId: null })

    const result = await syncAccount(id, TEST_KEY)

    expect(result.added).toBe(0)
    expect(result.newEmails).toHaveLength(0)
  })

  it('does not include duplicate emails in newEmails on second sync', async () => {
    const id = randomUUID()
    seedAccount(id, 'gmail')

    const email: import('../../src/email/types').NormalizedEmail = {
      id: randomUUID(), accountId: id, threadId: null,
      subject: 'Duplicate test', sender: 'a@b.com', senderName: null,
      receivedAt: Date.now(), isRead: false, folder: 'inbox', tab: 'primary',
      isImportant: false, category: null, bodyHtml: null, bodyText: null,
      snippet: null, rawSize: 50,
    }

    vi.mocked(mockGmailFetch).mockResolvedValue({ emails: [email], newHistoryId: null })
    await syncAccount(id, TEST_KEY)       // first sync — inserts

    vi.mocked(mockGmailFetch).mockResolvedValue({ emails: [email], newHistoryId: null })
    const result = await syncAccount(id, TEST_KEY)   // second sync — INSERT OR IGNORE skips it

    expect(result.added).toBe(0)
    expect(result.newEmails).toHaveLength(0)
  })

  it('slices subject to 200 chars', async () => {
    const id = randomUUID()
    seedAccount(id, 'gmail')

    const longSubject = 'A'.repeat(300)
    const email: import('../../src/email/types').NormalizedEmail = {
      id: randomUUID(), accountId: id, threadId: null, subject: longSubject,
      sender: 'a@b.com', senderName: null, receivedAt: Date.now(), isRead: false,
      folder: 'inbox', tab: 'primary', isImportant: false, category: null,
      bodyHtml: null, bodyText: null, snippet: null, rawSize: 50,
    }

    vi.mocked(mockGmailFetch).mockResolvedValue({ emails: [email], newHistoryId: null })
    const result = await syncAccount(id, TEST_KEY)

    expect(result.newEmails[0].subject).toHaveLength(200)
  })
})
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd inboxmy-backend && npm test -- --reporter=verbose tests/email/sync-engine.test.ts
```

Expected: `newEmails` tests FAIL with "Property 'newEmails' does not exist" or similar.

- [ ] **Step 3: Add `NewEmailSummary` interface and update `syncAccount`**

In `src/email/sync-engine.ts`, add the exported interface after the imports:

```ts
export interface NewEmailSummary {
  id: string
  sender: string
  senderName: string | null
  subject: string   // plaintext from NormalizedEmail.subject before encryption, max 200 chars
  accountId: string
}
```

Change `syncAccount` return type annotation from `Promise<{ added: number; errors: string[] }>` to `Promise<{ added: number; errors: string[]; newEmails: NewEmailSummary[] }>`.

Declare the accumulator **before** the `db.transaction` call (just after `let added = 0`):

```ts
const newEmails: NewEmailSummary[] = []
```

Inside the `syncAll` transaction callback, find the `if (result.changes > 0)` block and add the push after `added++`:

```ts
newEmails.push({
  id: email.id,
  sender: email.sender,
  senderName: email.senderName ?? null,
  subject: (email.subject ?? '').slice(0, 200),
  accountId,
})
```

At the end of the `try` block, change the final `return { added, errors }` to:

```ts
return { added, errors, newEmails }
```

In the `catch` block, change `return { added, errors }` to:

```ts
return { added, errors, newEmails }
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
cd inboxmy-backend && npm test -- --reporter=verbose tests/email/sync-engine.test.ts
```

Expected: All tests in the file PASS.

- [ ] **Step 5: Commit**

```bash
cd inboxmy-backend && git add src/email/sync-engine.ts tests/email/sync-engine.test.ts
git commit -m "feat: syncAccount returns newEmails summaries with plaintext subject"
```

---

## Task 2: `syncAllAccounts` accumulates and returns results

**Files:**
- Modify: `inboxmy-backend/src/email/sync-engine.ts`
- Modify: `inboxmy-backend/tests/email/sync-engine.test.ts`

- [ ] **Step 1: Write failing test**

Add to `tests/email/sync-engine.test.ts`:

```ts
describe('syncAllAccounts — returns accumulated results', () => {
  beforeEach(() => { vi.resetAllMocks() })

  it('returns combined added count and newEmails across all accounts for a user', async () => {
    // Create a real user so syncAllAccounts can look up accounts by user_id
    const { getDb } = await import('../../src/db')
    const { encryptSystem } = await import('../../src/crypto')
    const userId = randomUUID()
    const db = getDb()

    // Insert the user directly
    db.prepare(`INSERT OR IGNORE INTO users (id, email, password_hash, data_key_enc, created_at)
      VALUES (?, ?, ?, ?, ?)`
    ).run(userId, `${userId}@test.com`, 'hash', encryptSystem('key'), Date.now())

    const acc1 = randomUUID()
    const acc2 = randomUUID()
    db.prepare(`INSERT INTO accounts (id, provider, email, token_enc, created_at, user_id)
      VALUES (?, 'gmail', ?, ?, ?, ?)`
    ).run(acc1, `${acc1}@test.com`, encryptSystem('{}'), Date.now(), userId)
    db.prepare(`INSERT INTO accounts (id, provider, email, token_enc, created_at, user_id)
      VALUES (?, 'gmail', ?, ?, ?, ?)`
    ).run(acc2, `${acc2}@test.com`, encryptSystem('{}'), Date.now(), userId)

    const makeEmail = (accountId: string): import('../../src/email/types').NormalizedEmail => ({
      id: randomUUID(), accountId, threadId: null, subject: `Email for ${accountId}`,
      sender: 'a@b.com', senderName: 'Sender', receivedAt: Date.now(), isRead: false,
      folder: 'inbox', tab: 'primary', isImportant: false, category: null,
      bodyHtml: null, bodyText: null, snippet: null, rawSize: 50,
    })

    vi.mocked(mockGmailFetch)
      .mockResolvedValueOnce({ emails: [makeEmail(acc1)], newHistoryId: null })
      .mockResolvedValueOnce({ emails: [makeEmail(acc2)], newHistoryId: null })

    const { syncAllAccounts } = await import('../../src/email/sync-engine')
    const result = await syncAllAccounts(userId, TEST_KEY)

    expect(result.added).toBe(2)
    expect(result.newEmails).toHaveLength(2)
    const accountIds = result.newEmails.map(e => e.accountId)
    expect(accountIds).toContain(acc1)
    expect(accountIds).toContain(acc2)
  })
})
```

- [ ] **Step 2: Run test to confirm it fails**

```bash
cd inboxmy-backend && npm test -- --reporter=verbose tests/email/sync-engine.test.ts
```

Expected: New `syncAllAccounts` test FAILS — current implementation returns `void`.

- [ ] **Step 3: Update `syncAllAccounts`**

In `src/email/sync-engine.ts`, change `syncAllAccounts` signature and body:

```ts
export async function syncAllAccounts(
  userId: string,
  dataKey: Buffer
): Promise<{ added: number; newEmails: NewEmailSummary[] }> {
  const db = getDb()
  const accounts = db.prepare('SELECT id FROM accounts WHERE user_id = ?').all(userId) as any[]
  let totalAdded = 0
  const allNewEmails: NewEmailSummary[] = []
  for (const acc of accounts) {
    const result = await syncAccount(acc.id, dataKey)
    totalAdded += result.added
    allNewEmails.push(...result.newEmails)
  }
  return { added: totalAdded, newEmails: allNewEmails }
}
```

- [ ] **Step 4: Run all tests**

```bash
cd inboxmy-backend && npm test -- --reporter=verbose
```

Expected: All tests PASS (114+).

- [ ] **Step 5: Commit**

```bash
cd inboxmy-backend && git add src/email/sync-engine.ts tests/email/sync-engine.test.ts
git commit -m "feat: syncAllAccounts returns accumulated added count and newEmails"
```

---

## Task 3: Sync route returns `{ added, emails }`

**Files:**
- Modify: `inboxmy-backend/src/routes/sync.ts`
- Create: `inboxmy-backend/tests/routes/sync.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/routes/sync.test.ts`:

```ts
// tests/routes/sync.test.ts
import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest'
import { closeDb, getDb } from '../../src/db'
import { encryptSystem } from '../../src/crypto'
import { randomUUID } from 'crypto'
import { createTestUser } from '../helpers/auth'

vi.mock('../../src/email/gmail-client', () => ({ fetchNewEmails: vi.fn() }))
vi.mock('../../src/email/outlook-client', () => ({ fetchNewEmails: vi.fn() }))

import { fetchNewEmails as mockGmailFetch } from '../../src/email/gmail-client'
import type { NormalizedEmail } from '../../src/email/types'

afterAll(() => closeDb())

function makeEmail(accountId: string): NormalizedEmail {
  return {
    id: randomUUID(), accountId, threadId: null, subject: 'Test Subject',
    sender: 'sender@test.com', senderName: 'Sender Name', receivedAt: Date.now(),
    isRead: false, folder: 'inbox', tab: 'primary', isImportant: false, category: null,
    bodyHtml: null, bodyText: null, snippet: null, rawSize: 100,
  }
}

function seedAccount(userId: string) {
  const accountId = randomUUID()
  getDb().prepare(`
    INSERT INTO accounts (id, provider, email, token_enc, created_at, user_id)
    VALUES (?, 'gmail', ?, ?, ?, ?)
  `).run(accountId, `${accountId}@test.com`, encryptSystem('{}'), Date.now(), userId)
  return accountId
}

describe('POST /api/sync/trigger — all accounts', () => {
  beforeEach(() => { vi.resetAllMocks() })

  it('returns { added, emails } when new emails are found', async () => {
    const { agent, id: userId } = await createTestUser()
    const accountId = seedAccount(userId)
    const email = makeEmail(accountId)

    vi.mocked(mockGmailFetch).mockResolvedValue({ emails: [email], newHistoryId: null })

    const res = await agent.post('/api/sync/trigger').send({})

    expect(res.status).toBe(200)
    expect(typeof res.body.added).toBe('number')
    expect(res.body.added).toBe(1)
    expect(Array.isArray(res.body.emails)).toBe(true)
    expect(res.body.emails).toHaveLength(1)
    expect(res.body.emails[0].subject).toBe('Test Subject')
    expect(res.body.emails[0].sender).toBe('sender@test.com')
    expect(res.body.emails[0].senderName).toBe('Sender Name')
    expect(res.body.emails[0].accountId).toBe(accountId)
  })

  it('returns { added: 0, emails: [] } when no new emails', async () => {
    const { agent, id: userId } = await createTestUser()
    seedAccount(userId)
    vi.mocked(mockGmailFetch).mockResolvedValue({ emails: [], newHistoryId: null })

    const res = await agent.post('/api/sync/trigger').send({})

    expect(res.status).toBe(200)
    expect(res.body.added).toBe(0)
    expect(res.body.emails).toEqual([])
  })

  it('returns 401 without session', async () => {
    const { default: request } = await import('supertest')
    const { app } = await import('../../src/server')
    const res = await request(app).post('/api/sync/trigger').send({})
    expect(res.status).toBe(401)
  })
})
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd inboxmy-backend && npm test -- --reporter=verbose tests/routes/sync.test.ts
```

Expected: Tests FAIL — current route returns `{ ok: true }`, not `{ added, emails }`.

- [ ] **Step 3: Update `src/routes/sync.ts`**

Replace the all-accounts path body:

```ts
// OLD:
await syncAllAccounts(user.id, user.dataKey)
console.log('[sync] Done — all accounts')
res.json({ ok: true })

// NEW:
const result = await syncAllAccounts(user.id, user.dataKey)
console.log(`[sync] Done — all accounts, added ${result.added} emails`)
res.json({ added: result.added, emails: result.newEmails })
```

Replace the single-account path body (the `res.json(result)` line):

```ts
// OLD:
res.json(result)

// NEW:
res.json({ added: result.added, emails: result.newEmails, errors: result.errors })
```

Also add `NewEmailSummary` to the import from `sync-engine` if TypeScript needs it (it may be inferred).

- [ ] **Step 4: Run all tests**

```bash
cd inboxmy-backend && npm test -- --reporter=verbose
```

Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
cd inboxmy-backend && git add src/routes/sync.ts tests/routes/sync.test.ts
git commit -m "feat: sync trigger returns { added, emails } with NewEmailSummary array"
```

---

## Task 4: `GET /api/emails/unread-count` endpoint

**Files:**
- Modify: `inboxmy-backend/src/routes/emails.ts`
- Create: `inboxmy-backend/tests/routes/emails.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/routes/emails.test.ts`:

```ts
// tests/routes/emails.test.ts
import { describe, it, expect, afterAll } from 'vitest'
import { closeDb, getDb } from '../../src/db'
import { encryptSystem, encrypt } from '../../src/crypto'
import { randomUUID } from 'crypto'
import { createTestUser } from '../helpers/auth'

afterAll(() => closeDb())

const KEY = Buffer.alloc(32)

function seedEmail(userId: string, opts: {
  isRead?: boolean
  folder?: string
  tab?: string
}) {
  const db = getDb()
  const accountId = randomUUID()
  const emailId = randomUUID()

  db.prepare(`
    INSERT INTO accounts (id, provider, email, token_enc, created_at, user_id)
    VALUES (?, 'gmail', ?, ?, ?, ?)
  `).run(accountId, `${accountId}@test.com`, encryptSystem('{}'), Date.now(), userId)

  db.prepare(`
    INSERT INTO emails (id, account_id, subject_enc, sender, received_at, is_read, folder, tab)
    VALUES (?, ?, ?, 'test@test.com', ?, ?, ?, ?)
  `).run(
    emailId, accountId,
    encrypt('Test Subject', KEY),
    Date.now(),
    opts.isRead ? 1 : 0,
    opts.folder ?? 'inbox',
    opts.tab ?? 'primary'
  )

  return { emailId, accountId }
}

describe('GET /api/emails/unread-count', () => {
  it('returns count of unread inbox non-promotions emails', async () => {
    const { agent, id: userId } = await createTestUser()
    seedEmail(userId, { isRead: false, folder: 'inbox', tab: 'primary' })
    seedEmail(userId, { isRead: false, folder: 'inbox', tab: 'primary' })

    const res = await agent.get('/api/emails/unread-count')

    expect(res.status).toBe(200)
    expect(res.body.count).toBeGreaterThanOrEqual(2)
  })

  it('excludes read emails', async () => {
    const { agent, id: userId } = await createTestUser()
    seedEmail(userId, { isRead: true, folder: 'inbox', tab: 'primary' })

    const res = await agent.get('/api/emails/unread-count')

    expect(res.status).toBe(200)
    expect(res.body.count).toBe(0)
  })

  it('excludes Promotions tab emails', async () => {
    const { agent, id: userId } = await createTestUser()
    seedEmail(userId, { isRead: false, folder: 'inbox', tab: 'promotions' })

    const res = await agent.get('/api/emails/unread-count')

    expect(res.status).toBe(200)
    expect(res.body.count).toBe(0)
  })

  it('excludes non-inbox folders', async () => {
    const { agent, id: userId } = await createTestUser()
    seedEmail(userId, { isRead: false, folder: 'spam', tab: 'primary' })

    const res = await agent.get('/api/emails/unread-count')

    expect(res.status).toBe(200)
    expect(res.body.count).toBe(0)
  })

  it('does not count another user\'s emails', async () => {
    const { id: userId1 } = await createTestUser()
    const { agent: agent2 } = await createTestUser()
    seedEmail(userId1, { isRead: false, folder: 'inbox', tab: 'primary' })

    const res = await agent2.get('/api/emails/unread-count')

    expect(res.status).toBe(200)
    expect(res.body.count).toBe(0)
  })

  it('returns 401 without session', async () => {
    const { default: request } = await import('supertest')
    const { app } = await import('../../src/server')
    const res = await request(app).get('/api/emails/unread-count')
    expect(res.status).toBe(401)
  })
})
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd inboxmy-backend && npm test -- --reporter=verbose tests/routes/emails.test.ts
```

Expected: Tests FAIL with 404 (endpoint does not exist yet).

- [ ] **Step 3: Add the endpoint to `src/routes/emails.ts`**

Add before the `export` statement (or at the end of the route definitions, before any `export`):

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

- [ ] **Step 4: Run all tests**

```bash
cd inboxmy-backend && npm test -- --reporter=verbose
```

Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
cd inboxmy-backend && git add src/routes/emails.ts tests/routes/emails.test.ts
git commit -m "feat: add GET /api/emails/unread-count endpoint"
```

---

## Task 5: Electron main — infrastructure (prefs, dedup, badge label, IPC)

**Files:**
- Modify: `electron/main.js`

No automated tests for the main process — verify via manual test at the end.

- [ ] **Step 1: Add file-path constants**

Near the top of `main.js`, after `const NOTIFIED_FILE = ...`:

```js
const EMAIL_NOTIFIED_FILE = path.join(app.getPath('userData'), 'notified-emails.json')
const PREFS_FILE = path.join(app.getPath('userData'), 'prefs.json')
```

- [ ] **Step 2: Add in-memory cache variable**

After the existing `let tray = null` block:

```js
let emailNotifEnabled = true  // in-memory cache — populated in app.whenReady
```

- [ ] **Step 3: Add email-notified helpers**

After the existing `saveNotified` function, add:

```js
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

- [ ] **Step 4: Fix `saveNotified` (bills) to add error handling**

The existing `saveNotified` at the top of `main.js` currently has no try/catch and will throw on disk failure. Change it to:

```js
function saveNotified(map) {
  try { fs.writeFileSync(NOTIFIED_FILE, JSON.stringify(map)) }
  catch (e) { console.error('[notified] Failed to save:', e.message) }
}
```

- [ ] **Step 5: Add prefs helpers**

After the `saveEmailNotified` function:

```js
function loadPrefs() {
  try { return { emailNotifications: true, ...JSON.parse(fs.readFileSync(PREFS_FILE, 'utf8')) } }
  catch { return { emailNotifications: true } }
}
function savePrefs(prefs) {
  try { fs.writeFileSync(PREFS_FILE, JSON.stringify(prefs)) }
  catch (e) { console.error('[prefs] Failed to save:', e.message) }
}
```

- [ ] **Step 6: Update `setWindowsBadge` to accept a label parameter**

Change the function signature and accessibility string:

```js
// OLD:
function setWindowsBadge(win, count) {
  ...
  win.setOverlayIcon(img, `${count} overdue`)

// NEW:
function setWindowsBadge(win, count, label = 'unread') {
  ...
  win.setOverlayIcon(img, `${count} ${label}`)
```

- [ ] **Step 7: Fix the three existing `setWindowsBadge` call sites in `runSchedulerTick`**

There are three calls in `runSchedulerTick` that must now pass `'overdue'` as the third argument:

1. Early-return guard when no bills (line ~207): `setWindowsBadge(mainWindow, 0)` → `setWindowsBadge(mainWindow, 0, 'overdue')`
2. Early-return guard when no fresh bills (line ~220): `setWindowsBadge(mainWindow, bills.length)` → `setWindowsBadge(mainWindow, bills.length, 'overdue')`
3. End of function (line ~288): `setWindowsBadge(mainWindow, bills.length)` → `setWindowsBadge(mainWindow, bills.length, 'overdue')`

- [ ] **Step 8: Add IPC handlers to `setupIPC()`**

After the existing `ipcMain.on('navigate-to-bill', ...)` handler:

```js
ipcMain.handle('get-notif-pref', () => emailNotifEnabled)

ipcMain.handle('set-notif-pref', (_, enabled) => {
  emailNotifEnabled = Boolean(enabled)
  const prefs = loadPrefs()
  prefs.emailNotifications = emailNotifEnabled
  savePrefs(prefs)
  return { ok: true }
})
```

- [ ] **Step 9: Initialise `emailNotifEnabled` cache in `app.whenReady()`**

In `app.whenReady().then(async () => { ... })`, after the `setupIPC()` call:

```js
emailNotifEnabled = loadPrefs().emailNotifications
```

- [ ] **Step 10: Commit**

```bash
git add electron/main.js
git commit -m "feat: add prefs cache, email dedup helpers, badge label param, notif IPC handlers"
```

---

## Task 6: Electron main — update `runSyncTick` with notification logic

**Files:**
- Modify: `electron/main.js`

- [ ] **Step 1: Replace the body-draining sync request with body accumulation**

In `runSyncTick`, find the `await new Promise((resolve) => {` block that calls `POST /api/sync/trigger`. Replace it entirely:

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

- [ ] **Step 2: Add notification + badge logic after the sync request**

Directly after the `const body = await ...` block (and before the existing `// Tell the renderer to refresh` comment), add:

```js
let syncResult = {}
try { syncResult = JSON.parse(body) } catch { /* parse failed — skip notifications */ }

const { added = 0, emails = [] } = syncResult

// Fire email arrival toasts (only if notifications are enabled)
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

// Fetch authoritative unread count → update taskbar badge + send to renderer
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
          setWindowsBadge(mainWindow, unreadCount)
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

- [ ] **Step 3: Remove (or keep) the old `sync-complete` IPC send**

The existing line `mainWindow.webContents.send('sync-complete')` should remain unconditionally at the end of `runSyncTick` as a drift-correction fallback. Confirm it is still present after your changes.

- [ ] **Step 4: Commit**

```bash
git add electron/main.js
git commit -m "feat: runSyncTick fires email toasts and updates unread badge after sync"
```

---

## Task 7: Preload — expose new IPC methods

**Files:**
- Modify: `electron/preload.js`

- [ ] **Step 1: Add three new entries to `window.inboxmy`**

In `preload.js`, inside the `contextBridge.exposeInMainWorld('inboxmy', { ... })` object, add after the existing `getAutoLaunch` entry:

```js
// Email arrival — carries authoritative unreadCount from main process
onNewEmails: (cb) => ipcRenderer.on('new-emails', (_, data) => cb(data)),

// Notification preference toggle
getNotifPref: () => ipcRenderer.invoke('get-notif-pref'),
setNotifPref: (enabled) => ipcRenderer.invoke('set-notif-pref', enabled),
```

- [ ] **Step 2: Commit**

```bash
git add electron/preload.js
git commit -m "feat: expose onNewEmails, getNotifPref, setNotifPref via contextBridge"
```

---

## Task 8: Frontend HTML — unread badge + settings toggle

**Files:**
- Modify: `frontend/index.html`

- [ ] **Step 1: Add `#unread-badge` span in the toolbar**

In `index.html`, find the `.tb-right` div (around line 345). Add the badge span **before** the `.profile-wrap` div:

```html
<div class="tb-right">
  <button class="tb-lang" id="sync-btn" onclick="doSync()">↻ Sync</button>
  <span id="sync-status" style="font-size:11px;color:var(--ink4)"></span>
  <button class="tb-lang active" id="lang-en" onclick="setLang('en')">EN</button>
  <button class="tb-lang" id="lang-bm" onclick="setLang('bm')">BM</button>
  <span id="unread-badge" class="sb-badge" style="display:none;cursor:default" title="Unread emails"></span>
  <div class="profile-wrap">
```

Using the existing `.sb-badge` class gives it the correct coral pill styling for free.

- [ ] **Step 2: Add notification toggle to the Settings modal**

In `index.html`, find the `settings-ai` section (around line 568). Add a new `settings-field` for the notification toggle **inside** `#settings-ai`, after the `auto-launch-field` div and before the closing `</div>` of `settings-ai`:

```html
<div class="settings-field" id="notif-toggle-field">
  <label>
    <input type="checkbox" id="notif-toggle" onchange="handleNotifToggle(this.checked)" />
    Email notifications (new email toasts + sound)
  </label>
  <div id="notif-off-label" style="display:none; color: var(--coral); font-size: 0.85rem; margin-top: 4px;">
    Notifications are off
  </div>
</div>
```

- [ ] **Step 3: Commit**

```bash
git add frontend/index.html
git commit -m "feat: add unread badge to toolbar and notification toggle to settings modal"
```

---

## Task 9: Frontend JS — badge logic, IPC wiring, settings

**Files:**
- Modify: `frontend/app.js`

- [ ] **Step 1: Add `unreadCount` state and helpers**

Near the top of `app.js`, after the `const API = ''` line, add:

```js
// ── UNREAD BADGE ─────────────────────────────────────────────────────────────
let unreadCount = 0

async function refreshUnreadCount() {
  try {
    const { count } = await apiFetch('/api/emails/unread-count')
    unreadCount = count
    renderUnreadBadge()
  } catch { /* silent — badge stays at last known value */ }
}

function renderUnreadBadge() {
  const el = document.getElementById('unread-badge')
  if (!el) return
  if (unreadCount <= 0) { el.style.display = 'none'; return }
  el.textContent = unreadCount > 99 ? '99+' : String(unreadCount)
  el.style.display = ''
}
```

- [ ] **Step 2: Wire up IPC events and initial load**

In the `checkAuth` IIFE (the one that runs on page load) at the top, after setting up the avatar, add a call to `refreshUnreadCount()`. Or alternatively, add a new self-executing init block after the `checkAuth` IIFE:

```js
// ── NOTIFICATION + BADGE INIT ────────────────────────────────────────────────
;(function initNotifications() {
  refreshUnreadCount()

  if (window.inboxmy) {
    // new-emails: authoritative count from main — set directly
    window.inboxmy.onNewEmails(({ unreadCount: count }) => {
      unreadCount = count
      renderUnreadBadge()
    })
    // sync-complete: drift correction fallback
    window.inboxmy.onSyncComplete(() => refreshUnreadCount())
  }
})()
```

Note: `onSyncComplete` was already wired elsewhere in the original app. If it's already registered in `app.js`, **do not add a duplicate** — just add the `refreshUnreadCount()` call inside the existing handler.

Check the existing `onSyncComplete` usage:
```bash
grep -n "onSyncComplete" frontend/app.js
```
If an existing handler already calls `loadEmails(true)` etc., add `refreshUnreadCount()` to the same handler body rather than registering a second listener.

- [ ] **Step 3: Decrement badge when user reads an email**

In `app.js`, find the `if (!email.is_read)` block inside the email-open handler (around line 381). After the existing `// Decrement the relevant category badge` comment section, add:

```js
// Decrement the toolbar unread badge
unreadCount = Math.max(0, unreadCount - 1)
renderUnreadBadge()
```

- [ ] **Step 4: Add notification settings helpers**

Add after the `closeSettings` function:

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

- [ ] **Step 5: Call `loadNotifSettings` from `openSettings`**

Find the `openSettings` function and add `loadNotifSettings()` alongside the existing calls:

```js
function openSettings() {
  document.getElementById('profile-dropdown').classList.remove('open');
  renderSettingsAccounts();
  loadAISettings()
  loadNotifSettings()     // ← add this line
  document.getElementById('settings-modal').classList.add('open');
}
```

- [ ] **Step 6: Run the full backend test suite one final time**

```bash
cd inboxmy-backend && npm test -- --reporter=verbose
```

Expected: All tests PASS.

- [ ] **Step 7: Commit**

```bash
git add frontend/app.js
git commit -m "feat: live unread badge, email notification toggle in settings"
```

---

## Manual Verification Checklist

After all tasks are complete, run the Electron app (`npm start` or the dev launch command) and verify:

- [ ] 1–3 new emails on next sync → individual toast per email with sender as title and subject as body (≤100 chars)
- [ ] 4+ new emails → single grouped toast: "N new emails across M account(s)"
- [ ] Unread badge appears in toolbar, shows correct count, hides when 0, shows `99+` above 99
- [ ] Opening an email decrements the badge by 1
- [ ] Settings modal → "Email notifications" toggle present; unchecking shows red "Notifications are off" label
- [ ] With notifications off, new emails on next sync: **no toast**, but badge still updates
- [ ] Taskbar overlay badge shows unread count (not "overdue") after email sync
- [ ] Bill notifications still show correct "overdue" overlay badge label
- [ ] `sync-complete` refreshes badge from server after zero-add syncs
