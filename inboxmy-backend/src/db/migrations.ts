// src/db/migrations.ts
import Database from 'better-sqlite3'

const MIGRATIONS: string[] = [
  // Migration 1: initial schema
  `
  CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY, provider TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE, label TEXT,
    token_enc TEXT NOT NULL, created_at INTEGER NOT NULL,
    last_synced INTEGER
  );
  CREATE TABLE IF NOT EXISTS emails (
    id TEXT PRIMARY KEY, account_id TEXT NOT NULL
      REFERENCES accounts(id) ON DELETE CASCADE,
    thread_id TEXT, subject_enc TEXT NOT NULL,
    sender TEXT NOT NULL, sender_name TEXT,
    received_at INTEGER NOT NULL, is_read INTEGER NOT NULL DEFAULT 0,
    category TEXT, body_enc TEXT, snippet TEXT, raw_size INTEGER
  );
  CREATE TABLE IF NOT EXISTS parsed_bills (
    id TEXT PRIMARY KEY, email_id TEXT NOT NULL
      REFERENCES emails(id) ON DELETE CASCADE,
    biller TEXT NOT NULL, amount_rm REAL, due_date INTEGER,
    account_ref TEXT, status TEXT DEFAULT 'unpaid', parsed_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sync_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL,
    started_at INTEGER NOT NULL, finished_at INTEGER,
    emails_added INTEGER DEFAULT 0, error TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_emails_account ON emails(account_id);
  CREATE INDEX IF NOT EXISTS idx_emails_category ON emails(category);
  CREATE INDEX IF NOT EXISTS idx_emails_received ON emails(received_at DESC);
  CREATE INDEX IF NOT EXISTS idx_bills_due ON parsed_bills(due_date);
  `,
  // Migration 2: multi-user auth
  `
  CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    email         TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    pbkdf2_salt   TEXT NOT NULL,
    data_key_enc  TEXT NOT NULL,
    recovery_enc  TEXT NOT NULL,
    created_at    INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key_enc    TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
  CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    used       INTEGER NOT NULL DEFAULT 0
  );
  ALTER TABLE accounts ADD COLUMN user_id TEXT REFERENCES users(id) ON DELETE CASCADE;
  CREATE INDEX IF NOT EXISTS idx_accounts_user ON accounts(user_id);
  `,
  // Migration 3: per-email folder and importance flag
  `
  ALTER TABLE emails ADD COLUMN folder TEXT NOT NULL DEFAULT 'inbox';
  ALTER TABLE emails ADD COLUMN is_important INTEGER NOT NULL DEFAULT 0;
  CREATE INDEX IF NOT EXISTS idx_emails_folder ON emails(folder);
  `,
  // Migration 4: Gmail inbox tab (primary / promotions / social / updates / forums)
  `
  ALTER TABLE emails ADD COLUMN tab TEXT NOT NULL DEFAULT 'primary';
  CREATE INDEX IF NOT EXISTS idx_emails_tab ON emails(tab);
  `,
  // Migration 5: per-account token expiry flag
  `ALTER TABLE accounts ADD COLUMN token_expired INTEGER NOT NULL DEFAULT 0;`,
  // Migration 6: Gmail History API ID for incremental sync
  `ALTER TABLE accounts ADD COLUMN gmail_history_id TEXT;`,
  // Migration 7: snooze, labels, email-label junction
  `
  ALTER TABLE emails ADD COLUMN snoozed_until INTEGER;
  CREATE INDEX IF NOT EXISTS idx_emails_snoozed ON emails(snoozed_until)
    WHERE snoozed_until IS NOT NULL;
  CREATE TABLE IF NOT EXISTS labels (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    color      TEXT NOT NULL DEFAULT '#6B7280',
    created_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_labels_user_name ON labels(user_id, name);
  CREATE INDEX IF NOT EXISTS idx_labels_user ON labels(user_id);
  CREATE TABLE IF NOT EXISTS email_labels (
    email_id  TEXT NOT NULL REFERENCES emails(id) ON DELETE CASCADE,
    label_id  TEXT NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
    PRIMARY KEY (email_id, label_id)
  );
  CREATE INDEX IF NOT EXISTS idx_email_labels_label ON email_labels(label_id);
  `,
  // Migration 8: composite index for fast unread count aggregation
  `CREATE INDEX IF NOT EXISTS idx_emails_unread
    ON emails(account_id, folder, is_read, tab, snoozed_until)`,
  // Migration 9: persist MSAL token cache per Outlook account so refresh tokens survive restarts
  `ALTER TABLE accounts ADD COLUMN msal_cache TEXT`,
  // Migration 10: Progressive sync hot path tables
  `
  CREATE TABLE IF NOT EXISTS inbox_index (
    email_id             TEXT PRIMARY KEY,
    account_id           TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    provider_message_id  TEXT NOT NULL,
    thread_id            TEXT,
    sender_email         TEXT NOT NULL,
    sender_name          TEXT,
    subject_preview_enc  TEXT NOT NULL,
    snippet_preview_enc  TEXT,
    received_at          INTEGER NOT NULL,
    folder               TEXT NOT NULL DEFAULT 'inbox',
    tab                  TEXT NOT NULL DEFAULT 'primary',
    is_read              INTEGER NOT NULL DEFAULT 0,
    is_important         INTEGER NOT NULL DEFAULT 0,
    has_full_body        INTEGER NOT NULL DEFAULT 0,
    sync_state           TEXT NOT NULL DEFAULT 'partial',
    snoozed_until        INTEGER,
    category             TEXT,
    UNIQUE(account_id, provider_message_id)
  );

  CREATE INDEX IF NOT EXISTS idx_inbox_hot
    ON inbox_index(account_id, folder, tab, received_at DESC, email_id DESC)
    WHERE snoozed_until IS NULL;

  CREATE INDEX IF NOT EXISTS idx_inbox_backfill
    ON inbox_index(account_id, folder, received_at DESC, email_id DESC);

  CREATE INDEX IF NOT EXISTS idx_inbox_unread
    ON inbox_index(account_id, folder, is_read, tab, snoozed_until);

  CREATE TABLE IF NOT EXISTS sync_state (
    account_id           TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
    last_fast_sync_at    INTEGER,
    fast_sync_cursor     TEXT,
    last_backfill_at     INTEGER,
    backfill_complete    INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS sync_backfill_cursors (
    account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    folder      TEXT NOT NULL,
    cursor      TEXT,
    complete    INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (account_id, folder)
  );
  `,
  // Migration 11: Lazy-loaded heavy data tables
  `
  CREATE TABLE IF NOT EXISTS email_body (
    email_id         TEXT PRIMARY KEY REFERENCES inbox_index(email_id) ON DELETE CASCADE,
    body_enc         TEXT NOT NULL,
    body_format      TEXT NOT NULL DEFAULT 'text',
    raw_headers_enc  TEXT,
    fetched_at       INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS attachments (
    attachment_id  TEXT PRIMARY KEY,
    email_id       TEXT NOT NULL REFERENCES inbox_index(email_id) ON DELETE CASCADE,
    filename       TEXT NOT NULL,
    mime_type      TEXT NOT NULL DEFAULT 'application/octet-stream',
    size_bytes     INTEGER,
    remote_ref     TEXT,
    download_state TEXT NOT NULL DEFAULT 'not_downloaded',
    local_path     TEXT,
    listed_at      INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_attachments_email ON attachments(email_id);
  `,
  // Migration 12: adaptive batch sizing columns on sync_state
  `
  ALTER TABLE sync_state ADD COLUMN last_batch_size INTEGER NOT NULL DEFAULT 100;
  ALTER TABLE sync_state ADD COLUMN last_batch_duration_ms INTEGER;
  `,
]

export function runMigrations(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)`)
  const row = db.prepare('SELECT MAX(version) as v FROM schema_version').get() as any
  const current = row?.v ?? 0

  for (let i = current; i < MIGRATIONS.length; i++) {
    db.exec(MIGRATIONS[i])
    db.prepare('INSERT OR REPLACE INTO schema_version VALUES (?)').run(i + 1)
  }
}
