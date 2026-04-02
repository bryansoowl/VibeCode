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
- Addition to `src/scheduler.ts` — 15-min tick restores emails whose `snoozed_until <= now()`

### New frontend

- Right-click context menu component in `frontend/app.js` + `frontend/index.html`
- Snooze submenu (4 presets + custom datetime input)
- Move to submenu (folder list)
- Label as submenu (user labels + inline "New label…")
- "Focused" and "Snoozed" sidebar entries
- "Labels" sidebar section — one entry per user label, dynamically loaded

---

## Section 2: Database Schema (Migration 7)

```sql
-- Snooze: nullable timestamp, NULL = not snoozed
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

- Snoozed emails are hidden from all normal `GET /api/emails` queries by a default filter: `AND (e.snoozed_until IS NULL)`
- The `?snoozed=1` param inverts this: `AND (e.snoozed_until IS NOT NULL)`, ignoring `folder`/`tab`
- The email's original `folder` value is preserved throughout — when un-snoozed it returns exactly where it was

### Labels in email response

`GET /api/emails` and `GET /api/emails/:id` LEFT JOIN `email_labels` + `labels` and return a `labels` array: `[{ id, name, color }]`. Empty array when none assigned.

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
| `POST` | `/api/emails/:id/labels/:labelId` | — | `{ ok: true }` 201 |
| `DELETE` | `/api/emails/:id/labels/:labelId` | — | `{ ok: true }` 200 |

**Snooze validation:**
- `until` must be > `Date.now()` (reject past timestamps with 400)
- `until` must be < `Date.now() + 365 * 24 * 60 * 60 * 1000` (max 1 year)

**`GET /api/emails` changes:**
- New `?snoozed=1` param: shows only snoozed emails (overrides folder/tab filters)
- New `?labelId=<id>` param: filters via `email_labels` JOIN, verified against user ownership
- Default query adds `AND (e.snoozed_until IS NULL)` when `snoozed` param absent

### `src/scheduler.ts` addition

Added to the existing 15-min cron tick:

```sql
UPDATE emails
SET folder = folder, snoozed_until = NULL
WHERE snoozed_until IS NOT NULL AND snoozed_until <= <now>
  AND account_id IN (SELECT id FROM accounts WHERE user_id IS NOT NULL)
```

The `folder` column is preserved — the email returns to wherever it was before being snoozed.

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
│  🕐  Snooze                        ▶ │
├─────────────────────────────────────┤
│  📁  Move to                        ▶ │
│  🏷  Label as                       ▶ │
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

Lists: Inbox / Sent / Drafts / Spam / Trash / Archive. Calls `PATCH /api/emails/:id/folder` then removes email from current view.

### Label as submenu

- One row per user label with a colored dot; checkmark if already assigned to this email
- Clicking a checked label removes it; clicking unchecked assigns it
- "＋ New label…" at the bottom: reveals an inline text input + color picker; Enter creates and immediately assigns the label
- Re-fetches the label list after create so the sidebar badge count updates

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
- Focused unread: `GET /api/emails?folder=inbox&tab=primary&unread=1&limit=1` (uses `total` field)
- Snoozed total: `GET /api/emails?snoozed=1&limit=1` (uses `total` field)
- Label counts: returned by `GET /api/labels` in the `count` field

Labels sidebar section is hidden when the user has no labels. Labels are loaded once on app startup and refreshed after create/delete.

---

## Section 6: Testing

### New test files

| File | Coverage |
|------|----------|
| `tests/routes/labels.test.ts` | `GET /api/labels` list + empty + count field; `POST` create + 400 name too long + 400 bad hex color + 409 duplicate name; `PATCH` rename + recolor + 404 cross-user; `DELETE` deletes + cascades `email_labels`; ownership guards throughout |
| `tests/routes/snooze.test.ts` | `PATCH /api/emails/:id/snooze` sets `snoozed_until`; rejects past timestamp (400); rejects >1yr (400); 404 cross-user. `DELETE` clears field. `GET /api/emails` default excludes snoozed; `?snoozed=1` shows only snoozed; snoozed email excluded from folder view |
| `tests/routes/email-labels.test.ts` | `POST /api/emails/:id/labels/:labelId` assigns label + idempotent (201 both times); `DELETE` removes label; label appears in `GET /api/emails` response `labels` array; label appears in `GET /api/emails/:id`; cross-user guard on both email and label |

### Additions to existing test files

| File | Additions |
|------|-----------|
| `tests/routes/emails.test.ts` | `?labelId=` filter returns only emails with that label; `labels: []` present in list response; label data in single email response |
| `tests/email/sync-engine.test.ts` | Scheduler un-snooze: email with `snoozed_until` in the past gets `snoozed_until = NULL` and remains in original folder after tick |

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
