// src/routes/sync.ts
import { Router } from 'express'
import { getDb } from '../db'
import { syncAccount, syncAllAccounts } from '../email/sync-engine'

export const syncRouter = Router()

syncRouter.post('/trigger', async (req, res) => {
  const { accountId } = req.body
  const user = (req as any).user

  if (accountId) {
    const account = getDb().prepare(
      'SELECT id FROM accounts WHERE id = ? AND user_id = ?'
    ).get(accountId, user.id)
    if (!account) return res.status(404).json({ error: 'Account not found' })
  }

  const target = accountId ? `account ${accountId}` : 'all accounts'
  console.log(`[sync] Manual trigger — ${target}`)
  try {
    if (accountId) {
      const result = await syncAccount(accountId, user.dataKey)
      console.log(`[sync] Done — added ${result.added} emails`)
      res.json({ added: result.added, emails: result.newEmails, errors: result.errors })
    } else {
      const result = await syncAllAccounts(user.id, user.dataKey)
      console.log(`[sync] Done — all accounts, added ${result.added} emails`)
      res.json({ added: result.added, emails: result.newEmails })
    }
  } catch (err: any) {
    console.error('[sync] Failed:', err.message)
    res.status(500).json({ error: err.message })
  }
})
