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

## Testing

### Backend tests (110 tests)

```bash
cd inboxmy-backend
$env:ENCRYPTION_KEY="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
$env:DATA_DIR="./data-test"
npm test
```

### Utils tests (4 tests)

```bash
# From repo root
npm run test:utils
```

### Combined: 114 tests total

Test coverage includes: encryption, bill parsers, API routes, auth middleware, sync engine, AI notifier, notification scheduler utils.

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

---

## Credentials Setup

For the full step-by-step guide to setting up Google Cloud (Gmail) and Azure Portal (Outlook) OAuth credentials, see [SETUP.md](./SETUP.md).

---

## Privacy Guarantees

| What | Where | Access |
|---|---|---|
| Email bodies + subjects | `data/inboxmy.db` — AES-256-GCM encrypted | Only the device holding `ENCRYPTION_KEY` |
| OAuth tokens | Same DB, encrypted separately | Same |
| Gemini API key | Windows DPAPI (`safeStorage`) — never logged or transmitted | Local device only |
| Network | API bound to `127.0.0.1` — not reachable from LAN or internet | Local device only |
| Telemetry | None | N/A |
