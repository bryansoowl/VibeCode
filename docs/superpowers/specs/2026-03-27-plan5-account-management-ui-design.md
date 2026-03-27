# Plan 5 — Account Management UI Design

**Date:** 2026-03-27
**Status:** Approved

---

## Overview

Plan 5 wires the existing `PATCH /api/accounts/:id/label` and `DELETE /api/accounts/:id` backend routes into the Settings modal UI. It also adds per-account sync status badges and expired-token re-auth prompts. All controls live exclusively in the Settings modal "Connected accounts" section — the sidebar stays clean.

---

## 1. Backend Changes

### Migration 5 — `token_expired` column

Add one column to the `accounts` table as entry index 4 in the `MIGRATIONS` array in `src/db/migrations.ts`:

```sql
ALTER TABLE accounts ADD COLUMN token_expired INTEGER NOT NULL DEFAULT 0;
```

- `0` = healthy (default for all existing rows)
- `1` = OAuth token has expired; user must reconnect

SQLite allows `NOT NULL DEFAULT 0` on `ALTER TABLE` — this is valid and non-breaking.

The `SELECT * FROM accounts WHERE id = ?` inside `syncAccount()` will automatically pick up the new column; no change is needed there.

### Sync engine (`src/email/sync-engine.ts`)

In the `catch` block of `syncAccount()`, after logging the error to `sync_log`, check whether the error is auth-related. Use a case-insensitive check against the error message string for any of: `invalid_grant`, `401`, `token has been expired or revoked`, `unauthorized`, `re-auth required`. The last pattern catches the Outlook-specific error thrown by `getAccessToken()` (`"Outlook account not found in MSAL cache — re-auth required"`). If matched, run:

```sql
UPDATE accounts SET token_expired = 1 WHERE id = ?
```

On successful sync completion, combine the `last_synced` and `token_expired` updates into a single statement for atomicity:

```sql
UPDATE accounts SET last_synced = ?, token_expired = 0 WHERE id = ?
```

This ensures the flag is cleared whenever a sync succeeds. Remove the separate `UPDATE accounts SET last_synced = ?` statement that previously existed here.

### OAuth callbacks (`src/server.ts`)

The Gmail and Outlook OAuth callbacks upsert an account row and call `saveToken()`. `accountId` is determined before `.run()` (via `existing?.id ?? randomUUID()`), but is safe to use because the INSERT uses that same UUID. Place the UPDATE immediately after `.run()` completes:

```sql
UPDATE accounts SET token_expired = 0 WHERE id = ?
```

The UPDATE must use the `accountId` value **after** the upsert `.run()` call, not before, to guarantee the row exists.

### `GET /api/accounts`

Update the SELECT in `accounts.ts` to include `token_expired`:

```sql
SELECT id, provider, email, label, created_at, last_synced, token_expired FROM accounts WHERE user_id = ?
```

---

## 2. Frontend — Settings Modal Account Cards

### `renderSettingsAccounts()` in `frontend/app.js`

Each account card gains three new elements:

#### 2a. Sync status badge

Shown below the last-sync line. Three states — evaluated in this order:

| Condition | Display |
|---|---|
| `acct.token_expired === 1` | Red badge: `⚠ Auth expired — ` + `<a href="/api/accounts/connect/gmail">Reconnect</a>` (or `outlook`) |
| `acct.last_synced` truthy and `token_expired === 0` | Green dot + `Synced [time]` |
| No `last_synced` and `token_expired === 0` | Grey text: `Never synced` |

The reconnect URL uses `acct.provider` verbatim (lowercase `gmail` or `outlook`, matching DB values), producing `/api/accounts/connect/gmail` or `/api/accounts/connect/outlook` — the same paths already used in the sidebar connect links.

#### 2b. Pencil (rename) button

- Positioned next to the account label text in the card header
- Clicking it replaces the label `<div>` with an `<input>` pre-filled with `acct.label || acct.email`, plus **Save** and **Cancel** buttons
- **Save**: calls `PATCH /api/accounts/:id/label` with `{ label: inputValue.trim() }`, updates the matching entry in `accountsData` in memory, re-renders the card and the sidebar (`renderAccounts()`)
- **Cancel**: reverts the card to display mode with no API call
- Keyboard: Enter = Save, Escape = Cancel
- Empty label is allowed (the backend accepts any string); if saved empty, display falls back to `acct.email`

#### 2c. Delete button

- Red × or trash button on the card
- Calls `openConfirm()` in **simple mode** (see Section 3) with the message:
  > Remove **[label or email]**? This deletes all its synced emails from this device. Your actual mailbox is not affected.
- Confirmed action:
  1. Calls `DELETE /api/accounts/:id`
  2. Removes the account from `accountsData`
  3. Calls `renderAccounts()` (sidebar) and `renderSettingsAccounts()` (settings list)
  4. Shows `showToast('Account removed.')`

---

## 3. `openConfirm()` Simple Mode Extension

**Current signature:** `openConfirm(message, action)`

**New signature:** `openConfirm(message, action, { simple = false } = {})`

### When `simple = true`

1. Add `id="confirm-type-label"` to the "Type DELETE to confirm" `<div>` in `index.html` (currently it has only `class="confirm-type-label"`), then hide it via `style.display = 'none'`
2. Hide `#confirm-input` via `style.display = 'none'` — a hidden input cannot receive user input events, so the inline `oninput` handler (`oninput="document.getElementById('confirm-submit').disabled=this.value!=='DELETE'"`) will never trigger. There is no need to remove or modify the `oninput` attribute.
3. Set `#confirm-submit.disabled = false` immediately (do not call `.focus()` on the hidden input)
4. Skip the `setTimeout(() => confirmInput.focus(), 100)` call that normal mode uses

### `closeConfirm()` — always runs the full restore

`closeConfirm()` must **always** (unconditionally, regardless of which mode opened the modal) perform all of:

1. Restore `#confirm-type-label` to `style.display = ''`
2. Restore `#confirm-input` to `style.display = ''`
3. Clear `#confirm-input.value = ''`
4. Set `#confirm-submit.disabled = true`
5. Reset `#confirm-submit.textContent = 'Delete'` — this fixes a pre-existing gap where `runConfirmedAction()` sets the button to `'Deleting…'` during execution and only resets it in the `catch` path, leaving it as `'Deleting…'` on success

This unconditional restore ensures neither simple-mode nor normal-mode callers leave the modal in a broken state for the next caller.

Note: some existing callers (e.g. `confirmResync`, `confirmWipeAll`) call `closeConfirm()` themselves inside their action callbacks, and `runConfirmedAction()` also calls it on success — meaning `closeConfirm()` may be called twice. All restore operations (setting `style.display`, clearing value, setting `disabled`, resetting text) are idempotent, so double-calling is safe and requires no guard.

---

## 4. Data Flow Summary

```
User clicks 🗑 delete
  → openConfirm(msg, action, { simple: true })
  → modal shows with no type-DELETE input, Delete button enabled
  → user clicks Delete
  → DELETE /api/accounts/:id
  → accountsData.splice(index, 1)
  → renderAccounts() + renderSettingsAccounts()
  → showToast('Account removed.')
  → closeConfirm() restores modal to default state

User clicks ✏ pencil
  → card enters edit mode (input + Save/Cancel)
  → user types new label, presses Enter or clicks Save
  → PATCH /api/accounts/:id/label { label: "..." }
  → accountsData[index].label = newLabel
  → re-render card + renderAccounts()

Sync fails with auth error (invalid_grant / 401 / etc.)
  → sync-engine sets token_expired = 1 WHERE id = accountId
  → next GET /api/accounts returns token_expired: 1
  → renderSettingsAccounts() shows red re-auth badge with reconnect link

User clicks reconnect link
  → navigates to /api/accounts/connect/gmail (or outlook)
  → OAuth callback upserts token, then UPDATE accounts SET token_expired = 0 WHERE id = accountId
  → next loadAccounts() shows green sync badge
```

---

## 5. Test Coverage

### Automated test additions

**`tests/routes/accounts.test.ts`** — add:
- `PATCH /api/accounts/:id/label` with empty string (valid — returns 200)
- `DELETE /api/accounts/:id` cascades emails: insert an email for the account, delete the account, verify email count = 0
- `GET /api/accounts` returns `token_expired` field (value `0` by default)

**`tests/email/sync-engine.test.ts`** (new file) — add:
- Sync success: `token_expired` is set to `0` after a successful sync even if it was previously `1`
- Sync Gmail auth error: when the email-fetch throws an error containing `invalid_grant`, `token_expired` is set to `1`
- Sync Outlook auth error: when the email-fetch throws `"Outlook account not found in MSAL cache — re-auth required"`, `token_expired` is set to `1`
- Sync non-auth error (e.g. network timeout message): `token_expired` is NOT set to `1`

### Manual checklist (Settings modal)

1. Open Settings → "Connected accounts" shows all accounts with last-sync time or "Never synced"
2. Click pencil icon → label becomes editable input pre-filled with current label
3. Type a new name, press Enter → label updates in sidebar and settings card, no page reload
4. Press Escape during rename → reverts with no API call
5. Click × delete button → simple confirm modal appears (no type-DELETE input, Delete button immediately enabled)
6. Confirm delete → account disappears from sidebar and settings list, "Account removed." toast shown
7. After delete, open confirm modal for another action (e.g. wipe-all) → modal is back in normal mode (type-DELETE input visible, button disabled)
8. Simulate auth expiry (SQLite: `UPDATE accounts SET token_expired = 1 WHERE ...`) → reload → red re-auth badge appears on card
9. Click reconnect link → OAuth flow starts; on successful return the badge is gone

---

## 6. Files Changed

| File | Change |
|---|---|
| `src/db/migrations.ts` | Migration 5: add `token_expired` column |
| `src/email/sync-engine.ts` | Set/clear `token_expired` on auth errors and success |
| `src/server.ts` | Clear `token_expired` after successful OAuth callback (Gmail + Outlook) |
| `src/routes/accounts.ts` | Add `token_expired` to GET SELECT |
| `frontend/app.js` | `renderSettingsAccounts()` with rename/delete/badge; extend `openConfirm()`; fix `closeConfirm()` restore |
| `frontend/index.html` | CSS for rename input, status badge, pencil and delete buttons |
| `tests/routes/accounts.test.ts` | New test cases for empty label, cascade delete, token_expired field |
| `tests/email/sync-engine.test.ts` | New test file for token_expired set/clear behaviour |

---

## Next Session Prompt (Plan 5 Implementation)

```
We are building InboxMY — a privacy-first, locally-priced unified email dashboard for Malaysia.
It aggregates Gmail and Outlook accounts (up to 6), parses Malaysian bills (TNB, Unifi, Celcom/Maxis/Digi,
Touch 'n Go, LHDN, MySejahtera, Shopee, Lazada), and stores everything AES-256-GCM encrypted in a local
SQLite database. Nothing is sent to any cloud.

Completed so far:
- Plan 1 (Backend): 100% complete — encrypted SQLite, OAuth flows (Gmail + Outlook), sync engine,
  Malaysian bill parsers (TNB, Unifi, Maxis, TnG, LHDN, Shopee, Lazada), REST API. 7 test files.
- Plan 2 (Frontend Wiring): 100% complete — frontend/app.js wires all dashboard panels to the live API
  (email list, detail, accounts sidebar, bills panel, sync button, infinite scroll, error handling).
- Plan 3 (OAuth Credentials Setup): 100% complete — npm run setup wizard, startup config validator with
  checklist, SETUP.md full reference guide, README roadmap remodel. 2 test files.
- Plan 4 (Multi-User Architecture): 100% complete — user sign-up/sign-in (email + password), per-user
  AES-256-GCM encrypted data keys, HTTP-only cookie sessions (30-day absolute TTL), forgot-password +
  reset-password with key re-wrap, requireAuth middleware on all API routes, OAuth state relay,
  frontend auth.html login/signup page, sign-out button. 3 test files. 71 tests total passing.

Today's goal is implementing Plan 5: Account Management UI.
The design spec is at docs/superpowers/specs/2026-03-27-plan5-account-management-ui-design.md
The implementation plan is at docs/superpowers/plans/2026-03-27-plan5-account-management-ui.md

Key decisions already made:
- All management controls live in the Settings modal only (sidebar stays clean)
- Rename via pencil icon → input + Save/Cancel (Enter/Escape supported)
- Delete via extended openConfirm() simple mode (no type-DELETE required)
- token_expired column added via Migration 5; set by sync engine on auth errors, cleared on reconnect
- GET /api/accounts exposes token_expired; red re-auth badge shown when = 1
- closeConfirm() unconditionally restores all modal state including button text reset to 'Delete'

Do NOT break existing UI. Enhance only. Use the writing-plans skill to review the spec, then implement.
```
