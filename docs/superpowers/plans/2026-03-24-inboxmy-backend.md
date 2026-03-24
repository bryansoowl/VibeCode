# InboxMy Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a privacy-first, locally-running backend that aggregates up to 6 Gmail/Outlook accounts, parses Malaysian-specific emails (TNB, LHDN, Shopee, etc.), and serves a unified REST API — with all email data stored encrypted on the user's own machine.

**Architecture:** Node.js + Express API server that runs locally (localhost:3001). Email metadata and parsed data are stored in an encrypted SQLite database on disk — nothing is sent to any remote server. OAuth tokens are stored locally with AES-256 encryption. Email parsing runs entirely in-process using deterministic regex rules trained on Malaysian sender/subject patterns.

**Tech Stack:** Node.js 20, Express 5, better-sqlite3, node-forge (AES-256 encryption), googleapis (Gmail API), @microsoft/microsoft-graph-client (Outlook), node-cron (sync scheduling), zod (validation), vitest (tests), tsx (TypeScript runner)

---

## Scope Check

This plan covers **one subsystem**: the backend API + email engine. The frontend (landing page, dashboard HTML) is a separate concern and integrates via the REST API defined in Task 9.

---

## File Structure

```
inboxmy-backend/
├── src/
│   ├── server.ts                  # Express app entry point
│   ├── config.ts                  # Environment config + constants
│   ├── crypto.ts                  # AES-256 encrypt/decrypt helpers
│   ├── db/
│   │   ├── index.ts               # SQLite connection singleton
│   │   ├── migrations.ts          # Schema creation + migrations
│   │   └── schema.sql             # Reference schema (not executed directly)
│   ├── auth/
│   │   ├── gmail.ts               # Google OAuth2 flow
│   │   ├── outlook.ts             # Microsoft OAuth2 flow
│   │   └── token-store.ts         # Encrypted token read/write
│   ├── email/
│   │   ├── gmail-client.ts        # Gmail API fetch + normalize
│   │   ├── outlook-client.ts      # Graph API fetch + normalize
│   │   ├── sync-engine.ts         # Orchestrates multi-account sync
│   │   └── types.ts               # Shared email types (NormalizedEmail)
│   ├── parsers/
│   │   ├── index.ts               # Parser registry + dispatch
│   │   ├── tnb.ts                 # Tenaga Nasional bills
│   │   ├── unifi.ts               # Unifi broadband invoices
│   │   ├── celcom-maxis.ts        # Celcom/Maxis postpaid bills
│   │   ├── tng.ts                 # Touch 'n Go reload/statements
│   │   ├── lhdn.ts                # LHDN e-Filing & tax notices
│   │   ├── mysejahtera.ts         # MySejahtera notifications
│   │   ├── shopee.ts              # Shopee order confirmations
│   │   ├── lazada.ts              # Lazada receipts
│   │   └── generic-bill.ts        # Fallback RM amount extractor
│   ├── routes/
│   │   ├── accounts.ts            # GET/POST/DELETE /api/accounts
│   │   ├── emails.ts              # GET /api/emails, /api/emails/:id
│   │   ├── bills.ts               # GET /api/bills (parsed bill summary)
│   │   └── sync.ts                # POST /api/sync/trigger
│   └── scheduler.ts               # node-cron sync job (every 15 min)
├── tests/
│   ├── crypto.test.ts
│   ├── parsers/
│   │   ├── tnb.test.ts
│   │   ├── lhdn.test.ts
│   │   ├── shopee.test.ts
│   │   └── generic-bill.test.ts
│   ├── routes/
│   │   ├── accounts.test.ts
│   │   └── emails.test.ts
│   └── fixtures/
│       ├── tnb-email.html          # Real-format sample (anonymised)
│       ├── lhdn-email.txt
│       ├── shopee-email.html
│       └── lazada-email.html
├── .env.example
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

---

## Task 1: Project Bootstrap

**Files:**
- Create: `inboxmy-backend/package.json`
- Create: `inboxmy-backend/tsconfig.json`
- Create: `inboxmy-backend/vitest.config.ts`
- Create: `inboxmy-backend/.env.example`

- [ ] **Step 1: Initialise project**

```bash
mkdir inboxmy-backend && cd inboxmy-backend
npm init -y
```

- [ ] **Step 2: Install runtime dependencies**

```bash
npm install express better-sqlite3 node-forge googleapis \
  @microsoft/microsoft-graph-client @azure/msal-node \
  node-cron zod dotenv cors helmet
```

- [ ] **Step 3: Install dev dependencies**

```bash
npm install -D typescript tsx vitest @types/express \
  @types/better-sqlite3 @types/node @types/node-cron \
  @types/node-forge supertest @types/supertest
```

- [ ] **Step 4: Write tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "CommonJS",
    "moduleResolution": "node",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "skipLibCheck": true
  },
  "include": ["src", "tests"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 5: Write vitest.config.ts**

```typescript
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
})
```

- [ ] **Step 6: Write .env.example**

```env
# Server
PORT=3001
DATA_DIR=./data

# Encryption — generate with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
ENCRYPTION_KEY=replace_with_64_char_hex

# Google OAuth (https://console.cloud.google.com)
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=http://localhost:3001/auth/gmail/callback

# Microsoft OAuth (https://portal.azure.com)
MICROSOFT_CLIENT_ID=
MICROSOFT_CLIENT_SECRET=
MICROSOFT_REDIRECT_URI=http://localhost:3001/auth/outlook/callback

# Sync interval in minutes (default: 15)
SYNC_INTERVAL_MINUTES=15
```

- [ ] **Step 7: Add package.json scripts**

```json
{
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "build": "tsc",
    "start": "node dist/server.js",
    "test": "vitest run",
    "test:watch": "vitest"
  }
}
```

- [ ] **Step 8: Commit**

```bash
git add . && git commit -m "chore: bootstrap inboxmy-backend project"
```

---

## Task 2: Crypto Module

**Files:**
- Create: `src/crypto.ts`
- Create: `src/config.ts`
- Test: `tests/crypto.test.ts`

Privacy guarantee: all email bodies, subjects, and OAuth tokens are AES-256-GCM encrypted before touching disk. The key lives only in `.env` (user's machine).

- [ ] **Step 1: Write the failing test**

```typescript
// tests/crypto.test.ts
import { encrypt, decrypt } from '../src/crypto'

describe('crypto', () => {
  it('round-trips a plaintext string', () => {
    const plain = 'Hello, Malaysia!'
    const cipher = encrypt(plain)
    expect(cipher).not.toBe(plain)
    expect(decrypt(cipher)).toBe(plain)
  })

  it('produces different ciphertext for same input (random IV)', () => {
    const plain = 'same input'
    expect(encrypt(plain)).not.toBe(encrypt(plain))
  })

  it('throws on tampered ciphertext', () => {
    const cipher = encrypt('safe')
    expect(() => decrypt(cipher + 'x')).toThrow()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd inboxmy-backend && npx vitest run tests/crypto.test.ts
```
Expected: FAIL — `Cannot find module '../src/crypto'`

- [ ] **Step 3: Write config.ts**

```typescript
// src/config.ts
import dotenv from 'dotenv'
dotenv.config()

function required(key: string): string {
  const val = process.env[key]
  if (!val) throw new Error(`Missing required env var: ${key}`)
  return val
}

export const config = {
  port: parseInt(process.env.PORT ?? '3001'),
  dataDir: process.env.DATA_DIR ?? './data',
  encryptionKey: required('ENCRYPTION_KEY'),
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID ?? '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? '',
    redirectUri: process.env.GOOGLE_REDIRECT_URI ?? 'http://localhost:3001/auth/gmail/callback',
  },
  microsoft: {
    clientId: process.env.MICROSOFT_CLIENT_ID ?? '',
    clientSecret: process.env.MICROSOFT_CLIENT_SECRET ?? '',
    redirectUri: process.env.MICROSOFT_REDIRECT_URI ?? 'http://localhost:3001/auth/outlook/callback',
  },
  syncIntervalMinutes: parseInt(process.env.SYNC_INTERVAL_MINUTES ?? '15'),
}
```

- [ ] **Step 4: Write crypto.ts**

```typescript
// src/crypto.ts
import forge from 'node-forge'
import { config } from './config'

function getKey(): forge.util.ByteStringBuffer {
  return forge.util.createBuffer(
    forge.util.hexToBytes(config.encryptionKey)
  )
}

export function encrypt(plaintext: string): string {
  const iv = forge.random.getBytesSync(12)
  const cipher = forge.cipher.createCipher('AES-GCM', getKey())
  cipher.start({ iv })
  cipher.update(forge.util.createBuffer(plaintext, 'utf8'))
  cipher.finish()

  const encrypted = cipher.output.bytes()
  const tag = (cipher as any).mode.tag.bytes()

  const combined = iv + tag + encrypted
  return forge.util.encode64(combined)
}

export function decrypt(ciphertext: string): string {
  const combined = forge.util.decode64(ciphertext)
  const iv = combined.slice(0, 12)
  const tag = forge.util.createBuffer(combined.slice(12, 28))
  const encrypted = combined.slice(28)

  const decipher = forge.cipher.createDecipher('AES-GCM', getKey())
  decipher.start({ iv, tag })
  decipher.update(forge.util.createBuffer(encrypted))
  const pass = decipher.finish()

  if (!pass) throw new Error('Decryption failed: data may be tampered')
  return decipher.output.toString()
}
```

- [ ] **Step 5: Set test env var and run tests**

```bash
ENCRYPTION_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") \
  npx vitest run tests/crypto.test.ts
```
Expected: 3 PASS

- [ ] **Step 6: Commit**

```bash
git add src/config.ts src/crypto.ts tests/crypto.test.ts
git commit -m "feat: add AES-256-GCM crypto module"
```

---

## Task 3: Database Schema & Migrations

**Files:**
- Create: `src/db/index.ts`
- Create: `src/db/migrations.ts`
- Create: `src/db/schema.sql` (reference only)

- [ ] **Step 1: Write schema.sql (reference)**

```sql
-- src/db/schema.sql
CREATE TABLE IF NOT EXISTS accounts (
  id          TEXT PRIMARY KEY,           -- uuid
  provider    TEXT NOT NULL,              -- 'gmail' | 'outlook'
  email       TEXT NOT NULL UNIQUE,
  label       TEXT,                       -- user nickname
  token_enc   TEXT NOT NULL,             -- encrypted JSON {access,refresh,expiry}
  created_at  INTEGER NOT NULL,
  last_synced INTEGER
);

CREATE TABLE IF NOT EXISTS emails (
  id           TEXT PRIMARY KEY,          -- provider message id
  account_id   TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  thread_id    TEXT,
  subject_enc  TEXT NOT NULL,             -- encrypted
  sender       TEXT NOT NULL,             -- NOT encrypted (used for filtering)
  sender_name  TEXT,
  received_at  INTEGER NOT NULL,          -- unix ms
  is_read      INTEGER NOT NULL DEFAULT 0,
  category     TEXT,                      -- 'bill'|'govt'|'receipt'|'work'|null
  body_enc     TEXT,                      -- encrypted HTML/text body
  snippet      TEXT,                      -- short plaintext preview (encrypted)
  raw_size     INTEGER
);

CREATE TABLE IF NOT EXISTS parsed_bills (
  id           TEXT PRIMARY KEY,          -- uuid
  email_id     TEXT NOT NULL REFERENCES emails(id) ON DELETE CASCADE,
  biller       TEXT NOT NULL,             -- 'TNB'|'Unifi'|'Celcom'|...
  amount_rm    REAL,
  due_date     INTEGER,                   -- unix ms
  account_ref  TEXT,                      -- account/bill number
  status       TEXT DEFAULT 'unpaid',     -- 'unpaid'|'paid'|'overdue'
  parsed_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id   TEXT NOT NULL,
  started_at   INTEGER NOT NULL,
  finished_at  INTEGER,
  emails_added INTEGER DEFAULT 0,
  error        TEXT
);

CREATE INDEX IF NOT EXISTS idx_emails_account ON emails(account_id);
CREATE INDEX IF NOT EXISTS idx_emails_category ON emails(category);
CREATE INDEX IF NOT EXISTS idx_emails_received ON emails(received_at DESC);
CREATE INDEX IF NOT EXISTS idx_bills_due ON parsed_bills(due_date);
```

- [ ] **Step 2: Write db/index.ts**

```typescript
// src/db/index.ts
import Database from 'better-sqlite3'
import path from 'path'
import fs from 'fs'
import { config } from '../config'
import { runMigrations } from './migrations'

let _db: Database.Database | null = null

export function getDb(): Database.Database {
  if (_db) return _db

  const dir = path.resolve(config.dataDir)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })

  _db = new Database(path.join(dir, 'inboxmy.db'))
  _db.pragma('journal_mode = WAL')
  _db.pragma('foreign_keys = ON')
  runMigrations(_db)
  return _db
}

export function closeDb(): void {
  if (_db) {
    _db.close()
    _db = null
  }
}
```

- [ ] **Step 3: Write db/migrations.ts**

```typescript
// src/db/migrations.ts
import Database from 'better-sqlite3'

const MIGRATIONS: string[] = [
  // Migration 1: initial schema
  `
  CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY, provider TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE, label TEXT,
    token_enc TEXT NOT NULL, created_at INTEGER NOT NULL,
    last_synced INTEGER
  );
  CREATE TABLE IF NOT EXISTS emails (
    id TEXT PRIMARY KEY, account_id TEXT NOT NULL
      REFERENCES accounts(id) ON DELETE CASCADE,
    thread_id TEXT, subject_enc TEXT NOT NULL,
    sender TEXT NOT NULL, sender_name TEXT,
    received_at INTEGER NOT NULL, is_read INTEGER NOT NULL DEFAULT 0,
    category TEXT, body_enc TEXT, snippet TEXT, raw_size INTEGER
  );
  CREATE TABLE IF NOT EXISTS parsed_bills (
    id TEXT PRIMARY KEY, email_id TEXT NOT NULL
      REFERENCES emails(id) ON DELETE CASCADE,
    biller TEXT NOT NULL, amount_rm REAL, due_date INTEGER,
    account_ref TEXT, status TEXT DEFAULT 'unpaid', parsed_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sync_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL,
    started_at INTEGER NOT NULL, finished_at INTEGER,
    emails_added INTEGER DEFAULT 0, error TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_emails_account ON emails(account_id);
  CREATE INDEX IF NOT EXISTS idx_emails_category ON emails(category);
  CREATE INDEX IF NOT EXISTS idx_emails_received ON emails(received_at DESC);
  CREATE INDEX IF NOT EXISTS idx_bills_due ON parsed_bills(due_date);
  `,
]

export function runMigrations(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)`)
  const row = db.prepare('SELECT MAX(version) as v FROM schema_version').get() as any
  const current = row?.v ?? 0

  for (let i = current; i < MIGRATIONS.length; i++) {
    db.exec(MIGRATIONS[i])
    db.prepare('INSERT OR REPLACE INTO schema_version VALUES (?)').run(i + 1)
  }
}
```

- [ ] **Step 4: Verify DB initialises**

```bash
ENCRYPTION_KEY=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
  npx tsx -e "import { getDb } from './src/db/index'; const db = getDb(); console.log(db.prepare('SELECT name FROM sqlite_master WHERE type=\\'table\\'').all())"
```
Expected: array containing `accounts`, `emails`, `parsed_bills`, `sync_log`

- [ ] **Step 5: Commit**

```bash
git add src/db/ && git commit -m "feat: sqlite schema with AES-encrypted columns"
```

---

## Task 4: Gmail OAuth2 Flow

**Files:**
- Create: `src/auth/gmail.ts`
- Create: `src/auth/token-store.ts`

- [ ] **Step 1: Write token-store.ts**

```typescript
// src/auth/token-store.ts
import { getDb } from '../db'
import { encrypt, decrypt } from '../crypto'

export interface OAuthToken {
  accessToken: string
  refreshToken: string
  expiryMs: number
}

export function saveToken(accountId: string, token: OAuthToken): void {
  const db = getDb()
  const enc = encrypt(JSON.stringify(token))
  db.prepare(
    'UPDATE accounts SET token_enc = ? WHERE id = ?'
  ).run(enc, accountId)
}

export function loadToken(accountId: string): OAuthToken {
  const db = getDb()
  const row = db.prepare('SELECT token_enc FROM accounts WHERE id = ?').get(accountId) as any
  if (!row) throw new Error(`Account ${accountId} not found`)
  return JSON.parse(decrypt(row.token_enc))
}
```

- [ ] **Step 2: Write auth/gmail.ts**

```typescript
// src/auth/gmail.ts
import { google } from 'googleapis'
import { randomUUID } from 'crypto'
import { getDb } from '../db'
import { encrypt } from '../crypto'
import { saveToken, loadToken } from './token-store'
import { config } from '../config'

export function getOAuthClient() {
  return new google.auth.OAuth2(
    config.google.clientId,
    config.google.clientSecret,
    config.google.redirectUri
  )
}

export function getAuthUrl(state?: string): string {
  const client = getOAuthClient()
  return client.generateAuthUrl({
    access_type: 'offline',
    scope: [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/userinfo.email',
    ],
    state,
    prompt: 'consent',
  })
}

export async function handleCallback(code: string): Promise<string> {
  const client = getOAuthClient()
  const { tokens } = await client.getToken(code)

  // Get user email
  client.setCredentials(tokens)
  const oauth2 = google.oauth2({ version: 'v2', auth: client })
  const { data } = await oauth2.userinfo.get()
  const email = data.email!

  const db = getDb()
  const existing = db.prepare('SELECT id FROM accounts WHERE email = ?').get(email) as any
  const accountId = existing?.id ?? randomUUID()

  const tokenData = {
    accessToken: tokens.access_token!,
    refreshToken: tokens.refresh_token ?? '',
    expiryMs: tokens.expiry_date ?? Date.now() + 3600_000,
  }

  // Upsert — avoids race condition if two auth flows complete simultaneously
  db.prepare(`
    INSERT INTO accounts (id, provider, email, token_enc, created_at)
    VALUES (?, 'gmail', ?, ?, ?)
    ON CONFLICT(email) DO UPDATE SET token_enc = excluded.token_enc
  `).run(accountId, email, encrypt(JSON.stringify(tokenData)), Date.now())

  return accountId
}

export async function getAuthedClient(accountId: string) {
  const token = loadToken(accountId)
  const client = getOAuthClient()
  client.setCredentials({
    access_token: token.accessToken,
    refresh_token: token.refreshToken,
    expiry_date: token.expiryMs,
  })
  // Auto-refresh if needed
  client.on('tokens', (tokens) => {
    if (tokens.access_token) {
      saveToken(accountId, {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token ?? token.refreshToken,
        expiryMs: tokens.expiry_date ?? Date.now() + 3600_000,
      })
    }
  })
  return client
}
```

- [ ] **Step 3: Commit**

```bash
git add src/auth/ && git commit -m "feat: gmail oauth2 flow with encrypted token storage"
```

---

## Task 5: Outlook OAuth2 Flow

**Files:**
- Create: `src/auth/outlook.ts`

- [ ] **Step 1: Write auth/outlook.ts**

```typescript
// src/auth/outlook.ts
import { ConfidentialClientApplication } from '@azure/msal-node'
import { randomUUID } from 'crypto'
import { getDb } from '../db'
import { encrypt } from '../crypto'
import { saveToken, loadToken } from './token-store'
import { config } from '../config'

const SCOPES = ['https://graph.microsoft.com/Mail.Read', 'User.Read', 'offline_access']

function getMsalApp() {
  return new ConfidentialClientApplication({
    auth: {
      clientId: config.microsoft.clientId,
      clientSecret: config.microsoft.clientSecret,
      authority: 'https://login.microsoftonline.com/common',
    },
  })
}

export async function getAuthUrl(state?: string): Promise<string> {
  const app = getMsalApp()
  return app.getAuthCodeUrl({
    scopes: SCOPES,
    redirectUri: config.microsoft.redirectUri,
    state,
  })
}

export async function handleCallback(code: string): Promise<string> {
  const app = getMsalApp()
  const result = await app.acquireTokenByCode({
    code,
    scopes: SCOPES,
    redirectUri: config.microsoft.redirectUri,
  })

  const email = result.account?.username!
  const db = getDb()
  const existing = db.prepare('SELECT id FROM accounts WHERE email = ?').get(email) as any
  const accountId = existing?.id ?? randomUUID()

  const tokenData = {
    accessToken: result.accessToken,
    refreshToken: '',          // MSAL handles refresh internally via cache
    expiryMs: result.expiresOn?.getTime() ?? Date.now() + 3600_000,
  }

  // Upsert — avoids race condition on concurrent auth
  db.prepare(`
    INSERT INTO accounts (id, provider, email, token_enc, created_at)
    VALUES (?, 'outlook', ?, ?, ?)
    ON CONFLICT(email) DO UPDATE SET token_enc = excluded.token_enc
  `).run(accountId, email, encrypt(JSON.stringify(tokenData)), Date.now())

  return accountId
}

export async function getAccessToken(accountId: string): Promise<string> {
  // For Outlook, re-acquire silently each call — MSAL caches internally
  const token = loadToken(accountId)
  if (token.expiryMs > Date.now() + 60_000) return token.accessToken

  const db = getDb()
  const row = db.prepare('SELECT email FROM accounts WHERE id = ?').get(accountId) as any
  const app = getMsalApp()
  const accounts = await app.getTokenCache().getAllAccounts()
  const account = accounts.find(a => a.username === row.email)

  if (!account) throw new Error('Outlook account not found in MSAL cache — re-auth required')

  const result = await app.acquireTokenSilent({ scopes: SCOPES, account })
  const updated = {
    accessToken: result!.accessToken,
    refreshToken: '',
    expiryMs: result!.expiresOn?.getTime() ?? Date.now() + 3600_000,
  }
  saveToken(accountId, updated)
  return updated.accessToken
}
```

- [ ] **Step 2: Commit**

```bash
git add src/auth/outlook.ts && git commit -m "feat: outlook/microsoft oauth2 via msal"
```

---

## Task 6: Email Normalisation & Gmail Fetch

**Files:**
- Create: `src/email/types.ts`
- Create: `src/email/gmail-client.ts`

- [ ] **Step 1: Write email/types.ts**

```typescript
// src/email/types.ts
export type EmailCategory = 'bill' | 'govt' | 'receipt' | 'work' | null

export interface NormalizedEmail {
  id: string            // provider message id
  accountId: string
  threadId: string | null
  subject: string       // plaintext (will be encrypted on store)
  sender: string        // email address
  senderName: string | null
  receivedAt: number    // unix ms
  isRead: boolean
  category: EmailCategory
  bodyHtml: string | null
  bodyText: string | null
  snippet: string | null
  rawSize: number
}
```

- [ ] **Step 2: Write email/gmail-client.ts**

```typescript
// src/email/gmail-client.ts
import { google } from 'googleapis'
import { getAuthedClient } from '../auth/gmail'
import type { NormalizedEmail } from './types'

const FETCH_LIMIT = 50  // per sync run

export async function fetchNewEmails(
  accountId: string,
  sinceMs: number | null
): Promise<NormalizedEmail[]> {
  const auth = await getAuthedClient(accountId)
  const gmail = google.gmail({ version: 'v1', auth })

  const query = sinceMs
    ? `after:${Math.floor(sinceMs / 1000)}`
    : 'newer_than:30d'

  const list = await gmail.users.messages.list({
    userId: 'me',
    q: query,
    maxResults: FETCH_LIMIT,
  })

  const messages = list.data.messages ?? []
  const emails: NormalizedEmail[] = []

  for (const msg of messages) {
    const full = await gmail.users.messages.get({
      userId: 'me',
      id: msg.id!,
      format: 'full',
    })

    emails.push(normalizeGmailMessage(accountId, full.data))
  }

  return emails
}

function normalizeGmailMessage(accountId: string, msg: any): NormalizedEmail {
  const headers: Record<string, string> = {}
  for (const h of msg.payload?.headers ?? []) {
    headers[h.name.toLowerCase()] = h.value
  }

  const from = headers['from'] ?? ''
  const senderMatch = from.match(/^(.+?)\s*<([^>]+)>$/)
  const senderEmail = senderMatch ? senderMatch[2] : from
  const senderName = senderMatch ? senderMatch[1].replace(/"/g, '').trim() : null

  const { htmlBody, textBody } = extractBody(msg.payload)

  return {
    id: msg.id,
    accountId,
    threadId: msg.threadId ?? null,
    subject: headers['subject'] ?? '(no subject)',
    sender: senderEmail.toLowerCase(),
    senderName,
    receivedAt: parseInt(msg.internalDate ?? '0'),
    isRead: !(msg.labelIds ?? []).includes('UNREAD'),
    category: null,  // set by parser
    bodyHtml: htmlBody,
    bodyText: textBody,
    snippet: msg.snippet ?? null,
    rawSize: msg.sizeEstimate ?? 0,
  }
}

function extractBody(payload: any): { htmlBody: string | null; textBody: string | null } {
  let htmlBody: string | null = null
  let textBody: string | null = null

  function walk(part: any) {
    if (!part) return
    if (part.mimeType === 'text/html' && part.body?.data) {
      htmlBody = Buffer.from(part.body.data, 'base64').toString('utf-8')
    } else if (part.mimeType === 'text/plain' && part.body?.data) {
      textBody = Buffer.from(part.body.data, 'base64').toString('utf-8')
    }
    for (const sub of part.parts ?? []) walk(sub)
  }

  walk(payload)
  return { htmlBody, textBody }
}
```

- [ ] **Step 3: Commit**

```bash
git add src/email/ && git commit -m "feat: gmail email fetch + normalisation"
```

---

## Task 7: Outlook Email Fetch

**Files:**
- Create: `src/email/outlook-client.ts`

- [ ] **Step 1: Write outlook-client.ts**

```typescript
// src/email/outlook-client.ts
import { Client } from '@microsoft/microsoft-graph-client'
import { getAccessToken } from '../auth/outlook'
import type { NormalizedEmail } from './types'

export async function fetchNewEmails(
  accountId: string,
  sinceMs: number | null
): Promise<NormalizedEmail[]> {
  const accessToken = await getAccessToken(accountId)
  const client = Client.init({
    authProvider: (done) => done(null, accessToken),
  })

  const since = sinceMs
    ? new Date(sinceMs).toISOString()
    : new Date(Date.now() - 30 * 86400_000).toISOString()

  const result = await client
    .api('/me/messages')
    .filter(`receivedDateTime gt ${since}`)
    .select('id,subject,from,receivedDateTime,isRead,bodyPreview,body,conversationId,size')
    .top(50)
    .get()

  return (result.value ?? []).map((msg: any) => normalizeGraphMessage(accountId, msg))
}

function normalizeGraphMessage(accountId: string, msg: any): NormalizedEmail {
  const from = msg.from?.emailAddress
  return {
    id: msg.id,
    accountId,
    threadId: msg.conversationId ?? null,
    subject: msg.subject ?? '(no subject)',
    sender: (from?.address ?? '').toLowerCase(),
    senderName: from?.name ?? null,
    receivedAt: new Date(msg.receivedDateTime).getTime(),
    isRead: msg.isRead,
    category: null,
    bodyHtml: msg.body?.contentType === 'html' ? msg.body.content : null,
    bodyText: msg.body?.contentType === 'text' ? msg.body.content : null,
    snippet: msg.bodyPreview ?? null,
    rawSize: msg.size ?? 0,
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/email/outlook-client.ts && git commit -m "feat: outlook graph api email fetch"
```

---

## Task 8: Malaysian Email Parsers

**Files:**
- Create: `src/parsers/types.ts`
- Create: `src/parsers/tnb.ts`
- Create: `src/parsers/unifi.ts`
- Create: `src/parsers/celcom-maxis.ts`
- Create: `src/parsers/tng.ts`
- Create: `src/parsers/lhdn.ts`
- Create: `src/parsers/mysejahtera.ts`
- Create: `src/parsers/shopee.ts`
- Create: `src/parsers/lazada.ts`
- Create: `src/parsers/generic-bill.ts`
- Create: `src/parsers/index.ts`
- Test: `tests/parsers/tnb.test.ts`
- Test: `tests/parsers/lhdn.test.ts`
- Test: `tests/parsers/shopee.test.ts`
- Test: `tests/parsers/generic-bill.test.ts`

### 8a — Parser shared types + TNB

- [ ] **Step 1: Write parser types**

```typescript
// src/parsers/types.ts
import type { NormalizedEmail, EmailCategory } from '../email/types'

export interface ParsedBill {
  biller: string
  amountRm: number | null
  dueDateMs: number | null
  accountRef: string | null
}

export interface ParseResult {
  category: EmailCategory
  bill: ParsedBill | null
}

export interface Parser {
  name: string
  /** Return true if this parser should handle the email */
  matches(email: NormalizedEmail): boolean
  parse(email: NormalizedEmail): ParseResult
}
```

- [ ] **Step 2: Write failing TNB test**

```typescript
// tests/parsers/tnb.test.ts
import { describe, it, expect } from 'vitest'
import { tnbParser } from '../../src/parsers/tnb'
import type { NormalizedEmail } from '../../src/email/types'

function makeEmail(overrides: Partial<NormalizedEmail>): NormalizedEmail {
  return {
    id: 'test-1', accountId: 'acc-1', threadId: null,
    subject: '', sender: '', senderName: null,
    receivedAt: Date.now(), isRead: false, category: null,
    bodyHtml: null, bodyText: null, snippet: null, rawSize: 0,
    ...overrides,
  }
}

describe('tnbParser', () => {
  it('matches TNB sender', () => {
    const email = makeEmail({ sender: 'billing@tnb.com.my' })
    expect(tnbParser.matches(email)).toBe(true)
  })

  it('does not match unrelated sender', () => {
    const email = makeEmail({ sender: 'hello@shopee.com' })
    expect(tnbParser.matches(email)).toBe(false)
  })

  it('extracts amount from TNB body', () => {
    const email = makeEmail({
      sender: 'billing@tnb.com.my',
      bodyText: 'Jumlah bil anda ialah RM 134.50\nTarikh akhir bayaran: 15/04/2026\nNo. Akaun: 210123456789',
    })
    const result = tnbParser.parse(email)
    expect(result.category).toBe('bill')
    expect(result.bill?.amountRm).toBe(134.50)
    expect(result.bill?.biller).toBe('TNB')
  })

  it('extracts amount from TNB HTML body', () => {
    const email = makeEmail({
      sender: 'no-reply@tnb.com.my',
      bodyHtml: '<p>Amount Due: <strong>RM 89.20</strong></p><p>Due Date: 20 April 2026</p>',
    })
    const result = tnbParser.parse(email)
    expect(result.bill?.amountRm).toBe(89.20)
  })
})
```

- [ ] **Step 3: Run to verify fail**

```bash
npx vitest run tests/parsers/tnb.test.ts
```
Expected: FAIL — module not found

- [ ] **Step 4: Write src/parsers/tnb.ts**

```typescript
// src/parsers/tnb.ts
import type { Parser, ParseResult } from './types'
import type { NormalizedEmail } from '../email/types'
import { extractRmAmount, extractDateMs, extractAccountRef } from './generic-bill'

const TNB_SENDERS = /(@tnb\.com\.my|tenagaenasional)/i
const TNB_SUBJECTS = /bil|invoice|bayaran|payment|elektrik/i

export const tnbParser: Parser = {
  name: 'TNB',

  matches(email: NormalizedEmail): boolean {
    return TNB_SENDERS.test(email.sender) ||
      (TNB_SUBJECTS.test(email.subject) && /tnb/i.test(email.subject))
  },

  parse(email: NormalizedEmail): ParseResult {
    const body = email.bodyText ?? email.bodyHtml ?? ''
    return {
      category: 'bill',
      bill: {
        biller: 'TNB',
        amountRm: extractRmAmount(body),
        dueDateMs: extractDateMs(body),
        accountRef: extractAccountRef(body),
      },
    }
  },
}
```

- [ ] **Step 5: Write generic-bill.ts (used by all parsers)**

```typescript
// src/parsers/generic-bill.ts
import type { Parser, ParseResult } from './types'
import type { NormalizedEmail } from '../email/types'

// Matches: RM 134.50 | RM134.50 | RM 1,234.00
const RM_PATTERN = /RM\s*([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{2})?)/i

// Matches: 15/04/2026 | 15-04-2026 | 15 April 2026 | April 15, 2026
const DATE_PATTERNS = [
  /(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/,
  /(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{4})/i,
  /(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{1,2}),?\s+(\d{4})/i,
]

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
}

// Account/bill number patterns
const ACCOUNT_PATTERNS = [
  /(?:akaun|account|bil|bill|no\.?)\s*(?:no\.?)?\s*[:\#]?\s*(\d{6,14})/i,
  /(?:customer|pelanggan)\s*(?:id|no)?\s*[:\#]?\s*(\d{6,14})/i,
]

export function extractRmAmount(text: string): number | null {
  // Strip HTML tags if present
  const plain = text.replace(/<[^>]*>/g, ' ')
  const match = plain.match(RM_PATTERN)
  if (!match) return null
  return parseFloat(match[1].replace(/,/g, ''))
}

export function extractDateMs(text: string): number | null {
  const plain = text.replace(/<[^>]*>/g, ' ')

  for (const pattern of DATE_PATTERNS) {
    const m = plain.match(pattern)
    if (!m) continue

    try {
      if (/\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4}/.test(m[0])) {
        const [, d, mo, y] = m
        return new Date(parseInt(y), parseInt(mo) - 1, parseInt(d)).getTime()
      }
      if (/\d{1,2}\s+[A-Za-z]/.test(m[0])) {
        const [, d, mon, y] = m
        return new Date(parseInt(y), MONTHS[mon.toLowerCase().slice(0, 3)], parseInt(d)).getTime()
      }
      if (/[A-Za-z].*\d{1,2}/.test(m[0])) {
        const [, mon, d, y] = m
        return new Date(parseInt(y), MONTHS[mon.toLowerCase().slice(0, 3)], parseInt(d)).getTime()
      }
    } catch { continue }
  }
  return null
}

export function extractAccountRef(text: string): string | null {
  const plain = text.replace(/<[^>]*>/g, ' ')
  for (const pattern of ACCOUNT_PATTERNS) {
    const m = plain.match(pattern)
    if (m) return m[1]
  }
  return null
}

// Generic fallback parser for any RM-amount email
export const genericBillParser: Parser = {
  name: 'Generic',
  matches(email: NormalizedEmail): boolean {
    const body = email.bodyText ?? email.bodyHtml ?? ''
    return RM_PATTERN.test(body)
  },
  parse(email: NormalizedEmail): ParseResult {
    const body = email.bodyText ?? email.bodyHtml ?? ''
    return {
      category: null,
      bill: {
        biller: 'Unknown',
        amountRm: extractRmAmount(body),
        dueDateMs: extractDateMs(body),
        accountRef: extractAccountRef(body),
      },
    }
  },
}
```

- [ ] **Step 6: Run TNB tests**

```bash
npx vitest run tests/parsers/tnb.test.ts
```
Expected: 4 PASS

### 8b — Remaining Malaysian parsers

- [ ] **Step 7: Write src/parsers/unifi.ts**

```typescript
// src/parsers/unifi.ts
import type { Parser, ParseResult } from './types'
import type { NormalizedEmail } from '../email/types'
import { extractRmAmount, extractDateMs, extractAccountRef } from './generic-bill'

export const unifiParser: Parser = {
  name: 'Unifi',
  matches: (e) => /@unifi\.com\.my|tmpoint|telekom\.com\.my/i.test(e.sender),
  parse: (e) => ({
    category: 'bill',
    bill: { biller: 'Unifi', amountRm: extractRmAmount(e.bodyText ?? e.bodyHtml ?? ''),
      dueDateMs: extractDateMs(e.bodyText ?? e.bodyHtml ?? ''),
      accountRef: extractAccountRef(e.bodyText ?? e.bodyHtml ?? '') },
  }),
}
```

- [ ] **Step 8: Write src/parsers/celcom-maxis.ts**

```typescript
// src/parsers/celcom-maxis.ts
import type { Parser, ParseResult } from './types'
import type { NormalizedEmail } from '../email/types'
import { extractRmAmount, extractDateMs, extractAccountRef } from './generic-bill'

const CELCOM_MAXIS = /@(?:celcom|maxis|digi|yes4g|umobile)\.com\.my/i

export const celcomMaxisParser: Parser = {
  name: 'Celcom/Maxis',
  matches: (e) => CELCOM_MAXIS.test(e.sender),
  parse: (e) => {
    const biller = /maxis/i.test(e.sender) ? 'Maxis' : /digi/i.test(e.sender) ? 'Digi' : 'Celcom'
    const body = e.bodyText ?? e.bodyHtml ?? ''
    return { category: 'bill', bill: { biller, amountRm: extractRmAmount(body),
      dueDateMs: extractDateMs(body), accountRef: extractAccountRef(body) } }
  },
}
```

- [ ] **Step 9: Write src/parsers/tng.ts**

```typescript
// src/parsers/tng.ts
import type { Parser, ParseResult } from './types'
import type { NormalizedEmail } from '../email/types'
import { extractRmAmount } from './generic-bill'

export const tngParser: Parser = {
  name: 'Touch n Go',
  matches: (e) => /@tngdigital\.com\.my|touchngo\.com\.my/i.test(e.sender),
  parse: (e) => {
    const body = e.bodyText ?? e.bodyHtml ?? ''
    return { category: 'bill', bill: { biller: 'TnG', amountRm: extractRmAmount(body), dueDateMs: null, accountRef: null } }
  },
}
```

- [ ] **Step 10: Write src/parsers/lhdn.ts**

```typescript
// src/parsers/lhdn.ts
import type { Parser, ParseResult } from './types'
import type { NormalizedEmail } from '../email/types'

export const lhdnParser: Parser = {
  name: 'LHDN',
  matches: (e) =>
    /@(?:hasil|lhdn|irbm)\.gov\.my/i.test(e.sender) ||
    /lhdn|hasil|e-filing|e filing|cukai/i.test(e.subject),
  parse: (e) => ({ category: 'govt', bill: null }),
}
```

- [ ] **Step 11: Write src/parsers/mysejahtera.ts**

```typescript
// src/parsers/mysejahtera.ts
import type { Parser, ParseResult } from './types'
import type { NormalizedEmail } from '../email/types'

export const mysejahteraParser: Parser = {
  name: 'MySejahtera',
  matches: (e) => /mysejahtera/i.test(e.sender) || /mysejahtera/i.test(e.subject),
  parse: (e) => ({ category: 'govt', bill: null }),
}
```

- [ ] **Step 12: Write src/parsers/shopee.ts**

```typescript
// src/parsers/shopee.ts
import type { Parser, ParseResult } from './types'
import type { NormalizedEmail } from '../email/types'
import { extractRmAmount } from './generic-bill'

const ORDER_PATTERN = /(?:order|pesanan)\s*(?:no\.?|id|#)?\s*[:\#]?\s*([A-Z0-9]{12,20})/i

export const shopeeParser: Parser = {
  name: 'Shopee',
  matches: (e) => /@shopee\.com\.my|no-reply@shopee/i.test(e.sender),
  parse: (e) => {
    const body = e.bodyText ?? e.bodyHtml ?? ''
    const orderMatch = body.match(ORDER_PATTERN)
    return {
      category: 'receipt',
      bill: {
        biller: 'Shopee',
        amountRm: extractRmAmount(body),
        dueDateMs: null,
        accountRef: orderMatch ? orderMatch[1] : null,
      },
    }
  },
}
```

- [ ] **Step 13: Write src/parsers/lazada.ts**

```typescript
// src/parsers/lazada.ts
import type { Parser, ParseResult } from './types'
import type { NormalizedEmail } from '../email/types'
import { extractRmAmount } from './generic-bill'

export const lazadaParser: Parser = {
  name: 'Lazada',
  matches: (e) => /@lazada\.com\.my|@emails\.lazada/i.test(e.sender),
  parse: (e) => {
    const body = e.bodyText ?? e.bodyHtml ?? ''
    const orderMatch = body.match(/order\s*(?:no\.?|id|#)?\s*[:\#]?\s*(\d{6,})/i)
    return {
      category: 'receipt',
      bill: {
        biller: 'Lazada',
        amountRm: extractRmAmount(body),
        dueDateMs: null,
        accountRef: orderMatch ? orderMatch[1] : null,
      },
    }
  },
}
```

- [ ] **Step 14: Write parser registry src/parsers/index.ts**

```typescript
// src/parsers/index.ts
import { tnbParser } from './tnb'
import { unifiParser } from './unifi'
import { celcomMaxisParser } from './celcom-maxis'
import { tngParser } from './tng'
import { lhdnParser } from './lhdn'
import { mysejahteraParser } from './mysejahtera'
import { shopeeParser } from './shopee'
import { lazadaParser } from './lazada'
import { genericBillParser } from './generic-bill'
import type { Parser, ParseResult } from './types'
import type { NormalizedEmail } from '../email/types'

// Order matters: specific parsers run before generic fallback
const PARSERS: Parser[] = [
  tnbParser,
  unifiParser,
  celcomMaxisParser,
  tngParser,
  lhdnParser,
  mysejahteraParser,
  shopeeParser,
  lazadaParser,
  genericBillParser,
]

export function parseEmail(email: NormalizedEmail): ParseResult {
  for (const parser of PARSERS) {
    if (parser.matches(email)) return parser.parse(email)
  }
  return { category: null, bill: null }
}
```

- [ ] **Step 15: Write LHDN + Shopee + generic tests**

```typescript
// tests/parsers/lhdn.test.ts
import { lhdnParser } from '../../src/parsers/lhdn'
import type { NormalizedEmail } from '../../src/email/types'

const base: NormalizedEmail = {
  id: '1', accountId: 'a', threadId: null, subject: '',
  sender: '', senderName: null, receivedAt: 0, isRead: false,
  category: null, bodyHtml: null, bodyText: null, snippet: null, rawSize: 0,
}

describe('lhdnParser', () => {
  it('matches LHDN domain', () => {
    expect(lhdnParser.matches({ ...base, sender: 'efiling@hasil.gov.my' })).toBe(true)
  })
  it('matches LHDN subject keyword', () => {
    expect(lhdnParser.matches({ ...base, sender: 'noreply@gov.my', subject: 'e-Filing 2025 Notification' })).toBe(true)
  })
  it('categorises as govt', () => {
    const r = lhdnParser.parse({ ...base, sender: 'noreply@hasil.gov.my' })
    expect(r.category).toBe('govt')
    expect(r.bill).toBeNull()
  })
})

// tests/parsers/shopee.test.ts
import { shopeeParser } from '../../src/parsers/shopee'
import type { NormalizedEmail } from '../../src/email/types'

const base: NormalizedEmail = {
  id: '1', accountId: 'a', threadId: null, subject: 'Order Confirmed',
  sender: 'no-reply@shopee.com.my', senderName: null, receivedAt: 0,
  isRead: false, category: null, bodyHtml: null,
  bodyText: 'Your order #SG2410123456789 has been confirmed.\nTotal: RM 78.90',
  snippet: null, rawSize: 0,
}

describe('shopeeParser', () => {
  it('matches shopee sender', () => expect(shopeeParser.matches(base)).toBe(true))
  it('extracts amount and order ref', () => {
    const r = shopeeParser.parse(base)
    expect(r.category).toBe('receipt')
    expect(r.bill?.amountRm).toBe(78.90)
    expect(r.bill?.accountRef).toBe('SG2410123456789')
  })
})

// tests/parsers/generic-bill.test.ts
import { extractRmAmount, extractDateMs } from '../../src/parsers/generic-bill'

describe('extractRmAmount', () => {
  it.each([
    ['RM 134.50', 134.50],
    ['RM134.50', 134.50],
    ['RM 1,234.00', 1234.00],
    ['no amount here', null],
  ])('parses "%s"', (text, expected) => {
    expect(extractRmAmount(text)).toBe(expected)
  })
})

describe('extractDateMs', () => {
  it('parses DD/MM/YYYY', () => {
    const ms = extractDateMs('Due: 15/04/2026')
    expect(new Date(ms!).getFullYear()).toBe(2026)
    expect(new Date(ms!).getMonth()).toBe(3) // April = 3
    expect(new Date(ms!).getDate()).toBe(15)
  })
  it('parses "15 April 2026"', () => {
    const ms = extractDateMs('Pay by 15 April 2026')
    expect(new Date(ms!).getMonth()).toBe(3)
  })
})
```

- [ ] **Step 16: Write remaining parser tests (Unifi, Celcom/Maxis, TnG, Lazada)**

```typescript
// tests/parsers/remaining.test.ts
import { describe, it, expect } from 'vitest'
import { unifiParser } from '../../src/parsers/unifi'
import { celcomMaxisParser } from '../../src/parsers/celcom-maxis'
import { tngParser } from '../../src/parsers/tng'
import { lazadaParser } from '../../src/parsers/lazada'
import type { NormalizedEmail } from '../../src/email/types'

const base: NormalizedEmail = {
  id: '1', accountId: 'a', threadId: null, subject: 'Bill',
  sender: '', senderName: null, receivedAt: 0, isRead: false,
  category: null, bodyHtml: null, bodyText: null, snippet: null, rawSize: 0,
}

describe('unifiParser', () => {
  it('matches Unifi sender', () => {
    expect(unifiParser.matches({ ...base, sender: 'billing@unifi.com.my' })).toBe(true)
  })
  it('extracts amount', () => {
    const r = unifiParser.parse({ ...base, sender: 'billing@unifi.com.my',
      bodyText: 'Jumlah: RM 129.00 Tarikh: 10/05/2026' })
    expect(r.category).toBe('bill')
    expect(r.bill?.amountRm).toBe(129.00)
    expect(r.bill?.biller).toBe('Unifi')
  })
})

describe('celcomMaxisParser', () => {
  it('matches Maxis sender', () => {
    expect(celcomMaxisParser.matches({ ...base, sender: 'bill@maxis.com.my' })).toBe(true)
  })
  it('labels biller as Maxis', () => {
    const r = celcomMaxisParser.parse({ ...base, sender: 'bill@maxis.com.my',
      bodyText: 'RM 88.00 due 01/06/2026' })
    expect(r.bill?.biller).toBe('Maxis')
  })
  it('labels biller as Digi', () => {
    const r = celcomMaxisParser.parse({ ...base, sender: 'noreply@digi.com.my',
      bodyText: 'RM 45.00' })
    expect(r.bill?.biller).toBe('Digi')
  })
})

describe('tngParser', () => {
  it('matches TnG domain', () => {
    expect(tngParser.matches({ ...base, sender: 'noreply@tngdigital.com.my' })).toBe(true)
  })
  it('extracts reload amount', () => {
    const r = tngParser.parse({ ...base, sender: 'noreply@tngdigital.com.my',
      bodyText: 'Reload berjaya: RM 50.00' })
    expect(r.bill?.amountRm).toBe(50.00)
    expect(r.bill?.biller).toBe('TnG')
  })
})

describe('lazadaParser', () => {
  it('matches Lazada sender', () => {
    expect(lazadaParser.matches({ ...base, sender: 'noreply@lazada.com.my' })).toBe(true)
  })
  it('extracts amount and order ref', () => {
    const r = lazadaParser.parse({ ...base, sender: 'noreply@lazada.com.my',
      bodyText: 'Order no. 123456789 confirmed. Total paid: RM 199.00' })
    expect(r.category).toBe('receipt')
    expect(r.bill?.amountRm).toBe(199.00)
    expect(r.bill?.accountRef).toBe('123456789')
  })
})
```

- [ ] **Step 17: Run all parser tests**

```bash
npx vitest run tests/parsers/
```
Expected: all PASS

- [ ] **Step 18: Commit**

```bash
git add src/parsers/ tests/parsers/
git commit -m "feat: malaysian email parsers (tnb/unifi/lhdn/shopee/lazada/etc)"
```

---

## Task 9: Sync Engine

**Files:**
- Create: `src/email/sync-engine.ts`

- [ ] **Step 1: Write sync-engine.ts**

```typescript
// src/email/sync-engine.ts
import { getDb } from '../db'
import { encrypt } from '../crypto'
import { fetchNewEmails as fetchGmail } from './gmail-client'
import { fetchNewEmails as fetchOutlook } from './outlook-client'
import { parseEmail } from '../parsers'
import { randomUUID } from 'crypto'
import type { NormalizedEmail } from './types'

export async function syncAccount(accountId: string): Promise<{ added: number; errors: string[] }> {
  const db = getDb()
  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId) as any
  if (!account) throw new Error(`Account ${accountId} not found`)

  const logId = db.prepare(
    'INSERT INTO sync_log (account_id, started_at) VALUES (?, ?)'
  ).run(accountId, Date.now()).lastInsertRowid

  const errors: string[] = []
  let added = 0

  try {
    const sinceMs = account.last_synced ?? null
    const emails: NormalizedEmail[] = account.provider === 'gmail'
      ? await fetchGmail(accountId, sinceMs)
      : await fetchOutlook(accountId, sinceMs)

    const insertEmail = db.prepare(`
      INSERT OR IGNORE INTO emails
        (id, account_id, thread_id, subject_enc, sender, sender_name,
         received_at, is_read, category, body_enc, snippet, raw_size)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)

    const insertBill = db.prepare(`
      INSERT INTO parsed_bills (id, email_id, biller, amount_rm, due_date, account_ref, parsed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)

    const syncAll = db.transaction((emails: NormalizedEmail[]) => {
      for (const email of emails) {
        const parsed = parseEmail(email)
        const body = email.bodyHtml ?? email.bodyText ?? ''

        const result = insertEmail.run(
          email.id, accountId, email.threadId ?? null,
          encrypt(email.subject),
          email.sender, email.senderName ?? null,
          email.receivedAt, email.isRead ? 1 : 0,
          parsed.category ?? null,
          body ? encrypt(body) : null,
          email.snippet ? encrypt(email.snippet) : null,
          email.rawSize
        )

        if (result.changes > 0) {
          added++
          if (parsed.bill?.amountRm != null || parsed.bill?.dueDateMs != null) {
            insertBill.run(
              randomUUID(), email.id, parsed.bill.biller,
              parsed.bill.amountRm ?? null, parsed.bill.dueDateMs ?? null,
              parsed.bill.accountRef ?? null, Date.now()
            )
          }
        }
      }
    })

    syncAll(emails)

    db.prepare('UPDATE accounts SET last_synced = ? WHERE id = ?').run(Date.now(), accountId)
    db.prepare('UPDATE sync_log SET finished_at = ?, emails_added = ? WHERE id = ?')
      .run(Date.now(), added, logId)

  } catch (err: any) {
    errors.push(err.message)
    db.prepare('UPDATE sync_log SET finished_at = ?, error = ? WHERE id = ?')
      .run(Date.now(), err.message, logId)
  }

  return { added, errors }
}

export async function syncAllAccounts(): Promise<void> {
  const db = getDb()
  const accounts = db.prepare('SELECT id FROM accounts').all() as any[]
  for (const acc of accounts) {
    await syncAccount(acc.id)
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/email/sync-engine.ts && git commit -m "feat: multi-account sync engine with parser integration"
```

---

## Task 10: REST API Routes

**Files:**
- Create: `src/routes/accounts.ts`
- Create: `src/routes/emails.ts`
- Create: `src/routes/bills.ts`
- Create: `src/routes/sync.ts`
- Test: `tests/routes/accounts.test.ts`

- [ ] **Step 1: Write accounts route**

```typescript
// src/routes/accounts.ts
import { Router } from 'express'
import { getDb } from '../db'
import { decrypt } from '../crypto'
import { getAuthUrl as getGmailUrl, handleCallback as gmailCallback } from '../auth/gmail'
import { getAuthUrl as getOutlookUrl, handleCallback as outlookCallback } from '../auth/outlook'

export const accountsRouter = Router()

accountsRouter.get('/', (req, res) => {
  const db = getDb()
  const accounts = db.prepare(
    'SELECT id, provider, email, label, created_at, last_synced FROM accounts'
  ).all()
  res.json({ accounts })
})

accountsRouter.delete('/:id', (req, res) => {
  const db = getDb()
  const result = db.prepare('DELETE FROM accounts WHERE id = ?').run(req.params.id)
  if (result.changes === 0) return res.status(404).json({ error: 'Account not found' })
  res.json({ ok: true })
})

accountsRouter.patch('/:id/label', (req, res) => {
  const { label } = req.body
  if (typeof label !== 'string') return res.status(400).json({ error: 'label must be string' })
  const db = getDb()
  db.prepare('UPDATE accounts SET label = ? WHERE id = ?').run(label, req.params.id)
  res.json({ ok: true })
})

// OAuth initiation
accountsRouter.get('/connect/gmail', async (req, res) => {
  const url = getGmailUrl()
  res.redirect(url)
})

accountsRouter.get('/connect/outlook', async (req, res) => {
  const url = await getOutlookUrl()
  res.redirect(url)
})
```

- [ ] **Step 2: Write emails route**

```typescript
// src/routes/emails.ts
import { Router, type Request, type Response } from 'express'
import { getDb } from '../db'
import { decrypt } from '../crypto'
import { z } from 'zod'

export const emailsRouter = Router()

const listQuery = z.object({
  category: z.enum(['bill', 'govt', 'receipt', 'work']).optional(),
  accountId: z.string().optional(),
  limit: z.coerce.number().min(1).max(100).default(50),
  offset: z.coerce.number().min(0).default(0),
  search: z.string().max(100).optional(),
})

emailsRouter.get('/', (req: Request, res: Response) => {
  const parsed = listQuery.safeParse(req.query)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })

  const { category, accountId, limit, offset, search } = parsed.data
  const db = getDb()

  let query = `SELECT e.id, e.account_id, e.thread_id, e.subject_enc,
    e.sender, e.sender_name, e.received_at, e.is_read, e.category,
    e.snippet, e.raw_size
    FROM emails e WHERE 1=1`
  const params: any[] = []

  if (category) { query += ' AND e.category = ?'; params.push(category) }
  if (accountId) { query += ' AND e.account_id = ?'; params.push(accountId) }
  // Search on sender (unencrypted) — subject search not possible on encrypted column
  if (search) { query += ' AND e.sender LIKE ?'; params.push(`%${search}%`) }

  query += ' ORDER BY e.received_at DESC LIMIT ? OFFSET ?'
  params.push(limit, offset)

  const rows = db.prepare(query).all(...params) as any[]
  try {
    const emails = rows.map(r => ({
      ...r,
      subject: decrypt(r.subject_enc),
      snippet: r.snippet ? decrypt(r.snippet) : null,
      subject_enc: undefined,
    }))

    res.json({ emails, limit, offset })
  } catch {
    res.status(500).json({ error: 'Failed to decrypt email data' })
  }
})

emailsRouter.get('/:id', (req: Request, res: Response) => {
  const db = getDb()
  const row = db.prepare(`
    SELECT e.*, pb.biller, pb.amount_rm, pb.due_date, pb.account_ref, pb.status
    FROM emails e
    LEFT JOIN parsed_bills pb ON pb.email_id = e.id
    WHERE e.id = ?
  `).get(req.params.id) as any

  if (!row) return res.status(404).json({ error: 'Email not found' })

  try {
    res.json({
      ...row,
      subject: decrypt(row.subject_enc),
      body: row.body_enc ? decrypt(row.body_enc) : null,
      snippet: row.snippet ? decrypt(row.snippet) : null,
      subject_enc: undefined,
      body_enc: undefined,
    })
  } catch {
    res.status(500).json({ error: 'Failed to decrypt email data' })
  }
})

emailsRouter.patch('/:id/read', (req: Request, res: Response) => {
  const db = getDb()
  db.prepare('UPDATE emails SET is_read = 1 WHERE id = ?').run(req.params.id)
  res.json({ ok: true })
})
```

- [ ] **Step 3: Write bills + sync routes**

```typescript
// src/routes/bills.ts
import { Router } from 'express'
import { getDb } from '../db'
import { decrypt } from '../crypto'

export const billsRouter = Router()

billsRouter.get('/', (req, res) => {
  const db = getDb()
  const { status } = req.query

  let query = `
    SELECT pb.id, pb.biller, pb.amount_rm, pb.due_date, pb.account_ref, pb.status,
      e.subject_enc, e.received_at, e.account_id
    FROM parsed_bills pb
    JOIN emails e ON e.id = pb.email_id
    WHERE 1=1
  `
  const VALID_STATUSES = ['unpaid', 'paid', 'overdue']
  const params: any[] = []
  if (status) {
    if (!VALID_STATUSES.includes(status as string)) {
      return res.status(400).json({ error: 'Invalid status filter' })
    }
    query += ' AND pb.status = ?'
    params.push(status)
  }
  query += ' ORDER BY pb.due_date ASC'

  const rows = db.prepare(query).all(...params) as any[]
  try {
    const bills = rows.map(r => ({
      ...r,
      subject: decrypt(r.subject_enc),
      subject_enc: undefined,
    }))
    res.json({ bills })
  } catch {
    res.status(500).json({ error: 'Failed to decrypt bill data' })
  }
})

billsRouter.patch('/:id/status', (req, res) => {
  const { status } = req.body
  if (!['unpaid', 'paid', 'overdue'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' })
  }
  const db = getDb()
  db.prepare('UPDATE parsed_bills SET status = ? WHERE id = ?').run(status, req.params.id)
  res.json({ ok: true })
})

// src/routes/sync.ts
import { Router } from 'express'
import { syncAccount, syncAllAccounts } from '../email/sync-engine'

export const syncRouter = Router()

syncRouter.post('/trigger', async (req, res) => {
  const { accountId } = req.body
  try {
    if (accountId) {
      const result = await syncAccount(accountId)
      res.json(result)
    } else {
      await syncAllAccounts()
      res.json({ ok: true })
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})
```

- [ ] **Step 4: Write accounts route test**

```typescript
// tests/routes/accounts.test.ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import request from 'supertest'
import { app } from '../../src/server'
import { getDb, closeDb } from '../../src/db'
import { encrypt } from '../../src/crypto'
import { randomUUID } from 'crypto'

function seedAccount(id: string, email: string) {
  getDb().prepare(`
    INSERT OR IGNORE INTO accounts (id, provider, email, token_enc, created_at)
    VALUES (?, 'gmail', ?, ?, ?)
  `).run(id, email, encrypt('{}'), Date.now())
}

afterAll(() => closeDb())

describe('GET /api/accounts', () => {
  it('returns empty list when no accounts', async () => {
    const res = await request(app).get('/api/accounts')
    expect(res.status).toBe(200)
    expect(res.body.accounts).toBeInstanceOf(Array)
  })
})

describe('PATCH /api/accounts/:id/label', () => {
  it('updates the label', async () => {
    const id = randomUUID()
    seedAccount(id, `label-test-${id}@test.com`)
    const res = await request(app)
      .patch(`/api/accounts/${id}/label`)
      .send({ label: 'Work Gmail' })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    const row = getDb().prepare('SELECT label FROM accounts WHERE id = ?').get(id) as any
    expect(row.label).toBe('Work Gmail')
  })

  it('returns 400 for non-string label', async () => {
    const res = await request(app)
      .patch('/api/accounts/any-id/label')
      .send({ label: 123 })
    expect(res.status).toBe(400)
  })
})

describe('DELETE /api/accounts/:id', () => {
  it('deletes an existing account', async () => {
    const id = randomUUID()
    seedAccount(id, `delete-test-${id}@test.com`)
    const res = await request(app).delete(`/api/accounts/${id}`)
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    const row = getDb().prepare('SELECT id FROM accounts WHERE id = ?').get(id)
    expect(row).toBeUndefined()
  })

  it('returns 404 for non-existent account', async () => {
    const res = await request(app).delete('/api/accounts/does-not-exist')
    expect(res.status).toBe(404)
  })
})
```

- [ ] **Step 5: Commit**

```bash
git add src/routes/ tests/routes/
git commit -m "feat: rest api routes for accounts, emails, bills, sync"
```

---

## Task 11: Express Server + Auth Callbacks

**Files:**
- Create: `src/server.ts`
- Create: `src/scheduler.ts`

- [ ] **Step 1: Write server.ts**

```typescript
// src/server.ts
import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import { config } from './config'
import { getDb } from './db'
import { accountsRouter } from './routes/accounts'
import { emailsRouter } from './routes/emails'
import { billsRouter } from './routes/bills'
import { syncRouter } from './routes/sync'
import { handleCallback as gmailCallback } from './auth/gmail'
import { handleCallback as outlookCallback } from './auth/outlook'
import { startScheduler } from './scheduler'

export const app = express()

app.use(helmet())
app.use(cors({ origin: ['http://localhost:3000', 'http://localhost:5173', 'null'] }))
app.use(express.json())

// Auth callbacks (called by Google/Microsoft OAuth redirect)
app.get('/auth/gmail/callback', async (req, res) => {
  const { code, error } = req.query
  if (error || !code) return res.status(400).send(`OAuth error: ${error}`)
  try {
    const accountId = await gmailCallback(code as string)
    res.send(`<script>window.close()</script><p>Gmail connected! Account: ${accountId}</p>`)
  } catch (err: any) {
    res.status(500).send(err.message)
  }
})

app.get('/auth/outlook/callback', async (req, res) => {
  const { code, error } = req.query
  if (error || !code) return res.status(400).send(`OAuth error: ${error}`)
  try {
    const accountId = await outlookCallback(code as string)
    res.send(`<script>window.close()</script><p>Outlook connected! Account: ${accountId}</p>`)
  } catch (err: any) {
    res.status(500).send(err.message)
  }
})

// API routes
app.use('/api/accounts', accountsRouter)
app.use('/api/emails', emailsRouter)
app.use('/api/bills', billsRouter)
app.use('/api/sync', syncRouter)

app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now() }))

if (require.main === module) {
  getDb() // initialise DB on start
  startScheduler()
  const port = config.port
  app.listen(port, '127.0.0.1', () => {
    console.log(`InboxMy backend running on http://localhost:${port}`)
    console.log(`Data directory: ${config.dataDir}`)
  })
}
```

- [ ] **Step 2: Write scheduler.ts**

```typescript
// src/scheduler.ts
import cron from 'node-cron'
import { syncAllAccounts } from './email/sync-engine'
import { config } from './config'

export function startScheduler(): void {
  const interval = config.syncIntervalMinutes
  // Clamp to valid cron: 1-59 minutes
  const mins = Math.max(1, Math.min(59, interval))

  cron.schedule(`*/${mins} * * * *`, async () => {
    console.log(`[sync] Starting scheduled sync (every ${mins}m)`)
    try {
      await syncAllAccounts()
      console.log('[sync] Completed')
    } catch (err) {
      console.error('[sync] Error:', err)
    }
  })

  console.log(`[scheduler] Sync scheduled every ${mins} minutes`)
}
```

- [ ] **Step 3: Run full test suite**

```bash
ENCRYPTION_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") \
  npx vitest run
```
Expected: all tests PASS

- [ ] **Step 5: Smoke test the server**

```bash
ENCRYPTION_KEY=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
  npx tsx src/server.ts &
sleep 2
curl http://localhost:3001/health
curl http://localhost:3001/api/accounts
curl http://localhost:3001/api/emails
kill %1
```
Expected: `{"ok":true}` and `{"accounts":[]}` and `{"emails":[],...}`

- [ ] **Step 6: Commit**

```bash
git add src/server.ts src/scheduler.ts
git commit -m "feat: express server with oauth callbacks and cron sync scheduler"
```

---

## Task 12: Privacy Hardening

**Files:**
- Modify: `src/server.ts`
- Modify: `src/db/index.ts`

These changes ensure InboxMy stays genuinely privacy-first: no telemetry, no external requests except OAuth + email APIs, strict localhost binding.

- [ ] **Step 1: Bind to localhost only**

In `src/server.ts`, change `.listen(port, () =>` to `.listen(port, '127.0.0.1', () =>`.
This prevents LAN access — emails are only accessible from the user's own machine.

- [ ] **Step 2: Enable SQLite encryption-at-rest pragma check**

In `src/db/index.ts`, add after WAL pragma:
```typescript
// Verify encryption key is present before any DB access
if (!process.env.ENCRYPTION_KEY) {
  throw new Error('ENCRYPTION_KEY must be set — see .env.example')
}
```

- [ ] **Step 3: Add rate limiting to API**

```bash
npm install express-rate-limit
```

In `src/server.ts`, add before routes:
```typescript
import rateLimit from 'express-rate-limit'

app.use('/api', rateLimit({
  windowMs: 60_000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
}))
```

- [ ] **Step 4: Add .gitignore for data and .env**

```
# .gitignore
node_modules/
dist/
data/
.env
*.db
*.db-shm
*.db-wal
```

- [ ] **Step 5: Commit**

```bash
git add src/server.ts src/db/index.ts .gitignore
git commit -m "security: localhost-only binding, rate limiting, env guard"
```

---

## Task 13: Frontend API Integration Spec

The frontend (landing.html / InboxMy.html) connects to this backend via `fetch()` calls to `http://localhost:3001`. Here is the complete API surface for the frontend developer:

```
GET  /health                         → { ok: true }
GET  /api/accounts                   → { accounts: Account[] }
GET  /api/accounts/connect/gmail     → redirect to Google OAuth
GET  /api/accounts/connect/outlook   → redirect to Microsoft OAuth
DELETE /api/accounts/:id             → { ok: true }
PATCH  /api/accounts/:id/label       → { ok: true }   body: { label: string }

GET  /api/emails                     → { emails: Email[], limit, offset }
  ?category=bill|govt|receipt|work
  ?accountId=<uuid>
  ?limit=50&offset=0
GET  /api/emails/:id                 → Email (with body + parsed bill fields)
PATCH /api/emails/:id/read           → { ok: true }

GET  /api/bills                      → { bills: Bill[] }
  ?status=unpaid|paid|overdue
PATCH /api/bills/:id/status          → { ok: true }   body: { status: string }

POST /api/sync/trigger               → { added: number }
  body: { accountId?: string }       (omit accountId to sync all)
```

- [ ] **Step 1: Serve the dashboard via Express static files**

Opening CORS to all origins would expose the email API to any locally-running site. Instead, serve the dashboard through Express:

In , add before API routes:
```typescript
import path from 'path'
// Serve frontend from Express - avoids unsafe open-CORS
app.use(express.static(path.resolve(__dirname, '../../frontend')))
```

Move  and  into a  directory at the repo root. The dashboard is then accessed at  and is covered by the existing restrictive CORS config.

- [ ] **Step 2: Update fetch base URLs in frontend HTML**

All  calls in  should use relative paths (, , etc.) since the dashboard is now served by the same origin.

- [ ] **Step 3: Commit**

```bash
git add src/server.ts && git commit -m "feat: serve frontend from express, keep cors restrictive"
```

---

## API Type Reference

```typescript
interface Account {
  id: string
  provider: 'gmail' | 'outlook'
  email: string
  label: string | null
  created_at: number   // unix ms
  last_synced: number | null
}

interface Email {
  id: string
  account_id: string
  subject: string      // decrypted
  sender: string
  sender_name: string | null
  received_at: number
  is_read: 0 | 1
  category: 'bill' | 'govt' | 'receipt' | 'work' | null
  snippet: string | null
  // only in GET /api/emails/:id:
  body?: string
  biller?: string
  amount_rm?: number
  due_date?: number
  account_ref?: string
  status?: 'unpaid' | 'paid' | 'overdue'
}

interface Bill {
  id: string
  biller: string
  amount_rm: number | null
  due_date: number | null
  account_ref: string | null
  status: 'unpaid' | 'paid' | 'overdue'
  subject: string
  received_at: number
  account_id: string
}
```

---

## Running the Backend

```bash
# 1. Copy and fill in credentials
cp .env.example .env
# Edit .env with ENCRYPTION_KEY, GOOGLE_CLIENT_ID, etc.

# 2. Development mode (hot reload)
npm run dev

# 3. Production
npm run build && npm start

# 4. Run tests
npm test
```

---

## Privacy Guarantees Summary

| What | Where it lives | Who can see it |
|---|---|---|
| Email bodies | `data/inboxmy.db` (AES-256-GCM encrypted column) | Only the machine with `ENCRYPTION_KEY` |
| OAuth tokens | Same DB, separately encrypted | Same |
| Email metadata (sender, date) | Sender stored unencrypted for filtering; subject/snippet encrypted | Local only |
| Parsed bill amounts | `parsed_bills` table, amounts stored as REAL (not encrypted — these are already shown in UI) | Local only |
| Sync logs | `sync_log` table, error messages only | Local only |
| Network | API bound to `127.0.0.1` only | Cannot be reached from LAN/internet |
