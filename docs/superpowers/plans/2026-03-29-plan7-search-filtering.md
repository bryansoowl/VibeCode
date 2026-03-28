# Plan 7: Search + Filtering Improvements — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add full-text in-memory search (sender/subject/snippet), date range filters (presets + custom picker), and multi-account filter pills to the InboxMY email list.

**Architecture:** Backend extends `GET /api/emails` with `dateFrom`, `dateTo`, `accountIds` params and splits into two execution paths: a fast SQL-only path (no search) and an in-memory decrypt-and-filter path (when `search` is present). Frontend adds a new date filter row and account pills to the email list header.

**Tech Stack:** TypeScript/Express/better-sqlite3 (backend), Vanilla JS + HTML (frontend), Vitest + supertest (tests)

**Spec:** `docs/superpowers/specs/2026-03-29-search-filtering-design.md`

---

## File Map

| File | Change |
|---|---|
| `inboxmy-backend/tests/helpers/auth.ts` | Add `dataKey: Buffer` to `TestUser` + `createTestUser` return |
| `inboxmy-backend/tests/routes/emails.test.ts` | Add 15 new test cases across 3 new `describe` blocks |
| `inboxmy-backend/src/routes/emails.ts` | Extend zod schema; refactor `GET /` handler into fast path + in-memory search path |
| `InboxMy.html` | Add date filter row (HTML + CSS); add account pills container to `el-filters` row |
| `frontend/app.js` | New state vars; update `fetchEmails`, `buildEmailParams`, `setFolder`, `renderAccounts`; add `setDatePreset`, `toggleCustomDatePicker`, `applyCustomDates`, `renderAccountPills`, `toggleAccountPill`, `clearFilters`, `updateClearFiltersVisibility` |

---

## Task 1: Extend auth test helper to expose user's dataKey

Search tests need to encrypt seed data with the real user dataKey. Modify the helper to derive and return it.

**Files:**
- Modify: `inboxmy-backend/tests/helpers/auth.ts`

- [ ] **Step 1: Update `TestUser` interface and `createTestUser` to include `dataKey`**

Replace the entire file content:

```typescript
// tests/helpers/auth.ts
// Creates a user and returns a supertest agent with a valid session cookie.
import request from 'supertest'
import { app } from '../../src/server'
import { randomUUID } from 'crypto'
import { getDb } from '../../src/db'
import { deriveWrapKey, unwrapKey } from '../../src/crypto'

export interface TestUser {
  id: string
  email: string
  password: string
  agent: ReturnType<typeof request.agent>
  dataKey: Buffer
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

  // Derive the user's dataKey so tests can seed encrypted data with the correct key
  const db = getDb()
  const user = db.prepare(
    'SELECT pbkdf2_salt, data_key_enc FROM users WHERE email = ?'
  ).get(userEmail.toLowerCase()) as any
  const salt = Buffer.from(user.pbkdf2_salt, 'base64')
  const wrapKeyBuf = deriveWrapKey(password, salt)
  const dataKey = unwrapKey(user.data_key_enc, wrapKeyBuf)

  return { id: res.body.user.id, email: userEmail, password, agent, dataKey }
}
```

- [ ] **Step 2: Run existing tests to verify no regressions**

```bash
cd inboxmy-backend && npx vitest run tests/routes/emails.test.ts
```

Expected: All existing tests pass (the new `dataKey` field is additive).

- [ ] **Step 3: Commit**

```bash
git add inboxmy-backend/tests/helpers/auth.ts
git commit -m "test: expose dataKey from createTestUser helper"
```

---

## Task 2: Write failing tests — date filters and accountIds (SQL path)

Write all new tests first. They will fail until Task 3 implements the backend.

**Files:**
- Modify: `inboxmy-backend/tests/routes/emails.test.ts`

- [ ] **Step 1: Add `seedAccount` and update `seedEmail` helpers at the top of the test file**

Replace the block starting with `const KEY = Buffer.alloc(32)` through (and including) the closing `}` of the existing `function seedEmail(...)` with:

```typescript
const KEY = Buffer.alloc(32)

function seedAccount(userId: string): string {
  const db = getDb()
  const accountId = randomUUID()
  db.prepare(`
    INSERT INTO accounts (id, provider, email, token_enc, created_at, user_id)
    VALUES (?, 'gmail', ?, ?, ?, ?)
  `).run(accountId, `${accountId}@test.com`, encryptSystem('{}'), Date.now(), userId)
  return accountId
}

function seedEmail(userId: string, opts: {
  isRead?: boolean
  folder?: string
  tab?: string
  subject?: string
  snippet?: string
  sender?: string
  receivedAt?: number
  accountId?: string
  dataKey?: Buffer
}) {
  const db = getDb()
  const accountId = opts.accountId ?? seedAccount(userId)
  const emailId = randomUUID()
  const key = opts.dataKey ?? KEY

  db.prepare(`
    INSERT INTO emails (id, account_id, subject_enc, snippet, sender, received_at, is_read, folder, tab)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    emailId,
    accountId,
    encrypt(opts.subject ?? 'Test Subject', key),
    opts.snippet ? encrypt(opts.snippet, key) : null,
    opts.sender ?? 'test@test.com',
    opts.receivedAt ?? Date.now(),
    opts.isRead ? 1 : 0,
    opts.folder ?? 'inbox',
    opts.tab ?? 'primary'
  )

  return { emailId, accountId }
}
```

- [ ] **Step 2: Run existing tests to verify the refactored helpers don't break anything**

```bash
cd inboxmy-backend && npx vitest run tests/routes/emails.test.ts
```

Expected: All existing tests pass.

- [ ] **Step 3: Add failing tests for `dateFrom` / `dateTo`**

Append a new `describe` block after the existing `describe('GET /api/emails/unread-count', ...)` block:

```typescript
describe('GET /api/emails — date filters', () => {
  // MYT midnight expressed as ms. Used to build known timestamps for seeded emails.
  function myt(dateStr: string, time: 'start' | 'end' = 'start'): number {
    const suffix = time === 'start' ? 'T00:00:00+08:00' : 'T23:59:59.999+08:00'
    return new Date(dateStr + suffix).getTime()
  }

  it('dateFrom returns only emails on or after that date', async () => {
    const { agent, id: userId } = await createTestUser()
    const acctId = seedAccount(userId)
    seedEmail(userId, { accountId: acctId, receivedAt: myt('2026-03-10') })  // before
    seedEmail(userId, { accountId: acctId, receivedAt: myt('2026-03-20') })  // on boundary
    seedEmail(userId, { accountId: acctId, receivedAt: myt('2026-03-25') })  // after

    const res = await agent.get('/api/emails?dateFrom=2026-03-20')
    expect(res.status).toBe(200)
    expect(res.body.emails).toHaveLength(2)
    expect(res.body.total).toBe(2)
  })

  it('dateTo returns only emails on or before that date', async () => {
    const { agent, id: userId } = await createTestUser()
    const acctId = seedAccount(userId)
    seedEmail(userId, { accountId: acctId, receivedAt: myt('2026-03-10') })  // before boundary
    seedEmail(userId, { accountId: acctId, receivedAt: myt('2026-03-20', 'end') })  // on boundary
    seedEmail(userId, { accountId: acctId, receivedAt: myt('2026-03-25') })  // after

    const res = await agent.get('/api/emails?dateTo=2026-03-20')
    expect(res.status).toBe(200)
    expect(res.body.emails).toHaveLength(2)
  })

  it('dateFrom + dateTo combined return emails within the range only', async () => {
    const { agent, id: userId } = await createTestUser()
    const acctId = seedAccount(userId)
    seedEmail(userId, { accountId: acctId, receivedAt: myt('2026-03-01') })   // outside
    seedEmail(userId, { accountId: acctId, receivedAt: myt('2026-03-10') })   // inside
    seedEmail(userId, { accountId: acctId, receivedAt: myt('2026-03-15') })   // inside
    seedEmail(userId, { accountId: acctId, receivedAt: myt('2026-03-31') })   // outside

    const res = await agent.get('/api/emails?dateFrom=2026-03-05&dateTo=2026-03-20')
    expect(res.status).toBe(200)
    expect(res.body.emails).toHaveLength(2)
  })

  it('swaps dateFrom and dateTo silently when inverted', async () => {
    const { agent, id: userId } = await createTestUser()
    const acctId = seedAccount(userId)
    seedEmail(userId, { accountId: acctId, receivedAt: myt('2026-03-10') })  // in range
    seedEmail(userId, { accountId: acctId, receivedAt: myt('2026-03-25') })  // outside

    // dateFrom > dateTo — backend should swap them
    const res = await agent.get('/api/emails?dateFrom=2026-03-20&dateTo=2026-03-05')
    expect(res.status).toBe(200)
    expect(res.body.emails).toHaveLength(1)
  })

  it('returns 400 for invalid dateFrom format', async () => {
    const { agent } = await createTestUser()
    const res = await agent.get('/api/emails?dateFrom=not-a-date')
    expect(res.status).toBe(400)
  })
})

describe('GET /api/emails — accountIds filter', () => {
  it('accountIds with single ID returns only emails from that account', async () => {
    const { agent, id: userId } = await createTestUser()
    const acct1 = seedAccount(userId)
    const acct2 = seedAccount(userId)
    seedEmail(userId, { accountId: acct1 })
    seedEmail(userId, { accountId: acct2 })

    const res = await agent.get(`/api/emails?accountIds=${acct1}`)
    expect(res.status).toBe(200)
    expect(res.body.emails).toHaveLength(1)
    expect(res.body.emails[0].account_id).toBe(acct1)
  })

  it('accountIds with multiple IDs returns emails from any (OR logic)', async () => {
    const { agent, id: userId } = await createTestUser()
    const acct1 = seedAccount(userId)
    const acct2 = seedAccount(userId)
    const acct3 = seedAccount(userId)
    seedEmail(userId, { accountId: acct1 })
    seedEmail(userId, { accountId: acct2 })
    seedEmail(userId, { accountId: acct3 })

    const res = await agent.get(`/api/emails?accountIds=${acct1},${acct2}`)
    expect(res.status).toBe(200)
    expect(res.body.emails).toHaveLength(2)
    const ids = res.body.emails.map((e: any) => e.account_id)
    expect(ids).toContain(acct1)
    expect(ids).toContain(acct2)
    expect(ids).not.toContain(acct3)
  })

  it('accountIds containing another user\'s account ID returns no results', async () => {
    const { agent } = await createTestUser()
    const { id: userId2 } = await createTestUser()
    const otherAcct = seedAccount(userId2)
    seedEmail(userId2, { accountId: otherAcct })

    const res = await agent.get(`/api/emails?accountIds=${otherAcct}`)
    expect(res.status).toBe(200)
    expect(res.body.emails).toHaveLength(0)
  })

  it('accountIds with all-empty entries (e.g. ",,,") is treated as absent', async () => {
    const { agent, id: userId } = await createTestUser()
    seedEmail(userId, {})
    seedEmail(userId, {})

    const res = await agent.get('/api/emails?accountIds=,,,')
    expect(res.status).toBe(200)
    expect(res.body.emails).toHaveLength(2)
  })
})
```

- [ ] **Step 4: Run to confirm tests fail (backend not yet updated)**

```bash
cd inboxmy-backend && npx vitest run tests/routes/emails.test.ts
```

Expected: New tests fail (`dateFrom`/`dateTo`/`accountIds` params are currently ignored).

- [ ] **Step 5: Commit the failing tests**

```bash
git add inboxmy-backend/tests/routes/emails.test.ts
git commit -m "test(emails): add failing tests for dateFrom/dateTo/accountIds filters"
```

---

## Task 3: Implement backend — date and accountIds SQL filters

**Files:**
- Modify: `inboxmy-backend/src/routes/emails.ts`

- [ ] **Step 1: Replace the `GET /` handler and the file preamble above it**

Replace everything from the first line of the file (`// src/routes/emails.ts`) through the closing `})` of `emailsRouter.get('/', ...)` — that is, through the `})` that closes the handler. All routes that follow (`/unread-count`, `/:id`, `DELETE /`, `PATCH /:id/read`) must be kept unchanged.

Replacement code:

```typescript
// src/routes/emails.ts
import { Router, type Request, type Response } from 'express'
import { getDb } from '../db'
import { decrypt } from '../crypto'
import { z } from 'zod'

export const emailsRouter = Router()

const listQuery = z.object({
  category:   z.enum(['bill', 'govt', 'receipt', 'work']).optional(),
  folder:     z.enum(['inbox', 'sent', 'spam', 'draft', 'trash']).optional(),
  tab:        z.enum(['primary', 'promotions', 'social', 'updates', 'forums']).optional(),
  important:  z.enum(['1', 'true']).optional(),
  accountId:  z.string().optional(),
  accountIds: z.string().optional(),
  limit:      z.coerce.number().min(1).max(100).default(50),
  offset:     z.coerce.number().min(0).default(0),
  search:     z.string().max(100).optional(),
  unread:     z.enum(['1', 'true']).optional(),
  dateFrom:   z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dateTo:     z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
})

const EMAIL_SELECT = `SELECT e.id, e.account_id, e.thread_id, e.subject_enc,
  e.sender, e.sender_name, e.received_at, e.is_read, e.category,
  e.snippet, e.raw_size
  FROM emails e
  JOIN accounts a ON a.id = e.account_id`

emailsRouter.get('/', (req: Request, res: Response) => {
  const parsed = listQuery.safeParse(req.query)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })

  const { category, folder, tab, important, accountId, accountIds, limit, offset, search, unread, dateFrom, dateTo } = parsed.data
  const user = (req as any).user
  const db = getDb()

  // accountIds (multi) takes precedence over accountId (single)
  const idList = accountIds
    ? accountIds.split(',').filter(s => s.trim().length > 0).slice(0, 6)
    : accountId ? [accountId] : []

  // Convert YYYY-MM-DD to milliseconds (MYT = UTC+8)
  let dateFromMs: number | null = null
  let dateToMs: number | null = null
  if (dateFrom) dateFromMs = new Date(`${dateFrom}T00:00:00+08:00`).getTime()
  if (dateTo)   dateToMs   = new Date(`${dateTo}T23:59:59.999+08:00`).getTime()
  // Swap silently if inverted (user intent is clear)
  if (dateFromMs !== null && dateToMs !== null && dateToMs < dateFromMs) {
    ;[dateFromMs, dateToMs] = [dateToMs, dateFromMs]
  }

  // Build shared WHERE clause
  const conditions: string[] = ['a.user_id = ?']
  const params: any[] = [user.id]

  if (folder)    { conditions.push('e.folder = ?');      params.push(folder) }
  if (tab)       { conditions.push('e.tab = ?');         params.push(tab) }
  if (important) { conditions.push('e.is_important = 1') }
  if (category)  { conditions.push('e.category = ?');    params.push(category) }
  if (idList.length > 0) {
    conditions.push(`e.account_id IN (${idList.map(() => '?').join(',')})`)
    params.push(...idList)
  }
  if (unread)              { conditions.push('e.is_read = 0') }
  if (dateFromMs !== null) { conditions.push('e.received_at >= ?'); params.push(dateFromMs) }
  if (dateToMs !== null)   { conditions.push('e.received_at <= ?'); params.push(dateToMs) }
  // Inbox always excludes Promotions tab unless an explicit tab filter is set
  if (folder === 'inbox' && !tab) { conditions.push("e.tab != 'promotions'") }

  const WHERE = conditions.join(' AND ')

  try {
    if (!search) {
      // Fast path: SQL pagination, no decryption overhead
      const rows = db.prepare(`${EMAIL_SELECT} WHERE ${WHERE} ORDER BY e.received_at DESC LIMIT ? OFFSET ?`).all(...params, limit, offset) as any[]
      const { total } = db.prepare(`SELECT COUNT(*) as total FROM emails e JOIN accounts a ON a.id = e.account_id WHERE ${WHERE}`).get(...params) as any
      const emails = rows.map(r => ({
        ...r,
        subject: decrypt(r.subject_enc, user.dataKey),
        snippet: r.snippet ? decrypt(r.snippet, user.dataKey) : null,
        subject_enc: undefined,
      }))
      return res.json({ emails, limit, offset, total })
    }

    // In-memory search path: fetch up to 2000 candidates, decrypt, filter
    // The SQL query intentionally has NO search filter — only the in-memory pass does.
    // NOTE: `total` will reflect at most 2000 when the candidate set is capped.
    const candidates = db.prepare(`${EMAIL_SELECT} WHERE ${WHERE} ORDER BY e.received_at DESC LIMIT 2000`).all(...params) as any[]

    const q = search.toLowerCase()
    const filtered: any[] = []
    for (const r of candidates) {
      try {
        const subject = decrypt(r.subject_enc, user.dataKey)
        const snippet = r.snippet ? decrypt(r.snippet, user.dataKey) : null
        if (
          r.sender.toLowerCase().includes(q) ||
          subject.toLowerCase().includes(q) ||
          (snippet ?? '').toLowerCase().includes(q)
        ) {
          filtered.push({ ...r, subject, snippet, subject_enc: undefined })
        }
      } catch {
        // Skip rows that fail decryption rather than aborting the whole response
      }
    }

    const total = filtered.length
    const emails = filtered.slice(offset, offset + limit)
    return res.json({ emails, limit, offset, total })
  } catch {
    return res.status(500).json({ error: 'Failed to process emails' })
  }
})
```

Keep everything after this handler (the `/unread-count`, `/:id`, `DELETE /`, `PATCH /:id/read` routes) unchanged.

- [ ] **Step 2: Compile the backend**

```bash
cd inboxmy-backend && npx tsc --noEmit
```

Expected: No TypeScript errors.

- [ ] **Step 3: Run the date + accountIds tests**

```bash
cd inboxmy-backend && npx vitest run tests/routes/emails.test.ts
```

Expected: All previously failing date/accountIds tests now pass. All prior tests still pass.

- [ ] **Step 4: Commit**

```bash
git add inboxmy-backend/src/routes/emails.ts
git commit -m "feat(api): add dateFrom/dateTo/accountIds filters to GET /api/emails"
```

---

## Task 4: Write failing tests — in-memory search

**Files:**
- Modify: `inboxmy-backend/tests/routes/emails.test.ts`

- [ ] **Step 1: Append in-memory search test block to the emails test file**

Add after the `accountIds` describe block:

```typescript
describe('GET /api/emails — in-memory search', () => {
  it('search matches on sender field', async () => {
    const { agent, id: userId, dataKey } = await createTestUser()
    const acctId = seedAccount(userId)
    seedEmail(userId, { accountId: acctId, sender: 'bills@tnb.com.my', dataKey })
    seedEmail(userId, { accountId: acctId, sender: 'noreply@shopee.com', dataKey })

    const res = await agent.get('/api/emails?search=tnb')
    expect(res.status).toBe(200)
    expect(res.body.emails).toHaveLength(1)
    expect(res.body.emails[0].sender).toBe('bills@tnb.com.my')
  })

  it('search matches on decrypted subject', async () => {
    const { agent, id: userId, dataKey } = await createTestUser()
    const acctId = seedAccount(userId)
    seedEmail(userId, { accountId: acctId, subject: 'Your TNB bill is ready', dataKey })
    seedEmail(userId, { accountId: acctId, subject: 'Welcome to Unifi', dataKey })

    const res = await agent.get('/api/emails?search=TNB+bill')
    expect(res.status).toBe(200)
    expect(res.body.emails).toHaveLength(1)
    expect(res.body.emails[0].subject).toBe('Your TNB bill is ready')
  })

  it('search matches on decrypted snippet', async () => {
    const { agent, id: userId, dataKey } = await createTestUser()
    const acctId = seedAccount(userId)
    seedEmail(userId, { accountId: acctId, subject: 'Invoice', snippet: 'Amount due: RM 45.60', dataKey })
    seedEmail(userId, { accountId: acctId, subject: 'Newsletter', snippet: 'Check out our latest deals', dataKey })

    const res = await agent.get('/api/emails?search=RM+45')
    expect(res.status).toBe(200)
    expect(res.body.emails).toHaveLength(1)
    expect(res.body.emails[0].snippet).toBe('Amount due: RM 45.60')
  })

  it('search is case-insensitive', async () => {
    const { agent, id: userId, dataKey } = await createTestUser()
    const acctId = seedAccount(userId)
    seedEmail(userId, { accountId: acctId, subject: 'Your LHDN Notice', dataKey })

    const res = await agent.get('/api/emails?search=lhdn')
    expect(res.status).toBe(200)
    expect(res.body.emails).toHaveLength(1)
  })

  it('search combined with dateFrom narrows results', async () => {
    const { agent, id: userId, dataKey } = await createTestUser()
    const acctId = seedAccount(userId)
    // Both match search, but only one is within date range
    seedEmail(userId, { accountId: acctId, subject: 'TNB March bill', dataKey, receivedAt: new Date('2026-03-15T10:00:00+08:00').getTime() })
    seedEmail(userId, { accountId: acctId, subject: 'TNB January bill', dataKey, receivedAt: new Date('2026-01-15T10:00:00+08:00').getTime() })

    const res = await agent.get('/api/emails?search=TNB&dateFrom=2026-03-01')
    expect(res.status).toBe(200)
    expect(res.body.emails).toHaveLength(1)
    expect(res.body.emails[0].subject).toBe('TNB March bill')
  })

  it('search combined with accountIds returns matching emails in specified accounts only', async () => {
    const { agent, id: userId, dataKey } = await createTestUser()
    const acct1 = seedAccount(userId)
    const acct2 = seedAccount(userId)
    seedEmail(userId, { accountId: acct1, subject: 'Unifi invoice', dataKey })
    seedEmail(userId, { accountId: acct2, subject: 'Unifi invoice', dataKey })  // same subject, different account

    const res = await agent.get(`/api/emails?search=Unifi&accountIds=${acct1}`)
    expect(res.status).toBe(200)
    expect(res.body.emails).toHaveLength(1)
    expect(res.body.emails[0].account_id).toBe(acct1)
  })

  it('total reflects the in-memory filtered count, not the raw SQL count', async () => {
    const { agent, id: userId, dataKey } = await createTestUser()
    const acctId = seedAccount(userId)
    // 5 emails match search, 3 do not
    for (let i = 0; i < 5; i++) {
      seedEmail(userId, { accountId: acctId, subject: 'Celcom bill', dataKey })
    }
    for (let i = 0; i < 3; i++) {
      seedEmail(userId, { accountId: acctId, subject: 'Newsletter', dataKey })
    }

    const res = await agent.get('/api/emails?search=Celcom&limit=2&offset=0')
    expect(res.status).toBe(200)
    expect(res.body.total).toBe(5)    // only matching emails, not all 8
    expect(res.body.emails).toHaveLength(2)  // respects limit
  })

  it('in-memory pagination: offset slices the filtered set', async () => {
    const { agent, id: userId, dataKey } = await createTestUser()
    const acctId = seedAccount(userId)
    for (let i = 1; i <= 5; i++) {
      seedEmail(userId, { accountId: acctId, subject: `Maxis bill ${i}`, dataKey, receivedAt: Date.now() - i * 1000 })
    }

    const page1 = await agent.get('/api/emails?search=Maxis&limit=3&offset=0')
    const page2 = await agent.get('/api/emails?search=Maxis&limit=3&offset=3')

    expect(page1.body.emails).toHaveLength(3)
    expect(page2.body.emails).toHaveLength(2)
    expect(page1.body.total).toBe(5)
    expect(page2.body.total).toBe(5)

    // No overlap between pages
    const p1ids = page1.body.emails.map((e: any) => e.id)
    const p2ids = page2.body.emails.map((e: any) => e.id)
    expect(p1ids.some((id: string) => p2ids.includes(id))).toBe(false)
  })
})
```

- [ ] **Step 2: Run to confirm new tests fail**

```bash
cd inboxmy-backend && npx vitest run tests/routes/emails.test.ts
```

Expected: New search tests fail (the existing code uses `AND e.sender LIKE ?` which doesn't match subject/snippet, and the response subjects are encrypted in current data).

- [ ] **Step 3: Commit failing tests**

```bash
git add inboxmy-backend/tests/routes/emails.test.ts
git commit -m "test(emails): add failing tests for in-memory search path"
```

---

## Task 5: Verify in-memory search tests pass

The Task 3 implementation already includes the in-memory search path. Run the new tests to confirm.

- [ ] **Step 1: Run all email tests**

```bash
cd inboxmy-backend && npx vitest run tests/routes/emails.test.ts
```

Expected: All tests pass, including the new in-memory search tests.

> **If any search tests fail:** The most likely cause is the `sender` field — the in-memory search tests use a custom `sender` value but `seedEmail` defaults to `'test@test.com'`. Verify that:
> 1. The `sender` opt is passed through to the INSERT in `seedEmail`
> 2. The in-memory search checks `r.sender` (not `r.sender_name`)
> 3. The `subject_enc` column contains data encrypted with `opts.dataKey` (not `KEY = Buffer.alloc(32)`) when `dataKey` is passed

- [ ] **Step 2: Run the full backend test suite**

```bash
cd inboxmy-backend && npx vitest run
```

Expected: All 110+ tests pass. Note the new count in the output.

- [ ] **Step 3: Commit**

```bash
git add inboxmy-backend/tests/routes/emails.test.ts inboxmy-backend/src/routes/emails.ts
git commit -m "feat(api): in-memory search on decrypted subject/snippet via GET /api/emails"
```

(This commit may be empty if Task 3 and 5 share no new file changes — that's fine, skip it.)

---

## Task 6: Frontend — state, fetchEmails, buildEmailParams, setFolder

Wire the new backend params into the frontend state machine. No visual changes yet.

**Files:**
- Modify: `frontend/app.js`

- [ ] **Step 1: Add three new state variables after the existing state block (around line 160)**

Find this block:
```js
let currentFolder = 'inbox';
let currentFilter = 'all';
let currentSearch = '';
let currentAccountId = null;
```

Add three lines immediately after:
```js
let currentDateFrom   = null;   // 'YYYY-MM-DD' or null
let currentDateTo     = null;   // 'YYYY-MM-DD' or null
let currentAccountIds = [];     // [] = all accounts
```

- [ ] **Step 2: Update `fetchEmails` to accept and forward `accountIds`, `dateFrom`, `dateTo`**

Find the `async function fetchEmails(...)` definition (around line 112). The current signature is:
```js
async function fetchEmails({ category, folder, tab, important, accountId, search, unread, limit = 50, offset = 0 } = {}) {
```

Replace the entire function with:
```js
async function fetchEmails({ category, folder, tab, important, accountId, accountIds, search, unread, dateFrom, dateTo, limit = 50, offset = 0 } = {}) {
  const p = new URLSearchParams();
  if (category)   p.set('category', category);
  if (folder)     p.set('folder', folder);
  if (tab)        p.set('tab', tab);
  if (important)  p.set('important', '1');
  if (accountId)  p.set('accountId', accountId);
  if (accountIds) p.set('accountIds', accountIds);
  if (search)     p.set('search', search);
  if (unread)     p.set('unread', '1');
  if (dateFrom)   p.set('dateFrom', dateFrom);
  if (dateTo)     p.set('dateTo', dateTo);
  p.set('limit', limit);
  p.set('offset', offset);
  return apiFetch('/api/emails?' + p);
}
```

- [ ] **Step 3: Update `buildEmailParams` to use the new state and enforce accountId/accountIds mutual exclusion**

Find the `function buildEmailParams(offset = 0)` function and replace it:
```js
function buildEmailParams(offset = 0) {
  const folderParams = FOLDER_PARAMS[currentFolder] || { folder: 'inbox' };
  const params = {
    ...folderParams,
    search: currentSearch || undefined,
    unread: currentFilter === 'unread' || undefined,
    limit: 50,
    offset,
  };
  // accountIds takes precedence over accountId (sidebar single-account filter)
  if (currentAccountIds.length > 0) {
    params.accountIds = currentAccountIds.join(',');
  } else if (currentAccountId) {
    params.accountId = currentAccountId;
  }
  if (currentDateFrom) params.dateFrom = currentDateFrom;
  if (currentDateTo)   params.dateTo   = currentDateTo;
  return params;
}
```

- [ ] **Step 4: Update `setFolder` to reset date filters but preserve account pill selection**

Find `function setFolder(f, el)` and add these lines at the very top of the function body (before any existing code):
```js
  currentDateFrom = null;
  currentDateTo   = null;
  // currentAccountIds intentionally NOT reset — account pills persist across folders
```

Also add these lines to reset the date filter UI state (add inside `function setFolder`, after `document.getElementById('filter-all').classList.add('active');`):
```js
  document.querySelectorAll('.el-date-pill').forEach(i => i.classList.remove('active'));
  const customPanel = document.getElementById('custom-date-panel');
  if (customPanel) customPanel.style.display = 'none';
  const customPill = document.getElementById('date-custom');
  if (customPill) customPill.textContent = 'Custom ▾';
  updateClearFiltersVisibility();
```

- [ ] **Step 5: Add `updateClearFiltersVisibility` and `clearFilters` functions**

Append these two functions after `filterEmails`:
```js
function updateClearFiltersVisibility() {
  const link = document.getElementById('clear-filters-link');
  if (!link) return;
  const active = currentDateFrom || currentDateTo || currentAccountIds.length > 0;
  link.style.display = active ? '' : 'none';
}

function clearFilters() {
  currentDateFrom   = null;
  currentDateTo     = null;
  currentAccountIds = [];
  document.querySelectorAll('.el-date-pill').forEach(i => i.classList.remove('active'));
  const customPanel = document.getElementById('custom-date-panel');
  if (customPanel) customPanel.style.display = 'none';
  const customPill = document.getElementById('date-custom');
  if (customPill) customPill.textContent = 'Custom ▾';
  renderAccountPills();
  updateClearFiltersVisibility();
  loadEmails(true);
}
```

- [ ] **Step 6: Commit**

```bash
git add frontend/app.js
git commit -m "feat(frontend): add date/accountIds state and update buildEmailParams"
```

---

## Task 7: Frontend — date filter bar (HTML + CSS + JS)

Add the date preset row with custom picker to `InboxMy.html` and the JS functions to drive it.

**Files:**
- Modify: `InboxMy.html`
- Modify: `frontend/app.js`

- [ ] **Step 1: Add CSS for the date filter row**

In `InboxMy.html`, find the existing `.el-filters` CSS rule (around line 70):
```css
.el-filters{display:flex;gap:4px;padding:8px 10px;border-bottom:1px solid var(--border);flex-shrink:0;overflow-x:auto}
```

After this block, add:
```css
.el-dates{display:flex;align-items:center;gap:4px;padding:6px 10px 2px;flex-shrink:0;flex-wrap:wrap;position:relative}
.el-date-pill{padding:4px 11px;border-radius:999px;font-size:12px;font-weight:600;cursor:pointer;border:1px solid transparent;white-space:nowrap;transition:all .15s;color:var(--ink3);background:transparent}
.el-date-pill.active{background:#fff;color:var(--ink);border-color:var(--border);box-shadow:0 1px 3px rgba(26,22,18,.06)}
.el-date-pill:hover:not(.active){background:var(--cream3)}
.clear-filters-link{margin-left:auto;font-size:11px;color:var(--ink4);cursor:pointer;padding:4px 6px;white-space:nowrap}
.clear-filters-link:hover{color:var(--coral)}
.custom-date-panel{position:absolute;top:100%;left:10px;z-index:100;background:#fff;border:1px solid var(--border);border-radius:10px;padding:10px;display:flex;align-items:center;gap:8px;box-shadow:0 4px 16px rgba(26,22,18,.12)}
.custom-date-panel input[type=date]{padding:5px 8px;border:1px solid var(--border);border-radius:6px;font-size:12px;font-family:var(--sans);color:var(--ink);background:var(--cream)}
.custom-date-panel button{padding:5px 12px;border-radius:6px;background:var(--coral);color:#fff;border:none;font-size:12px;font-family:var(--sans);cursor:pointer}
```

- [ ] **Step 2: Add date filter row HTML**

In `InboxMy.html`, find the `<!-- EMAIL LIST -->` section. The `el-filters` div currently looks like:
```html
    <div class="el-filters">
      <div class="el-filter active" onclick="setFilter('all', this)" id="filter-all">All</div>
```

Insert the following block **immediately before** the `<div class="el-filters">` line:
```html
    <!-- DATE FILTER ROW -->
    <div class="el-dates" id="el-dates">
      <div class="el-date-pill" id="date-today"   onclick="setDatePreset('today', this)">Today</div>
      <div class="el-date-pill" id="date-week"    onclick="setDatePreset('week', this)">This week</div>
      <div class="el-date-pill" id="date-month"   onclick="setDatePreset('month', this)">This month</div>
      <div class="el-date-pill" id="date-3month"  onclick="setDatePreset('3month', this)">Last 3 months</div>
      <div class="el-date-pill" id="date-custom"  onclick="toggleCustomDatePicker()">Custom ▾</div>
      <span class="clear-filters-link" id="clear-filters-link" onclick="clearFilters()" style="display:none">× Clear filters</span>
      <div class="custom-date-panel" id="custom-date-panel" style="display:none">
        <input type="date" id="date-from-input">
        <span style="font-size:12px;color:var(--ink4)">to</span>
        <input type="date" id="date-to-input">
        <button onclick="applyCustomDates()">Apply</button>
      </div>
    </div>
```

- [ ] **Step 3: Add `setDatePreset`, `toggleCustomDatePicker`, `applyCustomDates` to `app.js`**

Append these functions after `clearFilters`:

```js
function setDatePreset(preset, el) {
  // Clicking an active preset clears it
  if (el.classList.contains('active')) {
    currentDateFrom = null;
    currentDateTo   = null;
    el.classList.remove('active');
    updateClearFiltersVisibility();
    loadEmails(true);
    return;
  }
  // Deactivate all date pills (only one preset at a time)
  document.querySelectorAll('.el-date-pill').forEach(i => i.classList.remove('active'));
  el.classList.add('active');

  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  const today = fmt(now);

  if (preset === 'today') {
    currentDateFrom = today;
    currentDateTo   = today;
  } else if (preset === 'week') {
    const d = new Date(now); d.setDate(d.getDate() - 7);
    currentDateFrom = fmt(d);
    currentDateTo   = today;
  } else if (preset === 'month') {
    const d = new Date(now); d.setMonth(d.getMonth() - 1);
    currentDateFrom = fmt(d);
    currentDateTo   = today;
  } else if (preset === '3month') {
    const d = new Date(now); d.setMonth(d.getMonth() - 3);
    currentDateFrom = fmt(d);
    currentDateTo   = today;
  }

  const customPanel = document.getElementById('custom-date-panel');
  if (customPanel) customPanel.style.display = 'none';
  const customPill = document.getElementById('date-custom');
  if (customPill) customPill.textContent = 'Custom ▾';

  updateClearFiltersVisibility();
  loadEmails(true);
}

function toggleCustomDatePicker() {
  const panel = document.getElementById('custom-date-panel');
  const pill  = document.getElementById('date-custom');
  if (!panel) return;

  const isOpen = panel.style.display !== 'none';

  // If open AND a custom range is active, clicking '✕' clears it
  if (isOpen && (currentDateFrom || currentDateTo)) {
    currentDateFrom = null;
    currentDateTo   = null;
    panel.style.display = 'none';
    if (pill) pill.textContent = 'Custom ▾';
    document.querySelectorAll('.el-date-pill').forEach(i => i.classList.remove('active'));
    updateClearFiltersVisibility();
    loadEmails(true);
    return;
  }

  panel.style.display = isOpen ? 'none' : '';
}

function applyCustomDates() {
  const fromVal = document.getElementById('date-from-input')?.value;
  const toVal   = document.getElementById('date-to-input')?.value;

  currentDateFrom = fromVal || null;
  currentDateTo   = toVal   || null;

  const panel = document.getElementById('custom-date-panel');
  const pill  = document.getElementById('date-custom');

  document.querySelectorAll('.el-date-pill').forEach(i => i.classList.remove('active'));

  if (currentDateFrom || currentDateTo) {
    if (pill) { pill.textContent = 'Custom ✕'; pill.classList.add('active'); }
  } else {
    if (pill) pill.textContent = 'Custom ▾';
  }

  if (panel) panel.style.display = 'none';
  updateClearFiltersVisibility();
  loadEmails(true);
}
```

- [ ] **Step 4: Smoke test in the browser**

Start the app (`npm start` from the project root) and verify:
- Date preset pills appear between the search box area and the `All / Unread / Bills` row
- Clicking "Today" highlights the pill and reloads the email list with `dateFrom=dateTo=today`
- Clicking "Today" again deactivates it
- Clicking "Custom ▾" opens the date input panel; filling in dates and clicking Apply reloads the list
- "Custom ✕" appears when a custom range is set; clicking it clears the range
- Switching sidebar folders resets the date pills

- [ ] **Step 5: Commit**

```bash
git add InboxMy.html frontend/app.js
git commit -m "feat(ui): add date filter row with presets and custom date picker"
```

---

## Task 8: Frontend — account filter pills

Render one pill per connected account in the `el-filters` row. Toggle logic updates `currentAccountIds`.

**Files:**
- Modify: `InboxMy.html`
- Modify: `frontend/app.js`

- [ ] **Step 1: Add CSS for account pills container**

In `InboxMy.html`, after the `.el-filters` CSS block, add:
```css
.el-acct-pills{display:flex;gap:4px;margin-left:auto;flex-shrink:0}
```

- [ ] **Step 2: Add account pills container to the `el-filters` row**

Find the `<div class="el-filters">` HTML block and add a container div at the end, before the closing `</div>`:
```html
      <div class="el-acct-pills" id="el-acct-pills"></div>
```

The full `el-filters` block should now look like:
```html
    <div class="el-filters">
      <div class="el-filter active" onclick="setFilter('all', this)" id="filter-all">All</div>
      <div class="el-filter" onclick="setFilter('unread', this)">Unread</div>
      <div class="el-filter" onclick="setFilter('bills', this)">Bills</div>
      <div class="el-filter" onclick="setFilter('govt', this)">Govt</div>
      <div class="el-filter" onclick="setFilter('receipts', this)">Receipts</div>
      <div class="el-acct-pills" id="el-acct-pills"></div>
    </div>
```

- [ ] **Step 3: Add `renderAccountPills` and `toggleAccountPill` functions to `app.js`**

Append after `applyCustomDates`:
```js
function renderAccountPills() {
  const container = document.getElementById('el-acct-pills');
  if (!container) return;
  container.innerHTML = '';

  // Hide pills when only 0 or 1 account is connected (no value in filtering)
  if (accountsData.length <= 1) return;

  accountsData.forEach(acct => {
    const label = (acct.label || acct.email || '').slice(0, 20);
    const isActive = currentAccountIds.includes(acct.id);

    const pill = document.createElement('div');
    pill.className = 'el-filter' + (isActive ? ' active' : '');
    pill.title = acct.email || '';
    pill.textContent = label;
    pill.onclick = () => toggleAccountPill(acct.id, pill);
    container.appendChild(pill);
  });
}

function toggleAccountPill(accountId, el) {
  const idx = currentAccountIds.indexOf(accountId);
  if (idx === -1) {
    currentAccountIds.push(accountId);
    el.classList.add('active');
  } else {
    currentAccountIds.splice(idx, 1);
    el.classList.remove('active');
  }
  updateClearFiltersVisibility();
  loadEmails(true);
}
```

- [ ] **Step 4: Call `renderAccountPills()` from `renderAccounts()`**

Find `function renderAccounts()` in `app.js`. At the very end of the function body (after the `connectDiv` visibility check), add:
```js
  renderAccountPills();
```

- [ ] **Step 5: Smoke test in the browser**

Connect two or more accounts, then verify:
- Account pills appear on the right side of the `All / Unread / Bills` row
- Clicking a pill highlights it and reloads the list filtered to that account
- Clicking a second pill adds it (OR logic — both accounts' emails appear)
- Clicking an active pill deactivates it
- "× Clear filters" appears when any pill is active; clicking it deactivates all pills
- With only 1 account, no pills are rendered
- Switching sidebar folders keeps the pill selection active

- [ ] **Step 6: Commit**

```bash
git add InboxMy.html frontend/app.js
git commit -m "feat(ui): add multi-account filter pills to email list"
```

---

## Task 9: Full regression pass

- [ ] **Step 1: Run the complete backend test suite**

```bash
cd inboxmy-backend && npx vitest run
```

Expected: All tests pass. Note the final count — should be at least 141 (126 prior + 15 new).

- [ ] **Step 2: Manual end-to-end smoke test**

Using the running app, verify the full feature set from the spec:

**Date filters:**
- [ ] `Today` preset shows only today's emails
- [ ] `This week` shows emails from the last 7 days
- [ ] `This month` shows emails from the last ~30 days
- [ ] `Last 3 months` shows emails from the last ~90 days
- [ ] `Custom ▾` opens date inputs; Apply loads the filtered list; `Custom ✕` clears it
- [ ] Switching folders (inbox → bills → inbox) resets date pills

**Search:**
- [ ] Typing in the search box filters by sender (existing behaviour preserved)
- [ ] Typing a subject keyword returns matching emails
- [ ] Typing a partial amount from a bill snippet returns the bill email

**Account pills (requires 2+ connected accounts):**
- [ ] Account pills appear only when 2+ accounts connected
- [ ] Selecting one account pills filters to that account
- [ ] Selecting two account pills returns emails from both (OR)
- [ ] Account pills stay active after switching folders
- [ ] `× Clear filters` resets account pills but leaves search box and unread toggle unchanged

- [ ] **Step 3: Final commit**

```bash
git add .
git commit -m "feat: Plan 7 — search/filtering improvements complete

- Full-text in-memory search across sender, subject, snippet
- Date range filters: today/week/month/3-month presets + custom picker
- Multi-account filter pills (OR logic) persisting across folder switches
- 15 new backend tests; all existing tests pass"
```
