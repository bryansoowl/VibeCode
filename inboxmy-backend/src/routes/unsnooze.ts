// src/routes/unsnooze.ts
import { Router, type Request, type Response } from 'express'
import { getDb } from '../db'

export const unsnoozeDueRouter = Router()

// POST /api/emails/unsnooze-due — restore emails whose snooze time has passed
// Called by Electron's runSyncTick every 60s via net.request with session cookie
unsnoozeDueRouter.post('/', (req: Request, res: Response) => {
  const user = (req as any).user
  const now = Date.now()
  const result = getDb().prepare(`
    UPDATE emails SET snoozed_until = NULL
    WHERE snoozed_until IS NOT NULL AND snoozed_until <= ?
      AND account_id IN (SELECT id FROM accounts WHERE user_id = ?)
  `).run(now, user.id)
  res.json({ restored: result.changes })
})
