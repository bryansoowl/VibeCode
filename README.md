# InboxMy

A privacy-first, locally-priced unified email dashboard for Malaysia. Aggregates up to 6 Gmail/Outlook accounts with smart local filtering — pre-trained to recognise Malaysian bill formats, LHDN emails, MySejahtera, and e-commerce receipts.

All email data is stored **encrypted on your own machine**. Nothing is sent to any cloud.

---

## What's Built

| Layer | Files | Details |
|---|---|---|
| Crypto | `src/crypto.ts`, `src/config.ts` | AES-256-GCM encryption — all email bodies, subjects, and tokens encrypted at rest |
| Database | `src/db/index.ts`, `migrations.ts` | SQLite with WAL mode, versioned migrations, `closeDb()` |
| Auth | `src/auth/gmail.ts`, `outlook.ts`, `token-store.ts` | OAuth2 for Gmail + Outlook, tokens stored encrypted |
| Email fetch | `src/email/gmail-client.ts`, `outlook-client.ts` | Gmail API + Microsoft Graph, normalised to shared type |
| Parsers | `src/parsers/` (11 files) | TNB, Unifi, Celcom/Maxis/Digi, Touch 'n Go, LHDN, MySejahtera, Shopee, Lazada + generic RM extractor |
| Sync engine | `src/email/sync-engine.ts` | Multi-account sync, runs parsers, writes emails + bills atomically |
| REST API | `src/routes/` (4 files) | `/api/accounts`, `/api/emails`, `/api/bills`, `/api/sync` |
| Server | `src/server.ts` | Express, bound to `127.0.0.1` only, rate-limited, serves frontend |
| Scheduler | `src/scheduler.ts` | node-cron, syncs all accounts every 15 min |
| Frontend | `frontend/index.html`, `frontend/landing.html` | Dashboard + landing page served by Express |

---

## Prerequisites

- Node.js 20+
- A Google Cloud project with Gmail API enabled → [console.cloud.google.com](https://console.cloud.google.com)
- A Microsoft Azure app registration → [portal.azure.com](https://portal.azure.com)

---

## Running the Backend

```bash
# 1. Enter the backend directory
cd inboxmy-backend

# 2. Install dependencies (already done if you cloned this repo)
npm install

# 3. Copy the example env file
cp .env.example .env
```

Open `.env` and fill in:

```env
# Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
ENCRYPTION_KEY=your_64_char_hex_key_here

# From Google Cloud Console (OAuth 2.0 Client ID, Desktop or Web app)
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=

# From Azure Portal (App Registration)
MICROSOFT_CLIENT_ID=
MICROSOFT_CLIENT_SECRET=
```

```bash
# 4. Start in development mode (hot reload)
npm run dev
```

The backend runs at `http://localhost:3001`.
Open `http://localhost:3001` for the dashboard, or `http://localhost:3001/landing.html` for the landing page.

To connect a Gmail account, visit: `http://localhost:3001/api/accounts/connect/gmail`
To connect an Outlook account, visit: `http://localhost:3001/api/accounts/connect/outlook`

---

## Running the Tests

```bash
cd inboxmy-backend

# Run all tests once
ENCRYPTION_KEY=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa DATA_DIR=./data-test npm test

# Watch mode during development
ENCRYPTION_KEY=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa DATA_DIR=./data-test npm run test:watch
```

Expected output: **32 tests passing** across:
- `tests/crypto.test.ts` — AES-256-GCM round-trip, tamper detection
- `tests/parsers/tnb.test.ts` — TNB bill detection + amount extraction
- `tests/parsers/lhdn.test.ts` — LHDN domain + subject matching
- `tests/parsers/shopee.test.ts` — Shopee order ref + amount
- `tests/parsers/generic-bill.test.ts` — RM amount + date parsing
- `tests/parsers/remaining.test.ts` — Unifi, Celcom/Maxis, TnG, Lazada
- `tests/routes/accounts.test.ts` — GET, PATCH label, DELETE

---

## API Reference

| Method | Endpoint | Description |
|---|---|---|
| GET | `/health` | Server health check |
| GET | `/api/accounts` | List connected accounts |
| GET | `/api/accounts/connect/gmail` | Start Gmail OAuth flow |
| GET | `/api/accounts/connect/outlook` | Start Outlook OAuth flow |
| DELETE | `/api/accounts/:id` | Remove an account |
| PATCH | `/api/accounts/:id/label` | Rename an account |
| GET | `/api/emails` | List emails (`?category=bill\|govt\|receipt\|work`, `?search=`, `?limit=`, `?offset=`) |
| GET | `/api/emails/:id` | Get email with body + parsed bill fields |
| PATCH | `/api/emails/:id/read` | Mark as read |
| GET | `/api/bills` | List parsed bills (`?status=unpaid\|paid\|overdue`) |
| PATCH | `/api/bills/:id/status` | Update bill status |
| POST | `/api/sync/trigger` | Trigger sync (`body: { accountId? }`) |

---

## Privacy Guarantees

| What | Where | Access |
|---|---|---|
| Email bodies + subjects | `data/inboxmy.db` — AES-256-GCM encrypted | Only the machine holding `ENCRYPTION_KEY` |
| OAuth tokens | Same DB, encrypted separately | Same |
| Sender addresses | Stored unencrypted (needed for parser matching) | Local only |
| Bill amounts | `parsed_bills` table, stored as numbers | Local only |
| Network | API bound to `127.0.0.1` — not reachable from LAN | Local machine only |

Next step: wire the dashboard HTML to actually call the API endpoints, and set up Google Cloud / Azure app registrations to get real OAuth credentials.

 - What's Built table — all 11 layers with file references and what each does
  - Prerequisites — Node 20+, Google Cloud, Azure
  - Running the backend — step by step including .env setup and how to connect accounts
  - Running the tests — exact commands with the dummy ENCRYPTION_KEY, expected 32 tests, breakdown of what each test file covers
  - API Reference — full endpoint table
  - Privacy Guarantees — what's encrypted, what's not, and why