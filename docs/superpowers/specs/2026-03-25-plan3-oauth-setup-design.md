# Plan 3 — OAuth Credentials Setup: Design Spec

**Date:** 2026-03-25
**Status:** Approved
**Project:** InboxMY — Privacy-first unified email dashboard for Malaysia

---

## Context

InboxMY is a privacy-first email dashboard that aggregates Gmail and Outlook accounts. Plans 1 and 2 are complete: the backend runs, the frontend is wired, and 32 tests pass.

**The problem Plan 3 solves:** The app requires a Google Cloud OAuth app registration and a Microsoft Azure app registration to connect any email account. Currently, `config.ts` only throws on a missing `ENCRYPTION_KEY` — Google and Microsoft credentials silently default to empty strings, causing sync to fail with cryptic errors at runtime. There is no user-facing guide or tooling to set these up correctly.

**Who this plan is for:** Bryan (the app developer/owner). End users never touch credentials — they click "Connect Gmail" or "Connect Outlook" in the dashboard UI and go through Google/Microsoft's standard permission screen. The OAuth app credentials in `.env` are registered once by whoever hosts or runs the app.

**Product vision note:** InboxMY is heading toward a BlueMail-style model — developer registers the OAuth app once, users connect their own email accounts via standard OAuth. The multi-user architecture (user sign-up/sign-in, per-user data isolation) is Plan 4. Plan 3 establishes the credential foundation that Plan 4 builds on.

---

## Scope

### In scope
- `scripts/setup.ts` — interactive CLI wizard that writes `.env`
- `config.ts` — startup validator with console checklist
- `SETUP.md` — full reference guide for Google Cloud + Azure (beginner-friendly)
- `README.md` — roadmap remodel, remove partial Google Cloud section, add Vision section

### Out of scope
- User authentication (Plan 4)
- Multi-tenant data isolation (Plan 4)
- Hosted deployment (Plan 10)

---

## Components

### 1. `inboxmy-backend/scripts/setup.ts`

**Purpose:** Interactive CLI that configures `.env` without the user ever manually editing a file.

**Behaviour:**
- Runs via `npm run setup` (new entry in `package.json` scripts)
- No new npm dependencies — uses Node.js built-in `readline`
- Asks which providers to configure: Gmail only / Outlook only / Both
- Auto-generates a cryptographically random `ENCRYPTION_KEY` (32 bytes → 64-char hex via `crypto.randomBytes`) — user never sees or sets this
- For each selected provider, prints condensed step-by-step instructions inline with the exact URL to open, then prompts for Client ID and Client Secret
- Validates input format:
  - Google Client ID must end in `.apps.googleusercontent.com`
  - Azure Client ID must match UUID format (`xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`)
  - Secrets must be non-empty
  - On invalid input: prints format hint and re-prompts — maximum **3 attempts** per field; on exhaustion prints a clear exit message and aborts without writing `.env`
- If `.env` already exists: prints a warning and asks `Overwrite? (y/N)` — defaults to **no**
- On completion: always writes a **complete `.env`** containing all known variables (`PORT`, `DATA_DIR`, `ENCRYPTION_KEY`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`, `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, `MICROSOFT_REDIRECT_URI`, `SYNC_INTERVAL_MINUTES`). Skipped providers write empty strings. Non-credential values (`PORT`, `DATA_DIR`, `SYNC_INTERVAL_MINUTES`) are always written with their defaults. **Note:** if the user has previously customized `PORT` or `DATA_DIR`, re-running setup will reset them to defaults — acceptable for the current solo-developer scope.
- References `SETUP.md` at the start of each provider section for the full guide

**tsconfig.json update required:** Add `"scripts"` to the `exclude` array so `tsc` ignores `scripts/setup.ts`. The `npm run setup` command invokes `tsx` directly and is unaffected — this is purely a build hygiene fix. Without it, `npm run build` fails once `scripts/setup.ts` exists because `rootDir` is set to `src`.

```json
"exclude": ["node_modules", "dist", "scripts"]
```

**Script flow:**
```
npm run setup

╔══════════════════════════════════════════╗
║  InboxMY — First-time Setup              ║
╚══════════════════════════════════════════╝

Which email providers do you want to connect?
  1) Gmail only
  2) Outlook only
  3) Both Gmail and Outlook
> 3

✓ ENCRYPTION_KEY generated automatically.

─── Gmail Setup ────────────────────────────
  Full guide: SETUP.md → Section 1 (Google Cloud)
  1. Go to https://console.cloud.google.com
  2. Create or select a project
  3. Enable the Gmail API
  4. Create OAuth 2.0 credentials (Web application)
  5. Add redirect URI: http://localhost:3001/auth/gmail/callback
  6. Copy your Client ID and Client Secret below

Enter GOOGLE_CLIENT_ID: ████████
Enter GOOGLE_CLIENT_SECRET: ████████

─── Outlook Setup ──────────────────────────
  Full guide: SETUP.md → Section 2 (Azure Portal)
  1. Go to https://portal.azure.com
  2. Search "App registrations" → New registration
  3. Name: InboxMY, Accounts: "Accounts in any organizational directory and personal Microsoft accounts (Outlook.com, Hotmail)" — this covers both personal and work/school accounts
  4. Redirect URI: http://localhost:3001/auth/outlook/callback
  5. API permissions → Add Mail.Read, User.Read
  6. Certificates & secrets → New client secret → Copy value

Enter MICROSOFT_CLIENT_ID: ████████
Enter MICROSOFT_CLIENT_SECRET: ████████

─── Writing .env ───────────────────────────
✓ .env written to inboxmy-backend/.env

All done! Run the server with:
  npm run build && npm start
Then open http://localhost:3001
```

---

### 2. `config.ts` (update existing)

**Purpose:** Validate all credential groups at startup and print a readable checklist so the user always knows their configuration state.

**Changes to existing behaviour:**
- Keep the existing `required('ENCRYPTION_KEY')` hard throw — this key is always auto-generated by the setup script so it should always be present
- Add a new `validateConfig()` function exported from `config.ts` but **not** called at module level — calling it at module level would cause it to run during every test that imports `config`, polluting test output with checklist noise
- `validateConfig()` is called in `server.ts` inside the existing `if (require.main === module)` guard (line 63) — this ensures it runs only when the server is started directly, never during tests
- `validateConfig()` checks each credential group and prints a checklist block, then returns without throwing

**Checklist output on startup:**
```
─── InboxMY Config ─────────────────────────
  [✓] ENCRYPTION_KEY
  [✓] Gmail (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET)
  [ ] Outlook (MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET)
      → Run: npm run setup
────────────────────────────────────────────
```

**Rules:**
- `[✓]` if both ID and Secret are non-empty
- `[ ]` with a `→ Run: npm run setup` hint if either is missing
- `ENCRYPTION_KEY` still throws if missing (hard requirement — without it no data can be decrypted)
- The checklist prints on every startup (not just when something is missing) — gives the user constant visibility into config state
- No change to runtime behaviour — app continues starting regardless of missing Google/Microsoft creds

---

### 3. `SETUP.md`

**Purpose:** Complete from-scratch reference guide for a first-timer. Written as if the reader has never touched Google Cloud Console or Azure Portal before.

**Structure:**
```
# InboxMY — OAuth Credentials Setup Guide

## Overview
  - What these credentials are for
  - Who needs to do this (the person running the server)
  - What end users experience (just the OAuth permission screen)

## Section 1 — Google Cloud Setup (Gmail)
  Step 1: Create a Google Cloud project
  Step 2: Enable the Gmail API
  Step 3: Configure the OAuth consent screen
  Step 4: Create OAuth 2.0 credentials
  Step 5: Add your email as a test user
  Step 6: Copy credentials into .env / npm run setup
  Troubleshooting: org_internal error, insufficient scopes

## Section 2 — Azure Portal Setup (Outlook)
  Step 1: Sign in to Azure Portal
  Step 2: Register a new application
  Step 3: Configure redirect URI
  Step 4: Add API permissions (Mail.Read, User.Read)
  Step 5: Generate a client secret
  Step 6: Copy credentials into .env / npm run setup
  Troubleshooting: admin consent required, secret expiry

## Section 3 — Verifying Setup
  - Run npm run setup
  - Start server, check checklist output
  - Connect Gmail / Outlook from dashboard
  - Trigger sync, confirm emails appear
```

---

### 4. `README.md` (updates)

**Changes:**
1. **Roadmap table remodeled** — full 10-plan table with key deliverables and status per plan (see below)
2. **Existing "Google Cloud Setup" section removed** — content moved into `SETUP.md`, README links to it
3. **Short "Vision" section added** — explains the BlueMail-style model: developer registers OAuth app once, users connect their own accounts via standard OAuth flow; notes Plan 4 as the multi-user milestone

**Updated roadmap table:**

| # | Plan | Key Deliverables | Status |
|---|------|-----------------|--------|
| 1 | **Backend Core** | Encrypted SQLite, OAuth flows (Gmail + Outlook), email sync engine, Malaysian bill parsers (TNB, Unifi, Maxis, TnG, LHDN, Shopee, Lazada), REST API, 32 tests | ✅ Done |
| 2 | **Frontend Wiring** | Dashboard panels wired to live API — email list, email detail, accounts sidebar, bills panel, sync button, infinite scroll, error handling | ✅ Done |
| 3 | **OAuth Credentials Setup** | `npm run setup` wizard, startup config validator with checklist, `SETUP.md` full reference guide, README roadmap remodel | 🔄 This session |
| 4 | **Multi-User Architecture** | User sign-up/sign-in, per-user data isolation, per-user encryption keys, session management — foundation for hosted and local-download modes | ⏳ Pending |
| 5 | **Account Management UI** | Rename accounts, delete + revoke, re-auth expired tokens, per-account sync status | ⏳ Pending |
| 6 | **Notifications + Overdue Detection** | Due-date alerts, overdue bill banner, browser notifications | ⏳ Pending |
| 7 | **Search + Filtering Improvements** | Full-text search, date range filters, multi-account filter, saved searches | ⏳ Pending |
| 8 | **Packaging + Auto-start on Login** | Electron or system tray wrapper, auto-start on OS login, local-download installer | ⏳ Pending |
| 9 | **Hardening + v1.0 Polish** | Rate limiting review, error boundary UI, accessibility pass, performance profiling, v1.0 release | ⏳ Pending |
| 10 | **Hosted Deployment** | Docker setup, cloud hosting config, privacy-preserving multi-tenant model | ⏳ Pending |

---

## Data Flow

```
User runs: npm run setup
    │
    ├── Asks provider choice (Gmail / Outlook / Both)
    ├── Auto-generates ENCRYPTION_KEY
    ├── Prints inline steps + SETUP.md reference per provider
    ├── Prompts for Client ID + Secret per provider
    ├── Validates format
    └── Writes .env

User runs: npm run build && npm start
    │
    ├── dotenv loads .env
    ├── validateConfig() runs → prints checklist to console
    ├── Server starts on :3001
    └── Dashboard accessible at http://localhost:3001

User clicks "Connect Gmail" in dashboard
    │
    ├── GET /api/accounts/connect/gmail
    ├── Redirects to Google OAuth consent screen
    ├── User approves
    ├── GET /auth/gmail/callback?code=...
    ├── Token exchanged + encrypted + stored in SQLite
    └── Account appears in dashboard sidebar
```

---

## Error Handling

| Scenario | Behaviour |
|----------|-----------|
| `.env` exists when running setup | Warns, asks `Overwrite? (y/N)`, defaults no |
| Invalid Client ID format | Prints format hint, re-prompts up to 3 times; aborts cleanly on 3rd failure without writing `.env` |
| `ENCRYPTION_KEY` missing at startup | Hard throw — app exits with clear message |
| Google/Microsoft creds missing at startup | Checklist shows `[ ]`, prints `→ Run: npm run setup`, app continues |
| User connects Gmail with unconfigured creds | OAuth redirect fails gracefully, error shown in browser |

---

## File Changes Summary

| File | Change |
|------|--------|
| `inboxmy-backend/scripts/setup.ts` | New file |
| `inboxmy-backend/src/config.ts` | Add exported `validateConfig()` function |
| `inboxmy-backend/src/server.ts` | Call `validateConfig()` inside `require.main` guard |
| `inboxmy-backend/package.json` | Add `"setup": "tsx scripts/setup.ts"` to scripts |
| `inboxmy-backend/tsconfig.json` | Add `"scripts"` to `exclude` array |
| `SETUP.md` | New file (root of repo) |
| `README.md` | Remodel roadmap, remove Google Cloud section, add Vision section, link to SETUP.md |

---

## Testing

- Run `npm run setup` → verify `.env` is written correctly
- Run `npm run setup` again → verify overwrite prompt appears and defaults to no
- Start server → verify checklist prints with correct `[✓]`/`[ ]` states
- Remove a credential from `.env`, restart → verify `[ ]` appears for that provider
- Remove `ENCRYPTION_KEY`, restart → verify hard throw with clear message
