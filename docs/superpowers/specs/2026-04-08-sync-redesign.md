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

- Inbox shows recent emails **within seconds** of first account connection.
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
- Instantiate `SyncManager(apiRequest, mainWindow, BACKEND_URL)`.
- Wire `app.on('before-quit')` → `syncManager.stop()`.

---

## Job Types

| Type | Priority | Trigger | Interval |
|---|---|---|---|
| `burst` | 0 (highest) | New account detected | One-shot |
| `fast` | 1 | Timer | Every 60s |
| `backfill` | 2 | Timer | Every 2min |

Jobs are dispatched FIFO within the same priority tier. At most `MAX_CONCURRENCY = 3` jobs run simultaneously.

---

## Sync Flows

### 1. Burst Sync

Triggered the first time a new `accountId` appears in `GET /api/accounts`.

**Electron (account poller — every 10s):**
```
accounts = GET /api/accounts
for each account not in knownAccounts:
  enqueue({ type: 'burst', accountId, priority: 0 })
  knownAccounts.add(accountId)
```

**Backend — new endpoint `POST /api/sync/burst`:**
```
fetchEmailsMetadata(accountId, limit=200)   // metadata only, no bodies
INSERT INTO inbox_index ... ON CONFLICT DO NOTHING
seed sync_backfill_cursors (idempotent)
return { added }
```

After burst completes, Electron sends `sync-complete` to the renderer so the inbox refreshes.

---

### 2. Fast Sync (unchanged)

Every 60s via existing `POST /api/sync/trigger`.  
Gmail uses History API (incremental, ~2 API calls).  
Outlook uses `sinceMs` filter.  
Writes to both `inbox_index` and `emails`. No changes needed.

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
  persist to sync_state
```

**Backend — `POST /api/sync/backfill` change:**  
`BATCH_SIZE` changes from hardcoded `25` to `req.body.batchSize` (server-side clamped to 50–200).

---

## Adaptive Batch Sizing

### Global budget

```
GLOBAL_BATCH_BUDGET = 300
perAccountMax = floor(300 / activeAccountCount)
// 1 account → 300 (capped at 200), 2 → 150, 3 → 100
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

### CPU backpressure (optional, best-effort)

Sampled once per dispatch cycle using `process.cpuUsage()`:
```
if cpuPercent > 80:
  effectiveBatchSize = floor(batchSize * 0.5)
```

### Persistence

`accountBatchState` is seeded from `sync_state` on startup so tuning survives restarts.

---

## Concurrency Control

```
class SyncManager:
  dispatch():
    while jobQueue.size > 0 and activeSlots < MAX_CONCURRENCY:
      job = jobQueue.pop()
      activeSlots++
      runJob(job).finally(() => { activeSlots--; dispatch() })
```

No external semaphore library needed — a simple counter suffices.

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
- Network errors: log, release concurrency slot, job is re-queued on the next timer tick naturally.
- Backfill complete for all folders: `sync_backfill_cursors.complete = 1` — no more backfill jobs enqueued for that account.

---

## Idempotency & Deduplication

No changes needed. Both `inbox_index` and `emails` use `INSERT OR IGNORE` / `ON CONFLICT DO NOTHING` keyed on `(account_id, provider_message_id)`. Burst, fast, and backfill can overlap safely.

---

## File Change Summary

| File | Change |
|---|---|
| `electron/sync-manager.js` | **New** — SyncManager class |
| `electron/main.js` | Remove sync/backfill functions, instantiate SyncManager |
| `inboxmy-backend/src/routes/sync.ts` | Add `POST /api/sync/burst`; accept `batchSize` in backfill |
| `inboxmy-backend/src/db/migrations.ts` | Migration 12: two new columns on `sync_state` |
