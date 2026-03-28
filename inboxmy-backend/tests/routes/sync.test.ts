// tests/routes/sync.test.ts
import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest'
import { closeDb, getDb } from '../../src/db'
import { encryptSystem } from '../../src/crypto'
import { randomUUID } from 'crypto'
import { createTestUser } from '../helpers/auth'

vi.mock('../../src/email/gmail-client', () => ({ fetchNewEmails: vi.fn() }))
vi.mock('../../src/email/outlook-client', () => ({ fetchNewEmails: vi.fn() }))

import { fetchNewEmails as mockGmailFetch } from '../../src/email/gmail-client'
import type { NormalizedEmail } from '../../src/email/types'

afterAll(() => closeDb())

function makeEmail(accountId: string): NormalizedEmail {
  return {
    id: randomUUID(), accountId, threadId: null, subject: 'Test Subject',
    sender: 'sender@test.com', senderName: 'Sender Name', receivedAt: Date.now(),
    isRead: false, folder: 'inbox', tab: 'primary', isImportant: false, category: null,
    bodyHtml: null, bodyText: null, snippet: null, rawSize: 100,
  }
}

function seedAccount(userId: string) {
  const accountId = randomUUID()
  getDb().prepare(`
    INSERT INTO accounts (id, provider, email, token_enc, created_at, user_id)
    VALUES (?, 'gmail', ?, ?, ?, ?)
  `).run(accountId, `${accountId}@test.com`, encryptSystem('{}'), Date.now(), userId)
  return accountId
}

describe('POST /api/sync/trigger — all accounts', () => {
  beforeEach(() => { vi.resetAllMocks() })

  it('returns { added, emails } when new emails are found', async () => {
    const { agent, id: userId } = await createTestUser()
    const accountId = seedAccount(userId)
    const email = makeEmail(accountId)

    vi.mocked(mockGmailFetch).mockResolvedValue({ emails: [email], newHistoryId: null })

    const res = await agent.post('/api/sync/trigger').send({})

    expect(res.status).toBe(200)
    expect(typeof res.body.added).toBe('number')
    expect(res.body.added).toBe(1)
    expect(Array.isArray(res.body.emails)).toBe(true)
    expect(res.body.emails).toHaveLength(1)
    expect(res.body.emails[0].subject).toBe('Test Subject')
    expect(res.body.emails[0].sender).toBe('sender@test.com')
    expect(res.body.emails[0].senderName).toBe('Sender Name')
    expect(res.body.emails[0].accountId).toBe(accountId)
  })

  it('returns { added: 0, emails: [] } when no new emails', async () => {
    const { agent, id: userId } = await createTestUser()
    seedAccount(userId)
    vi.mocked(mockGmailFetch).mockResolvedValue({ emails: [], newHistoryId: null })

    const res = await agent.post('/api/sync/trigger').send({})

    expect(res.status).toBe(200)
    expect(res.body.added).toBe(0)
    expect(res.body.emails).toEqual([])
  })

  it('returns 401 without session', async () => {
    const { default: request } = await import('supertest')
    const { app } = await import('../../src/server')
    const res = await request(app).post('/api/sync/trigger').send({})
    expect(res.status).toBe(401)
  })
})

describe('POST /api/sync/trigger — single account', () => {
  beforeEach(() => { vi.resetAllMocks() })

  it('returns { added, emails, errors } for a specific account', async () => {
    const { agent, id: userId } = await createTestUser()
    const accountId = seedAccount(userId)
    const email = makeEmail(accountId)

    vi.mocked(mockGmailFetch).mockResolvedValue({ emails: [email], newHistoryId: null })

    const res = await agent.post('/api/sync/trigger').send({ accountId })

    expect(res.status).toBe(200)
    expect(res.body.added).toBe(1)
    expect(Array.isArray(res.body.emails)).toBe(true)
    expect(res.body.emails[0].subject).toBe('Test Subject')
    expect(Array.isArray(res.body.errors)).toBe(true)
    expect(res.body.errors).toHaveLength(0)
  })

  it('returns 404 when accountId does not belong to the authenticated user', async () => {
    const { agent } = await createTestUser()
    const { id: otherUserId } = await createTestUser()
    const otherAccountId = seedAccount(otherUserId)

    const res = await agent.post('/api/sync/trigger').send({ accountId: otherAccountId })

    expect(res.status).toBe(404)
  })
})
