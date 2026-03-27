// src/routes/accounts.ts
import { Router } from 'express'
import { getDb } from '../db'
import { getAuthUrl as getGmailUrl } from '../auth/gmail'
import { getAuthUrl as getOutlookUrl } from '../auth/outlook'

export const accountsRouter = Router()

accountsRouter.get('/', (req, res) => {
  const db = getDb()
  const user = (req as any).user
  const accounts = db.prepare(
    'SELECT id, provider, email, label, created_at, last_synced, token_expired FROM accounts WHERE user_id = ?'
  ).all(user.id)
  res.json({ accounts })
})

// Embed sessionId as OAuth state so the callback can resolve the user
accountsRouter.get('/connect/gmail', (req, res) => {
  const sessionId = (req as any).cookies?.session
  const url = getGmailUrl(sessionId)
  res.redirect(url)
})

accountsRouter.get('/connect/outlook', async (req, res) => {
  const sessionId = (req as any).cookies?.session
  const url = await getOutlookUrl(sessionId)
  res.redirect(url)
})

accountsRouter.delete('/:id', (req, res) => {
  const db = getDb()
  const user = (req as any).user
  const result = db.prepare(
    'DELETE FROM accounts WHERE id = ? AND user_id = ?'
  ).run(req.params.id, user.id)
  if (result.changes === 0) return res.status(404).json({ error: 'Account not found' })
  res.json({ ok: true })
})

// Wipe all synced emails for one account and reset last_synced so the
// next sync re-fetches everything from scratch (30-day window).
accountsRouter.delete('/:id/emails', (req, res) => {
  const db = getDb()
  const user = (req as any).user
  const account = db.prepare('SELECT id FROM accounts WHERE id = ? AND user_id = ?')
    .get(req.params.id, user.id)
  if (!account) return res.status(404).json({ error: 'Account not found' })
  db.prepare('DELETE FROM emails WHERE account_id = ?').run(req.params.id)
  db.prepare('UPDATE accounts SET last_synced = NULL WHERE id = ?').run(req.params.id)
  res.json({ ok: true })
})

accountsRouter.patch('/:id/label', (req, res) => {
  const { label } = req.body
  if (typeof label !== 'string') return res.status(400).json({ error: 'label must be string' })
  const db = getDb()
  const user = (req as any).user
  db.prepare('UPDATE accounts SET label = ? WHERE id = ? AND user_id = ?')
    .run(label, req.params.id, user.id)
  res.json({ ok: true })
})
