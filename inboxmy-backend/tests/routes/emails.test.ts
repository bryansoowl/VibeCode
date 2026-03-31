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
    const { agent, id: userId, dataKey } = await createTestUser()
    const acctId = seedAccount(userId)
    seedEmail(userId, { accountId: acctId, receivedAt: myt('2026-03-10'), dataKey })  // before
    seedEmail(userId, { accountId: acctId, receivedAt: myt('2026-03-20'), dataKey })  // on boundary
    seedEmail(userId, { accountId: acctId, receivedAt: myt('2026-03-25'), dataKey })  // after

    const res = await agent.get('/api/emails?dateFrom=2026-03-20')
    expect(res.status).toBe(200)
    expect(res.body.emails).toHaveLength(2)
    expect(res.body.total).toBe(2)
  })

  it('dateTo returns only emails on or before that date', async () => {
    const { agent, id: userId, dataKey } = await createTestUser()
    const acctId = seedAccount(userId)
    seedEmail(userId, { accountId: acctId, receivedAt: myt('2026-03-10'), dataKey })  // before boundary
    seedEmail(userId, { accountId: acctId, receivedAt: myt('2026-03-20', 'end'), dataKey })  // on boundary
    seedEmail(userId, { accountId: acctId, receivedAt: myt('2026-03-25'), dataKey })  // after

    const res = await agent.get('/api/emails?dateTo=2026-03-20')
    expect(res.status).toBe(200)
    expect(res.body.emails).toHaveLength(2)
    expect(res.body.total).toBe(2)
  })

  it('dateFrom + dateTo combined return emails within the range only', async () => {
    const { agent, id: userId, dataKey } = await createTestUser()
    const acctId = seedAccount(userId)
    seedEmail(userId, { accountId: acctId, receivedAt: myt('2026-03-01'), dataKey })   // outside
    seedEmail(userId, { accountId: acctId, receivedAt: myt('2026-03-10'), dataKey })   // inside
    seedEmail(userId, { accountId: acctId, receivedAt: myt('2026-03-15'), dataKey })   // inside
    seedEmail(userId, { accountId: acctId, receivedAt: myt('2026-03-31'), dataKey })   // outside

    const res = await agent.get('/api/emails?dateFrom=2026-03-05&dateTo=2026-03-20')
    expect(res.status).toBe(200)
    expect(res.body.emails).toHaveLength(2)
    expect(res.body.total).toBe(2)
  })

  it('swaps dateFrom and dateTo silently when inverted', async () => {
    const { agent, id: userId, dataKey } = await createTestUser()
    const acctId = seedAccount(userId)
    seedEmail(userId, { accountId: acctId, receivedAt: myt('2026-03-10'), dataKey })  // in range
    seedEmail(userId, { accountId: acctId, receivedAt: myt('2026-03-25'), dataKey })  // outside

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
    const { agent, id: userId, dataKey } = await createTestUser()
    const acct1 = seedAccount(userId)
    const acct2 = seedAccount(userId)
    seedEmail(userId, { accountId: acct1, dataKey })
    seedEmail(userId, { accountId: acct2, dataKey })

    const res = await agent.get(`/api/emails?accountIds=${acct1}`)
    expect(res.status).toBe(200)
    expect(res.body.emails).toHaveLength(1)
    expect(res.body.emails[0].account_id).toBe(acct1)
  })

  it('accountIds with multiple IDs returns emails from any (OR logic)', async () => {
    const { agent, id: userId, dataKey } = await createTestUser()
    const acct1 = seedAccount(userId)
    const acct2 = seedAccount(userId)
    const acct3 = seedAccount(userId)
    seedEmail(userId, { accountId: acct1, dataKey })
    seedEmail(userId, { accountId: acct2, dataKey })
    seedEmail(userId, { accountId: acct3, dataKey })

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
    const { agent, id: userId, dataKey } = await createTestUser()
    seedEmail(userId, { dataKey })
    seedEmail(userId, { dataKey })

    const res = await agent.get('/api/emails?accountIds=,,,')
    expect(res.status).toBe(200)
    expect(res.body.emails).toHaveLength(2)
  })
})

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
