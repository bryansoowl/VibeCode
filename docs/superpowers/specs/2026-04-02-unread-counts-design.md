# Unread Count Architecture — Design Spec
**Date:** 2026-04-02  
**Project:** InboxMY  
**Status:** Approved

---

## Problem

The current unread count implementation has three issues:

1. `loadCategoryBadges()` fires 10 parallel API calls on every poll cycle — one per sidebar badge. This is wasteful and causes counts to arrive at different times, creating visual jitter.
2. `PATCH /api/emails/:id/read` returns only `{ ok: true }`. After marking an email read, the frontend has no authoritative count and relies entirely on its own decrement logic, which drifts over time and across sessions.
3. There is no "mark as unread" user action. Only clicking an email marks it read (fire-and-forget, no revert on failure).

---

## Goals

- Backend is the single source of truth for all unread counts.
- All badge values are fetched in one SQL query / one round-trip.
- Every mark-read/unread action returns fresh counts in its response — no second request needed.
- Optimistic UI updates make actions feel instant; server response immediately reconciles any drift.
- Failures revert the UI and re-fetch authoritative state.
- "Mark as unread" is available from the right-click context menu.

---

## Out of Scope

- WebSockets / server-sent events
- A faster 10-second counts-only poll (Option C — deferred)
- Batching multiple mark-read actions into one request

---

## Intentional Behavior Changes (vs. current implementation)

### `total_unread` now covers all folders
The old `/api/emails/unread-count` query required `e.folder = 'inbox' AND e.tab != 'promotions'`, so the title bar badge only counted inbox unread. The new `total_unread` counts unread emails across **all** folders (still excludes snoozed). The title bar badge will reflect a larger, more complete number. This is intentional.

### `important` badge now shows unread-only
The current `loadCategoryBadges()` fetches important emails without an `unread` filter, so it shows a count of all important emails regardless of read state. The new query counts only `is_read = 0 AND is_important = 1`, aligning it with every other badge. This is intentional.

### Badge counts capped at 99+
The new `renderUnreadBadges()` caps all displayed badge values at "99+" (any count > 99 shows as "99+"). The current `loadCategoryBadges()` shows raw numbers with no cap. This is a minor visual improvement, not a data change.

### `snoozed` badge counts all snoozed, read or unread
The snoozed badge counts all currently-snoozed emails (`snoozed_until > now`) regardless of `is_read`. This matches the current `refreshSnoozedBadge()` behavior and is intentional — the badge communicates "you have N emails waiting to reappear", not "N unread snoozed emails". All other badges (`bills`, `govt`, etc.) exclude snoozed emails via `AND e.snoozed_until IS NULL`, keeping them consistent with `total_unread`.

---

## Backend Changes

### 1. New endpoint: `GET /api/emails/unread-counts`

Replaces `/api/emails/unread-count` (singular, **deleted**). Returns all sidebar badge values in one response using a single SQL query with conditional aggregation.

**Response shape:**
```typescript
interface UnreadCounts {
  total_unread: number   // title bar badge — all unread, all folders, excl. snoozed
  bills:        number   // unread with category='bill'
  govt:         number   // unread with category='govt'
  receipts:     number   // unread with category='receipt'
  work:         number   // unread with category='work'
  important:    number   // unread with is_important=1
  promotions:   number   // unread with tab='promotions'
  snoozed:      number   // all snoozed (read+unread) where snoozed_until > now
  sent:         number   // unread in folder='sent'
  draft:        number   // unread in folder='draft'
  spam:         number   // unread in folder='spam'
  archived:     number   // unread in folder='archive'
}
```

**SQL — single query, conditional aggregation:**
```sql
SELECT
  COUNT(CASE WHEN e.is_read = 0 AND e.snoozed_until IS NULL THEN 1 END) AS total_unread,
  COUNT(CASE WHEN e.is_read = 0 AND e.snoozed_until IS NULL AND e.category = 'bill'    THEN 1 END) AS bills,
  COUNT(CASE WHEN e.is_read = 0 AND e.snoozed_until IS NULL AND e.category = 'govt'    THEN 1 END) AS govt,
  COUNT(CASE WHEN e.is_read = 0 AND e.snoozed_until IS NULL AND e.category = 'receipt' THEN 1 END) AS receipts,
  COUNT(CASE WHEN e.is_read = 0 AND e.snoozed_until IS NULL AND e.category = 'work'    THEN 1 END) AS work,
  COUNT(CASE WHEN e.is_read = 0 AND e.snoozed_until IS NULL AND e.is_important = 1     THEN 1 END) AS important,
  COUNT(CASE WHEN e.is_read = 0 AND e.snoozed_until IS NULL AND e.tab = 'promotions'   THEN 1 END) AS promotions,
  COUNT(CASE WHEN e.snoozed_until IS NOT NULL
              AND e.snoozed_until > (strftime('%s','now') * 1000) THEN 1 END) AS snoozed,
  COUNT(CASE WHEN e.is_read = 0 AND e.snoozed_until IS NULL AND e.folder = 'sent'    THEN 1 END) AS sent,
  COUNT(CASE WHEN e.is_read = 0 AND e.snoozed_until IS NULL AND e.folder = 'draft'   THEN 1 END) AS draft,
  COUNT(CASE WHEN e.is_read = 0 AND e.snoozed_until IS NULL AND e.folder = 'spam'    THEN 1 END) AS spam,
  COUNT(CASE WHEN e.is_read = 0 AND e.snoozed_until IS NULL AND e.folder = 'archive' THEN 1 END) AS archived
FROM emails e
JOIN accounts a ON a.id = e.account_id
WHERE a.user_id = ?
```

### 2. Updated endpoint: `PATCH /api/emails/:id/read`

**Body change:** field renamed from `read` to `is_read` to match the DB column and frontend cache field.

Old Zod schema: `z.object({ read: z.boolean().optional() })`  
New Zod schema: `z.object({ is_read: z.boolean() })` — required, not optional.

**Response change:** `{ ok: true }` → `{ ok: true, counts: UnreadCounts }`

The handler runs the aggregation query after the UPDATE and returns fresh counts in the same response. No follow-up GET needed.

**Note on default behavior:** The old handler defaulted to `is_read = 1` when no body was present (because `markRead()` sent no body). The new schema requires `is_read` — the `markRead()` wrapper function must be updated to pass `{ is_read: true }` in the request body.

### 3. Database index

Ensure this index exists for performant count queries (add if missing):
```sql
CREATE INDEX IF NOT EXISTS idx_emails_unread
  ON emails(account_id, folder, is_read, tab, snoozed_until);
```

---

## Frontend Changes

### 1. State

Replace the scattered `unreadCount` variable with a single object. Remove the `unreadCount` variable entirely.

```javascript
let unreadCounts = {
  total_unread: 0,
  bills: 0, govt: 0, receipts: 0, work: 0,
  important: 0, promotions: 0, snoozed: 0,
  sent: 0, draft: 0, spam: 0, archived: 0,
}

// Tracks in-flight mark-read requests to handle rapid clicks on the same email
const pendingReadRequests = new Map()  // emailId → boolean (target is_read state)
```

### 2. Rendering

Delete `renderUnreadBadge()`. Add `renderUnreadBadges(counts)`:

```javascript
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
```

### 3. Fetching

**Delete** `refreshUnreadCount()`, `loadCategoryBadges()`, and `refreshSnoozedBadge()`.  
**Add** `refreshUnreadCounts()`:

```javascript
async function refreshUnreadCounts() {
  try {
    const data = await apiFetch('/api/emails/unread-counts')
    unreadCounts = data
    renderUnreadBadges()
  } catch { /* silent — stale counts better than broken UI */ }
}
```

### 4. Mark read / unread

**Delete** the inline mark-read block inside `selectEmail()` (the optimistic decrement logic and the `markRead(id)` fire-and-forget call). Replace with a call to `markEmailRead(id, true)`.

**Delete** `markRead()` wrapper function (lines ~133-135). **Warning:** the current `markRead()` function contains a backslash path bug (`'\api\emails\'`) and sends no request body. After the backend's Zod schema makes `is_read` required, any surviving call to the old function will receive a 400. Ensure it is fully deleted with no remaining call sites before testing.

**Add** `markEmailRead(emailId, isRead)`:

1. Find email in `emailCache`. No-op if `email.is_read === isRead` (already in target state).
2. Compute optimistic delta (`+1` for marking unread, `-1` for marking read).
3. Apply delta to a shallow copy of `unreadCounts` for each affected badge key (see delta table below). Use `Math.max(0, n + delta)` on every field.
4. Update `email.is_read` in cache. Re-render the email row.
5. Call `renderUnreadBadges(optimistic)` immediately — this is the instant visual feedback.
6. Set `pendingReadRequests.set(emailId, isRead)`.
7. Call `PATCH /api/emails/:id/read` with body `{ is_read: isRead }`.
8. On **success**: set `unreadCounts = response.counts`. Call `renderUnreadBadges()`. Delete from pending map.
9. On **failure**: revert `email.is_read` to original. Re-render the email row. Call `refreshUnreadCounts()`. Show error toast. Delete from pending map.

**Rapid-click guard:** At the start of `markEmailRead`, check `pendingReadRequests.has(emailId)`. If the in-flight target state equals `isRead`, return early (duplicate). If it differs (user toggled quickly), let it proceed — the last response wins on reconciliation.

**Delta computation table:**

| Condition on email | Badge key | Note |
|---|---|---|
| always | `total_unread` | Every read/unread affects total |
| `category === 'bill'` | `bills` | |
| `category === 'govt'` | `govt` | |
| `category === 'receipt'` | `receipts` | |
| `category === 'work'` | `work` | |
| `is_important === 1` | `important` | |
| `tab === 'promotions'` | `promotions` | |
| `folder === 'sent'` | `sent` | |
| `folder === 'draft'` | `draft` | |
| `folder === 'spam'` | `spam` | |
| `folder === 'archive'` | `archived` | |
| — | `snoozed` | **Excluded** — snooze state is not affected by marking read/unread |

### 5. Mark as unread — context menu

**Delete** the existing `ctxAction('toggle-read')` block (currently at line ~1581) which sends `{ read: newRead }` directly via `apiFetch`. Replace with two separate, conditionally-rendered menu items.

In `index.html`, update the context menu (`#ctx-menu`) to have two mutually exclusive items:

```html
<div class="ctx-item" id="ctx-mark-read"   onclick="ctxAction('mark-read')">Mark as read</div>
<div class="ctx-item" id="ctx-mark-unread" onclick="ctxAction('mark-unread')">Mark as unread</div>
```

In `showCtxMenu()` (or wherever the context menu is populated), show/hide based on the email's current state:

```javascript
document.getElementById('ctx-mark-read').style.display   = ctxEmailData.is_read ? 'none' : ''
document.getElementById('ctx-mark-unread').style.display = ctxEmailData.is_read ? '' : 'none'
```

In `ctxAction()`:
```javascript
case 'mark-read':   markEmailRead(ctxEmailId, true);  closeCtxMenu(); break
case 'mark-unread': markEmailRead(ctxEmailId, false); closeCtxMenu(); break
```

### 6. Call site migration — complete list

Every call to the three deleted functions must be replaced. Full list:

| Location | Was | Becomes |
|---|---|---|
| `DOMContentLoaded` init | `loadCategoryBadges()` + `refreshUnreadCount()` (called separately) | `refreshUnreadCounts()` (once) |
| `DOMContentLoaded` init | `refreshSnoozedBadge()` | removed (covered by `refreshUnreadCounts`) |
| `backgroundSyncPoll()` | `loadCategoryBadges()` (unconditional) | `refreshUnreadCounts()` |
| `backgroundSyncPoll()` | `refreshUnreadCount()` inside `if (result.added > 0)` block | **delete** — the unconditional `refreshUnreadCounts()` above covers it |
| `window.inboxmy.onSyncComplete` | `loadCategoryBadges()` + `refreshUnreadCount()` | `refreshUnreadCounts()`; **keep** the existing `loadEmails(true)` call unchanged |
| `window.inboxmy.onNewEmails` handler | `unreadCount = count; renderUnreadBadge()` | Remove the integer assignment entirely. Call `refreshUnreadCounts()` for authoritative counts. Keep `showEmailNotifications(emails)`. |
| Manual sync button handler (~line 1103) | `loadCategoryBadges()` | `refreshUnreadCounts()` |
| `confirmResyncAccount()` (~line 1364) | `loadCategoryBadges()` | `refreshUnreadCounts()` |
| `confirmWipeAll()` (~line 1388) | `loadCategoryBadges()` | `refreshUnreadCounts()` |
| Snooze / unsnooze action handlers (~lines 1679, 1698) | `refreshSnoozedBadge()` | `refreshUnreadCounts()` |

**Note on `onNewEmails`:** The Electron main process IPC payload includes a precomputed `unreadCount` integer. After this refactor, that integer is ignored in the renderer — the renderer always fetches authoritative counts from the backend via `refreshUnreadCounts()`. The main process IPC sender does **not** need to change.

---

## Files Changed

| File | Change |
|---|---|
| `inboxmy-backend/src/routes/emails.ts` | Add `/unread-counts` endpoint; update `/:id/read` (rename body field, return counts); delete `/unread-count` endpoint |
| `frontend/app.js` | Add `unreadCounts` object + `pendingReadRequests` map; add `renderUnreadBadges()`; add `refreshUnreadCounts()`; add `markEmailRead()`; delete `unreadCount`, `renderUnreadBadge()`, `refreshUnreadCount()`, `loadCategoryBadges()`, `refreshSnoozedBadge()`, `markRead()`; update all call sites; replace `ctxAction('toggle-read')` with `mark-read`/`mark-unread` cases |
| `frontend/index.html` | Replace `toggle-read` context menu item with separate `mark-read` and `mark-unread` items |

---

## Non-Goals / Explicitly Not Changed

- Database schema (no migration needed — `is_read` column and `archive` folder already exist)
- The sync engine or Electron IPC main process
- Any other API endpoints
- Test files (updating tests is a separate concern)
