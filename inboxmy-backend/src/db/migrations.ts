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
