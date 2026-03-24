// src/routes/sync.ts
import { Router } from 'express'
import { syncAccount, syncAllAccounts } from '../email/sync-engine'

export const syncRouter = Router()

syncRouter.post('/trigger', async (req, res) => {
  const { accountId } = req.body
  try {
    if (accountId) {
      const result = await syncAccount(accountId)
      res.json(result)
    } else {
      await syncAllAccounts()
      res.json({ ok: true })
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})
