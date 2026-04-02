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

## Backend Changes

### 1. New endpoint: `GET /api/emails/unread-counts`

Replaces `/api/emails/unread-count` (singular). Returns all sidebar badge values in one response using a single SQL query with conditional aggregation.

**Response shape:**
```typescript
interface UnreadCounts {
  total_unread: number   // title bar badge — all unread, all folders
  bills:        number
  govt:         number
  receipts:     number
  work:         number
  important:    number
  promotions:   number
  snoozed:      number   // currently snoozed (snoozed_until > now)
  sent:         number
  draft:        number
  spam:         number
  archived:     number
}
```

**SQL pattern** — single query, conditional aggregation:
```sql
SELECT
  COUNT(CASE WHEN e.is_read = 0 AND e.snoozed_until IS NULL THEN 1 END) AS total_unread,
  COUNT(CASE WHEN e.is_read = 0 AND e.category = 'bill'    THEN 1 END) AS bills,
  COUNT(CASE WHEN e.is_read = 0 AND e.category = 'govt'    THEN 1 END) AS govt,
  COUNT(CASE WHEN e.is_read = 0 AND e.category = 'receipt' THEN 1 END) AS receipts,
  COUNT(CASE WHEN e.is_read = 0 AND e.category = 'work'    THEN 1 END) AS work,
  COUNT(CASE WHEN e.is_read = 0 AND e.is_important = 1     THEN 1 END) AS important,
  COUNT(CASE WHEN e.is_read = 0 AND e.tab = 'promotions'   THEN 1 END) AS promotions,
  COUNT(CASE WHEN e.snoozed_until IS NOT NULL AND e.snoozed_until > datetime('now') THEN 1 END) AS snoozed,
  COUNT(CASE WHEN e.is_read = 0 AND e.folder = 'sent'      THEN 1 END) AS sent,
  COUNT(CASE WHEN e.is_read = 0 AND e.folder = 'draft'     THEN 1 END) AS draft,
  COUNT(CASE WHEN e.is_read = 0 AND e.folder = 'spam'      THEN 1 END) AS spam,
  COUNT(CASE WHEN e.is_read = 0 AND e.folder = 'archive'   THEN 1 END) AS archived
FROM emails e
JOIN accounts a ON a.id = e.account_id
WHERE a.user_id = ?
```

The old `/unread-count` endpoint is **deleted**.

### 2. Updated endpoint: `PATCH /api/emails/:id/read`

**Body change:** `{ read: boolean }` → `{ is_read: boolean }` (matches field name in DB and frontend cache).

**Response change:** `{ ok: true }` → `{ ok: true, counts: UnreadCounts }`

The handler runs the same aggregation query after the UPDATE and returns fresh counts in the same response. This eliminates the need for any follow-up GET.

### 3. Database index (if not present)

Ensure this index exists for performant count queries:
```sql
CREATE INDEX IF NOT EXISTS idx_emails_unread
  ON emails(account_id, folder, is_read, tab, snoozed_until);
```

---

## Frontend Changes

### 1. State

Replace the scattered `unreadCount` variable with a single object:

```javascript
let unreadCounts = {
  total_unread: 0,
  bills: 0, govt: 0, receipts: 0, work: 0,
  important: 0, promotions: 0, snoozed: 0,
  sent: 0, draft: 0, spam: 0, archived: 0,
}

// Tracks in-flight mark-read requests to handle rapid clicks
const pendingReadRequests = new Map()  // emailId → boolean (target is_read state)
```

### 2. Rendering

Single function replaces `renderUnreadBadge()` and the badge-setting logic inside `loadCategoryBadges()`:

```javascript
function renderUnreadBadges(counts = unreadCounts) {
  // Updates all badge-* elements and #unread-badge from the counts object
}
```

### 3. Fetching

Two functions replace `refreshUnreadCount()` and `loadCategoryBadges()`:

```javascript
async function refreshUnreadCounts() {
  // GET /api/emails/unread-counts → set unreadCounts → renderUnreadBadges()
}
```

`loadCategoryBadges()` is **deleted**. All call sites are updated to call `refreshUnreadCounts()` instead.

### 4. Mark read / unread

New function `markEmailRead(emailId, isRead)`:

1. Find email in `emailCache`. No-op if already in target state.
2. Compute optimistic delta: which badge keys does this email affect, and by +1 or -1?
3. Apply delta to a shallow copy of `unreadCounts`. Call `renderUnreadBadges(optimistic)` immediately.
4. Set `pendingReadRequests.set(emailId, isRead)`.
5. Call `PATCH /api/emails/:id/read` with `{ is_read: isRead }`.
6. On **success**: set `unreadCounts = response.counts`. Call `renderUnreadBadges()`. Remove from pending map.
7. On **failure**: revert `email.is_read`. Re-render the email row. Call `refreshUnreadCounts()`. Show error toast. Remove from pending map.

The inline mark-read block inside `selectEmail()` is replaced with a call to `markEmailRead(id, true)`.

**Delta computation rules:**
| Email field | Badge key affected |
|---|---|
| `category === 'bill'` | `bills` |
| `category === 'govt'` | `govt` |
| `category === 'receipt'` | `receipts` |
| `category === 'work'` | `work` |
| `is_important === 1` | `important` |
| `tab === 'promotions'` | `promotions` |
| `folder === 'sent'` | `sent` |
| `folder === 'draft'` | `draft` |
| `folder === 'spam'` | `spam` |
| `folder === 'archive'` | `archived` |
| always | `total_unread` |

All deltas use `Math.max(0, n + delta)` to prevent negative counts.

### 5. Mark as unread — context menu

Add a "Mark as unread" item to the right-click context menu (`#ctx-menu`). It appears conditionally: visible only when the selected email `is_read === true`. It calls `markEmailRead(ctxEmailId, false)`.

The existing "Mark as read" item (if any) is shown only when `is_read === false`.

### 6. Sync integration

All call sites updated:

| Was | Becomes |
|---|---|
| `refreshUnreadCount()` | `refreshUnreadCounts()` |
| `loadCategoryBadges()` | `refreshUnreadCounts()` |
| Both called together | Single `refreshUnreadCounts()` |

Affected locations: `DOMContentLoaded` init, `backgroundSyncPoll()`, `window.inboxmy.onSyncComplete`, `window.inboxmy.onNewEmails`.

---

## Files Changed

| File | Change |
|---|---|
| `inboxmy-backend/src/routes/emails.ts` | Add `/unread-counts`, update `/:id/read`, delete `/unread-count` |
| `frontend/app.js` | Replace badge state/logic, add `markEmailRead()`, update all call sites |
| `frontend/index.html` | Add "Mark as unread" and "Mark as read" context menu items |

---

## Non-Goals / Explicitly Not Changed

- Database schema (no migration needed)
- The sync engine or Electron IPC layer
- Any other API endpoints
- Test files (updating tests is a separate concern)
