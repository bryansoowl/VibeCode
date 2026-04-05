import Database from 'better-sqlite3'
import { runMigrations } from '../../src/db/migrations'

export function makeTestDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  runMigrations(db)
  // Caller is responsible for closing: afterEach(() => db.close())
  return db
}
