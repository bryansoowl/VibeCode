# Unread Counts Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace 10 parallel badge API calls and fragile frontend counter arithmetic with a single `/api/emails/unread-counts` endpoint whose response drives all sidebar badges, and add proper mark-as-unread support.

**Architecture:** The backend gains one aggregation endpoint (single SQL query, all counts in one row) and the PATCH read endpoint now returns those counts in its response. The frontend replaces three scattered functions (`refreshUnreadCount`, `loadCategoryBadges`, `refreshSnoozedBadge`) with one (`refreshUnreadCounts`) and the inline optimistic-decrement hack with a proper `markEmailRead(id, isRead)` function that reconciles from the server response.

**Tech Stack:** TypeScript + Express + better-sqlite3 + Zod (backend); vanilla JS (frontend); Vitest + Supertest (tests)

**Spec:** `docs/superpowers/specs/2026-04-02-unread-counts-design.md`

---

## File Map

| File | What changes |
|---|---|
| `inboxmy-backend/src/db/migrations.ts` | Add new migration entry with `idx_emails_unread` index |
| `inboxmy-backend/src/routes/emails.ts` | Add `computeUnreadCounts()` helper + `GET /unread-counts`; rewrite `PATCH /:id/read`; delete `GET /unread-count` |
| `inboxmy-backend/tests/routes/emails.test.ts` | Extend `seedEmail`; replace old `/unread-count` describe block; add `/unread-counts` tests; update PATCH read tests |
| `frontend/app.js` | Replace state vars; add `renderUnreadBadges`, `refreshUnreadCounts`, `markEmailRead`; delete old functions; migrate all call sites |
| `frontend/index.html` | Replace single `ctx-toggle-read` menu item with two separate items |

---

## Task 1: Backend — Add `/unread-counts` endpoint, delete `/unread-count`

**Files:**
- Modify: `inboxmy-backend/src/routes/emails.ts:141-150` (replace old endpoint)
- Modify: `inboxmy-backend/src/routes/emails.ts:197-209` (update PATCH read)

- [ ] **Step 1: Write failing tests for the new `/unread-counts` endpoint**

Add a new `describe` block in `inboxmy-backend/tests/routes/emails.test.ts`. First, extend the `seedEmail` helper at the top of the file to support the extra fields needed:

```typescript
// Update seedEmail signature (replace existing function, lines 22-54):
function seedEmail(userId: string, opts: {
  isRead?: boolean
  folder?: string
  tab?: string
  subject?: string
  snippet?: string
  sender?: string
  receivedAt?: number
  accountId?: string
  dataKey?: Buffer
  category?: string       // NEW
  isImportant?: boolean   // NEW
  snoozedUntil?: number   // NEW (ms epoch)
}) {
  const db = getDb()
  const accountId = opts.accountId ?? seedAccount(userId)
  const emailId = randomUUID()
  const key = opts.dataKey ?? KEY

  db.prepare(`
    INSERT INTO emails
      (id, account_id, subject_enc, snippet, sender, received_at,
       is_read, folder, tab, category, is_important, snoozed_until)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    emailId,
    accountId,
    encrypt(opts.subject ?? 'Test Subject', key),
    opts.snippet ? encrypt(opts.snippet, key) : null,
    opts.sender ?? 'test@test.com',
    opts.receivedAt ?? Date.now(),
    opts.isRead ? 1 : 0,
    opts.folder ?? 'inbox',
    opts.tab ?? 'primary',
    opts.category ?? null,
    opts.isImportant ? 1 : 0,
    opts.snoozedUntil ?? null,
  )

  return { emailId, accountId }
}
```

Then add the new test describe block **after** the existing `/unread-count` describe block (keep the old block — you'll delete it in a later step):

```typescript
describe('GET /api/emails/unread-counts', () => {
  it('returns 401 without session', async () => {
    const { default: request } = await import('supertest')
    const { app } = await import('../../src/server')
    const res = await request(app).get('/api/emails/unread-counts')
    expect(res.status).toBe(401)
  })

  it('returns all-zero counts when no emails exist', async () => {
    const { agent } = await createTestUser()
    const res = await agent.get('/api/emails/unread-counts')
    expect(res.status).toBe(200)
    const keys = ['total_unread','bills','govt','receipts','work','important','promotions','snoozed','sent','draft','spam','archived']
    for (const k of keys) expect(res.body[k]).toBe(0)
  })

  it('total_unread counts unread emails across all folders excluding snoozed', async () => {
    const { agent, id: userId } = await createTestUser()
    seedEmail(userId, { isRead: false, folder: 'inbox' })
    seedEmail(userId, { isRead: false, folder: 'sent' })
    seedEmail(userId, { isRead: true,  folder: 'inbox' })     // read — excluded
    seedEmail(userId, { isRead: false, snoozedUntil: Date.now() + 60_000 }) // snoozed — excluded
    const res = await agent.get('/api/emails/unread-counts')
    expect(res.status).toBe(200)
    expect(res.body.total_unread).toBe(2)
  })

  it('bills counts unread bill-category emails excluding snoozed', async () => {
    const { agent, id: userId } = await createTestUser()
    seedEmail(userId, { isRead: false, category: 'bill' })
    seedEmail(userId, { isRead: true,  category: 'bill' })    // read — excluded
    seedEmail(userId, { isRead: false, category: 'bill', snoozedUntil: Date.now() + 60_000 }) // snoozed — excluded
    seedEmail(userId, { isRead: false, category: 'govt' })    // different category
    const res = await agent.get('/api/emails/unread-counts')
    expect(res.body.bills).toBe(1)
  })

  it('snoozed counts all snoozed emails regardless of is_read', async () => {
    const { agent, id: userId } = await createTestUser()
    const future = Date.now() + 60_000
    const past   = Date.now() - 60_000
    seedEmail(userId, { isRead: false, snoozedUntil: future }) // currently snoozed
    seedEmail(userId, { isRead: true,  snoozedUntil: future }) // currently snoozed (read)
    seedEmail(userId, { isRead: false, snoozedUntil: past   }) // past snooze — NOT counted
    const res = await agent.get('/api/emails/unread-counts')
    expect(res.body.snoozed).toBe(2)
  })

  it('important counts unread important emails excluding snoozed', async () => {
    const { agent, id: userId } = await createTestUser()
    seedEmail(userId, { isRead: false, isImportant: true })
    seedEmail(userId, { isRead: true,  isImportant: true })   // read — excluded
    seedEmail(userId, { isRead: false, isImportant: false })  // not important
    const res = await agent.get('/api/emails/unread-counts')
    expect(res.body.important).toBe(1)
  })

  it('does not count another user\'s emails', async () => {
    const { id: userId1 } = await createTestUser()
    const { agent: agent2 } = await createTestUser()
    seedEmail(userId1, { isRead: false })
    const res = await agent2.get('/api/emails/unread-counts')
    expect(res.body.total_unread).toBe(0)
  })
})
```

- [ ] **Step 2: Run the new tests — confirm they fail**

```bash
cd inboxmy-backend && npx vitest run tests/routes/emails.test.ts 2>&1 | grep -E "FAIL|PASS|Error" | head -20
```

Expected: multiple `FAIL` lines for the new `/api/emails/unread-counts` tests (404 or similar — endpoint doesn't exist yet).

- [ ] **Step 3: Add the performance index to `migrations.ts`**

In `inboxmy-backend/src/db/migrations.ts`, append a new migration entry before the closing `]` on line 101:

```typescript
  // Migration 9: composite index for fast unread count aggregation
  `CREATE INDEX IF NOT EXISTS idx_emails_unread
    ON emails(account_id, folder, is_read, tab, snoozed_until)`,
```

- [ ] **Step 4: Add the `computeUnreadCounts` helper and new endpoint in `emails.ts`**

Add right after line 150 (after the old `/unread-count` handler, before the `/:id` GET):

```typescript
// ── SHARED: compute all unread/badge counts for a user in one SQL query ──────
interface UnreadCounts {
  total_unread: number
  bills: number; govt: number; receipts: number; work: number
  important: number; promotions: number; snoozed: number
  sent: number; draft: number; spam: number; archived: number
}

function computeUnreadCounts(db: ReturnType<typeof getDb>, userId: string): UnreadCounts {
  return db.prepare(`
    SELECT
      COUNT(CASE WHEN e.is_read=0 AND e.snoozed_until IS NULL THEN 1 END) AS total_unread,
      COUNT(CASE WHEN e.is_read=0 AND e.snoozed_until IS NULL AND e.category='bill'    THEN 1 END) AS bills,
      COUNT(CASE WHEN e.is_read=0 AND e.snoozed_until IS NULL AND e.category='govt'    THEN 1 END) AS govt,
      COUNT(CASE WHEN e.is_read=0 AND e.snoozed_until IS NULL AND e.category='receipt' THEN 1 END) AS receipts,
      COUNT(CASE WHEN e.is_read=0 AND e.snoozed_until IS NULL AND e.category='work'    THEN 1 END) AS work,
      COUNT(CASE WHEN e.is_read=0 AND e.snoozed_until IS NULL AND e.is_important=1     THEN 1 END) AS important,
      COUNT(CASE WHEN e.is_read=0 AND e.snoozed_until IS NULL AND e.tab='promotions'   THEN 1 END) AS promotions,
      COUNT(CASE WHEN e.snoozed_until IS NOT NULL
                  AND e.snoozed_until > (strftime('%s','now') * 1000)                  THEN 1 END) AS snoozed,
      COUNT(CASE WHEN e.is_read=0 AND e.snoozed_until IS NULL AND e.folder='sent'      THEN 1 END) AS sent,
      COUNT(CASE WHEN e.is_read=0 AND e.snoozed_until IS NULL AND e.folder='draft'     THEN 1 END) AS draft,
      COUNT(CASE WHEN e.is_read=0 AND e.snoozed_until IS NULL AND e.folder='spam'      THEN 1 END) AS spam,
      COUNT(CASE WHEN e.is_read=0 AND e.snoozed_until IS NULL AND e.folder='archive'   THEN 1 END) AS archived
    FROM emails e
    JOIN accounts a ON a.id = e.account_id
    WHERE a.user_id = ?
  `).get(userId) as UnreadCounts
}

emailsRouter.get('/unread-counts', (req: Request, res: Response) => {
  const user = (req as any).user
  res.json(computeUnreadCounts(getDb(), user.id))
})
```

Also add the performance index to `inboxmy-backend/src/db/migrations.ts` as a new migration entry (this is the established pattern — all indexes live there). The migrations array ends at line 100 with `]`. Add a new entry before the closing bracket:

```typescript
// NEW: Migration 9 (append before the closing `]` at line 101):
  `CREATE INDEX IF NOT EXISTS idx_emails_unread
    ON emails(account_id, folder, is_read, tab, snoozed_until)`,
```

The full handler is simply:

```typescript
emailsRouter.get('/unread-counts', (req: Request, res: Response) => {
  const user = (req as any).user
  res.json(computeUnreadCounts(getDb(), user.id))
})
```

- [ ] **Step 5: Run tests — confirm new `/unread-counts` tests pass**

```bash
cd inboxmy-backend && npx vitest run tests/routes/emails.test.ts 2>&1 | grep -E "✓|✗|FAIL|PASS" | head -40
```

Expected: all new `/api/emails/unread-counts` tests pass. Old `/api/emails/unread-count` tests still pass (haven't deleted the old endpoint yet).

- [ ] **Step 6: Delete the old `/unread-count` endpoint**

In `emails.ts`, delete lines 141–150:
```typescript
// DELETE THIS ENTIRE BLOCK:
emailsRouter.get('/unread-count', (req: Request, res: Response) => {
  const user = (req as any).user
  const db = getDb()
  const row = db.prepare(`
    SELECT COUNT(*) as count FROM emails e
    JOIN accounts a ON a.id = e.account_id
    WHERE a.user_id = ? AND e.is_read = 0 AND e.folder = 'inbox' AND e.tab != 'promotions' AND e.snoozed_until IS NULL
  `).get(user.id) as { count: number }
  res.json({ count: row.count })
})
```

- [ ] **Step 7: Delete the old `/unread-count` tests, replace with a 404 check**

In `emails.test.ts`, replace the entire `describe('GET /api/emails/unread-count', ...)` block (lines 56–115) with:

```typescript
describe('GET /api/emails/unread-count (removed)', () => {
  it('returns 404 — endpoint has been replaced by /unread-counts', async () => {
    const { agent } = await createTestUser()
    const res = await agent.get('/api/emails/unread-count')
    expect(res.status).toBe(404)
  })
})
```

- [ ] **Step 8: Run full test suite — confirm no regressions**

```bash
cd inboxmy-backend && npx vitest run 2>&1 | tail -20
```

Expected: all tests pass.

- [ ] **Step 9: Commit**

```bash
cd "C:\Users\bryan.GOAT\Downloads\VibeCode"
git add inboxmy-backend/src/db/migrations.ts inboxmy-backend/src/routes/emails.ts inboxmy-backend/tests/routes/emails.test.ts
git commit -m "feat(api): add GET /api/emails/unread-counts, remove /unread-count"
```

---

## Task 2: Backend — Update PATCH `/:id/read` to return counts

**Files:**
- Modify: `inboxmy-backend/src/routes/emails.ts:197-209`
- Modify: `inboxmy-backend/tests/routes/emails.test.ts` (update PATCH read tests)

- [ ] **Step 1: Fix the three existing bodyless PATCH tests (lines 463–498)**

The current handler defaults to `is_read = 1` with no body. The new schema makes `is_read` required — these three tests will break if not updated first.

In `emails.test.ts`, update the `describe('PATCH /api/emails/:id/read', ...)` block:

```typescript
// Line 468 — was: agent.patch(`/api/emails/${emailId}/read`)
const res = await agent.patch(`/api/emails/${emailId}/read`).send({ is_read: true })
// ... keep remaining assertions (res.status 200, is_read DB check)

// Line 481 — was: agent.patch(`/api/emails/${emailId}/read`)
const res = await agent.patch(`/api/emails/${emailId}/read`).send({ is_read: true })

// Line 493 — was: agent.patch(`/api/emails/${emailId}/read`)
const res = await agent2.patch(`/api/emails/${emailId}/read`).send({ is_read: true })
```

- [ ] **Step 2: Write failing tests for the updated PATCH endpoint**

Find the existing PATCH read tests in `emails.test.ts`. Add these tests to that describe block:

```typescript
it('returns counts in response body', async () => {
  const { agent, id: userId } = await createTestUser()
  seedEmail(userId, { isRead: false, folder: 'inbox', tab: 'primary' })
  const { emailId } = seedEmail(userId, { isRead: false, folder: 'inbox', tab: 'primary' })

  const res = await agent.patch(`/api/emails/${emailId}/read`).send({ is_read: true })

  expect(res.status).toBe(200)
  expect(res.body.ok).toBe(true)
  expect(res.body.counts).toBeDefined()
  expect(typeof res.body.counts.total_unread).toBe('number')
  // After marking one of two unread emails as read, total_unread should be 1
  expect(res.body.counts.total_unread).toBe(1)
})

it('marks email as unread when is_read: false', async () => {
  const { agent, id: userId } = await createTestUser()
  const { emailId } = seedEmail(userId, { isRead: true, folder: 'inbox' })

  const res = await agent.patch(`/api/emails/${emailId}/read`).send({ is_read: false })

  expect(res.status).toBe(200)
  expect(res.body.counts.total_unread).toBe(1)
  const row = getDb().prepare('SELECT is_read FROM emails WHERE id = ?').get(emailId) as any
  expect(row.is_read).toBe(0)
})

it('returns 400 when body is missing is_read', async () => {
  const { agent, id: userId } = await createTestUser()
  const { emailId } = seedEmail(userId, { isRead: false })

  const res = await agent.patch(`/api/emails/${emailId}/read`).send({})

  expect(res.status).toBe(400)
})
```

- [ ] **Step 3: Run — confirm existing tests still pass, new tests fail**

```bash
cd inboxmy-backend && npx vitest run tests/routes/emails.test.ts 2>&1 | grep -E "✓|✗|FAIL|PASS" | head -40
```

Expected: the three updated existing tests pass; the three new tests (`returns counts`, `marks email as unread`, `400 when body`) fail.

- [ ] **Step 4: Rewrite the PATCH `/:id/read` handler**

Replace lines 197–209 in `emails.ts`:

```typescript
// OLD — delete this:
const readBody = z.object({ read: z.boolean().optional() })

emailsRouter.patch('/:id/read', (req: Request, res: Response) => {
  const parsed = readBody.safeParse(req.body)
  const isRead = parsed.success && parsed.data.read === false ? 0 : 1
  const user = (req as any).user
  const db = getDb()
  db.prepare(`
    UPDATE emails SET is_read = ?
    WHERE id = ? AND account_id IN (SELECT id FROM accounts WHERE user_id = ?)
  `).run(isRead, req.params.id, user.id)
  res.json({ ok: true })
})
```

Replace with:

```typescript
const readBody = z.object({ is_read: z.boolean() })

emailsRouter.patch('/:id/read', (req: Request, res: Response) => {
  const parsed = readBody.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })

  const user = (req as any).user
  const db = getDb()
  db.prepare(`
    UPDATE emails SET is_read = ?
    WHERE id = ? AND account_id IN (SELECT id FROM accounts WHERE user_id = ?)
  `).run(parsed.data.is_read ? 1 : 0, req.params.id, user.id)

  res.json({ ok: true, counts: computeUnreadCounts(db, user.id) })
})
```

- [ ] **Step 5: Run the PATCH tests — confirm they pass**

```bash
cd inboxmy-backend && npx vitest run tests/routes/emails.test.ts 2>&1 | grep -E "✓|✗|FAIL|PASS" | head -40
```

Expected: all tests pass including the three new PATCH tests.

- [ ] **Step 6: Run full test suite — confirm no regressions**

```bash
cd inboxmy-backend && npx vitest run 2>&1 | tail -20
```

Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
cd "C:\Users\bryan.GOAT\Downloads\VibeCode"
git add inboxmy-backend/src/routes/emails.ts inboxmy-backend/tests/routes/emails.test.ts
git commit -m "feat(api): PATCH /:id/read returns counts, field renamed to is_read"
```

---

## Task 3: Frontend — State, rendering, and fetching

**Files:**
- Modify: `frontend/app.js:40-57` (state vars + render function)
- Modify: `frontend/app.js:1039-1083` (loadCategoryBadges — delete)
- Modify: `frontend/app.js:1439-1444` (refreshSnoozedBadge — delete)

- [ ] **Step 1: Replace the state variable and render function**

In `frontend/app.js`, replace lines 40–57:

```javascript
// ── UNREAD BADGE ─────────────────────────────────────────────────────────────
let unreadCount = 0

async function refreshUnreadCount() {
  try {
    const data = await apiFetch('/api/emails/unread-count')
    unreadCount = data.count
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

With:

```javascript
// ── UNREAD BADGES ─────────────────────────────────────────────────────────────
let unreadCounts = {
  total_unread: 0,
  bills: 0, govt: 0, receipts: 0, work: 0,
  important: 0, promotions: 0, snoozed: 0,
  sent: 0, draft: 0, spam: 0, archived: 0,
}

// Tracks in-flight mark-read requests — prevents optimistic update races
const pendingReadRequests = new Map()  // emailId → boolean (target is_read)

function renderUnreadBadges(counts = unreadCounts) {
  const set = (id, n) => {
    const el = document.getElementById(id)
    if (!el) return
    el.textContent = n > 0 ? (n > 99 ? '99+' : String(n)) : ''
    if (id === 'unread-badge') el.style.display = n > 0 ? '' : 'none'
  }
  set('unread-badge',     counts.total_unread)
  set('badge-bills',      counts.bills)
  set('badge-govt',       counts.govt)
  set('badge-receipts',   counts.receipts)
  set('badge-work',       counts.work)
  set('badge-important',  counts.important)
  set('badge-promotions', counts.promotions)
  set('badge-snoozed',    counts.snoozed)
  set('badge-sent',       counts.sent)
  set('badge-draft',      counts.draft)
  set('badge-spam',       counts.spam)
  set('badge-archived',   counts.archived)
}

async function refreshUnreadCounts() {
  try {
    const data = await apiFetch('/api/emails/unread-counts')
    unreadCounts = data
    renderUnreadBadges()
  } catch { /* silent — stale counts better than broken UI */ }
}
```

- [ ] **Step 2: Delete `loadCategoryBadges()`**

Find and delete the entire `loadCategoryBadges()` function (lines ~1052–1083):

```javascript
// DELETE THIS ENTIRE FUNCTION:
async function loadCategoryBadges() {
  try {
    const [bills, govt, receipts, work, important, promotions, sent, draft, spam, archived] = await Promise.all([
      ...
    ]);
    ...
  } catch { /* badges are non-critical */ }
}
```

- [ ] **Step 3: Delete `refreshSnoozedBadge()`**

Find and delete the entire `refreshSnoozedBadge()` function (lines ~1439–1445):

```javascript
// DELETE THIS ENTIRE FUNCTION:
async function refreshSnoozedBadge() {
  try {
    const data = await apiFetch('/api/emails?snoozed=1&limit=1')
    const el = document.getElementById('badge-snoozed')
    if (el) el.textContent = data.total > 0 ? (data.total > 99 ? '99+' : data.total) : ''
  } catch { /* silent */ }
}
```

- [ ] **Step 4: Verify the app still loads without JS errors**

Open the Electron app (or a browser pointing to the frontend). Open DevTools console. Confirm no `ReferenceError: loadCategoryBadges is not defined` or similar. 

The badges will be empty/broken until call sites are migrated in Task 5 — that's expected at this stage.

- [ ] **Step 5: Commit**

```bash
cd "C:\Users\bryan.GOAT\Downloads\VibeCode"
git add frontend/app.js
git commit -m "refactor(frontend): replace scattered badge vars with unreadCounts object"
```

---

## Task 4: Frontend — `markEmailRead()` function

**Files:**
- Modify: `frontend/app.js:133-135` (delete `markRead()`)
- Modify: `frontend/app.js:654-681` (replace inline mark-read block in `selectEmail()`)

- [ ] **Step 1: Delete `markRead()` wrapper**

Find and delete lines 133–135:

```javascript
// DELETE THIS:
async function markRead(id) {
  return apiFetch('/api/emails/' + id + '/read', { method: 'PATCH' });
}
```

**Warning:** Do not leave any call to `markRead()` — the new backend schema requires a body so a bodyless call will get a 400.

- [ ] **Step 2: Add `markEmailRead()` function**

Add the new function directly after the `refreshUnreadCounts()` function (after line ~75 in the new state):

```javascript
async function markEmailRead(emailId, isRead) {
  // Find email in cache
  const email = emailCache.find(e => e.id === emailId)
  if (!email) return
  if (email.is_read === isRead) return  // already in target state

  // Rapid-click guard: if same target already in flight, skip duplicate
  if (pendingReadRequests.has(emailId) && pendingReadRequests.get(emailId) === isRead) return

  const delta = isRead ? -1 : +1
  const prev = email.is_read  // save for revert

  // ── Optimistic update ──────────────────────────────────────────────────────
  email.is_read = isRead
  renderEmailRow(email)

  const optimistic = { ...unreadCounts }
  optimistic.total_unread = Math.max(0, optimistic.total_unread + delta)
  if (email.category === 'bill')    optimistic.bills      = Math.max(0, optimistic.bills      + delta)
  if (email.category === 'govt')    optimistic.govt       = Math.max(0, optimistic.govt       + delta)
  if (email.category === 'receipt') optimistic.receipts   = Math.max(0, optimistic.receipts   + delta)
  if (email.category === 'work')    optimistic.work       = Math.max(0, optimistic.work       + delta)
  if (email.is_important)           optimistic.important  = Math.max(0, optimistic.important  + delta)
  if (email.tab === 'promotions')   optimistic.promotions = Math.max(0, optimistic.promotions + delta)
  if (email.folder === 'sent')      optimistic.sent       = Math.max(0, optimistic.sent       + delta)
  if (email.folder === 'draft')     optimistic.draft      = Math.max(0, optimistic.draft      + delta)
  if (email.folder === 'spam')      optimistic.spam       = Math.max(0, optimistic.spam       + delta)
  if (email.folder === 'archive')   optimistic.archived   = Math.max(0, optimistic.archived   + delta)
  renderUnreadBadges(optimistic)

  pendingReadRequests.set(emailId, isRead)

  // ── API call ───────────────────────────────────────────────────────────────
  try {
    const result = await apiFetch(`/api/emails/${emailId}/read`, {
      method: 'PATCH',
      body: JSON.stringify({ is_read: isRead }),
    })
    // Reconcile with authoritative counts from server
    unreadCounts = result.counts
    renderUnreadBadges()
  } catch (err) {
    // Revert optimistic update
    email.is_read = prev
    renderEmailRow(email)
    refreshUnreadCounts()
    showToast('Failed to update read status')
  } finally {
    pendingReadRequests.delete(emailId)
  }
}
```

- [ ] **Step 3: Replace the inline mark-read block in `selectEmail()`**

Find the block inside `selectEmail()` at lines ~654–681:

```javascript
// REPLACE THIS ENTIRE BLOCK (from "Mark read (fire & forget...)" to the closing brace):
    // Mark read (fire & forget — don't block UI)
    if (!email.is_read) {
      markRead(id).catch(() => {});
      // Update row UI
      if (row) {
        row.classList.remove('unread');
        const dot = row.querySelector('.er-unread-dot');
        if (dot) dot.remove();
        const fromEl = row.querySelector('.er-from');
        if (fromEl) fromEl.style.fontWeight = '500';
      }
      // Update cache
      const cached = emailCache.find(e => e.id === id);
      if (cached) cached.is_read = true;
      // Decrement the relevant category badge
      const catBadgeMap = { bill: 'badge-bills', govt: 'badge-govt', receipt: 'badge-receipts', work: 'badge-work' };
      const catBadgeId = catBadgeMap[email.category];
      if (catBadgeId) {
        const catBadge = document.getElementById(catBadgeId);
        if (catBadge) {
          const curr = parseInt(catBadge.textContent) || 0;
          if (curr > 1) catBadge.textContent = String(curr - 1);
          else catBadge.textContent = '';
        }
      }
      unreadCount = Math.max(0, unreadCount - 1)
      renderUnreadBadge()
    }
```

With:

```javascript
    // Mark read via unified function (optimistic + server reconcile)
    if (!email.is_read) {
      markEmailRead(id, true)
    }
```

- [ ] **Step 4: Verify mark-read still works**

Open the app, click an unread email. Confirm:
- Email row loses bold/dot immediately
- Sidebar badge decrements immediately  
- No console errors

- [ ] **Step 5: Commit**

```bash
cd "C:\Users\bryan.GOAT\Downloads\VibeCode"
git add frontend/app.js
git commit -m "feat(frontend): add markEmailRead with optimistic update and server reconcile"
```

---

## Task 5: Frontend — Context menu mark-as-unread + call site migration

**Files:**
- Modify: `frontend/index.html:728` (replace ctx-toggle-read item)
- Modify: `frontend/app.js:1512-1520` (openCtxMenu — update toggle-read label logic)
- Modify: `frontend/app.js:1581-1589` (ctxAction toggle-read block — replace)
- Migrate all remaining `loadCategoryBadges` / `refreshUnreadCount` / `refreshSnoozedBadge` call sites

- [ ] **Step 1: Update the context menu HTML**

In `frontend/index.html`, find line 728:

```html
<div class="ctx-item" id="ctx-toggle-read" onclick="ctxAction('toggle-read')"> Mark as unread</div>
```

Replace with:

```html
<div class="ctx-item" id="ctx-mark-read"   onclick="ctxAction('mark-read')">Mark as read</div>
<div class="ctx-item" id="ctx-mark-unread" onclick="ctxAction('mark-unread')">Mark as unread</div>
```

- [ ] **Step 2: Update `openCtxMenu()` to show/hide the correct item**

In `app.js`, find the `openCtxMenu` function (lines ~1512–1538). Replace the toggle-read label block:

```javascript
// OLD (lines ~1517-1519) — DELETE:
  const toggleEl = document.getElementById('ctx-toggle-read')
  if (toggleEl) toggleEl.textContent = emailData.is_read ? 'Mark as unread' : 'Mark as read'
```

With:

```javascript
  const markReadEl   = document.getElementById('ctx-mark-read')
  const markUnreadEl = document.getElementById('ctx-mark-unread')
  if (markReadEl)   markReadEl.style.display   = emailData.is_read ? 'none' : ''
  if (markUnreadEl) markUnreadEl.style.display = emailData.is_read ? '' : 'none'
```

- [ ] **Step 3: Replace `ctxAction('toggle-read')` with two new cases**

In `app.js`, find the `toggle-read` block (lines ~1581–1589):

```javascript
// OLD — DELETE THIS ENTIRE BLOCK:
  if (action === 'toggle-read') {
    const newRead = !data.is_read
    await apiFetch(`/api/emails/${id}/read`, { method: 'PATCH', body: JSON.stringify({ read: newRead }) })
    const row = document.getElementById('row-' + id)
    if (row) row.classList.toggle('unread', !newRead)
    const cached = emailCache.find(e => e.id === id)
    if (cached) cached.is_read = newRead
    return
  }
```

Add these two new cases before the `find-sender` block:

```javascript
  if (action === 'mark-read') {
    closeCtxMenu()
    markEmailRead(id, true)
    return
  }

  if (action === 'mark-unread') {
    closeCtxMenu()
    markEmailRead(id, false)
    return
  }
```

- [ ] **Step 4: Migrate all remaining call sites — `DOMContentLoaded`**

In `app.js`, find the `DOMContentLoaded` block (lines ~1474–1491):

```javascript
// OLD:
  await Promise.all([
    loadAccounts(),
    loadEmails(true),
    loadBills(),
    loadCategoryBadges(),
    refreshUnreadCount(),
  ]);
  loadLabels()
  refreshSnoozedBadge()
```

Replace with:

```javascript
  await Promise.all([
    loadAccounts(),
    loadEmails(true),
    loadBills(),
    refreshUnreadCounts(),
  ]);
  loadLabels()
```

- [ ] **Step 5: Migrate `backgroundSyncPoll()`**

Find `backgroundSyncPoll()` (lines ~1461–1471):

```javascript
// OLD:
async function backgroundSyncPoll() {
  try {
    const result = await triggerSync();
    if (result.added > 0 && Array.isArray(result.emails)) {
      showEmailNotifications(result.emails);
      refreshUnreadCount();
    }
    loadEmails(true);
    loadCategoryBadges();
  } catch { /* non-critical — ignore failures */ }
}
```

Replace with:

```javascript
async function backgroundSyncPoll() {
  try {
    const result = await triggerSync();
    if (result.added > 0 && Array.isArray(result.emails)) {
      showEmailNotifications(result.emails);
    }
    loadEmails(true);
    refreshUnreadCounts();
  } catch { /* non-critical — ignore failures */ }
}
```

- [ ] **Step 6: Migrate Electron IPC handlers**

Find the `if (window.inboxmy)` block (lines ~1398–1436). Update two handlers:

```javascript
// OLD onSyncComplete:
  window.inboxmy.onSyncComplete(function() {
    loadEmails(true)
    loadCategoryBadges()
    refreshUnreadCount()
  })

// NEW:
  window.inboxmy.onSyncComplete(function() {
    loadEmails(true)
    refreshUnreadCounts()
  })

// OLD onNewEmails:
  window.inboxmy.onNewEmails(({ unreadCount: count, emails }) => {
    unreadCount = count
    renderUnreadBadge()
    if (emails) showEmailNotifications(emails)
  })

// NEW (ignore the IPC integer — fetch authoritative counts instead):
  window.inboxmy.onNewEmails(({ emails }) => {
    refreshUnreadCounts()
    if (emails) showEmailNotifications(emails)
  })
```

- [ ] **Step 7: Migrate the manual sync button handler**

Find line ~1103 in `doSync()`:

```javascript
// OLD:
    await Promise.all([loadEmails(true), loadAccounts(), loadBills(), loadCategoryBadges()]);
// NEW:
    await Promise.all([loadEmails(true), loadAccounts(), loadBills(), refreshUnreadCounts()]);
```

- [ ] **Step 8: Migrate `confirmResync()` and `confirmWipeAll()`**

Find `confirmResync()` (lines ~1354–1372), update line ~1364:

```javascript
// OLD:
        await Promise.all([loadEmails(true), loadAccounts(), loadBills(), loadCategoryBadges()]);
// NEW:
        await Promise.all([loadEmails(true), loadAccounts(), loadBills(), refreshUnreadCounts()]);
```

Find `confirmWipeAll()` (lines ~1374–1396), update line ~1388:

```javascript
// OLD:
        await Promise.all([loadAccounts(), loadBills(), loadCategoryBadges()]);
// NEW:
        await Promise.all([loadAccounts(), loadBills(), refreshUnreadCounts()]);
```

- [ ] **Step 9: Migrate snooze handlers**

Find `ctxSnoozePreset()` (line ~1679):

```javascript
// OLD:
    .then(() => { removeEmailFromList(id); refreshSnoozedBadge() })
// NEW:
    .then(() => { removeEmailFromList(id); refreshUnreadCounts() })
```

Find `ctxSnoozeApplyCustom()` (line ~1698):

```javascript
// OLD:
    refreshSnoozedBadge()
// NEW:
    refreshUnreadCounts()
```

- [ ] **Step 10: Verify no remaining references to deleted functions**

```bash
cd "C:\Users\bryan.GOAT\Downloads\VibeCode"
grep -rn "loadCategoryBadges\|refreshUnreadCount\b\|refreshSnoozedBadge\|renderUnreadBadge\b\|markRead(" frontend/
```

Expected: zero results. If any remain, fix them before proceeding.

Also verify the deleted backend endpoint is gone:

```bash
grep -n "unread-count'" inboxmy-backend/src/routes/emails.ts
```

Expected: zero results (only `unread-counts` with an `s` should appear).

- [ ] **Step 11: Run full backend test suite one final time**

```bash
cd inboxmy-backend && npx vitest run 2>&1 | tail -20
```

Expected: all tests pass.

- [ ] **Step 12: Final smoke test**

Open the app. Verify:
1. All sidebar badges populate on load (single network request to `/api/emails/unread-counts` in DevTools Network tab)
2. Clicking an unread email decrements the badge instantly (optimistic), then the badge value matches after server response
3. Right-click an unread email → "Mark as read" appears, click it → email row goes bold-off, badges decrement
4. Right-click a read email → "Mark as unread" appears, click it → email goes bold, badges increment
5. Right-click context menu never shows both options simultaneously

- [ ] **Step 13: Commit**

```bash
cd "C:\Users\bryan.GOAT\Downloads\VibeCode"
git add frontend/app.js frontend/index.html
git commit -m "feat(frontend): mark-as-unread context menu, migrate all badge call sites"
```
