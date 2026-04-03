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
  category?: string       // NEW
  isImportant?: boolean   // NEW
  snoozedUntil?: number   // NEW (ms epoch)
}) {
  const db = getDb()
  const accountId = opts.accountId ?? seedAccount(userId)
  const emailId = randomUUID()
  const key = opts.dataKey ?? KEY

  db.prepare(`
    INSERT INTO emails
      (id, account_id, subject_enc, snippet, sender, received_at,
       is_read, folder, tab, category, is_important, snoozed_until)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    emailId,
    accountId,
    encrypt(opts.subject ?? 'Test Subject', key),
    opts.snippet ? encrypt(opts.snippet, key) : null,
    opts.sender ?? 'test@test.com',
    opts.receivedAt ?? Date.now(),
    opts.isRead ? 1 : 0,
    opts.folder ?? 'inbox',
    opts.tab ?? 'primary',
    opts.category ?? null,
    opts.isImportant ? 1 : 0,
    opts.snoozedUntil ?? null,
  )

  return { emailId, accountId }
}

describe('GET /api/emails/unread-count (removed)', () => {
  it('returns 404 — endpoint has been replaced by /unread-counts', async () => {
    const { agent } = await createTestUser()
    const res = await agent.get('/api/emails/unread-count')
    expect(res.status).toBe(404)
  })
})

describe('GET /api/emails/unread-counts', () => {
  it('returns 401 without session', async () => {
    const { default: request } = await import('supertest')
    const { app } = await import('../../src/server')
    const res = await request(app).get('/api/emails/unread-counts')
    expect(res.status).toBe(401)
  })

  it('returns all-zero counts when no emails exist', async () => {
    const { agent } = await createTestUser()
    const res = await agent.get('/api/emails/unread-counts')
    expect(res.status).toBe(200)
    const keys = ['total_unread','bills','govt','receipts','work','important','promotions','snoozed','sent','draft','spam','archived']
    for (const k of keys) expect(res.body[k]).toBe(0)
  })

  it('total_unread counts unread emails across all folders excluding snoozed', async () => {
    const { agent, id: userId } = await createTestUser()
    seedEmail(userId, { isRead: false, folder: 'inbox' })
    seedEmail(userId, { isRead: false, folder: 'sent' })
    seedEmail(userId, { isRead: true,  folder: 'inbox' })     // read — excluded
    seedEmail(userId, { isRead: false, snoozedUntil: Date.now() + 60_000 }) // snoozed — excluded
    const res = await agent.get('/api/emails/unread-counts')
    expect(res.status).toBe(200)
    expect(res.body.total_unread).toBe(2)
  })

  it('bills counts unread bill-category emails excluding snoozed', async () => {
    const { agent, id: userId } = await createTestUser()
    seedEmail(userId, { isRead: false, category: 'bill' })
    seedEmail(userId, { isRead: true,  category: 'bill' })    // read — excluded
    seedEmail(userId, { isRead: false, category: 'bill', snoozedUntil: Date.now() + 60_000 }) // snoozed — excluded
    seedEmail(userId, { isRead: false, category: 'govt' })    // different category
    const res = await agent.get('/api/emails/unread-counts')
    expect(res.body.bills).toBe(1)
  })

  it('snoozed counts all snoozed emails regardless of is_read', async () => {
    const { agent, id: userId } = await createTestUser()
    const future = Date.now() + 60_000
    const past   = Date.now() - 60_000
    seedEmail(userId, { isRead: false, snoozedUntil: future }) // currently snoozed
    seedEmail(userId, { isRead: true,  snoozedUntil: future }) // currently snoozed (read)
    seedEmail(userId, { isRead: false, snoozedUntil: past   }) // past snooze — NOT counted
    const res = await agent.get('/api/emails/unread-counts')
    expect(res.body.snoozed).toBe(2)
  })

  it('important counts unread important emails excluding snoozed', async () => {
    const { agent, id: userId } = await createTestUser()
    seedEmail(userId, { isRead: false, isImportant: true })
    seedEmail(userId, { isRead: true,  isImportant: true })   // read — excluded
    seedEmail(userId, { isRead: false, isImportant: false })  // not important
    const res = await agent.get('/api/emails/unread-counts')
    expect(res.body.important).toBe(1)
  })

  it('does not count another user\'s emails', async () => {
    const { id: userId1 } = await createTestUser()
    const { agent: agent2 } = await createTestUser()
    seedEmail(userId1, { isRead: false })
    const res = await agent2.get('/api/emails/unread-counts')
    expect(res.body.total_unread).toBe(0)
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

describe('GET /api/emails — basic list', () => {
  it('returns 401 without session', async () => {
    const { default: request } = await import('supertest')
    const { app } = await import('../../src/server')
    const res = await request(app).get('/api/emails')
    expect(res.status).toBe(401)
  })

  it('returns paginated response shape: { emails, limit, offset, total }', async () => {
    const { agent, id: userId, dataKey } = await createTestUser()
    const acctId = seedAccount(userId)
    for (let i = 0; i < 3; i++) {
      seedEmail(userId, { accountId: acctId, dataKey })
    }

    const res = await agent.get('/api/emails?limit=50&offset=0')
    expect(res.status).toBe(200)
    expect(res.body).toHaveProperty('emails')
    expect(res.body).toHaveProperty('total')
    expect(res.body).toHaveProperty('limit', 50)
    expect(res.body).toHaveProperty('offset', 0)
    expect(Array.isArray(res.body.emails)).toBe(true)
    expect(res.body.emails).toHaveLength(3)
    expect(res.body.total).toBe(3)
  })

  it('each email has a decrypted subject and no subject_enc', async () => {
    const { agent, id: userId, dataKey } = await createTestUser()
    const acctId = seedAccount(userId)
    seedEmail(userId, { accountId: acctId, subject: 'Hello World', dataKey })

    const res = await agent.get('/api/emails')
    expect(res.status).toBe(200)
    expect(res.body.emails[0].subject).toBe('Hello World')
    expect(res.body.emails[0].subject_enc).toBeUndefined()
  })

  it('respects limit and offset for pagination', async () => {
    const { agent, id: userId, dataKey } = await createTestUser()
    const acctId = seedAccount(userId)
    for (let i = 0; i < 5; i++) {
      seedEmail(userId, { accountId: acctId, dataKey, receivedAt: Date.now() - i * 1000 })
    }

    const page1 = await agent.get('/api/emails?limit=3&offset=0')
    const page2 = await agent.get('/api/emails?limit=3&offset=3')

    expect(page1.body.emails).toHaveLength(3)
    expect(page2.body.emails).toHaveLength(2)
    expect(page1.body.total).toBe(5)
  })

  it('does not return another user\'s emails', async () => {
    const { id: userId1 } = await createTestUser()
    const { agent: agent2 } = await createTestUser()
    seedEmail(userId1, {})

    const res = await agent2.get('/api/emails')
    expect(res.status).toBe(200)
    expect(res.body.emails).toHaveLength(0)
  })

  it('returns 400 for limit above 100', async () => {
    const { agent } = await createTestUser()
    const res = await agent.get('/api/emails?limit=200')
    expect(res.status).toBe(400)
  })
})

describe('GET /api/emails/:id', () => {
  it('returns 401 without session', async () => {
    const { default: request } = await import('supertest')
    const { app } = await import('../../src/server')
    const res = await request(app).get('/api/emails/some-id')
    expect(res.status).toBe(401)
  })

  it('returns 404 for a non-existent email id', async () => {
    const { agent } = await createTestUser()
    const res = await agent.get('/api/emails/does-not-exist')
    expect(res.status).toBe(404)
  })

  it('returns the email with decrypted subject when found', async () => {
    const { agent, id: userId, dataKey } = await createTestUser()
    const acctId = seedAccount(userId)
    const { emailId } = seedEmail(userId, { accountId: acctId, subject: 'My TNB bill', dataKey })

    const res = await agent.get(`/api/emails/${emailId}`)
    expect(res.status).toBe(200)
    expect(res.body.id).toBe(emailId)
    expect(res.body.subject).toBe('My TNB bill')
    expect(res.body.subject_enc).toBeUndefined()
  })

  it('returns 404 when the email belongs to a different user', async () => {
    const { id: userId1 } = await createTestUser()
    const { agent: agent2 } = await createTestUser()
    const acctId = seedAccount(userId1)
    const { emailId } = seedEmail(userId1, { accountId: acctId })

    const res = await agent2.get(`/api/emails/${emailId}`)
    expect(res.status).toBe(404)
  })
})

describe('PATCH /api/emails/:id/read', () => {
  it('returns 401 without session', async () => {
    const { default: request } = await import('supertest')
    const { app } = await import('../../src/server')
    const res = await request(app).patch('/api/emails/some-id/read')
    expect(res.status).toBe(401)
  })

  it('marks an unread email as read', async () => {
    const { agent, id: userId } = await createTestUser()
    const acctId = seedAccount(userId)
    const { emailId } = seedEmail(userId, { accountId: acctId, isRead: false })

    const res = await agent.patch(`/api/emails/${emailId}/read`)
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)

    const row = getDb().prepare('SELECT is_read FROM emails WHERE id = ?').get(emailId) as any
    expect(row.is_read).toBe(1)
  })

  it('is idempotent — marking an already-read email read returns 200', async () => {
    const { agent, id: userId } = await createTestUser()
    const acctId = seedAccount(userId)
    const { emailId } = seedEmail(userId, { accountId: acctId, isRead: true })

    const res = await agent.patch(`/api/emails/${emailId}/read`)
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
  })

  it('silently ignores an email that belongs to another user', async () => {
    const { id: userId1 } = await createTestUser()
    const { agent: agent2 } = await createTestUser()
    const acctId = seedAccount(userId1)
    const { emailId } = seedEmail(userId1, { accountId: acctId, isRead: false })

    // Should return 200 (no error), but the row should not have changed
    const res = await agent2.patch(`/api/emails/${emailId}/read`)
    expect(res.status).toBe(200)

    const row = getDb().prepare('SELECT is_read FROM emails WHERE id = ?').get(emailId) as any
    expect(row.is_read).toBe(0) // still unread
  })
})

describe('DELETE /api/emails', () => {
  it('returns 401 without session', async () => {
    const { default: request } = await import('supertest')
    const { app } = await import('../../src/server')
    const res = await request(app).delete('/api/emails')
    expect(res.status).toBe(401)
  })

  it('deletes all emails for the current user', async () => {
    const { agent, id: userId } = await createTestUser()
    const acctId = seedAccount(userId)
    seedEmail(userId, { accountId: acctId })
    seedEmail(userId, { accountId: acctId })

    const res = await agent.delete('/api/emails')
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)

    const count = getDb().prepare(
      'SELECT COUNT(*) as n FROM emails WHERE account_id = ?'
    ).get(acctId) as any
    expect(count.n).toBe(0)
  })

  it('resets last_synced on all accounts for the current user', async () => {
    const { agent, id: userId } = await createTestUser()
    const acctId = seedAccount(userId)
    getDb().prepare('UPDATE accounts SET last_synced = ? WHERE id = ?').run(Date.now(), acctId)

    await agent.delete('/api/emails')

    const row = getDb().prepare('SELECT last_synced FROM accounts WHERE id = ?').get(acctId) as any
    expect(row.last_synced).toBeNull()
  })

  it('does not delete another user\'s emails', async () => {
    const { id: userId1 } = await createTestUser()
    const { agent: agent2 } = await createTestUser()
    const acctId = seedAccount(userId1)
    seedEmail(userId1, { accountId: acctId })

    await agent2.delete('/api/emails')

    const count = getDb().prepare(
      'SELECT COUNT(*) as n FROM emails WHERE account_id = ?'
    ).get(acctId) as any
    expect(count.n).toBe(1) // still there
  })
})

describe('GET /api/emails — folder filter', () => {
  it('folder=inbox returns only inbox emails', async () => {
    const { agent, id: userId, dataKey } = await createTestUser()
    const acctId = seedAccount(userId)
    seedEmail(userId, { accountId: acctId, folder: 'inbox', dataKey })
    seedEmail(userId, { accountId: acctId, folder: 'spam', dataKey })
    seedEmail(userId, { accountId: acctId, folder: 'sent', dataKey })

    const res = await agent.get('/api/emails?folder=inbox')
    expect(res.status).toBe(200)
    expect(res.body.emails.every((e: any) => e.folder === 'inbox')).toBe(true)
    expect(res.body.emails).toHaveLength(1)
  })

  it('folder=spam returns only spam emails', async () => {
    const { agent, id: userId, dataKey } = await createTestUser()
    const acctId = seedAccount(userId)
    seedEmail(userId, { accountId: acctId, folder: 'spam', dataKey })
    seedEmail(userId, { accountId: acctId, folder: 'inbox', dataKey })

    const res = await agent.get('/api/emails?folder=spam')
    expect(res.status).toBe(200)
    expect(res.body.emails).toHaveLength(1)
    expect(res.body.emails[0].folder).toBe('spam')
  })

  it('folder=sent returns only sent emails', async () => {
    const { agent, id: userId, dataKey } = await createTestUser()
    const acctId = seedAccount(userId)
    seedEmail(userId, { accountId: acctId, folder: 'sent', dataKey })
    seedEmail(userId, { accountId: acctId, folder: 'inbox', dataKey })

    const res = await agent.get('/api/emails?folder=sent')
    expect(res.status).toBe(200)
    expect(res.body.emails).toHaveLength(1)
    expect(res.body.emails[0].folder).toBe('sent')
  })

  it('returns 400 for an invalid folder value', async () => {
    const { agent } = await createTestUser()
    const res = await agent.get('/api/emails?folder=invalid')
    expect(res.status).toBe(400)
  })
})

describe('GET /api/emails — tab filter', () => {
  it('tab=promotions returns only promotions-tab emails', async () => {
    const { agent, id: userId, dataKey } = await createTestUser()
    const acctId = seedAccount(userId)
    seedEmail(userId, { accountId: acctId, tab: 'promotions', dataKey })
    seedEmail(userId, { accountId: acctId, tab: 'primary', dataKey })

    const res = await agent.get('/api/emails?tab=promotions')
    expect(res.status).toBe(200)
    expect(res.body.emails).toHaveLength(1)
    expect(res.body.emails[0].tab).toBe('promotions')
  })

  it('tab=primary returns only primary-tab emails', async () => {
    const { agent, id: userId, dataKey } = await createTestUser()
    const acctId = seedAccount(userId)
    seedEmail(userId, { accountId: acctId, tab: 'primary', dataKey })
    seedEmail(userId, { accountId: acctId, tab: 'social', dataKey })

    const res = await agent.get('/api/emails?tab=primary')
    expect(res.status).toBe(200)
    expect(res.body.emails).toHaveLength(1)
    expect(res.body.emails[0].tab).toBe('primary')
  })

  it('returns 400 for an invalid tab value', async () => {
    const { agent } = await createTestUser()
    const res = await agent.get('/api/emails?tab=badtab')
    expect(res.status).toBe(400)
  })
})

describe('GET /api/emails — unread filter', () => {
  it('unread=1 returns only unread emails', async () => {
    const { agent, id: userId, dataKey } = await createTestUser()
    const acctId = seedAccount(userId)
    seedEmail(userId, { accountId: acctId, isRead: false, dataKey })
    seedEmail(userId, { accountId: acctId, isRead: false, dataKey })
    seedEmail(userId, { accountId: acctId, isRead: true, dataKey })

    const res = await agent.get('/api/emails?unread=1')
    expect(res.status).toBe(200)
    expect(res.body.emails).toHaveLength(2)
    expect(res.body.emails.every((e: any) => e.is_read === 0)).toBe(true)
  })

  it('unread=true also works as the flag value', async () => {
    const { agent, id: userId, dataKey } = await createTestUser()
    const acctId = seedAccount(userId)
    seedEmail(userId, { accountId: acctId, isRead: false, dataKey })
    seedEmail(userId, { accountId: acctId, isRead: true, dataKey })

    const res = await agent.get('/api/emails?unread=true')
    expect(res.status).toBe(200)
    expect(res.body.emails).toHaveLength(1)
  })

  it('without unread filter returns both read and unread', async () => {
    const { agent, id: userId, dataKey } = await createTestUser()
    const acctId = seedAccount(userId)
    seedEmail(userId, { accountId: acctId, isRead: false, dataKey })
    seedEmail(userId, { accountId: acctId, isRead: true, dataKey })

    const res = await agent.get('/api/emails')
    expect(res.status).toBe(200)
    expect(res.body.emails).toHaveLength(2)
  })
})

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
    const { default: request } = await import('supertest')
    const { app } = await import('../../src/server')
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
