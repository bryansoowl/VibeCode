// src/routes/accounts.ts
import { Router } from 'express'
import { getDb } from '../db'
import { getAuthUrl as getGmailUrl } from '../auth/gmail'
import { getAuthUrl as getOutlookUrl } from '../auth/outlook'

export const accountsRouter = Router()

accountsRouter.get('/', (req, res) => {
  const db = getDb()
  const accounts = db.prepare(
    'SELECT id, provider, email, label, created_at, last_synced FROM accounts'
  ).all()
  res.json({ accounts })
})

accountsRouter.delete('/:id', (req, res) => {
  const db = getDb()
  const result = db.prepare('DELETE FROM accounts WHERE id = ?').run(req.params.id)
  if (result.changes === 0) return res.status(404).json({ error: 'Account not found' })
  res.json({ ok: true })
})

accountsRouter.patch('/:id/label', (req, res) => {
  const { label } = req.body
  if (typeof label !== 'string') return res.status(400).json({ error: 'label must be string' })
  const db = getDb()
  db.prepare('UPDATE accounts SET label = ? WHERE id = ?').run(label, req.params.id)
  res.json({ ok: true })
})

accountsRouter.get('/connect/gmail', async (req, res) => {
  const url = getGmailUrl()
  res.redirect(url)
})

accountsRouter.get('/connect/outlook', async (req, res) => {
  const url = await getOutlookUrl()
  res.redirect(url)
})
