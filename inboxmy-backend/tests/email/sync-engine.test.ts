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
    vi.mocked(mockGmailFetch).mockResolvedValue([])
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
