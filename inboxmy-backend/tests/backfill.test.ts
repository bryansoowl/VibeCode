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

const MOCK_BATCH = Array.from({ length: 5 }, (_, i) => ({
  id: `old-msg-${i}`,
  accountId: 'acc-1',
  threadId: null,
  subject: `Old Email ${i}`,
  sender: `sender${i}@example.com`,
  senderName: `Sender ${i}`,
  receivedAt: 1_690_000_000_000 - i * 1000,
  isRead: false,
  folder: 'inbox' as const,
  tab: 'primary' as const,
  isImportant: false,
  category: null,
  snippet: `snippet ${i}`,
  rawSize: 512,
}))

vi.mock('../src/email/gmail-client', () => ({
  fetchNewEmails: vi.fn(),
  fetchEmailsMetadata: vi.fn().mockImplementation(
    (accountId: string, beforeMs?: number) => {
      if (beforeMs) return Promise.resolve(MOCK_BATCH)
      return Promise.resolve([])
    }
  ),
}))

vi.mock('../src/email/outlook-client', () => ({
  fetchNewEmails: vi.fn(),
  fetchEmailsMetadata: vi.fn().mockResolvedValue([]),
}))

const TEST_DATA_KEY = Buffer.alloc(32, 0x42)
const TEST_USER = { id: 'user-1', dataKey: TEST_DATA_KEY }

async function makeApp() {
  const { syncRouter } = await import('../src/routes/sync')
  const app = express()
  app.use(express.json())
  app.use((req: any, _res: any, next: any) => { req.user = TEST_USER; next() })
  app.use('/api/sync', syncRouter)
  return app
}

function seedAccount(db: Database.Database) {
  db.prepare(`INSERT INTO users (id, email, password_hash, pbkdf2_salt, data_key_enc, recovery_enc, created_at)
    VALUES ('user-1', 'u@t.com', 'h', 's', 'e', 'e', 1)`).run()
  db.prepare(`INSERT INTO accounts (id, provider, email, token_enc, created_at, user_id)
    VALUES ('acc-1', 'gmail', 'a@t.com', 'e', 1, 'user-1')`).run()
  const cursorJson = JSON.stringify({ received_at: 1_700_000_000_000, email_id: 'existing-uuid' })
  db.prepare(`INSERT INTO sync_backfill_cursors (account_id, folder, cursor, complete)
    VALUES ('acc-1', 'inbox', ?, 0), ('acc-1', 'sent', ?, 1), ('acc-1', 'spam', ?, 1)
  `).run(cursorJson, cursorJson, cursorJson)
}

describe('POST /api/sync/backfill', () => {
  beforeEach(() => {
    testDb = makeTestDb()
    seedAccount(testDb)
  })

  afterEach(() => testDb.close())

  it('returns 200 with per-folder results', async () => {
    const app = await makeApp()
    const res = await request(app).post('/api/sync/backfill').send({ accountId: 'acc-1' })
    expect(res.status).toBe(200)
    expect(res.body).toHaveProperty('results')
    expect(Array.isArray(res.body.results)).toBe(true)
  })

  it('inserts provider-fetched emails into inbox_index', async () => {
    const app = await makeApp()
    await request(app).post('/api/sync/backfill').send({ accountId: 'acc-1' })

    const count = (testDb.prepare('SELECT COUNT(*) as n FROM inbox_index').get() as any).n
    expect(count).toBe(5)
  })

  it('marks folder complete when provider returns fewer than 25 emails', async () => {
    const app = await makeApp()
    await request(app).post('/api/sync/backfill').send({ accountId: 'acc-1' })

    const row = testDb.prepare(
      `SELECT complete FROM sync_backfill_cursors WHERE account_id='acc-1' AND folder='inbox'`
    ).get() as any
    expect(row.complete).toBe(1)
  })

  it('advances cursor to the oldest inserted email', async () => {
    const app = await makeApp()
    await request(app).post('/api/sync/backfill').send({ accountId: 'acc-1' })

    const row = testDb.prepare(
      `SELECT cursor FROM sync_backfill_cursors WHERE account_id='acc-1' AND folder='inbox'`
    ).get() as any
    const cursor = JSON.parse(row.cursor)
    expect(cursor.received_at).toBe(1_690_000_000_000 - 4 * 1000)
  })

  it('is idempotent — running twice does not duplicate inbox_index rows', async () => {
    const app = await makeApp()
    await request(app).post('/api/sync/backfill').send({ accountId: 'acc-1' })
    await request(app).post('/api/sync/backfill').send({ accountId: 'acc-1' })

    const count = (testDb.prepare('SELECT COUNT(*) as n FROM inbox_index').get() as any).n
    expect(count).toBe(5)
  })

  it('skips already-complete folders', async () => {
    const app = await makeApp()
    const res = await request(app).post('/api/sync/backfill').send({ accountId: 'acc-1' })
    const results = res.body.results as any[]
    const sentResult = results.find((r: any) => r.folder === 'sent')
    expect(sentResult.skipped).toBe(true)
  })

  it('returns 404 for unknown account', async () => {
    const app = await makeApp()
    const res = await request(app).post('/api/sync/backfill').send({ accountId: 'nonexistent' })
    expect(res.status).toBe(404)
  })
})
