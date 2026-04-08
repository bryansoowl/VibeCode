# Sync Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the idle-only fixed-batch backfill scheduler with a `SyncManager` class that runs burst, fast, and backfill jobs continuously with adaptive batch sizing and parallel account support.

**Architecture:** A new `electron/sync-manager.js` module owns all sync scheduling via an in-memory priority job queue and a concurrency slot counter (max 3). The Express backend gains three new/updated endpoints: `POST /api/sync/burst`, updated `POST /api/sync/backfill` (accepts dynamic `batchSize`), and `PATCH /api/sync/state/:accountId`. `electron/main.js` is stripped of all sync logic and delegates to `SyncManager`.

**Tech Stack:** Node.js, Electron, Express, better-sqlite3 (SQLite), Vitest (backend tests at `inboxmy-backend/`), Vitest with root config (electron tests at `electron/`). Run backend tests with `npm run test:backend` from root. Run electron tests with `npm run test:utils` from root.

---

## Parallelisation Map

Tasks are grouped into two independent tracks that can run simultaneously:

| Track A (Backend) | Track B (Electron) |
|---|---|
| Task 1: DB Migration 12 | Task 5: `sync-manager.js` |
| Task 2: `fetchBurstMetadata` — Gmail | Task 6: Refactor `main.js` |
| Task 3: `fetchBurstMetadata` — Outlook | |
| Task 4: Backend routes (burst, backfill, state) | |

Track B has no dependency on Track A. Both tracks can be dispatched simultaneously.

---

## Track A — Backend

---

### Task 1: DB Migration 12

**Files:**
- Modify: `inboxmy-backend/src/db/migrations.ts`
- Modify: `inboxmy-backend/tests/migrations.test.ts`

**Context:** `migrations.ts` exports `runMigrations(db)`. It has an array `MIGRATIONS: string[]` where each entry is raw SQL. Currently 11 entries (indices 0–10). New migration goes at index 11. `makeTestDb()` in `tests/helpers/db.ts` calls `runMigrations` on an in-memory SQLite — so migration tests run without any file I/O.

- [ ] **Step 1: Write the failing test**

Add to `inboxmy-backend/tests/migrations.test.ts` (append a new `describe` block at the end of the file):

```typescript
describe('Migration 12 — sync_state adaptive batch columns', () => {
  let db: Database.Database
  beforeEach(() => { db = makeTestDb() })
  afterEach(() => db.close())

  it('adds last_batch_size with default 100 to sync_state', () => {
    const cols = db.prepare("PRAGMA table_info(sync_state)").all() as any[]
    const col = cols.find((c: any) => c.name === 'last_batch_size')
    expect(col).toBeDefined()
    expect(col.dflt_value).toBe('100')
  })

  it('adds last_batch_duration_ms (nullable) to sync_state', () => {
    const cols = db.prepare("PRAGMA table_info(sync_state)").all() as any[]
    const col = cols.find((c: any) => c.name === 'last_batch_duration_ms')
    expect(col).toBeDefined()
    expect(col.notnull).toBe(0)
  })

  it('can insert a sync_state row and read back last_batch_size', () => {
    db.prepare(`INSERT INTO accounts (id, provider, email, token_enc, created_at)
      VALUES ('acc-m', 'gmail', 'm@t.com', 'e', 1)`).run()
    db.prepare(`INSERT INTO sync_state (account_id, last_batch_size, last_batch_duration_ms)
      VALUES ('acc-m', 75, 4200)`).run()
    const row = db.prepare("SELECT * FROM sync_state WHERE account_id='acc-m'").get() as any
    expect(row.last_batch_size).toBe(75)
    expect(row.last_batch_duration_ms).toBe(4200)
  })
})
```

- [ ] **Step 2: Run test to confirm it fails**

```bash
cd inboxmy-backend && npx vitest run tests/migrations.test.ts
```
Expected: last 3 tests FAIL — columns don't exist yet.

- [ ] **Step 3: Add Migration 12 to migrations.ts**

In `inboxmy-backend/src/db/migrations.ts`, append to the `MIGRATIONS` array (after the last entry, before the closing `]`):

```typescript
  // Migration 12: adaptive batch sizing columns on sync_state
  `
  ALTER TABLE sync_state ADD COLUMN last_batch_size INTEGER NOT NULL DEFAULT 100;
  ALTER TABLE sync_state ADD COLUMN last_batch_duration_ms INTEGER;
  `,
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
cd inboxmy-backend && npx vitest run tests/migrations.test.ts
```
Expected: all migration tests PASS.

- [ ] **Step 5: Commit**

```bash
cd inboxmy-backend && git add src/db/migrations.ts tests/migrations.test.ts && git commit -m "feat(db): migration 12 — adaptive batch size columns on sync_state"
```

---

### Task 2: `fetchBurstMetadata` — Gmail

**Files:**
- Modify: `inboxmy-backend/src/email/gmail-client.ts`

**Context:** `gmail-client.ts` already exports `fetchEmailsMetadata(accountId, beforeMs?, limit?)`. The new `fetchBurstMetadata` is similar but: (1) always uses `in:inbox newer_than:90d` as the query (no `beforeMs` pagination), (2) does **not** pass `includeSpamTrash: true` to `messages.list`. This keeps spam/trash out of burst results. The function signature is `fetchBurstMetadata(accountId: string, limit: number): Promise<NormalizedEmailMetadata[]>`.

- [ ] **Step 1: Add `fetchBurstMetadata` to `gmail-client.ts`**

Add this function after `fetchEmailsMetadata` (before the helper functions at the bottom of the file):

```typescript
/**
 * Fetch the most recent inbox emails (metadata only) for burst sync on app launch.
 * Scoped to inbox only — does NOT pass includeSpamTrash so spam/trash are excluded.
 * @param accountId - The account to fetch for
 * @param limit - Max emails to fetch (burst uses 200)
 */
export async function fetchBurstMetadata(
  accountId: string,
  limit: number
): Promise<NormalizedEmailMetadata[]> {
  const auth = await getAuthedClient(accountId)
  const gmail = google.gmail({ version: 'v1', auth })

  console.log(`[gmail] fetchBurstMetadata accountId=${accountId} limit=${limit}`)

  let list: any
  try {
    list = await gmail.users.messages.list({
      userId: 'me',
      q: 'in:inbox newer_than:90d',
      maxResults: limit,
      // intentionally no includeSpamTrash — burst is inbox-only
    })
  } catch (err: any) {
    console.error(`[gmail] fetchBurstMetadata list error: ${err.message}`)
    throw err
  }

  const messages = list.data.messages ?? []
  const results: NormalizedEmailMetadata[] = []

  for (const msg of messages) {
    try {
      const meta = await gmail.users.messages.get({
        userId: 'me',
        id: msg.id!,
        format: 'metadata',
        metadataHeaders: ['From', 'Subject', 'Date'],
      })
      results.push(normalizeGmailMetadata(accountId, meta.data))
    } catch (err: any) {
      console.error(`[gmail] fetchBurstMetadata get error for ${msg.id}: ${err.message}`)
    }
  }

  return results
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd inboxmy-backend && npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add inboxmy-backend/src/email/gmail-client.ts && git commit -m "feat(gmail): add fetchBurstMetadata for inbox-only burst sync"
```

---

### Task 3: `fetchBurstMetadata` — Outlook

**Files:**
- Modify: `inboxmy-backend/src/email/outlook-client.ts`

**Context:** Outlook's Graph API `/me/messages` already scopes to the inbox by default (it does not return sent/spam unless you specify a different mail folder). So `fetchBurstMetadata` for Outlook is essentially `fetchEmailsMetadata` without the `beforeMs` filter — it fetches the most recent `limit` messages. Export it as a named function so `sync.ts` can import it identically from both providers.

- [ ] **Step 1: Add `fetchBurstMetadata` to `outlook-client.ts`**

Add after `fetchEmailsMetadata`:

```typescript
/**
 * Fetch the most recent inbox emails (metadata only) for burst sync on app launch.
 * Outlook /me/messages is inbox-scoped by default.
 * @param accountId - The account to fetch for
 * @param limit - Max emails to fetch (burst uses 200)
 */
export async function fetchBurstMetadata(
  accountId: string,
  limit: number
): Promise<NormalizedEmailMetadata[]> {
  const accessToken = await getAccessToken(accountId)
  const client = Client.init({
    authProvider: (done) => done(null, accessToken),
  })

  const since = new Date(Date.now() - 90 * 86400_000).toISOString()

  const result = await client
    .api('/me/messages')
    .filter(`receivedDateTime gt ${since}`)
    .select('id,subject,from,receivedDateTime,isRead,bodyPreview,conversationId,importance')
    .top(limit)
    .get()

  return (result.value ?? []).map((msg: any) => normalizeGraphMetadata(accountId, msg))
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd inboxmy-backend && npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add inboxmy-backend/src/email/outlook-client.ts && git commit -m "feat(outlook): add fetchBurstMetadata for inbox-only burst sync"
```

---

### Task 4: Backend Routes — burst, backfill batchSize, PATCH state

**Files:**
- Modify: `inboxmy-backend/src/routes/sync.ts`
- Create: `inboxmy-backend/tests/burst.test.ts`
- Modify: `inboxmy-backend/tests/backfill.test.ts`

**Context:** `sync.ts` has two existing endpoints: `POST /api/sync/backfill` and `POST /api/sync/trigger`. Three changes:
1. Add `POST /api/sync/burst` — fetches 200 inbox emails via `fetchBurstMetadata`, inserts into `inbox_index` with encryption, seeds `sync_backfill_cursors`.
2. Update `POST /api/sync/backfill` — read `batchSize` from `req.body` (default 100, clamped server-side to 50–200) instead of hardcoded `const BATCH_SIZE = 25`.
3. Add `PATCH /api/sync/state/:accountId` — upserts `last_batch_size` and `last_batch_duration_ms` into `sync_state`. Requires ownership check.

The test file `tests/backfill.test.ts` checks "marks folder complete when provider returns fewer than 25 emails" — that test checks `batch.length < BATCH_SIZE`. After making `BATCH_SIZE` dynamic, the mock returns 5 emails and the default batchSize is 100, so 5 < 100 still marks complete. The existing test does not need to change logic but verify it still passes.

**Encryption reminder:** `inbox_index` stores `subject_preview_enc` and `snippet_preview_enc` — these must be encrypted with `req.user.dataKey` before insert (see how `sync.ts`'s existing backfill route does this at lines 71–73).

- [ ] **Step 1: Write failing tests for burst endpoint**

Create `inboxmy-backend/tests/burst.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { makeTestDb } from './helpers/db'
import type Database from 'better-sqlite3'

let testDb: Database.Database

vi.mock('../src/db', () => ({ getDb: () => testDb }))
vi.mock('../src/middleware/auth', () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
}))

const MOCK_BURST_EMAILS = Array.from({ length: 5 }, (_, i) => ({
  id: `burst-msg-${i}`,
  accountId: 'acc-1',
  threadId: null,
  subject: `Burst Email ${i}`,
  sender: `burst${i}@example.com`,
  senderName: `Burst Sender ${i}`,
  receivedAt: 1_700_000_000_000 - i * 1000,
  isRead: false,
  folder: 'inbox' as const,
  tab: 'primary' as const,
  isImportant: false,
  category: null,
  snippet: `burst snippet ${i}`,
  rawSize: 256,
}))

vi.mock('../src/email/gmail-client', () => ({
  fetchNewEmails: vi.fn(),
  fetchEmailsMetadata: vi.fn().mockResolvedValue([]),
  fetchBurstMetadata: vi.fn().mockResolvedValue(MOCK_BURST_EMAILS),
}))

vi.mock('../src/email/outlook-client', () => ({
  fetchNewEmails: vi.fn(),
  fetchEmailsMetadata: vi.fn().mockResolvedValue([]),
  fetchBurstMetadata: vi.fn().mockResolvedValue([]),
}))

const TEST_DATA_KEY = Buffer.alloc(32, 0x42)
const TEST_USER = { id: 'user-1', dataKey: TEST_DATA_KEY }

async function makeApp() {
  const { syncRouter } = await import('../src/routes/sync')
  const app = express()
  app.use(express.json())
  app.use((req: any, _res: any, next: any) => { req.user = TEST_USER; next() })
  app.use('/api/sync', syncRouter)
  return app
}

function seedAccount(db: Database.Database) {
  db.prepare(`INSERT INTO users (id, email, password_hash, pbkdf2_salt, data_key_enc, recovery_enc, created_at)
    VALUES ('user-1', 'u@t.com', 'h', 's', 'e', 'e', 1)`).run()
  db.prepare(`INSERT INTO accounts (id, provider, email, token_enc, created_at, user_id)
    VALUES ('acc-1', 'gmail', 'a@t.com', 'e', 1, 'user-1')`).run()
}

describe('POST /api/sync/burst', () => {
  beforeEach(() => {
    testDb = makeTestDb()
    seedAccount(testDb)
  })
  afterEach(() => testDb.close())

  it('returns 200 with added count', async () => {
    const app = await makeApp()
    const res = await request(app).post('/api/sync/burst').send({ accountId: 'acc-1' })
    expect(res.status).toBe(200)
    expect(res.body.added).toBe(5)
  })

  it('inserts emails into inbox_index', async () => {
    const app = await makeApp()
    await request(app).post('/api/sync/burst').send({ accountId: 'acc-1' })
    const count = (testDb.prepare('SELECT COUNT(*) as n FROM inbox_index').get() as any).n
    expect(count).toBe(5)
  })

  it('seeds sync_backfill_cursors for inbox, sent, spam', async () => {
    const app = await makeApp()
    await request(app).post('/api/sync/burst').send({ accountId: 'acc-1' })
    const rows = testDb.prepare(
      `SELECT folder FROM sync_backfill_cursors WHERE account_id='acc-1'`
    ).all() as any[]
    const folders = rows.map((r: any) => r.folder).sort()
    expect(folders).toEqual(['inbox', 'sent', 'spam'])
  })

  it('is idempotent — running twice does not duplicate inbox_index rows', async () => {
    const app = await makeApp()
    await request(app).post('/api/sync/burst').send({ accountId: 'acc-1' })
    await request(app).post('/api/sync/burst').send({ accountId: 'acc-1' })
    const count = (testDb.prepare('SELECT COUNT(*) as n FROM inbox_index').get() as any).n
    expect(count).toBe(5)
  })

  it('returns 404 for unknown accountId', async () => {
    const app = await makeApp()
    const res = await request(app).post('/api/sync/burst').send({ accountId: 'unknown' })
    expect(res.status).toBe(404)
  })

  it('returns 400 when accountId is missing', async () => {
    const app = await makeApp()
    const res = await request(app).post('/api/sync/burst').send({})
    expect(res.status).toBe(400)
  })
})

describe('PATCH /api/sync/state/:accountId', () => {
  beforeEach(() => {
    testDb = makeTestDb()
    seedAccount(testDb)
  })
  afterEach(() => testDb.close())

  it('upserts last_batch_size and last_batch_duration_ms', async () => {
    const app = await makeApp()
    const res = await request(app)
      .patch('/api/sync/state/acc-1')
      .send({ last_batch_size: 75, last_batch_duration_ms: 4200 })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)

    const row = testDb.prepare(
      `SELECT last_batch_size, last_batch_duration_ms FROM sync_state WHERE account_id='acc-1'`
    ).get() as any
    expect(row.last_batch_size).toBe(75)
    expect(row.last_batch_duration_ms).toBe(4200)
  })

  it('returns 404 for account not owned by user', async () => {
    const app = await makeApp()
    const res = await request(app)
      .patch('/api/sync/state/acc-other')
      .send({ last_batch_size: 100, last_batch_duration_ms: 1000 })
    expect(res.status).toBe(404)
  })

  it('updates existing sync_state row without clobbering other columns', async () => {
    const app = await makeApp()
    // Pre-insert a sync_state row with last_fast_sync_at
    testDb.prepare(`INSERT INTO sync_state (account_id, last_fast_sync_at) VALUES ('acc-1', 9999)`).run()
    await request(app)
      .patch('/api/sync/state/acc-1')
      .send({ last_batch_size: 50, last_batch_duration_ms: 8000 })
    const row = testDb.prepare(`SELECT * FROM sync_state WHERE account_id='acc-1'`).get() as any
    expect(row.last_fast_sync_at).toBe(9999)  // not clobbered
    expect(row.last_batch_size).toBe(50)
  })
})
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd inboxmy-backend && npx vitest run tests/burst.test.ts
```
Expected: all tests FAIL — routes don't exist yet.

- [ ] **Step 3: Implement the three route changes in `sync.ts`**

**3a — Add imports at the top of `sync.ts`** (after existing imports). Note: `randomUUID` is already imported at line 8 of `sync.ts` — do not add it again:

```typescript
import { fetchBurstMetadata as fetchGmailBurst } from '../email/gmail-client'
import { fetchBurstMetadata as fetchOutlookBurst } from '../email/outlook-client'
```

**3b — Add `POST /api/sync/burst` before the existing `syncRouter.post('/backfill', ...)` block:**

```typescript
syncRouter.post('/burst', async (req, res) => {
  const { accountId } = req.body
  const user = (req as any).user
  const db = getDb()

  if (!accountId) return res.status(400).json({ error: 'accountId required' })

  const account = db.prepare(
    'SELECT id, provider FROM accounts WHERE id = ? AND user_id = ?'
  ).get(accountId, user.id) as any
  if (!account) return res.status(404).json({ error: 'Account not found' })

  const BURST_LIMIT = 200
  let emails: any[] = []
  try {
    const fetcher = account.provider === 'gmail' ? fetchGmailBurst : fetchOutlookBurst
    emails = await fetcher(accountId, BURST_LIMIT)
  } catch (err: any) {
    console.error(`[burst] Provider fetch failed for ${accountId}:`, err.message)
    return res.status(502).json({ error: 'Provider fetch failed', detail: err.message })
  }

  const insertIndex = db.prepare(`
    INSERT INTO inbox_index
      (email_id, account_id, provider_message_id, thread_id,
       sender_email, sender_name, subject_preview_enc, snippet_preview_enc,
       received_at, folder, tab, is_read, is_important, category)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(account_id, provider_message_id) DO NOTHING
  `)

  let added = 0
  const burst = db.transaction((emails: any[]) => {
    for (const email of emails) {
      const r = insertIndex.run(
        randomUUID(), accountId, email.id, email.threadId ?? null,
        email.sender, email.senderName ?? null,
        encrypt(email.subject, user.dataKey),
        email.snippet ? encrypt(email.snippet, user.dataKey) : null,
        email.receivedAt, email.folder ?? 'inbox', email.tab ?? 'primary',
        email.isRead ? 1 : 0, email.isImportant ? 1 : 0, null  // category=null, fast sync reconciles
      )
      if (r.changes > 0) added++
    }

    // Seed backfill cursors (idempotent)
    for (const folder of ['inbox', 'sent', 'spam']) {
      db.prepare(`
        INSERT INTO sync_backfill_cursors (account_id, folder, complete)
        VALUES (?, ?, 0)
        ON CONFLICT(account_id, folder) DO NOTHING
      `).run(accountId, folder)
    }
  })
  burst(emails)

  console.log(`[burst] ${account.provider} ${accountId} — added ${added} / ${emails.length}`)
  res.json({ added })
})
```

**3c — Update `POST /api/sync/backfill` — replace hardcoded `BATCH_SIZE = 25` with dynamic:**

Find this line near the top of the backfill handler:
```typescript
  const BATCH_SIZE = 25
```

Replace it with:
```typescript
  const rawBatchSize = typeof req.body.batchSize === 'number' ? req.body.batchSize : 100
  const BATCH_SIZE = Math.max(50, Math.min(200, rawBatchSize))
```

**3d — Add `GET /api/sync/state` before the trigger endpoint** (returns batch state for all user accounts — used by SyncManager at startup to restore persisted batch sizes):

```typescript
syncRouter.get('/state', (req, res) => {
  const user = (req as any).user
  const db = getDb()
  const rows = db.prepare(`
    SELECT ss.account_id, ss.last_batch_size, ss.last_batch_duration_ms
    FROM sync_state ss
    JOIN accounts a ON a.id = ss.account_id
    WHERE a.user_id = ?
  `).all(user.id) as any[]
  res.json({ states: rows })
})
```

**3e — Add `PATCH /api/sync/state/:accountId` after the trigger endpoint:**

```typescript
syncRouter.patch('/state/:accountId', (req, res) => {
  const { accountId } = req.params
  const { last_batch_size, last_batch_duration_ms } = req.body
  const user = (req as any).user
  const db = getDb()

  // Ownership check
  const account = db.prepare(
    'SELECT id FROM accounts WHERE id = ? AND user_id = ?'
  ).get(accountId, user.id)
  if (!account) return res.status(404).json({ error: 'Account not found' })

  if (typeof last_batch_size !== 'number' || typeof last_batch_duration_ms !== 'number') {
    return res.status(400).json({ error: 'last_batch_size and last_batch_duration_ms are required numbers' })
  }

  db.prepare(`
    INSERT INTO sync_state (account_id, last_batch_size, last_batch_duration_ms)
    VALUES (?, ?, ?)
    ON CONFLICT(account_id) DO UPDATE SET
      last_batch_size = excluded.last_batch_size,
      last_batch_duration_ms = excluded.last_batch_duration_ms
  `).run(accountId, last_batch_size, last_batch_duration_ms)

  res.json({ ok: true })
})
```

- [ ] **Step 4: Run burst tests**

```bash
cd inboxmy-backend && npx vitest run tests/burst.test.ts
```
Expected: all 9 tests PASS.

- [ ] **Step 5: Run existing backfill tests to confirm no regressions**

```bash
cd inboxmy-backend && npx vitest run tests/backfill.test.ts
```
Expected: all 7 existing tests PASS. (The "marks folder complete when fewer than 25" test still passes because mock returns 5 emails and new default BATCH_SIZE is 100; 5 < 100 → complete.)

- [ ] **Step 6: Run the full backend test suite**

```bash
cd inboxmy-backend && npm test
```
Expected: all tests PASS.

- [ ] **Step 7: Verify TypeScript compiles**

```bash
cd inboxmy-backend && npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add inboxmy-backend/src/routes/sync.ts inboxmy-backend/tests/burst.test.ts && git commit -m "feat(sync): burst endpoint, dynamic backfill batchSize, PATCH state"
```

---

## Track B — Electron

---

### Task 5: `electron/sync-manager.js`

**Files:**
- Create: `electron/sync-manager.js`
- Create: `electron/sync-manager.test.js`

**Context:** The Electron test framework runs via `npm run test:utils` from root (uses `vitest.config.mjs` which includes `electron/**/*.test.js`). Tests use globals (`describe`, `it`, `expect`) — no explicit import needed. The existing `electron/utils.test.js` shows the pattern.

`SyncManager` needs:
- `constructor(apiRequest, mainWindow, backendUrl)` — `apiRequest(path, method, body)` is the authenticated fetch helper already in `main.js`
- `start()` — seeds `knownAccounts` from `GET /api/accounts`, starts account poller, sync timer, backfill timer
- `stop()` — clears all timers, empties job queue (fire-and-forget: active API calls complete naturally)
- Internal `enqueue(job)` — pushes to priority min-heap, calls `dispatch()`
- Internal `dispatch()` — while slots available and queue non-empty: pop job, increment slots, run, on finish decrement slots and dispatch again
- Internal `runJob(job)` — routes to `runBurst / runFast / runBackfill`
- `notifySyncComplete()` — debounced (500ms trailing) `mainWindow.webContents.send('sync-complete')`

Adaptive batch sizing helpers:
- `computeBatchSize(accountId, activeAccountCount)` — reads from `accountBatchState`, applies global budget formula
- `updateBatchState(accountId, batchSize, durationMs)` — applies auto-tune formula, calls `PATCH /api/sync/state/:accountId`

Constants (defined at module top):
```
MAX_CONCURRENCY = 3
GLOBAL_BATCH_BUDGET = 300
MIN_BATCH_SIZE = 50
MAX_BATCH_SIZE = 200
INITIAL_BATCH_SIZE = 100
SYNC_INTERVAL_MS = 60_000
BACKFILL_INTERVAL_MS = 2 * 60_000
ACCOUNT_POLL_INTERVAL_MS = 30_000
SYNC_STARTUP_DELAY_MS = 30_000
BACKFILL_STARTUP_DELAY_MS = 90_000
```

- [ ] **Step 1: Write failing tests for `SyncManager`**

Create `electron/sync-manager.test.js`. Use `require` (CommonJS) — the Electron test suite uses CJS throughout (see `utils.test.js`):

```javascript
// electron/sync-manager.test.js
const { SyncManager } = require('./sync-manager.js')

// Minimal stub for mainWindow
function makeWindow(destroyed = false) {
  const sends = []
  return {
    isDestroyed: () => destroyed,
    webContents: { send: (event, ...args) => sends.push({ event, args }) },
    _sends: sends,
  }
}

// Capture apiRequest calls
function makeApiRequest(responses = {}) {
  const calls = []
  const fn = async (path, method = 'GET', body = null) => {
    calls.push({ path, method, body })
    return responses[path] ?? { status: 200, body: { accounts: [] } }
  }
  fn._calls = calls
  return fn
}

describe('SyncManager — computeBatchSize', () => {
  it('returns INITIAL_BATCH_SIZE for unknown account', () => {
    const sm = new SyncManager(makeApiRequest(), makeWindow(), 'http://localhost:3001')
    const size = sm.computeBatchSize('acc-unknown', 1)
    expect(size).toBe(100)
  })

  it('divides global budget by account count', () => {
    const sm = new SyncManager(makeApiRequest(), makeWindow(), 'http://localhost:3001')
    sm.accountBatchState.set('acc-1', { batchSize: 100, lastDurationMs: 0 })
    // 3 accounts → perAccountMax = floor(300/3) = 100 → clamped to min(100, 200) = 100
    const size = sm.computeBatchSize('acc-1', 3)
    expect(size).toBe(100)
  })

  it('does not exceed MAX_BATCH_SIZE regardless of account count', () => {
    const sm = new SyncManager(makeApiRequest(), makeWindow(), 'http://localhost:3001')
    sm.accountBatchState.set('acc-1', { batchSize: 200, lastDurationMs: 0 })
    const size = sm.computeBatchSize('acc-1', 1)
    expect(size).toBe(200)  // perAccountMax = 300 but capped at 200
  })
})

describe('SyncManager — nextBatchSize (auto-tune)', () => {
  it('increases by 25 when last batch was fast (< 3s)', () => {
    const sm = new SyncManager(makeApiRequest(), makeWindow(), 'http://localhost:3001')
    const next = sm.nextBatchSize(100, 2000, 200)
    expect(next).toBe(125)
  })

  it('decreases by 25 when last batch was slow (> 10s)', () => {
    const sm = new SyncManager(makeApiRequest(), makeWindow(), 'http://localhost:3001')
    const next = sm.nextBatchSize(100, 11000, 200)
    expect(next).toBe(75)
  })

  it('holds steady in the stable zone (3–10s)', () => {
    const sm = new SyncManager(makeApiRequest(), makeWindow(), 'http://localhost:3001')
    const next = sm.nextBatchSize(100, 6000, 200)
    expect(next).toBe(100)
  })

  it('clamps to MIN_BATCH_SIZE (50) when decremented below floor', () => {
    const sm = new SyncManager(makeApiRequest(), makeWindow(), 'http://localhost:3001')
    const next = sm.nextBatchSize(50, 11000, 200)
    expect(next).toBe(50)
  })

  it('clamps to perAccountMax when incremented above ceiling', () => {
    const sm = new SyncManager(makeApiRequest(), makeWindow(), 'http://localhost:3001')
    const next = sm.nextBatchSize(175, 1000, 175)  // perAccountMax = 175
    expect(next).toBe(175)  // would be 200, clamped to 175
  })
})

describe('SyncManager — concurrency', () => {
  it('does not exceed MAX_CONCURRENCY active slots', async () => {
    const sm = new SyncManager(makeApiRequest(), makeWindow(), 'http://localhost:3001')

    // Track max concurrent slots observed
    let maxSeen = 0
    const originalRun = sm.runJob.bind(sm)
    sm.runJob = async (job) => {
      maxSeen = Math.max(maxSeen, sm.activeSlots)
      await new Promise(r => setTimeout(r, 10))  // simulate async work
    }

    // Enqueue 6 jobs
    for (let i = 0; i < 6; i++) {
      sm.enqueue({ type: 'backfill', accountId: `acc-${i}`, priority: 2 })
    }

    // Wait for all to drain
    await new Promise(r => setTimeout(r, 200))
    expect(maxSeen).toBeLessThanOrEqual(3)
  })
})

describe('SyncManager — job queue priority', () => {
  it('burst jobs run before backfill jobs', async () => {
    const sm = new SyncManager(makeApiRequest(), makeWindow(), 'http://localhost:3001')

    const runOrder = []
    sm.runJob = async (job) => { runOrder.push(job.type) }

    // Enqueue backfill first, then burst — burst should run first
    sm.enqueue({ type: 'backfill', accountId: 'acc-1', priority: 2 })
    sm.enqueue({ type: 'burst', accountId: 'acc-1', priority: 0 })

    await new Promise(r => setTimeout(r, 50))
    // At least the first job dispatched should be burst
    expect(runOrder[0]).toBe('burst')
  })
})

describe('SyncManager — stop', () => {
  it('clears the job queue', () => {
    const sm = new SyncManager(makeApiRequest(), makeWindow(), 'http://localhost:3001')
    sm.enqueue({ type: 'backfill', accountId: 'acc-1', priority: 2 })
    sm.enqueue({ type: 'backfill', accountId: 'acc-2', priority: 2 })
    expect(sm.jobQueue.length).toBeGreaterThan(0)
    sm.stop()
    expect(sm.jobQueue.length).toBe(0)
  })
})
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npm run test:utils
```
Expected: all tests FAIL — module doesn't exist.

- [ ] **Step 3: Implement `electron/sync-manager.js`**

Create `electron/sync-manager.js`:

```javascript
// electron/sync-manager.js
'use strict'

const MAX_CONCURRENCY = 3
const GLOBAL_BATCH_BUDGET = 300
const MIN_BATCH_SIZE = 50
const MAX_BATCH_SIZE = 200
const INITIAL_BATCH_SIZE = 100
const SYNC_INTERVAL_MS = 60_000
const BACKFILL_INTERVAL_MS = 2 * 60_000
const ACCOUNT_POLL_INTERVAL_MS = 30_000
const SYNC_STARTUP_DELAY_MS = 30_000
const BACKFILL_STARTUP_DELAY_MS = 90_000
const SYNC_COMPLETE_DEBOUNCE_MS = 500

class SyncManager {
  constructor(apiRequest, mainWindow, backendUrl) {
    this.apiRequest = apiRequest
    this.mainWindow = mainWindow
    this.backendUrl = backendUrl

    // Job queue: array used as min-heap sorted by priority (0=highest)
    this.jobQueue = []
    this.activeSlots = 0

    // Per-account adaptive batch state
    this.accountBatchState = new Map()

    // Known accounts for burst detection
    this.knownAccounts = new Set()

    // Timer handles
    this._syncTimer = null
    this._backfillTimer = null
    this._pollTimer = null
    this._syncCompleteDebounce = null

    this._stopped = false
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  async start() {
    this._stopped = false

    // Seed knownAccounts from existing accounts
    try {
      const [accountsRes, stateRes] = await Promise.all([
        this.apiRequest('/api/accounts'),
        this.apiRequest('/api/sync/state'),
      ])

      // Build persisted batch state map for seeding
      const persistedState = {}
      if (stateRes && stateRes.status === 200 && Array.isArray(stateRes.body?.states)) {
        for (const row of stateRes.body.states) {
          persistedState[row.account_id] = {
            batchSize: row.last_batch_size ?? INITIAL_BATCH_SIZE,
            lastDurationMs: row.last_batch_duration_ms ?? 0,
          }
        }
      }

      if (accountsRes && accountsRes.status === 200 && Array.isArray(accountsRes.body?.accounts)) {
        const accounts = accountsRes.body.accounts
        let burstIndex = 0
        for (const acc of accounts) {
          this.knownAccounts.add(acc.id)
          // Restore persisted batch size, fall back to initial
          this.accountBatchState.set(acc.id, persistedState[acc.id] ?? { batchSize: INITIAL_BATCH_SIZE, lastDurationMs: 0 })
          // Burst on every launch to quickly populate inbox
          this.enqueue({ type: 'burst', accountId: acc.id, priority: 0, burstIndex: burstIndex++ })
        }
      }
    } catch (e) {
      console.error('[sync-manager] start: failed to load accounts:', e.message)
    }

    // Account poller — detect new accounts mid-session
    this._pollTimer = setTimeout(() => {
      this._runPollTick()
      this._pollTimer = setInterval(() => this._runPollTick(), ACCOUNT_POLL_INTERVAL_MS)
    }, ACCOUNT_POLL_INTERVAL_MS)

    // Fast sync timer
    this._syncTimer = setTimeout(() => {
      this.enqueue({ type: 'fast', priority: 1 })
      this._syncTimer = setInterval(() => {
        this.enqueue({ type: 'fast', priority: 1 })
      }, SYNC_INTERVAL_MS)
    }, SYNC_STARTUP_DELAY_MS)

    // Backfill timer
    this._backfillTimer = setTimeout(() => {
      this._enqueueBackfill()
      this._backfillTimer = setInterval(() => this._enqueueBackfill(), BACKFILL_INTERVAL_MS)
    }, BACKFILL_STARTUP_DELAY_MS)
  }

  stop() {
    this._stopped = true
    // Clear all timers
    ;[this._syncTimer, this._backfillTimer, this._pollTimer].forEach(t => {
      if (t) { clearTimeout(t); clearInterval(t) }
    })
    if (this._syncCompleteDebounce) clearTimeout(this._syncCompleteDebounce)
    // Drain queue (fire-and-forget: active API calls complete naturally)
    this.jobQueue = []
  }

  // ── Job Queue ───────────────────────────────────────────────────────────────

  enqueue(job) {
    this.jobQueue.push(job)
    // Sort by priority ascending (0 = highest priority)
    this.jobQueue.sort((a, b) => a.priority - b.priority)
    this._dispatch()
  }

  _dispatch() {
    if (this._stopped) return
    while (this.jobQueue.length > 0 && this.activeSlots < MAX_CONCURRENCY) {
      const job = this.jobQueue.shift()
      this.activeSlots++
      // Stagger burst jobs to reduce quota pressure
      const delay = (job.type === 'burst' && job.burstIndex > 0)
        ? job.burstIndex * 500
        : 0
      const run = () => this.runJob(job)
        .catch(e => console.error(`[sync-manager] job ${job.type}/${job.accountId} failed:`, e.message))
        .finally(() => {
          this.activeSlots--
          this._dispatch()
        })
      if (delay > 0) setTimeout(run, delay)
      else run()
    }
  }

  async runJob(job) {
    if (job.type === 'burst')   return this._runBurst(job)
    if (job.type === 'fast')    return this._runFast(job)
    if (job.type === 'backfill') return this._runBackfill(job)
  }

  // ── Job Runners ─────────────────────────────────────────────────────────────

  async _runBurst(job) {
    console.log(`[sync-manager] burst ${job.accountId}`)
    const res = await this.apiRequest('/api/sync/burst', 'POST', { accountId: job.accountId })
    if (!res || res.status !== 200) {
      console.log(`[sync-manager] burst ${job.accountId} failed (status ${res?.status ?? 'network'})`)
      return
    }
    console.log(`[sync-manager] burst ${job.accountId} — added ${res.body?.added ?? 0}`)
    this._notifySyncComplete()
  }

  async _runFast(_job) {
    const res = await this.apiRequest('/api/sync/trigger', 'POST', {})
    if (!res || res.status !== 200) return
    const { added = 0, emails = [] } = res.body ?? {}
    if (added > 0) {
      await this._handleNewEmails(added, emails)
    }
    this._notifySyncComplete()
    // Unsnooze due emails
    await this.apiRequest('/api/emails/unsnooze-due', 'POST', {}).catch(() => {})
  }

  async _runBackfill(job) {
    const activeAccountCount = this.knownAccounts.size || 1
    const batchSize = this.computeBatchSize(job.accountId, activeAccountCount)
    console.log(`[sync-manager] backfill ${job.accountId} batchSize=${batchSize}`)

    const t0 = Date.now()
    const res = await this.apiRequest('/api/sync/backfill', 'POST', {
      accountId: job.accountId,
      batchSize,
    })
    const durationMs = Date.now() - t0

    if (!res || res.status !== 200) {
      console.log(`[sync-manager] backfill ${job.accountId} failed (status ${res?.status ?? 'network'})`)
      return
    }

    await this.updateBatchState(job.accountId, batchSize, durationMs)

    const results = res.body?.results ?? []
    for (const r of results) {
      if (!r.skipped) {
        console.log(`[sync-manager] backfill ${job.accountId}/${r.folder} — added ${r.added}${r.complete ? ' (complete)' : ''}`)
      }
    }
  }

  // ── Adaptive Batch Sizing ───────────────────────────────────────────────────

  computeBatchSize(accountId, activeAccountCount) {
    const state = this.accountBatchState.get(accountId)
    const current = state?.batchSize ?? INITIAL_BATCH_SIZE
    const perAccountMax = Math.min(MAX_BATCH_SIZE, Math.floor(GLOBAL_BATCH_BUDGET / Math.max(1, activeAccountCount)))
    return Math.max(MIN_BATCH_SIZE, Math.min(current, perAccountMax))
  }

  nextBatchSize(current, lastDurationMs, perAccountMax) {
    let next = current
    if (lastDurationMs < 3000)  next = current + 25
    else if (lastDurationMs > 10000) next = current - 25
    return Math.max(MIN_BATCH_SIZE, Math.min(next, perAccountMax))
  }

  async updateBatchState(accountId, batchSize, durationMs) {
    const activeAccountCount = this.knownAccounts.size || 1
    const perAccountMax = Math.min(MAX_BATCH_SIZE, Math.floor(GLOBAL_BATCH_BUDGET / activeAccountCount))
    const newSize = this.nextBatchSize(batchSize, durationMs, perAccountMax)

    this.accountBatchState.set(accountId, { batchSize: newSize, lastDurationMs: durationMs })

    // Persist to backend
    await this.apiRequest(`/api/sync/state/${accountId}`, 'PATCH', {
      last_batch_size: newSize,
      last_batch_duration_ms: durationMs,
    }).catch(e => console.error('[sync-manager] persist batch state failed:', e.message))
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  async _runPollTick() {
    try {
      const res = await this.apiRequest('/api/accounts')
      if (!res || res.status !== 200 || !Array.isArray(res.body?.accounts)) return
      let burstIndex = 0
      for (const acc of res.body.accounts) {
        if (!this.knownAccounts.has(acc.id)) {
          this.knownAccounts.add(acc.id)
          this.accountBatchState.set(acc.id, { batchSize: INITIAL_BATCH_SIZE, lastDurationMs: 0 })
          this.enqueue({ type: 'burst', accountId: acc.id, priority: 0, burstIndex: burstIndex++ })
          console.log(`[sync-manager] new account detected: ${acc.id} — burst queued`)
        }
      }
    } catch (e) {
      console.error('[sync-manager] poll tick error:', e.message)
    }
  }

  _enqueueBackfill() {
    for (const accountId of this.knownAccounts) {
      this.enqueue({ type: 'backfill', accountId, priority: 2 })
    }
  }

  _notifySyncComplete() {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return
    // Trailing debounce — coalesces burst + fast sync events at launch
    if (this._syncCompleteDebounce) clearTimeout(this._syncCompleteDebounce)
    this._syncCompleteDebounce = setTimeout(() => {
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send('sync-complete')
      }
    }, SYNC_COMPLETE_DEBOUNCE_MS)
  }

  async _handleNewEmails(added, emails) {
    // Fetch unread count and notify renderer
    const res = await this.apiRequest('/api/emails/unread-counts').catch(() => null)
    if (!res || res.status !== 200) return
    const unreadCount = res.body?.total_unread ?? 0
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send('new-emails', { added, unreadCount, emails })
    }
  }
}

module.exports = { SyncManager }
```

- [ ] **Step 4: Run sync-manager tests**

```bash
npm run test:utils
```
Expected: all `sync-manager.test.js` tests PASS. `utils.test.js` tests still PASS.

- [ ] **Step 5: Commit**

```bash
git add electron/sync-manager.js electron/sync-manager.test.js && git commit -m "feat(electron): SyncManager with priority queue, adaptive batching, burst sync"
```

---

### Task 6: Refactor `electron/main.js`

**Files:**
- Modify: `electron/main.js`

**Context:** `main.js` currently has `runSyncTick()`, `runBackfillTick()`, `backfillRunning`, `BACKFILL_INTERVAL_MS`, and their associated timer wiring in `app.whenReady()`. All of this moves to `SyncManager`. What stays in `main.js`:
- Backend process management (`startBackend`, `waitForBackend`)
- `BrowserWindow` and tray setup
- `apiRequest` helper (still needed and passed to `SyncManager`)
- IPC handlers (`setupIPC`)
- Notification logic (`runSchedulerTick` for bills — unchanged)
- `setWindowsBadge` helper

The `syncTimer` and `backfillTimer` variables and their `before-quit` cleanup are replaced by a single `syncManager.stop()` call.

**Important:** `runSyncTick` sends `sync-complete` and `new-emails` events to the renderer and calls unsnooze. These responsibilities move to `SyncManager._runFast()` and `SyncManager._notifySyncComplete()`. The `setWindowsBadge` call based on unread count is triggered by `new-emails` event — this wiring stays in `main.js` but is called from the `new-emails` IPC event that `SyncManager` sends. Add a `mainWindow.webContents.on('ipc-message', ...)` listener or keep badge update inline.

Actually, the cleanest approach: `SyncManager._handleNewEmails` already sends `new-emails` to the renderer. Keep `setWindowsBadge` wiring in main.js listening to the same IPC event via `ipcMain.on('update-badge', ...)` or just have `SyncManager` call a callback. Pass an optional `onNewEmails` callback to the SyncManager constructor.

Simpler: pass `setWindowsBadge` as a callback. Update SyncManager constructor to accept `{ onNewEmails }` options and call it after `_handleNewEmails`.

- [ ] **Step 1: Update `SyncManager` constructor to accept an `onNewEmails` callback**

In `electron/sync-manager.js`, update constructor and `_handleNewEmails`:

```javascript
// Constructor: add options parameter
constructor(apiRequest, mainWindow, backendUrl, options = {}) {
  // ... existing fields ...
  this._onNewEmails = options.onNewEmails ?? null
}

// In _handleNewEmails, after send:
async _handleNewEmails(added, emails) {
  const res = await this.apiRequest('/api/emails/unread-counts').catch(() => null)
  if (!res || res.status !== 200) return
  const unreadCount = res.body?.total_unread ?? 0
  if (this.mainWindow && !this.mainWindow.isDestroyed()) {
    this.mainWindow.webContents.send('new-emails', { added, unreadCount, emails })
  }
  if (this._onNewEmails) this._onNewEmails({ added, unreadCount, emails })
}
```

- [ ] **Step 2: Refactor `main.js`**

Make the following changes to `electron/main.js`:

**2a — Add import at top (after existing requires):**
```javascript
const { SyncManager } = require('./sync-manager')
```

**2b — Remove these variables:**
```javascript
// REMOVE:
let syncTimer = null
let backfillTimer = null
let backfillRunning = false
const BACKFILL_INTERVAL_MS = 5 * 60 * 1000
```

**2c — Add `syncManager` variable:**
```javascript
let syncManager = null
```

**2d — Remove the entire `runSyncTick()` function** (lines ~204–279 in original).

**2e — Remove the entire `runBackfillTick()` function** (lines ~282–331 in original).

**2f — In `app.whenReady()`, replace the sync/backfill timer blocks:**

Remove:
```javascript
  // Email sync: first run 30s after launch, then every 60s
  syncTimer = setTimeout(() => {
    runSyncTick()
    syncTimer = setInterval(runSyncTick, SYNC_INTERVAL_MS)
  }, SCHEDULER_STARTUP_DELAY_MS)

  // Progressive backfill: first run 90s after launch, then every 5 min (idle only)
  backfillTimer = setTimeout(() => {
    runBackfillTick()
    backfillTimer = setInterval(runBackfillTick, BACKFILL_INTERVAL_MS)
  }, 90_000)
```

Replace with:
```javascript
  syncManager = new SyncManager(apiRequest, mainWindow, BACKEND_URL, {
    onNewEmails: ({ unreadCount }) => setWindowsBadge(mainWindow, unreadCount),
  })
  syncManager.start()
```

**2g — In `app.on('before-quit', ...)`, replace timer cleanup:**

Remove:
```javascript
  if (syncTimer)     { clearTimeout(syncTimer);     clearInterval(syncTimer) }
  if (backfillTimer) { clearTimeout(backfillTimer); clearInterval(backfillTimer) }
```

Replace with:
```javascript
  if (syncManager) syncManager.stop()
```

- [ ] **Step 3: Run electron tests to confirm nothing broke**

```bash
npm run test:utils
```
Expected: all tests PASS (utils + sync-manager).

- [ ] **Step 4: Run full test suite**

```bash
npm run test:all
```
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add electron/main.js electron/sync-manager.js && git commit -m "refactor(electron): wire SyncManager into main, remove idle-only backfill"
```

---

## Final Verification

- [ ] **Run full test suite one last time**

```bash
npm run test:all
```
Expected: all tests PASS.

- [ ] **TypeScript compile check**

```bash
cd inboxmy-backend && npx tsc --noEmit
```
Expected: no errors.

- [ ] **Manual smoke test** (optional but recommended)

Start the app: `npm run start` (or `npm run electron:dev` for dev mode).
1. App launches → burst jobs fire for each account → inbox populates within ~10s.
2. Wait 2min → backfill tick runs (check console for `[sync-manager] backfill` logs).
3. Keep window focused → backfill still runs (idle gate is gone).
4. Connect a new account mid-session → burst fires within 30s (next account poll tick).

- [ ] **Final commit** (if any last fixes)

```bash
git add -A && git commit -m "chore: sync redesign final cleanup"
```
