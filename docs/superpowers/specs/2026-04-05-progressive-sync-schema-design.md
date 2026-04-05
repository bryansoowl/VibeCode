# Progressive Sync Schema Design
**Date:** 2026-04-05  
**Status:** Approved for implementation  
**Scope:** Database schema + sync architecture only (no UI, no auth, no encryption changes)

---

## 1. Problem

The current system performs a full sync on every trigger: it fetches up to 500 emails with full bodies, encrypts and stores everything in the `emails` table before the UI can render anything. This causes slow initial load, heavy upfront processing, and poor scalability for large mailboxes.

---

## 2. Goal

Introduce a 2-layer progressive sync architecture:

- **`inbox_index`** — lightweight metadata table powering instant inbox rendering
- **`email_body`** — lazy-loaded encrypted full content, fetched only on demand

With:
- Cursor-based pagination (no OFFSET anywhere in the new system)
- Idempotent sync operations across Gmail and Outlook
- Zero changes to existing `emails` table or any auth/encryption/UI code

---

## 3. Approach

**Additive only.** New tables are added alongside the existing `emails` table. Existing routes, sync logic, and the `emails` table remain untouched for backward compatibility. New routes and sync behaviour are introduced incrementally.

Two staged migrations:
- **Migration 10** — hot path tables: `inbox_index`, `sync_state`, `sync_backfill_cursors`
- **Migration 11** — heavy data tables: `email_body`, `attachments`

---

## 4. Schema

### Migration 10 — Hot Path Tables

```sql
CREATE TABLE inbox_index (
  email_id             TEXT PRIMARY KEY,        -- internal UUID (NOT provider ID)
  account_id           TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  provider_message_id  TEXT NOT NULL,           -- Gmail msg ID / Outlook msg ID
  thread_id            TEXT,
  sender_email         TEXT NOT NULL,
  sender_name          TEXT,
  subject_preview_enc  TEXT NOT NULL,           -- encrypted, same dataKey as emails.subject_enc
  snippet_preview_enc  TEXT,                    -- encrypted
  received_at          INTEGER NOT NULL,        -- unix ms
  folder               TEXT NOT NULL DEFAULT 'inbox',
  tab                  TEXT NOT NULL DEFAULT 'primary',
  is_read              INTEGER NOT NULL DEFAULT 0,
  is_important         INTEGER NOT NULL DEFAULT 0,
  has_full_body        INTEGER NOT NULL DEFAULT 0,
  sync_state           TEXT NOT NULL DEFAULT 'partial',  -- 'partial' | 'complete'
  snoozed_until        INTEGER,
  category             TEXT,
  UNIQUE(account_id, provider_message_id)       -- deduplication constraint
);

-- Partial index for hot inbox read path (non-snoozed emails only)
CREATE INDEX idx_inbox_hot
  ON inbox_index(account_id, folder, tab, received_at DESC, email_id DESC)
  WHERE snoozed_until IS NULL;

-- Full index for backfill pagination
CREATE INDEX idx_inbox_backfill
  ON inbox_index(account_id, folder, received_at DESC, email_id DESC);

-- Unread count aggregation
-- Column order serves: account_id + folder + is_read=0 + snoozed_until IS NULL queries.
-- If per-tab badge counts are needed in future, reorder to (account_id, folder, tab, is_read, snoozed_until).
CREATE INDEX idx_inbox_unread
  ON inbox_index(account_id, folder, is_read, tab, snoozed_until);

CREATE TABLE sync_state (
  account_id           TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  last_fast_sync_at    INTEGER,
  fast_sync_cursor     TEXT,   -- provider cursor: Gmail historyId / Outlook deltaToken (future)
                               -- CANONICAL for new sync path; accounts.gmail_history_id is legacy
  last_backfill_at     INTEGER,
  backfill_complete    INTEGER NOT NULL DEFAULT 0
);

-- Per-folder backfill position tracking
CREATE TABLE sync_backfill_cursors (
  account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  folder      TEXT NOT NULL,
  cursor      TEXT,            -- JSON: { "received_at": number, "email_id": string }
  complete    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, folder)
);
```

### Migration 11 — Heavy Data Tables

```sql
CREATE TABLE email_body (
  email_id         TEXT PRIMARY KEY REFERENCES inbox_index(email_id) ON DELETE CASCADE,
  body_enc         TEXT NOT NULL,               -- encrypted body content (never NULL; insert only when body is ready)
  body_format      TEXT NOT NULL DEFAULT 'text',  -- 'html' | 'text'
  raw_headers_enc  TEXT,                        -- encrypted raw headers
  fetched_at       INTEGER NOT NULL
);

CREATE TABLE attachments (
  attachment_id  TEXT PRIMARY KEY,
  email_id       TEXT NOT NULL REFERENCES inbox_index(email_id) ON DELETE CASCADE,
  filename       TEXT NOT NULL,
  mime_type      TEXT NOT NULL DEFAULT 'application/octet-stream',
  size_bytes     INTEGER,
  remote_ref     TEXT,         -- provider attachment ID (Gmail attachmentId / Outlook att ID)
                               -- WARNING: Gmail remote_ref may expire; validate via listed_at
  download_state TEXT NOT NULL DEFAULT 'not_downloaded',  -- 'not_downloaded' | 'downloaded'
  local_path     TEXT,
  listed_at      INTEGER NOT NULL
);

CREATE INDEX idx_attachments_email ON attachments(email_id);
```

---

## 5. Sync Flow

### Phase 1 — Fast Sync (`POST /api/sync/trigger`, updated)

**Goal:** Populate `inbox_index` with latest ~100 emails immediately, metadata only.

```
1. Read sync_state.fast_sync_cursor for account
2. If cursor exists → incremental provider fetch (Gmail: historyId, Outlook: date-based)
   If no cursor   → full metadata fetch, newest 100 emails
3. Provider calls:
   Gmail:   messages.list + messages.get(format='metadata')
   Outlook: GET /messages?$select=id,subject,from,receivedDateTime,isRead,...
4. For each email:
   a. Extract metadata only — DO NOT fetch body
   b. Run spam scorer on headers/sender only
   c. Generate internal UUID for email_id
   d. INSERT INTO inbox_index ON CONFLICT(account_id, provider_message_id) DO NOTHING
   e. INSERT INTO emails (legacy path, unchanged — independent write, failure here does NOT
      roll back the inbox_index insert; these are intentionally isolated writes)
5. Update sync_state.fast_sync_cursor = new provider cursor
   Gmail: capture fresh historyId via getProfile() after full sync fallback
6. For each folder in ['inbox', 'sent', 'spam']:
   INSERT INTO sync_backfill_cursors (account_id, folder, complete)
   VALUES (?, ?, 0)
   ON CONFLICT(account_id, folder) DO NOTHING   -- idempotent; never overwrite existing cursor
7. Return — UI renders from inbox_index immediately
```

**Provider notes:**
- Gmail: if historyId returns 404 (expired after ~7 days), clear `fast_sync_cursor` and fall back to full metadata fetch. Capture new historyId at end of fallback and store.
- Outlook: no delta token yet — date-based fetch only. `fast_sync_cursor` remains NULL for Outlook accounts. Document as known limitation.

### Phase 2 — Background Backfill (`POST /api/sync/backfill`, new)

**Goal:** Fill older inbox_index rows progressively without blocking UI.

```
1. For each folder in ['inbox', 'sent', 'spam']:
   a. Read sync_backfill_cursors WHERE account_id=? AND folder=?
   b. If complete=1 → skip
   c. Parse cursor JSON: { received_at, email_id }  ← BACKFILL CURSOR FORMAT
      (distinct from the route's next_cursor format — do NOT conflate)
   d. Query provider for 25 emails older than cursor position (metadata only)
   e. INSERT INTO inbox_index ON CONFLICT(account_id, provider_message_id) DO NOTHING
      for each row in the batch; collect email_ids where result.changes > 0.
      Call this set: inserted_ids
   f. Derive new cursor from inbox_index scoped to inserted_ids only:
        SELECT received_at, email_id FROM inbox_index
        WHERE email_id IN (<inserted_ids>)
        ORDER BY received_at ASC, email_id ASC   -- ASC to find batch-oldest row
        LIMIT 1
      Store as: { "received_at": <value>, "email_id": <value> }
      IMPORTANT: scope query to inserted_ids — do NOT query globally for the folder's
      oldest row, or the cursor will jump to the start of already-synced history on
      every call after the first, causing the backfill to stall indefinitely.
      If inserted_ids is empty (all conflicted), keep the existing cursor unchanged.
   g. If batch size < 25 → set complete=1
      Note: on a small mailbox the very first batch may return < 25 rows, immediately
      marking the folder complete. This is correct — the mailbox is fully backfilled.
2. Update sync_state.last_backfill_at
3. Return { folder, added, complete } per folder
```

**Ordering rule:** The hot read path index uses `(received_at DESC, email_id DESC)` ordering. Cursor derivation in step 2g uses `ASC` to locate the oldest (minimum) row in the inserted batch — this is the correct direction for finding the next page boundary.

**Cursor format note:** `sync_backfill_cursors.cursor` uses `{ received_at, email_id }` field names. The route's `next_cursor` response uses `{ before_ts, before_id }` field names. These are two separate cursor formats for two separate systems — never store a route cursor in `sync_backfill_cursors` or vice versa.

Scheduled by Electron on a low-priority interval (e.g. every 5 min, idle-only).

### Phase 3 — On-Demand Body Fetch (`GET /api/emails/index/:id`, new)

**Goal:** Fetch and cache full email body when user opens an email.

```
1. SELECT * FROM email_body WHERE email_id = ?
2. If row exists:
   → decrypt body_enc and return immediately
3. If not exists:
   a. Fetch full email from provider (Gmail: format='full', Outlook: $select=body,internetMessageHeaders)
   b. Encrypt body_enc and raw_headers_enc using user's dataKey
   c. Determine body_format: 'html' if bodyHtml present, else 'text'
   d. TRANSACTION {
        INSERT INTO email_body (...) ON CONFLICT(email_id) DO NOTHING
        UPDATE inbox_index SET has_full_body=1, sync_state='complete' WHERE email_id=?
      }
      -- DO NOT use DO UPDATE: body is immutable once stored
      -- Transaction ensures has_full_body flag is always consistent with email_body row
4. Decrypt and return body to client
```

**Concurrent request safety:** If two requests race through step 3, both fetch the body from the provider. Both then execute the transaction: one INSERT wins (stores the body), the other INSERT is a DO NOTHING no-op. Both transactions still execute the UPDATE `has_full_body=1` — this is safe because `UPDATE` is idempotent (setting 1→1 is harmless). Both requests decrypt their in-memory copy of the body and return it to the user. No placeholder rows, no corruption, no null body.

### Phase 4 — Lazy Attachment Load (unchanged before Migration 11)

**Before Migration 11:** Live API fetch on every request (current behaviour, unchanged).

**After Migration 11:**
```
1. SELECT * FROM attachments WHERE email_id = ?
2. If rows exist AND listed_at > (now - 6 hours) → return cached list
   (6-hour TTL is application-level config, not enforced by schema)
3. Else → fetch from provider API, INSERT OR REPLACE into attachments, return
   NOTE: Gmail remote_ref may expire — always validate listed_at staleness before using
4. Download: only on user request
   → fetch attachment content from provider
   → set download_state='downloaded', local_path=?
```

---

## 6. New Route: Cursor-Based Inbox

**`GET /api/emails/index`** — new route, does not replace existing `GET /api/emails`.

Query params: `folder`, `tab`, `limit` (default 50, max 100), `before_ts` (unix ms), `before_id` (email_id UUID)

```sql
-- First page (no cursor):
SELECT * FROM inbox_index
WHERE account_id = ?
  AND folder = ?
  AND tab = ?
  AND snoozed_until IS NULL
ORDER BY received_at DESC, email_id DESC
LIMIT ?

-- Subsequent pages (with cursor):
-- params bind order: account_id, folder, tab, before_ts, before_id, limit
-- before_ts = next_cursor.before_ts, before_id = next_cursor.before_id
SELECT * FROM inbox_index
WHERE account_id = ?
  AND folder = ?
  AND tab = ?
  AND snoozed_until IS NULL
  AND (received_at, email_id) < (?, ?)   -- SQLite row value comparison (v3.15+)
                                         -- better-sqlite3 bundles SQLite >= 3.31, safe to use
ORDER BY received_at DESC, email_id DESC
LIMIT ?
```

Use two separate prepared statements (first page / next page). Both use `idx_inbox_hot` partial index.

Response:
```json
{
  "emails": [...],
  "next_cursor": { "before_ts": 1712345678000, "before_id": "uuid-of-last-row" } 
}
```

`next_cursor` is `null` when fewer than `limit` rows are returned.

**Rules:**
- NO OFFSET anywhere
- NO JOIN in hot query path — filter on `inbox_index.account_id` directly
- All fields decrypted server-side before returning (subject_preview_enc, snippet_preview_enc)

---

## 7. Design Rules Summary

| Rule | Rationale |
|------|-----------|
| `email_id` is internal UUID | Decouples internal identity from provider IDs which can change (Outlook on move) |
| `UNIQUE(account_id, provider_message_id)` | Single deduplication key — prevents cross-phase and cross-sync duplicates |
| `ON CONFLICT(account_id, provider_message_id) DO NOTHING` | Idempotent insert — safe for retry at any phase |
| Partial index `WHERE snoozed_until IS NULL` | Excludes snoozed rows from hot path index — inbox renders from index only |
| Phase 3 INSERT + UPDATE in transaction | Guarantees `has_full_body` flag is always consistent with `email_body` row existence |
| `body` is immutable once stored (`DO NOTHING`, not `DO UPDATE`) | Prevents re-encryption races from overwriting valid body with potentially different result |
| `fast_sync_cursor` ≠ `backfill_cursor` | Provider state token vs pagination cursor — never mixed |
| `sync_backfill_cursors` is per (account, folder) | Supports multi-folder backfill without cursor collision |

---

## 8. Provider Edge Cases

| Provider | Edge Case | Handling |
|----------|-----------|----------|
| Gmail | historyId expires (~7 days inactivity) | Catch 404 → clear cursor → full metadata fetch → capture new historyId |
| Gmail | `format='metadata'` includes snippet | Confirmed — `msg.snippet` present in metadata format |
| Gmail | Message IDs stable on folder move | No action needed |
| Outlook | No delta token support yet | Date-based fetch only; `fast_sync_cursor` stays NULL; documented limitation |
| Outlook | No tab taxonomy | All emails default to `tab='primary'` |
| Outlook | Message ID changes on folder move | **Known UX regression:** stale row remains visible in inbox with incorrect folder until a future cleanup pass. New ID inserts cleanly via `DO NOTHING`. Deferred to known limitations. |

---

## 9. Files to Change

| File | Change |
|------|--------|
| `src/db/migrations.ts` | Add Migration 10 (inbox_index, sync_state, sync_backfill_cursors) and Migration 11 (email_body, attachments) |
| `src/email/sync-engine.ts` | Phase 1: write to inbox_index; read/write sync_state; preserve legacy emails write |
| `src/routes/emails.ts` | Add `GET /index` and `GET /index/:id` sub-routes |
| `src/routes/sync.ts` | Add `POST /backfill` endpoint |
| `src/email/gmail-client.ts` | Add `format='metadata'` fetch path alongside existing full fetch |
| `src/email/outlook-client.ts` | Add metadata-only select path |
| `src/email/attachments.ts` | After M11: cache listing in `attachments` table with 6h TTL |

**Not touched:** `src/crypto.ts`, `src/auth/*`, `src/middleware/*`, `src/db/index.ts`, existing `emails` table, existing `GET /api/emails` route.

**Note on `src/db/schema.sql`:** This file is a legacy DDL snapshot and is not the canonical source of truth — `src/db/migrations.ts` is canonical. `schema.sql` is intentionally excluded from this change to avoid divergence with the migration runner. It does not need to be kept in sync.

---

## 10. Known Limitations (Out of Scope)

- **Outlook delta token sync** — future work; `fast_sync_cursor` column is ready to receive it
- **Outlook stale rows on folder move** — when an Outlook email is moved between folders, its message ID changes. The old `inbox_index` row remains with the wrong folder label and will appear as a ghost email in that folder until a cleanup pass runs. This is a known UX regression, intentionally deferred.
- **Outlook tab taxonomy** — Outlook has no equivalent to Gmail's Primary/Promotions/Social tabs. All Outlook emails are assigned `tab='primary'`. Tab filtering in the inbox UI should be hidden or disabled for Outlook accounts.
- **Full-text search on `inbox_index`** — separate task, not part of this migration
- **Attachment download to local disk** — schema is ready (`local_path`, `download_state`); download logic is future work
