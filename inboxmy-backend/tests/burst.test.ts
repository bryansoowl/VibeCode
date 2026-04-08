import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { makeTestDb } from './helpers/db'
import type Database from 'better-sqlite3'

let testDb: Database.Database

vi.mock('../src/db', () => ({ getDb: () => testDb }))
vi.mock('../src/middleware/auth', () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
}))

const MOCK_BURST_EMAILS = Array.from({ length: 5 }, (_, i) => ({
  id: `burst-msg-${i}`,
  accountId: 'acc-1',
  threadId: null,
  subject: `Burst Email ${i}`,
  sender: `burst${i}@example.com`,
  senderName: `Burst Sender ${i}`,
  receivedAt: 1_700_000_000_000 - i * 1000,
  isRead: false,
  folder: 'inbox' as const,
  tab: 'primary' as const,
  isImportant: false,
  category: null,
  snippet: `burst snippet ${i}`,
  rawSize: 256,
}))

vi.mock('../src/email/gmail-client', () => ({
  fetchNewEmails: vi.fn(),
  fetchEmailsMetadata: vi.fn().mockResolvedValue([]),
  fetchBurstMetadata: vi.fn().mockResolvedValue(MOCK_BURST_EMAILS),
}))

vi.mock('../src/email/outlook-client', () => ({
  fetchNewEmails: vi.fn(),
  fetchEmailsMetadata: vi.fn().mockResolvedValue([]),
  fetchBurstMetadata: vi.fn().mockResolvedValue([]),
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
}

describe('POST /api/sync/burst', () => {
  beforeEach(() => {
    testDb = makeTestDb()
    seedAccount(testDb)
  })
  afterEach(() => testDb.close())

  it('returns 200 with added count', async () => {
    const app = await makeApp()
    const res = await request(app).post('/api/sync/burst').send({ accountId: 'acc-1' })
    expect(res.status).toBe(200)
    expect(res.body.added).toBe(5)
  })

  it('inserts emails into inbox_index', async () => {
    const app = await makeApp()
    await request(app).post('/api/sync/burst').send({ accountId: 'acc-1' })
    const count = (testDb.prepare('SELECT COUNT(*) as n FROM inbox_index').get() as any).n
    expect(count).toBe(5)
  })

  it('seeds sync_backfill_cursors for inbox, sent, spam', async () => {
    const app = await makeApp()
    await request(app).post('/api/sync/burst').send({ accountId: 'acc-1' })
    const rows = testDb.prepare(
      `SELECT folder FROM sync_backfill_cursors WHERE account_id='acc-1'`
    ).all() as any[]
    const folders = rows.map((r: any) => r.folder).sort()
    expect(folders).toEqual(['inbox', 'sent', 'spam'])
  })

  it('is idempotent — running twice does not duplicate inbox_index rows', async () => {
    const app = await makeApp()
    await request(app).post('/api/sync/burst').send({ accountId: 'acc-1' })
    await request(app).post('/api/sync/burst').send({ accountId: 'acc-1' })
    const count = (testDb.prepare('SELECT COUNT(*) as n FROM inbox_index').get() as any).n
    expect(count).toBe(5)
  })

  it('returns 404 for unknown accountId', async () => {
    const app = await makeApp()
    const res = await request(app).post('/api/sync/burst').send({ accountId: 'unknown' })
    expect(res.status).toBe(404)
  })

  it('returns 400 when accountId is missing', async () => {
    const app = await makeApp()
    const res = await request(app).post('/api/sync/burst').send({})
    expect(res.status).toBe(400)
  })
})

describe('PATCH /api/sync/state/:accountId', () => {
  beforeEach(() => {
    testDb = makeTestDb()
    seedAccount(testDb)
  })
  afterEach(() => testDb.close())

  it('upserts last_batch_size and last_batch_duration_ms', async () => {
    const app = await makeApp()
    const res = await request(app)
      .patch('/api/sync/state/acc-1')
      .send({ last_batch_size: 75, last_batch_duration_ms: 4200 })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)

    const row = testDb.prepare(
      `SELECT last_batch_size, last_batch_duration_ms FROM sync_state WHERE account_id='acc-1'`
    ).get() as any
    expect(row.last_batch_size).toBe(75)
    expect(row.last_batch_duration_ms).toBe(4200)
  })

  it('returns 404 for account not owned by user', async () => {
    const app = await makeApp()
    const res = await request(app)
      .patch('/api/sync/state/acc-other')
      .send({ last_batch_size: 100, last_batch_duration_ms: 1000 })
    expect(res.status).toBe(404)
  })

  it('updates existing sync_state row without clobbering other columns', async () => {
    const app = await makeApp()
    // Pre-insert a sync_state row with last_fast_sync_at
    testDb.prepare(`INSERT INTO sync_state (account_id, last_fast_sync_at) VALUES ('acc-1', 9999)`).run()
    await request(app)
      .patch('/api/sync/state/acc-1')
      .send({ last_batch_size: 50, last_batch_duration_ms: 8000 })
    const row = testDb.prepare(`SELECT * FROM sync_state WHERE account_id='acc-1'`).get() as any
    expect(row.last_fast_sync_at).toBe(9999)  // not clobbered
    expect(row.last_batch_size).toBe(50)
  })
})
