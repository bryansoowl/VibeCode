// src/db/index.ts
import Database from 'better-sqlite3'
import path from 'path'
import fs from 'fs'
import { config } from '../config'
import { runMigrations } from './migrations'

if (!process.env.ENCRYPTION_KEY) {
  throw new Error('ENCRYPTION_KEY must be set — see .env.example')
}

let _db: Database.Database | null = null

export function getDb(): Database.Database {
  if (_db) return _db

  const dir = path.resolve(config.dataDir)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })

  _db = new Database(path.join(dir, 'inboxmy.db'))
  _db.pragma('journal_mode = WAL')
  _db.pragma('foreign_keys = ON')
  runMigrations(_db)
  return _db
}

export function closeDb(): void {
  if (_db) {
    _db.close()
    _db = null
  }
}
