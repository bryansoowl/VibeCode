# Plan 10: Compose / Reply / Forward + Move / Archive Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add email sending (compose, reply, forward) and folder management (move, archive, spam) to InboxMY, making it a fully read-write email client.

**Architecture:** A new `src/email/send.ts` module handles provider-specific sending (Gmail via googleapis, Outlook via Graph API fetch), called by a new `POST /api/emails/send` route that saves a local encrypted sent copy. Folder management is a single new `PATCH /api/emails/:id/folder` endpoint. Frontend wires up the existing compose modal HTML with real JS functions and adds an account picker, Forward button, and Archive sidebar entry.

**Tech Stack:** TypeScript + Express + better-sqlite3 (backend), Vanilla JS (frontend), googleapis (Gmail send), fetch (Outlook Graph API), node-forge (AES-256-GCM encryption), Vitest + supertest (tests)

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Modify | `inboxmy-backend/src/auth/gmail.ts` | Add `gmail.send` scope to `getAuthUrl()` |
| Modify | `inboxmy-backend/src/auth/outlook.ts` | Add `Mail.Send` to `SCOPES` constant |
| Modify | `inboxmy-backend/src/routes/emails.ts` | Add `'archive'` to `listQuery` enum, add `POST /send`, add `PATCH /:id/folder` |
| **Create** | `inboxmy-backend/src/email/send.ts` | `sendEmail()` abstraction: Gmail (MIME) + Outlook (Graph JSON) |
| **Create** | `inboxmy-backend/tests/email/send.test.ts` | Unit tests for `sendEmail()` |
| **Create** | `inboxmy-backend/tests/routes/send.test.ts` | Integration tests for `POST /api/emails/send` |
| Modify | `inboxmy-backend/tests/routes/emails.test.ts` | Append `PATCH /:id/folder` tests + `GET ?folder=archive` test |
| Modify | `frontend/app.js` | `openCompose()`, `closeCompose()`, `sendEmail()`, `moveEmail()`, `FOLDER_PARAMS`, `titles`, compose state |
| Modify | `frontend/index.html` | Wire buttons, add Forward, add account picker, add Archive sidebar, add Settings toggle |

---

## Task 1: Add OAuth send scopes

**Files:**
- Modify: `inboxmy-backend/src/auth/gmail.ts:21-24`
- Modify: `inboxmy-backend/src/auth/outlook.ts:9`

> Note: No test for this task — it's a config-only change. The send tests in Task 4 will exercise the downstream effects.

- [ ] **Step 1: Add `gmail.send` scope in `src/auth/gmail.ts`**

In `getAuthUrl()`, change:
```typescript
scope: [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/userinfo.email',
],
```
to:
```typescript
scope: [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/userinfo.email',
],
```

- [ ] **Step 2: Add `Mail.Send` scope in `src/auth/outlook.ts`**

Change line 9:
```typescript
const SCOPES = ['https://graph.microsoft.com/Mail.Read', 'User.Read', 'offline_access']
```
to:
```typescript
const SCOPES = ['https://graph.microsoft.com/Mail.Read', 'https://graph.microsoft.com/Mail.Send', 'User.Read', 'offline_access']
```

- [ ] **Step 3: Commit**

```bash
git add inboxmy-backend/src/auth/gmail.ts inboxmy-backend/src/auth/outlook.ts
git commit -m "feat(auth): add gmail.send and Mail.Send OAuth scopes"
```

---

## Task 2: Add `'archive'` to listQuery folder enum + PATCH /:id/folder tests (RED)

**Files:**
- Modify: `inboxmy-backend/src/routes/emails.ts:10-11`
- Modify: `inboxmy-backend/tests/routes/emails.test.ts` (append)

- [ ] **Step 1: Write the failing tests**

Append to `inboxmy-backend/tests/routes/emails.test.ts`:

```typescript
describe('PATCH /api/emails/:id/folder', () => {
  it('moves email to a valid folder', async () => {
    const { agent, id: userId, dataKey } = await createTestUser()
    const { emailId } = seedEmail(userId, { folder: 'inbox', dataKey })
    const res = await agent.patch(`/api/emails/${emailId}/folder`).send({ folder: 'archive' })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    const row = getDb().prepare('SELECT folder FROM emails WHERE id = ?').get(emailId) as any
    expect(row.folder).toBe('archive')
  })

  it('returns 400 for invalid folder value', async () => {
    const { agent, id: userId, dataKey } = await createTestUser()
    const { emailId } = seedEmail(userId, { folder: 'inbox', dataKey })
    const res = await agent.patch(`/api/emails/${emailId}/folder`).send({ folder: 'nope' })
    expect(res.status).toBe(400)
  })

  it('returns 404 when email belongs to another user', async () => {
    const { id: userId1 } = await createTestUser()
    const { emailId } = seedEmail(userId1, { folder: 'inbox' })
    const { agent: agent2 } = await createTestUser()
    const res = await agent2.patch(`/api/emails/${emailId}/folder`).send({ folder: 'trash' })
    expect(res.status).toBe(404)
  })

  it('returns 401 without session cookie', async () => {
    const res = await request(app).patch(`/api/emails/${randomUUID()}/folder`).send({ folder: 'trash' })
    expect(res.status).toBe(401)
  })
})

describe('GET /api/emails with folder=archive', () => {
  it('returns 200 and lists archived emails', async () => {
    const { agent, id: userId, dataKey } = await createTestUser()
    seedEmail(userId, { folder: 'archive', dataKey })
    const res = await agent.get('/api/emails?folder=archive')
    expect(res.status).toBe(200)
    expect(res.body.emails.length).toBeGreaterThanOrEqual(1)
  })
})
```

You'll also need to import `request` and `app` at the top if not already present. Check the existing imports in the file — add:
```typescript
import request from 'supertest'
import { app } from '../../src/server'
```
if they are missing.

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd inboxmy-backend && npx vitest run tests/routes/emails.test.ts
```

Expected: `PATCH /api/emails/:id/folder` and `folder=archive` describe blocks fail with 404 (no route) or 400 (enum error).

---

## Task 3: Implement PATCH /:id/folder + archive enum (GREEN)

**Files:**
- Modify: `inboxmy-backend/src/routes/emails.ts`

- [ ] **Step 1: Add `'archive'` to `listQuery` folder enum**

In `emails.ts`, change line 11 (the `listQuery` zod object — this is the GET list query schema, not the PATCH body):
```typescript
folder:     z.enum(['inbox', 'sent', 'spam', 'draft', 'trash']).optional(),
```
to:
```typescript
folder:     z.enum(['inbox', 'sent', 'spam', 'draft', 'trash', 'archive']).optional(),
```

> Note: Task 7 adds a **separate** `folderBody` zod object for the PATCH route — that is a different schema from `listQuery`. Do not confuse them.

- [ ] **Step 2: Add `PATCH /:id/folder` route**

Add this after the existing `PATCH /:id/read` handler (after line 174):

```typescript
const folderBody = z.object({
  folder: z.enum(['inbox', 'sent', 'spam', 'draft', 'trash', 'archive']),
})

emailsRouter.patch('/:id/folder', (req: Request, res: Response) => {
  const parsed = folderBody.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })

  const user = (req as any).user
  const db = getDb()
  const result = db.prepare(`
    UPDATE emails SET folder = ?
    WHERE id = ? AND account_id IN (SELECT id FROM accounts WHERE user_id = ?)
  `).run(parsed.data.folder, req.params.id, user.id)

  if (result.changes === 0) return res.status(404).json({ error: 'Email not found' })
  res.json({ ok: true })
})
```

- [ ] **Step 3: Run tests to verify they pass**

```bash
cd inboxmy-backend && npx vitest run tests/routes/emails.test.ts
```

Expected: all tests pass including the new PATCH and archive GET tests.

- [ ] **Step 4: Commit**

```bash
git add inboxmy-backend/src/routes/emails.ts inboxmy-backend/tests/routes/emails.test.ts
git commit -m "feat(api): add PATCH /emails/:id/folder and archive folder support"
```

---

## Task 4: Write send.ts unit tests (RED)

**Files:**
- **Create**: `inboxmy-backend/tests/email/send.test.ts`

- [ ] **Step 1: Create the failing test file**

Create `inboxmy-backend/tests/email/send.test.ts`:

```typescript
// tests/email/send.test.ts
import { vi, describe, it, expect, beforeEach, afterAll } from 'vitest'

// Mock auth modules before importing send
vi.mock('../../src/auth/gmail', () => ({
  getAuthedClient: vi.fn(),
}))
vi.mock('../../src/auth/outlook', () => ({
  getAccessToken: vi.fn(),
}))

// Mock googleapis — intercept the gmail client
const mockSend = vi.fn()
vi.mock('googleapis', () => ({
  google: {
    gmail: vi.fn().mockReturnValue({
      users: { messages: { send: mockSend } },
    }),
  },
}))

import { getAuthedClient } from '../../src/auth/gmail'
import { getAccessToken } from '../../src/auth/outlook'
import { getDb, closeDb } from '../../src/db'
import { encryptSystem } from '../../src/crypto'
import { randomUUID } from 'crypto'

afterAll(() => closeDb())

function seedAccount(provider: 'gmail' | 'outlook' = 'gmail') {
  const id = randomUUID()
  getDb().prepare(`
    INSERT INTO accounts (id, provider, email, token_enc, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, provider, `${id}@send-test.com`, encryptSystem('{}'), Date.now())
  return id
}

describe('sendEmail — Gmail', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mockSend.mockResolvedValue({ data: {} })
    vi.mocked(getAuthedClient).mockResolvedValue({} as any)
  })

  it('calls gmail.users.messages.send with a base64url raw payload', async () => {
    const accountId = seedAccount('gmail')
    const { sendEmail } = await import('../../src/email/send')
    await sendEmail(accountId, {
      to: 'dest@example.com',
      subject: 'Hello',
      bodyHtml: '<p>Hi there</p>',
    })
    expect(mockSend).toHaveBeenCalledOnce()
    const call = mockSend.mock.calls[0][0]
    expect(call.userId).toBe('me')
    expect(call.requestBody.raw).toBeDefined()

    // Decode and validate RFC 2822 headers
    const decoded = Buffer.from(call.requestBody.raw, 'base64url').toString('utf8')
    expect(decoded).toContain('From:')
    expect(decoded).toContain('To: dest@example.com')
    expect(decoded).toContain('Subject: Hello')
    expect(decoded).toContain('Content-Type: text/html')
  })

  it('propagates auth errors from getAuthedClient', async () => {
    const accountId = seedAccount('gmail')
    vi.mocked(getAuthedClient).mockRejectedValue(new Error('invalid_grant'))
    const { sendEmail } = await import('../../src/email/send')
    await expect(sendEmail(accountId, { to: 'a@b.com', subject: 'x', bodyHtml: 'y' }))
      .rejects.toThrow('invalid_grant')
  })
})

describe('sendEmail — Outlook', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(getAccessToken).mockResolvedValue('fake-token')
    global.fetch = vi.fn().mockResolvedValue({ ok: true } as any)
  })

  it('calls Graph API sendMail with correct JSON body', async () => {
    const accountId = seedAccount('outlook')
    const { sendEmail } = await import('../../src/email/send')
    await sendEmail(accountId, {
      to: 'dest@example.com',
      subject: 'Hello Outlook',
      bodyHtml: '<p>Hi</p>',
    })
    expect(global.fetch).toHaveBeenCalledOnce()
    const [url, opts] = (global.fetch as any).mock.calls[0]
    expect(url).toBe('https://graph.microsoft.com/v1.0/me/sendMail')
    const body = JSON.parse(opts.body)
    expect(body.message.subject).toBe('Hello Outlook')
    expect(body.message.toRecipients[0].emailAddress.address).toBe('dest@example.com')
    expect(body.message.body.content).toBe('<p>Hi</p>')
  })

  it('propagates re-auth errors from getAccessToken', async () => {
    const accountId = seedAccount('outlook')
    vi.mocked(getAccessToken).mockRejectedValue(
      new Error('Outlook account not found in MSAL cache — re-auth required')
    )
    const { sendEmail } = await import('../../src/email/send')
    await expect(sendEmail(accountId, { to: 'a@b.com', subject: 'x', bodyHtml: 'y' }))
      .rejects.toThrow('re-auth required')
  })

  it('throws when Graph API returns non-ok response', async () => {
    const accountId = seedAccount('outlook')
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => 'Forbidden',
    } as any)
    const { sendEmail } = await import('../../src/email/send')
    await expect(sendEmail(accountId, { to: 'a@b.com', subject: 'x', bodyHtml: 'y' }))
      .rejects.toThrow()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd inboxmy-backend && npx vitest run tests/email/send.test.ts
```

Expected: all tests fail with "Cannot find module '../../src/email/send'".

---

## Task 5: Implement `src/email/send.ts` (GREEN)

**Files:**
- **Create**: `inboxmy-backend/src/email/send.ts`

- [ ] **Step 1: Create the implementation file**

Create `inboxmy-backend/src/email/send.ts`:

```typescript
// src/email/send.ts
import { google } from 'googleapis'
import { getAuthedClient } from '../auth/gmail'
import { getAccessToken } from '../auth/outlook'
import { getDb } from '../db'

export async function sendEmail(
  accountId: string,
  opts: { to: string; subject: string; bodyHtml: string }
): Promise<void> {
  const db = getDb()
  const account = db.prepare('SELECT provider, email FROM accounts WHERE id = ?').get(accountId) as any
  if (!account) throw new Error(`Account ${accountId} not found`)

  if (account.provider === 'gmail') {
    const auth = await getAuthedClient(accountId)
    const gmail = google.gmail({ version: 'v1', auth })

    const mime = [
      `From: ${account.email}`,
      `To: ${opts.to}`,
      `Subject: ${opts.subject}`,
      'MIME-Version: 1.0',
      'Content-Type: text/html; charset=utf-8',
      '',
      opts.bodyHtml,
    ].join('\r\n')

    await gmail.users.messages.send({
      userId: 'me',
      requestBody: { raw: Buffer.from(mime).toString('base64url') },
    })
  } else {
    // Outlook via Graph API
    const token = await getAccessToken(accountId)
    const res = await fetch('https://graph.microsoft.com/v1.0/me/sendMail', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message: {
          subject: opts.subject,
          body: { contentType: 'HTML', content: opts.bodyHtml },
          toRecipients: [{ emailAddress: { address: opts.to } }],
        },
      }),
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Outlook sendMail failed: ${res.status} ${text}`)
    }
  }
}
```

- [ ] **Step 2: Run send unit tests to verify they pass**

```bash
cd inboxmy-backend && npx vitest run tests/email/send.test.ts
```

Expected: all tests pass.

- [ ] **Step 3: Commit**

```bash
git add inboxmy-backend/src/email/send.ts inboxmy-backend/tests/email/send.test.ts
git commit -m "feat(email): add sendEmail abstraction for Gmail and Outlook"
```

---

## Task 6: Write POST /api/emails/send route tests (RED)

**Files:**
- **Create**: `inboxmy-backend/tests/routes/send.test.ts`

- [ ] **Step 1: Create the failing test file**

Create `inboxmy-backend/tests/routes/send.test.ts`:

```typescript
// tests/routes/send.test.ts
import { vi, describe, it, expect, afterAll, beforeEach } from 'vitest'

// Mock sendEmail before importing anything that touches the route
vi.mock('../../src/email/send', () => ({
  sendEmail: vi.fn(),
}))

import request from 'supertest'
import { app } from '../../src/server'
import { getDb, closeDb } from '../../src/db'
import { encryptSystem, encrypt, decrypt } from '../../src/crypto'
import { randomUUID } from 'crypto'
import { createTestUser } from '../helpers/auth'
import { sendEmail as mockSendEmail } from '../../src/email/send'

afterAll(() => closeDb())

function seedAccount(userId: string, provider: 'gmail' | 'outlook' = 'gmail') {
  const db = getDb()
  const accountId = randomUUID()
  db.prepare(`
    INSERT INTO accounts (id, provider, email, token_enc, created_at, user_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(accountId, provider, `${accountId}@test.com`, encryptSystem('{}'), Date.now(), userId)
  return accountId
}

function seedEmail(userId: string, accountId: string) {
  const db = getDb()
  const emailId = randomUUID()
  db.prepare(`
    INSERT INTO emails (id, account_id, subject_enc, sender, received_at, is_read, folder, tab)
    VALUES (?, ?, ?, ?, ?, 0, 'inbox', 'primary')
  `).run(emailId, accountId, encryptSystem('Test Subject'), 'from@test.com', Date.now())
  return emailId
}

describe('POST /api/emails/send', () => {
  beforeEach(() => { vi.mocked(mockSendEmail).mockResolvedValue(undefined) })

  it('returns 401 without session cookie', async () => {
    const res = await request(app)
      .post('/api/emails/send')
      .send({ to: 'a@b.com', subject: 'Hi', body: 'Hello', accountId: randomUUID() })
    expect(res.status).toBe(401)
  })

  it('happy path: sends email and saves sent copy in DB', async () => {
    const { agent, id: userId, dataKey } = await createTestUser()
    const accountId = seedAccount(userId)
    const res = await agent
      .post('/api/emails/send')
      .send({ to: 'dest@example.com', subject: 'Hello', body: '<p>Hi</p>', accountId })
    expect(res.status).toBe(200)
    expect(res.body.id).toBeDefined()

    // Verify sent copy in DB
    const row = getDb()
      .prepare('SELECT * FROM emails WHERE id = ?')
      .get(res.body.id) as any
    expect(row).toBeDefined()
    expect(row.folder).toBe('sent')
    expect(row.is_read).toBe(1)
    expect(row.account_id).toBe(accountId)

    // Verify subject is encrypted with user's dataKey (not system key)
    expect(decrypt(row.subject_enc, dataKey)).toBe('Hello')
  })

  it('auto-picks accountId from replyToEmailId', async () => {
    const { agent, id: userId } = await createTestUser()
    const accountId = seedAccount(userId)
    const emailId = seedEmail(userId, accountId)

    const res = await agent
      .post('/api/emails/send')
      .send({ to: 'dest@example.com', subject: 'Re: Test', body: '<p>Reply</p>', replyToEmailId: emailId })
    expect(res.status).toBe(200)

    const row = getDb().prepare('SELECT account_id FROM emails WHERE id = ?').get(res.body.id) as any
    expect(row.account_id).toBe(accountId)
  })

  it('returns 400 when accountId missing and no replyToEmailId', async () => {
    const { agent } = await createTestUser()
    const res = await agent
      .post('/api/emails/send')
      .send({ to: 'a@b.com', subject: 'Hi', body: 'Hello' })
    expect(res.status).toBe(400)
  })

  it('returns 400 for invalid to email address', async () => {
    const { agent, id: userId } = await createTestUser()
    const accountId = seedAccount(userId)
    const res = await agent
      .post('/api/emails/send')
      .send({ to: 'not-an-email', subject: 'Hi', body: 'Hello', accountId })
    expect(res.status).toBe(400)
  })

  it('returns 400 when body exceeds 50 KB', async () => {
    const { agent, id: userId } = await createTestUser()
    const accountId = seedAccount(userId)
    const res = await agent
      .post('/api/emails/send')
      .send({ to: 'a@b.com', subject: 'Hi', body: 'x'.repeat(51201), accountId })
    expect(res.status).toBe(400)
  })

  it('returns 404 when replyToEmailId belongs to another user', async () => {
    const { id: userId1 } = await createTestUser()
    const accountId1 = seedAccount(userId1)
    const emailId = seedEmail(userId1, accountId1)

    const { agent: agent2 } = await createTestUser()
    const res = await agent2
      .post('/api/emails/send')
      .send({ to: 'a@b.com', subject: 'Hi', body: 'Hello', replyToEmailId: emailId })
    expect(res.status).toBe(404)
  })

  it('returns 404 when accountId belongs to another user', async () => {
    const { id: userId1 } = await createTestUser()
    const accountId1 = seedAccount(userId1)   // account owned by user1

    const { agent: agent2 } = await createTestUser()
    const res = await agent2
      .post('/api/emails/send')
      .send({ to: 'a@b.com', subject: 'Hi', body: 'Hello', accountId: accountId1 })
    expect(res.status).toBe(404)
  })

  it('returns 502 and does not save DB row when sendEmail throws generic error', async () => {
    const { agent, id: userId } = await createTestUser()
    const accountId = seedAccount(userId)
    vi.mocked(mockSendEmail).mockRejectedValue(new Error('Network timeout'))

    const countBefore = (getDb().prepare('SELECT COUNT(*) as n FROM emails WHERE folder = ?').get('sent') as any).n
    const res = await agent
      .post('/api/emails/send')
      .send({ to: 'a@b.com', subject: 'Hi', body: 'Hello', accountId })
    expect(res.status).toBe(502)
    const countAfter = (getDb().prepare('SELECT COUNT(*) as n FROM emails WHERE folder = ?').get('sent') as any).n
    expect(countAfter).toBe(countBefore)
  })

  it('returns 401 with reconnect:true when sendEmail throws re-auth error', async () => {
    const { agent, id: userId } = await createTestUser()
    const accountId = seedAccount(userId)
    vi.mocked(mockSendEmail).mockRejectedValue(
      new Error('Outlook account not found in MSAL cache — re-auth required')
    )
    const res = await agent
      .post('/api/emails/send')
      .send({ to: 'a@b.com', subject: 'Hi', body: 'Hello', accountId })
    expect(res.status).toBe(401)
    expect(res.body.reconnect).toBe(true)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd inboxmy-backend && npx vitest run tests/routes/send.test.ts
```

Expected: all tests fail — no `/api/emails/send` route exists yet.

---

## Task 7: Implement POST /api/emails/send route (GREEN)

**Files:**
- Modify: `inboxmy-backend/src/routes/emails.ts`

- [ ] **Step 1: Add imports at the top of emails.ts**

Add these imports after the existing imports at the top:
```typescript
import { randomUUID } from 'crypto'
import { encrypt } from '../crypto'
import { sendEmail } from '../email/send'
```

- [ ] **Step 2: Add the send body schema after the existing `listQuery` const**

Add after line 22 (after the `listQuery` definition):
```typescript
const sendBody = z.object({
  to:              z.string().email(),
  subject:         z.string().max(500),
  body:            z.string().max(51200),
  replyToEmailId:  z.string().uuid().optional(),
  accountId:       z.string().optional(),
})
```

- [ ] **Step 3: Add the POST /send route**

Add this **before** the existing `emailsRouter.get('/', ...)` handler (so it doesn't get caught by `/:id`):

```typescript
emailsRouter.post('/send', async (req: Request, res: Response) => {
  const parsed = sendBody.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })

  const { to, subject, body, replyToEmailId, accountId: bodyAccountId } = parsed.data
  const user = (req as any).user
  const db = getDb()

  // Resolve which account to send from
  let accountId: string
  let originalThreadId: string | null = null

  if (replyToEmailId) {
    const original = db.prepare(`
      SELECT e.account_id, e.thread_id
      FROM emails e
      JOIN accounts a ON a.id = e.account_id
      WHERE e.id = ? AND a.user_id = ?
    `).get(replyToEmailId, user.id) as any
    if (!original) return res.status(404).json({ error: 'Email not found' })
    accountId = original.account_id
    originalThreadId = original.thread_id ?? null
  } else {
    if (!bodyAccountId) return res.status(400).json({ error: 'accountId is required' })
    const acct = db.prepare('SELECT id FROM accounts WHERE id = ? AND user_id = ?')
      .get(bodyAccountId, user.id) as any
    if (!acct) return res.status(404).json({ error: 'Account not found' })
    accountId = bodyAccountId
  }

  const account = db.prepare('SELECT email, label FROM accounts WHERE id = ?').get(accountId) as any

  // Send via provider
  try {
    await sendEmail(accountId, { to, subject, bodyHtml: body })
  } catch (err: any) {
    const msg = err?.message ?? ''
    if (msg.includes('re-auth required') || msg.includes('invalid_grant')) {
      return res.status(401).json({ error: 'Re-authentication required', reconnect: true })
    }
    return res.status(502).json({ error: 'Send failed' })
  }

  // Save encrypted sent copy
  const id = randomUUID()
  const snippet = body.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 200)
  db.prepare(`
    INSERT INTO emails
      (id, account_id, thread_id, subject_enc, sender, sender_name,
       received_at, is_read, folder, tab, is_important, category, body_enc, snippet, raw_size)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'sent', 'primary', 0, NULL, ?, ?, ?)
  `).run(
    id,
    accountId,
    originalThreadId,
    encrypt(subject, user.dataKey),
    account.email,
    account.label ?? null,
    Date.now(),
    encrypt(body, user.dataKey),
    snippet ? encrypt(snippet, user.dataKey) : null,
    body.length,
  )

  return res.json({ id })
})
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd inboxmy-backend && npx vitest run tests/routes/send.test.ts
```

Expected: all 9 tests pass.

- [ ] **Step 5: Run full backend test suite to confirm no regressions**

```bash
cd inboxmy-backend && npx vitest run
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add inboxmy-backend/src/routes/emails.ts inboxmy-backend/tests/routes/send.test.ts
git commit -m "feat(api): add POST /emails/send with local sent copy storage"
```

---

## Task 8: Frontend — compose state, openCompose, closeCompose

**Files:**
- Modify: `frontend/app.js`

> No separate test file for frontend JS (Vanilla JS, no test harness). Verify manually via the running app after Task 9.

- [ ] **Step 1: Add compose state variables**

Find the block where `selectedEmailId` is declared (around line 170). Add these lines right after it:

```javascript
// Compose state
let currentComposeReplyToId = null;
let currentComposeAccountId = null;
```

- [ ] **Step 2: Add `openCompose()` function**

Find `function setFolder(f, el)` (around line 364). Add these functions **before** it:

```javascript
function openCompose(mode = 'compose', emailId = null) {
  currentComposeReplyToId = null;
  currentComposeAccountId = null;

  document.getElementById('compose-to').value = '';
  document.getElementById('compose-subject').value = '';
  document.getElementById('compose-body').value = '';
  document.getElementById('compose-account-row').style.display = 'none';

  const titleEl = document.getElementById('lbl-new-message');

  if (mode === 'compose') {
    titleEl.textContent = 'New Message';
    document.getElementById('compose-account-row').style.display = 'flex';
    populateAccountPicker();
  } else if (mode === 'reply' || mode === 'forward') {
    const email = emailCache.find(e => e.id === emailId)
      || { sender: '', subject: '', account_id: null, body: '' };

    currentComposeReplyToId = emailId;

    if (mode === 'reply') {
      titleEl.textContent = 'Reply';
      document.getElementById('compose-to').value = email.sender || '';
      document.getElementById('compose-subject').value = 'Re: ' + (email.subject || '');
      const quotedReply = localStorage.getItem('setting_quotedReply') !== 'false';
      if (quotedReply && email.body) {
        const date = email.received_at ? new Date(email.received_at).toLocaleString() : '';
        const senderLabel = (email.sender_name ? email.sender_name + ' ' : '') + '<' + email.sender + '>';
        const plainBody = (email.body || '').replace(/<[^>]+>/g, '').slice(0, 2000);
        document.getElementById('compose-body').value =
          '\n\n---\nOn ' + date + ', ' + senderLabel + ' wrote:\n' + plainBody;
      }
    } else {
      titleEl.textContent = 'Forward';
      document.getElementById('compose-subject').value = 'Fwd: ' + (email.subject || '');
      if (email.body) {
        const date = email.received_at ? new Date(email.received_at).toLocaleString() : '';
        const senderLabel = (email.sender_name ? email.sender_name + ' ' : '') + '<' + email.sender + '>';
        const plainBody = (email.body || '').replace(/<[^>]+>/g, '').slice(0, 2000);
        document.getElementById('compose-body').value =
          '\n\n---\nOn ' + date + ', ' + senderLabel + ' wrote:\n' + plainBody;
      }
    }
  }

  document.getElementById('compose').style.display = 'flex';
}

function closeCompose() {
  document.getElementById('compose').style.display = 'none';
  document.getElementById('compose-to').value = '';
  document.getElementById('compose-subject').value = '';
  document.getElementById('compose-body').value = '';
  currentComposeReplyToId = null;
  currentComposeAccountId = null;
}

function populateAccountPicker() {
  const sel = document.getElementById('compose-account');
  if (!sel) return;
  sel.innerHTML = '';
  // Use the global accounts list already loaded in the sidebar
  const accts = document.querySelectorAll('.sb-account[data-id]');
  accts.forEach(el => {
    const opt = document.createElement('option');
    opt.value = el.dataset.id;
    opt.textContent = el.dataset.email || el.textContent.trim();
    sel.appendChild(opt);
  });
}
```

- [ ] **Step 3: Commit**

```bash
git add frontend/app.js
git commit -m "feat(frontend): add openCompose/closeCompose/populateAccountPicker"
```

---

## Task 9: Frontend — sendEmail and moveEmail functions

**Files:**
- Modify: `frontend/app.js`

- [ ] **Step 1: Add `sendEmail()` function**

Add this after `closeCompose()`:

```javascript
async function sendEmail() {
  const to = document.getElementById('compose-to').value.trim();
  const subject = document.getElementById('compose-subject').value.trim();
  const body = document.getElementById('compose-body').value.trim();

  if (!to || !subject) {
    showToast('To and Subject are required');
    return;
  }

  const btn = document.getElementById('lbl-send');
  btn.textContent = 'Sending…';
  btn.disabled = true;

  const payload = { to, subject, body: '<p>' + body.replace(/\n/g, '<br>') + '</p>' };

  if (currentComposeReplyToId) {
    payload.replyToEmailId = currentComposeReplyToId;
  } else {
    const sel = document.getElementById('compose-account');
    payload.accountId = sel ? sel.value : null;
  }

  try {
    const res = await fetch('/api/emails/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (res.ok) {
      closeCompose();
      showToast('Sent!');
      loadEmails(true);
    } else if (res.status === 401 && data.reconnect) {
      showToast('Please reconnect your account in Settings');
    } else {
      showToast('Failed to send — please try again');
    }
  } catch {
    showToast('Failed to send — please try again');
  } finally {
    btn.textContent = 'Send';
    btn.disabled = false;
  }
}
```

- [ ] **Step 2: Add `moveEmail()` function**

Add this after `sendEmail()`:

```javascript
async function moveEmail(id, folder) {
  const labels = {
    archive: 'Archived', spam: 'Marked as spam',
    trash: 'Moved to trash', inbox: 'Moved to inbox',
  };
  try {
    const res = await fetch(`/api/emails/${id}/folder`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folder }),
    });
    if (res.ok) {
      showToast(labels[folder] || 'Moved');
      document.getElementById('ed-content').style.display = 'none';
      document.getElementById('ed-empty').style.display = 'flex';
      loadEmails(true);
    } else {
      showToast('Action failed');
    }
  } catch {
    showToast('Action failed');
  }
}
```

- [ ] **Step 3: Add `archive` to `FOLDER_PARAMS` and `titles`**

In `FOLDER_PARAMS` (around line 180), add `archive` entry:
```javascript
const FOLDER_PARAMS = {
  inbox:      { folder: 'inbox' },
  allmail:    {},
  bills:      { category: 'bill' },
  govt:       { category: 'govt' },
  receipts:   { category: 'receipt' },
  work:       { category: 'work' },
  important:  { important: '1' },
  promotions: { tab: 'promotions' },
  sent:       { folder: 'sent' },
  draft:      { folder: 'draft' },
  spam:       { folder: 'spam' },
  archive:    { folder: 'archive' },   // ← add this line
};
```

In `setFolder()` (around line 372), add `archive` to the `titles` object:
```javascript
const titles = {
  inbox: 'Inbox', allmail: 'All Mail', bills: 'Bills', govt: 'Government',
  receipts: 'Receipts', work: 'Work', important: 'Important',
  promotions: 'Promotions', sent: 'Sent', draft: 'Drafts', spam: 'Spam',
  archive: 'Archive',   // ← add this line
};
```

- [ ] **Step 4: Commit**

```bash
git add frontend/app.js
git commit -m "feat(frontend): add sendEmail, moveEmail, archive folder support"
```

---

## Task 10: Frontend — wire up HTML buttons, add Forward, Archive sidebar, account picker, Settings toggle

**Files:**
- Modify: `frontend/index.html`

- [ ] **Step 1: Wire Archive and Spam action buttons**

Find lines around 486–488 (the email detail action buttons):
```html
<button class="ed-btn" onclick="showToast('Archived!')">Archive</button>
<button class="ed-btn" onclick="showToast('Marked spam!')">Spam</button>
<button class="ed-btn primary" onclick="openCompose()">Reply</button>
```

Replace with (use `selectedEmailId` — that is the JS variable at line 170 of app.js tracking the current email, NOT `currentEmailId`):
```html
<button class="ed-btn" onclick="moveEmail(selectedEmailId, 'archive')">Archive</button>
<button class="ed-btn" onclick="moveEmail(selectedEmailId, 'spam')">Spam</button>
<button class="ed-btn" onclick="openCompose('reply', selectedEmailId)">Reply</button>
<button class="ed-btn" onclick="openCompose('forward', selectedEmailId)">Forward</button>
```

- [ ] **Step 2: Add account picker row to compose modal**

Find the compose modal (around line 531–555). After the Subject field (`</div>` on line ~543), add:

```html
  <div class="cmp-field" id="compose-account-row" style="display:none">
    <div class="cmp-field-label">From</div>
    <select id="compose-account" style="flex:1;border:none;outline:none;font-size:13px;background:transparent"></select>
  </div>
```

- [ ] **Step 3: Add Archive entry to sidebar folder list**

Find the sidebar where Spam and Sent are listed. Look for the `<li>` that contains `setFolder('spam'...)`. Add Archive after Spam or after Sent — keep it consistent with existing ordering:

```html
<li class="sb-item" onclick="setFolder('archive', this)">
  <span class="sb-icon">🗄</span> Archive
</li>
```

- [ ] **Step 4: Add "Include quoted message" toggle to Settings modal**

Find the Settings modal body (around line 564). After the `<div class="modal-section-label">Connected accounts</div>` section, add before the AI Notifications section:

```html
      <div class="modal-section-label" style="margin-top:16px">Compose</div>
      <div class="settings-field">
        <label>
          <input type="checkbox" id="quoted-reply-toggle"
            onchange="localStorage.setItem('setting_quotedReply', this.checked)"
            checked />
          Include quoted message when replying
        </label>
      </div>
```

Also add a script to initialise the checkbox state when settings open. Find `function openSettings()` in `app.js` and add this line inside it:
```javascript
const qr = document.getElementById('quoted-reply-toggle');
if (qr) qr.checked = localStorage.getItem('setting_quotedReply') !== 'false';
```

- [ ] **Step 5: Commit**

```bash
git add frontend/index.html frontend/app.js
git commit -m "feat(frontend): wire compose/reply/forward/move buttons, add Archive sidebar and settings toggle"
```

---

## Task 11: Run full test suite + verify

- [ ] **Step 1: Run all backend tests**

```bash
cd inboxmy-backend && npx vitest run
```

Expected: all tests pass (no regressions).

- [ ] **Step 2: Run all tests from the repo root**

```bash
cd .. && npm run test:all
```

Expected: full suite passes.

- [ ] **Step 3: Update README roadmap**

In `README.md`, find the Plan 10 row in the roadmap table and mark it complete. Move it from "Future Plans" to "Completed Plans" if that section exists, or mark status as ✅.

- [ ] **Step 4: Final commit**

```bash
git add README.md
git commit -m "docs: mark Plan 10 complete in roadmap"
```

---

## Notes for Implementation

**`selectedEmailId` vs `currentEmailId`:** The frontend uses `selectedEmailId` (line 170 of app.js) as the currently selected email. `currentEmailId` does **not** exist in app.js. All `onclick` attributes in index.html that reference the current email **must** use `selectedEmailId`. Using `currentEmailId` will silently pass `null` to every action.

**`accounts.label` column:** Confirmed present in `src/db/migrations.ts` line 9 (`label TEXT`). It is nullable — use `account.label ?? null` when writing to the sent copy row.

**Compose modal default display:** The existing `#compose` element likely has `display: none` or is shown via CSS. The `openCompose()` function sets `style.display = 'flex'` and `closeCompose()` sets `style.display = 'none'`. If the modal is styled differently, adjust accordingly.

**`emailCache` for reply/forward:** `openCompose('reply', emailId)` reads from `emailCache` to get the email's subject/body. However, `emailCache` stores list items (no `body` field). The `body` field is only fetched in `selectEmail(id)` via `GET /api/emails/:id`. You can read it from the detail panel's current state or fetch it on-demand:

```javascript
// If email.body is not in cache, fetch it
async function getEmailBody(emailId) {
  const res = await fetch(`/api/emails/${emailId}`);
  const data = await res.json();
  return data.body || '';
}
```

Call this inside `openCompose` for reply/forward modes and await it before populating the quoted body. Adjust `openCompose` to be `async` accordingly.

**Reconnect notice for existing accounts:** After implementing, users with existing accounts will need to disconnect and reconnect to grant `gmail.send` / `Mail.Send` scopes. This is expected behaviour — no code change needed, just a UI note.
