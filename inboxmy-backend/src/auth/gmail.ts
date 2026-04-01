// src/auth/gmail.ts
import { google } from 'googleapis'
import { randomUUID } from 'crypto'
import { getDb } from '../db'
import { encryptSystem } from '../crypto'
import { saveToken, loadToken } from './token-store'
import { config } from '../config'

export function getOAuthClient() {
  return new google.auth.OAuth2(
    config.google.clientId,
    config.google.clientSecret,
    config.google.redirectUri
  )
}

export function getAuthUrl(state?: string): string {
  const client = getOAuthClient()
  return client.generateAuthUrl({
    access_type: 'offline',
    scope: [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/userinfo.email',
    ],
    state,
    prompt: 'consent',
  })
}

export async function handleCallback(code: string, userId: string): Promise<string> {
  const client = getOAuthClient()
  const { tokens } = await client.getToken(code)

  client.setCredentials(tokens)
  const oauth2 = google.oauth2({ version: 'v2', auth: client })
  const { data } = await oauth2.userinfo.get()
  const email = data.email!

  const db = getDb()
  const existing = db.prepare(
    'SELECT id FROM accounts WHERE email = ? AND user_id = ?'
  ).get(email, userId) as any
  const accountId = existing?.id ?? randomUUID()

  const tokenData = {
    accessToken: tokens.access_token!,
    refreshToken: tokens.refresh_token ?? '',
    expiryMs: tokens.expiry_date ?? Date.now() + 3600_000,
  }

  db.prepare(`
    INSERT INTO accounts (id, provider, email, token_enc, created_at, user_id)
    VALUES (?, 'gmail', ?, ?, ?, ?)
    ON CONFLICT(email) DO UPDATE SET token_enc = excluded.token_enc, user_id = excluded.user_id
  `).run(accountId, email, encryptSystem(JSON.stringify(tokenData)), Date.now(), userId)

  return accountId
}

export async function getAuthedClient(accountId: string) {
  const token = loadToken(accountId)
  const client = getOAuthClient()
  client.setCredentials({
    access_token: token.accessToken,
    refresh_token: token.refreshToken,
    expiry_date: token.expiryMs,
  })
  // Auto-refresh if needed
  client.on('tokens', (tokens) => {
    if (tokens.access_token) {
      saveToken(accountId, {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token ?? token.refreshToken,
        expiryMs: tokens.expiry_date ?? Date.now() + 3600_000,
      })
    }
  })
  return client
}
