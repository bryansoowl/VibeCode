// src/routes/bills.ts
import { Router } from 'express'
import { getDb } from '../db'
import { decrypt } from '../crypto'

export const billsRouter = Router()

billsRouter.get('/', (req, res) => {
  const user = (req as any).user
  const db = getDb()
  const { status } = req.query

  let query = `
    SELECT pb.id, pb.email_id, pb.biller, pb.amount_rm, pb.due_date, pb.account_ref, pb.status,
      e.subject_enc, e.received_at, e.account_id
    FROM parsed_bills pb
    JOIN emails e ON e.id = pb.email_id
    JOIN accounts a ON a.id = e.account_id
    WHERE a.user_id = ?
  `
  const VALID_STATUSES = ['unpaid', 'paid', 'overdue']
  const params: any[] = [user.id]
  if (status) {
    if (!VALID_STATUSES.includes(status as string)) {
      return res.status(400).json({ error: 'Invalid status filter' })
    }
    query += ' AND pb.status = ?'
    params.push(status)
  }
  query += ' ORDER BY pb.due_date ASC'

  const rows = db.prepare(query).all(...params) as any[]
  try {
    const bills = rows.map(r => ({
      ...r,
      subject: decrypt(r.subject_enc, user.dataKey),
      subject_enc: undefined,
    }))
    res.json({ bills })
  } catch {
    res.status(500).json({ error: 'Failed to decrypt bill data' })
  }
})

// PATCH /api/bills/auto-mark-overdue
// Marks all unpaid bills whose due_date has passed as 'overdue'.
// Called by the Electron scheduler before each notification check.
billsRouter.patch('/auto-mark-overdue', (req, res) => {
  const user = (req as any).user
  const db = getDb()
  const now = Date.now()

  const result = db.prepare(`
    UPDATE parsed_bills SET status = 'overdue'
    WHERE status = 'unpaid'
      AND due_date IS NOT NULL
      AND due_date < ?
      AND email_id IN (
        SELECT e.id FROM emails e
        JOIN accounts a ON a.id = e.account_id
        WHERE a.user_id = ?
      )
  `).run(now, user.id)

  res.json({ marked: result.changes })
})

billsRouter.patch('/:id/status', (req, res) => {
  const { status } = req.body
  if (!['unpaid', 'paid', 'overdue'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' })
  }
  const user = (req as any).user
  const db = getDb()
  const existing = db.prepare(`
    SELECT pb.id FROM parsed_bills pb
    JOIN emails e ON e.id = pb.email_id
    JOIN accounts a ON a.id = e.account_id
    WHERE pb.id = ? AND a.user_id = ?
  `).get(req.params.id, user.id)
  if (!existing) return res.status(404).json({ error: 'Bill not found' })
  db.prepare('UPDATE parsed_bills SET status = ? WHERE id = ?').run(status, req.params.id)
  res.json({ ok: true })
})
