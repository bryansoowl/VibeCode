# Plan 11 Design: Snooze + Focused Inbox + Smart Groups (Labels)

**Date:** 2026-04-02
**Status:** Approved

---

## Goal

Add three inbox-management features to InboxMY:

1. **Snooze** — hide an email until a chosen future time, then restore it to its original folder
2. **Focused Inbox** — rule-based filter showing only `folder=inbox AND tab=primary` emails
3. **Smart Groups (Labels)** — user-created named labels, many-to-many assigned to emails

All three are surfaced through a **Gmail-style right-click context menu** on email rows. No new OAuth, no AI calls — everything runs locally.

---

## Section 1: Architecture Overview

### New database additions (Migration 7)

- `snoozed_until INTEGER` column on `emails` — `NULL` = not snoozed; timestamp = wake-up time
- `labels` table — `(id, user_id, name, color, created_at)`
- `email_labels` junction table — `(email_id, label_id)`, many-to-many, cascades on delete

### New backend

- New file: `src/routes/labels.ts` — full CRUD for labels + label assignment on emails
- Additions to `src/routes/emails.ts` — snooze endpoints, `?snoozed=1` param, `?labelId=` param, `labels` array in response
- New endpoint `POST /api/emails/unsnooze-due` — called by Electron's sync tick to restore due emails; no request body required, no auth (internal call uses session cookie from Electron's `net.request`)
- Addition to `electron/main.js` `runSyncTick` — calls `POST /api/emails/unsnooze-due` via `net.request` every 60 seconds alongside the existing sync logic

### New frontend

- Right-click context menu component in `frontend/app.js` + `frontend/index.html`
- Snooze submenu (4 presets + custom datetime input)
- Move to submenu (folder list, using canonical `FOLDER_VALUES`)
- Label as submenu (user labels + inline "New label…")
- "Focused" and "Snoozed" sidebar entries
- "Labels" sidebar section — one entry per user label, dynamically loaded

---

## Section 2: Database Schema (Migration 7)

```sql
-- Snooze: nullable timestamp, NULL = not snoozed
-- Partial index on SQLite 3.8.9+ (well-supported by better-sqlite3)
ALTER TABLE emails ADD COLUMN snoozed_until INTEGER;
CREATE INDEX IF NOT EXISTS idx_emails_snoozed ON emails(snoozed_until)
  WHERE snoozed_until IS NOT NULL;

-- Labels: per-user named + colored groups
CREATE TABLE IF NOT EXISTS labels (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  color      TEXT NOT NULL DEFAULT '#6B7280',
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_labels_user_name ON labels(user_id, name);
CREATE INDEX IF NOT EXISTS idx_labels_user ON labels(user_id);

-- Email-label junction: many-to-many
CREATE TABLE IF NOT EXISTS email_labels (
  email_id  TEXT NOT NULL REFERENCES emails(id) ON DELETE CASCADE,
  label_id  TEXT NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
  PRIMARY KEY (email_id, label_id)
);
CREATE INDEX IF NOT EXISTS idx_email_labels_label ON email_labels(label_id);
```

### Snooze behaviour

- Snoozed emails are hidden from all normal `GET /api/emails` queries by a default filter: `AND (e.snoozed_until IS NULL)`. This filter is applied to **both** the fast SQL path and the in-memory search candidate fetch.
- The `?snoozed=1` param inverts this: `AND (e.snoozed_until IS NOT NULL)`, ignoring `folder`/`tab`. Applies to both paths.
- When `?search=` and `?snoozed=1` are combined, the search candidate SQL must include `AND (e.snoozed_until IS NOT NULL)` before the in-memory filter runs.
- The email's original `folder` value is preserved throughout — when un-snoozed, `snoozed_until` is set to `NULL` and the email reappears in its original folder automatically.

### Labels in email response

`GET /api/emails` and `GET /api/emails/:id` return labels using a correlated subquery (not a LEFT JOIN) to avoid row multiplication on multi-label emails:

```sql
-- Per email row, fetch labels as JSON array via subquery
(SELECT json_group_array(json_object('id', l.id, 'name', l.name, 'color', l.color))
 FROM email_labels el JOIN labels l ON l.id = el.label_id
 WHERE el.email_id = e.id) AS labels_json
```

The backend parses `labels_json` (defaulting to `[]` if null) before returning the response. This ensures the row count and `total` field in the list response are never inflated by label joins.

`GET /api/labels` includes a `count` field per label (total emails assigned to that label for the user), used for sidebar badges.

---

## Section 3: Backend API

### `src/routes/labels.ts` (new)

| Method | Path | Body | Response |
|--------|------|------|----------|
| `GET` | `/api/labels` | — | `[{ id, name, color, count }]` 200 |
| `POST` | `/api/labels` | `{ name, color? }` | `{ id, name, color }` 201 |
| `PATCH` | `/api/labels/:id` | `{ name?, color? }` | `{ ok: true }` 200 |
| `DELETE` | `/api/labels/:id` | — | `{ ok: true }` 200 |

**Validation:**
- `name`: required, max 50 chars, unique per user (409 on duplicate)
- `color`: optional, must match `/^#[0-9a-fA-F]{6}$/` — defaults to `#6B7280`
- All writes verify ownership (404 if label belongs to another user)

### Additions to `src/routes/emails.ts`

| Method | Path | Body | Response |
|--------|------|------|----------|
| `PATCH` | `/api/emails/:id/snooze` | `{ until: number }` (ms timestamp) | `{ ok: true }` 200 |
| `DELETE` | `/api/emails/:id/snooze` | — | `{ ok: true }` 200 |
| `POST` | `/api/emails/:id/labels/:labelId` | — | `{ ok: true }` 200 (`INSERT OR IGNORE` — idempotent, always 200) |
| `DELETE` | `/api/emails/:id/labels/:labelId` | — | `{ ok: true }` 200 |

**Snooze validation:**
- `until` must be > `Date.now()` (reject past timestamps with 400)
- `until` must be < `Date.now() + 365 * 24 * 60 * 60 * 1000` (max 1 year out)

**`GET /api/emails` changes:**
- New `?snoozed=1` param: shows only snoozed emails (overrides folder/tab filters); applies to both fast SQL path and in-memory search path
- New `?labelId=<id>` param: filters via `email_labels` JOIN; if `labelId` does not belong to `req.user.id`, returns 404 (consistent with ownership guard pattern across the API)
- Default query adds `AND (e.snoozed_until IS NULL)` to both fast-path SQL and the in-memory candidate fetch SQL when `snoozed` param absent
- `labels` field added to every email row via correlated subquery (see Section 2)
- Badge polling uses `?limit=1` (satisfies Zod `.min(1)` constraint on the list query) and reads the `total` field from the response

**`GET /api/emails/unread-count` change:**
- After Migration 7, this endpoint's SQL query must also add `AND (e.snoozed_until IS NULL)` so snoozed-but-unread emails are not counted in the inbox unread badge.

### `POST /api/emails/unsnooze-due` (new, in `src/routes/emails.ts`)

- Called internally by Electron's `runSyncTick` via `net.request` with the user's session cookie
- No request body; protected by `requireAuth` like all `/api/*` routes
- **Registration:** must be registered before the `GET /:id` wildcard handler inside `emailsRouter`, or follow the `sendRouter` pattern and mount it as a separate router in `server.ts` before `emailsRouter`. Either approach works; the `sendRouter` separate-mount pattern is preferred for consistency.
- Runs:
  ```sql
  UPDATE emails SET snoozed_until = NULL
  WHERE snoozed_until IS NOT NULL AND snoozed_until <= <now>
    AND account_id IN (SELECT id FROM accounts WHERE user_id = ?)
  ```
- Returns `{ restored: <number of rows updated> }` 200

### `electron/main.js` addition

Inside `runSyncTick` (fires every 60 seconds), add a `net.request` call to `POST /api/emails/unsnooze-due` using the stored session cookie. This mirrors the existing pattern for other internal API calls in `runSchedulerTick`.

---

## Section 4: Context Menu

### Trigger and positioning

- Event: `contextmenu` on any email row — `e.preventDefault()` suppresses native menu
- A single `div#ctx-menu` at the bottom of `<body>`, positioned absolutely to cursor coordinates
- Dismissed by: outside click, `Escape` key, or `scroll` on the email list

### Menu structure

```
┌─────────────────────────────────────┐
│  ↩  Reply                           │
│  ↩↩ Reply all                       │
│  ↪  Forward                         │
├─────────────────────────────────────┤
│  ⬚  Archive                         │
│  🗑  Delete                          │
│  ✉  Mark as unread / Mark as read   │
│  🕐  Snooze                        ▶ │  ← submenu
├─────────────────────────────────────┤
│  📁  Move to                        ▶ │  ← submenu
│  🏷  Label as                       ▶ │  ← submenu
├─────────────────────────────────────┤
│  🔍  Find emails from [sender name] │
└─────────────────────────────────────┘
```

### Snooze submenu

```
┌──────────────────────────────┐
│  Later today   (+3 hours)    │
│  Tomorrow      (9:00 AM)     │
│  This weekend  (Sat 9:00 AM) │
│  Next week     (Mon 9:00 AM) │
├──────────────────────────────┤
│  Custom date/time…           │  ← inline datetime input
└──────────────────────────────┘
```

Preset times are computed at menu-open time relative to the user's local timezone.

### Move to submenu

Lists the canonical folder values from `FOLDER_VALUES`: `inbox`, `sent`, `draft`, `spam`, `trash`, `archive` (display names mapped in the frontend: "Inbox", "Sent", "Drafts", "Spam", "Trash", "Archive"). Calls `PATCH /api/emails/:id/folder` with the canonical string value, then removes the email from the current view.

### Label as submenu

- One row per user label with a colored dot; checkmark if already assigned to this email
- Clicking a checked label removes it (`DELETE /api/emails/:id/labels/:labelId`); clicking unchecked assigns it (`POST /api/emails/:id/labels/:labelId`)
- "＋ New label…" at the bottom: reveals an inline text input; Enter creates the label (`POST /api/labels`) then immediately assigns it
- Re-fetches `GET /api/labels` after create/delete so sidebar badge counts stay current

### Plan 10 frontend dependency

Reply, Reply all, Forward call `openCompose()` if it exists (Plan 10 frontend). If `openCompose` is not defined, they show a non-blocking toast: "Compose coming soon". The menu is fully functional regardless.

### "Find emails from [sender]"

Sets the search input value to the sender's email address and calls `loadEmails()` — no new API endpoint.

---

## Section 5: Focused Inbox + Sidebar

### Focused Inbox rule

**Focused** = `folder = 'inbox' AND tab = 'primary'`

The existing `tab` column (set during sync from Gmail/Outlook categorisation) already separates primary from promotions/social/updates/forums. No new columns, no AI.

### Sidebar additions

```
── INBOX ──────────────────────────────
  Focused              [unread badge]   → ?folder=inbox&tab=primary
  Inbox (All)          [unread badge]   → ?folder=inbox  (existing)
  Snoozed              [total badge]    → ?snoozed=1

── (existing: Sent, Drafts, Spam, Archive, Promotions, Bills, Govt, Receipts, Work) ──

── LABELS ─────────────────────────────
  ● Work               [count badge]    → ?labelId=<id>
  ● Finance            [count badge]
  ＋ New label                          → inline create
```

**Badge counts:**
- Focused unread: `GET /api/emails?folder=inbox&tab=primary&unread=1&limit=1` — reads `total` field; `limit=1` satisfies the Zod `.min(1)` constraint on the list query
- Snoozed total: `GET /api/emails?snoozed=1&limit=1` — reads `total` field
- Label counts: returned by `GET /api/labels` in the `count` field — one request, all counts

Labels sidebar section is hidden when the user has no labels. Labels are loaded once on app startup and refreshed after create/delete.

---

## Section 6: Testing

### New test files

| File | Coverage |
|------|----------|
| `tests/routes/labels.test.ts` | `GET /api/labels` list + empty + `count` field; `POST` create + 400 name too long + 400 bad hex color + 409 duplicate name; `PATCH` rename + recolor + 404 cross-user; `DELETE` deletes + cascades `email_labels`; ownership guards throughout |
| `tests/routes/snooze.test.ts` | `PATCH /api/emails/:id/snooze` sets `snoozed_until`; rejects past timestamp (400); rejects >1yr (400); 404 cross-user. `DELETE` clears `snoozed_until`. `GET /api/emails` default excludes snoozed; `?snoozed=1` shows only snoozed; snoozed email excluded from normal folder view. `POST /api/emails/unsnooze-due` restores emails with `snoozed_until <= now()` and leaves future-snoozed emails untouched |
| `tests/routes/email-labels.test.ts` | `POST /api/emails/:id/labels/:labelId` assigns label; idempotent — second call returns 200 with no error; `DELETE` removes label; label appears in `GET /api/emails` `labels` array; label appears in `GET /api/emails/:id`; cross-user guard on both email (404) and label (404); `?labelId=<other-user-label>` returns 404 |

### Additions to existing test files

| File | Additions |
|------|-----------|
| `tests/routes/emails.test.ts` | `?labelId=` filter returns only emails with that label; `labels: []` present in list response for unlabelled email; label data correct in single email response; multi-label email appears exactly once in list (not duplicated) |

### Estimated totals

- New tests: ~35
- New total: ~274 (270 backend + 4 Electron utils)

### Not tested (requires Playwright)

- Context menu rendering and positioning
- Snooze submenu preset calculations
- Label submenu toggle behaviour
- Inline "New label…" flow

---

## Out of Scope

- Mute (suppress future notifications from a sender) — deferred
- "Add to Tasks" — no tasks system exists yet
- "Forward as attachment" — deferred
- "Open in new window" — Electron only, deferred
- Label colour picker in the sidebar management UI — labels use a predefined palette of 8 colours, not a freeform hex picker, to keep the UI simple
