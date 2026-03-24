// src/routes/bills.ts
import { Router } from 'express'
import { getDb } from '../db'
import { decrypt } from '../crypto'

export const billsRouter = Router()

billsRouter.get('/', (req, res) => {
  const db = getDb()
  const { status } = req.query

  let query = `
    SELECT pb.id, pb.biller, pb.amount_rm, pb.due_date, pb.account_ref, pb.status,
      e.subject_enc, e.received_at, e.account_id
    FROM parsed_bills pb
    JOIN emails e ON e.id = pb.email_id
    WHERE 1=1
  `
  const VALID_STATUSES = ['unpaid', 'paid', 'overdue']
  const params: any[] = []
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
      subject: decrypt(r.subject_enc),
      subject_enc: undefined,
    }))
    res.json({ bills })
  } catch {
    res.status(500).json({ error: 'Failed to decrypt bill data' })
  }
})

billsRouter.patch('/:id/status', (req, res) => {
  const { status } = req.body
  if (!['unpaid', 'paid', 'overdue'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' })
  }
  const db = getDb()
  const existing = db.prepare('SELECT id FROM parsed_bills WHERE id = ?').get(req.params.id)
  if (!existing) return res.status(404).json({ error: 'Bill not found' })
  db.prepare('UPDATE parsed_bills SET status = ? WHERE id = ?').run(status, req.params.id)
  res.json({ ok: true })
})
