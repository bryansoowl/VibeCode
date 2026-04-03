// tests/email/sync-engine.test.ts
import { vi, describe, it, expect, beforeEach, afterAll } from 'vitest'

vi.mock('../../src/email/gmail-client', () => ({ fetchNewEmails: vi.fn() }))
vi.mock('../../src/email/outlook-client', () => ({ fetchNewEmails: vi.fn() }))

import { fetchNewEmails as mockGmailFetch } from '../../src/email/gmail-client'
import { fetchNewEmails as mockOutlookFetch } from '../../src/email/outlook-client'
import { syncAccount } from '../../src/email/sync-engine'
import { getDb, closeDb } from '../../src/db'
import { encryptSystem } from '../../src/crypto'
import { randomUUID } from 'crypto'

afterAll(() => closeDb())

// Note: Task 1 must be fully complete (migration applied to data-test DB) before running these tests.
// Do NOT include token_expired in the INSERT — let it default to 0 via the DEFAULT constraint.
function seedAccount(id: string, provider: 'gmail' | 'outlook' = 'gmail') {
  getDb().prepare(`
    INSERT OR IGNORE INTO accounts
      (id, provider, email, token_enc, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, provider, `${id}@sync-test.com`, encryptSystem('{}'), Date.now())
}

const TEST_KEY = Buffer.alloc(32)

describe('syncAccount — token_expired flag', () => {
  beforeEach(() => { vi.resetAllMocks() })

  it('sets token_expired = 1 when Gmail fetch throws invalid_grant', async () => {
    const id = randomUUID()
    seedAccount(id, 'gmail')
    vi.mocked(mockGmailFetch).mockRejectedValue(new Error('invalid_grant'))
    await syncAccount(id, TEST_KEY)
    const row = getDb().prepare('SELECT token_expired FROM accounts WHERE id = ?').get(id) as any
    expect(row.token_expired).toBe(1)
  })

  it('sets token_expired = 1 when Outlook fetch throws re-auth required', async () => {
    const id = randomUUID()
    seedAccount(id, 'outlook')
    vi.mocked(mockOutlookFetch).mockRejectedValue(
      new Error('Outlook account not found in MSAL cache — re-auth required')
    )
    await syncAccount(id, TEST_KEY)
    const row = getDb().prepare('SELECT token_expired FROM accounts WHERE id = ?').get(id) as any
    expect(row.token_expired).toBe(1)
  })

  it('does NOT set token_expired = 1 for non-auth errors', async () => {
    const id = randomUUID()
    seedAccount(id, 'gmail')
    vi.mocked(mockGmailFetch).mockRejectedValue(new Error('Network timeout'))
    await syncAccount(id, TEST_KEY)
    const row = getDb().prepare('SELECT token_expired FROM accounts WHERE id = ?').get(id) as any
    expect(row.token_expired).toBe(0)
  })

  it('clears token_expired to 0 on successful sync even if previously 1', async () => {
    const id = randomUUID()
    seedAccount(id, 'gmail')
    getDb().prepare('UPDATE accounts SET token_expired = 1 WHERE id = ?').run(id)
    vi.mocked(mockGmailFetch).mockResolvedValue({ emails: [], newHistoryId: null })
    await syncAccount(id, TEST_KEY)
    const row = getDb().prepare('SELECT token_expired FROM accounts WHERE id = ?').get(id) as any
    expect(row.token_expired).toBe(0)
  })

  it('leaves token_expired = 1 unchanged when non-auth error occurs on already-expired account', async () => {
    const id = randomUUID()
    seedAccount(id, 'gmail')
    getDb().prepare('UPDATE accounts SET token_expired = 1 WHERE id = ?').run(id)
    vi.mocked(mockGmailFetch).mockRejectedValue(new Error('Network timeout'))
    await syncAccount(id, TEST_KEY)
    const row = getDb().prepare('SELECT token_expired FROM accounts WHERE id = ?').get(id) as any
    expect(row.token_expired).toBe(1)
  })
})

describe('syncAccount — newEmails return', () => {
  beforeEach(() => { vi.resetAllMocks() })

  it('returns newEmails with plaintext subject and sender for each newly inserted email', async () => {
    const id = randomUUID()
    seedAccount(id, 'gmail')

    const email: import('../../src/email/types').NormalizedEmail = {
      id: randomUUID(),
      accountId: id,
      threadId: null,
      subject: 'Your TNB bill is ready',
      sender: 'billing@tnb.com.my',
      senderName: 'TNB Billing',
      receivedAt: Date.now(),
      isRead: false,
      folder: 'inbox',
      tab: 'primary',
      isImportant: false,
      category: 'bill',
      bodyHtml: null,
      bodyText: null,
      snippet: null,
      rawSize: 100,
    }

    vi.mocked(mockGmailFetch).mockResolvedValue({ emails: [email], newHistoryId: null })

    const result = await syncAccount(id, TEST_KEY)

    expect(result.added).toBe(1)
    expect(result.newEmails).toHaveLength(1)
    expect(result.newEmails[0].id).toBe(email.id)
    expect(result.newEmails[0].sender).toBe('billing@tnb.com.my')
    expect(result.newEmails[0].senderName).toBe('TNB Billing')
    expect(result.newEmails[0].subject).toBe('Your TNB bill is ready')
    expect(result.newEmails[0].accountId).toBe(id)
  })

  it('returns empty newEmails when no new emails are fetched', async () => {
    const id = randomUUID()
    seedAccount(id, 'gmail')
    vi.mocked(mockGmailFetch).mockResolvedValue({ emails: [], newHistoryId: null })

    const result = await syncAccount(id, TEST_KEY)

    expect(result.added).toBe(0)
    expect(result.newEmails).toHaveLength(0)
  })

  it('does not include duplicate emails in newEmails on second sync', async () => {
    const id = randomUUID()
    seedAccount(id, 'gmail')

    const email: import('../../src/email/types').NormalizedEmail = {
      id: randomUUID(), accountId: id, threadId: null,
      subject: 'Duplicate test', sender: 'a@b.com', senderName: null,
      receivedAt: Date.now(), isRead: false, folder: 'inbox', tab: 'primary',
      isImportant: false, category: null, bodyHtml: null, bodyText: null,
      snippet: null, rawSize: 50,
    }

    vi.mocked(mockGmailFetch).mockResolvedValue({ emails: [email], newHistoryId: null })
    await syncAccount(id, TEST_KEY)       // first sync — inserts

    vi.mocked(mockGmailFetch).mockResolvedValue({ emails: [email], newHistoryId: null })
    const result = await syncAccount(id, TEST_KEY)   // second sync — INSERT OR IGNORE skips it

    expect(result.added).toBe(0)
    expect(result.newEmails).toHaveLength(0)
  })

  it('slices subject to 200 chars', async () => {
    const id = randomUUID()
    seedAccount(id, 'gmail')

    const longSubject = 'A'.repeat(300)
    const email: import('../../src/email/types').NormalizedEmail = {
      id: randomUUID(), accountId: id, threadId: null, subject: longSubject,
      sender: 'a@b.com', senderName: null, receivedAt: Date.now(), isRead: false,
      folder: 'inbox', tab: 'primary', isImportant: false, category: null,
      bodyHtml: null, bodyText: null, snippet: null, rawSize: 50,
    }

    vi.mocked(mockGmailFetch).mockResolvedValue({ emails: [email], newHistoryId: null })
    const result = await syncAccount(id, TEST_KEY)

    expect(result.newEmails[0].subject).toHaveLength(200)
  })
})

describe('syncAllAccounts — returns accumulated results', () => {
  beforeEach(() => { vi.resetAllMocks() })

  it('returns combined added count and newEmails across all accounts for a user', async () => {
    const { getDb } = await import('../../src/db')
    const { encryptSystem } = await import('../../src/crypto')
    const userId = randomUUID()
    const db = getDb()

    // users table: id, email, password_hash, pbkdf2_salt, data_key_enc, recovery_enc, created_at
    db.prepare(`INSERT OR IGNORE INTO users (id, email, password_hash, pbkdf2_salt, data_key_enc, recovery_enc, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(userId, `${userId}@test.com`, 'hash', 'salt', encryptSystem('key'), encryptSystem('rec'), Date.now())

    const acc1 = randomUUID()
    const acc2 = randomUUID()
    db.prepare(`INSERT INTO accounts (id, provider, email, token_enc, created_at, user_id)
      VALUES (?, 'gmail', ?, ?, ?, ?)`
    ).run(acc1, `${acc1}@test.com`, encryptSystem('{}'), Date.now(), userId)
    db.prepare(`INSERT INTO accounts (id, provider, email, token_enc, created_at, user_id)
      VALUES (?, 'gmail', ?, ?, ?, ?)`
    ).run(acc2, `${acc2}@test.com`, encryptSystem('{}'), Date.now(), userId)

    const makeEmail = (accountId: string): import('../../src/email/types').NormalizedEmail => ({
      id: randomUUID(), accountId, threadId: null, subject: `Email for ${accountId}`,
      sender: 'a@b.com', senderName: 'Sender', receivedAt: Date.now(), isRead: false,
      folder: 'inbox', tab: 'primary', isImportant: false, category: null,
      bodyHtml: null, bodyText: null, snippet: null, rawSize: 50,
    })

    vi.mocked(mockGmailFetch)
      .mockResolvedValueOnce({ emails: [makeEmail(acc1)], newHistoryId: null })
      .mockResolvedValueOnce({ emails: [makeEmail(acc2)], newHistoryId: null })

    const { syncAllAccounts } = await import('../../src/email/sync-engine')
    const result = await syncAllAccounts(userId, TEST_KEY)

    expect(result.added).toBe(2)
    expect(result.newEmails).toHaveLength(2)
    const accountIds = result.newEmails.map(e => e.accountId)
    expect(accountIds).toContain(acc1)
    expect(accountIds).toContain(acc2)
  })
})

describe('syncAccount — concurrent sync does not double-insert', () => {
  beforeEach(() => { vi.resetAllMocks() })

  it('two concurrent syncAccount calls for the same account insert each email exactly once', async () => {
    const id = randomUUID()
    seedAccount(id, 'gmail')

    const emailId = randomUUID()
    const email: import('../../src/email/types').NormalizedEmail = {
      id: emailId, accountId: id, threadId: null, subject: 'Concurrent test',
      sender: 'a@b.com', senderName: null, receivedAt: Date.now(), isRead: false,
      folder: 'inbox', tab: 'primary', isImportant: false, category: null,
      bodyHtml: null, bodyText: null, snippet: null, rawSize: 50,
    }

    // Both calls return the same email — INSERT OR IGNORE should prevent duplicates
    vi.mocked(mockGmailFetch).mockResolvedValue({ emails: [email], newHistoryId: null })

    const [r1, r2] = await Promise.all([
      syncAccount(id, TEST_KEY),
      syncAccount(id, TEST_KEY),
    ])

    const count = getDb()
      .prepare('SELECT COUNT(*) as n FROM emails WHERE id = ?')
      .get(emailId) as any

    expect(count.n).toBe(1)  // exactly one row, not two
    // Combined added count from both calls is 1 (one inserted, one was IGNORE'd)
    expect(r1.added + r2.added).toBe(1)
  })
})
