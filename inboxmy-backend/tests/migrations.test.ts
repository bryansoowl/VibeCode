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

describe('Migration 11 — heavy data tables', () => {
  let db: Database.Database
  beforeEach(() => {
    db = makeTestDb()
  })
  afterEach(() => db.close())

  it('creates email_body table with NOT NULL body_enc', () => {
    const cols = db.prepare("PRAGMA table_info(email_body)").all() as any[]
    const bodyCol = cols.find((c: any) => c.name === 'body_enc')
    expect(bodyCol).toBeTruthy()
    expect(bodyCol.notnull).toBe(1) // NOT NULL enforced
  })

  it('creates attachments table with expected columns', () => {
    const cols = db.prepare("PRAGMA table_info(attachments)").all() as any[]
    const names = cols.map((c: any) => c.name)
    expect(names).toContain('attachment_id')
    expect(names).toContain('email_id')
    expect(names).toContain('filename')
    expect(names).toContain('mime_type')
    expect(names).toContain('remote_ref')
    expect(names).toContain('download_state')
    expect(names).toContain('listed_at')
  })

  it('email_body FK cascades delete from inbox_index', () => {
    db.prepare(`INSERT INTO accounts (id, provider, email, token_enc, created_at)
      VALUES ('acc1', 'gmail', 'a@test.com', 'enc', 1)`).run()
    db.prepare(`INSERT INTO inbox_index
      (email_id, account_id, provider_message_id, sender_email, subject_preview_enc, received_at)
      VALUES ('uuid-1', 'acc1', 'msg1', 'x@x.com', 'enc', 1)`).run()
    db.prepare(`INSERT INTO email_body (email_id, body_enc, fetched_at)
      VALUES ('uuid-1', 'encrypted-body', 1)`).run()

    db.prepare(`DELETE FROM inbox_index WHERE email_id = 'uuid-1'`).run()

    const body = db.prepare(`SELECT * FROM email_body WHERE email_id = 'uuid-1'`).get()
    expect(body).toBeUndefined()
  })

  it('attachments FK cascades delete from inbox_index', () => {
    db.prepare(`INSERT INTO accounts (id, provider, email, token_enc, created_at)
      VALUES ('acc1', 'gmail', 'a@test.com', 'enc', 1)`).run()
    db.prepare(`INSERT INTO inbox_index
      (email_id, account_id, provider_message_id, sender_email, subject_preview_enc, received_at)
      VALUES ('uuid-1', 'acc1', 'msg1', 'x@x.com', 'enc', 1)`).run()
    db.prepare(`INSERT INTO attachments (attachment_id, email_id, filename, listed_at)
      VALUES ('att-1', 'uuid-1', 'file.pdf', 1)`).run()

    db.prepare(`DELETE FROM inbox_index WHERE email_id = 'uuid-1'`).run()

    const att = db.prepare(`SELECT * FROM attachments WHERE attachment_id = 'att-1'`).get()
    expect(att).toBeUndefined()
  })
})

describe('Migration 12 — sync_state adaptive batch columns', () => {
  let db: Database.Database
  beforeEach(() => { db = makeTestDb() })
  afterEach(() => db.close())

  it('adds last_batch_size with default 100 to sync_state', () => {
    const cols = db.prepare("PRAGMA table_info(sync_state)").all() as any[]
    const col = cols.find((c: any) => c.name === 'last_batch_size')
    expect(col).toBeDefined()
    expect(col.dflt_value).toBe('100')
  })

  it('adds last_batch_duration_ms (nullable) to sync_state', () => {
    const cols = db.prepare("PRAGMA table_info(sync_state)").all() as any[]
    const col = cols.find((c: any) => c.name === 'last_batch_duration_ms')
    expect(col).toBeDefined()
    expect(col.notnull).toBe(0)
  })

  it('can insert a sync_state row and read back last_batch_size', () => {
    db.prepare(`INSERT INTO accounts (id, provider, email, token_enc, created_at)
      VALUES ('acc-m', 'gmail', 'm@t.com', 'e', 1)`).run()
    db.prepare(`INSERT INTO sync_state (account_id, last_batch_size, last_batch_duration_ms)
      VALUES ('acc-m', 75, 4200)`).run()
    const row = db.prepare("SELECT * FROM sync_state WHERE account_id='acc-m'").get() as any
    expect(row.last_batch_size).toBe(75)
    expect(row.last_batch_duration_ms).toBe(4200)
  })
})
