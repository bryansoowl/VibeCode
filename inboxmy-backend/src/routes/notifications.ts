// src/routes/notifications.ts
import { Router } from 'express'
import { getDb } from '../db'
import { getNotifications } from '../ai/notifier'
import type { BillForNotification } from '../ai/notifier'

export const notificationsRouter = Router()

notificationsRouter.get('/due-soon', (req, res) => {
  const user = (req as any).user
  const db = getDb()
  const now = Date.now()
  const window72h = now + 72 * 60 * 60 * 1000

  const rows = db.prepare(`
    SELECT pb.id, pb.biller, pb.amount_rm, pb.due_date, pb.status
    FROM parsed_bills pb
    JOIN emails e ON e.id = pb.email_id
    JOIN accounts a ON a.id = e.account_id
    WHERE a.user_id = ?
      AND (
        pb.status = 'overdue'
        OR (
          pb.status = 'unpaid'
          AND pb.due_date IS NOT NULL
          AND pb.due_date >= ?
          AND pb.due_date <= ?
        )
      )
    ORDER BY pb.due_date ASC
  `).all(user.id, now, window72h)

  res.json({ bills: rows })
})

// POST /api/notifications/ai-summary
// Accepts bills array + Gemini key, returns NotificationResult[].
// Key is passed per-request and never stored server-side.
// SECURITY: Do not add any body logging middleware — key must not appear in logs.
notificationsRouter.post('/ai-summary', async (req, res) => {
  const { bills, geminiKey } = req.body
  if (!Array.isArray(bills) || typeof geminiKey !== 'string' || !geminiKey.trim()) {
    return res.status(400).json({ error: 'bills (array) and geminiKey (string) required' })
  }

  try {
    const results = await getNotifications(bills as BillForNotification[], geminiKey)
    res.json(results)
  } catch {
    res.status(500).json({ error: 'Notification generation failed' })
  }
})
