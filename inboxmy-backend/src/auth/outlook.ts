// src/auth/outlook.ts
import { ConfidentialClientApplication } from '@azure/msal-node'
import { randomUUID } from 'crypto'
import { getDb } from '../db'
import { encryptSystem } from '../crypto'
import { saveToken, loadToken } from './token-store'
import { config } from '../config'

const SCOPES = ['https://graph.microsoft.com/Mail.Read', 'User.Read', 'offline_access']

function getMsalApp() {
  return new ConfidentialClientApplication({
    auth: {
      clientId: config.microsoft.clientId,
      clientSecret: config.microsoft.clientSecret,
      authority: 'https://login.microsoftonline.com/common',
    },
  })
}

export async function getAuthUrl(state?: string): Promise<string> {
  const app = getMsalApp()
  return app.getAuthCodeUrl({
    scopes: SCOPES,
    redirectUri: config.microsoft.redirectUri,
    state: state ?? undefined,
  })
}

export async function handleCallback(code: string, userId: string): Promise<string> {
  const app = getMsalApp()
  const result = await app.acquireTokenByCode({
    code,
    scopes: SCOPES,
    redirectUri: config.microsoft.redirectUri,
  })

  const email = result.account?.username!
  const db = getDb()
  const existing = db.prepare(
    'SELECT id FROM accounts WHERE email = ? AND user_id = ?'
  ).get(email, userId) as any
  const accountId = existing?.id ?? randomUUID()

  const tokenData = {
    accessToken: result.accessToken,
    refreshToken: '',
    expiryMs: result.expiresOn?.getTime() ?? Date.now() + 3600_000,
  }

  db.prepare(`
    INSERT INTO accounts (id, provider, email, token_enc, created_at, user_id)
    VALUES (?, 'outlook', ?, ?, ?, ?)
    ON CONFLICT(email) DO UPDATE SET token_enc = excluded.token_enc, user_id = excluded.user_id
  `).run(accountId, email, encryptSystem(JSON.stringify(tokenData)), Date.now(), userId)

  return accountId
}

export async function getAccessToken(accountId: string): Promise<string> {
  // For Outlook, re-acquire silently each call — MSAL caches internally
  const token = loadToken(accountId)
  if (token.expiryMs > Date.now() + 60_000) return token.accessToken

  const db = getDb()
  const row = db.prepare('SELECT email FROM accounts WHERE id = ?').get(accountId) as any
  const app = getMsalApp()
  const accounts = await app.getTokenCache().getAllAccounts()
  const account = accounts.find(a => a.username === row.email)

  if (!account) throw new Error('Outlook account not found in MSAL cache — re-auth required')

  const result = await app.acquireTokenSilent({ scopes: SCOPES, account })
  const updated = {
    accessToken: result!.accessToken,
    refreshToken: '',
    expiryMs: result!.expiresOn?.getTime() ?? Date.now() + 3600_000,
  }
  saveToken(accountId, updated)
  return updated.accessToken
}
