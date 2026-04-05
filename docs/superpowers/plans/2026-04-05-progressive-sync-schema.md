# Progressive Sync Schema Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Migration 10 + 11 (inbox_index, email_body, and supporting tables), update the sync engine to write metadata to inbox_index during Phase 1, and expose new cursor-based inbox and on-demand body routes — all additive, no existing tables or routes modified.

**Architecture:** Two migrations add 5 new tables alongside the existing `emails` table. The sync engine gains a parallel write path: for every email already inserted into `emails`, it also writes metadata to `inbox_index`. New Express sub-routes under `/api/emails/index` serve a cursor-paginated inbox list and on-demand body fetch (storing results in `email_body`). The legacy `GET /api/emails`, `POST /api/sync/trigger` behavior and the `emails` table are completely untouched.

**Tech Stack:** TypeScript, better-sqlite3 (SQLite), Express 5, Vitest, supertest, node-forge (encryption — do not modify crypto.ts)

**Spec:** `docs/superpowers/specs/2026-04-05-progressive-sync-schema-design.md`

---

## File Map

| Action | Path | Responsibility |
|--------|------|----------------|
| Create | `inboxmy-backend/tests/setup.ts` | Set `ENCRYPTION_KEY` env var before tests run |
| Create | `inboxmy-backend/tests/helpers/db.ts` | `makeTestDb()` — in-memory DB with all migrations applied |
| Create | `inboxmy-backend/tests/migrations.test.ts` | Verify Migration 10 + 11 tables, constraints, indexes |
| Create | `inboxmy-backend/tests/sync-engine-index.test.ts` | Verify inbox_index + sync_state writes during syncAccount |
| Create | `inboxmy-backend/tests/backfill.test.ts` | Verify backfill cursor advancement and completion |
| Create | `inboxmy-backend/tests/emails-index-route.test.ts` | Verify GET /index cursor pagination + GET /index/:id body fetch |
| Modify | `inboxmy-backend/vitest.config.ts` | Add `setupFiles: ['tests/setup.ts']` |
| Modify | `inboxmy-backend/src/db/migrations.ts` | Add Migration 10 (inbox_index, sync_state, sync_backfill_cursors) and Migration 11 (email_body, attachments) |
| Modify | `inboxmy-backend/src/email/types.ts` | Add `NormalizedEmailMetadata` interface |
| Modify | `inboxmy-backend/src/email/gmail-client.ts` | Add `fetchEmailsMetadata()` — metadata-only fetch path |
| Modify | `inboxmy-backend/src/email/outlook-client.ts` | Add `fetchEmailsMetadata()` — metadata-only select path |
| Modify | `inboxmy-backend/src/email/sync-engine.ts` | Add inbox_index + sync_state writes inside syncAccount; seed sync_backfill_cursors |
| Modify | `inboxmy-backend/src/routes/emails.ts` | Add `GET /index` (cursor pagination) and `GET /index/:id` (on-demand body) before existing `/:id` |
| Modify | `inboxmy-backend/src/routes/sync.ts` | Add `POST /backfill` endpoint |

---

## Task 1: Test Infrastructure

**Files:**
- Create: `inboxmy-backend/tests/setup.ts`
- Create: `inboxmy-backend/tests/helpers/db.ts`
- Modify: `inboxmy-backend/vitest.config.ts`

- [ ] **Step 1: Create test env setup file**

`inboxmy-backend/tests/setup.ts`:
```typescript
// Set required env vars before any module is imported
process.env.ENCRYPTION_KEY = 'a'.repeat(64) // 64 hex chars = 32 bytes, test only
```

- [ ] **Step 2: Create the DB helper**

`inboxmy-backend/tests/helpers/db.ts`:
```typescript
import Database from 'better-sqlite3'
import { runMigrations } from '../../src/db/migrations'

export function makeTestDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  runMigrations(db)
  return db
}
```

- [ ] **Step 3: Register setup file in vitest config**

`inboxmy-backend/vitest.config.ts` — replace entirely:
```typescript
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
  },
})
```

- [ ] **Step 4: Verify config loads**

Run from `inboxmy-backend/`:
```bash
npx vitest run --reporter=verbose 2>&1 | head -20
```
Expected: "No test files found" (not an error about ENCRYPTION_KEY)

- [ ] **Step 5: Commit**

```bash
git add inboxmy-backend/tests/setup.ts inboxmy-backend/tests/helpers/db.ts inboxmy-backend/vitest.config.ts
git commit -m "test: add vitest infrastructure — in-memory DB helper and env setup"
```

---

## Task 2: Migration 10 — Hot Path Tables

**Files:**
- Modify: `inboxmy-backend/src/db/migrations.ts` (append to MIGRATIONS array)
- Create: `inboxmy-backend/tests/migrations.test.ts`

- [ ] **Step 1: Write the failing test**

`inboxmy-backend/tests/migrations.test.ts`:
```typescript
import Database from 'better-sqlite3'
import { describe, it, expect, beforeEach } from 'vitest'
import { runMigrations } from '../src/db/migrations'

function freshDb() {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  return db
}

describe('Migration 10 — hot path tables', () => {
  let db: Database.Database

  beforeEach(() => {
    db = freshDb()
    runMigrations(db)
  })

  it('creates inbox_index table with required columns', () => {
    const cols = db.prepare("PRAGMA table_info(inbox_index)").all() as any[]
    const names = cols.map(c => c.name)
    expect(names).toContain('email_id')
    expect(names).toContain('account_id')
    expect(names).toContain('provider_message_id')
    expect(names).toContain('subject_preview_enc')
    expect(names).toContain('received_at')
    expect(names).toContain('has_full_body')
    expect(names).toContain('sync_state')
    expect(names).toContain('snoozed_until')
  })

  it('enforces UNIQUE(account_id, provider_message_id) on inbox_index', () => {
    // Create prerequisite account
    db.prepare(`INSERT INTO accounts (id, provider, email, token_enc, created_at)
      VALUES ('acc1', 'gmail', 'a@test.com', 'enc', 1)`).run()

    const insert = db.prepare(`
      INSERT INTO inbox_index
        (email_id, account_id, provider_message_id, sender_email, subject_preview_enc, received_at)
      VALUES (?, 'acc1', 'msg1', 'x@x.com', 'enc', 1)
    `)

    insert.run('uuid-1')
    // Second insert with same provider_message_id — must be ignored
    expect(() => insert.run('uuid-2')).toThrow(/UNIQUE constraint/)
  })

  it('ON CONFLICT DO NOTHING does not throw on duplicate provider_message_id', () => {
    db.prepare(`INSERT INTO accounts (id, provider, email, token_enc, created_at)
      VALUES ('acc1', 'gmail', 'a@test.com', 'enc', 1)`).run()

    const insert = db.prepare(`
      INSERT INTO inbox_index
        (email_id, account_id, provider_message_id, sender_email, subject_preview_enc, received_at)
      VALUES (?, 'acc1', 'msg1', 'x@x.com', 'enc', 1)
      ON CONFLICT(account_id, provider_message_id) DO NOTHING
    `)

    expect(() => {
      insert.run('uuid-1')
      insert.run('uuid-2') // duplicate — should silently do nothing
    }).not.toThrow()

    const count = (db.prepare('SELECT COUNT(*) as n FROM inbox_index').get() as any).n
    expect(count).toBe(1)
  })

  it('creates sync_state table', () => {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as any[]
    const names = tables.map(t => t.name)
    expect(names).toContain('sync_state')
    expect(names).toContain('sync_backfill_cursors')
  })

  it('sync_backfill_cursors has composite primary key (account_id, folder)', () => {
    db.prepare(`INSERT INTO accounts (id, provider, email, token_enc, created_at)
      VALUES ('acc1', 'gmail', 'a@test.com', 'enc', 1)`).run()

    db.prepare(`INSERT INTO sync_backfill_cursors (account_id, folder) VALUES ('acc1', 'inbox')`).run()
    // Duplicate must conflict
    expect(() =>
      db.prepare(`INSERT INTO sync_backfill_cursors (account_id, folder) VALUES ('acc1', 'inbox')`).run()
    ).toThrow(/UNIQUE constraint/)
  })

  it('idx_inbox_hot partial index exists', () => {
    const idx = db.prepare(`
      SELECT name FROM sqlite_master WHERE type='index' AND name='idx_inbox_hot'
    `).get()
    expect(idx).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run test — expect FAIL (tables don't exist yet)**

```bash
cd inboxmy-backend && npx vitest run tests/migrations.test.ts --reporter=verbose
```
Expected: FAIL — "no such table: inbox_index"

- [ ] **Step 3: Add Migration 10 to MIGRATIONS array**

Open `inboxmy-backend/src/db/migrations.ts`. After the last element in MIGRATIONS (Migration 9, the `msal_cache` line), append:

```typescript
  // Migration 10: progressive sync hot-path tables
  // inbox_index powers instant inbox rendering (metadata only, no body)
  // sync_state tracks per-account fast-sync cursor (Gmail historyId / Outlook deltaToken)
  // sync_backfill_cursors tracks per-folder backfill position
  `
  CREATE TABLE IF NOT EXISTS inbox_index (
    email_id             TEXT PRIMARY KEY,
    account_id           TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    provider_message_id  TEXT NOT NULL,
    thread_id            TEXT,
    sender_email         TEXT NOT NULL,
    sender_name          TEXT,
    subject_preview_enc  TEXT NOT NULL,
    snippet_preview_enc  TEXT,
    received_at          INTEGER NOT NULL,
    folder               TEXT NOT NULL DEFAULT 'inbox',
    tab                  TEXT NOT NULL DEFAULT 'primary',
    is_read              INTEGER NOT NULL DEFAULT 0,
    is_important         INTEGER NOT NULL DEFAULT 0,
    has_full_body        INTEGER NOT NULL DEFAULT 0,
    sync_state           TEXT NOT NULL DEFAULT 'partial',
    snoozed_until        INTEGER,
    category             TEXT,
    UNIQUE(account_id, provider_message_id)
  );
  CREATE INDEX IF NOT EXISTS idx_inbox_hot
    ON inbox_index(account_id, folder, tab, received_at DESC, email_id DESC)
    WHERE snoozed_until IS NULL;
  CREATE INDEX IF NOT EXISTS idx_inbox_backfill
    ON inbox_index(account_id, folder, received_at DESC, email_id DESC);
  CREATE INDEX IF NOT EXISTS idx_inbox_unread
    ON inbox_index(account_id, folder, is_read, tab, snoozed_until);

  CREATE TABLE IF NOT EXISTS sync_state (
    account_id           TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
    last_fast_sync_at    INTEGER,
    fast_sync_cursor     TEXT,
    last_backfill_at     INTEGER,
    backfill_complete    INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS sync_backfill_cursors (
    account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    folder      TEXT NOT NULL,
    cursor      TEXT,
    complete    INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (account_id, folder)
  );
  `,
```

- [ ] **Step 4: Run test — expect PASS**

```bash
npx vitest run tests/migrations.test.ts --reporter=verbose
```
Expected: all 5 tests PASS

- [ ] **Step 5: Commit**

```bash
git add inboxmy-backend/src/db/migrations.ts inboxmy-backend/tests/migrations.test.ts
git commit -m "feat(db): Migration 10 — inbox_index, sync_state, sync_backfill_cursors"
```

---

## Task 3: Migration 11 — Heavy Data Tables

**Files:**
- Modify: `inboxmy-backend/src/db/migrations.ts` (append Migration 11)
- Modify: `inboxmy-backend/tests/migrations.test.ts` (add Migration 11 tests)

- [ ] **Step 1: Add Migration 11 tests to `tests/migrations.test.ts`**

Append a new describe block at the bottom of the file:

```typescript
describe('Migration 11 — heavy data tables', () => {
  let db: Database.Database

  beforeEach(() => {
    db = freshDb()
    runMigrations(db)
  })

  it('creates email_body table with NOT NULL body_enc', () => {
    const cols = db.prepare("PRAGMA table_info(email_body)").all() as any[]
    const bodyCol = cols.find((c: any) => c.name === 'body_enc')
    expect(bodyCol).toBeTruthy()
    expect(bodyCol.notnull).toBe(1) // NOT NULL enforced
  })

  it('creates attachments table with correct columns', () => {
    const cols = db.prepare("PRAGMA table_info(attachments)").all() as any[]
    const names = cols.map((c: any) => c.name)
    expect(names).toContain('attachment_id')
    expect(names).toContain('email_id')
    expect(names).toContain('remote_ref')
    expect(names).toContain('download_state')
    expect(names).toContain('listed_at')
  })

  it('email_body FK cascades delete from inbox_index', () => {
    db.prepare(`INSERT INTO accounts (id, provider, email, token_enc, created_at)
      VALUES ('acc1', 'gmail', 'a@test.com', 'enc', 1)`).run()
    db.prepare(`INSERT INTO inbox_index
      (email_id, account_id, provider_message_id, sender_email, subject_preview_enc, received_at)
      VALUES ('uuid-1', 'acc1', 'msg1', 'x@x.com', 'enc', 1)`).run()
    db.prepare(`INSERT INTO email_body (email_id, body_enc, fetched_at)
      VALUES ('uuid-1', 'encrypted-body', 1)`).run()

    db.prepare(`DELETE FROM inbox_index WHERE email_id = 'uuid-1'`).run()

    const body = db.prepare(`SELECT * FROM email_body WHERE email_id = 'uuid-1'`).get()
    expect(body).toBeUndefined()
  })

  it('attachments FK cascades delete from inbox_index', () => {
    db.prepare(`INSERT INTO accounts (id, provider, email, token_enc, created_at)
      VALUES ('acc1', 'gmail', 'a@test.com', 'enc', 1)`).run()
    db.prepare(`INSERT INTO inbox_index
      (email_id, account_id, provider_message_id, sender_email, subject_preview_enc, received_at)
      VALUES ('uuid-1', 'acc1', 'msg1', 'x@x.com', 'enc', 1)`).run()
    db.prepare(`INSERT INTO attachments
      (attachment_id, email_id, filename, listed_at)
      VALUES ('att-1', 'uuid-1', 'file.pdf', 1)`).run()

    db.prepare(`DELETE FROM inbox_index WHERE email_id = 'uuid-1'`).run()

    const att = db.prepare(`SELECT * FROM attachments WHERE attachment_id = 'att-1'`).get()
    expect(att).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run test — expect FAIL (email_body doesn't exist yet)**

```bash
npx vitest run tests/migrations.test.ts --reporter=verbose
```
Expected: Migration 11 tests FAIL

- [ ] **Step 3: Add Migration 11 to MIGRATIONS array**

In `src/db/migrations.ts`, append after Migration 10:

```typescript
  // Migration 11: lazy-loaded heavy data tables
  // email_body populated only when user opens email (on-demand, Phase 3)
  // attachments cached lazily after first listing (Phase 4, 6h TTL)
  `
  CREATE TABLE IF NOT EXISTS email_body (
    email_id         TEXT PRIMARY KEY REFERENCES inbox_index(email_id) ON DELETE CASCADE,
    body_enc         TEXT NOT NULL,
    body_format      TEXT NOT NULL DEFAULT 'text',
    raw_headers_enc  TEXT,
    fetched_at       INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS attachments (
    attachment_id  TEXT PRIMARY KEY,
    email_id       TEXT NOT NULL REFERENCES inbox_index(email_id) ON DELETE CASCADE,
    filename       TEXT NOT NULL,
    mime_type      TEXT NOT NULL DEFAULT 'application/octet-stream',
    size_bytes     INTEGER,
    remote_ref     TEXT,
    download_state TEXT NOT NULL DEFAULT 'not_downloaded',
    local_path     TEXT,
    listed_at      INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_attachments_email ON attachments(email_id);
  `,
```

- [ ] **Step 4: Run all migration tests — expect PASS**

```bash
npx vitest run tests/migrations.test.ts --reporter=verbose
```
Expected: all 9 tests PASS

- [ ] **Step 5: Commit**

```bash
git add inboxmy-backend/src/db/migrations.ts inboxmy-backend/tests/migrations.test.ts
git commit -m "feat(db): Migration 11 — email_body, attachments"
```

---

## Task 4: NormalizedEmailMetadata Type

**Files:**
- Modify: `inboxmy-backend/src/email/types.ts`

- [ ] **Step 1: Add the type**

Append to `inboxmy-backend/src/email/types.ts`:

```typescript
// Metadata-only representation — no body fields.
// Used by inbox_index writes and metadata-only provider fetch paths.
export interface NormalizedEmailMetadata {
  id: string            // provider message id (goes into inbox_index.provider_message_id)
  accountId: string
  threadId: string | null
  subject: string       // plaintext (will be encrypted on store)
  sender: string        // email address
  senderName: string | null
  receivedAt: number    // unix ms
  isRead: boolean
  folder: EmailFolder
  tab: EmailTab
  isImportant: boolean
  category: EmailCategory
  snippet: string | null
  rawSize: number
  // NO bodyHtml, NO bodyText
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd inboxmy-backend && npx tsc --noEmit
```
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add inboxmy-backend/src/email/types.ts
git commit -m "feat(types): add NormalizedEmailMetadata — metadata-only email shape"
```

---

## Task 5: Gmail Metadata Fetch

**Files:**
- Modify: `inboxmy-backend/src/email/gmail-client.ts`

This adds a new exported function `fetchEmailsMetadata` alongside the existing `fetchNewEmails`. The existing function is NOT modified.

- [ ] **Step 1: Add `fetchEmailsMetadata` to `gmail-client.ts`**

Append after the existing `extractBody` function:

```typescript
// ── Metadata-only fetch (Phase 1 fast sync) ──────────────────────────────────
// Uses format='metadata' — returns headers + snippet but NO body.
// ~10x faster than format='full' for large syncs.

export async function fetchEmailsMetadata(
  accountId: string,
  cursor: string | null,  // fast_sync_cursor from sync_state (Gmail historyId)
  limit: number = 100,
  beforeMs?: number        // optional upper-bound timestamp for backfill (Unix ms)
): Promise<{ emails: NormalizedEmailMetadata[], newCursor: string | null }> {
  const auth = await getAuthedClient(accountId)
  const gmail = google.gmail({ version: 'v1', auth })

  // ── Incremental mode (History API) — only used when no beforeMs constraint ──
  if (cursor && !beforeMs) {
    try {
      const history = await gmail.users.history.list({
        userId: 'me',
        startHistoryId: cursor,
        historyTypes: ['messageAdded'],
      })
      const newCursor = history.data.historyId ?? cursor
      const messageIds = new Set<string>()
      for (const record of history.data.history ?? []) {
        for (const added of record.messagesAdded ?? []) {
          if (added.message?.id) messageIds.add(added.message.id)
        }
      }
      if (messageIds.size === 0) return { emails: [], newCursor }

      const emails: NormalizedEmailMetadata[] = []
      for (const id of messageIds) {
        try {
          const meta = await gmail.users.messages.get({
            userId: 'me', id, format: 'metadata',
            metadataHeaders: ['From', 'Subject', 'Date'],
          })
          emails.push(normalizeGmailMetadata(accountId, meta.data))
        } catch { /* skip individual failures */ }
      }
      return { emails, newCursor }
    } catch (err: any) {
      // 404 = historyId stale — fall through to full metadata fetch
      if (err.code !== 404 && err.status !== 404) throw err
      console.log(`[gmail] metadata: historyId stale for ${accountId}, falling back`)
    }
  }

  // ── Full / backfill metadata fetch ──────────────────────────────────────────
  // When beforeMs is provided (backfill): fetch emails BEFORE that timestamp.
  // When not provided (Phase 1): fetch the newest emails.
  const query = beforeMs
    ? `before:${Math.floor(beforeMs / 1000)}`  // backfill: older than cursor
    : 'newer_than:90d'                          // Phase 1: newest emails
  const list = await gmail.users.messages.list({
    userId: 'me', q: query, maxResults: limit, includeSpamTrash: true,
  })

  const emails: NormalizedEmailMetadata[] = []
  for (const msg of list.data.messages ?? []) {
    try {
      const meta = await gmail.users.messages.get({
        userId: 'me', id: msg.id!, format: 'metadata',
        metadataHeaders: ['From', 'Subject', 'Date'],
      })
      emails.push(normalizeGmailMetadata(accountId, meta.data))
    } catch { /* skip individual failures */ }
  }

  // Capture fresh historyId for next incremental sync
  let newCursor: string | null = null
  try {
    const profile = await gmail.users.getProfile({ userId: 'me' })
    newCursor = profile.data.historyId ?? null
  } catch { /* non-fatal */ }

  return { emails, newCursor }
}

function normalizeGmailMetadata(accountId: string, msg: any): NormalizedEmailMetadata {
  const headers: Record<string, string> = {}
  for (const h of msg.payload?.headers ?? []) {
    headers[h.name.toLowerCase()] = h.value
  }
  const labelIds: string[] = msg.labelIds ?? []
  const from = headers['from'] ?? ''
  const senderMatch = from.match(/^(.+?)\s*<([^>]+)>$/)
  const senderEmail = senderMatch ? senderMatch[2] : from
  const senderName = senderMatch ? senderMatch[1].replace(/"/g, '').trim() : null

  return {
    id: msg.id,
    accountId,
    threadId: msg.threadId ?? null,
    subject: headers['subject'] ?? '(no subject)',
    sender: senderEmail.toLowerCase(),
    senderName,
    receivedAt: parseInt(msg.internalDate ?? '0'),
    isRead: !labelIds.includes('UNREAD'),
    folder: gmailFolder(labelIds),
    tab: gmailTab(labelIds),
    isImportant: labelIds.includes('IMPORTANT'),
    category: null,
    snippet: msg.snippet ?? null,
    rawSize: msg.sizeEstimate ?? 0,
  }
}
```

Also add `NormalizedEmailMetadata` to the import from `./types` at the top of `gmail-client.ts`:

```typescript
import type { NormalizedEmail, NormalizedEmailMetadata } from './types'
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd inboxmy-backend && npx tsc --noEmit
```
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add inboxmy-backend/src/email/gmail-client.ts
git commit -m "feat(gmail): add fetchEmailsMetadata — metadata-only Phase 1 fetch path"
```

---

## Task 6: Outlook Metadata Fetch

**Files:**
- Modify: `inboxmy-backend/src/email/outlook-client.ts`

- [ ] **Step 1: Add `fetchEmailsMetadata` to `outlook-client.ts`**

Append after the existing `normalizeGraphMessage` function, and add the import:

```typescript
import type { NormalizedEmail, NormalizedEmailMetadata } from './types'
```

Then append:

```typescript
// ── Metadata-only fetch (Phase 1 fast sync) ──────────────────────────────────
// NOTE: Outlook has no delta token support yet.
// fast_sync_cursor is unused for Outlook — always does date-based fetch.
// Delta token support is a future task; the sync_state column is ready.

export async function fetchEmailsMetadata(
  accountId: string,
  _cursor: string | null,  // unused until Outlook deltaToken is implemented
  limit: number = 100,
  beforeMs?: number        // optional upper-bound for backfill (Unix ms)
): Promise<{ emails: NormalizedEmailMetadata[], newCursor: string | null }> {
  const accessToken = await getAccessToken(accountId)
  const client = Client.init({
    authProvider: (done) => done(null, accessToken),
  })

  // When beforeMs provided (backfill): fetch emails older than that timestamp.
  // When not provided (Phase 1): fetch emails from the last 90 days.
  const since = new Date(Date.now() - 90 * 86400_000).toISOString()
  const filter = beforeMs
    ? `receivedDateTime lt ${new Date(beforeMs).toISOString()}`
    : `receivedDateTime gt ${since}`

  const result = await client
    .api('/me/messages')
    .filter(filter)
    // Metadata only — no body, no bodyPreview expanded beyond snippet
    .select('id,subject,from,receivedDateTime,isRead,bodyPreview,conversationId,importance,sizeEstimate')
    .top(limit)
    .get()

  const emails: NormalizedEmailMetadata[] = (result.value ?? []).map(
    (msg: any) => normalizeGraphMetadata(accountId, msg)
  )

  // Outlook: no cursor for now — return null until deltaToken is implemented
  return { emails, newCursor: null }
}

function normalizeGraphMetadata(accountId: string, msg: any): NormalizedEmailMetadata {
  const from = msg.from?.emailAddress
  return {
    id: msg.id,
    accountId,
    threadId: msg.conversationId ?? null,
    subject: msg.subject ?? '(no subject)',
    sender: (from?.address ?? '').toLowerCase(),
    senderName: from?.name ?? null,
    receivedAt: new Date(msg.receivedDateTime).getTime(),
    isRead: msg.isRead,
    folder: 'inbox',  // Outlook folder detection is a future task
    tab: 'primary',   // Outlook has no CATEGORY_* equivalent
    isImportant: msg.importance === 'high',
    category: null,
    snippet: msg.bodyPreview ?? null,
    rawSize: msg.sizeEstimate ?? 0,
  }
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd inboxmy-backend && npx tsc --noEmit
```
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add inboxmy-backend/src/email/outlook-client.ts
git commit -m "feat(outlook): add fetchEmailsMetadata — metadata-only Phase 1 fetch path"
```

---

## Task 7: Sync Engine — inbox_index Writes (Phase 1)

**Files:**
- Modify: `inboxmy-backend/src/email/sync-engine.ts`
- Create: `inboxmy-backend/tests/sync-engine-index.test.ts`

This task adds a **parallel write** to `inbox_index` inside the existing `syncAll` transaction. The existing `emails` table write is untouched. `sync_state` is read/written. `sync_backfill_cursors` is seeded.

- [ ] **Step 1: Write the failing test**

`inboxmy-backend/tests/sync-engine-index.test.ts`:
```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { makeTestDb } from './helpers/db'
import type Database from 'better-sqlite3'

// ── DB mock ──────────────────────────────────────────────────────────────────
let testDb: Database.Database

vi.mock('../src/db', () => ({ getDb: () => testDb }))

// ── Provider mock — returns 2 emails, no body ─────────────────────────────────
vi.mock('../src/email/gmail-client', () => ({
  fetchNewEmails: vi.fn().mockResolvedValue({
    emails: [
      {
        id: 'gmail-msg-1', accountId: 'acc-1', threadId: 'thread-1',
        subject: 'Hello', sender: 'a@example.com', senderName: 'Alice',
        receivedAt: 1_700_000_000_000, isRead: false,
        folder: 'inbox', tab: 'primary', isImportant: false,
        category: null, bodyHtml: '<p>Hi</p>', bodyText: null,
        snippet: 'Hi there', rawSize: 1024,
      },
      {
        id: 'gmail-msg-2', accountId: 'acc-1', threadId: null,
        subject: 'World', sender: 'b@example.com', senderName: null,
        receivedAt: 1_699_000_000_000, isRead: true,
        folder: 'inbox', tab: 'primary', isImportant: true,
        category: 'bill', bodyHtml: null, bodyText: 'Body text',
        snippet: 'World snippet', rawSize: 512,
      },
    ],
    newHistoryId: 'history-abc',
  }),
}))

vi.mock('../src/email/outlook-client', () => ({
  fetchNewEmails: vi.fn().mockResolvedValue([]),
}))

vi.mock('../src/parsers', () => ({
  parseEmail: vi.fn().mockReturnValue({ category: null, bill: null }),
}))

vi.mock('../src/parsers/spam-scorer', () => ({
  scoreSpam: vi.fn().mockReturnValue({ isSpam: false }),
}))

// ── Tests ─────────────────────────────────────────────────────────────────────
describe('syncAccount — inbox_index writes', () => {
  const TEST_DATA_KEY = Buffer.alloc(32, 0x42)

  beforeEach(() => {
    testDb = makeTestDb()
    // Insert prerequisite user + account
    testDb.prepare(`
      INSERT INTO users (id, email, password_hash, pbkdf2_salt, data_key_enc, recovery_enc, created_at)
      VALUES ('user-1', 'user@test.com', 'hash', 'salt', 'enc', 'enc', 1)
    `).run()
    testDb.prepare(`
      INSERT INTO accounts (id, provider, email, token_enc, created_at, user_id)
      VALUES ('acc-1', 'gmail', 'a@test.com', 'enc', 1, 'user-1')
    `).run()
  })

  afterEach(() => testDb.close())

  it('inserts emails into inbox_index after sync', async () => {
    const { syncAccount } = await import('../src/email/sync-engine')
    await syncAccount('acc-1', TEST_DATA_KEY)

    const rows = testDb.prepare('SELECT * FROM inbox_index ORDER BY received_at DESC').all() as any[]
    expect(rows).toHaveLength(2)
    expect(rows[0].provider_message_id).toBe('gmail-msg-1')
    expect(rows[0].sender_email).toBe('a@example.com')
    expect(rows[0].is_read).toBe(0)
    expect(rows[0].is_important).toBe(0)
    expect(rows[0].sync_state).toBe('partial')
    expect(rows[0].has_full_body).toBe(0)
  })

  it('email_id in inbox_index is a UUID (not the provider message id)', async () => {
    const { syncAccount } = await import('../src/email/sync-engine')
    await syncAccount('acc-1', TEST_DATA_KEY)

    const row = testDb.prepare('SELECT email_id, provider_message_id FROM inbox_index WHERE provider_message_id = ?')
      .get('gmail-msg-1') as any
    expect(row).toBeTruthy()
    expect(row.email_id).not.toBe('gmail-msg-1')
    // UUID v4 format
    expect(row.email_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
  })

  it('subject_preview_enc is encrypted (not plaintext)', async () => {
    const { syncAccount } = await import('../src/email/sync-engine')
    await syncAccount('acc-1', TEST_DATA_KEY)

    const row = testDb.prepare('SELECT subject_preview_enc FROM inbox_index WHERE provider_message_id = ?')
      .get('gmail-msg-1') as any
    expect(row.subject_preview_enc).not.toBe('Hello') // must be encrypted
    expect(row.subject_preview_enc.length).toBeGreaterThan(10)
  })

  it('is idempotent — running sync twice does not duplicate inbox_index rows', async () => {
    const { syncAccount } = await import('../src/email/sync-engine')
    await syncAccount('acc-1', TEST_DATA_KEY)
    await syncAccount('acc-1', TEST_DATA_KEY)

    const count = (testDb.prepare('SELECT COUNT(*) as n FROM inbox_index').get() as any).n
    expect(count).toBe(2)
  })

  it('updates sync_state after sync', async () => {
    const { syncAccount } = await import('../src/email/sync-engine')
    await syncAccount('acc-1', TEST_DATA_KEY)

    const state = testDb.prepare('SELECT * FROM sync_state WHERE account_id = ?').get('acc-1') as any
    expect(state).toBeTruthy()
    expect(state.fast_sync_cursor).toBe('history-abc')
    expect(state.last_fast_sync_at).toBeGreaterThan(0)
  })

  it('seeds sync_backfill_cursors for inbox, sent, spam', async () => {
    const { syncAccount } = await import('../src/email/sync-engine')
    await syncAccount('acc-1', TEST_DATA_KEY)

    const cursors = testDb.prepare('SELECT folder FROM sync_backfill_cursors WHERE account_id = ?')
      .all('acc-1') as any[]
    const folders = cursors.map(c => c.folder).sort()
    expect(folders).toEqual(['inbox', 'sent', 'spam'])
  })
})
```

- [ ] **Step 2: Run test — expect FAIL**

```bash
cd inboxmy-backend && npx vitest run tests/sync-engine-index.test.ts --reporter=verbose
```
Expected: FAIL — inbox_index row count is 0

- [ ] **Step 3: Update `sync-engine.ts` — add inbox_index writes**

In `src/email/sync-engine.ts`, make the following changes:

**Add `randomUUID` import (already present — verify it's there).**

> **Verify return shape before writing sync_state upsert:** Open `src/email/gmail-client.ts` and confirm the return type of `fetchNewEmails` is `{ emails: NormalizedEmail[], newHistoryId: string | null }`. The sync_state upsert at the end of this step references `newHistoryId` by that exact name — if the variable is named differently in `syncAccount` (e.g. destructured as `gmailResult.newHistoryId`), adjust accordingly.

Inside `syncAccount`, after the existing `insertEmail` prepared statement, add:

```typescript
const insertIndex = db.prepare(`
  INSERT INTO inbox_index
    (email_id, account_id, provider_message_id, thread_id,
     sender_email, sender_name, subject_preview_enc, snippet_preview_enc,
     received_at, folder, tab, is_read, is_important, category)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(account_id, provider_message_id) DO NOTHING
`)
```

Inside the `syncAll` transaction, after the `if (result.changes > 0)` block (where `added++` is called), add the inbox_index write:

```typescript
if (result.changes > 0) {
  added++
  // ── inbox_index parallel write ──────────────────────────────────────
  insertIndex.run(
    randomUUID(),                                    // email_id (internal UUID)
    accountId,
    email.id,                                        // provider_message_id
    email.threadId ?? null,
    email.sender,
    email.senderName ?? null,
    encrypt(email.subject, dataKey),                 // subject_preview_enc
    email.snippet ? encrypt(email.snippet, dataKey) : null, // snippet_preview_enc
    email.receivedAt,
    finalFolder,
    finalTab,
    email.isRead ? 1 : 0,
    email.isImportant ? 1 : 0,
    parsed.category ?? null
  )
  // ── end inbox_index write ────────────────────────────────────────────
  staged.push({ ... }) // existing code continues unchanged
```

After the `syncAll(emails)` call and the existing `accounts` UPDATE, add sync_state and backfill cursor writes:

```typescript
// ── Update sync_state (new progressive sync tracking) ─────────────────
db.prepare(`
  INSERT INTO sync_state (account_id, last_fast_sync_at, fast_sync_cursor)
  VALUES (?, ?, ?)
  ON CONFLICT(account_id) DO UPDATE SET
    last_fast_sync_at = excluded.last_fast_sync_at,
    fast_sync_cursor  = COALESCE(excluded.fast_sync_cursor, fast_sync_cursor)
`).run(accountId, Date.now(), newHistoryId)

// ── Seed backfill cursors (idempotent — DO NOTHING if already exists) ──
for (const folder of ['inbox', 'sent', 'spam']) {
  db.prepare(`
    INSERT INTO sync_backfill_cursors (account_id, folder, complete)
    VALUES (?, ?, 0)
    ON CONFLICT(account_id, folder) DO NOTHING
  `).run(accountId, folder)
}
```

- [ ] **Step 4: Run test — expect PASS**

```bash
npx vitest run tests/sync-engine-index.test.ts --reporter=verbose
```
Expected: all 6 tests PASS

- [ ] **Step 5: Run full test suite to ensure nothing regressed**

```bash
npx vitest run --reporter=verbose
```
Expected: all tests PASS

- [ ] **Step 6: Commit**

```bash
git add inboxmy-backend/src/email/sync-engine.ts inboxmy-backend/tests/sync-engine-index.test.ts
git commit -m "feat(sync): write inbox_index + sync_state in Phase 1 — parallel to existing emails write"
```

---

## Task 8: POST /api/sync/backfill (Phase 2)

**Files:**
- Modify: `inboxmy-backend/src/routes/sync.ts`
- Create: `inboxmy-backend/tests/backfill.test.ts`

The backfill route calls the provider API (via `fetchEmailsMetadata` with a `beforeMs` bound) to fetch older emails not yet in `inbox_index`. It inserts results with `ON CONFLICT DO NOTHING`, tracks which rows were actually inserted (`inserted_ids`), and derives the cursor only from that inserted set.

- [ ] **Step 1: Write the failing test**

`inboxmy-backend/tests/backfill.test.ts`:
```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { makeTestDb } from './helpers/db'
import type Database from 'better-sqlite3'
import { encrypt } from '../src/crypto'

let testDb: Database.Database

vi.mock('../src/db', () => ({ getDb: () => testDb }))
vi.mock('../src/middleware/auth', () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
}))

// Provider mock — returns 5 older emails for inbox, 0 for others
const MOCK_BATCH = Array.from({ length: 5 }, (_, i) => ({
  id: `old-msg-${i}`,
  accountId: 'acc-1',
  threadId: null,
  subject: `Old Email ${i}`,
  sender: `sender${i}@example.com`,
  senderName: `Sender ${i}`,
  receivedAt: 1_690_000_000_000 - i * 1000, // older than Phase 1 emails
  isRead: false,
  folder: 'inbox' as const,
  tab: 'primary' as const,
  isImportant: false,
  category: null,
  snippet: `snippet ${i}`,
  rawSize: 512,
}))

vi.mock('../src/email/gmail-client', () => ({
  fetchNewEmails: vi.fn(),
  fetchEmailsMetadata: vi.fn().mockImplementation(
    (_accountId: string, _cursor: string | null, _limit: number, beforeMs?: number) => {
      // Only return batch when fetching for inbox (called with beforeMs)
      if (beforeMs) return Promise.resolve({ emails: MOCK_BATCH, newCursor: null })
      return Promise.resolve({ emails: [], newCursor: null })
    }
  ),
}))

vi.mock('../src/email/outlook-client', () => ({
  fetchNewEmails: vi.fn(),
  fetchEmailsMetadata: vi.fn().mockResolvedValue({ emails: [], newCursor: null }),
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
  // Seed a cursor pointing to "some existing email" so backfill fetches emails older than it
  const cursorJson = JSON.stringify({ received_at: 1_700_000_000_000, email_id: 'existing-uuid' })
  db.prepare(`INSERT INTO sync_backfill_cursors (account_id, folder, cursor, complete)
    VALUES ('acc-1', 'inbox', ?, 0), ('acc-1', 'sent', ?, 1), ('acc-1', 'spam', ?, 1)
  `).run(cursorJson, cursorJson, cursorJson)
}

describe('POST /api/sync/backfill', () => {
  beforeEach(() => {
    testDb = makeTestDb()
    seedAccount(testDb)
  })

  afterEach(() => testDb.close())

  it('returns 200 with per-folder results', async () => {
    const app = await makeApp()
    const res = await request(app).post('/api/sync/backfill').send({ accountId: 'acc-1' })
    expect(res.status).toBe(200)
    expect(res.body).toHaveProperty('results')
    expect(Array.isArray(res.body.results)).toBe(true)
  })

  it('inserts provider-fetched emails into inbox_index', async () => {
    const app = await makeApp()
    await request(app).post('/api/sync/backfill').send({ accountId: 'acc-1' })

    const count = (testDb.prepare('SELECT COUNT(*) as n FROM inbox_index').get() as any).n
    expect(count).toBe(5) // MOCK_BATCH has 5 emails
  })

  it('marks folder complete when provider returns fewer than 25 emails', async () => {
    const app = await makeApp()
    await request(app).post('/api/sync/backfill').send({ accountId: 'acc-1' })

    const row = testDb.prepare(
      `SELECT complete FROM sync_backfill_cursors WHERE account_id='acc-1' AND folder='inbox'`
    ).get() as any
    expect(row.complete).toBe(1) // 5 < 25 → complete
  })

  it('advances cursor to the oldest inserted email (not unchanged from pre-existing)', async () => {
    const app = await makeApp()
    await request(app).post('/api/sync/backfill').send({ accountId: 'acc-1' })

    const row = testDb.prepare(
      `SELECT cursor FROM sync_backfill_cursors WHERE account_id='acc-1' AND folder='inbox'`
    ).get() as any
    const cursor = JSON.parse(row.cursor)
    // Oldest in MOCK_BATCH is index 4 (lowest received_at)
    expect(cursor.received_at).toBe(1_690_000_000_000 - 4 * 1000)
  })

  it('is idempotent — running twice does not duplicate inbox_index rows', async () => {
    const app = await makeApp()
    await request(app).post('/api/sync/backfill').send({ accountId: 'acc-1' })
    await request(app).post('/api/sync/backfill').send({ accountId: 'acc-1' })

    const count = (testDb.prepare('SELECT COUNT(*) as n FROM inbox_index').get() as any).n
    expect(count).toBe(5) // no duplicates
  })

  it('skips already-complete folders', async () => {
    // sent and spam are already complete in seedAccount
    const app = await makeApp()
    const res = await request(app).post('/api/sync/backfill').send({ accountId: 'acc-1' })
    const results = res.body.results as any[]
    const sentResult = results.find((r: any) => r.folder === 'sent')
    expect(sentResult.skipped).toBe(true)
  })

  it('returns 404 for unknown account', async () => {
    const app = await makeApp()
    const res = await request(app).post('/api/sync/backfill').send({ accountId: 'nonexistent' })
    expect(res.status).toBe(404)
  })
})
```

- [ ] **Step 2: Run test — expect FAIL (route doesn't exist)**

```bash
cd inboxmy-backend && npx vitest run tests/backfill.test.ts --reporter=verbose
```
Expected: FAIL — 404 on POST /api/sync/backfill

- [ ] **Step 3: Add the backfill route to `src/routes/sync.ts`**

Add these imports at the top of `sync.ts` alongside existing imports:

```typescript
import { fetchEmailsMetadata as fetchGmailMetadata } from '../email/gmail-client'
import { fetchEmailsMetadata as fetchOutlookMetadata } from '../email/outlook-client'
import { encrypt } from '../crypto'
import { randomUUID } from 'crypto'
import { scoreSpam } from '../parsers/spam-scorer'
```

Then append after the existing `syncRouter.post('/trigger', ...)` handler:

```typescript
// POST /api/sync/backfill — Phase 2 background backfill
// Calls the provider API to fetch older emails (metadata only) not yet in inbox_index.
// Inserts with ON CONFLICT(account_id, provider_message_id) DO NOTHING (idempotent).
// Cursor tracks the oldest email fetched — scoped to inserted_ids only to avoid stalling.
// Called by Electron on a low-priority idle schedule (e.g., every 5 min when idle).
syncRouter.post('/backfill', async (req, res) => {
  const { accountId } = req.body
  const user = (req as any).user
  const db = getDb()

  if (!accountId) return res.status(400).json({ error: 'accountId required' })

  const account = db.prepare(
    'SELECT id, provider FROM accounts WHERE id = ? AND user_id = ?'
  ).get(accountId, user.id) as any
  if (!account) return res.status(404).json({ error: 'Account not found' })

  const BATCH_SIZE = 25
  const BACKFILL_FOLDERS = ['inbox', 'sent', 'spam'] as const
  const results: Array<{ folder: string; added: number; complete: boolean; skipped?: boolean }> = []

  const insertIndex = db.prepare(`
    INSERT INTO inbox_index
      (email_id, account_id, provider_message_id, thread_id,
       sender_email, sender_name, subject_preview_enc, snippet_preview_enc,
       received_at, folder, tab, is_read, is_important, category)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(account_id, provider_message_id) DO NOTHING
  `)

  for (const folder of BACKFILL_FOLDERS) {
    const cursorRow = db.prepare(
      'SELECT cursor, complete FROM sync_backfill_cursors WHERE account_id = ? AND folder = ?'
    ).get(accountId, folder) as any

    if (!cursorRow || cursorRow.complete === 1) {
      results.push({ folder, added: 0, complete: true, skipped: true })
      continue
    }

    // Parse cursor — { received_at, email_id } — distinct from route's next_cursor format
    const parsedCursor: { received_at: number; email_id: string } | null =
      cursorRow.cursor ? JSON.parse(cursorRow.cursor) : null

    // Call provider API to fetch emails older than cursor.received_at (metadata only)
    const beforeMs = parsedCursor?.received_at ?? undefined
    let batch: any[] = []
    try {
      const fetcher = account.provider === 'gmail' ? fetchGmailMetadata : fetchOutlookMetadata
      const result = await fetcher(accountId, null, BATCH_SIZE, beforeMs)
      batch = result.emails
    } catch (err: any) {
      console.error(`[backfill] Provider fetch failed for ${accountId}/${folder}:`, err.message)
      results.push({ folder, added: 0, complete: false })
      continue
    }

    // Insert batch — collect inserted_ids (rows where changes > 0)
    const insertedIds: string[] = []
    for (const email of batch) {
      const newUuid = randomUUID()
      const spamResult = scoreSpam(email)
      const finalFolder = spamResult.isSpam ? 'spam' : (email.folder ?? folder)
      const finalTab = finalFolder === 'spam' ? 'primary' : (email.tab ?? 'primary')

      const r = insertIndex.run(
        newUuid, accountId, email.id, email.threadId ?? null,
        email.sender, email.senderName ?? null,
        encrypt(email.subject, user.dataKey),
        email.snippet ? encrypt(email.snippet, user.dataKey) : null,
        email.receivedAt, finalFolder, finalTab,
        email.isRead ? 1 : 0, email.isImportant ? 1 : 0, email.category ?? null
      )
      if (r.changes > 0) insertedIds.push(newUuid)
    }

    const isComplete = batch.length < BATCH_SIZE

    // Derive new cursor ONLY from inserted_ids — never from the full batch or global DB query.
    // Scoping to inserted_ids prevents the cursor from jumping to the start of already-synced
    // history on subsequent calls, which would cause the backfill to stall indefinitely.
    // NOTE: better-sqlite3 .get() accepts an array for multi-value positional params.
    // Use .get(insertedIds) NOT .get(...insertedIds) — the spread form is ambiguous under
    // TypeScript overloads and harder to reason about. Array form is idiomatic.
    let newCursorJson: string | null = cursorRow.cursor
    if (insertedIds.length > 0) {
      const placeholders = insertedIds.map(() => '?').join(',')
      const oldestInserted = db.prepare(`
        SELECT received_at, email_id FROM inbox_index
        WHERE email_id IN (${placeholders})
        ORDER BY received_at ASC, email_id ASC
        LIMIT 1
      `).get(insertedIds) as any
      if (oldestInserted) {
        newCursorJson = JSON.stringify({
          received_at: oldestInserted.received_at,
          email_id: oldestInserted.email_id,
        })
      }
    }

    db.prepare(`
      UPDATE sync_backfill_cursors
      SET cursor = ?, complete = ?
      WHERE account_id = ? AND folder = ?
    `).run(newCursorJson, isComplete ? 1 : 0, accountId, folder)

    results.push({ folder, added: insertedIds.length, complete: isComplete })
  }

  // Update last_backfill_at in sync_state (upsert — sync_state may not exist yet)
  db.prepare(`
    INSERT INTO sync_state (account_id, last_backfill_at)
    VALUES (?, ?)
    ON CONFLICT(account_id) DO UPDATE SET last_backfill_at = excluded.last_backfill_at
  `).run(accountId, Date.now())

  res.json({ results })
})
```

- [ ] **Step 4: Run test — expect PASS**

```bash
npx vitest run tests/backfill.test.ts --reporter=verbose
```
Expected: all 6 tests PASS

- [ ] **Step 5: Run full test suite**

```bash
npx vitest run --reporter=verbose
```
Expected: all tests PASS

- [ ] **Step 6: Commit**

```bash
git add inboxmy-backend/src/routes/sync.ts inboxmy-backend/tests/backfill.test.ts
git commit -m "feat(routes): add POST /api/sync/backfill — Phase 2 provider fetch + cursor advancement"
```

---

## Task 9: GET /api/emails/index — Cursor Pagination (Phase UI)

**Files:**
- Modify: `inboxmy-backend/src/routes/emails.ts`
- Create: `inboxmy-backend/tests/emails-index-route.test.ts`

**Critical:** The new routes must be added **before** the existing `emailsRouter.get('/:id', ...)` handler (line 224 of emails.ts) to prevent `index` being matched as an email ID.

- [ ] **Step 1: Write the failing tests**

`inboxmy-backend/tests/emails-index-route.test.ts`:
```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { makeTestDb } from './helpers/db'
import type Database from 'better-sqlite3'
import { encrypt } from '../src/crypto'

let testDb: Database.Database

vi.mock('../src/db', () => ({ getDb: () => testDb }))
vi.mock('../src/middleware/auth', () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
}))

const TEST_DATA_KEY = Buffer.alloc(32, 0x42)
const TEST_USER = { id: 'user-1', dataKey: TEST_DATA_KEY }

async function makeApp() {
  const { emailsRouter } = await import('../src/routes/emails')
  const app = express()
  app.use(express.json())
  app.use((req: any, _res: any, next: any) => { req.user = TEST_USER; next() })
  app.use('/api/emails', emailsRouter)
  return app
}

function seedPrerequisites(db: Database.Database) {
  db.prepare(`INSERT INTO users (id, email, password_hash, pbkdf2_salt, data_key_enc, recovery_enc, created_at)
    VALUES ('user-1', 'u@t.com', 'h', 's', 'e', 'e', 1)`).run()
  db.prepare(`INSERT INTO accounts (id, provider, email, token_enc, created_at, user_id)
    VALUES ('acc-1', 'gmail', 'a@t.com', 'e', 1, 'user-1')`).run()
}

function seedIndexRow(db: Database.Database, overrides: Record<string, any> = {}) {
  const defaults = {
    email_id: 'uuid-1', account_id: 'acc-1', provider_message_id: 'msg-1',
    sender_email: 'sender@example.com', sender_name: 'Sender',
    subject_preview_enc: encrypt('Test Subject', TEST_DATA_KEY),
    snippet_preview_enc: encrypt('Test snippet', TEST_DATA_KEY),
    received_at: 1_700_000_000_000,
    folder: 'inbox', tab: 'primary',
    is_read: 0, is_important: 0, has_full_body: 0, sync_state: 'partial',
  }
  const row = { ...defaults, ...overrides }
  db.prepare(`INSERT INTO inbox_index
    (email_id, account_id, provider_message_id, sender_email, sender_name,
     subject_preview_enc, snippet_preview_enc, received_at, folder, tab,
     is_read, is_important, has_full_body, sync_state)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.email_id, row.account_id, row.provider_message_id, row.sender_email,
    row.sender_name, row.subject_preview_enc, row.snippet_preview_enc,
    row.received_at, row.folder, row.tab, row.is_read, row.is_important,
    row.has_full_body, row.sync_state
  )
}

describe('GET /api/emails/index — cursor pagination', () => {
  beforeEach(() => {
    testDb = makeTestDb()
    seedPrerequisites(testDb)
  })
  afterEach(() => testDb.close())

  it('returns 200 with emails array and decrypted subject', async () => {
    seedIndexRow(testDb)
    const app = await makeApp()
    const res = await request(app).get('/api/emails/index?accountId=acc-1&folder=inbox&tab=primary')
    expect(res.status).toBe(200)
    expect(res.body.emails).toHaveLength(1)
    expect(res.body.emails[0].subject).toBe('Test Subject')
    expect(res.body.emails[0].snippet).toBe('Test snippet')
    expect(res.body.emails[0].subject_preview_enc).toBeUndefined()
  })

  it('returns 404 for account not belonging to user', async () => {
    const app = await makeApp()
    const res = await request(app).get('/api/emails/index?accountId=other-acc&folder=inbox&tab=primary')
    expect(res.status).toBe(404)
  })

  it('returns next_cursor when results equal limit', async () => {
    for (let i = 0; i < 3; i++) {
      seedIndexRow(testDb, {
        email_id: `uuid-${i}`, provider_message_id: `msg-${i}`,
        received_at: 1_700_000_000_000 - i * 1000,
      })
    }
    const app = await makeApp()
    const res = await request(app).get('/api/emails/index?accountId=acc-1&folder=inbox&tab=primary&limit=2')
    expect(res.status).toBe(200)
    expect(res.body.emails).toHaveLength(2)
    expect(res.body.next_cursor).not.toBeNull()
    expect(res.body.next_cursor).toHaveProperty('before_ts')
    expect(res.body.next_cursor).toHaveProperty('before_id')
  })

  it('returns next_cursor=null when results are fewer than limit', async () => {
    seedIndexRow(testDb)
    const app = await makeApp()
    const res = await request(app).get('/api/emails/index?accountId=acc-1&folder=inbox&tab=primary&limit=50')
    expect(res.status).toBe(200)
    expect(res.body.next_cursor).toBeNull()
  })

  it('cursor pagination returns correct next page without duplicates', async () => {
    for (let i = 0; i < 5; i++) {
      seedIndexRow(testDb, {
        email_id: `uuid-${i}`, provider_message_id: `msg-${i}`,
        received_at: 1_700_000_000_000 - i * 1000,
      })
    }
    const app = await makeApp()

    // Page 1
    const page1 = await request(app).get('/api/emails/index?accountId=acc-1&folder=inbox&tab=primary&limit=3')
    expect(page1.body.emails).toHaveLength(3)
    const { before_ts, before_id } = page1.body.next_cursor

    // Page 2
    const page2 = await request(app).get(
      `/api/emails/index?accountId=acc-1&folder=inbox&tab=primary&limit=3&before_ts=${before_ts}&before_id=${before_id}`
    )
    expect(page2.body.emails).toHaveLength(2)
    expect(page2.body.next_cursor).toBeNull()

    // No overlap
    const page1Ids = page1.body.emails.map((e: any) => e.email_id)
    const page2Ids = page2.body.emails.map((e: any) => e.email_id)
    const overlap = page1Ids.filter((id: string) => page2Ids.includes(id))
    expect(overlap).toHaveLength(0)
  })

  it('excludes snoozed emails', async () => {
    seedIndexRow(testDb, { snoozed_until: Date.now() + 100_000 })
    const app = await makeApp()
    const res = await request(app).get('/api/emails/index?accountId=acc-1&folder=inbox&tab=primary')
    expect(res.body.emails).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run test — expect FAIL**

```bash
npx vitest run tests/emails-index-route.test.ts --reporter=verbose
```
Expected: FAIL — 404 on GET /api/emails/index

- [ ] **Step 3: Add GET /index route to `src/routes/emails.ts`**

Find the line `emailsRouter.get('/:id', ...)` (around line 224). Add the following **immediately before** it:

```typescript
// ── GET /api/emails/index — cursor-based inbox (new progressive sync UI) ──────
// Uses inbox_index table with idx_inbox_hot partial index for fast reads.
// NO OFFSET — cursor is { before_ts, before_id } from the last row of previous page.
// NO JOIN in the hot query path — accountId is validated first, then passed directly.
// Does NOT replace GET /api/emails which uses the legacy emails table.

const indexListQuery = z.object({
  accountId: z.string(),   // required — validated for ownership before hot query
  folder:    z.string().default('inbox'),
  tab:       z.string().default('primary'),
  limit:     z.coerce.number().min(1).max(100).default(50),
  before_ts: z.coerce.number().optional(),
  before_id: z.string().optional(),
})

emailsRouter.get('/index', (req: Request, res: Response) => {
  const parsed = indexListQuery.safeParse(req.query)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })

  const { accountId, folder, tab, limit, before_ts, before_id } = parsed.data
  const user = (req as any).user
  const db = getDb()

  // One-time ownership check — keeps the hot query JOIN-free
  const account = db.prepare(
    'SELECT id FROM accounts WHERE id = ? AND user_id = ?'
  ).get(accountId, user.id)
  if (!account) return res.status(404).json({ error: 'Account not found' })

  // Hot path — single-table scan, no JOIN, served by idx_inbox_hot partial index
  const hasCursor = before_ts !== undefined && before_id !== undefined
  const rows: any[] = hasCursor
    ? db.prepare(`
        SELECT * FROM inbox_index
        WHERE account_id = ?
          AND folder = ?
          AND tab = ?
          AND snoozed_until IS NULL
          AND (received_at, email_id) < (?, ?)
        ORDER BY received_at DESC, email_id DESC
        LIMIT ?
      `).all(accountId, folder, tab, before_ts, before_id, limit)
    : db.prepare(`
        SELECT * FROM inbox_index
        WHERE account_id = ?
          AND folder = ?
          AND tab = ?
          AND snoozed_until IS NULL
        ORDER BY received_at DESC, email_id DESC
        LIMIT ?
      `).all(accountId, folder, tab, limit)

  try {
    const emails = rows.map(r => ({
      ...r,
      subject: decrypt(r.subject_preview_enc, user.dataKey),
      snippet: r.snippet_preview_enc ? decrypt(r.snippet_preview_enc, user.dataKey) : null,
      subject_preview_enc: undefined,
      snippet_preview_enc: undefined,
    }))

    const next_cursor = rows.length === limit
      ? { before_ts: rows[rows.length - 1].received_at, before_id: rows[rows.length - 1].email_id }
      : null

    return res.json({ emails, next_cursor })
  } catch {
    return res.status(500).json({ error: 'Failed to decrypt index data' })
  }
})
```

- [ ] **Step 4: Run test — expect PASS**

```bash
npx vitest run tests/emails-index-route.test.ts --reporter=verbose
```

- [ ] **Step 5: Verify existing email routes still work (no regression)**

```bash
npx vitest run --reporter=verbose
```
Expected: all tests PASS

- [ ] **Step 6: Commit**

```bash
git add inboxmy-backend/src/routes/emails.ts inboxmy-backend/tests/emails-index-route.test.ts
git commit -m "feat(routes): add GET /api/emails/index — cursor-based inbox from inbox_index"
```

---

## Task 10: GET /api/emails/index/:id — On-Demand Body Fetch (Phase 3)

**Files:**
- Modify: `inboxmy-backend/src/routes/emails.ts`
- Modify: `inboxmy-backend/tests/emails-index-route.test.ts` (add body fetch tests)

- [ ] **Step 1: Add body fetch tests to `tests/emails-index-route.test.ts`**

Append a new describe block:

```typescript
// ── Top-level mocks for body fetch tests ────────────────────────────────────
// All vi.mock calls MUST be at file top-level — Vitest hoists them automatically.
// Do NOT place vi.mock inside describe() or it() — the mock will not take effect.
vi.mock('../src/email/gmail-client', () => ({
  fetchNewEmails: vi.fn(),
  fetchEmailsMetadata: vi.fn(),
}))
vi.mock('../src/email/outlook-client', () => ({
  fetchNewEmails: vi.fn(),
  fetchEmailsMetadata: vi.fn(),
}))
vi.mock('../src/auth/gmail', () => ({
  getAuthedClient: vi.fn().mockResolvedValue({}),
}))
vi.mock('googleapis', () => ({
  google: {
    gmail: () => ({
      users: {
        messages: {
          get: vi.fn().mockResolvedValue({
            data: {
              id: 'msg-1',
              threadId: 'thread-1',
              labelIds: [],
              snippet: 'snippet',
              internalDate: '1700000000000',
              sizeEstimate: 1024,
              payload: {
                headers: [
                  { name: 'From', value: 'sender@example.com' },
                  { name: 'Subject', value: 'Test Subject' },
                ],
                mimeType: 'text/html',
                body: { data: Buffer.from('<p>Hello body</p>').toString('base64') },
                parts: [],
              },
            },
          }),
        },
      },
    }),
  },
}))

describe('GET /api/emails/index/:id — on-demand body fetch', () => {
  beforeEach(() => {
    testDb = makeTestDb()
    seedPrerequisites(testDb)
    seedIndexRow(testDb, { email_id: 'uuid-1', provider_message_id: 'msg-1' })
  })
  afterEach(() => testDb.close())

  it('returns 404 for unknown email_id', async () => {
    const app = await makeApp()
    const res = await request(app).get('/api/emails/index/nonexistent-uuid')
    expect(res.status).toBe(404)
  })

  it('fetches and caches body when has_full_body=0', async () => {
    const app = await makeApp()
    const res = await request(app).get('/api/emails/index/uuid-1')
    expect(res.status).toBe(200)
    expect(res.body).toHaveProperty('email_id', 'uuid-1')
    expect(res.body.body).toBe('<p>Hello body</p>')

    // Verify DB state: email_body row inserted and has_full_body flag set
    const bodyRow = testDb.prepare('SELECT * FROM email_body WHERE email_id = ?').get('uuid-1') as any
    expect(bodyRow).toBeTruthy()
    const indexRow = testDb.prepare('SELECT has_full_body FROM inbox_index WHERE email_id = ?').get('uuid-1') as any
    expect(indexRow.has_full_body).toBe(1)
  })

  it('serves body from email_body cache when has_full_body=1', async () => {
    // Pre-populate email_body
    testDb.prepare(`INSERT INTO email_body (email_id, body_enc, body_format, fetched_at)
      VALUES ('uuid-1', ?, 'html', ?)`)
      .run(encrypt('<p>Cached body</p>', TEST_DATA_KEY), Date.now())
    testDb.prepare(`UPDATE inbox_index SET has_full_body=1 WHERE email_id='uuid-1'`).run()

    const app = await makeApp()
    const res = await request(app).get('/api/emails/index/uuid-1')
    expect(res.status).toBe(200)
    expect(res.body.body).toBe('<p>Cached body</p>')
    expect(res.body.body_format).toBe('html')
  })

  it('is idempotent — second fetch returns same body', async () => {
    testDb.prepare(`INSERT INTO email_body (email_id, body_enc, body_format, fetched_at)
      VALUES ('uuid-1', ?, 'text', ?)`)
      .run(encrypt('Plain body', TEST_DATA_KEY), Date.now())
    testDb.prepare(`UPDATE inbox_index SET has_full_body=1 WHERE email_id='uuid-1'`).run()

    const app = await makeApp()
    const res1 = await request(app).get('/api/emails/index/uuid-1')
    const res2 = await request(app).get('/api/emails/index/uuid-1')
    expect(res1.body.body).toBe(res2.body.body)
  })
})
```

- [ ] **Step 2: Run test — expect FAIL (route doesn't exist)**

```bash
npx vitest run tests/emails-index-route.test.ts --reporter=verbose
```
Expected: body fetch describe block FAILs with 404

- [ ] **Step 3: Add GET /index/:id route to `src/routes/emails.ts`**

Add **immediately after** the GET /index route and **before** the existing GET /:id handler:

```typescript
// ── GET /api/emails/index/:id — on-demand body fetch (Phase 3) ───────────────
// 1. If email_body row exists → return cached decrypted body immediately
// 2. If not → fetch full email from provider, encrypt, store in email_body,
//    mark inbox_index.has_full_body=1, return body
// INSERT uses ON CONFLICT DO NOTHING (body is immutable once stored).
// INSERT + UPDATE wrapped in a transaction to keep has_full_body consistent.

emailsRouter.get('/index/:id', async (req: Request, res: Response) => {
  const user = (req as any).user
  const db = getDb()

  // Verify email exists and belongs to this user
  const indexRow = db.prepare(`
    SELECT ii.*, a.provider, a.id as account_id
    FROM inbox_index ii
    JOIN accounts a ON a.id = ii.account_id
    WHERE ii.email_id = ? AND a.user_id = ?
  `).get(req.params.id, user.id) as any

  if (!indexRow) return res.status(404).json({ error: 'Email not found' })

  // ── Step 1: Check cache ────────────────────────────────────────────────────
  const cached = db.prepare('SELECT * FROM email_body WHERE email_id = ?').get(req.params.id) as any
  if (cached) {
    return res.json({
      email_id: indexRow.email_id,
      account_id: indexRow.account_id,
      subject: decrypt(indexRow.subject_preview_enc, user.dataKey),
      sender_email: indexRow.sender_email,
      sender_name: indexRow.sender_name,
      received_at: indexRow.received_at,
      folder: indexRow.folder,
      tab: indexRow.tab,
      is_read: indexRow.is_read,
      is_important: indexRow.is_important,
      body: decrypt(cached.body_enc, user.dataKey),
      body_format: cached.body_format,
      has_full_body: 1,
      sync_state: 'complete',
    })
  }

  // ── Step 2: Fetch from provider ────────────────────────────────────────────
  try {
    let bodyHtml: string | null = null
    let bodyText: string | null = null
    let rawHeaders: string | null = null

    if (indexRow.provider === 'gmail') {
      const { getAuthedClient } = await import('../auth/gmail')
      const { google } = await import('googleapis')
      const auth = await getAuthedClient(indexRow.account_id)
      const gmail = google.gmail({ version: 'v1', auth })
      const full = await gmail.users.messages.get({
        userId: 'me', id: indexRow.provider_message_id, format: 'full',
      })
      // Extract body
      function extractBody(payload: any): { html: string | null; text: string | null } {
        let html: string | null = null
        let text: string | null = null
        function walk(part: any) {
          if (!part) return
          if (part.mimeType === 'text/html' && part.body?.data)
            html = Buffer.from(part.body.data, 'base64').toString('utf-8')
          else if (part.mimeType === 'text/plain' && part.body?.data)
            text = Buffer.from(part.body.data, 'base64').toString('utf-8')
          for (const sub of part.parts ?? []) walk(sub)
        }
        walk(payload)
        return { html, text }
      }
      const extracted = extractBody(full.data.payload)
      bodyHtml = extracted.html
      bodyText = extracted.text
      rawHeaders = JSON.stringify(full.data.payload?.headers ?? [])
    } else {
      // Outlook
      const { getAccessToken } = await import('../auth/outlook')
      const token = await getAccessToken(indexRow.account_id)
      const msgRes = await fetch(
        `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(indexRow.provider_message_id)}?$select=body,internetMessageHeaders`,
        { headers: { Authorization: `Bearer ${token}` } }
      )
      if (!msgRes.ok) throw new Error(`Outlook body fetch failed: ${msgRes.status}`)
      const msg = await msgRes.json() as any
      bodyHtml = msg.body?.contentType === 'html' ? msg.body.content : null
      bodyText = msg.body?.contentType === 'text' ? msg.body.content : null
      rawHeaders = JSON.stringify(msg.internetMessageHeaders ?? [])
    }

    const body = bodyHtml ?? bodyText ?? ''
    const bodyFormat = bodyHtml ? 'html' : 'text'
    const bodyEnc = encrypt(body, user.dataKey)
    const headersEnc = rawHeaders ? encrypt(rawHeaders, user.dataKey) : null

    // ── Step 3: Store atomically ───────────────────────────────────────────
    const storeBody = db.transaction(() => {
      db.prepare(`
        INSERT INTO email_body (email_id, body_enc, body_format, raw_headers_enc, fetched_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(email_id) DO NOTHING
      `).run(req.params.id, bodyEnc, bodyFormat, headersEnc, Date.now())

      db.prepare(`
        UPDATE inbox_index SET has_full_body = 1, sync_state = 'complete'
        WHERE email_id = ?
      `).run(req.params.id)
    })
    storeBody()

    return res.json({
      email_id: indexRow.email_id,
      account_id: indexRow.account_id,
      subject: decrypt(indexRow.subject_preview_enc, user.dataKey),
      sender_email: indexRow.sender_email,
      sender_name: indexRow.sender_name,
      received_at: indexRow.received_at,
      folder: indexRow.folder,
      tab: indexRow.tab,
      is_read: indexRow.is_read,
      is_important: indexRow.is_important,
      body,
      body_format: bodyFormat,
      has_full_body: 1,
      sync_state: 'complete',
    })
  } catch (err: any) {
    console.error(`[index/:id] Body fetch failed for ${req.params.id}:`, err.message)
    return res.status(502).json({ error: 'Failed to fetch email body' })
  }
})
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
npx vitest run tests/emails-index-route.test.ts --reporter=verbose
```

- [ ] **Step 5: Run full test suite**

```bash
npx vitest run --reporter=verbose
```
Expected: all tests PASS

- [ ] **Step 6: TypeScript compile check**

```bash
npx tsc --noEmit
```
Expected: no errors

- [ ] **Step 7: Commit**

```bash
git add inboxmy-backend/src/routes/emails.ts inboxmy-backend/tests/emails-index-route.test.ts
git commit -m "feat(routes): add GET /api/emails/index/:id — on-demand body fetch with email_body cache"
```

---

## Final Verification

- [ ] **Run full test suite one last time**

```bash
cd inboxmy-backend && npx vitest run --reporter=verbose
```
Expected: all tests PASS, no skips

- [ ] **TypeScript build check**

```bash
npx tsc --noEmit
```
Expected: no errors

- [ ] **Verify migration version is correct (should be 11)**

```bash
node -e "
const Database = require('better-sqlite3');
const db = new Database(':memory:');
require('./dist/db/migrations').runMigrations(db);
const v = db.prepare('SELECT MAX(version) as v FROM schema_version').get();
console.log('Schema version:', v.v);
" 2>/dev/null || echo "Run 'npm run build' first, then re-run"
```

- [ ] **Final commit if any cleanup was done**

```bash
git add -p
git commit -m "chore: progressive sync implementation complete — Migration 10+11, inbox_index, backfill, cursor pagination"
```

---

## What Was NOT Implemented (Future Tasks)

| Item | Status |
|------|--------|
| Gmail metadata-only fetch replacing full fetch in Phase 1 | `fetchEmailsMetadata` added — wire it into sync-engine as a follow-up for full speed benefit |
| Outlook delta token (fast_sync_cursor) | Column ready; implementation deferred |
| Attachment caching with 6h TTL in `attachments` table | Schema ready (Migration 11); caching logic deferred |
| Stale Outlook row cleanup on folder move | Known limitation, deferred |
| Full-text search on inbox_index | Separate task |
