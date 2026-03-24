// src/config.ts
import dotenv from 'dotenv'
dotenv.config()

function required(key: string): string {
  const val = process.env[key]
  if (!val) throw new Error(`Missing required env var: ${key}`)
  return val
}

export const config = {
  port: parseInt(process.env.PORT ?? '3001'),
  dataDir: process.env.DATA_DIR ?? './data',
  encryptionKey: required('ENCRYPTION_KEY'),
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID ?? '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? '',
    redirectUri: process.env.GOOGLE_REDIRECT_URI ?? 'http://localhost:3001/auth/gmail/callback',
  },
  microsoft: {
    clientId: process.env.MICROSOFT_CLIENT_ID ?? '',
    clientSecret: process.env.MICROSOFT_CLIENT_SECRET ?? '',
    redirectUri: process.env.MICROSOFT_REDIRECT_URI ?? 'http://localhost:3001/auth/outlook/callback',
  },
  syncIntervalMinutes: parseInt(process.env.SYNC_INTERVAL_MINUTES ?? '15'),
}
