# Plan 4 — Multi-User Architecture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add user sign-up/sign-in, per-user encrypted data isolation, HTTP-only cookie sessions, and password reset to the InboxMY backend and frontend.

**Architecture:** Each user gets a random 256-bit data key wrapped with a PBKDF2-derived key from their password. Sessions are stored in SQLite with a 30-day absolute TTL. All `/api/*` routes require a valid session cookie; the data key is decrypted per-request from the session row and passed explicitly to all encrypt/decrypt calls.

**Tech Stack:** Express 5, better-sqlite3, node-forge (AES-GCM), Node.js `crypto` (PBKDF2/randomBytes), bcryptjs, cookie-parser, nodemailer, Vitest + supertest

**Spec:** `docs/superpowers/specs/2026-03-25-plan4-multi-user-architecture-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `inboxmy-backend/src/crypto.ts` | Modify | Add explicit-key API; add system-key wrappers; remove old zero-arg exports |
| `inboxmy-backend/src/config.ts` | Modify | Add SESSION_SECRET, RECOVERY_SECRET required fields |
| `inboxmy-backend/src/db/migrations.ts` | Modify | Migration 2: users, sessions, password_reset_tokens, user_id on accounts |
| `inboxmy-backend/src/routes/auth.ts` | Create | signup, login, logout, me, forgot-password, reset-password |
| `inboxmy-backend/src/middleware/auth.ts` | Create | requireAuth: session lookup, TTL check, key decryption, req.user |
| `inboxmy-backend/src/routes/accounts.ts` | Modify | Filter by user_id; OAuth state relay in connect routes |
| `inboxmy-backend/src/routes/emails.ts` | Modify | Filter via accounts join with user_id; pass dataKey to decrypt |
| `inboxmy-backend/src/routes/bills.ts` | Modify | Filter via accounts/emails join with user_id; pass dataKey to decrypt |
| `inboxmy-backend/src/routes/sync.ts` | Modify | Verify account ownership; pass dataKey to sync engine |
| `inboxmy-backend/src/email/sync-engine.ts` | Modify | Accept dataKey param; pass to encrypt |
| `inboxmy-backend/src/auth/token-store.ts` | Modify | Use encryptSystem/decryptSystem |
| `inboxmy-backend/src/auth/gmail.ts` | Modify | handleCallback accepts userId; insert with user_id |
| `inboxmy-backend/src/auth/outlook.ts` | Modify | handleCallback accepts userId; insert with user_id |
| `inboxmy-backend/src/server.ts` | Modify | Mount authRouter; requireAuth on /api/*; cookie-parser; auth rate limiter; OAuth state relay; orphaned account cleanup |
| `inboxmy-backend/scripts/setup.ts` | Modify | Auto-generate SESSION_SECRET, RECOVERY_SECRET; prompt APP_URL; optional SMTP |
| `inboxmy-backend/.env` | Modify | Add SESSION_SECRET, RECOVERY_SECRET (test values for dev) |
| `inboxmy-backend/tests/crypto.test.ts` | Modify | Update for new API; add wrapKey/unwrapKey/deriveWrapKey tests |
| `inboxmy-backend/tests/routes/auth.test.ts` | Create | Auth route tests |
| `inboxmy-backend/tests/middleware/auth.test.ts` | Create | requireAuth middleware tests |
| `inboxmy-backend/tests/routes/accounts.test.ts` | Modify | Add auth helper usage; fix encryptSystem rename |
| `inboxmy-backend/tests/helpers/auth.ts` | Create | Test helper: createTestUser(), loginAs() — returns supertest agent with cookie |
| `inboxmy-backend/tests/setup.test.ts` | Modify | Add SESSION_SECRET, RECOVERY_SECRET to buildEnvContent assertions |
| `frontend/auth.html` | Create | Sign-in / sign-up page |
| `frontend/index.html` | Modify | Add sign-out button to header |
| `frontend/app.js` | Modify | Auth check on load; sign-out handler |
| `README.md` | Modify | Plan 4 status; Multi-User Architecture section |

---

## Task 1: Install dependencies and seed test env vars

**Files:**
- Modify: `inboxmy-backend/package.json` (via npm install)
- Modify: `inboxmy-backend/.env`

- [ ] **Step 1.1: Install runtime dependencies**

```bash
cd inboxmy-backend
npm install bcryptjs cookie-parser nodemailer
```

- [ ] **Step 1.2: Install type definitions**

```bash
npm install --save-dev @types/bcryptjs @types/cookie-parser @types/nodemailer
```

- [ ] **Step 1.3: Add SESSION_SECRET and RECOVERY_SECRET to .env**

Open `inboxmy-backend/.env` and append these two lines (generate real random values for production via `npm run setup`; these are dev/test values):

```
SESSION_SECRET=0000000000000000000000000000000000000000000000000000000000000001
RECOVERY_SECRET=0000000000000000000000000000000000000000000000000000000000000002
APP_URL=http://localhost:3001
```

- [ ] **Step 1.4: Verify existing tests still pass**

```bash
cd inboxmy-backend && npm test
```

Expected: All 32 tests pass (no failures from new env vars yet — crypto.ts still exports old API)

- [ ] **Step 1.5: Commit**

```bash
git add inboxmy-backend/package.json inboxmy-backend/package-lock.json inboxmy-backend/.env
git commit -m "chore: install bcryptjs, cookie-parser, nodemailer; add dev session secrets to .env"
```

---

## Task 2: Update crypto.ts with explicit-key API

The existing `encrypt(plaintext)` / `decrypt(ciphertext)` read from `config.encryptionKey` (the global key). After this task:
- `encryptSystem` / `decryptSystem` preserve the old global-key behavior (used by token-store.ts)
- `encrypt(plaintext, key)` / `decrypt(ciphertext, key)` take an explicit Buffer key (used for per-user data)
- `wrapKey`, `unwrapKey`, `deriveWrapKey` are added for key management

**Files:**
- Modify: `inboxmy-backend/src/crypto.ts`
- Modify: `inboxmy-backend/tests/crypto.test.ts`

- [ ] **Step 2.1: Write failing tests for the new crypto API**

Replace `inboxmy-backend/tests/crypto.test.ts` entirely:

```typescript
// tests/crypto.test.ts
import { randomBytes, createHash } from 'crypto'
import {
  encrypt, decrypt,
  encryptSystem, decryptSystem,
  wrapKey, unwrapKey,
  deriveWrapKey,
} from '../src/crypto'

describe('encryptSystem / decryptSystem (global ENCRYPTION_KEY)', () => {
  it('round-trips a plaintext string', () => {
    const plain = 'Hello, Malaysia!'
    const cipher = encryptSystem(plain)
    expect(cipher).not.toBe(plain)
    expect(decryptSystem(cipher)).toBe(plain)
  })

  it('produces different ciphertext for same input (random IV)', () => {
    const plain = 'same input'
    expect(encryptSystem(plain)).not.toBe(encryptSystem(plain))
  })

  it('throws on tampered ciphertext', () => {
    const cipher = encryptSystem('safe')
    expect(() => decryptSystem(cipher + 'x')).toThrow()
  })
})

describe('encrypt / decrypt (explicit key)', () => {
  it('round-trips with a 32-byte key', () => {
    const key = randomBytes(32)
    const plain = 'per-user data'
    const cipher = encrypt(plain, key)
    expect(cipher).not.toBe(plain)
    expect(decrypt(cipher, key)).toBe(plain)
  })

  it('fails to decrypt with a different key', () => {
    const key1 = randomBytes(32)
    const key2 = randomBytes(32)
    const cipher = encrypt('secret', key1)
    expect(() => decrypt(cipher, key2)).toThrow()
  })

  it('produces different ciphertext each call (random IV)', () => {
    const key = randomBytes(32)
    expect(encrypt('abc', key)).not.toBe(encrypt('abc', key))
  })
})

describe('deriveWrapKey', () => {
  it('returns a 32-byte Buffer', () => {
    const salt = randomBytes(32)
    const key = deriveWrapKey('mypassword', salt)
    expect(Buffer.isBuffer(key)).toBe(true)
    expect(key.length).toBe(32)
  })

  it('is deterministic — same password+salt → same key', () => {
    const salt = randomBytes(32)
    const k1 = deriveWrapKey('password123', salt)
    const k2 = deriveWrapKey('password123', salt)
    expect(k1.equals(k2)).toBe(true)
  })

  it('different salts → different keys', () => {
    const s1 = randomBytes(32)
    const s2 = randomBytes(32)
    const k1 = deriveWrapKey('password', s1)
    const k2 = deriveWrapKey('password', s2)
    expect(k1.equals(k2)).toBe(false)
  })
})

describe('wrapKey / unwrapKey', () => {
  it('round-trips a 32-byte data key', () => {
    const dataKey = randomBytes(32)
    const wrappingKey = randomBytes(32)
    const enc = wrapKey(dataKey, wrappingKey)
    expect(typeof enc).toBe('string')
    const recovered = unwrapKey(enc, wrappingKey)
    expect(Buffer.isBuffer(recovered)).toBe(true)
    expect(recovered.equals(dataKey)).toBe(true)
  })

  it('fails to unwrap with a wrong wrapping key', () => {
    const dataKey = randomBytes(32)
    const rightKey = randomBytes(32)
    const wrongKey = randomBytes(32)
    const enc = wrapKey(dataKey, rightKey)
    expect(() => unwrapKey(enc, wrongKey)).toThrow()
  })
})
```

- [ ] **Step 2.2: Run tests to see them fail**

```bash
cd inboxmy-backend && npm test -- --reporter=verbose tests/crypto.test.ts
```

Expected: Multiple failures — `encryptSystem`, `wrapKey`, `unwrapKey`, `deriveWrapKey` not exported

- [ ] **Step 2.3: Rewrite crypto.ts**

Replace `inboxmy-backend/src/crypto.ts` entirely:

```typescript
// src/crypto.ts
import forge from 'node-forge'
import { pbkdf2Sync } from 'crypto'
import { config } from './config'

// ─── Internal AES-256-GCM helpers ────────────────────────────────────────────

function aesEncrypt(plaintext: string, keyBuf: Buffer): string {
  const keyBytes = forge.util.createBuffer(keyBuf.toString('binary'))
  const iv = forge.random.getBytesSync(12)
  const cipher = forge.cipher.createCipher('AES-GCM', keyBytes)
  cipher.start({ iv })
  cipher.update(forge.util.createBuffer(plaintext, 'utf8'))
  cipher.finish()
  const combined = iv + (cipher as any).mode.tag.bytes() + cipher.output.bytes()
  return forge.util.encode64(combined)
}

function aesDecrypt(ciphertext: string, keyBuf: Buffer): string {
  const keyBytes = forge.util.createBuffer(keyBuf.toString('binary'))
  const combined = forge.util.decode64(ciphertext)
  const iv = combined.slice(0, 12)
  const tag = forge.util.createBuffer(combined.slice(12, 28))
  const encrypted = combined.slice(28)
  const decipher = forge.cipher.createDecipher('AES-GCM', keyBytes)
  decipher.start({ iv, tag })
  decipher.update(forge.util.createBuffer(encrypted))
  if (!decipher.finish()) throw new Error('Decryption failed: data may be tampered')
  return decipher.output.toString()
}

// ─── Explicit-key API (per-user data) ────────────────────────────────────────

export function encrypt(plaintext: string, key: Buffer): string {
  return aesEncrypt(plaintext, key)
}

export function decrypt(ciphertext: string, key: Buffer): string {
  return aesDecrypt(ciphertext, key)
}

// ─── System-key API (OAuth tokens — uses global ENCRYPTION_KEY) ──────────────

export function encryptSystem(plaintext: string): string {
  const keyBuf = Buffer.from(config.encryptionKey, 'hex')
  return aesEncrypt(plaintext, keyBuf)
}

export function decryptSystem(ciphertext: string): string {
  const keyBuf = Buffer.from(config.encryptionKey, 'hex')
  return aesDecrypt(ciphertext, keyBuf)
}

// ─── Key derivation (PBKDF2) ─────────────────────────────────────────────────
// Uses pbkdf2Sync — only called on sign-up/login paths, not hot path.
// 310,000 iterations per OWASP 2023 recommendation for SHA-256.

export function deriveWrapKey(password: string, salt: Buffer): Buffer {
  return pbkdf2Sync(password, salt, 310_000, 32, 'sha256')
}

// ─── Key wrapping (data key storage) ─────────────────────────────────────────

export function wrapKey(dataKey: Buffer, wrappingKey: Buffer): string {
  return aesEncrypt(dataKey.toString('binary'), wrappingKey)
}

export function unwrapKey(enc: string, wrappingKey: Buffer): Buffer {
  const binaryStr = aesDecrypt(enc, wrappingKey)
  return Buffer.from(binaryStr, 'binary')
}
```

- [ ] **Step 2.4: Run tests to verify they pass**

```bash
cd inboxmy-backend && npm test -- --reporter=verbose tests/crypto.test.ts
```

Expected: All crypto tests pass

- [ ] **Step 2.5: Commit**

```bash
git add inboxmy-backend/src/crypto.ts inboxmy-backend/tests/crypto.test.ts
git commit -m "feat: add explicit-key encrypt/decrypt, key wrapping, PBKDF2 to crypto.ts"
```

---

## Task 3: Update config.ts with new required secrets

**Files:**
- Modify: `inboxmy-backend/src/config.ts`

- [ ] **Step 3.1: Update config.ts**

Replace `inboxmy-backend/src/config.ts` entirely:

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
  sessionSecret: required('SESSION_SECRET'),
  recoverySecret: required('RECOVERY_SECRET'),
  appUrl: process.env.APP_URL ?? 'http://localhost:3001',
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
  smtp: {
    host: process.env.SMTP_HOST ?? '',
    port: parseInt(process.env.SMTP_PORT ?? '587'),
    user: process.env.SMTP_USER ?? '',
    pass: process.env.SMTP_PASS ?? '',
  },
  syncIntervalMinutes: parseInt(process.env.SYNC_INTERVAL_MINUTES ?? '15'),
}

export function validateConfig(): void {
  const bar = '─'.repeat(44)
  console.log(bar)
  console.log('  InboxMY Config')
  console.log(bar)

  const googleOk = !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET)
  console.log(`  ${googleOk ? '[✓]' : '[ ]'} Gmail (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET)`)
  if (!googleOk) console.log('      → Run: npm run setup')

  const msOk = !!(process.env.MICROSOFT_CLIENT_ID && process.env.MICROSOFT_CLIENT_SECRET)
  console.log(`  ${msOk ? '[✓]' : '[ ]'} Outlook (MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET)`)
  if (!msOk) console.log('      → Run: npm run setup')

  const smtpOk = !!(process.env.SMTP_HOST)
  console.log(`  ${smtpOk ? '[✓]' : '[ ]'} SMTP (password reset emails)`)
  if (!smtpOk) console.log('      → Reset links will be logged to console')

  console.log(bar)
}
```

- [ ] **Step 3.2: Run all tests to confirm nothing broke**

```bash
cd inboxmy-backend && npm test
```

Expected: All existing tests still pass (SESSION_SECRET and RECOVERY_SECRET are in .env from Task 1)

- [ ] **Step 3.3: Commit**

```bash
git add inboxmy-backend/src/config.ts
git commit -m "feat: add SESSION_SECRET, RECOVERY_SECRET, APP_URL, smtp to config"
```

---

## Task 4: Fix callers of old crypto API

`token-store.ts`, `gmail.ts`, `outlook.ts`, and `sync-engine.ts` all call the old zero-arg `encrypt`/`decrypt`. These must be updated to `encryptSystem`/`decryptSystem` before the build can compile. The sync-engine change (per-user dataKey) is deferred to Task 8 — for now, keep it on the system key so the app stays runnable.

**Files:**
- Modify: `inboxmy-backend/src/auth/token-store.ts`
- Modify: `inboxmy-backend/src/auth/gmail.ts`
- Modify: `inboxmy-backend/src/auth/outlook.ts`
- Modify: `inboxmy-backend/src/email/sync-engine.ts`
- Modify: `inboxmy-backend/tests/routes/accounts.test.ts`

- [ ] **Step 4.1: Update token-store.ts**

Replace `inboxmy-backend/src/auth/token-store.ts` entirely:

```typescript
// src/auth/token-store.ts
import { getDb } from '../db'
import { encryptSystem, decryptSystem } from '../crypto'

export interface OAuthToken {
  accessToken: string
  refreshToken: string
  expiryMs: number
}

export function saveToken(accountId: string, token: OAuthToken): void {
  const db = getDb()
  const enc = encryptSystem(JSON.stringify(token))
  db.prepare('UPDATE accounts SET token_enc = ? WHERE id = ?').run(enc, accountId)
}

export function loadToken(accountId: string): OAuthToken {
  const db = getDb()
  const row = db.prepare('SELECT token_enc FROM accounts WHERE id = ?').get(accountId) as any
  if (!row) throw new Error(`Account ${accountId} not found`)
  return JSON.parse(decryptSystem(row.token_enc))
}
```

- [ ] **Step 4.2: Update gmail.ts** — change `encrypt` import to `encryptSystem`

In `inboxmy-backend/src/auth/gmail.ts`:
- Change line 5: `import { encrypt } from '../crypto'` → `import { encryptSystem } from '../crypto'`
- Change line 55: `encrypt(JSON.stringify(tokenData))` → `encryptSystem(JSON.stringify(tokenData))`

- [ ] **Step 4.3: Update outlook.ts** — change `encrypt` import to `encryptSystem`

In `inboxmy-backend/src/auth/outlook.ts`:
- Change line 5: `import { encrypt } from '../crypto'` → `import { encryptSystem } from '../crypto'`
- Change line 54: `encrypt(JSON.stringify(tokenData))` → `encryptSystem(JSON.stringify(tokenData))`

- [ ] **Step 4.4: Update sync-engine.ts** — change `encrypt` import to `encryptSystem` (temporary; replaced in Task 8)

In `inboxmy-backend/src/email/sync-engine.ts`:
- Change line 2: `import { encrypt } from '../crypto'` → `import { encryptSystem } from '../crypto'`
- Change all three `encrypt(...)` calls on lines 48, 52, 53 to `encryptSystem(...)`

- [ ] **Step 4.5: Update accounts.test.ts** — fix `encrypt` → `encryptSystem` import

In `inboxmy-backend/tests/routes/accounts.test.ts`:
- Change line 6: `import { encrypt } from '../../src/crypto'` → `import { encryptSystem } from '../../src/crypto'`
- Change line 13: `encrypt('{}')` → `encryptSystem('{}')`

- [ ] **Step 4.6: Run tests to confirm all pass**

```bash
cd inboxmy-backend && npm test
```

Expected: All tests pass. If TypeScript compilation fails on any missed `encrypt` call site, fix it now before proceeding.

- [ ] **Step 4.7: Commit**

```bash
git add inboxmy-backend/src/auth/token-store.ts inboxmy-backend/src/auth/gmail.ts \
  inboxmy-backend/src/auth/outlook.ts inboxmy-backend/src/email/sync-engine.ts \
  inboxmy-backend/tests/routes/accounts.test.ts
git commit -m "refactor: rename encrypt/decrypt to encryptSystem/decryptSystem in token-store and OAuth modules"
```

---

## Task 5: DB Migration 2

**Files:**
- Modify: `inboxmy-backend/src/db/migrations.ts`

- [ ] **Step 5.1: Add Migration 2 to migrations.ts**

In `inboxmy-backend/src/db/migrations.ts`, append to the `MIGRATIONS` array (after the closing backtick of Migration 1, before the `]`):

```typescript
  // Migration 2: multi-user auth
  `
  CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    email         TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    pbkdf2_salt   TEXT NOT NULL,
    data_key_enc  TEXT NOT NULL,
    recovery_enc  TEXT NOT NULL,
    created_at    INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key_enc    TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
  CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    used       INTEGER NOT NULL DEFAULT 0
  );
  ALTER TABLE accounts ADD COLUMN user_id TEXT REFERENCES users(id) ON DELETE CASCADE;
  CREATE INDEX IF NOT EXISTS idx_accounts_user ON accounts(user_id);
  `,
```

- [ ] **Step 5.2: Run tests to confirm migration runs cleanly**

```bash
cd inboxmy-backend && npm test
```

Expected: All tests pass. The migration runs on the test DB automatically via `getDb()`.

- [ ] **Step 5.3: Commit**

```bash
git add inboxmy-backend/src/db/migrations.ts
git commit -m "feat: add migration 2 — users, sessions, password_reset_tokens, user_id on accounts"
```

---

## Task 6: Create test helper for auth

All `/api/*` route tests will need an authenticated session after Task 7. Create the helper now so it's ready.

**Files:**
- Create: `inboxmy-backend/tests/helpers/auth.ts`

- [ ] **Step 6.1: Create the test auth helper**

Create `inboxmy-backend/tests/helpers/auth.ts`:

```typescript
// tests/helpers/auth.ts
// Creates a user and returns a supertest agent with a valid session cookie.
import request from 'supertest'
import { app } from '../../src/server'
import { randomUUID } from 'crypto'

export interface TestUser {
  id: string
  email: string
  password: string
  agent: ReturnType<typeof request.agent>
}

export async function createTestUser(
  email?: string,
  password = 'TestPass123!'
): Promise<TestUser> {
  const userEmail = email ?? `test-${randomUUID()}@example.com`
  const agent = request.agent(app)

  const res = await agent
    .post('/auth/signup')
    .send({ email: userEmail, password })

  if (res.status !== 200) {
    throw new Error(`createTestUser failed: ${res.status} ${JSON.stringify(res.body)}`)
  }

  return { id: res.body.user.id, email: userEmail, password, agent }
}
```

- [ ] **Step 6.2: No test needed for this helper** — it will be tested implicitly by auth route tests in Task 7.

- [ ] **Step 6.3: Commit**

```bash
git add inboxmy-backend/tests/helpers/auth.ts
git commit -m "test: add createTestUser helper for auth-required route tests"
```

---

## Task 7: Auth routes — signup, login, logout, me

**Files:**
- Create: `inboxmy-backend/src/routes/auth.ts`
- Create: `inboxmy-backend/tests/routes/auth.test.ts`
- Modify: `inboxmy-backend/src/server.ts`

- [ ] **Step 7.1: Write failing tests**

Create `inboxmy-backend/tests/routes/auth.test.ts`:

```typescript
// tests/routes/auth.test.ts
import { describe, it, expect, afterAll } from 'vitest'
import request from 'supertest'
import { app } from '../../src/server'
import { closeDb, getDb } from '../../src/db'
import { randomUUID } from 'crypto'

afterAll(() => closeDb())

function email() { return `auth-${randomUUID()}@example.com` }

describe('POST /auth/signup', () => {
  it('creates a user and returns a session cookie', async () => {
    const res = await request(app)
      .post('/auth/signup')
      .send({ email: email(), password: 'Password123!' })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.user.email).toBeDefined()
    expect(res.body.user.id).toBeDefined()
    const cookie = res.headers['set-cookie']
    expect(cookie).toBeDefined()
    expect(Array.isArray(cookie) ? cookie[0] : cookie).toContain('HttpOnly')
  })

  it('returns 409 for duplicate email', async () => {
    const e = email()
    await request(app).post('/auth/signup').send({ email: e, password: 'Password123!' })
    const res = await request(app).post('/auth/signup').send({ email: e, password: 'Password123!' })
    expect(res.status).toBe(409)
  })

  it('returns 400 for password under 8 chars', async () => {
    const res = await request(app)
      .post('/auth/signup')
      .send({ email: email(), password: 'short' })
    expect(res.status).toBe(400)
  })

  it('returns 400 for missing email', async () => {
    const res = await request(app).post('/auth/signup').send({ password: 'Password123!' })
    expect(res.status).toBe(400)
  })
})

describe('POST /auth/login', () => {
  it('returns a session cookie on correct credentials', async () => {
    const e = email()
    await request(app).post('/auth/signup').send({ email: e, password: 'Password123!' })
    const res = await request(app).post('/auth/login').send({ email: e, password: 'Password123!' })
    expect(res.status).toBe(200)
    expect(res.body.user.email).toBe(e)
    expect(res.headers['set-cookie']).toBeDefined()
  })

  it('returns 401 for wrong password', async () => {
    const e = email()
    await request(app).post('/auth/signup').send({ email: e, password: 'Password123!' })
    const res = await request(app).post('/auth/login').send({ email: e, password: 'WrongPass!' })
    expect(res.status).toBe(401)
    expect(res.body.error).toBe('Invalid email or password')
  })

  it('returns 401 for unknown email', async () => {
    const res = await request(app)
      .post('/auth/login')
      .send({ email: 'nobody@example.com', password: 'Password123!' })
    expect(res.status).toBe(401)
  })
})

describe('GET /auth/me', () => {
  it('returns the user when authenticated', async () => {
    const agent = request.agent(app)
    const e = email()
    await agent.post('/auth/signup').send({ email: e, password: 'Password123!' })
    const res = await agent.get('/auth/me')
    expect(res.status).toBe(200)
    expect(res.body.user.email).toBe(e)
  })

  it('returns 401 without a session', async () => {
    const res = await request(app).get('/auth/me')
    expect(res.status).toBe(401)
  })
})

describe('POST /auth/logout', () => {
  it('clears the session and subsequent /auth/me returns 401', async () => {
    const agent = request.agent(app)
    await agent.post('/auth/signup').send({ email: email(), password: 'Password123!' })
    await agent.post('/auth/logout')
    const res = await agent.get('/auth/me')
    expect(res.status).toBe(401)
  })
})
```

- [ ] **Step 7.2: Run tests to confirm they fail**

```bash
cd inboxmy-backend && npm test -- --reporter=verbose tests/routes/auth.test.ts
```

Expected: All fail — `/auth/signup` returns 404

- [ ] **Step 7.3: Create src/routes/auth.ts**

Create `inboxmy-backend/src/routes/auth.ts`:

```typescript
// src/routes/auth.ts
import { Router } from 'express'
import { randomBytes, createHash } from 'crypto'
import { randomUUID } from 'crypto'
import bcrypt from 'bcryptjs'
import { getDb } from '../db'
import { config } from '../config'
import {
  deriveWrapKey, wrapKey, unwrapKey,
} from '../crypto'
import { requireAuth } from '../middleware/auth'

export const authRouter = Router()

const SESSION_COOKIE_OPTS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax' as const,
  path: '/',
}

function validatePassword(password: string): string | null {
  if (typeof password !== 'string') return 'Password is required'
  if (password.length < 8) return 'Password must be at least 8 characters'
  if (Buffer.byteLength(password, 'utf8') > 72) return 'Password must be 72 bytes or fewer'
  return null
}

// POST /auth/signup
authRouter.post('/signup', async (req, res) => {
  const { email, password } = req.body
  if (!email || typeof email !== 'string') {
    return res.status(400).json({ error: 'Email is required' })
  }
  const pwErr = validatePassword(password)
  if (pwErr) return res.status(400).json({ error: pwErr })

  const db = getDb()
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase())
  if (existing) return res.status(409).json({ error: 'Email already registered' })

  const userId = randomUUID()
  const passwordHash = await bcrypt.hash(password, 12)
  const pbkdf2Salt = randomBytes(32)
  const dataKey = randomBytes(32)
  const wrapKeyBuf = deriveWrapKey(password, pbkdf2Salt)
  const dataKeyEnc = wrapKey(dataKey, wrapKeyBuf)
  const recoveryKeyBuf = Buffer.from(config.recoverySecret, 'hex')
  const recoveryEnc = wrapKey(dataKey, recoveryKeyBuf)

  db.prepare(`
    INSERT INTO users (id, email, password_hash, pbkdf2_salt, data_key_enc, recovery_enc, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(userId, email.toLowerCase(), passwordHash, pbkdf2Salt.toString('base64'), dataKeyEnc, recoveryEnc, Date.now())

  // Create session
  const sessionId = randomBytes(32).toString('hex')
  const sessionSecretBuf = Buffer.from(config.sessionSecret, 'hex')
  const keyEnc = wrapKey(dataKey, sessionSecretBuf)
  db.prepare('INSERT INTO sessions (id, user_id, key_enc, created_at) VALUES (?, ?, ?, ?)')
    .run(sessionId, userId, keyEnc, Date.now())

  res.cookie('session', sessionId, SESSION_COOKIE_OPTS)
  res.json({ ok: true, user: { id: userId, email: email.toLowerCase() } })
})

// POST /auth/login
authRouter.post('/login', async (req, res) => {
  const { email, password } = req.body
  if (!email || !password) {
    return res.status(401).json({ error: 'Invalid email or password' })
  }

  const db = getDb()
  const user = db.prepare(
    'SELECT id, email, password_hash, pbkdf2_salt, data_key_enc FROM users WHERE email = ?'
  ).get((email as string).toLowerCase()) as any

  if (!user) return res.status(401).json({ error: 'Invalid email or password' })

  const match = await bcrypt.compare(password, user.password_hash)
  if (!match) return res.status(401).json({ error: 'Invalid email or password' })

  const pbkdf2Salt = Buffer.from(user.pbkdf2_salt, 'base64')
  const wrapKeyBuf = deriveWrapKey(password, pbkdf2Salt)
  const dataKey = unwrapKey(user.data_key_enc, wrapKeyBuf)

  const sessionId = randomBytes(32).toString('hex')
  const sessionSecretBuf = Buffer.from(config.sessionSecret, 'hex')
  const keyEnc = wrapKey(dataKey, sessionSecretBuf)
  db.prepare('INSERT INTO sessions (id, user_id, key_enc, created_at) VALUES (?, ?, ?, ?)')
    .run(sessionId, user.id, keyEnc, Date.now())

  res.cookie('session', sessionId, SESSION_COOKIE_OPTS)
  res.json({ ok: true, user: { id: user.id, email: user.email } })
})

// POST /auth/logout
authRouter.post('/logout', requireAuth, (req, res) => {
  const sessionId = req.cookies?.session
  if (sessionId) {
    getDb().prepare('DELETE FROM sessions WHERE id = ?').run(sessionId)
  }
  res.clearCookie('session', { path: '/' })
  res.json({ ok: true })
})

// GET /auth/me
authRouter.get('/me', requireAuth, (req, res) => {
  res.json({ user: { id: (req as any).user.id, email: (req as any).user.email } })
})
```

- [ ] **Step 7.4: Create src/middleware/auth.ts**

Create `inboxmy-backend/src/middleware/auth.ts`:

```typescript
// src/middleware/auth.ts
import type { Request, Response, NextFunction } from 'express'
import { getDb } from '../db'
import { config } from '../config'
import { unwrapKey } from '../crypto'

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 days absolute TTL — exported so server.ts OAuth callbacks use the same value

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const sessionId = (req as any).cookies?.session
  if (!sessionId) return res.status(401).json({ error: 'Not authenticated' })

  const db = getDb()
  const row = db.prepare(`
    SELECT s.user_id, s.key_enc, s.created_at, u.email
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.id = ?
  `).get(sessionId) as any

  if (!row) return res.status(401).json({ error: 'Session not found' })

  if (Date.now() - row.created_at > SESSION_TTL_MS) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId)
    return res.status(401).json({ error: 'Session expired' })
  }

  const sessionSecretBuf = Buffer.from(config.sessionSecret, 'hex')
  const dataKey = unwrapKey(row.key_enc, sessionSecretBuf)
  ;(req as any).user = { id: row.user_id, email: row.email, dataKey }
  next()
}
```

- [ ] **Step 7.5: Mount authRouter and cookie-parser in server.ts**

In `inboxmy-backend/src/server.ts`, make these changes:

1. Add imports near the top (after existing imports):
```typescript
import cookieParser from 'cookie-parser'
import { authRouter } from './routes/auth'
import { requireAuth, SESSION_TTL_MS } from './middleware/auth'
```

2. Add `app.use(cookieParser())` immediately after `app.use(express.json())`.

3. Add auth rate limiter after the existing `/api` rate limiter:
```typescript
// Stricter rate limit on auth routes
app.use(['/auth/login', '/auth/signup', '/auth/forgot-password'], rateLimit({
  windowMs: 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
}))
```

4. Mount authRouter before the API routes block:
```typescript
app.use('/auth', authRouter)
```

5. Apply `requireAuth` to all API routes:
```typescript
app.use('/api', requireAuth)
```

Add line 5 directly before `app.use('/api/accounts', accountsRouter)`.

- [ ] **Step 7.6: Run auth tests**

```bash
cd inboxmy-backend && npm test -- --reporter=verbose tests/routes/auth.test.ts
```

Expected: All 9 auth tests pass

- [ ] **Step 7.7: Run full test suite**

```bash
cd inboxmy-backend && npm test
```

Expected: Accounts tests will now fail with 401 — that's expected. Crypto, config, parser, setup tests should still pass.

- [ ] **Step 7.8: Commit**

```bash
git add inboxmy-backend/src/routes/auth.ts inboxmy-backend/src/middleware/auth.ts \
  inboxmy-backend/src/server.ts inboxmy-backend/tests/routes/auth.test.ts
git commit -m "feat: add auth routes (signup, login, logout, me) and requireAuth middleware"
```

---

## Task 8: Fix existing route tests to use auth

**Files:**
- Modify: `inboxmy-backend/tests/routes/accounts.test.ts`

The accounts tests hit `/api/*` which now requires auth. Update them to use the `createTestUser` helper.

- [ ] **Step 8.1: Update accounts.test.ts**

Replace `inboxmy-backend/tests/routes/accounts.test.ts` entirely:

```typescript
// tests/routes/accounts.test.ts
import { describe, it, expect, afterAll } from 'vitest'
import { closeDb, getDb } from '../../src/db'
import { encryptSystem } from '../../src/crypto'
import { randomUUID } from 'crypto'
import { createTestUser } from '../helpers/auth'

afterAll(() => closeDb())

function seedAccount(userId: string, id: string, email: string) {
  getDb().prepare(`
    INSERT OR IGNORE INTO accounts (id, provider, email, token_enc, created_at, user_id)
    VALUES (?, 'gmail', ?, ?, ?, ?)
  `).run(id, email, encryptSystem('{}'), Date.now(), userId)
}

describe('GET /api/accounts', () => {
  it('returns list for authenticated user', async () => {
    const { agent } = await createTestUser()
    const res = await agent.get('/api/accounts')
    expect(res.status).toBe(200)
    expect(res.body.accounts).toBeInstanceOf(Array)
  })

  it('returns 401 without session', async () => {
    const { default: request } = await import('supertest')
    const { app } = await import('../../src/server')
    const res = await request(app).get('/api/accounts')
    expect(res.status).toBe(401)
  })
})

describe('PATCH /api/accounts/:id/label', () => {
  it('updates the label', async () => {
    const { agent, id: userId } = await createTestUser()
    const id = randomUUID()
    seedAccount(userId, id, `label-test-${id}@test.com`)
    const res = await agent.patch(`/api/accounts/${id}/label`).send({ label: 'Work Gmail' })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    const row = getDb().prepare('SELECT label FROM accounts WHERE id = ?').get(id) as any
    expect(row.label).toBe('Work Gmail')
  })

  it('returns 400 for non-string label', async () => {
    const { agent } = await createTestUser()
    const res = await agent.patch('/api/accounts/any-id/label').send({ label: 123 })
    expect(res.status).toBe(400)
  })
})

describe('DELETE /api/accounts/:id', () => {
  it('deletes an existing account', async () => {
    const { agent, id: userId } = await createTestUser()
    const id = randomUUID()
    seedAccount(userId, id, `delete-test-${id}@test.com`)
    const res = await agent.delete(`/api/accounts/${id}`)
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    const row = getDb().prepare('SELECT id FROM accounts WHERE id = ?').get(id)
    expect(row).toBeUndefined()
  })

  it('returns 404 for non-existent account', async () => {
    const { agent } = await createTestUser()
    const res = await agent.delete('/api/accounts/does-not-exist')
    expect(res.status).toBe(404)
  })
})
```

- [ ] **Step 8.2: Run tests**

```bash
cd inboxmy-backend && npm test -- --reporter=verbose tests/routes/accounts.test.ts
```

Expected: All accounts tests pass

- [ ] **Step 8.3: Commit**

```bash
git add inboxmy-backend/tests/routes/accounts.test.ts
git commit -m "test: update accounts tests to use auth helper after requireAuth wiring"
```

---

## Task 9: Per-user data isolation in existing routes

Update all `/api/*` route handlers so each user only sees their own data. Also update the sync engine to receive the data key per-user.

**Files:**
- Modify: `inboxmy-backend/src/routes/accounts.ts`
- Modify: `inboxmy-backend/src/routes/emails.ts`
- Modify: `inboxmy-backend/src/routes/bills.ts`
- Modify: `inboxmy-backend/src/routes/sync.ts`
- Modify: `inboxmy-backend/src/email/sync-engine.ts`
- Modify: `inboxmy-backend/src/auth/gmail.ts`
- Modify: `inboxmy-backend/src/auth/outlook.ts`
- Modify: `inboxmy-backend/src/server.ts`

- [ ] **Step 9.1: Update accounts.ts**

Replace `inboxmy-backend/src/routes/accounts.ts` entirely:

```typescript
// src/routes/accounts.ts
import { Router } from 'express'
import { getDb } from '../db'
import { getAuthUrl as getGmailUrl } from '../auth/gmail'
import { getAuthUrl as getOutlookUrl } from '../auth/outlook'

export const accountsRouter = Router()

accountsRouter.get('/', (req, res) => {
  const db = getDb()
  const user = (req as any).user
  const accounts = db.prepare(
    'SELECT id, provider, email, label, created_at, last_synced FROM accounts WHERE user_id = ?'
  ).all(user.id)
  res.json({ accounts })
})

// Embed sessionId as OAuth state so the callback can resolve the user
accountsRouter.get('/connect/gmail', (req, res) => {
  const sessionId = (req as any).cookies?.session
  const url = getGmailUrl(sessionId)
  res.redirect(url)
})

accountsRouter.get('/connect/outlook', async (req, res) => {
  const sessionId = (req as any).cookies?.session
  const url = await getOutlookUrl(sessionId)
  res.redirect(url)
})

accountsRouter.delete('/:id', (req, res) => {
  const db = getDb()
  const user = (req as any).user
  // Only delete if account belongs to this user
  const result = db.prepare(
    'DELETE FROM accounts WHERE id = ? AND user_id = ?'
  ).run(req.params.id, user.id)
  if (result.changes === 0) return res.status(404).json({ error: 'Account not found' })
  res.json({ ok: true })
})

accountsRouter.patch('/:id/label', (req, res) => {
  const { label } = req.body
  if (typeof label !== 'string') return res.status(400).json({ error: 'label must be string' })
  const db = getDb()
  const user = (req as any).user
  db.prepare('UPDATE accounts SET label = ? WHERE id = ? AND user_id = ?')
    .run(label, req.params.id, user.id)
  res.json({ ok: true })
})
```

- [ ] **Step 9.2: Update emails.ts**

Replace `inboxmy-backend/src/routes/emails.ts` entirely:

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
  const user = (req as any).user
  const db = getDb()

  let query = `SELECT e.id, e.account_id, e.thread_id, e.subject_enc,
    e.sender, e.sender_name, e.received_at, e.is_read, e.category,
    e.snippet, e.raw_size
    FROM emails e
    JOIN accounts a ON a.id = e.account_id
    WHERE a.user_id = ?`
  const params: any[] = [user.id]

  if (category) { query += ' AND e.category = ?'; params.push(category) }
  if (accountId) { query += ' AND e.account_id = ?'; params.push(accountId) }
  if (search) { query += ' AND e.sender LIKE ?'; params.push(`%${search}%`) }

  query += ' ORDER BY e.received_at DESC LIMIT ? OFFSET ?'
  params.push(limit, offset)

  const rows = db.prepare(query).all(...params) as any[]
  try {
    const emails = rows.map(r => ({
      ...r,
      subject: decrypt(r.subject_enc, user.dataKey),
      snippet: r.snippet ? decrypt(r.snippet, user.dataKey) : null,
      subject_enc: undefined,
    }))
    res.json({ emails, limit, offset })
  } catch {
    res.status(500).json({ error: 'Failed to decrypt email data' })
  }
})

emailsRouter.get('/:id', (req: Request, res: Response) => {
  const user = (req as any).user
  const db = getDb()
  const row = db.prepare(`
    SELECT e.*, pb.biller, pb.amount_rm, pb.due_date, pb.account_ref, pb.status
    FROM emails e
    JOIN accounts a ON a.id = e.account_id
    LEFT JOIN parsed_bills pb ON pb.email_id = e.id
    WHERE e.id = ? AND a.user_id = ?
  `).get(req.params.id, user.id) as any

  if (!row) return res.status(404).json({ error: 'Email not found' })

  try {
    res.json({
      ...row,
      subject: decrypt(row.subject_enc, user.dataKey),
      body: row.body_enc ? decrypt(row.body_enc, user.dataKey) : null,
      snippet: row.snippet ? decrypt(row.snippet, user.dataKey) : null,
      subject_enc: undefined,
      body_enc: undefined,
    })
  } catch {
    res.status(500).json({ error: 'Failed to decrypt email data' })
  }
})

emailsRouter.patch('/:id/read', (req: Request, res: Response) => {
  const user = (req as any).user
  const db = getDb()
  // Only update if email belongs to this user
  db.prepare(`
    UPDATE emails SET is_read = 1
    WHERE id = ? AND account_id IN (SELECT id FROM accounts WHERE user_id = ?)
  `).run(req.params.id, user.id)
  res.json({ ok: true })
})
```

- [ ] **Step 9.3: Update bills.ts**

Replace `inboxmy-backend/src/routes/bills.ts` entirely:

```typescript
// src/routes/bills.ts
import { Router } from 'express'
import { getDb } from '../db'
import { decrypt } from '../crypto'

export const billsRouter = Router()

billsRouter.get('/', (req, res) => {
  const user = (req as any).user
  const db = getDb()
  const { status } = req.query

  let query = `
    SELECT pb.id, pb.biller, pb.amount_rm, pb.due_date, pb.account_ref, pb.status,
      e.subject_enc, e.received_at, e.account_id
    FROM parsed_bills pb
    JOIN emails e ON e.id = pb.email_id
    JOIN accounts a ON a.id = e.account_id
    WHERE a.user_id = ?
  `
  const VALID_STATUSES = ['unpaid', 'paid', 'overdue']
  const params: any[] = [user.id]
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
      subject: decrypt(r.subject_enc, user.dataKey),
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
  const user = (req as any).user
  const db = getDb()
  // Verify bill belongs to this user via joins
  const existing = db.prepare(`
    SELECT pb.id FROM parsed_bills pb
    JOIN emails e ON e.id = pb.email_id
    JOIN accounts a ON a.id = e.account_id
    WHERE pb.id = ? AND a.user_id = ?
  `).get(req.params.id, user.id)
  if (!existing) return res.status(404).json({ error: 'Bill not found' })
  db.prepare('UPDATE parsed_bills SET status = ? WHERE id = ?').run(status, req.params.id)
  res.json({ ok: true })
})
```

- [ ] **Step 9.4: Update sync.ts**

Replace `inboxmy-backend/src/routes/sync.ts` entirely:

```typescript
// src/routes/sync.ts
import { Router } from 'express'
import { getDb } from '../db'
import { syncAccount, syncAllAccounts } from '../email/sync-engine'

export const syncRouter = Router()

syncRouter.post('/trigger', async (req, res) => {
  const { accountId } = req.body
  const user = (req as any).user

  if (accountId) {
    // Verify the account belongs to this user
    const account = getDb().prepare(
      'SELECT id FROM accounts WHERE id = ? AND user_id = ?'
    ).get(accountId, user.id)
    if (!account) return res.status(404).json({ error: 'Account not found' })
  }

  const target = accountId ? `account ${accountId}` : 'all accounts'
  console.log(`[sync] Manual trigger — ${target}`)
  try {
    if (accountId) {
      const result = await syncAccount(accountId, user.dataKey)
      console.log(`[sync] Done — added ${result.added} emails${result.errors.length ? ', errors: ' + result.errors.join(', ') : ''}`)
      res.json(result)
    } else {
      await syncAllAccounts(user.id, user.dataKey)
      console.log('[sync] Done — all accounts')
      res.json({ ok: true })
    }
  } catch (err: any) {
    console.error('[sync] Failed:', err.message)
    res.status(500).json({ error: err.message })
  }
})
```

- [ ] **Step 9.5: Update sync-engine.ts**

Replace `inboxmy-backend/src/email/sync-engine.ts` entirely:

```typescript
// src/email/sync-engine.ts
import { getDb } from '../db'
import { encrypt } from '../crypto'
import { fetchNewEmails as fetchGmail } from './gmail-client'
import { fetchNewEmails as fetchOutlook } from './outlook-client'
import { parseEmail } from '../parsers'
import { randomUUID } from 'crypto'
import type { NormalizedEmail } from './types'

export async function syncAccount(
  accountId: string,
  dataKey: Buffer
): Promise<{ added: number; errors: string[] }> {
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
    console.log(`[sync] Fetching emails for ${account.email} (${account.provider})…`)
    const emails: NormalizedEmail[] = account.provider === 'gmail'
      ? await fetchGmail(accountId, sinceMs)
      : await fetchOutlook(accountId, sinceMs)
    console.log(`[sync] Fetched ${emails.length} emails, processing…`)

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
          encrypt(email.subject, dataKey),
          email.sender, email.senderName ?? null,
          email.receivedAt, email.isRead ? 1 : 0,
          parsed.category ?? null,
          body ? encrypt(body, dataKey) : null,
          email.snippet ? encrypt(email.snippet, dataKey) : null,
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

export async function syncAllAccounts(userId: string, dataKey: Buffer): Promise<void> {
  const db = getDb()
  const accounts = db.prepare('SELECT id FROM accounts WHERE user_id = ?').all(userId) as any[]
  for (const acc of accounts) {
    await syncAccount(acc.id, dataKey)
  }
}
```

- [ ] **Step 9.6: Update scheduler.ts** — scheduler no longer calls syncAllAccounts directly (it can't without a dataKey). Disable the scheduler's direct sync for now; it will be re-enabled in a future plan with a system-level re-auth pattern.

Replace `inboxmy-backend/src/scheduler.ts` entirely:

```typescript
// src/scheduler.ts
// NOTE: Per-user sync requires a user's dataKey which is only available during
// an authenticated request. Background sync is disabled in Plan 4 pending a
// service-account re-auth pattern in a future plan.
export function startScheduler(): void {
  console.log('[scheduler] Background sync disabled (Plan 4 — requires per-user dataKey)')
}
```

- [ ] **Step 9.7: Update gmail.ts handleCallback to accept userId**

Replace **only the `handleCallback` function** in `inboxmy-backend/src/auth/gmail.ts`. Do NOT touch the import lines — the `import { encryptSystem }` line placed in Step 4.2 must remain. The function signature changes from `handleCallback(code: string)` to `handleCallback(code: string, userId: string)` and the INSERT gains a `user_id` column:

```typescript
export async function handleCallback(code: string, userId: string): Promise<string> {
  const client = getOAuthClient()
  const { tokens } = await client.getToken(code)

  client.setCredentials(tokens)
  const oauth2 = google.oauth2({ version: 'v2', auth: client })
  const { data } = await oauth2.userinfo.get()
  const email = data.email!

  const db = getDb()
  const existing = db.prepare(
    'SELECT id FROM accounts WHERE email = ? AND user_id = ?'
  ).get(email, userId) as any
  const accountId = existing?.id ?? randomUUID()

  const tokenData = {
    accessToken: tokens.access_token!,
    refreshToken: tokens.refresh_token ?? '',
    expiryMs: tokens.expiry_date ?? Date.now() + 3600_000,
  }

  db.prepare(`
    INSERT INTO accounts (id, provider, email, token_enc, created_at, user_id)
    VALUES (?, 'gmail', ?, ?, ?, ?)
    ON CONFLICT(email) DO UPDATE SET token_enc = excluded.token_enc, user_id = excluded.user_id
  `).run(accountId, email, encryptSystem(JSON.stringify(tokenData)), Date.now(), userId)

  return accountId
}
```

- [ ] **Step 9.8: Update outlook.ts handleCallback to accept userId**

Replace **only the `handleCallback` function** in `inboxmy-backend/src/auth/outlook.ts`. Do NOT touch the import lines — the `import { encryptSystem }` line from Step 4.3 must remain:

```typescript
export async function handleCallback(code: string, userId: string): Promise<string> {
  const app = getMsalApp()
  const result = await app.acquireTokenByCode({
    code,
    scopes: SCOPES,
    redirectUri: config.microsoft.redirectUri,
  })

  const email = result.account?.username!
  const db = getDb()
  const existing = db.prepare(
    'SELECT id FROM accounts WHERE email = ? AND user_id = ?'
  ).get(email, userId) as any
  const accountId = existing?.id ?? randomUUID()

  const tokenData = {
    accessToken: result.accessToken,
    refreshToken: '',
    expiryMs: result.expiresOn?.getTime() ?? Date.now() + 3600_000,
  }

  db.prepare(`
    INSERT INTO accounts (id, provider, email, token_enc, created_at, user_id)
    VALUES (?, 'outlook', ?, ?, ?, ?)
    ON CONFLICT(email) DO UPDATE SET token_enc = excluded.token_enc, user_id = excluded.user_id
  `).run(accountId, email, encryptSystem(JSON.stringify(tokenData)), Date.now(), userId)

  return accountId
}
```

- [ ] **Step 9.9: Update OAuth callbacks in server.ts to use state relay**

In `inboxmy-backend/src/server.ts`, replace both OAuth callback handlers:

```typescript
// OAuth callbacks (called by Google/Microsoft redirect)
app.get('/auth/gmail/callback', async (req, res) => {
  const { code, error, state } = req.query
  if (error || !code) return res.status(400).send(`OAuth error: ${error}`)
  if (!state) return res.status(400).send('OAuth error: missing state')

  const db = getDb()
  // SESSION_TTL_MS imported from middleware/auth — single source of truth
  const session = db.prepare(
    'SELECT user_id, created_at FROM sessions WHERE id = ?'
  ).get(state as string) as any
  if (!session || Date.now() - session.created_at > SESSION_TTL_MS) {
    return res.status(400).send('Invalid or expired session. Please reconnect from the dashboard.')
  }

  try {
    const accountId = await gmailCallback(code as string, session.user_id)
    res.send(`<script>window.close()</script><p>Gmail connected! Account: ${accountId}</p>`)
  } catch (err: any) {
    res.status(500).send(err.message)
  }
})

app.get('/auth/outlook/callback', async (req, res) => {
  const { code, error, state } = req.query
  if (error || !code) return res.status(400).send(`OAuth error: ${error}`)
  if (!state) return res.status(400).send('OAuth error: missing state')

  const db = getDb()
  // SESSION_TTL_MS imported from middleware/auth — single source of truth
  const session = db.prepare(
    'SELECT user_id, created_at FROM sessions WHERE id = ?'
  ).get(state as string) as any
  if (!session || Date.now() - session.created_at > SESSION_TTL_MS) {
    return res.status(400).send('Invalid or expired session. Please reconnect from the dashboard.')
  }

  try {
    const accountId = await outlookCallback(code as string, session.user_id)
    res.send(`<script>window.close()</script><p>Outlook connected! Account: ${accountId}</p>`)
  } catch (err: any) {
    res.status(500).send(err.message)
  }
})
```

Also add orphaned account cleanup in the `if (require.main === module)` block, right after `getDb()`:

```typescript
// Clean up any accounts without a user_id (dev data from pre-Plan-4 runs)
getDb().prepare('DELETE FROM accounts WHERE user_id IS NULL').run()
```

- [ ] **Step 9.10: Run all tests**

```bash
cd inboxmy-backend && npm test
```

Expected: All tests pass. If any compilation errors remain from missed `encrypt` calls, fix them now.

- [ ] **Step 9.11: Commit**

```bash
git add inboxmy-backend/src/routes/accounts.ts inboxmy-backend/src/routes/emails.ts \
  inboxmy-backend/src/routes/bills.ts inboxmy-backend/src/routes/sync.ts \
  inboxmy-backend/src/email/sync-engine.ts inboxmy-backend/src/auth/gmail.ts \
  inboxmy-backend/src/auth/outlook.ts inboxmy-backend/src/server.ts \
  inboxmy-backend/src/scheduler.ts
git commit -m "feat: per-user data isolation — filter all routes by user_id, pass dataKey to encrypt/decrypt"
```

---

## Task 10: Password reset routes

**Files:**
- Modify: `inboxmy-backend/src/routes/auth.ts`
- Create: `inboxmy-backend/tests/routes/auth-reset.test.ts`

- [ ] **Step 10.1: Write failing tests**

Create `inboxmy-backend/tests/routes/auth-reset.test.ts`:

```typescript
// tests/routes/auth-reset.test.ts
import { describe, it, expect, afterAll, vi } from 'vitest'
import request from 'supertest'
import { app } from '../../src/server'
import { closeDb, getDb } from '../../src/db'
import { createHash, randomBytes } from 'crypto'
import { randomUUID } from 'crypto'

afterAll(() => closeDb())

function email() { return `reset-${randomUUID()}@example.com` }

describe('POST /auth/forgot-password', () => {
  it('always returns 200 (prevents email enumeration)', async () => {
    const res = await request(app)
      .post('/auth/forgot-password')
      .send({ email: 'nobody@example.com' })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
  })

  it('creates a reset token for existing user', async () => {
    const e = email()
    await request(app).post('/auth/signup').send({ email: e, password: 'Password123!' })
    await request(app).post('/auth/forgot-password').send({ email: e })
    const user = getDb().prepare('SELECT id FROM users WHERE email = ?').get(e) as any
    const token = getDb().prepare(
      'SELECT id FROM password_reset_tokens WHERE user_id = ? AND used = 0'
    ).get(user.id)
    expect(token).toBeDefined()
  })
})

describe('POST /auth/reset-password', () => {
  async function setupReset() {
    const e = email()
    await request(app).post('/auth/signup').send({ email: e, password: 'OldPass123!' })
    const user = getDb().prepare('SELECT id FROM users WHERE email = ?').get(e) as any

    const rawToken = randomBytes(32).toString('hex')
    const tokenHash = createHash('sha256').update(rawToken).digest('hex')
    getDb().prepare(
      'INSERT INTO password_reset_tokens (id, user_id, token_hash, expires_at, used) VALUES (?, ?, ?, ?, 0)'
    ).run(randomUUID(), user.id, tokenHash, Date.now() + 3600_000)

    return { email: e, userId: user.id, rawToken }
  }

  it('resets password and allows login with new password', async () => {
    const { email: e, rawToken } = await setupReset()
    const res = await request(app)
      .post('/auth/reset-password')
      .send({ token: rawToken, newPassword: 'NewPass456!' })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)

    const loginRes = await request(app)
      .post('/auth/login')
      .send({ email: e, password: 'NewPass456!' })
    expect(loginRes.status).toBe(200)
  })

  it('rejects old password after reset', async () => {
    const { email: e, rawToken } = await setupReset()
    await request(app).post('/auth/reset-password').send({ token: rawToken, newPassword: 'NewPass456!' })
    const loginRes = await request(app).post('/auth/login').send({ email: e, password: 'OldPass123!' })
    expect(loginRes.status).toBe(401)
  })

  it('returns 400 for expired token', async () => {
    const { rawToken, userId } = await setupReset()
    // Manually expire the token
    const tokenHash = createHash('sha256').update(rawToken).digest('hex')
    getDb().prepare('UPDATE password_reset_tokens SET expires_at = ? WHERE token_hash = ?')
      .run(Date.now() - 1000, tokenHash)
    const res = await request(app)
      .post('/auth/reset-password')
      .send({ token: rawToken, newPassword: 'NewPass456!' })
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('expired')
  })

  it('returns 400 for already-used token', async () => {
    const { rawToken } = await setupReset()
    await request(app).post('/auth/reset-password').send({ token: rawToken, newPassword: 'NewPass456!' })
    const res = await request(app)
      .post('/auth/reset-password')
      .send({ token: rawToken, newPassword: 'AnotherPass789!' })
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('used')
  })
})
```

- [ ] **Step 10.2: Run tests to confirm failure**

```bash
cd inboxmy-backend && npm test -- --reporter=verbose tests/routes/auth-reset.test.ts
```

Expected: Tests fail — forgot-password and reset-password routes return 404

- [ ] **Step 10.3: Add password reset routes to src/routes/auth.ts**

Add these imports at the top of `inboxmy-backend/src/routes/auth.ts`:

```typescript
import { createHash } from 'crypto'
import bcrypt from 'bcryptjs'  // already imported
import nodemailer from 'nodemailer'
```

Then append these two route handlers at the bottom of the file:

```typescript
// POST /auth/forgot-password
authRouter.post('/forgot-password', async (req, res) => {
  const { email } = req.body
  // Always return 200 FIRST — prevents email enumeration and avoids ERR_HTTP_HEADERS_SENT
  // if any post-response side effect throws (DB insert, SMTP send).
  res.json({ ok: true })

  if (!email || typeof email !== 'string') return

  // All side effects wrapped in try/catch — errors log to console, never propagate
  try {
    const db = getDb()
    const user = db.prepare('SELECT id FROM users WHERE email = ?')
      .get((email as string).toLowerCase()) as any
    if (!user) return

    const rawToken = randomBytes(32).toString('hex')
    const tokenHash = createHash('sha256').update(rawToken).digest('hex')
    db.prepare(
      'INSERT INTO password_reset_tokens (id, user_id, token_hash, expires_at, used) VALUES (?, ?, ?, ?, 0)'
    ).run(randomUUID(), user.id, tokenHash, Date.now() + 3600_000)

    const resetLink = `${config.appUrl}/reset-password?token=${rawToken}`

    if (config.smtp.host) {
      const transporter = nodemailer.createTransport({
        host: config.smtp.host,
        port: config.smtp.port,
        auth: { user: config.smtp.user, pass: config.smtp.pass },
      })
      await transporter.sendMail({
        from: `InboxMY <noreply@${config.smtp.host}>`,
        to: email,
        subject: 'Reset your InboxMY password',
        text: `Click this link to reset your password (expires in 1 hour):\n\n${resetLink}`,
      })
    } else {
      console.log('[InboxMY] Password reset link:', resetLink)
    }
  } catch (err: any) {
    console.error('[auth] forgot-password side effect error:', err.message)
  }
})

// POST /auth/reset-password
authRouter.post('/reset-password', async (req, res) => {
  const { token, newPassword } = req.body
  if (!token || !newPassword) {
    return res.status(400).json({ error: 'token and newPassword are required' })
  }
  const pwErr = validatePassword(newPassword)
  if (pwErr) return res.status(400).json({ error: pwErr })

  const tokenHash = createHash('sha256').update(token as string).digest('hex')
  const db = getDb()
  const tokenRow = db.prepare(
    'SELECT id, user_id, expires_at, used FROM password_reset_tokens WHERE token_hash = ?'
  ).get(tokenHash) as any

  if (!tokenRow) return res.status(400).json({ error: 'Reset link is invalid.' })
  if (tokenRow.used) return res.status(400).json({ error: 'Reset link has already been used.' })
  if (tokenRow.expires_at < Date.now()) return res.status(400).json({ error: 'Reset link has expired. Request a new one.' })

  const user = db.prepare('SELECT id, pbkdf2_salt, recovery_enc FROM users WHERE id = ?')
    .get(tokenRow.user_id) as any

  const recoveryKeyBuf = Buffer.from(config.recoverySecret, 'hex')
  const dataKey = unwrapKey(user.recovery_enc, recoveryKeyBuf)

  const newSalt = randomBytes(32)
  const newWrapKey = deriveWrapKey(newPassword as string, newSalt)
  const newDataKeyEnc = wrapKey(dataKey, newWrapKey)
  const newPasswordHash = await bcrypt.hash(newPassword as string, 12)

  db.prepare(`
    UPDATE users SET password_hash = ?, pbkdf2_salt = ?, data_key_enc = ? WHERE id = ?
  `).run(newPasswordHash, newSalt.toString('base64'), newDataKeyEnc, user.id)

  db.prepare('UPDATE password_reset_tokens SET used = 1 WHERE id = ?').run(tokenRow.id)
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id)

  res.json({ ok: true })
})
```

Also add `unwrapKey` and `wrapKey` to the existing import from `'../crypto'` at the top of the file.

- [ ] **Step 10.4: Run password reset tests**

```bash
cd inboxmy-backend && npm test -- --reporter=verbose tests/routes/auth-reset.test.ts
```

Expected: All 5 password reset tests pass

- [ ] **Step 10.5: Run full test suite**

```bash
cd inboxmy-backend && npm test
```

Expected: All tests pass

- [ ] **Step 10.6: Commit**

```bash
git add inboxmy-backend/src/routes/auth.ts inboxmy-backend/tests/routes/auth-reset.test.ts
git commit -m "feat: add forgot-password and reset-password routes with key re-wrap"
```

---

## Task 11: Add auth middleware tests

**Files:**
- Create: `inboxmy-backend/tests/middleware/auth.test.ts`

- [ ] **Step 11.1: Write and run auth middleware tests**

Create `inboxmy-backend/tests/middleware/auth.test.ts`:

```typescript
// tests/middleware/auth.test.ts
import { describe, it, expect, afterAll } from 'vitest'
import { closeDb, getDb } from '../../src/db'
import { createTestUser } from '../helpers/auth'
import request from 'supertest'
import { app } from '../../src/server'

afterAll(() => closeDb())

describe('requireAuth middleware', () => {
  it('allows request through with valid session', async () => {
    const { agent } = await createTestUser()
    const res = await agent.get('/api/accounts')
    expect(res.status).toBe(200)
  })

  it('returns 401 with no cookie', async () => {
    const res = await request(app).get('/api/accounts')
    expect(res.status).toBe(401)
    expect(res.body.error).toBeDefined()
  })

  it('returns 401 with a made-up session id', async () => {
    const res = await request(app)
      .get('/api/accounts')
      .set('Cookie', 'session=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
    expect(res.status).toBe(401)
  })

  it('returns 401 for session older than 30 days', async () => {
    const { agent, id: userId } = await createTestUser()
    // Manually age the session in the DB
    getDb().prepare('UPDATE sessions SET created_at = ? WHERE user_id = ?')
      .run(Date.now() - (31 * 24 * 60 * 60 * 1000), userId)
    const res = await agent.get('/api/accounts')
    expect(res.status).toBe(401)
  })
})
```

- [ ] **Step 11.2: Run middleware tests**

```bash
cd inboxmy-backend && npm test -- --reporter=verbose tests/middleware/auth.test.ts
```

Expected: All 4 middleware tests pass

- [ ] **Step 11.3: Run full test suite and verify count**

```bash
cd inboxmy-backend && npm test
```

Expected: All tests pass. Test count should be significantly higher than the original 32.

- [ ] **Step 11.4: Commit**

```bash
git add inboxmy-backend/tests/middleware/auth.test.ts
git commit -m "test: add requireAuth middleware tests including 30-day TTL check"
```

---

## Task 12: Update npm run setup

**Files:**
- Modify: `inboxmy-backend/scripts/setup.ts`
- Modify: `inboxmy-backend/tests/setup.test.ts`

- [ ] **Step 12.1: Write failing tests first (TDD)**

Replace `inboxmy-backend/tests/setup.test.ts` entirely:

```typescript
// tests/setup.test.ts
import { describe, it, expect } from 'vitest'
import {
  isValidGoogleClientId,
  isValidAzureClientId,
  isValidSecret,
  buildEnvContent,
} from '../scripts/setup'

describe('isValidGoogleClientId', () => {
  it('accepts a valid Google client ID', () => {
    expect(isValidGoogleClientId('202736727260-abc.apps.googleusercontent.com')).toBe(true)
  })
  it('rejects ID that does not end with .apps.googleusercontent.com', () => {
    expect(isValidGoogleClientId('notvalid')).toBe(false)
  })
  it('rejects empty string', () => {
    expect(isValidGoogleClientId('')).toBe(false)
  })
  it('rejects ID ending with just googleusercontent.com (missing .apps prefix)', () => {
    expect(isValidGoogleClientId('123.googleusercontent.com')).toBe(false)
  })
})

describe('isValidAzureClientId', () => {
  it('accepts a valid UUID', () => {
    expect(isValidAzureClientId('b14dc905-7164-429e-b85b-daf15dae9b87')).toBe(true)
  })
  it('rejects a non-UUID string', () => {
    expect(isValidAzureClientId('notauuid')).toBe(false)
  })
  it('rejects empty string', () => {
    expect(isValidAzureClientId('')).toBe(false)
  })
  it('rejects UUID with wrong segment lengths', () => {
    expect(isValidAzureClientId('b14dc905-7164-429e-b85b-daf15dae9b8')).toBe(false)
  })
})

describe('isValidSecret', () => {
  it('accepts a non-empty string', () => {
    expect(isValidSecret('GOCSPX-something')).toBe(true)
  })
  it('rejects empty string', () => {
    expect(isValidSecret('')).toBe(false)
  })
  it('rejects whitespace-only string', () => {
    expect(isValidSecret('   ')).toBe(false)
  })
})

describe('buildEnvContent', () => {
  const base = {
    encryptionKey: 'a'.repeat(64),
    sessionSecret: 'b'.repeat(64),
    recoverySecret: 'c'.repeat(64),
    appUrl: 'http://localhost:3001',
    googleClientId: 'test.apps.googleusercontent.com',
    googleClientSecret: 'gsecret',
    microsoftClientId: 'b14dc905-7164-429e-b85b-daf15dae9b87',
    microsoftClientSecret: 'msecret',
    smtpHost: '',
    smtpPort: '587',
    smtpUser: '',
    smtpPass: '',
  }

  it('writes all variables including new Plan 4 secrets', () => {
    const content = buildEnvContent(base)
    expect(content).toContain('ENCRYPTION_KEY=' + 'a'.repeat(64))
    expect(content).toContain('SESSION_SECRET=' + 'b'.repeat(64))
    expect(content).toContain('RECOVERY_SECRET=' + 'c'.repeat(64))
    expect(content).toContain('APP_URL=http://localhost:3001')
    expect(content).toContain('GOOGLE_CLIENT_ID=test.apps.googleusercontent.com')
    expect(content).toContain('GOOGLE_CLIENT_SECRET=gsecret')
    expect(content).toContain('GOOGLE_REDIRECT_URI=http://localhost:3001/auth/gmail/callback')
    expect(content).toContain('MICROSOFT_CLIENT_ID=b14dc905-7164-429e-b85b-daf15dae9b87')
    expect(content).toContain('MICROSOFT_CLIENT_SECRET=msecret')
    expect(content).toContain('MICROSOFT_REDIRECT_URI=http://localhost:3001/auth/outlook/callback')
    expect(content).toContain('PORT=3001')
    expect(content).toContain('DATA_DIR=./data')
    expect(content).toContain('SYNC_INTERVAL_MINUTES=15')
    expect(content).toContain('SMTP_HOST=')
    expect(content).toContain('SMTP_PORT=587')
  })

  it('writes empty strings for skipped providers', () => {
    const content = buildEnvContent({ ...base, googleClientId: '', googleClientSecret: '', microsoftClientId: '', microsoftClientSecret: '' })
    expect(content).toContain('GOOGLE_CLIENT_ID=')
    expect(content).toContain('GOOGLE_CLIENT_SECRET=')
    expect(content).toContain('MICROSOFT_CLIENT_ID=')
    expect(content).toContain('MICROSOFT_CLIENT_SECRET=')
  })
})
```

- [ ] **Step 12.2: Run tests to confirm failure**

```bash
cd inboxmy-backend && npm test -- --reporter=verbose tests/setup.test.ts
```

Expected: `buildEnvContent` tests fail — SESSION_SECRET, RECOVERY_SECRET, APP_URL not in output yet

- [ ] **Step 12.3: Update buildEnvContent in scripts/setup.ts**

Add the new variables to the `BuildEnvParams` interface and `buildEnvContent` function:

```typescript
// Add to BuildEnvParams interface:
sessionSecret: string
recoverySecret: string
appUrl: string
smtpHost: string
smtpPort: string
smtpUser: string
smtpPass: string
```

Append to the env file content string:
```
SESSION_SECRET=${params.sessionSecret}
RECOVERY_SECRET=${params.recoverySecret}
APP_URL=${params.appUrl}
SMTP_HOST=${params.smtpHost}
SMTP_PORT=${params.smtpPort}
SMTP_USER=${params.smtpUser}
SMTP_PASS=${params.smtpPass}
```

In the interactive wizard, after generating `ENCRYPTION_KEY`, also generate and log:
```typescript
const sessionSecret = randomBytes(32).toString('hex')
const recoverySecret = randomBytes(32).toString('hex')
console.log('✓ SESSION_SECRET generated automatically.')
console.log('✓ RECOVERY_SECRET generated automatically.')
```

Add a prompt for `APP_URL` (default `http://localhost:3001` if blank), then an optional SMTP block:
```
─── Email (Password Reset) ──────────────────
Configure SMTP for password reset emails? (y/N):
```
If yes: prompt SMTP_HOST, SMTP_PORT (default 587), SMTP_USER, SMTP_PASS.
If no: write empty strings for all four.

- [ ] **Step 12.4: Run setup tests**

```bash
cd inboxmy-backend && npm test -- --reporter=verbose tests/setup.test.ts
```

Expected: All setup tests pass

- [ ] **Step 12.5: Commit**

```bash
git add inboxmy-backend/scripts/setup.ts inboxmy-backend/tests/setup.test.ts
git commit -m "feat: extend setup wizard with SESSION_SECRET, RECOVERY_SECRET, APP_URL, SMTP prompts"
```

---

## Task 13: Frontend — auth page, sign-out, auth check

**Files:**
- Create: `frontend/auth.html`
- Modify: `frontend/index.html`
- Modify: `frontend/app.js`

- [ ] **Step 13.1: Create frontend/auth.html**

Create `inboxmy-backend/../frontend/auth.html` (i.e., `frontend/auth.html` at repo root):

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>InboxMY — Sign In</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: #0f1117; color: #e2e8f0;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      display: flex; align-items: center; justify-content: center;
      min-height: 100vh;
    }
    .card {
      background: #1a1d27; border: 1px solid #2d3748; border-radius: 12px;
      padding: 2rem; width: 100%; max-width: 420px;
    }
    h1 { font-size: 1.5rem; margin-bottom: 0.25rem; }
    .subtitle { color: #718096; font-size: 0.875rem; margin-bottom: 1.5rem; }
    .tabs { display: flex; gap: 0.5rem; margin-bottom: 1.5rem; }
    .tab {
      flex: 1; padding: 0.5rem; background: #2d3748; border: none; border-radius: 6px;
      color: #a0aec0; cursor: pointer; font-size: 0.9rem;
    }
    .tab.active { background: #4299e1; color: #fff; }
    label { display: block; font-size: 0.85rem; color: #a0aec0; margin-bottom: 0.25rem; }
    input {
      width: 100%; padding: 0.6rem 0.75rem; background: #2d3748; border: 1px solid #4a5568;
      border-radius: 6px; color: #e2e8f0; font-size: 0.95rem; margin-bottom: 1rem;
    }
    input:focus { outline: none; border-color: #4299e1; }
    .btn {
      width: 100%; padding: 0.7rem; background: #4299e1; color: #fff;
      border: none; border-radius: 6px; font-size: 1rem; cursor: pointer;
    }
    .btn:hover { background: #3182ce; }
    .error { color: #fc8181; font-size: 0.875rem; margin-bottom: 0.75rem; display: none; }
    .forgot { text-align: right; margin-top: -0.75rem; margin-bottom: 1rem; }
    .forgot a { color: #4299e1; font-size: 0.8rem; text-decoration: none; }
  </style>
</head>
<body>
  <div class="card">
    <h1>InboxMY</h1>
    <p class="subtitle">Privacy-first email dashboard for Malaysia</p>

    <div class="tabs">
      <button class="tab active" onclick="showTab('signin')">Sign In</button>
      <button class="tab" onclick="showTab('signup')">Sign Up</button>
    </div>

    <div id="error" class="error"></div>

    <!-- Sign In -->
    <form id="signinForm" onsubmit="handleSignin(event)">
      <label>Email</label>
      <input type="email" id="signinEmail" required placeholder="you@example.com" />
      <label>Password</label>
      <input type="password" id="signinPassword" required placeholder="Your password" />
      <div class="forgot"><a href="/forgot-password">Forgot password?</a></div>
      <button type="submit" class="btn">Sign In</button>
    </form>

    <!-- Sign Up -->
    <form id="signupForm" style="display:none" onsubmit="handleSignup(event)">
      <label>Email</label>
      <input type="email" id="signupEmail" required placeholder="you@example.com" />
      <label>Password</label>
      <input type="password" id="signupPassword" required placeholder="Min 8 characters" />
      <label>Confirm Password</label>
      <input type="password" id="signupConfirm" required placeholder="Repeat password" />
      <button type="submit" class="btn">Create Account</button>
    </form>
  </div>

  <script>
    function showTab(tab) {
      document.getElementById('signinForm').style.display = tab === 'signin' ? '' : 'none'
      document.getElementById('signupForm').style.display = tab === 'signup' ? '' : 'none'
      document.querySelectorAll('.tab').forEach((el, i) => {
        el.classList.toggle('active', (i === 0) === (tab === 'signin'))
      })
      document.getElementById('error').style.display = 'none'
    }

    function showError(msg) {
      const el = document.getElementById('error')
      el.textContent = msg
      el.style.display = 'block'
    }

    async function handleSignin(e) {
      e.preventDefault()
      const email = document.getElementById('signinEmail').value
      const password = document.getElementById('signinPassword').value
      const res = await fetch('/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      })
      if (res.ok) {
        window.location.href = '/'
      } else {
        const data = await res.json()
        showError(data.error ?? 'Sign in failed')
      }
    }

    async function handleSignup(e) {
      e.preventDefault()
      const email = document.getElementById('signupEmail').value
      const password = document.getElementById('signupPassword').value
      const confirm = document.getElementById('signupConfirm').value
      if (password !== confirm) return showError('Passwords do not match')
      const res = await fetch('/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      })
      if (res.ok) {
        window.location.href = '/'
      } else {
        const data = await res.json()
        showError(data.error ?? 'Sign up failed')
      }
    }
  </script>
</body>
</html>
```

- [ ] **Step 13.2: Add sign-out button to frontend/index.html**

In `frontend/index.html`, find the header element and add a sign-out button. Add this near the top of `<body>` or inside the existing header:

```html
<button id="signOutBtn" onclick="handleSignOut()" style="position:fixed;top:12px;right:16px;background:#e53e3e;color:#fff;border:none;padding:6px 14px;border-radius:6px;cursor:pointer;font-size:0.85rem;z-index:999;">Sign Out</button>
```

- [ ] **Step 13.3: Update frontend/app.js**

At the very top of `frontend/app.js`, add the auth check before any other code:

```javascript
// Auth check — redirect to /auth if not logged in
(async function checkAuth() {
  try {
    const res = await fetch('/auth/me')
    if (!res.ok) {
      window.location.href = '/auth'
      return
    }
    const { user } = await res.json()
    // Display user email if there's a header element for it
    const emailEl = document.getElementById('userEmail')
    if (emailEl) emailEl.textContent = user.email
  } catch {
    window.location.href = '/auth'
  }
})()

async function handleSignOut() {
  await fetch('/auth/logout', { method: 'POST' })
  window.location.href = '/auth'
}
```

- [ ] **Step 13.4: Add /auth route to server.ts**

In `inboxmy-backend/src/server.ts`, add a route to serve auth.html before the static middleware:

```typescript
app.get('/auth', (req, res) => {
  res.sendFile(path.resolve(__dirname, '../../frontend/auth.html'))
})
```

- [ ] **Step 13.5: Manual smoke test**

```bash
cd inboxmy-backend && npm run dev
```

1. Open `http://localhost:3001` → confirm redirect to `/auth`
2. Sign up with a new email → confirm redirect to dashboard
3. Open DevTools → Application → Cookies → confirm `session` cookie is HttpOnly, SameSite=Lax
4. Click Sign Out → confirm redirect to `/auth`
5. Press browser back → confirm still on `/auth` (dashboard blocks unauthenticated access)

- [ ] **Step 13.6: Commit**

```bash
git add frontend/auth.html frontend/index.html frontend/app.js inboxmy-backend/src/server.ts
git commit -m "feat: add auth.html login/signup page, sign-out button, and auth check in app.js"
```

---

## Task 14: Update README

**Files:**
- Modify: `README.md`

- [ ] **Step 14.1: Update README.md**

Make the following changes to `README.md`:

1. In the roadmap table, update Plan 4 row:
   - Change status from `⏳ Pending` to `✅ Done`
   - Update key deliverables to: `User sign-up/sign-in (email+password), per-user AES-256-GCM encrypted data keys, HTTP-only cookie sessions (30-day TTL), email-based password reset, auth middleware on all API routes, OAuth state relay, frontend sign-in page`

2. Add a new `## Multi-User Architecture` section after the existing setup section. Include:

```markdown
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
```

- [ ] **Step 14.2: Commit**

```bash
git add README.md
git commit -m "docs: update README — Plan 4 complete, multi-user architecture section, test checklist"
```

---

## Task 15: Final verification

- [ ] **Step 15.1: Run full test suite**

```bash
cd inboxmy-backend && npm test -- --reporter=verbose
```

Expected: All tests pass. Count should be substantially higher than the original 32.

- [ ] **Step 15.2: TypeScript build check**

```bash
cd inboxmy-backend && npm run build
```

Expected: No TypeScript errors

- [ ] **Step 15.3: Final commit if any loose files**

```bash
cd "C:/Users/bryan.GOAT/Downloads/VibeCode" && git status
```

Commit any uncommitted changes, then tag the completed plan.
