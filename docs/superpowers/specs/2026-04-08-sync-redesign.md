# Email Sync Redesign — Design Spec
**Date:** 2026-04-08  
**Status:** Approved

---

## Problem

The current sync system has three weaknesses:

1. **Backfill is idle-only.** `runBackfillTick` skips entirely when the app window is focused (`isFocused()` gate), meaning older emails never arrive while the user is actively using the app.
2. **Fixed batch size of 25.** Backfill progress is slow and makes no use of available network/CPU headroom.
3. **Sequential account processing.** `syncAllAccounts` iterates accounts one-at-a-time. With 3 accounts, the second and third wait for the first to finish.

Additionally, there is no explicit burst on first account connection — the inbox is empty until the next 60s fast-sync tick fires.

---

## Goals

- Inbox shows recent emails **within seconds** of account connection (on each app launch and on first connect).
- Backfill runs **continuously** (no idle gate), throttled to avoid spikes.
- Batch sizes **adapt** to network/device performance.
- Multiple accounts sync **in parallel** (max 3 concurrent).
- All sync logic is **isolated** from `electron/main.js` into a testable module.

---

## Non-goals

- Real-time push (WebSockets / Gmail push notifications) — not in scope.
- Body pre-fetching during sync — bodies remain lazy-loaded on demand.
- Redis / external queue — in-memory only.

---

## Architecture

### New file: `electron/sync-manager.js`

Owns all scheduling. `main.js` becomes thin: instantiate `SyncManager`, call `.start()`, call `.stop()` on quit.

```
SyncManager
├── jobQueue          — min-heap sorted by priority (burst=0, fast=1, backfill=2)
├── activeSlots       — integer counter, ceiling = MAX_CONCURRENCY (3)
├── accountBatchState — Map<accountId, { batchSize, lastDurationMs }>
├── knownAccounts     — Set<accountId> for new-account detection
└── timers            — syncTimer, backfillTimer, accountPollTimer
```

### `electron/main.js` changes

- Remove `runSyncTick`, `runBackfillTick`, their timers, and `backfillRunning` lock.
- Remove `BACKFILL_INTERVAL_MS` constant (interval moves into `SyncManager` as 2min).
- Instantiate `SyncManager(apiRequest, mainWindow, BACKEND_URL)`.
- Wire `app.on('before-quit')` → `syncManager.stop()`.

---

## Job Types

| Type | Priority | Trigger | Interval |
|---|---|---|---|
| `burst` | 0 (highest) | App launch or new account detected | One-shot per launch |
| `fast` | 1 | Timer | Every 60s |
| `backfill` | 2 | Timer | Every 2min |

Jobs are dispatched FIFO within the same priority tier. At most `MAX_CONCURRENCY = 3` jobs run simultaneously.

**Burst behavior on restarts:** `knownAccounts` starts empty on each app launch. Every account therefore gets a burst job at startup, quickly repopulating the inbox. This is intentional — burst is not limited to the first-ever account connection. After the first `GET /api/accounts` poll at launch, all existing accounts receive a burst job; subsequent polls only trigger burst for genuinely new accounts added during the session.

---

## Sync Flows

### 1. Burst Sync

Triggered when an account is not in `knownAccounts` (happens at launch for all accounts, and mid-session for newly connected accounts).

**Electron (account poller — every 30s):**
```
accounts = GET /api/accounts
for each account not in knownAccounts:
  enqueue({ type: 'burst', accountId, priority: 0 })
  knownAccounts.add(accountId)
```

**Backend — new endpoint `POST /api/sync/burst { accountId }`:**
```
// Auth: uses req.user.dataKey for encryption (same pattern as backfill route)

// Inbox-only: uses new fetchBurstMetadata(accountId, limit) which adds a folder/query
// parameter to the existing metadata fetch functions:
//   Gmail:   messages.list({ q: 'in:inbox newer_than:90d', maxResults: limit })
//   Outlook: /me/messages?$filter=receivedDateTime gt {90dAgo}&$top={limit}
//            (Outlook messages.list already scopes to inbox by default)
fetchBurstMetadata(accountId, limit=200)  // new function in gmail-client.ts + outlook-client.ts
// Gmail: messages.list({ q: 'in:inbox newer_than:90d', maxResults: limit })
//        MUST NOT pass includeSpamTrash: true — omitting it keeps spam/trash out of burst results.
// Outlook: /me/messages scopes to inbox by default; no extra filter needed.

for each email:
  INSERT INTO inbox_index (
    ...,
    subject_preview_enc = encrypt(email.subject, req.user.dataKey),
    snippet_preview_enc = encrypt(email.snippet, req.user.dataKey),
    category = null   // no parser run — see Classification Note below
  ) ON CONFLICT(account_id, provider_message_id) DO NOTHING

// Seed backfill cursors (idempotent — same INSERT OR IGNORE as sync-engine.ts lines 171–178)
for folder in ['inbox', 'sent', 'spam']:
  INSERT INTO sync_backfill_cursors (account_id, folder, complete)
  VALUES (accountId, folder, 0)
  ON CONFLICT(account_id, folder) DO NOTHING

return { added }
```

**Classification note:** Burst skips `parseEmail()` and `scoreSpam()`. Emails inserted by burst have `category = null` and retain the folder assigned by the provider (no spam reclassification). The next fast sync tick (within 60s) runs full classification and will update any misclassified rows. This trade-off is acceptable — burst's purpose is fast inbox population, not perfect classification.

**Rate limit note:** Gmail metadata fetch makes N+1 API calls (1 list + 1 per message). 200 emails = ~201 calls. This approaches Gmail's per-user quota limit for large accounts. Implementation should add a 50ms delay between `messages.get` calls during burst, or reduce burst limit to 100 for Gmail if quota errors are observed.

After burst completes, Electron sends `sync-complete` to the renderer so the inbox refreshes.

---

### 2. Fast Sync (unchanged)

Every 60s via existing `POST /api/sync/trigger`.  
Gmail uses History API (incremental, ~2 API calls).  
Outlook uses `sinceMs` filter.  
Writes to both `inbox_index` and `emails`. Runs `parseEmail()` and `scoreSpam()`. No changes needed.

---

### 3. Backfill (continuous, adaptive)

Every 2min (reduced from 5min). **Idle gate removed.**

**Electron:**
```
for each account (via job queue, max 3 concurrent):
  t0 = now()
  batchSize = computeBatchSize(accountId, activeAccountCount)
  POST /api/sync/backfill { accountId, batchSize }
  durationMs = now() - t0
  updateBatchState(accountId, batchSize, durationMs)
  PATCH /api/sync/state/{ accountId } { last_batch_size: batchSize, last_batch_duration_ms: durationMs }
```

**Backend — `POST /api/sync/backfill` change:**  
`BATCH_SIZE` changes from hardcoded `25` to `req.body.batchSize`, clamped server-side to `[50, 200]` as a safety guard. The Electron-side `perAccountMax` calculation is the real ceiling; the backend clamp is only a guard against malformed requests.

**Backend — new endpoint `PATCH /api/sync/state/:accountId { last_batch_size, last_batch_duration_ms }`:**  
Updates the two new columns in `sync_state` so `accountBatchState` survives app restarts. Must verify ownership before writing (`SELECT id FROM accounts WHERE id = ? AND user_id = ?` — same pattern as backfill route line 20). Must use `INSERT … ON CONFLICT DO UPDATE` (not a plain `UPDATE`) because `sync_state` rows may not yet exist for an account before the first fast sync runs:
```sql
INSERT INTO sync_state (account_id, last_batch_size, last_batch_duration_ms)
VALUES (?, ?, ?)
ON CONFLICT(account_id) DO UPDATE SET
  last_batch_size = excluded.last_batch_size,
  last_batch_duration_ms = excluded.last_batch_duration_ms
```

---

## Adaptive Batch Sizing

### Global budget

```
GLOBAL_BATCH_BUDGET = 300
perAccountMax = floor(300 / activeAccountCount)
// 1 account → 300 (capped at 200), 2 → 150, 3 → 100
// perAccountMax is always capped at 200 regardless of account count
```

### Per-account auto-tuning (after each backfill tick)

```
function nextBatchSize(current, lastDurationMs, perAccountMax):
  if lastDurationMs < 3000:  next = current + 25
  elif lastDurationMs > 10000: next = current - 25
  else: next = current
  return clamp(next, min=50, max=min(perAccountMax, 200))
```

Initial batch size for a new account: `100`.  
Floor of `50` matches the current production backfill value (2× the old 25) as a conservative baseline.

### Persistence

On `SyncManager` startup, seed `accountBatchState` from `sync_state`:
```
GET /api/accounts → for each account:
  row = SELECT last_batch_size, last_batch_duration_ms FROM sync_state WHERE account_id = ?
  accountBatchState.set(accountId, { batchSize: row.last_batch_size ?? 100, lastDurationMs: row.last_batch_duration_ms ?? 0 })
```

### CPU backpressure

Dropped from design. `process.cpuUsage()` returns cumulative CPU time (not a percentage) and requires two timed samples to produce a meaningful reading. The overhead of sampling correctly every dispatch cycle outweighs the benefit for an optional feature. The adaptive batch timing already provides implicit backpressure — slow device → long duration → smaller batch.

---

## Concurrency Control

```
class SyncManager:
  enqueue(job):
    jobQueue.push(job)   // min-heap on job.priority
    dispatch()

  dispatch():
    while jobQueue.size > 0 and activeSlots < MAX_CONCURRENCY:
      job = jobQueue.pop()
      activeSlots++
      runJob(job).finally(() => { activeSlots--; dispatch() })

  stop():
    // Fire-and-forget: stop dispatching new jobs, allow activeSlots to drain naturally.
    // Active API calls are not cancelled — they complete and release their slots,
    // but no new jobs are dispatched after stop() is called.
    clearAllTimers()
    jobQueue.clear()
```

No external semaphore library needed — a simple counter is correct for single-threaded Node.js.

**Dispatch jitter:** When multiple burst jobs are enqueued simultaneously at launch (e.g., 3 accounts), stagger burst-type job starts by `index * 500ms`. This is applied inside `dispatch()` specifically for `burst` jobs:
```
if job.type === 'burst' and job.burstIndex > 0:
  await delay(job.burstIndex * 500)
runJob(job)
```
`burstIndex` is assigned sequentially (0, 1, 2) when burst jobs are enqueued at launch. Fast and backfill jobs are not staggered.

**sync-complete debounce:** Burst completions and the first fast-sync all fire `sync-complete` within the first 30s of launch. `SyncManager` should send `sync-complete` via a 500ms trailing debounce (cancel-and-restart on each new signal) so the renderer does at most one reload per burst wave rather than N reloads for N accounts.

---

## DB Schema Changes

**Migration 12** (adds two columns to `sync_state`):

```sql
ALTER TABLE sync_state ADD COLUMN last_batch_size INTEGER NOT NULL DEFAULT 100;
ALTER TABLE sync_state ADD COLUMN last_batch_duration_ms INTEGER;
```

No new tables required. `sync_backfill_cursors` and `inbox_index` are unchanged.

---

## Error Handling

- Auth errors (401, `invalid_grant`) on burst/backfill: mark account `token_expired = 1`, skip further jobs for that account until re-auth.
- Network errors: log, release concurrency slot. Job is naturally re-attempted on the next timer tick.
- Backfill complete for all folders: `sync_backfill_cursors.complete = 1` for all folders → no more backfill jobs enqueued for that account.

---

## Idempotency & Deduplication

No changes needed. Both `inbox_index` and `emails` use `INSERT OR IGNORE` / `ON CONFLICT DO NOTHING` keyed on `(account_id, provider_message_id)`. Burst, fast, and backfill can overlap safely.

---

## File Change Summary

| File | Change |
|---|---|
| `electron/sync-manager.js` | **New** — SyncManager class with job queue, concurrency, adaptive batch sizing |
| `electron/main.js` | Remove sync/backfill functions and `BACKFILL_INTERVAL_MS`; instantiate SyncManager |
| `inboxmy-backend/src/routes/sync.ts` | Add `POST /api/sync/burst`; accept `batchSize` param in backfill; add `PATCH /api/sync/state/:accountId` |
| `inboxmy-backend/src/email/gmail-client.ts` | Add `fetchBurstMetadata(accountId, limit)` — metadata fetch scoped to `in:inbox` |
| `inboxmy-backend/src/email/outlook-client.ts` | Add `fetchBurstMetadata(accountId, limit)` — metadata fetch (Outlook inbox is default scope) |
| `inboxmy-backend/src/db/migrations.ts` | Migration 12: two new columns on `sync_state` |
