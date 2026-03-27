// src/server.ts
import express from 'express'
import cors from 'cors'
import rateLimit from 'express-rate-limit'
import path from 'path'
import { config, validateConfig } from './config'
import { getDb } from './db'
import { accountsRouter } from './routes/accounts'
import { emailsRouter } from './routes/emails'
import { billsRouter } from './routes/bills'
import { notificationsRouter } from './routes/notifications'
import { syncRouter } from './routes/sync'
import { handleCallback as gmailCallback } from './auth/gmail'
import { handleCallback as outlookCallback } from './auth/outlook'
import { startScheduler } from './scheduler'
import cookieParser from 'cookie-parser'
import { authRouter } from './routes/auth'
import { requireAuth, SESSION_TTL_MS } from './middleware/auth'

export const app = express()

app.use(cors({ origin: ['http://localhost:3000', 'http://localhost:5173'] }))
app.use(express.json())
app.use(cookieParser())

// Rate limit API routes
app.use('/api', rateLimit({
  windowMs: 60_000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
}))

// Stricter rate limit on auth routes (skipped in test env)
app.use(['/auth/login', '/auth/signup', '/auth/forgot-password'], rateLimit({
  windowMs: 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'test',
}))

app.use('/auth', authRouter)

app.get('/auth', (req, res) => {
  res.sendFile(path.resolve(__dirname, '../../frontend/auth.html'))
})

// Serve frontend static files (InboxMy.html, landing.html from ../frontend/)
app.use(express.static(path.resolve(__dirname, '../../frontend')))

// OAuth callbacks (called by Google/Microsoft redirect)
app.get('/auth/gmail/callback', async (req, res) => {
  const { code, error, state } = req.query
  if (error || !code) return res.status(400).send(`OAuth error: ${error}`)
  if (!state) return res.status(400).send('OAuth error: missing state')

  const db = getDb()
  const session = db.prepare(
    'SELECT user_id, created_at FROM sessions WHERE id = ?'
  ).get(state as string) as any
  if (!session || Date.now() - session.created_at > SESSION_TTL_MS) {
    return res.status(400).send('Invalid or expired session. Please reconnect from the dashboard.')
  }

  try {
    const accountId = await gmailCallback(code as string, session.user_id)
    getDb().prepare('UPDATE accounts SET token_expired = 0 WHERE id = ?').run(accountId)
    res.send(`<script>window.close()</script><p>Gmail connected! Account: ${accountId}</p>`)
  } catch (err: any) {
    res.status(500).send(err.message)
  }
})

app.get('/auth/outlook/callback', async (req, res) => {
  const { code, error, state } = req.query
  if (error || !code) return res.status(400).send(`OAuth error: ${error}`)
  if (!state) return res.status(400).send('OAuth error: missing state')

  const db = getDb()
  const session = db.prepare(
    'SELECT user_id, created_at FROM sessions WHERE id = ?'
  ).get(state as string) as any
  if (!session || Date.now() - session.created_at > SESSION_TTL_MS) {
    return res.status(400).send('Invalid or expired session. Please reconnect from the dashboard.')
  }

  try {
    const accountId = await outlookCallback(code as string, session.user_id)
    getDb().prepare('UPDATE accounts SET token_expired = 0 WHERE id = ?').run(accountId)
    res.send(`<script>window.close()</script><p>Outlook connected! Account: ${accountId}</p>`)
  } catch (err: any) {
    res.status(500).send(err.message)
  }
})

// API routes
app.use('/api', requireAuth)
app.use('/api/accounts', accountsRouter)
app.use('/api/emails', emailsRouter)
app.use('/api/bills', billsRouter)
app.use('/api/notifications', notificationsRouter)
app.use('/api/sync', syncRouter)

app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now() }))

if (require.main === module) {
  validateConfig()           // ← add as first statement
  getDb() // initialise DB on start
  // Clean up any accounts without a user_id (dev data from pre-Plan-4 runs)
  getDb().prepare('DELETE FROM accounts WHERE user_id IS NULL').run()
  startScheduler()
  const port = config.port
  app.listen(port, '127.0.0.1', () => {
    console.log(`InboxMy backend running on http://localhost:${port}`)
    console.log(`Data directory: ${config.dataDir}`)
  })
}
