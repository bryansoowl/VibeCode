// src/routes/sync.ts
import { Router } from 'express'
import { syncAccount, syncAllAccounts } from '../email/sync-engine'

export const syncRouter = Router()

syncRouter.post('/trigger', async (req, res) => {
  const { accountId } = req.body
  const target = accountId ? `account ${accountId}` : 'all accounts'
  console.log(`[sync] Manual trigger — ${target}`)
  try {
    if (accountId) {
      const result = await syncAccount(accountId)
      console.log(`[sync] Done — added ${result.added} emails${result.errors.length ? ', errors: ' + result.errors.join(', ') : ''}`)
      res.json(result)
    } else {
      await syncAllAccounts()
      console.log('[sync] Done — all accounts')
      res.json({ ok: true })
    }
  } catch (err: any) {
    console.error('[sync] Failed:', err.message)
    res.status(500).json({ error: err.message })
  }
})
