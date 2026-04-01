# Plan 10: Compose / Reply / Forward + Move / Archive

**Date:** 2026-04-01  
**Status:** Approved  
**Project:** InboxMY (Electron + Express/TypeScript + SQLite)

---

## Overview

Add email sending (compose, reply, forward) and folder management (move, archive, spam) to InboxMY. This closes the biggest functional gap between InboxMY and BlueMail: currently InboxMY is read-only.

---

## Architecture

Three new pieces slot into the existing structure:

```
Backend
  src/email/send.ts          new: send abstraction (Gmail API + Graph API)
  src/routes/emails.ts       extend: POST /send, PATCH /:id/folder

Frontend
  frontend/app.js            extend: openCompose(), closeCompose(), sendEmail(),
                                      moveEmail(), quoted-message setting
  frontend/index.html        minor: wire up action buttons, Forward button,
                                      account picker in compose, Settings toggle

OAuth scopes
  src/auth/gmail.ts          add gmail.send scope
  src/auth/outlook.ts        add Mail.Send scope
```

**Send strategy:** Reuses existing OAuth infrastructure.
- Gmail → `getAuthedClient(accountId)` (googleapis) → `gmail.users.messages.send`
- Outlook → `getAccessToken(accountId)` → `POST https://graph.microsoft.com/v1.0/me/sendMail`

No new SMTP server config required.

**Move/Archive:** Local-only — `PATCH /api/emails/:id/folder` updates the `folder` column. `archive` is a valid folder value alongside `inbox`, `sent`, `spam`, `trash`. No sync back to provider.

---

## Backend Components

### `src/email/send.ts` (new)

```
sendEmail(accountId, { to, subject, bodyHtml })
  → look up provider from accounts table
  → Gmail: getAuthedClient(accountId) → gmail.users.messages.send (base64 MIME)
  → Outlook: getAccessToken(accountId) → POST /v1.0/me/sendMail (JSON)
  → returns void, throws on failure
```

### `POST /api/emails/send` (new in emails.ts)

Request body (zod-validated):
```typescript
{
  to: string,            // valid email address
  subject: string,       // max 500 chars
  body: string,          // HTML or plain text, max 50 KB
  replyToEmailId?: string,  // if set, auto-picks accountId from original email
  accountId?: string,       // required if replyToEmailId not provided
}
```

Logic:
1. If `replyToEmailId` provided → fetch that email, verify user owns it, extract `account_id`
2. Else → use `accountId` from body, verify user owns that account
3. Validate fields with zod
4. Call `sendEmail(accountId, { to, subject, bodyHtml: body })`
5. Encrypt and INSERT sent copy: `folder='sent'`, `is_read=1`, `received_at=Date.now()`
6. Return `{ id: newEmailId }`

### `PATCH /api/emails/:id/folder` (new in emails.ts)

Request body:
```typescript
{ folder: 'inbox' | 'sent' | 'spam' | 'draft' | 'trash' | 'archive' }
```

- Validates user ownership via account join
- `UPDATE emails SET folder = ? WHERE id = ? AND account_id IN (...)`
- Returns `{ ok: true }`

### OAuth scope additions

| Provider | File | Scope to add |
|----------|------|-------------|
| Gmail | `src/auth/gmail.ts` | `https://www.googleapis.com/auth/gmail.send` |
| Outlook | `src/auth/outlook.ts` | `Mail.Send` |

Existing connected accounts must disconnect and reconnect to grant the new scopes. A UI notice is shown on the Accounts page when a send attempt fails due to insufficient permissions.

---

## Frontend Components

### `openCompose(mode, emailId?)`

| Mode | To | Subject | Body | accountId source |
|------|----|---------|------|-----------------|
| `compose` | empty | empty | empty | account picker shown |
| `reply` | original sender | `Re: <original>` | quoted body if setting ON | hidden (auto from original) |
| `forward` | empty | `Fwd: <original>` | quoted body always | hidden (auto from original) |

Quoted body format:
```
\n\n---\nOn <date>, <sender> wrote:\n<original body>
```

Stores `replyToEmailId` (reply/forward) or reads `accountId` from picker (compose).

### `sendEmail()`

1. Collect fields from modal
2. POST to `/api/emails/send`
3. Show spinner on Send button, disable form during flight
4. On success: `closeCompose()`, `showToast('Sent!')`, refresh email list
5. On error: `showToast('Failed to send — please try again')`, keep modal open (preserve draft)

### `closeCompose()`

Hides modal, clears all fields, resets `replyToEmailId` state.

### `moveEmail(id, folder)`

1. `PATCH /api/emails/${id}/folder` with `{ folder }`
2. On success: `showToast(label)`, hide detail panel, refresh list

Button wiring:
- Archive → `moveEmail(currentEmailId, 'archive')`
- Spam → `moveEmail(currentEmailId, 'spam')`
- Reply → `openCompose('reply', currentEmailId)`
- Forward (new button) → `openCompose('forward', currentEmailId)`

### Settings toggle — "Include quoted message when replying"

- Key: `localStorage` → `setting_quotedReply` (default `true`)
- Applies only to Reply; Forward always includes quoted body
- Added to the existing Settings section in the UI

### `index.html` changes (minimal)

- Archive/Spam buttons: replace placeholder `showToast(...)` with `moveEmail(...)`
- Reply button: `openCompose('reply', currentEmailId)`
- Add Forward button next to Reply
- Add `<select id="compose-account">` inside compose modal (hidden for reply/forward)
- Add "Include quoted message" toggle to Settings section

---

## Data Flow

```
User clicks Send
  → sendEmail() collects { to, subject, body, replyToEmailId / accountId }
  → POST /api/emails/send
  → Backend: zod validate
  → sendEmail(accountId, ...) → Gmail API / Graph API
  → Provider success → INSERT encrypted sent copy into DB → return { id }
  → Frontend: closeCompose(), showToast('Sent!'), refreshList()
```

```
User clicks Archive / Spam
  → moveEmail(currentEmailId, folder)
  → PATCH /api/emails/:id/folder
  → Backend: ownership check → UPDATE folder
  → Frontend: hide detail panel, showToast, refreshList()
```

---

## Error Handling

| Scenario | HTTP | Frontend behaviour |
|----------|------|--------------------|
| Provider send failure (token, network) | 502 | Keep modal open, toast "Failed to send" |
| Invalid `to` address | 400 | Inline field error |
| Missing `accountId` (compose, no reply) | 400 | Toast error |
| Account not owned by user | 403 | Toast "Unauthorised" |
| Invalid folder value | 400 | (shouldn't reach user — buttons are hardcoded) |
| Email not found for move | 404 | Toast "Not found" |

---

## Testing Strategy (TDD)

All tests written before implementation.

### `tests/routes/send.test.ts` (new)

Mock `src/email/send.ts`. Cover:
- Happy path: sent copy appears in DB with correct fields
- Auto-pick accountId from `replyToEmailId`
- Missing accountId without replyToEmailId → 400
- Invalid `to` email address → 400
- `replyToEmailId` belonging to another user → 403
- Provider send throws → 502, no DB row inserted

### `tests/routes/emails.test.ts` (append)

- `PATCH /:id/folder` valid move → 200 `{ ok: true }`
- `PATCH /:id/folder` invalid folder → 400
- `PATCH /:id/folder` email owned by another user → 404

### `tests/email/send.test.ts` (new)

Unit-test `sendEmail()` with mocked `getAuthedClient` (Gmail) and mocked `fetch` (Outlook Graph API).

---

## Constraints & Notes

- No schema migration needed: `folder` column already exists (Plan 1 migration)
- Sent copies are stored locally only; they will not appear in Gmail/Outlook "Sent" folders
- `archive` is stored as `folder = 'archive'`; it is never synced back to the provider
- Existing accounts must reconnect after scope addition to gain send permissions
- Body is stored as HTML; plain-text fallback handled by send.ts (wrap in `<p>` tags)
- Draft auto-save is out of scope for Plan 10
