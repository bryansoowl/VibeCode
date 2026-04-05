import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { makeTestDb } from './helpers/db'
import type Database from 'better-sqlite3'

// ── DB mock ──────────────────────────────────────────────────────────────────
let testDb: Database.Database

vi.mock('../src/db', () => ({ getDb: () => testDb }))

// ── Provider mock — returns 2 emails, no body ─────────────────────────────────
vi.mock('../src/email/gmail-client', () => ({
  fetchNewEmails: vi.fn().mockResolvedValue({
    emails: [
      {
        id: 'gmail-msg-1', accountId: 'acc-1', threadId: 'thread-1',
        subject: 'Hello', sender: 'a@example.com', senderName: 'Alice',
        receivedAt: 1_700_000_000_000, isRead: false,
        folder: 'inbox', tab: 'primary', isImportant: false,
        category: null, bodyHtml: '<p>Hi</p>', bodyText: null,
        snippet: 'Hi there', rawSize: 1024,
      },
      {
        id: 'gmail-msg-2', accountId: 'acc-1', threadId: null,
        subject: 'World', sender: 'b@example.com', senderName: null,
        receivedAt: 1_699_000_000_000, isRead: true,
        folder: 'inbox', tab: 'primary', isImportant: true,
        category: 'bill', bodyHtml: null, bodyText: 'Body text',
        snippet: 'World snippet', rawSize: 512,
      },
    ],
    newHistoryId: 'history-abc',
  }),
}))

vi.mock('../src/email/outlook-client', () => ({
  fetchNewEmails: vi.fn().mockResolvedValue([]),
}))

vi.mock('../src/parsers', () => ({
  parseEmail: vi.fn().mockReturnValue({ category: null, bill: null }),
}))

vi.mock('../src/parsers/spam-scorer', () => ({
  scoreSpam: vi.fn().mockReturnValue({ isSpam: false }),
}))

// ── Tests ─────────────────────────────────────────────────────────────────────
describe('syncAccount — inbox_index writes', () => {
  const TEST_DATA_KEY = Buffer.alloc(32, 0x42)

  beforeEach(() => {
    testDb = makeTestDb()
    // Insert prerequisite user + account
    testDb.prepare(`
      INSERT INTO users (id, email, password_hash, pbkdf2_salt, data_key_enc, recovery_enc, created_at)
      VALUES ('user-1', 'user@test.com', 'hash', 'salt', 'enc', 'enc', 1)
    `).run()
    testDb.prepare(`
      INSERT INTO accounts (id, provider, email, token_enc, created_at, user_id)
      VALUES ('acc-1', 'gmail', 'a@test.com', 'enc', 1, 'user-1')
    `).run()
  })

  afterEach(() => testDb.close())

  it('inserts emails into inbox_index after sync', async () => {
    const { syncAccount } = await import('../src/email/sync-engine')
    await syncAccount('acc-1', TEST_DATA_KEY)

    const rows = testDb.prepare('SELECT * FROM inbox_index ORDER BY received_at DESC').all() as any[]
    expect(rows).toHaveLength(2)
    expect(rows[0].provider_message_id).toBe('gmail-msg-1')
    expect(rows[0].sender_email).toBe('a@example.com')
    expect(rows[0].is_read).toBe(0)
    expect(rows[0].is_important).toBe(0)
    expect(rows[0].sync_state).toBe('partial')
    expect(rows[0].has_full_body).toBe(0)
  })

  it('email_id in inbox_index is a UUID (not the provider message id)', async () => {
    const { syncAccount } = await import('../src/email/sync-engine')
    await syncAccount('acc-1', TEST_DATA_KEY)

    const row = testDb.prepare('SELECT email_id, provider_message_id FROM inbox_index WHERE provider_message_id = ?')
      .get('gmail-msg-1') as any
    expect(row).toBeTruthy()
    expect(row.email_id).not.toBe('gmail-msg-1')
    expect(row.email_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
  })

  it('subject_preview_enc is encrypted (not plaintext)', async () => {
    const { syncAccount } = await import('../src/email/sync-engine')
    await syncAccount('acc-1', TEST_DATA_KEY)

    const row = testDb.prepare('SELECT subject_preview_enc FROM inbox_index WHERE provider_message_id = ?')
      .get('gmail-msg-1') as any
    expect(row.subject_preview_enc).not.toBe('Hello')
    expect(row.subject_preview_enc.length).toBeGreaterThan(10)
  })

  it('is idempotent — running sync twice does not duplicate inbox_index rows', async () => {
    const { syncAccount } = await import('../src/email/sync-engine')
    await syncAccount('acc-1', TEST_DATA_KEY)
    await syncAccount('acc-1', TEST_DATA_KEY)

    const count = (testDb.prepare('SELECT COUNT(*) as n FROM inbox_index').get() as any).n
    expect(count).toBe(2)
  })

  it('updates sync_state after sync', async () => {
    const { syncAccount } = await import('../src/email/sync-engine')
    await syncAccount('acc-1', TEST_DATA_KEY)

    const state = testDb.prepare('SELECT * FROM sync_state WHERE account_id = ?').get('acc-1') as any
    expect(state).toBeTruthy()
    expect(state.fast_sync_cursor).toBe('history-abc')
    expect(state.last_fast_sync_at).toBeGreaterThan(0)
  })

  it('seeds sync_backfill_cursors for inbox, sent, spam', async () => {
    const { syncAccount } = await import('../src/email/sync-engine')
    await syncAccount('acc-1', TEST_DATA_KEY)

    const cursors = testDb.prepare('SELECT folder FROM sync_backfill_cursors WHERE account_id = ?')
      .all('acc-1') as any[]
    const folders = cursors.map(c => c.folder).sort()
    expect(folders).toEqual(['inbox', 'sent', 'spam'])
  })
})
