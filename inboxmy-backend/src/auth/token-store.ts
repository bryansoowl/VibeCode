// src/auth/token-store.ts
import { getDb } from '../db'
import { encrypt, decrypt } from '../crypto'

export interface OAuthToken {
  accessToken: string
  refreshToken: string
  expiryMs: number
}

export function saveToken(accountId: string, token: OAuthToken): void {
  const db = getDb()
  const enc = encrypt(JSON.stringify(token))
  db.prepare(
    'UPDATE accounts SET token_enc = ? WHERE id = ?'
  ).run(enc, accountId)
}

export function loadToken(accountId: string): OAuthToken {
  const db = getDb()
  const row = db.prepare('SELECT token_enc FROM accounts WHERE id = ?').get(accountId) as any
  if (!row) throw new Error(`Account ${accountId} not found`)
  return JSON.parse(decrypt(row.token_enc))
}
