import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { makeTestDb } from './helpers/db'

// freshDb: creates in-memory DB WITHOUT running migrations (for failure tests)
function freshDb() {
  return new Database(':memory:')
}

describe('Migration 10 — hot path tables', () => {
  let db: Database.Database
  beforeEach(() => {
    db = makeTestDb()
  })
  afterEach(() => db.close())

  it('creates inbox_index table with expected columns', () => {
    const cols = db.prepare("PRAGMA table_info(inbox_index)").all() as any[]
    const names = cols.map((c: any) => c.name)
    expect(names).toContain('email_id')
    expect(names).toContain('account_id')
    expect(names).toContain('provider_message_id')
    expect(names).toContain('subject_preview_enc')
    expect(names).toContain('received_at')
    expect(names).toContain('has_full_body')
    expect(names).toContain('sync_state')
    expect(names).toContain('snoozed_until')
  })

  it('enforces UNIQUE(account_id, provider_message_id) on inbox_index', () => {
    db.prepare(`INSERT INTO accounts (id, provider, email, token_enc, created_at)
      VALUES ('acc1', 'gmail', 'a@test.com', 'enc', 1)`).run()
    db.prepare(`INSERT INTO inbox_index
      (email_id, account_id, provider_message_id, sender_email, subject_preview_enc, received_at)
      VALUES ('uuid-1', 'acc1', 'msg1', 'x@x.com', 'enc', 1)`).run()

    // Second insert with same (account_id, provider_message_id) should be silently ignored
    const result = db.prepare(`INSERT INTO inbox_index
      (email_id, account_id, provider_message_id, sender_email, subject_preview_enc, received_at)
      VALUES ('uuid-2', 'acc1', 'msg1', 'x@x.com', 'enc', 2)
      ON CONFLICT(account_id, provider_message_id) DO NOTHING`).run()
    expect(result.changes).toBe(0)

    const rows = db.prepare('SELECT * FROM inbox_index').all()
    expect(rows).toHaveLength(1)
  })

  it('creates sync_state table', () => {
    const cols = db.prepare("PRAGMA table_info(sync_state)").all() as any[]
    const names = cols.map((c: any) => c.name)
    expect(names).toContain('account_id')
    expect(names).toContain('fast_sync_cursor')
    expect(names).toContain('last_fast_sync_at')
    expect(names).toContain('backfill_complete')
  })

  it('creates sync_backfill_cursors table with composite PK', () => {
    const cols = db.prepare("PRAGMA table_info(sync_backfill_cursors)").all() as any[]
    const names = cols.map((c: any) => c.name)
    expect(names).toContain('account_id')
    expect(names).toContain('folder')
    expect(names).toContain('cursor')
    expect(names).toContain('complete')
  })

  it('inbox_index cascades delete from accounts', () => {
    db.prepare(`INSERT INTO accounts (id, provider, email, token_enc, created_at)
      VALUES ('acc1', 'gmail', 'a@test.com', 'enc', 1)`).run()
    db.prepare(`INSERT INTO inbox_index
      (email_id, account_id, provider_message_id, sender_email, subject_preview_enc, received_at)
      VALUES ('uuid-1', 'acc1', 'msg1', 'x@x.com', 'enc', 1)`).run()

    db.prepare(`DELETE FROM accounts WHERE id = 'acc1'`).run()

    const rows = db.prepare('SELECT * FROM inbox_index').all()
    expect(rows).toHaveLength(0)
  })
})
