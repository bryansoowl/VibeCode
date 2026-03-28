// tests/routes/emails.test.ts
import { describe, it, expect, afterAll } from 'vitest'
import { closeDb, getDb } from '../../src/db'
import { encryptSystem, encrypt } from '../../src/crypto'
import { randomUUID } from 'crypto'
import { createTestUser } from '../helpers/auth'

afterAll(() => closeDb())

const KEY = Buffer.alloc(32)

function seedEmail(userId: string, opts: {
  isRead?: boolean
  folder?: string
  tab?: string
}) {
  const db = getDb()
  const accountId = randomUUID()
  const emailId = randomUUID()

  db.prepare(`
    INSERT INTO accounts (id, provider, email, token_enc, created_at, user_id)
    VALUES (?, 'gmail', ?, ?, ?, ?)
  `).run(accountId, `${accountId}@test.com`, encryptSystem('{}'), Date.now(), userId)

  db.prepare(`
    INSERT INTO emails (id, account_id, subject_enc, sender, received_at, is_read, folder, tab)
    VALUES (?, ?, ?, 'test@test.com', ?, ?, ?, ?)
  `).run(
    emailId, accountId,
    encrypt('Test Subject', KEY),
    Date.now(),
    opts.isRead ? 1 : 0,
    opts.folder ?? 'inbox',
    opts.tab ?? 'primary'
  )

  return { emailId, accountId }
}

describe('GET /api/emails/unread-count', () => {
  it('returns count of unread inbox non-promotions emails', async () => {
    const { agent, id: userId } = await createTestUser()
    seedEmail(userId, { isRead: false, folder: 'inbox', tab: 'primary' })
    seedEmail(userId, { isRead: false, folder: 'inbox', tab: 'primary' })

    const res = await agent.get('/api/emails/unread-count')

    expect(res.status).toBe(200)
    expect(res.body.count).toBe(2)
  })

  it('excludes read emails', async () => {
    const { agent, id: userId } = await createTestUser()
    seedEmail(userId, { isRead: true, folder: 'inbox', tab: 'primary' })

    const res = await agent.get('/api/emails/unread-count')

    expect(res.status).toBe(200)
    expect(res.body.count).toBe(0)
  })

  it('excludes Promotions tab emails', async () => {
    const { agent, id: userId } = await createTestUser()
    seedEmail(userId, { isRead: false, folder: 'inbox', tab: 'promotions' })

    const res = await agent.get('/api/emails/unread-count')

    expect(res.status).toBe(200)
    expect(res.body.count).toBe(0)
  })

  it('excludes non-inbox folders', async () => {
    const { agent, id: userId } = await createTestUser()
    seedEmail(userId, { isRead: false, folder: 'spam', tab: 'primary' })

    const res = await agent.get('/api/emails/unread-count')

    expect(res.status).toBe(200)
    expect(res.body.count).toBe(0)
  })

  it('does not count another user\'s emails', async () => {
    const { id: userId1 } = await createTestUser()
    const { agent: agent2 } = await createTestUser()
    seedEmail(userId1, { isRead: false, folder: 'inbox', tab: 'primary' })

    const res = await agent2.get('/api/emails/unread-count')

    expect(res.status).toBe(200)
    expect(res.body.count).toBe(0)
  })

  it('returns 401 without session', async () => {
    const { default: request } = await import('supertest')
    const { app } = await import('../../src/server')
    const res = await request(app).get('/api/emails/unread-count')
    expect(res.status).toBe(401)
  })
})
