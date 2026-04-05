import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { makeTestDb } from './helpers/db'
import type Database from 'better-sqlite3'
import { encrypt } from '../src/crypto'

let testDb: Database.Database

vi.mock('../src/db', () => ({ getDb: () => testDb }))
vi.mock('../src/middleware/auth', () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
}))

const TEST_DATA_KEY = Buffer.alloc(32, 0x42)
const TEST_USER = { id: 'user-1', dataKey: TEST_DATA_KEY }

async function makeApp() {
  const { emailsRouter } = await import('../src/routes/emails')
  const app = express()
  app.use(express.json())
  app.use((req: any, _res: any, next: any) => { req.user = TEST_USER; next() })
  app.use('/api/emails', emailsRouter)
  return app
}

function seedPrerequisites(db: Database.Database) {
  db.prepare(`INSERT INTO users (id, email, password_hash, pbkdf2_salt, data_key_enc, recovery_enc, created_at)
    VALUES ('user-1', 'u@t.com', 'h', 's', 'e', 'e', 1)`).run()
  db.prepare(`INSERT INTO accounts (id, provider, email, token_enc, created_at, user_id)
    VALUES ('acc-1', 'gmail', 'a@t.com', 'e', 1, 'user-1')`).run()
}

function seedIndexRow(db: Database.Database, overrides: Record<string, any> = {}) {
  const defaults = {
    email_id: 'uuid-1', account_id: 'acc-1', provider_message_id: 'msg-1',
    sender_email: 'sender@example.com', sender_name: 'Sender',
    subject_preview_enc: encrypt('Test Subject', TEST_DATA_KEY),
    snippet_preview_enc: encrypt('Test snippet', TEST_DATA_KEY),
    received_at: 1_700_000_000_000,
    folder: 'inbox', tab: 'primary',
    is_read: 0, is_important: 0, has_full_body: 0, sync_state: 'partial',
  }
  const row = { ...defaults, ...overrides }
  db.prepare(`INSERT INTO inbox_index
    (email_id, account_id, provider_message_id, sender_email, sender_name,
     subject_preview_enc, snippet_preview_enc, received_at, folder, tab,
     is_read, is_important, has_full_body, sync_state, snoozed_until)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.email_id, row.account_id, row.provider_message_id, row.sender_email,
    row.sender_name, row.subject_preview_enc, row.snippet_preview_enc,
    row.received_at, row.folder, row.tab, row.is_read, row.is_important,
    row.has_full_body, row.sync_state, row.snoozed_until ?? null
  )
}

describe('GET /api/emails/index — cursor pagination', () => {
  beforeEach(() => {
    testDb = makeTestDb()
    seedPrerequisites(testDb)
  })
  afterEach(() => testDb.close())

  it('returns 200 with emails array and decrypted subject', async () => {
    seedIndexRow(testDb)
    const app = await makeApp()
    const res = await request(app).get('/api/emails/index?accountId=acc-1&folder=inbox&tab=primary')
    expect(res.status).toBe(200)
    expect(res.body.emails).toHaveLength(1)
    expect(res.body.emails[0].subject).toBe('Test Subject')
    expect(res.body.emails[0].snippet).toBe('Test snippet')
    expect(res.body.emails[0].subject_preview_enc).toBeUndefined()
  })

  it('returns 404 for account not belonging to user', async () => {
    const app = await makeApp()
    const res = await request(app).get('/api/emails/index?accountId=other-acc&folder=inbox&tab=primary')
    expect(res.status).toBe(404)
  })

  it('returns next_cursor when results equal limit', async () => {
    for (let i = 0; i < 3; i++) {
      seedIndexRow(testDb, {
        email_id: `uuid-${i}`, provider_message_id: `msg-${i}`,
        received_at: 1_700_000_000_000 - i * 1000,
      })
    }
    const app = await makeApp()
    const res = await request(app).get('/api/emails/index?accountId=acc-1&folder=inbox&tab=primary&limit=2')
    expect(res.status).toBe(200)
    expect(res.body.emails).toHaveLength(2)
    expect(res.body.next_cursor).not.toBeNull()
    expect(res.body.next_cursor).toHaveProperty('before_ts')
    expect(res.body.next_cursor).toHaveProperty('before_id')
  })

  it('returns next_cursor=null when results are fewer than limit', async () => {
    seedIndexRow(testDb)
    const app = await makeApp()
    const res = await request(app).get('/api/emails/index?accountId=acc-1&folder=inbox&tab=primary&limit=50')
    expect(res.status).toBe(200)
    expect(res.body.next_cursor).toBeNull()
  })

  it('cursor pagination returns correct next page without duplicates', async () => {
    for (let i = 0; i < 5; i++) {
      seedIndexRow(testDb, {
        email_id: `uuid-${i}`, provider_message_id: `msg-${i}`,
        received_at: 1_700_000_000_000 - i * 1000,
      })
    }
    const app = await makeApp()

    const page1 = await request(app).get('/api/emails/index?accountId=acc-1&folder=inbox&tab=primary&limit=3')
    expect(page1.body.emails).toHaveLength(3)
    const { before_ts, before_id } = page1.body.next_cursor

    const page2 = await request(app).get(
      `/api/emails/index?accountId=acc-1&folder=inbox&tab=primary&limit=3&before_ts=${before_ts}&before_id=${before_id}`
    )
    expect(page2.body.emails).toHaveLength(2)
    expect(page2.body.next_cursor).toBeNull()

    const page1Ids = page1.body.emails.map((e: any) => e.email_id)
    const page2Ids = page2.body.emails.map((e: any) => e.email_id)
    const overlap = page1Ids.filter((id: string) => page2Ids.includes(id))
    expect(overlap).toHaveLength(0)
  })

  it('excludes snoozed emails', async () => {
    seedIndexRow(testDb, { snoozed_until: Date.now() + 100_000 })
    const app = await makeApp()
    const res = await request(app).get('/api/emails/index?accountId=acc-1&folder=inbox&tab=primary')
    expect(res.body.emails).toHaveLength(0)
  })
})

// ── Top-level mocks for body fetch tests ────────────────────────────────────
// All vi.mock calls MUST be at file top-level — Vitest hoists them automatically.
// Do NOT place vi.mock inside describe() or it() — the mock will not take effect.
vi.mock('../src/email/gmail-client', () => ({
  fetchNewEmails: vi.fn(),
  fetchEmailsMetadata: vi.fn(),
}))
vi.mock('../src/email/outlook-client', () => ({
  fetchNewEmails: vi.fn(),
  fetchEmailsMetadata: vi.fn(),
}))
vi.mock('../src/auth/gmail', () => ({
  getAuthedClient: vi.fn().mockResolvedValue({}),
}))
vi.mock('googleapis', () => ({
  google: {
    gmail: () => ({
      users: {
        messages: {
          get: vi.fn().mockResolvedValue({
            data: {
              id: 'msg-1',
              threadId: 'thread-1',
              labelIds: [],
              snippet: 'snippet',
              internalDate: '1700000000000',
              sizeEstimate: 1024,
              payload: {
                headers: [
                  { name: 'From', value: 'sender@example.com' },
                  { name: 'Subject', value: 'Test Subject' },
                ],
                mimeType: 'text/html',
                body: { data: Buffer.from('<p>Hello body</p>').toString('base64') },
                parts: [],
              },
            },
          }),
        },
      },
    }),
  },
}))

describe('GET /api/emails/index/:id — on-demand body fetch', () => {
  beforeEach(() => {
    testDb = makeTestDb()
    seedPrerequisites(testDb)
    seedIndexRow(testDb, { email_id: 'uuid-1', provider_message_id: 'msg-1' })
  })
  afterEach(() => testDb.close())

  it('returns 404 for unknown email_id', async () => {
    const app = await makeApp()
    const res = await request(app).get('/api/emails/index/nonexistent-uuid')
    expect(res.status).toBe(404)
  })

  it('fetches and caches body when has_full_body=0', async () => {
    const app = await makeApp()
    const res = await request(app).get('/api/emails/index/uuid-1')
    expect(res.status).toBe(200)
    expect(res.body).toHaveProperty('email_id', 'uuid-1')
    expect(res.body.body).toBe('<p>Hello body</p>')

    // Verify DB state: email_body row inserted and has_full_body flag set
    const bodyRow = testDb.prepare('SELECT * FROM email_body WHERE email_id = ?').get('uuid-1') as any
    expect(bodyRow).toBeTruthy()
    const indexRow = testDb.prepare('SELECT has_full_body FROM inbox_index WHERE email_id = ?').get('uuid-1') as any
    expect(indexRow.has_full_body).toBe(1)
  })

  it('serves body from email_body cache when has_full_body=1', async () => {
    testDb.prepare(`INSERT INTO email_body (email_id, body_enc, body_format, fetched_at)
      VALUES ('uuid-1', ?, 'html', ?)`)
      .run(encrypt('<p>Cached body</p>', TEST_DATA_KEY), Date.now())
    testDb.prepare(`UPDATE inbox_index SET has_full_body=1 WHERE email_id='uuid-1'`).run()

    const app = await makeApp()
    const res = await request(app).get('/api/emails/index/uuid-1')
    expect(res.status).toBe(200)
    expect(res.body.body).toBe('<p>Cached body</p>')
    expect(res.body.body_format).toBe('html')
  })

  it('is idempotent — second fetch returns same body', async () => {
    testDb.prepare(`INSERT INTO email_body (email_id, body_enc, body_format, fetched_at)
      VALUES ('uuid-1', ?, 'text', ?)`)
      .run(encrypt('Plain body', TEST_DATA_KEY), Date.now())
    testDb.prepare(`UPDATE inbox_index SET has_full_body=1 WHERE email_id='uuid-1'`).run()

    const app = await makeApp()
    const res1 = await request(app).get('/api/emails/index/uuid-1')
    const res2 = await request(app).get('/api/emails/index/uuid-1')
    expect(res1.body.body).toBe(res2.body.body)
  })
})
