# InboxMY

A privacy-first, locally-priced unified email dashboard for Malaysia. Runs as an **Electron desktop app** — no browser needed, no cloud, no telemetry.

Aggregates Gmail and Outlook accounts, parses Malaysian bills (TNB, Unifi, Maxis/Celcom/Digi, Touch 'n Go, LHDN, Shopee, Lazada), and stores everything AES-256-GCM encrypted in a local SQLite database on your device.

---

## Features

- **Unified inbox** — up to 6 Gmail + Outlook accounts in one view
- **Bill detection + overdue tracking** — Malaysian bill parsers, overdue banner, due-date countdown
- **Windows toast notifications** — background scheduler fires every 60 min; AI-generated copy via Gemini 2.0 Flash (optional, user supplies own key)
- **System tray** — app runs in the background, accessible from the taskbar tray
- **Auto-launch at startup** — optional, toggleable in Settings
- **Deep link navigation** — clicking a toast jumps directly to that bill in the app
- **Search + filtering** — full-text search across sender/subject/snippet; date range presets (today/week/month/3 months) + custom picker; multi-account filter pills with OR logic
- **Privacy** — all data stored locally; API bound to `127.0.0.1`; no telemetry; no InboxMY servers

---

## Installation

```bash
# From the repo root
npm install
npm start
```

`npm start` launches the Electron app. The backend (Express + SQLite) is spawned automatically as a child process — no separate terminal needed.

> **First run:** The app will start but no accounts are connected yet. Open Settings (gear icon) to add Gmail or Outlook accounts. See [SETUP.md](./SETUP.md) for the full OAuth credential guide.

---

## Development

To run the backend and Electron together with live TypeScript compilation:

```bash
npm run electron:dev
```

This rebuilds the backend TypeScript on each change and restarts Electron.

To run only the backend (headless, for API testing):

```bash
cd inboxmy-backend
npm run build && npm start
```

---

## Building a Windows Installer

```bash
npm run dist
```

Produces a Windows installer (`dist/InboxMY Setup x.x.x.exe`) using `electron-builder`. Requires the backend to have been compiled (`inboxmy-backend/dist/`) before running.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Desktop shell | Electron 31 |
| Backend | Node.js / Express (TypeScript) |
| Database | better-sqlite3 (SQLite, WAL mode, AES-256-GCM encrypted) |
| AI notifications | @google/generative-ai — Gemini 2.0 Flash |
| Frontend | Vanilla JS SPA served by Express |
| Auth | OAuth 2.0 — Gmail API + Microsoft Graph |

---

## What's Built

| Layer | Files | Details |
|---|---|---|
| Crypto | `src/crypto.ts`, `src/config.ts` | AES-256-GCM encryption — all email bodies, subjects, and tokens encrypted at rest |
| Database | `src/db/index.ts`, `migrations.ts` | SQLite with WAL mode, versioned migrations |
| Auth | `src/auth/gmail.ts`, `outlook.ts`, `token-store.ts` | OAuth2 for Gmail + Outlook, tokens stored encrypted |
| Email fetch | `src/email/gmail-client.ts`, `outlook-client.ts` | Gmail API + Microsoft Graph, normalised to shared type |
| Parsers | `src/parsers/` (11 files) | TNB, Unifi, Celcom/Maxis/Digi, Touch 'n Go, LHDN, MySejahtera, Shopee, Lazada + generic RM extractor |
| Sync engine | `src/email/sync-engine.ts` | Multi-account sync, runs parsers, writes emails + bills atomically |
| Email send | `src/email/send.ts` | `sendEmail()` abstraction — Gmail (MIME base64url via googleapis) + Outlook (Graph API JSON) |
| REST API | `src/routes/` (8 files) | `/api/accounts`, `/api/emails`, `/api/emails/send`, `/api/emails/unsnooze-due`, `/api/bills`, `/api/sync`, `/api/notifications`, `/api/labels` |
| Server | `src/server.ts` | Express, bound to `127.0.0.1` only, rate-limited, serves frontend statically |
| AI notifier | `src/ai/notifier.ts` | Gemini 2.0 Flash — smart bill summaries with plaintext fallback |
| Electron main | `electron/main.js` | BrowserWindow, system tray, toast notifications, IPC, auto-launch, backend spawner |
| Preload bridge | `electron/preload.js` | contextBridge — `window.inboxmy.*` API (7 methods) |
| Electron utils | `electron/utils.js` | `makeNotificationKey` — deduplication key with UTC date handling |
| Frontend API client | `frontend/app.js` | Vanilla JS — fetches all panels from the backend API, overdue banner, deep-link navigation, AI settings, date/account filters |
| Dashboard | `frontend/index.html` | Full email dashboard — accounts, email list, email detail, bills panel, sync button, settings, date filter row |

---

## Running the Tests

### Run everything (282 tests)

```powershell
# From repo root — runs Electron utils + backend in sequence
npm run test:all
```

### Backend tests (278 tests)

```powershell
cd inboxmy-backend
$env:ENCRYPTION_KEY="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
$env:DATA_DIR="./data-test"
npm test
```

### Utils tests (4 tests)

```powershell
# From repo root
npm run test:utils
```

### Combined: 282 tests total

Test coverage includes: encryption, all bill parsers (TNB, Unifi, Maxis, TnG, LHDN, Shopee, Lazada, MySejahtera, generic, spam-scorer), all API routes (accounts, emails with all filters + snooze + label filters, bills, sync, notifications, send, labels CRUD, email-label assignment), auth middleware + session cookie attributes, sync engine (token-expired flag, dedup, concurrent sync, multi-account), AI notifier, notification scheduler utils, sendEmail abstraction (Gmail + Outlook), Electron notification key utils.

---

### Plan 1 — Backend Core tests

| Test file | What it tests |
|---|---|
| `tests/crypto.test.ts` | AES-256-GCM encryption and decryption round-trip, tamper detection |
| `tests/parsers/tnb.test.ts` | TNB eBill detection, amount extraction (RM format), due date parsing |
| `tests/parsers/lhdn.test.ts` | LHDN domain and subject matching |
| `tests/parsers/shopee.test.ts` | Shopee order reference and amount extraction |
| `tests/parsers/generic-bill.test.ts` | Generic Malaysian RM amount and date parsing |
| `tests/parsers/remaining.test.ts` | Unifi, Celcom/Maxis, Touch 'n Go, Lazada parser coverage |
| `tests/routes/accounts.test.ts` | GET /api/accounts, PATCH label, DELETE account |

---

### Plan 2 — Frontend Wiring tests

Plan 2 is all frontend (vanilla JS). There are no automated tests — use the manual checklist below:

1. Start the app (`npm start`) — Electron window opens
2. Dashboard loads without console errors
3. Email list panel shows placeholder state when no accounts are connected
4. Accounts sidebar renders "No accounts connected" when empty
5. Bills panel renders "No bills found" when empty
6. Click **↻ Sync** — button shows "↻ Syncing…" and then "Sync complete!" toast appears
7. Connect a Gmail or Outlook account via Settings — account appears in the sidebar
8. After sync completes, emails appear in the list with sender, subject, and date
9. Click an email row — detail pane renders subject, sender, body
10. Infinite scroll: scroll to bottom of email list — next 50 emails load
11. Category tabs (`All`, `Unread`, `Bills`, `Govt`, `Receipts`) filter the list
12. Search bar filters by sender name as you type

---

### Plan 3 — OAuth Credentials Setup tests

| Test file | What it tests |
|---|---|
| `tests/config.test.ts` | validateConfig() checklist output — Gmail/Outlook [✓]/[ ] states |
| `tests/setup.test.ts` | isValidGoogleClientId, isValidAzureClientId, isValidSecret, buildEnvContent |

To run just Plan 3 tests:
```powershell
$env:ENCRYPTION_KEY="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
$env:DATA_DIR="./data-test"
npx vitest run tests/config.test.ts tests/setup.test.ts
```

---

### Plan 4 — Multi-User Architecture tests

| Test file | What it tests |
|---|---|
| `tests/routes/auth.test.ts` | POST /auth/signup, POST /auth/login, GET /auth/me, POST /auth/logout |
| `tests/routes/auth-reset.test.ts` | POST /auth/forgot-password (email enumeration safe), POST /auth/reset-password — expired/used token rejection |
| `tests/middleware/auth.test.ts` | requireAuth — valid session passes, no cookie returns 401, fake session returns 401, session older than 30 days returns 401 |

To run just Plan 4 tests:
```powershell
$env:ENCRYPTION_KEY="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
$env:DATA_DIR="./data-test"
npx vitest run tests/routes/auth.test.ts tests/routes/auth-reset.test.ts tests/middleware/auth.test.ts
```

Manual test checklist for Plan 4 (requires running server):

1. App opens → redirects to `/auth`
2. Sign up → redirected to dashboard, HttpOnly `session` cookie set
3. Refresh → still logged in
4. Sign Out → redirected to `/auth`, back button blocked
5. Sign in again → dashboard loads
6. Sign in with wrong password → "Invalid email or password"
7. Open incognito, sign up as a different user, connect a Gmail account → original user's accounts panel does not show the new account
8. Forgot password → check server console for reset link → click link → new password works, old password rejected
9. After password reset, existing sessions are invalidated

---

### Plan 5 — Account Management UI tests

| Test file | What it tests |
|---|---|
| `tests/routes/accounts.test.ts` | GET returns `token_expired` field; empty-string label accepted; DELETE cascades to emails |
| `tests/email/sync-engine.test.ts` | `token_expired=1` on Gmail `invalid_grant`; Outlook re-auth error; no flag on non-auth errors; clears on success |

To run just Plan 5 tests:
```powershell
$env:ENCRYPTION_KEY="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
$env:DATA_DIR="./data-test"
npx vitest run tests/routes/accounts.test.ts tests/email/sync-engine.test.ts
```

Manual test checklist for Plan 5 (requires running app):

1. Open Settings → account cards show ✏ rename button and × delete button
2. Click ✏ → label becomes editable input → Enter saves → sidebar updates instantly
3. Escape during rename → reverts with no API call
4. Click × → simple confirm modal (no type-DELETE), Delete immediately enabled
5. Confirm delete → account gone from sidebar and settings, toast shown
6. After delete, open wipe-all confirm → type-DELETE input is back (modal restored correctly)
7. Set `token_expired=1` in DB → reload → red "⚠ Auth expired — Reconnect" badge on card
8. Reconnect link points to correct `/api/accounts/connect/gmail` (or `outlook`)

---

### Plan 6 — Notifications + Overdue Detection (Electron) tests

| Test file | What it tests |
|---|---|
| `tests/routes/notifications.test.ts` | GET /api/notifications/due-soon (overdue + 72h window), POST /api/notifications/ai-summary (401 no auth, 400 missing fields, 200 empty), PATCH /api/bills/auto-mark-overdue |
| `tests/ai/notifier.test.ts` | Gemini 2.0 Flash integration, fallback to plain copy on error, shouldNotify=false for paid bills |
| `electron/utils.test.js` | makeNotificationKey — UTC month/year, deduplication across timezones |

To run just Plan 6 backend tests:
```powershell
$env:ENCRYPTION_KEY="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
$env:DATA_DIR="./data-test"
npx vitest run tests/routes/notifications.test.ts tests/ai/notifier.test.ts
```

To run just Plan 6 utils tests (from repo root):
```powershell
npm run test:utils
```

Manual test checklist for Plan 6 (requires running Electron app):

1. Open Settings → "AI & Notifications" section visible
2. Enter a Gemini API key → "Active" status shown
3. Clear the key → "Not configured" shown
4. Toggle "Launch at startup" → toast confirms
5. Add a bill with due date within 72 hours → within 60 min (or after restarting app) a Windows toast appears
6. Click "View Bill" on the toast → app focuses and scrolls to that bill
7. Overdue bills → orange banner appears at top of bills panel showing count + total RM
8. Banner "View all" → filters bills panel to overdue
9. Banner × dismiss → banner hidden; reappears after fresh app restart (not within same session)
10. System tray icon visible → right-click → "Show InboxMY" and "Quit" options work
11. Close window (×) → app minimises to tray, does NOT quit
12. Quit via tray menu → app fully exits

---

### Plan 7 — Search + Filtering tests

| Test file | What it tests |
|---|---|
| `tests/routes/emails.test.ts` | `dateFrom`/`dateTo` boundary + inversion + validation; `accountIds` single/multi/cross-user/empty; in-memory search on sender/subject/snippet; search + date + accountIds combined; `total` count; pagination |

To run just Plan 7 tests:
```powershell
$env:ENCRYPTION_KEY="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
$env:DATA_DIR="./data-test"
npx vitest run tests/routes/emails.test.ts
```

Manual test checklist for Plan 7 (requires running app):

1. Date preset pills appear between search bar and the All/Unread/Bills row
2. Click **Today** → highlights, list reloads with today's emails only; click again → deactivates
3. **This week / This month / Last 3 months** each filter correctly
4. Click **Custom ▾** → date inputs open; fill dates + Apply → list filters; pill shows **Custom ✕**; click → clears
5. Switch sidebar folder → date pills reset automatically
6. Search + date preset combined → only matching emails within the date range
7. 2+ accounts connected → account pills appear on the right side of the filter row
8. Click one pill → that account's emails only; click second pill → both accounts (OR logic)
9. Click active pill → deactivates; **× Clear filters** link visible when any filter active; click → resets date + account filters (search box and unread toggle unchanged)
10. With only 1 account → no account pills rendered

---

### Plan 8 — Test Coverage (High Priority Routes)

| Test file | What it tests |
|---|---|
| `tests/routes/emails.test.ts` | `GET /api/emails` basic list + pagination shape, `GET /api/emails/:id` single email + 404 + cross-user guard, `PATCH /api/emails/:id/read` mark-read idempotency + cross-user safety, `DELETE /api/emails` wipe + `last_synced` reset |
| `tests/routes/bills.test.ts` | `GET /api/bills` list + status filter + sort order + field shape + cross-user isolation, `PATCH /api/bills/:id/status` paid/unpaid/overdue transitions + 400/404 guards |

To run just Plan 8 tests:
```powershell
$env:ENCRYPTION_KEY="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
$env:DATA_DIR="./data-test"
npx vitest run tests/routes/bills.test.ts tests/routes/emails.test.ts
```

---

### Plan 9 — Test Coverage (Medium Priority + Bug Fixes)

| Test file | What it tests |
|---|---|
| `tests/parsers/mysejahtera.test.ts` | MySejahtera sender/subject matching + `govt` category classification |
| `tests/parsers/spam-scorer.test.ts` | Trigger phrases, structural signals (caps, punctuation, $$$), link density, sender mismatch, non-inbox skip |
| `tests/routes/emails.test.ts` | `folder` filter (inbox/spam/sent + invalid 400), `tab` filter (promotions/primary + invalid 400), `unread=1`/`unread=true` filter |
| `tests/routes/auth.test.ts` | Session cookie is HttpOnly + SameSite=Lax on signup and login; rate-limit skip documented |
| `tests/routes/accounts.test.ts` | 6-account cap on `connect/gmail` + `connect/outlook` (400 when at limit, 302 redirect when under) |
| `tests/email/sync-engine.test.ts` | Concurrent `syncAccount` calls for same account insert each email exactly once |

**Production bugs found and fixed by Plan 9:**
- `EMAIL_SELECT` in `emails.ts` was missing `folder`, `tab`, `is_important` — email list responses were incomplete
- 6-account cap was documented but not enforced in `accounts.ts` — now enforced in `connect/gmail` and `connect/outlook`

To run just Plan 9 tests:
```powershell
$env:ENCRYPTION_KEY="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
$env:DATA_DIR="./data-test"
npx vitest run tests/parsers/mysejahtera.test.ts tests/parsers/spam-scorer.test.ts tests/routes/accounts.test.ts tests/routes/auth.test.ts tests/email/sync-engine.test.ts
```

---

### Plan 10 — Compose + Move/Archive (Backend)

| Test file | What it tests |
|---|---|
| `tests/email/send.test.ts` | `sendEmail()` — Gmail MIME construction (base64url RFC 2822 payload), Outlook Graph API JSON body, auth error propagation, Graph API non-ok response handling |
| `tests/routes/send.test.ts` | `POST /api/emails/send` — happy path saves encrypted sent copy; auto-picks accountId from replyToEmailId; 400 for missing accountId/invalid email/body > 50 KB; 404 for cross-user account/email; 502 on send failure (no DB row saved); 401 + reconnect:true on re-auth error |
| `tests/routes/emails.test.ts` | `PATCH /api/emails/:id/folder` — moves to valid folder, 400 for invalid folder, 404 cross-user guard, 401 no-auth; `GET /api/emails?folder=archive` — lists archived emails |

To run just Plan 10 tests:
```powershell
$env:ENCRYPTION_KEY="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
$env:DATA_DIR="./data-test"
npx vitest run tests/email/send.test.ts tests/routes/send.test.ts tests/routes/emails.test.ts
```

---

### Plan 11 — Snooze + Focused Inbox + Smart Groups (Labels)

| Test file | What it tests |
|---|---|
| `tests/routes/labels.test.ts` | `GET /api/labels` list + empty + `count` field; `POST` create + 400 name too long + 400 bad hex + 409 duplicate; `PATCH` rename + recolor + 404 cross-user; `DELETE` deletes + cascades `email_labels`; ownership guards throughout |
| `tests/routes/snooze.test.ts` | `PATCH /api/emails/:id/snooze` — sets snooze, 400 past timestamp, 400 >1 year, 404 cross-user, 401 no-auth; `DELETE` clears snooze (idempotent 200 when not snoozed); `GET /api/emails` default excludes snoozed, `?snoozed=1` shows only snoozed, folder view excludes snoozed; `POST /api/emails/unsnooze-due` restores past-due, leaves future-snoozed untouched; `GET /api/emails/unread-count` excludes snoozed emails |
| `tests/routes/email-labels.test.ts` | `POST /api/emails/:id/labels/:labelId` assigns label (idempotent), 404 cross-user email, 404 cross-user label, 401; `DELETE` removes label, 404 cross-user label; `labels` array in list + single email response; unlabelled email has `labels: []`; multi-label email appears exactly once; `?labelId=` filter + 404 cross-user labelId |

To run just Plan 11 tests:
```powershell
$env:ENCRYPTION_KEY="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
$env:DATA_DIR="./data-test"
npx vitest run tests/routes/labels.test.ts tests/routes/snooze.test.ts tests/routes/email-labels.test.ts
```

---

To run a single test file:
```powershell
$env:ENCRYPTION_KEY="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
$env:DATA_DIR="./data-test"
npx vitest run tests/crypto.test.ts
```

To run tests in watch mode (re-runs on file save — useful during development):
```powershell
$env:ENCRYPTION_KEY="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
$env:DATA_DIR="./data-test"
npm run test:watch
```

---

## Plans Reference

All implementation plans live in `docs/superpowers/plans/`.

| # | Plan | Status |
|---|------|--------|
| 1 | Backend Core | ✅ Done |
| 2 | Frontend Wiring | ✅ Done |
| 3 | OAuth Credentials Setup | ✅ Done |
| 4 | Multi-User Architecture | ✅ Done |
| 5 | Account Management UI | ✅ Done |
| 6 | Notifications + Overdue Detection (Electron) | ✅ Done |
| 7 | Search + Filtering Improvements | ✅ Done |
| 8 | Test Coverage — High Priority Routes | ✅ Done |
| 9 | Test Coverage — Medium Priority + Bug Fixes | ✅ Done |
| 10 | Compose + Move/Archive | ✅ Done (backend) |
| 11 | Snooze + Focused Inbox + Smart Groups | ✅ Done |
| 12 | Calendar Integration | ⏳ Pending |

---

## Roadmap

| # | Plan | Key Deliverables | Status |
|---|------|-----------------|--------|
| 1 | **Backend Core** | Encrypted SQLite, OAuth flows (Gmail + Outlook), email sync engine, Malaysian bill parsers (TNB, Unifi, Maxis, TnG, LHDN, Shopee, Lazada), REST API | ✅ Done |
| 2 | **Frontend Wiring** | Dashboard panels wired to live API — email list, email detail, accounts sidebar, bills panel, sync button, infinite scroll, error handling | ✅ Done |
| 3 | **OAuth Credentials Setup** | `npm run setup` wizard, startup config validator with checklist, `SETUP.md` full reference guide, README roadmap remodel | ✅ Done |
| 4 | **Multi-User Architecture** | User sign-up/sign-in (email+password), per-user AES-256-GCM encrypted data keys, HTTP-only cookie sessions (30-day TTL), email-based password reset, auth middleware on all API routes, OAuth state relay, frontend sign-in page | ✅ Done |
| 5 | **Account Management UI** | Rename accounts, delete + revoke, re-auth expired tokens, per-account sync status | ✅ Done |
| 6 | **Notifications + Overdue Detection (Electron)** | Electron desktop app (NSIS installer), system tray, Windows toast notifications, overdue bill banner, deep-link navigation, AI summaries via Gemini 2.0 Flash, Gemini key storage via DPAPI, auto-launch toggle | ✅ Done |
| 7 | **Search + Filtering Improvements** | Full-text in-memory search (sender/subject/snippet), date range filters (presets + custom picker), multi-account filter pills (OR logic) | ✅ Done |
| 8 | **Test Coverage — High Priority Routes** | Full test suite runner (`npm run test:all`), `GET /api/bills`, `PATCH /api/bills/:id/status`, `GET /api/emails` basic list + pagination, `GET /api/emails/:id`, `PATCH /api/emails/:id/read`, `DELETE /api/emails` — 181 tests total, all passing | ✅ Done |
| 9 | **Test Coverage — Medium Priority + Bug Fixes** | MySejahtera + spam-scorer parser tests, email folder/tab/unread filter tests, session cookie attribute tests, 6-account cap enforcement (backend + tests), concurrent sync dedup test — 219 tests total; 2 production bugs found and fixed | ✅ Done |
| 10 | **Compose + Move/Archive** | `sendEmail()` abstraction (Gmail MIME + Outlook Graph), `POST /api/emails/send` (validate, ownership check, save encrypted sent copy, re-auth 401), `PATCH /api/emails/:id/folder` (inbox/sent/spam/draft/trash/archive), OAuth send scopes added — 239 tests total, backend complete; frontend compose UI pending | ✅ Done (backend) |
| 11 | **Snooze + Focused Inbox + Smart Groups** | Snooze emails (`PATCH /api/emails/:id/snooze`, `DELETE /api/emails/:id/snooze`) with auto-restore via `POST /api/emails/unsnooze-due` (Electron tick every 60s); Focused inbox view (`folder=inbox&tab=primary`); user-created labels (`/api/labels` CRUD) with many-to-many email assignment; Gmail-style right-click context menu (snooze presets, move-to, label-as submenus); Focused + Snoozed + Labels sidebar entries — 282 tests total | ✅ Done |
| 12 | **Calendar Integration** | New calendar data domain, Google Calendar + Outlook Calendar via existing OAuth, separate calendar panel in dashboard | ⏳ Pending |

---

## Credentials Setup

For the full step-by-step guide to setting up Google Cloud (Gmail) and Azure Portal (Outlook) OAuth credentials, see [SETUP.md](./SETUP.md).

---

## Multi-User Architecture

InboxMY supports full user authentication and per-user data isolation.

### How it works

- **Sign up** at `/auth` with your email and a password (min 8 characters)
- **Your data is encrypted** with a 256-bit key that only your password can unlock — the server cannot read your emails or bills without it
- **Sessions persist** until you click Sign Out (30-day absolute TTL as a safety net)
- **Password reset** sends a time-limited link to your email; if SMTP is not configured, the link is printed to the server console

### Environment variables

| Variable | Description |
|----------|-------------|
| `SESSION_SECRET` | Encrypts the data key stored in session rows |
| `RECOVERY_SECRET` | Wraps the data key for password reset — keep this secret |
| `APP_URL` | Public URL for reset links (e.g. `https://inboxmy.my`) |
| `SMTP_HOST` | SMTP server for password reset emails (optional) |
| `SMTP_PORT` | SMTP port (default 587) |
| `SMTP_USER` | SMTP username |
| `SMTP_PASS` | SMTP password |

Run `npm run setup` from `inboxmy-backend/` to regenerate all secrets and configure SMTP.

---

## API Reference

All endpoints are available at `http://localhost:3001` while the app is running.

| Method | Endpoint | Description |
|---|---|---|
| GET | `/health` | Server health check — returns `{"ok":true}` |
| GET | `/api/accounts` | List all connected accounts |
| GET | `/api/accounts/connect/gmail` | Start Gmail OAuth flow |
| GET | `/api/accounts/connect/outlook` | Start Outlook OAuth flow |
| DELETE | `/api/accounts/:id` | Remove a connected account and its emails |
| PATCH | `/api/accounts/:id/label` | Rename an account — body: `{"label":"My Work Gmail"}` |
| GET | `/api/emails` | List emails — params: `?category=bill\|govt\|receipt\|work`, `?accountId=`, `?accountIds=id1,id2`, `?search=`, `?dateFrom=YYYY-MM-DD`, `?dateTo=YYYY-MM-DD`, `?unread=1`, `?limit=50`, `?offset=0` |
| GET | `/api/emails/:id` | Get a single email with decrypted body + parsed bill fields |
| PATCH | `/api/emails/:id/read` | Mark an email as read |
| PATCH | `/api/emails/:id/folder` | Move email to a folder — body: `{"folder":"inbox\|sent\|spam\|draft\|trash\|archive"}` |
| POST | `/api/emails/send` | Send an email — body: `{"to":"","subject":"","body":"","accountId":""}` (or use `replyToEmailId` instead of `accountId`) |
| GET | `/api/bills` | List parsed bills — params: `?status=unpaid\|paid\|overdue` |
| PATCH | `/api/bills/:id/status` | Update bill status — body: `{"status":"paid"}` |
| PATCH | `/api/bills/auto-mark-overdue` | Mark all past-due unpaid bills as overdue |
| GET | `/api/notifications/due-soon` | Bills overdue or due within 72 hours |
| POST | `/api/notifications/ai-summary` | AI-generated notification copy — body: `{"bills":[...],"geminiKey":"..."}` |
| POST | `/api/sync/trigger` | Trigger a sync — body: `{}` for all accounts, `{"accountId":"..."}` for one |

**Quick API test (PowerShell):**
```powershell
# Check server is alive
curl http://localhost:3001/health

# List connected accounts
curl http://localhost:3001/api/accounts

# List unpaid bills
curl "http://localhost:3001/api/bills?status=unpaid"

# Get bills due within 72 hours
curl http://localhost:3001/api/notifications/due-soon
```

---

## Privacy Guarantees

| What | Where | Access |
|---|---|---|
| Email bodies + subjects | `data/inboxmy.db` — AES-256-GCM encrypted | Only the device holding `ENCRYPTION_KEY` |
| OAuth tokens | Same DB, encrypted separately | Same |
| Gemini API key | Windows DPAPI (`safeStorage`) — never logged or transmitted | Local device only |
| Sender addresses | Stored unencrypted (needed for parser matching) | Local machine only |
| Bill amounts | `parsed_bills` table, stored as numbers | Local machine only |
| Network | API bound to `127.0.0.1` — not reachable from LAN or internet | Local device only |
| Telemetry | None | N/A |

---

## Testing Bill Detection

Use these templates to populate InboxMY with realistic test data — no real utility accounts needed. Send from a **second Gmail account** to the account connected in InboxMY, then click **↻ Sync**.

### How the parsers match

| Parser | Triggers on |
|---|---|
| TNB | Sender `@tnb.com.my` **or** subject contains `TNB` + bill word |
| Unifi | Sender `@unifi.com.my` **or** subject contains `Unifi` + bill word |
| Maxis / Celcom / Digi | Sender `@maxis/celcom/digi.com.my` **or** subject contains brand + bill word |
| Touch 'n Go | Sender `@tngdigital.com.my` **or** subject contains `TNG` / `Touch n Go` |
| Shopee | Sender `@shopee.com.my` **or** subject contains `Shopee` + order word |
| Lazada | Sender `@lazada.com.my` **or** subject contains `Lazada` + order word |
| LHDN | Sender `@hasil.gov.my` **or** subject contains `LHDN` / `e-Filing` / `cukai` |
| Generic bill | Any sender — body must contain an RM amount **plus** explicit payment language (`due date`, `please pay`, `invoice`, `amount due`, etc.) |

Because subject-based matching is supported, you can send all tests from any Gmail address.

---

### Test 1 — Generic Bill *(any sender, always works)*

**Subject:** `Invoice #INV-2026-001 — Amount Due`

```
Dear Customer,

Invoice No:  INV-2026-001
Account No:  9876543210
Amount Due:  RM 234.50
Due Date:    28 Feb 2026

Please pay before the due date to avoid service interruption.
```

✅ Bills category · Smart card: RM 234.50 · Due 28 Feb 2026 · Biller: Unknown

---

### Test 2 — TNB Electricity Bill

**Subject:** `TNB eBil - Invoice Elektrik Bil`

```
Akaun No: 1122334455
Jumlah Bil (Amount Due): RM 178.20
Tarikh Akhir Bayaran (Due Date): 15 Mar 2026

Sila bayar sebelum tarikh akhir / Please pay before due date.
```

✅ Bills category · Smart card: RM 178.20 · Due 15 Mar 2026 · Biller: TNB

---

### Test 3 — Unifi Monthly Bill

**Subject:** `Unifi Monthly Bill Invoice — March 2026`

```
Account No: 901234567
Amount Due: RM 129.00
Due Date: 20 Mar 2026

Please pay your Unifi bill before the due date.
```

✅ Bills category · Biller: Unifi

---

### Test 4 — Maxis Postpaid Bill

**Subject:** `Maxis Bill Invoice Statement — March 2026`

```
Account: 0123456789
Bill Amount: RM 88.00
Payment Due Date: 18 Mar 2026

Please pay before the due date to continue your service.
```

✅ Bills category · Biller: Maxis

---

### Test 5 — Touch 'n Go eWallet

**Subject:** `Touch n Go TNG Monthly Statement`

```
Your Touch n Go eWallet account summary.
Total transaction amount: RM 56.80
```

✅ Bills category · Biller: TnG

---

### Test 6 — Shopee Order Confirmation

**Subject:** `Shopee Order Confirmed — Pesanan Anda Telah Disahkan`

```
Order No: 240115ABC123XYZ789
Total amount paid: RM 45.90
Thank you for shopping with Shopee!
```

✅ Receipts category · Biller: Shopee · Appears in Recent orders panel

---

### Test 7 — Lazada Order

**Subject:** `Lazada Order Placed Successfully`

```
Order ID: 987654321
Your order has been placed.
Total: RM 132.00
Thank you for shopping with Lazada!
```

✅ Receipts category · Biller: Lazada · Appears in Recent orders panel

---

### Test 8 — LHDN Government Notice

**Subject:** `LHDN e-Filing Pemberitahuan Cukai Pendapatan 2025`

```
Pemberitahuan daripada Lembaga Hasil Dalam Negeri Malaysia.
Sila semak status e-Filing anda.
```

✅ Government category · No bill amount (LHDN parser is detection-only by design)

---

### Test 9 — False positive check *(should NOT become a bill)*

**Subject:** `Flash Sale! Up to 50% off — Shop Now`

```
Don't miss our biggest sale! RM 29.90 only!
Limited time offer. Shop now and save big!
```

✅ Should land in **Promotions** folder · Must NOT appear in Bills due soon panel

---

### After syncing — what to verify

| Check | Where |
|---|---|
| Email appears in Bills / Receipts / Govt tab | Sidebar |
| Smart card shows correct amount + due date | Email detail pane |
| Bill appears in "Bills due soon" panel | Right panel |
| Promotions email is absent from Bills panel | Right panel |
| Bill with past due date triggers overdue banner | Bills panel top |
| Bill within 72h triggers Windows toast notification | Taskbar / notification centre |

---

## Daily Usage

Once set up, your daily workflow is just:

```bash
# From the repo root
npm start
```

The Electron window opens. The backend starts automatically. The scheduler syncs your emails every 15 minutes and checks for bills due soon every 60 minutes.

If you update the backend source code (`.ts` files in `inboxmy-backend/src/`), rebuild before starting:

```bash
cd inboxmy-backend
npm run build
cd ..
npm start
```

---

## Vision

InboxMY is heading toward a **BlueMail-style model**: you (the person running the app) register the OAuth app with Google and Microsoft once. Your users connect their own email accounts by clicking "Connect Gmail" or "Connect Outlook" — they go through Google/Microsoft's standard permission screen and are done. No terminal, no credentials, no setup knowledge required.

The current version is a single-user Electron desktop app with full local encryption. Multi-user architecture (Plan 4) laid the foundation for both a hosted service and a local-download app. The Electron wrapper (Plan 6) makes it a proper desktop-first product with notifications, system tray, and a Windows installer.

---

## Database Inspection (SQLite)

The database lives at `inboxmy-backend/data/inboxmy.db`.

### Opening the database (PowerShell)

```powershell
& "C:\Users\bryan.GOAT\AppData\Local\Microsoft\WinGet\Packages\SQLite.SQLite_Microsoft.Winget.Source_8wekyb3d8bbwe\sqlite3.exe" "C:\Users\bryan.GOAT\Downloads\VibeCode\inboxmy-backend\data\inboxmy.db"
```

Or if `sqlite3` is on your PATH, open it from the data folder to avoid path wrapping issues:

```powershell
cd "C:\Users\bryan.GOAT\Downloads\VibeCode\inboxmy-backend\data"
sqlite3 inboxmy.db
```

Type `.quit` to exit. Type `.tables` to list all tables.

### Sync progress queries

Run these inside the sqlite3 shell.

**How many emails are indexed total:**
```sql
SELECT COUNT(*) AS total_indexed FROM inbox_index;
```

**Per-account breakdown with email address:**
```sql
SELECT a.id, a.email, a.provider, COUNT(ii.email_id) AS synced
FROM accounts a
LEFT JOIN inbox_index ii ON ii.account_id = a.id
GROUP BY a.id
ORDER BY synced DESC;
```

**Backfill progress per folder (is it still running? how far back has it reached?):**
```sql
SELECT account_id, folder, complete,
  CASE WHEN cursor IS NOT NULL
    THEN datetime(json_extract(cursor,'$.received_at')/1000,'unixepoch')
    ELSE 'not started'
  END AS oldest_email_reached
FROM sync_backfill_cursors;
```

- `complete = 0` with a date → still running, date shows how far back it has crawled
- `complete = 0` with "not started" → backfill hasn't been triggered for this account yet
- `complete = 1` → this folder is fully synced

**Recent sync activity (errors, timing, email counts):**
```sql
SELECT datetime(started_at/1000,'unixepoch') AS started,
  emails_added, error,
  (finished_at - started_at)/1000 AS duration_secs
FROM sync_log ORDER BY started_at DESC LIMIT 10;
```

### Cleanup queries

**Always enable cascade deletes first when running DELETE commands:**
```sql
PRAGMA foreign_keys = ON;
```

**Preview test/dummy accounts before deleting:**
```sql
SELECT id, email, provider FROM accounts WHERE email LIKE '%@test.com';
```

**Delete test accounts (cascades to inbox_index, sync_backfill_cursors, sync_state, etc.):**
```sql
PRAGMA foreign_keys = ON;
DELETE FROM accounts WHERE email LIKE '%@test.com';
```

**Verify cleanup:**
```sql
SELECT COUNT(*) FROM accounts;
SELECT COUNT(*) FROM inbox_index;
SELECT COUNT(*) FROM sync_backfill_cursors;
```

### API endpoints (PowerShell)

Port is `3001` by default.

**Login and save session cookie:**
```powershell
curl.exe -s -c cookies.txt -X POST http://localhost:3001/api/auth/login `
  -H "Content-Type: application/json" `
  -d '{\"email\":\"your@email.com\",\"password\":\"yourpassword\"}'
```

**Check sync state (batch size and timing per account):**
```powershell
curl.exe -s -b cookies.txt http://localhost:3001/api/sync/state
```

**Trigger a manual sync for all accounts:**
```powershell
curl.exe -s -b cookies.txt -X POST http://localhost:3001/api/sync/trigger `
  -H "Content-Type: application/json" `
  -d '{}'
```

**Trigger backfill for a specific account:**
```powershell
curl.exe -s -b cookies.txt -X POST http://localhost:3001/api/sync/backfill `
  -H "Content-Type: application/json" `
  -d '{\"accountId\":\"your-account-id-here\",\"batchSize\":100}'
```

---

## Next Session Prompt

Copy and paste this at the start of your next session:

```
We are building InboxMY — a privacy-first, locally-priced unified email dashboard for Malaysia.
It runs as an Electron 31 desktop app (Windows). Aggregates Gmail and Outlook accounts (up to 6),
parses Malaysian bills (TNB, Unifi, Celcom/Maxis/Digi, Touch 'n Go, LHDN, MySejahtera, Shopee,
Lazada), and stores everything AES-256-GCM encrypted in a local SQLite database. Nothing is sent
to any cloud.

Completed so far:
- Plan 1 (Backend): Encrypted SQLite, OAuth flows (Gmail + Outlook), sync engine, Malaysian bill
  parsers, REST API. 7 test files.
- Plan 2 (Frontend Wiring): frontend/app.js wires all dashboard panels to the live API.
- Plan 3 (OAuth Credentials Setup): npm run setup wizard, startup config validator, SETUP.md guide.
  2 test files.
- Plan 4 (Multi-User Architecture): User sign-up/sign-in, per-user AES-256-GCM encrypted data keys,
  HTTP-only cookie sessions (30-day TTL), forgot-password + reset-password, requireAuth middleware,
  OAuth state relay, frontend auth.html login page. 3 test files. 71 tests passing.
- Plan 5 (Account Management UI): Rename accounts (pencil icon → inline input), delete + revoke
  (simple confirm modal), re-auth badge (token_expired column), per-account sync status badge.
  2 test files. 88 tests passing.
- Plan 6 (Notifications + Overdue Detection + Electron): Full Electron desktop app — NSIS installer,
  system tray, close-to-tray, Windows toast notifications with "View Bill" deep-link, overdue banner
  (sessionStorage dismiss), AI summaries via Gemini 2.0 Flash (safeStorage DPAPI for key), auto-launch
  toggle, contextBridge/preload IPC, net.request() using renderer session. 3 new test files.
  114 tests total passing (110 backend + 4 utils).
- Plan 7 (Search + Filtering): Full-text in-memory search (sender/subject/snippet), date range
  filters (today/week/month/3-month presets + custom picker), multi-account filter pills (OR logic,
  persists across folder switches). GET /api/emails extended with dateFrom/dateTo/accountIds/search
  params — fast SQL path when no search, in-memory decrypt+filter path when search present. 17 new
  tests. 143 tests total passing (139 backend + 4 utils).
- Plan 8 (Test Coverage — High Priority Routes): Full test suite runner (npm run test:all),
  GET /api/bills, PATCH /api/bills/:id/status, GET /api/emails basic list + pagination,
  GET /api/emails/:id, PATCH /api/emails/:id/read, DELETE /api/emails. 181 tests total.
- Plan 9 (Test Coverage — Medium Priority + Bug Fixes): MySejahtera + spam-scorer parser tests,
  folder/tab/unread filter tests, session cookie attribute tests, 6-account cap enforcement (backend +
  tests), concurrent sync dedup test. 219 tests total. 2 production bugs found and fixed.
- Plan 10 (Compose + Move/Archive — backend complete): sendEmail() abstraction in src/email/send.ts
  (Gmail MIME base64url via googleapis, Outlook via Graph API fetch), POST /api/emails/send route
  (validates to/subject/body/accountId, resolves accountId from replyToEmailId, ownership check,
  saves encrypted sent copy with user dataKey, 502 on failure / 401+reconnect on re-auth),
  PATCH /api/emails/:id/folder (inbox/sent/spam/draft/trash/archive), OAuth send scopes added to
  Gmail and Outlook. 235 backend tests (239 total). Frontend compose UI (Tasks 8-10) is pending.

Next goal: FIXED THE FOLLOWING. 1. Remove Inbox and Focused as well, not just the frontend but the backend of it so that it dont leave any unused code. 2. Reaarange the order of the navigation bar to: All Mail, Important, Work, Bills, Receipts, Government, Promotions, Snoozed, Sent, Drafts, Spam. You should also add an Archived navigation bar, so that user can see what is acrchived.


