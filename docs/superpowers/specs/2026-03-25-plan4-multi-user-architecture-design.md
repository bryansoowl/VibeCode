# Plan 4 — Multi-User Architecture: Design Spec

**Date:** 2026-03-25
**Status:** Approved
**Project:** InboxMY — Privacy-first unified email dashboard for Malaysia

---

## Context

Plans 1–3 are complete: the backend runs at `localhost:3001`, the frontend is wired to the live API, the OAuth setup wizard works, and 32 tests pass. The app is currently single-user with no authentication — anyone with the URL has full access to all data.

**The problem Plan 4 solves:** InboxMY is heading toward a hosted service at `inboxmy.my`. Multiple Malaysian users need to sign up, log in, and have their email accounts, parsed bills, and encrypted data fully isolated from each other. There is no local-download mode — the app is hosted by Bryan, who registers the OAuth app credentials once, and users connect their own Gmail/Outlook accounts through the standard OAuth flow.

---

## Scope

### In scope
- User sign-up and sign-in (email + password, bcrypt cost 12)
- HTTP-only cookie sessions with 30-day idle TTL
- Per-user AES-256-GCM data key, wrapped with PBKDF2-derived password key (random salt per user)
- Server-side recovery key copy for email-based password reset
- Email-based password reset (logs to console if SMTP not configured)
- Auth middleware applied to all `/api/*` routes with stricter rate limits on `/auth/*`
- OAuth callback secured via state parameter to associate connected account with logged-in user
- DB migration: `users` and `sessions` tables, `user_id` on `accounts`
- Frontend auth page (login/signup) and sign-out button
- `npm run setup` extended to generate `SESSION_SECRET` and `RECOVERY_SECRET`
- README updated with full description, architecture, and test instructions

### Out of scope
- Admin dashboard / user management UI (future plan)
- OAuth-per-user credentials (Bryan's app credentials are shared — standard hosted model)
- Two-factor authentication (future plan)
- Email verification at sign-up (future plan)

---

## Architecture Decision: Session Mechanism

**Chosen: HTTP-only cookie sessions (server-side session table)**

Rejected alternatives:
- **JWT in localStorage** — XSS-vulnerable; a stolen JWT is valid until expiry with no revocation path
- **JWT access + refresh token** — overkill for single-server deployment; two token flows for no real benefit at this scale

HTTP-only cookie sessions are:
- XSS-proof (JavaScript cannot read the cookie)
- Instantly revocable (delete the session row)
- **Absolute 30-day TTL** from `created_at`: `requireAuth` rejects sessions where `created_at < now - 30 days` and deletes the row. This is an absolute expiry (not idle — the timer does not reset on activity). The startup cleanup uses the same `30 * 24 * 60 * 60 * 1000` constant to avoid drift.
- Simple: one DB lookup per request

**Cookie attributes** (set on all session cookies):
```typescript
res.cookie('session', sessionId, {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax',
  path: '/',
  // No maxAge — browser session cookie; persists until explicit logout or 30-day server-side TTL
})
```

---

## Database Schema

### New table: `users`

```sql
CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  pbkdf2_salt   TEXT NOT NULL,
  data_key_enc  TEXT NOT NULL,
  recovery_enc  TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);
```

| Column | Description |
|--------|-------------|
| `id` | UUID v4 |
| `email` | User's login email (not necessarily Gmail/Outlook — just the InboxMY account email) |
| `password_hash` | bcrypt hash (cost factor 12) — used for login verification only |
| `pbkdf2_salt` | 32 random bytes, base64-encoded — unique per user, used as PBKDF2 salt. Stored separately from `id` so it cannot be predicted from any public value |
| `data_key_enc` | 32-byte random data key, AES-256-GCM encrypted with `wrapKey = PBKDF2(password, pbkdf2_salt, 310000, SHA-256, 32 bytes)`. Output is base64-encoded `iv(12) + tag(16) + ciphertext(32)` |
| `recovery_enc` | Same data key, AES-256-GCM encrypted with `RECOVERY_SECRET` (server env var). Same encoding. |
| `created_at` | Unix ms |

### New table: `sessions`

```sql
CREATE TABLE sessions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key_enc    TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
```

| Column | Description |
|--------|-------------|
| `id` | 32 random bytes, hex encoded (64 chars) — used as the cookie value |
| `user_id` | FK to `users` |
| `key_enc` | User's `dataKey` encrypted with `SESSION_SECRET` — decrypted per-request, never persisted in memory beyond the request |
| `created_at` | Unix ms. `requireAuth` rejects sessions where `created_at < now - 30 days`. |

**Session TTL note:** The 30-day TTL is enforced in `requireAuth` (not the DB) — any session older than 30 days returns `401`. A background cleanup of expired rows runs on startup: `DELETE FROM sessions WHERE created_at < ?`. This prevents unbounded session table growth and ensures a leaked session cookie is not permanently valid.

### Modified table: `accounts`

```sql
ALTER TABLE accounts ADD COLUMN user_id TEXT REFERENCES users(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_accounts_user ON accounts(user_id);
```

`emails` and `parsed_bills` do not need `user_id` — they cascade through `accounts → emails → parsed_bills`.

**Migration safety:** `ALTER TABLE ... ADD COLUMN` is not idempotent. The migration runner in `migrations.ts` uses a `schema_version` table that prevents each migration from running more than once. Migration 2 is a single string entry in the `MIGRATIONS` array — it will only ever execute on a DB at version 1, never twice.

### New table: `password_reset_tokens`

```sql
CREATE TABLE password_reset_tokens (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used       INTEGER NOT NULL DEFAULT 0
);
```

Token is a 32-byte random hex string. Only the SHA-256 hash is stored. Expires after 1 hour. Marked `used = 1` after successful consumption (not deleted, for audit trail).

**Lookup pattern:** `SELECT * FROM password_reset_tokens WHERE token_hash = ? AND used = 0 AND expires_at > ?` — SQL equality comparison is acceptable here; timing-safe comparison in application code is not required because the comparison happens in the DB engine, not in JavaScript.

### Migration strategy

- Migration 2 adds all new tables and the `user_id` column to `accounts` as a single migration entry
- `user_id` is added as nullable to allow the migration to run on existing DBs without breaking them
- On first startup after migration, any `accounts` rows with `user_id IS NULL` are deleted via `DELETE FROM accounts WHERE user_id IS NULL` run inside `server.ts`'s `require.main` block, after `runMigrations()` and before `startScheduler()`. This is dev data cleanup — in production, users always authenticate before connecting accounts so this situation cannot arise. The cleanup is a one-time no-op on a fresh DB.

---

## Encryption Architecture

### Threat model note

`RECOVERY_SECRET` is a server-side symmetric secret. Anyone who obtains it plus the `users` table can unwrap every user's `dataKey`. This is an accepted tradeoff for the hosted v1 model: the server operator (Bryan) is trusted, and the recovery mechanism requires actual database access, not just network access. The `data_key_enc` column (PBKDF2-wrapped) remains unreadable without the user's password. A future hardening plan may introduce an HSM or separate key service for `RECOVERY_SECRET`.

### Key types and encodings

| Key | Type | Encoding |
|-----|------|----------|
| `dataKey` | 32-byte Buffer | raw Buffer in memory, never serialised directly |
| `wrapKey` (from PBKDF2) | 32-byte Buffer | raw Buffer, never stored |
| `SESSION_SECRET` | 32-byte Buffer | hex env var → `Buffer.from(hex, 'hex')` at use time |
| `RECOVERY_SECRET` | 32-byte Buffer | hex env var → `Buffer.from(hex, 'hex')` at use time |
| `data_key_enc`, `recovery_enc`, `key_enc` | AES-256-GCM output | base64 string: `iv(12) + tag(16) + ciphertext(32)` |

### Sign-up flow

```
1. Generate pbkdf2_salt = randomBytes(32)               → stored in users
2. Generate dataKey = randomBytes(32)                    → never stored directly
3. wrapKey = PBKDF2(password, pbkdf2_salt, 310000, SHA-256, 32 bytes) → raw Buffer, not stored
4. data_key_enc = AES-256-GCM(dataKey, wrapKey)          → stored in users
5. recovery_enc = AES-256-GCM(dataKey, RECOVERY_SECRET)  → stored in users
6. password_hash = bcrypt.hash(password, 12)             → stored in users
7. sessionId = randomBytes(32).hex()
8. key_enc = AES-256-GCM(dataKey, SESSION_SECRET)        → stored in sessions
9. Set HTTP-only session cookie with sessionId
```

### Login flow

```
1. SELECT id, password_hash, pbkdf2_salt, data_key_enc FROM users WHERE email = ?
2. bcrypt.compare(password, password_hash)               → identity verified
3. wrapKey = PBKDF2(password, pbkdf2_salt, 310000, SHA-256, 32 bytes)
4. dataKey = AES-256-GCM decrypt(data_key_enc, wrapKey)  → unwrapped
5. sessionId = randomBytes(32).hex()
6. key_enc = AES-256-GCM(dataKey, SESSION_SECRET)        → stored in sessions
7. Set HTTP-only session cookie with sessionId
```

### Per-request flow (requireAuth middleware)

```
1. Read sessionId from cookie 'session'
2. SELECT s.key_enc, s.user_id, s.created_at, u.email
   FROM sessions s JOIN users u ON u.id = s.user_id
   WHERE s.id = ?
3. If not found → 401
4. If created_at < now - 30 days → 401, delete session row
5. dataKey = AES-256-GCM decrypt(key_enc, SESSION_SECRET)  → Buffer, in-memory only
6. req.user = { id: s.user_id, email: u.email, dataKey }
7. next()
```

### Password reset flow

```
1. POST /auth/forgot-password { email }
2. SELECT id, recovery_enc FROM users WHERE email = ?
   (proceed regardless — always return { ok: true } to prevent email enumeration)
3. Generate resetToken = randomBytes(32).hex()
4. Store { token_hash: sha256(resetToken), user_id, expires_at: now + 1h } in password_reset_tokens
5. If SMTP configured → send email with link: APP_URL/reset-password?token=resetToken
   If SMTP not configured → console.log('[InboxMY] Password reset link:', link)
6. Return { ok: true }

7. POST /auth/reset-password { token, newPassword }
8. tokenHash = sha256(token)
9. SELECT id, user_id, expires_at, used FROM password_reset_tokens WHERE token_hash = ?
10. If not found / used=1 → 400 "Reset link has already been used."
11. If expires_at < now → 400 "Reset link has expired. Request a new one."
12. SELECT id, pbkdf2_salt, recovery_enc FROM users WHERE id = token.user_id
13. dataKey = AES-256-GCM decrypt(recovery_enc, RECOVERY_SECRET)
14. newSalt = randomBytes(32)                             → new salt on password change
15. newWrapKey = PBKDF2(newPassword, newSalt, 310000, SHA-256, 32 bytes)
16. newDataKeyEnc = AES-256-GCM(dataKey, newWrapKey)
17. UPDATE users SET password_hash = bcrypt(newPassword, 12),
                     pbkdf2_salt = newSalt,
                     data_key_enc = newDataKeyEnc
18. UPDATE password_reset_tokens SET used = 1 WHERE id = token.id
19. DELETE FROM sessions WHERE user_id = token.user_id   → invalidate all sessions
20. Return { ok: true }
```

### Crypto module changes

`src/crypto.ts` gains an explicit-key API alongside a system-key convenience wrapper:

```typescript
// Explicit key (used for per-user data encryption/decryption)
export function encrypt(plaintext: string, key: Buffer): string
export function decrypt(ciphertext: string, key: Buffer): string

// Key wrapping (used for data key storage)
export function wrapKey(dataKey: Buffer, wrappingKey: Buffer): string     // → base64
export function unwrapKey(enc: string, wrappingKey: Buffer): Buffer       // base64 → Buffer

// PBKDF2 key derivation — uses crypto.pbkdf2Sync (blocking)
// Rationale: only called on sign-up and login paths (not on every API request).
// The ~300ms block is acceptable on these low-frequency paths and avoids async
// complexity in the crypto module. Do NOT call from hot paths.
export function deriveWrapKey(password: string, salt: Buffer): Buffer     // → 32-byte Buffer

// System key wrapper (used by token-store.ts and OAuth auth modules — wraps global ENCRYPTION_KEY)
// ENCRYPTION_KEY is already provisioned by Plan 1's npm run setup; Plan 4 setup does NOT re-prompt for it.
export function encryptSystem(plaintext: string): string
export function decryptSystem(ciphertext: string): string
```

**Migration of existing callers:**
- `token-store.ts` — calls renamed from `encrypt`/`decrypt` to `encryptSystem`/`decryptSystem`. OAuth tokens are still encrypted with the global `ENCRYPTION_KEY` (they are system credentials, not user data).
- `gmail.ts`, `outlook.ts` — no direct crypto calls; they call `token-store.ts`.
- `sync-engine.ts` — accepts `dataKey: Buffer` parameter; all email body/subject encryption uses `encrypt(plaintext, dataKey)`.

The old zero-argument `encrypt(plaintext)` and `decrypt(ciphertext)` exports are removed. Compilation will fail fast on any missed call sites.

---

## OAuth Callback Security

**Problem:** After Plan 4, OAuth callbacks at `/auth/gmail/callback` and `/auth/outlook/callback` must associate the newly connected account with the authenticated user. These callbacks are triggered by Google/Microsoft redirects and cannot carry a session cookie in the traditional sense.

**Solution:** State parameter relay.

1. When the user clicks "Connect Gmail", `GET /api/accounts/connect/gmail` generates the OAuth URL with `state = sessionId` appended.
2. Google redirects to `/auth/gmail/callback?code=...&state=sessionId`.
3. The callback handler reads `state`, looks up the session in the DB to resolve `userId`, and passes `userId` to `handleCallback()`.
4. `handleCallback()` inserts `user_id` into the new `accounts` row.

Both `/auth/gmail/callback` and `/auth/outlook/callback` remain unauthenticated routes (no `requireAuth` middleware) but validate the state parameter. If the state is missing, invalid, or the session has expired (session not found in DB, or `created_at` older than 30 days by the same TTL constant used in `requireAuth`), the callback returns `400`.

The `getAuthUrl()` functions in `gmail.ts` and `outlook.ts` are updated to accept and embed a `state` string.

---

## Rate Limiting

A stricter limiter is applied to auth routes to prevent brute-force attacks:

```typescript
const authLimiter = rateLimit({
  windowMs: 60_000,        // 1 minute
  max: 10,                 // 10 requests per IP per minute
  standardHeaders: true,
  legacyHeaders: false,
})
app.use('/auth/login', authLimiter)
app.use('/auth/signup', authLimiter)
app.use('/auth/forgot-password', authLimiter)
```

The existing `/api` limiter (200 req/min) is unchanged. `/auth/logout` and `/auth/me` are intentionally not rate-limited — `me` is called on every page load (high frequency, low risk) and `logout` is a safe idempotent operation.

---

## New Files

| File | Purpose |
|------|---------|
| `src/routes/auth.ts` | Sign-up, login, logout, forgot-password, reset-password, me |
| `src/middleware/auth.ts` | `requireAuth` middleware — session lookup, TTL check, key decryption, req.user |
| `frontend/auth.html` | Login/signup page with two tabs |

---

## API Routes

### `POST /auth/signup`
**Body:** `{ email: string, password: string }`
**Response:** `{ ok: true, user: { id: string, email: string } }` + sets `session` cookie
**Errors:** `409` email already registered, `400` missing/invalid fields

**Password validation rules:**
- Minimum: 8 characters
- Maximum: 72 bytes (enforced before bcrypt — bcrypt silently truncates inputs over 72 bytes, meaning a 73-char and a 100-char password with the same first 72 bytes would produce the same hash; this rule prevents that)
- No character class requirements (length is the strongest factor)

### `POST /auth/login`
**Body:** `{ email: string, password: string }`
**Response:** `{ ok: true, user: { id: string, email: string } }` + sets `session` cookie
**Errors:** `401` "Invalid email or password" (never distinguishes which is wrong)

### `POST /auth/logout`
**Auth:** required (cookie)
**Response:** `{ ok: true }` + clears `session` cookie, deletes session row

### `GET /auth/me`
**Auth:** required (cookie)
**Response:** `{ user: { id: string, email: string } }`
**Purpose:** Frontend calls this on every page load to check auth state. Returns `401` if session is missing or expired.

### `POST /auth/forgot-password`
**Body:** `{ email: string }`
**Response:** `{ ok: true }` — always, regardless of whether email exists (prevents enumeration)
**Side effect:** If email exists: sends reset email or logs link to console if SMTP not configured

### `POST /auth/reset-password`
**Body:** `{ token: string, newPassword: string }`
**Response:** `{ ok: true }`
**Errors:** `400` "Reset link has expired. Request a new one." / `400` "Reset link has already been used."

---

## Auth Middleware

`src/middleware/auth.ts` exports `requireAuth`:

```typescript
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 days

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const sessionId = req.cookies?.session
  if (!sessionId) return res.status(401).json({ error: 'Not authenticated' })

  const row = db.prepare(`
    SELECT s.user_id, s.key_enc, s.created_at, u.email
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.id = ?
  `).get(sessionId) as any

  if (!row) return res.status(401).json({ error: 'Session not found' })

  if (Date.now() - row.created_at > SESSION_TTL_MS) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId)
    return res.status(401).json({ error: 'Session expired' })
  }

  const dataKey = unwrapKey(row.key_enc, Buffer.from(config.sessionSecret, 'hex'))
  req.user = { id: row.user_id, email: row.email, dataKey }
  next()
}
```

Applied in `server.ts`:
```typescript
app.use('/api', requireAuth)
```

---

## Route Changes

All existing routes (`/api/accounts`, `/api/emails`, `/api/bills`, `/api/sync`) are updated to filter by `req.user.id`:

```typescript
// Before
db.prepare('SELECT * FROM accounts').all()

// After
db.prepare('SELECT * FROM accounts WHERE user_id = ?').all(req.user.id)
```

All `INSERT` operations on `accounts` include `user_id = req.user.id`.

All `encrypt()`/`decrypt()` calls gain `req.user.dataKey` as the key argument.

All `sync-engine.ts` calls receive `req.user.dataKey` as a parameter.

---

## Frontend Changes

### New: `frontend/auth.html`

- Two-tab interface: **Sign In** / **Sign Up**
- Sign Up: email field, password field, confirm password field
- Sign In: email field, password field, "Forgot password?" link
- On success: redirects to `/`
- Served at `/auth` — the only unauthenticated HTML route
- Styled to match InboxMY's existing dark dashboard aesthetic

### Modified: `frontend/InboxMy.html`

- Sign-out button added to the header bar
- Calls `POST /auth/logout` on click, redirects to `/auth`

### Modified: `frontend/app.js`

- On `DOMContentLoaded`: call `GET /auth/me`
  - `401` → `window.location.href = '/auth'`
  - `200` → display `user.email` in header, proceed with normal load
- Sign-out button handler added
- All existing `fetch('/api/...')` calls unchanged — cookie sent automatically by browser

---

## New Environment Variables

| Variable | Description | Generated by |
|----------|-------------|-------------|
| `SESSION_SECRET` | 32-byte hex — encrypts data key stored in session row | `npm run setup` (auto) |
| `RECOVERY_SECRET` | 32-byte hex — wraps data key for password reset | `npm run setup` (auto) |
| `SMTP_HOST` | SMTP server hostname | User-configured (optional) |
| `SMTP_PORT` | SMTP port (default 587) | User-configured (optional) |
| `SMTP_USER` | SMTP username | User-configured (optional) |
| `SMTP_PASS` | SMTP password | User-configured (optional) |
| `APP_URL` | Public URL for reset links (e.g. `https://inboxmy.my`) | User-configured |

`npm run setup` extended to:
- Auto-generate `SESSION_SECRET` and `RECOVERY_SECRET`
- Ask for `APP_URL`
- Ask if user wants to configure SMTP (optional, can skip — reset links log to console)

---

## Data Flow

```
User visits https://inboxmy.my
    │
    ├── app.js: GET /auth/me
    │     ├── 401 → redirect to /auth
    │     └── 200 → load dashboard
    │
    ├── /auth → auth.html (sign in / sign up tabs)
    │     ├── Sign Up: POST /auth/signup { email, password }
    │     │     ├── bcrypt.hash(password, 12)
    │     │     ├── Generate pbkdf2_salt (32 random bytes)
    │     │     ├── Generate dataKey (32 random bytes)
    │     │     ├── PBKDF2(password, pbkdf2_salt) → wrapKey
    │     │     ├── wrapKey(dataKey, wrapKey)       → data_key_enc
    │     │     ├── wrapKey(dataKey, RECOVERY_SECRET) → recovery_enc
    │     │     ├── Create session, wrapKey(dataKey, SESSION_SECRET) → key_enc
    │     │     ├── Set HTTP-only session cookie
    │     │     └── Redirect to /
    │     │
    │     └── Sign In: POST /auth/login { email, password }
    │           ├── bcrypt.compare → verified
    │           ├── PBKDF2(password, pbkdf2_salt) → wrapKey → unwrap dataKey
    │           ├── Create session, wrapKey(dataKey, SESSION_SECRET) → key_enc
    │           ├── Set HTTP-only session cookie
    │           └── Redirect to /
    │
    ├── GET /api/emails (requireAuth middleware)
    │     ├── Read session cookie → look up sessions row, check TTL
    │     ├── unwrapKey(key_enc, SESSION_SECRET) → dataKey (in memory)
    │     ├── req.user = { id, email, dataKey }
    │     ├── SELECT emails WHERE account.user_id = req.user.id
    │     ├── decrypt(subject_enc, dataKey) for each email
    │     └── Return decrypted emails
    │
    ├── Connect Gmail (OAuth state relay)
    │     ├── GET /api/accounts/connect/gmail
    │     ├── Generate OAuth URL with state = sessionId
    │     ├── User approves on Google
    │     ├── GET /auth/gmail/callback?code=...&state=sessionId
    │     ├── Look up session → resolve userId
    │     ├── INSERT INTO accounts (user_id = userId, ...)
    │     └── window.close()
    │
    └── POST /auth/logout
          ├── DELETE FROM sessions WHERE id = sessionId
          ├── Clear session cookie
          └── Redirect to /auth
```

---

## Error Handling

| Scenario | Behaviour |
|----------|-----------|
| Sign-up with existing email | `409 Conflict` — "Email already registered" |
| Wrong password at login | `401` — "Invalid email or password" (never reveals which) |
| Missing session cookie | `401` — frontend redirects to `/auth` |
| Session older than 30 days | `401` — session deleted, frontend redirects to `/auth` |
| OAuth callback with invalid/expired state | `400` — "Invalid or expired session. Please reconnect from the dashboard." |
| Reset token expired (>1h) | `400` — "Reset link has expired. Request a new one." |
| Reset token already used | `400` — "Reset link has already been used." |
| SMTP not configured | Reset link logged to console: `[InboxMY] Password reset link: <url>` |
| `SESSION_SECRET` missing at startup | Hard throw — app exits (added to `validateConfig()`) |
| `RECOVERY_SECRET` missing at startup | Hard throw — app exits (added to `validateConfig()`) |

---

## Testing

### Manual test checklist

**Sign-up:**
1. Navigate to `http://localhost:3001/auth` → sign-up tab visible
2. Register with `test@example.com` / `Password123!`
3. Confirm redirect to dashboard at `/`
4. Open DevTools → Application → Cookies → confirm `session` cookie is `HttpOnly`, no `Expires` set, `SameSite=Lax`
5. Refresh page → confirm still logged in (no redirect to `/auth`)

**Sign-in:**
6. Click Sign Out → confirm redirect to `/auth`, cookie cleared
7. Sign in with same credentials → confirm redirect to dashboard
8. Sign in with wrong password → confirm "Invalid email or password" shown

**Per-user isolation:**
9. Sign up as `user2@example.com` in an incognito window
10. Connect a Gmail account as user2
11. Switch back to user1 window → confirm user2's account does NOT appear in the accounts panel

**OAuth connect with auth:**
12. As user1, click "Connect Gmail" → confirm Google OAuth opens
13. Approve → confirm account appears in user1's dashboard
14. As user2 (incognito), confirm user1's Gmail account is not visible

**Password reset:**
15. Click "Forgot password?" → enter `test@example.com` → confirm `{ ok: true }` response
16. Check server console for reset link (SMTP not configured in dev)
17. Open reset link → enter new password `NewPass456!` → confirm redirect to sign-in
18. Sign in with `NewPass456!` → confirm dashboard loads, emails and bills intact
19. Sign in with `Password123!` (old password) → confirm `401`

**Session TTL:**
20. To test TTL without waiting 30 days: in SQLite browser, set `created_at` of a session to `(now - 31 days)`, then reload the dashboard → confirm redirect to `/auth`

**Session persistence:**
21. Close browser entirely, reopen → navigate to `http://localhost:3001` → confirm still logged in

**Logout:**
22. Click Sign Out → confirm redirect to `/auth`
23. Press browser back button → confirm cannot access dashboard (redirected back to `/auth`)

### Unit tests (Jest)

| Test file | Tests |
|-----------|-------|
| `src/routes/auth.test.ts` | signup happy path, duplicate email, login success, login wrong password, logout clears session, me returns user, me returns 401 without cookie, forgot-password always 200, reset-password success + data intact, reset-password expired token, reset-password used token |
| `src/middleware/auth.test.ts` | valid session passes + sets req.user, missing cookie → 401, invalid session id → 401, session older than 30 days → 401 + row deleted |
| `src/crypto.test.ts` (extended) | encrypt/decrypt round-trip with explicit key, wrapKey/unwrapKey round-trip, deriveWrapKey determinism (same password+salt → same key), encryptSystem/decryptSystem round-trip |

---

## File Changes Summary

| File | Change |
|------|--------|
| `src/db/migrations.ts` | Migration 2: `users`, `sessions`, `password_reset_tokens` tables; `user_id` + index on `accounts`; startup cleanup of orphaned accounts |
| `src/crypto.ts` | Add `encrypt(key)`, `decrypt(key)`, `wrapKey`, `unwrapKey`, `deriveWrapKey`; add `encryptSystem`/`decryptSystem` wrappers; remove old zero-arg exports |
| `src/routes/auth.ts` | New file — signup, login, logout, me, forgot-password, reset-password |
| `src/middleware/auth.ts` | New file — `requireAuth` with 30-day TTL check |
| `src/routes/accounts.ts` | Filter by `req.user.id`; pass `req.user.dataKey`; embed `sessionId` in OAuth state |
| `src/routes/emails.ts` | Filter by `req.user.id` via accounts join; pass `req.user.dataKey` |
| `src/routes/bills.ts` | Filter by `req.user.id` via accounts/emails join |
| `src/routes/sync.ts` | Verify account belongs to `req.user.id`; pass `req.user.dataKey` to sync engine |
| `src/email/sync-engine.ts` | Accept `dataKey: Buffer` param; use `encrypt(plaintext, dataKey)` |
| `src/auth/token-store.ts` | Rename `encrypt`/`decrypt` calls to `encryptSystem`/`decryptSystem` |
| `src/auth/gmail.ts` | Accept `state` param in `getAuthUrl()`; accept `userId` in `handleCallback()` |
| `src/auth/outlook.ts` | Accept `state` param in `getAuthUrl()`; accept `userId` in `handleCallback()` |
| `src/config.ts` | Add `SESSION_SECRET`, `RECOVERY_SECRET` to `validateConfig()` hard-throw checks; add to `config` object |
| `src/server.ts` | Mount `authRouter` at `/auth`; apply `requireAuth` to `/api/*`; add `cookie-parser`; add auth rate limiter; startup session cleanup |
| `scripts/setup.ts` | Auto-generate `SESSION_SECRET`, `RECOVERY_SECRET`; prompt for `APP_URL`; optional SMTP config |
| `frontend/auth.html` | New file — login/signup page |
| `frontend/InboxMy.html` | Add sign-out button to header |
| `frontend/app.js` | Auth check on load via `GET /auth/me`; sign-out handler |
| `README.md` | Plan 4 status updated; new "Multi-User Architecture" section with env vars, architecture summary, and test checklist |

---

## README Additions

The README will be updated with:

1. **Plan 4 status** → marked as `🔄 This session` in the roadmap table
2. **New section: "Multi-User Architecture"** covering:
   - Overview: email + password sign-up, permanent sessions, per-user encrypted data
   - Per-user encryption model (plain English: "your emails are encrypted with a key only unlockable by your password; the server cannot read your data without it")
   - Recovery model and the RECOVERY_SECRET tradeoff (operator is trusted for v1)
   - New env vars table (`SESSION_SECRET`, `RECOVERY_SECRET`, `SMTP_*`, `APP_URL`)
   - Updated `npm run setup` behaviour (generates the two new secrets automatically)
   - Step-by-step manual test checklist (matching the Testing section above)
