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
import { syncRouter } from './routes/sync'
import { handleCallback as gmailCallback } from './auth/gmail'
import { handleCallback as outlookCallback } from './auth/outlook'
import { startScheduler } from './scheduler'

export const app = express()

app.use(cors({ origin: ['http://localhost:3000', 'http://localhost:5173'] }))
app.use(express.json())

// Rate limit API routes
app.use('/api', rateLimit({
  windowMs: 60_000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
}))

// Serve frontend static files (InboxMy.html, landing.html from ../frontend/)
app.use(express.static(path.resolve(__dirname, '../../frontend')))

// OAuth callbacks (called by Google/Microsoft redirect)
app.get('/auth/gmail/callback', async (req, res) => {
  const { code, error } = req.query
  if (error || !code) return res.status(400).send(`OAuth error: ${error}`)
  try {
    const accountId = await gmailCallback(code as string)
    res.send(`<script>window.close()</script><p>Gmail connected! Account: ${accountId}</p>`)
  } catch (err: any) {
    res.status(500).send(err.message)
  }
})

app.get('/auth/outlook/callback', async (req, res) => {
  const { code, error } = req.query
  if (error || !code) return res.status(400).send(`OAuth error: ${error}`)
  try {
    const accountId = await outlookCallback(code as string)
    res.send(`<script>window.close()</script><p>Outlook connected! Account: ${accountId}</p>`)
  } catch (err: any) {
    res.status(500).send(err.message)
  }
})

// API routes
app.use('/api/accounts', accountsRouter)
app.use('/api/emails', emailsRouter)
app.use('/api/bills', billsRouter)
app.use('/api/sync', syncRouter)

app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now() }))

if (require.main === module) {
  validateConfig()           // ← add as first statement
  getDb() // initialise DB on start
  startScheduler()
  const port = config.port
  app.listen(port, '127.0.0.1', () => {
    console.log(`InboxMy backend running on http://localhost:${port}`)
    console.log(`Data directory: ${config.dataDir}`)
  })
}
