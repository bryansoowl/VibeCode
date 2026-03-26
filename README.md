# InboxMY

A privacy-first, locally-priced unified email dashboard for Malaysia. Aggregates up to 6 Gmail/Outlook accounts with smart local filtering — pre-trained to recognise Malaysian bill formats, LHDN emails, MySejahtera, and e-commerce receipts.

All email data is stored **encrypted on your own machine**. Nothing is sent to any cloud.

---

## Completed Tasks

### Task 1 — Backend (Done)
Full Express + TypeScript backend with encrypted SQLite storage, OAuth for Gmail and Outlook, email sync engine, Malaysian bill parsers, and a REST API. 32 tests passing.

### Task 2 — Frontend Wiring (Done)
Connected the dashboard (`frontend/index.html`) to the live backend API using vanilla JavaScript. All panels — email list, email detail, accounts, bills, sync — are now wired to real data. No build step, no framework.

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
| REST API | `src/routes/` (4 files) | `/api/accounts`, `/api/emails`, `/api/bills`, `/api/sync` |
| Server | `src/server.ts` | Express, bound to `127.0.0.1` only, rate-limited, serves frontend statically |
| Scheduler | `src/scheduler.ts` | node-cron, syncs all accounts every 15 min |
| Frontend API client | `frontend/app.js` | Vanilla JS — fetches all panels from the backend API, infinite scroll, error handling |
| Dashboard | `frontend/index.html` | Full email dashboard — accounts, email list, email detail, bills panel, sync button |
| Landing page | `frontend/landing.html` | Marketing/info landing page |

---

## Prerequisites

Before you start, make sure you have:

- **Node.js 20 or newer** — check with `node --version`
- **A Google Cloud project** with the Gmail API enabled (for Gmail OAuth)
- **A Microsoft Azure app registration** (for Outlook OAuth)

You do NOT need to set up Google/Microsoft credentials to run and test locally — the app starts and the dashboard loads fine without them. You only need credentials when you want to actually connect a real email account.

---

## Step 1 — First-Time Setup

Run these steps once. After that, you only need `npm run build && npm start` to run the app.

**Open a terminal (PowerShell or Command Prompt) and run:**

```powershell
# Navigate to the backend folder
cd C:\Users\bryan.GOAT\Downloads\VibeCode\inboxmy-backend

# Install all dependencies
npm install
```

**Create your `.env` file by running the setup wizard:**

```powershell
npm run setup
```

The wizard will:
- Auto-generate a secure `ENCRYPTION_KEY` for you
- Walk you through Google Cloud setup (for Gmail) and/or Azure Portal setup (for Outlook)
- Write a complete `.env` file — you never need to edit it manually

> For the full step-by-step credential guide (every click in Google Cloud Console and Azure Portal), see [SETUP.md](./SETUP.md).

---

## Step 2 — Build the Backend

The backend is written in TypeScript and must be compiled to JavaScript before running. You only need to do this once, and again any time the backend source code changes.

```powershell
cd C:\Users\bryan.GOAT\Downloads\VibeCode\inboxmy-backend

npm run build
```

Expected output:
```
> inboxmy-backend@1.0.0 build
> tsc
```

No errors, no output — a silent exit means success. This creates the `dist/` folder containing compiled JavaScript files.

---

## Step 3 — Start the App

```powershell
cd C:\Users\bryan.GOAT\Downloads\VibeCode\inboxmy-backend

npm start
```

Expected output:
```
InboxMY backend running on http://localhost:3001
Scheduler started — syncing every 15 minutes
```

The app is now running. **Leave this terminal window open** — closing it stops the server.

Open your browser and go to:

| URL | What you see |
|---|---|
| `http://localhost:3001` | The email dashboard |
| `http://localhost:3001/landing.html` | The landing/marketing page |
| `http://localhost:3001/health` | `{"ok":true}` — confirms the server is alive |

---

## Multi-User Architecture

InboxMY Plan 4 adds full user authentication and per-user data isolation.

### How it works

- **Sign up** at `/auth` with your email and a password (min 8 characters)
- **Your data is encrypted** with a 256-bit key that only your password can unlock — the server cannot read your emails or bills without it
- **Sessions persist** until you click Sign Out (30-day absolute TTL as a safety net)
- **Password reset** sends a time-limited link to your email; if SMTP is not configured, the link is printed to the server console

### New environment variables (auto-generated by `npm run setup`)

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

### Manual test checklist

1. `http://localhost:3001` → redirects to `/auth`
2. Sign up → redirects to dashboard, HttpOnly `session` cookie set
3. Refresh → still logged in
4. Sign Out → redirected to `/auth`, back button blocked
5. Sign in again → dashboard loads
6. Sign in with wrong password → "Invalid email or password"
7. Open incognito, sign up as a different user, connect a Gmail account → original user's accounts panel does not show the new account
8. Forgot password → check server console for reset link → click link → new password works, old password rejected
9. After password reset, existing sessions are invalidated (sign in required)

---

## Step 4 — Connect a Gmail Account

> **Before this step:** Make sure your Google Cloud OAuth app is set to **External** user type (not Internal). See the section below on Google Cloud setup.

1. With the server running, open your browser and go to:
   ```
   http://localhost:3001/api/accounts/connect/gmail
   ```
2. You will be redirected to Google's OAuth consent screen.
3. Sign in with your Gmail account and grant the requested permissions (`gmail.readonly` + email info).
4. After approving, Google redirects you back to `http://localhost:3001/auth/gmail/callback`.
5. The server saves your encrypted OAuth token to the local database.
6. You are redirected to the dashboard at `http://localhost:3001`.

To connect an Outlook account instead:
```
http://localhost:3001/api/accounts/connect/outlook
```

After connecting, the app automatically syncs your emails in the background.

---

## Step 5 — Trigger a Manual Sync

After connecting an account, trigger a sync to fetch your emails immediately:

1. Open the dashboard at `http://localhost:3001`
2. Click the **↻ Sync** button in the top-right of the topbar
3. The button shows "↻ Syncing…" while working
4. When done: a "Sync complete!" toast appears and all panels refresh
5. The last-synced time appears next to the Sync button

Or trigger a sync via the API directly:
```powershell
# Sync all accounts
curl -X POST http://localhost:3001/api/sync/trigger

# Sync a specific account (replace ACCOUNT_ID with the real ID)
curl -X POST http://localhost:3001/api/sync/trigger -H "Content-Type: application/json" -d "{\"accountId\":\"ACCOUNT_ID\"}"
```

The scheduler also runs automatically every 15 minutes while the server is running.

---

## Step 6 — Using the Dashboard

Once emails are synced, here is how each part of the dashboard works:

**Sidebar — Folder navigation**
- Click `All inbox`, `Bills`, `Government`, `Receipts`, `Work` to filter the email list by category
- Click any connected account name to filter emails by that account only
- Click `All accounts` to see emails from all accounts

**Email list (centre column)**
- Emails load from the API and scroll infinitely (50 at a time)
- Use the tab filters at the top: `All`, `Unread`, `Bills`, `Govt`, `Receipts`
- Use the search bar at the top to search by sender name
- Click any email row to open it in the detail pane

**Email detail (right of email list)**
- Shows the decrypted email subject, sender, and body
- For bill emails (TNB, Unifi, Celcom, etc.): a smart card appears showing the parsed amount, due date, and account reference
- The email is automatically marked as read when you open it

**Bills panel (far right)**
- Shows unpaid and overdue bills sorted by due date
- Shows a "Bills due soon" countdown for each bill (e.g. "Due in 5 days")
- Click any bill to mark it as paid — it disappears from the panel
- Shows monthly totals: total unpaid amount + overdue count
- If you have Shopee or Lazada receipts, they appear in a "Recent orders" section

---

## Running the Tests

The test suite covers all backend logic — encryption, bill parsers, and API routes. The tests do **not** require a real Gmail or Outlook account.

```powershell
cd C:\Users\bryan.GOAT\Downloads\VibeCode\inboxmy-backend

# Set the test encryption key (required — can be any 64 hex chars)
$env:ENCRYPTION_KEY="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
$env:DATA_DIR="./data-test"

# Run all tests
npm test
```

Expected output:
```
 RUN  v4.x.x

 Test Files  9 passed (9)
       Tests  51 passed (51)
    Duration  ~2s
```

**What each test file covers:**

| Test file | What it tests |
|---|---|
| `tests/crypto.test.ts` | AES-256-GCM encryption and decryption round-trip, tamper detection |
| `tests/parsers/tnb.test.ts` | TNB eBill detection, amount extraction (RM format), due date parsing |
| `tests/parsers/lhdn.test.ts` | LHDN domain and subject matching |
| `tests/parsers/shopee.test.ts` | Shopee order reference and amount extraction |
| `tests/parsers/generic-bill.test.ts` | Generic Malaysian RM amount and date parsing |
| `tests/parsers/remaining.test.ts` | Unifi, Celcom/Maxis, Touch 'n Go, Lazada parser coverage |
| `tests/routes/accounts.test.ts` | GET /api/accounts, PATCH label, DELETE account |
| `tests/config.test.ts` | validateConfig() checklist output — Gmail/Outlook [✓]/[ ] states |
| `tests/setup.test.ts` | isValidGoogleClientId, isValidAzureClientId, isValidSecret, buildEnvContent |

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

## Credentials Setup

For the full step-by-step guide to setting up Google Cloud (Gmail) and Azure Portal (Outlook) credentials, see [SETUP.md](./SETUP.md).

---

## API Reference

All endpoints are available at `http://localhost:3001` while the server is running.

| Method | Endpoint | Description |
|---|---|---|
| GET | `/health` | Server health check — returns `{"ok":true}` |
| GET | `/api/accounts` | List all connected accounts |
| GET | `/api/accounts/connect/gmail` | Start Gmail OAuth flow (opens browser redirect) |
| GET | `/api/accounts/connect/outlook` | Start Outlook OAuth flow (opens browser redirect) |
| DELETE | `/api/accounts/:id` | Remove a connected account and its emails |
| PATCH | `/api/accounts/:id/label` | Rename an account — body: `{"label":"My Work Gmail"}` |
| GET | `/api/emails` | List emails — params: `?category=bill\|govt\|receipt\|work`, `?accountId=`, `?search=`, `?limit=50`, `?offset=0` |
| GET | `/api/emails/:id` | Get a single email with decrypted body + parsed bill fields |
| PATCH | `/api/emails/:id/read` | Mark an email as read |
| GET | `/api/bills` | List parsed bills — params: `?status=unpaid\|paid\|overdue` |
| PATCH | `/api/bills/:id/status` | Update bill status — body: `{"status":"paid"}` |
| POST | `/api/sync/trigger` | Trigger a sync — body: `{}` for all accounts, `{"accountId":"..."}` for one |

**Quick API test (PowerShell):**
```powershell
# Check server is alive
curl http://localhost:3001/health

# List connected accounts
curl http://localhost:3001/api/accounts

# List latest 10 emails
curl "http://localhost:3001/api/emails?limit=10"

# List unpaid bills
curl "http://localhost:3001/api/bills?status=unpaid"
```

---

## Privacy Guarantees

| What | Where | Access |
|---|---|---|
| Email bodies + subjects | `data/inboxmy.db` — AES-256-GCM encrypted | Only the machine holding `ENCRYPTION_KEY` |
| OAuth tokens | Same DB, encrypted separately | Same |
| Sender addresses | Stored unencrypted (needed for parser matching) | Local machine only |
| Bill amounts | `parsed_bills` table, stored as numbers | Local machine only |
| Network | API bound to `127.0.0.1` — not reachable from LAN or internet | Local machine only |

---

## Daily Usage (After First Setup)

Once everything is set up, your daily workflow is just:

```powershell
cd C:\Users\bryan.GOAT\Downloads\VibeCode\inboxmy-backend
npm start
```

Then open `http://localhost:3001` in your browser.

The scheduler syncs your emails automatically every 15 minutes. You can also click **↻ Sync** in the dashboard at any time.

If you update the backend source code (`.ts` files in `inboxmy-backend/src/`), rebuild before starting:
```powershell
npm run build
npm start
```

---

## Vision

InboxMY is heading toward a **BlueMail-style model**: you (the person running the server) register the OAuth app with Google and Microsoft once. Your users connect their own email accounts by clicking "Connect Gmail" or "Connect Outlook" — they go through Google/Microsoft's standard permission screen and are done. No terminal, no credentials, no setup knowledge required.

The current version is a single-user local app. **Plan 4** adds multi-user architecture: user sign-up/sign-in, per-user data isolation, and per-user encryption keys — the foundation for both a hosted service and a local-download app.

---

## Roadmap

| # | Plan | Key Deliverables | Status |
|---|------|-----------------|--------|
| 1 | **Backend Core** | Encrypted SQLite, OAuth flows (Gmail + Outlook), email sync engine, Malaysian bill parsers (TNB, Unifi, Maxis, TnG, LHDN, Shopee, Lazada), REST API | ✅ Done |
| 2 | **Frontend Wiring** | Dashboard panels wired to live API — email list, email detail, accounts sidebar, bills panel, sync button, infinite scroll, error handling | ✅ Done |
| 3 | **OAuth Credentials Setup** | `npm run setup` wizard, startup config validator with checklist, `SETUP.md` full reference guide, README roadmap remodel | ✅ Done |
| 4 | **Multi-User Architecture** | User sign-up/sign-in (email+password), per-user AES-256-GCM encrypted data keys, HTTP-only cookie sessions (30-day TTL), email-based password reset, auth middleware on all API routes, OAuth state relay, frontend sign-in page | ✅ Done |
| 5 | **Account Management UI** | Rename accounts, delete + revoke, re-auth expired tokens, per-account sync status | ⏳ Pending |
| 6 | **Notifications + Overdue Detection** | Due-date alerts, overdue bill banner, browser notifications | ⏳ Pending |
| 7 | **Search + Filtering Improvements** | Full-text search, date range filters, multi-account filter, saved searches | ⏳ Pending |
| 8 | **Packaging + Auto-start on Login** | Electron or system tray wrapper, auto-start on OS login, local-download installer | ⏳ Pending |
| 9 | **Hardening + v1.0 Polish** | Rate limiting review, error boundary UI, accessibility pass, performance profiling, v1.0 release | ⏳ Pending |
| 10 | **Hosted Deployment** | Docker setup, cloud hosting config, privacy-preserving multi-tenant model | ⏳ Pending |

---

## Next Session Prompt

Copy and paste this at the start of your next session:

```
We are building InboxMY — a privacy-first, locally-priced unified email dashboard for Malaysia.
It aggregates Gmail and Outlook accounts (up to 6), parses Malaysian bills (TNB, Unifi, Celcom/Maxis/Digi,
Touch 'n Go, LHDN, MySejahtera, Shopee, Lazada), and stores everything AES-256-GCM encrypted in a local
SQLite database. Nothing is sent to any cloud.

Completed so far:
- Plan 1 (Backend): 100% complete, 32 tests passing, running at http://localhost:3001
- Plan 2 (Frontend Wiring): 100% complete — frontend/app.js wires all dashboard panels to the live API
- Plan 3 (OAuth Credentials Setup): 100% complete — npm run setup wizard, startup config checklist,
  SETUP.md guide, README roadmap remodel

Today's goal is Plan 4: Multi-User Architecture.
Add user sign-up/sign-in, per-user data isolation, per-user encryption keys, and session management —
the foundation for both hosted and local-download modes. See docs/superpowers/specs/ for the design spec
once it is written.
```
