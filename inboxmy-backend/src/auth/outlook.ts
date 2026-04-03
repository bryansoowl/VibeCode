// src/auth/outlook.ts
import { ConfidentialClientApplication, type ICachePlugin } from '@azure/msal-node'
import { randomUUID } from 'crypto'
import { getDb } from '../db'
import { encryptSystem } from '../crypto'
import { saveToken, loadToken } from './token-store'
import { config } from '../config'

const SCOPES = ['https://graph.microsoft.com/Mail.Read', 'https://graph.microsoft.com/Mail.Send', 'User.Read', 'offline_access']

// Returns a cache plugin that persists the MSAL token cache (including refresh
// token) to the accounts.msal_cache column. This survives server restarts and
// allows silent token refresh without re-auth.
function makeCachePlugin(accountId: string): ICachePlugin {
  const db = getDb()
  return {
    beforeCacheAccess: async (ctx) => {
      const row = db.prepare('SELECT msal_cache FROM accounts WHERE id = ?').get(accountId) as any
      if (row?.msal_cache) ctx.tokenCache.deserialize(row.msal_cache)
    },
    afterCacheAccess: async (ctx) => {
      if (ctx.cacheHasChanged) {
        db.prepare('UPDATE accounts SET msal_cache = ? WHERE id = ?')
          .run(ctx.tokenCache.serialize(), accountId)
      }
    },
  }
}

function getMsalApp(accountId?: string): ConfidentialClientApplication {
  return new ConfidentialClientApplication({
    auth: {
      clientId: config.microsoft.clientId,
      clientSecret: config.microsoft.clientSecret,
      authority: 'https://login.microsoftonline.com/common',
    },
    cache: accountId ? { cachePlugin: makeCachePlugin(accountId) } : undefined,
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
  // Use a temporary cache plugin to capture the serialized cache (which contains
  // the refresh token) so we can persist it once we know the accountId.
  let serializedCache = ''
  const tempCachePlugin: ICachePlugin = {
    beforeCacheAccess: async () => {},
    afterCacheAccess: async (ctx) => {
      if (ctx.cacheHasChanged) serializedCache = ctx.tokenCache.serialize()
    },
  }

  const app = new ConfidentialClientApplication({
    auth: {
      clientId: config.microsoft.clientId,
      clientSecret: config.microsoft.clientSecret,
      authority: 'https://login.microsoftonline.com/common',
    },
    cache: { cachePlugin: tempCachePlugin },
  })

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
    INSERT INTO accounts (id, provider, email, token_enc, created_at, user_id, msal_cache)
    VALUES (?, 'outlook', ?, ?, ?, ?, ?)
    ON CONFLICT(email) DO UPDATE SET
      token_enc  = excluded.token_enc,
      user_id    = excluded.user_id,
      msal_cache = excluded.msal_cache
  `).run(accountId, email, encryptSystem(JSON.stringify(tokenData)), Date.now(), userId, serializedCache)

  return accountId
}

export async function getAccessToken(accountId: string): Promise<string> {
  const token = loadToken(accountId)
  // Return cached access token if still valid (with 60s buffer)
  if (token.expiryMs > Date.now() + 60_000) return token.accessToken

  // Token expired — use the persisted MSAL cache (with refresh token) to get a new one silently
  const db = getDb()
  const row = db.prepare('SELECT email FROM accounts WHERE id = ?').get(accountId) as any
  const app = getMsalApp(accountId)  // loads msal_cache from DB via cache plugin

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
