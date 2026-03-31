// tests/routes/emails.test.ts
import { describe, it, expect, afterAll } from 'vitest'
import { closeDb, getDb } from '../../src/db'
import { encryptSystem, encrypt } from '../../src/crypto'
import { randomUUID } from 'crypto'
import { createTestUser } from '../helpers/auth'

afterAll(() => closeDb())

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
    expect(res.body.total).toBe(2)
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
    expect(res.body.total).toBe(2)
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
