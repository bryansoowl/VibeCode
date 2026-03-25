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
  sessionSecret: required('SESSION_SECRET'),
  recoverySecret: required('RECOVERY_SECRET'),
  appUrl: process.env.APP_URL ?? 'http://localhost:3001',
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
  smtp: {
    host: process.env.SMTP_HOST ?? '',
    port: parseInt(process.env.SMTP_PORT ?? '587'),
    user: process.env.SMTP_USER ?? '',
    pass: process.env.SMTP_PASS ?? '',
  },
  syncIntervalMinutes: parseInt(process.env.SYNC_INTERVAL_MINUTES ?? '15'),
}

export function validateConfig(): void {
  const bar = '─'.repeat(44)
  console.log(bar)
  console.log('  InboxMY Config')
  console.log(bar)

  const googleOk = !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET)
  console.log(`  ${googleOk ? '[✓]' : '[ ]'} Gmail (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET)`)
  if (!googleOk) console.log('      → Run: npm run setup')

  const msOk = !!(process.env.MICROSOFT_CLIENT_ID && process.env.MICROSOFT_CLIENT_SECRET)
  console.log(`  ${msOk ? '[✓]' : '[ ]'} Outlook (MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET)`)
  if (!msOk) console.log('      → Run: npm run setup')

  const smtpOk = !!(process.env.SMTP_HOST)
  console.log(`  ${smtpOk ? '[✓]' : '[ ]'} SMTP (password reset emails)`)
  if (!smtpOk) console.log('      → Reset links will be logged to console')

  console.log(bar)
}
