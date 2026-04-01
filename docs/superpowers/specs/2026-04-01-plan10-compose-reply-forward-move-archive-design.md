# Plan 10: Compose / Reply / Forward + Move / Archive

**Date:** 2026-04-01  
**Status:** Approved  
**Project:** InboxMY (Electron + Express/TypeScript + SQLite)

---

## Overview

Add email sending (compose, reply, forward) and folder management (move, archive, spam) to InboxMY. This closes the biggest functional gap between InboxMY and BlueMail: currently InboxMY is read-only.

---

## Architecture

```
Backend
  src/auth/gmail.ts          add gmail.send scope to SCOPES array in getAuthUrl()
  src/auth/outlook.ts        add Mail.Send scope to SCOPES constant
  src/email/send.ts          new: send abstraction (Gmail API + Graph API)
  src/routes/emails.ts       extend: POST /send, PATCH /:id/folder,
                                      add 'archive' to listQuery folder enum

Frontend
  frontend/app.js            extend: openCompose(), closeCompose(), sendEmail(),
                                      moveEmail(), FOLDER_PARAMS, titles map,
                                      setFolder, quoted-message setting
  frontend/index.html        minor: wire up action buttons, Forward button,
                                      account picker in compose, Archive sidebar,
                                      Settings toggle
```

**Send strategy:** Reuses existing OAuth infrastructure.
- Gmail → `getAuthedClient(accountId)` (googleapis) → `gmail.users.messages.send` (base64url-encoded RFC 2822 MIME)
- Outlook → `getAccessToken(accountId)` → `POST https://graph.microsoft.com/v1.0/me/sendMail` (JSON)

No new SMTP server config required.

**Move/Archive:** Local-only — `PATCH /api/emails/:id/folder` updates the `folder` column. `archive` is a valid folder value alongside `inbox`, `sent`, `spam`, `trash`. No sync back to provider.

---

## Backend Components

### `src/auth/gmail.ts` — scope addition

In `getAuthUrl()`, add `https://www.googleapis.com/auth/gmail.send` to the scopes array (currently hardcoded at lines ~20–24). Existing accounts must disconnect and reconnect to grant this scope.

### `src/auth/outlook.ts` — scope addition

In the `SCOPES` constant (line ~9), add `'Mail.Send'`. Existing accounts must disconnect and reconnect.

### `src/routes/emails.ts` — listQuery update

Add `'archive'` to the existing `folder` zod enum:

```typescript
folder: z.enum(['inbox', 'sent', 'spam', 'draft', 'trash', 'archive']).optional()
```

### `src/email/send.ts` (new)

```typescript
sendEmail(accountId: string, opts: {
  to: string,
  subject: string,
  bodyHtml: string,
}): Promise<void>
```

- Looks up `provider` and `email` (sender address) from `accounts` table
- **Gmail:** `getAuthedClient(accountId)` → build RFC 2822 MIME with `From`, `To`, `Subject`, `Content-Type: text/html; charset=utf-8` headers → base64url-encode → `gmail.users.messages.send({ userId: 'me', requestBody: { raw: encoded } })`
- **Outlook:** `getAccessToken(accountId)` → `POST /v1.0/me/sendMail` with JSON body containing `message.toRecipients`, `message.subject`, `message.body`
- `In-Reply-To` / `References` threading headers are **out of scope for Plan 10**: the DB does not store RFC 2822 Message-IDs (only provider thread IDs), so these headers cannot be set correctly without a schema change. Threading via quoted-body quoting is sufficient for v1.
- Throws on failure; does not catch token errors

**Token expiry errors** are caught in the route handler:
- Outlook: string includes `'re-auth required'` → 401 `{ error: 'Re-authentication required', reconnect: true }`
- Gmail: googleapis throws with `code: 401` or `code: 403` → 401 `{ error: 'Re-authentication required', reconnect: true }`
- All other errors → 502 `{ error: 'Send failed' }`

### `POST /api/emails/send` (new in emails.ts)

Request body (zod-validated):

```typescript
{
  to: z.string().email(),
  subject: z.string().max(500),
  body: z.string().max(51200),     // 50 KB
  replyToEmailId: z.string().uuid().optional(),
  accountId: z.string().optional(),
}
```

Logic:
1. If `replyToEmailId` → fetch email (with account join on `user_id`), else 404
2. Else → require `accountId` (else 400), verify `accounts.user_id = req.user.id`, else 404
3. Call `sendEmail(accountId, { to, subject, bodyHtml: body })`
4. On auth error → 401 `{ error: 'Re-authentication required', reconnect: true }`. No DB write.
5. On other provider error → 502 `{ error: 'Send failed' }`. No DB write.
6. On success: INSERT sent copy into `emails` table. Encrypt using `req.user.dataKey` (same key used for all user data reads/writes in this codebase):

```
id:           randomUUID()
account_id:   accountId
thread_id:    originalEmail.thread_id  (if reply/forward) | null (if compose)
subject_enc:  encrypt(subject, req.user.dataKey)
sender:       account.email            (the sending account's email address)
sender_name:  account.label ?? null    (account label if set, else null — no fallback to email)
received_at:  Date.now()
is_read:      1
folder:       'sent'
tab:          'primary'
is_important: 0
category:     null
body_enc:     encrypt(body, req.user.dataKey)
snippet:      encrypt(body.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 200), req.user.dataKey)
              // strip HTML tags first, then collapse whitespace, then take first 200 chars
raw_size:     body.length
```

7. Return `{ id: newEmailId }`

**Note on ownership violations:** Returns 404 (not 403) — consistent with all existing routes in this codebase where ownership is enforced via SQL JOIN (unowned resources simply do not exist from the query's perspective).

### `PATCH /api/emails/:id/folder` (new in emails.ts)

Request body (zod-validated):
```typescript
{ folder: z.enum(['inbox', 'sent', 'spam', 'draft', 'trash', 'archive']) }
```

- Validates user ownership: `account_id IN (SELECT id FROM accounts WHERE user_id = ?)`
- If no row matched: 404
- `UPDATE emails SET folder = ? WHERE id = ? AND account_id IN (...)`
- Returns `{ ok: true }`

---

## Frontend Components

### `openCompose(mode, emailId?)`

| Mode | To | Subject | Body | accountId source |
|------|----|---------|------|-----------------|
| `compose` | empty | empty | empty | account picker `<select id="compose-account">` |
| `reply` | original sender email | `Re: <original subject>` | quoted body if `setting_quotedReply = true` | from original email's `account_id` (hidden) |
| `forward` | empty | `Fwd: <original subject>` | quoted body always | from original email's `account_id` (hidden) |

Quoted body format:
```
\n\n---\nOn <date>, <senderName> <<sender>> wrote:\n<original body plain text>
```

State stored on open: `currentComposeReplyToId` (reply/forward), `currentComposeAccountId` (compose).

**"Re: Re:" prefix:** No deduplication. Simple prepend. Acceptable for v1.

### `sendEmail()`

1. Collect `{ to, subject, body }` from modal fields
2. Build POST body: include `replyToEmailId` if set, else `accountId` from picker
3. POST to `/api/emails/send`
4. Show spinner on Send button, disable form during flight
5. On 200: `closeCompose()`, `showToast('Sent!')`, refresh email list
6. On 401 `{ reconnect: true }`: `showToast('Please reconnect your account in Settings')`, keep modal open
7. On other error: `showToast('Failed to send — please try again')`, keep modal open

### `closeCompose()`

Hides modal, clears all fields, resets `currentComposeReplyToId` and `currentComposeAccountId`.

### `moveEmail(id, folder)`

1. `PATCH /api/emails/${id}/folder` with `{ folder }`
2. On success: `showToast(label)`, hide detail panel, refresh list
3. On error: `showToast('Action failed')`

Button wiring:
- Archive → `moveEmail(currentEmailId, 'archive')`
- Spam → `moveEmail(currentEmailId, 'spam')`
- Reply → `openCompose('reply', currentEmailId)`
- Forward (new button) → `openCompose('forward', currentEmailId)`

### Archive folder support in `app.js`

Three locations must be updated:

1. **`FOLDER_PARAMS`** (object mapping folder names to API params): add `archive: { folder: 'archive' }`
2. **`titles`** map (used in `setFolder` to set the list header): add `archive: 'Archive'`
3. **`setFolder()`**: no logic change needed — adding the two entries above is sufficient

### Settings toggle — "Include quoted message when replying"

- `localStorage` key: `setting_quotedReply` (default `true`)
- Applies only to Reply; Forward always includes quoted body regardless of this setting
- Added to the existing Settings section in the UI

### `index.html` changes (minimal)

- Archive/Spam buttons: replace placeholder `showToast(...)` onclick with `moveEmail(...)`
- Reply button: change onclick to `openCompose('reply', currentEmailId)`
- Add `<button onclick="openCompose('forward', currentEmailId)">Forward</button>` next to Reply
- Add `<select id="compose-account">` inside compose modal (hidden when replying/forwarding)
- Add Archive entry to sidebar folder list: `<li onclick="setFolder('archive')">Archive</li>`
- Add "Include quoted message" toggle to Settings section

---

## Data Flow

```
User clicks Send
  → sendEmail() collects { to, subject, body, replyToEmailId / accountId }
  → POST /api/emails/send
  → Backend: zod validate → ownership check (404 if fail)
  → sendEmail(accountId, { to, subject, bodyHtml })
  → Gmail API (base64url MIME) / Outlook Graph API (JSON)
  → On provider success: encrypt with req.user.dataKey → INSERT sent copy → return { id }
  → Frontend: closeCompose(), showToast('Sent!'), refreshList()
```

```
User clicks Archive / Spam
  → moveEmail(currentEmailId, folder)
  → PATCH /api/emails/:id/folder
  → Backend: ownership check (404 if fail) → UPDATE folder
  → Frontend: hide detail panel, showToast, refreshList()
```

---

## Error Handling

| Scenario | HTTP | Frontend behaviour |
|----------|------|--------------------|
| Provider send failure (network, API) | 502 | Keep modal open, toast "Failed to send" |
| Provider token expired / re-auth | 401 `{ reconnect: true }` | Toast "Please reconnect your account" |
| Invalid `to` address | 400 | Inline field error |
| `body` exceeds 50 KB | 400 | Toast error |
| Missing `accountId` (compose, no reply) | 400 | Toast error |
| Email / account not found or wrong user | 404 | Toast "Not found" |
| Invalid folder value in PATCH | 400 | Prevented by hardcoded button values |

---

## Testing Strategy (TDD — tests written before implementation)

### `tests/routes/send.test.ts` (new)

Mock `src/email/send.ts` entirely with `vi.mock`. Cover:
- 401 without session cookie
- Happy path: 200, sent copy in DB with correct fields (`folder='sent'`, `is_read=1`, correct `account_id`, encrypted subject/body)
- Auto-pick `accountId` from valid `replyToEmailId`
- Missing `accountId` with no `replyToEmailId` → 400
- Invalid `to` (not an email address) → 400
- `body` over 50 KB → 400
- `replyToEmailId` not found or owned by another user → 404
- `sendEmail` throws generic error → 502, no DB row inserted
- `sendEmail` throws re-auth error string → 401 `{ reconnect: true }`, no DB row inserted

### `tests/routes/emails.test.ts` (append)

- `PATCH /:id/folder` valid move → 200 `{ ok: true }`
- `PATCH /:id/folder` invalid folder value → 400
- `PATCH /:id/folder` email owned by another user → 404
- `GET /` with `folder=archive` → 200 (validates enum update)

### `tests/email/send.test.ts` (new)

Unit-test `src/email/send.ts` using `vi.mock`:

**Gmail tests:**
```typescript
vi.mock('../../../src/auth/gmail', () => ({
  getAuthedClient: vi.fn().mockResolvedValue({
    // minimal shape needed: gmail client needs google.gmail({ version, auth })
    // mock at the google.gmail level via vi.mock('googleapis')
  })
}))
```
Mock `googleapis` so `gmail.users.messages.send` is a spy. Assert:
- Called with `{ userId: 'me', requestBody: { raw: <string> } }`
- `Buffer.from(raw, 'base64url').toString()` contains `From:`, `To:`, `Subject:`, `Content-Type:`

**Outlook tests:**
- Mock `getAccessToken` to return a fake token string
- Mock global `fetch` (or node-fetch) to return `{ ok: true }`
- Assert `fetch` called with `https://graph.microsoft.com/v1.0/me/sendMail` and correct JSON body
- Assert auth error from `getAccessToken` propagates (is not swallowed by `sendEmail`)

---

## Constraints & Out-of-Scope

- **No schema migration needed:** `folder` column already exists; `archive` is just a new valid value
- **Sent copies are local only:** Will not appear in Gmail/Outlook "Sent" folders on other devices
- **No CC / BCC:** Out of scope for Plan 10
- **No draft auto-save:** Out of scope for Plan 10
- **No email threading headers:** `In-Reply-To` / `References` omitted — DB stores provider thread IDs, not RFC 2822 Message-IDs. Threading is indicated by quoted body only. Deferred to a future plan.
- **"Re: Re:" deduplication:** Not implemented in v1; simple "Re: " prefix prepend only
- **Body is HTML:** Plain-text fallback: wrap plain text in `<p>` tags before sending
- **Existing accounts need reconnect:** Adding `gmail.send` and `Mail.Send` scopes requires users to disconnect and reconnect each account
- **Ownership violations return 404:** Consistent with all existing routes in this codebase
