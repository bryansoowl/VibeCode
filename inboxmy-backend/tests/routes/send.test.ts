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
