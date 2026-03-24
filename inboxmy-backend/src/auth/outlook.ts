// src/auth/outlook.ts
import { ConfidentialClientApplication } from '@azure/msal-node'
import { randomUUID } from 'crypto'
import { getDb } from '../db'
import { encrypt } from '../crypto'
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

export async function handleCallback(code: string): Promise<string> {
  const app = getMsalApp()
  const result = await app.acquireTokenByCode({
    code,
    scopes: SCOPES,
    redirectUri: config.microsoft.redirectUri,
  })

  const email = result.account?.username!
  const db = getDb()
  const existing = db.prepare('SELECT id FROM accounts WHERE email = ?').get(email) as any
  const accountId = existing?.id ?? randomUUID()

  const tokenData = {
    accessToken: result.accessToken,
    refreshToken: '',          // MSAL handles refresh internally via cache
    expiryMs: result.expiresOn?.getTime() ?? Date.now() + 3600_000,
  }

  // Upsert — avoids race condition on concurrent auth
  db.prepare(`
    INSERT INTO accounts (id, provider, email, token_enc, created_at)
    VALUES (?, 'outlook', ?, ?, ?)
    ON CONFLICT(email) DO UPDATE SET token_enc = excluded.token_enc
  `).run(accountId, email, encrypt(JSON.stringify(tokenData)), Date.now())

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
