// src/routes/emails.ts
import { Router, type Request, type Response } from 'express'
import { getDb } from '../db'
import { decrypt } from '../crypto'
import { z } from 'zod'

export const emailsRouter = Router()

const listQuery = z.object({
  category: z.enum(['bill', 'govt', 'receipt', 'work']).optional(),
  accountId: z.string().optional(),
  limit: z.coerce.number().min(1).max(100).default(50),
  offset: z.coerce.number().min(0).default(0),
  search: z.string().max(100).optional(),
})

emailsRouter.get('/', (req: Request, res: Response) => {
  const parsed = listQuery.safeParse(req.query)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })

  const { category, accountId, limit, offset, search } = parsed.data
  const user = (req as any).user
  const db = getDb()

  let query = `SELECT e.id, e.account_id, e.thread_id, e.subject_enc,
    e.sender, e.sender_name, e.received_at, e.is_read, e.category,
    e.snippet, e.raw_size
    FROM emails e
    JOIN accounts a ON a.id = e.account_id
    WHERE a.user_id = ?`
  const params: any[] = [user.id]

  if (category) { query += ' AND e.category = ?'; params.push(category) }
  if (accountId) { query += ' AND e.account_id = ?'; params.push(accountId) }
  if (search) { query += ' AND e.sender LIKE ?'; params.push(`%${search}%`) }

  query += ' ORDER BY e.received_at DESC LIMIT ? OFFSET ?'
  params.push(limit, offset)

  const rows = db.prepare(query).all(...params) as any[]
  try {
    const emails = rows.map(r => ({
      ...r,
      subject: decrypt(r.subject_enc, user.dataKey),
      snippet: r.snippet ? decrypt(r.snippet, user.dataKey) : null,
      subject_enc: undefined,
    }))
    res.json({ emails, limit, offset })
  } catch {
    res.status(500).json({ error: 'Failed to decrypt email data' })
  }
})

emailsRouter.get('/:id', (req: Request, res: Response) => {
  const user = (req as any).user
  const db = getDb()
  const row = db.prepare(`
    SELECT e.*, pb.biller, pb.amount_rm, pb.due_date, pb.account_ref, pb.status
    FROM emails e
    JOIN accounts a ON a.id = e.account_id
    LEFT JOIN parsed_bills pb ON pb.email_id = e.id
    WHERE e.id = ? AND a.user_id = ?
  `).get(req.params.id, user.id) as any

  if (!row) return res.status(404).json({ error: 'Email not found' })

  try {
    res.json({
      ...row,
      subject: decrypt(row.subject_enc, user.dataKey),
      body: row.body_enc ? decrypt(row.body_enc, user.dataKey) : null,
      snippet: row.snippet ? decrypt(row.snippet, user.dataKey) : null,
      subject_enc: undefined,
      body_enc: undefined,
    })
  } catch {
    res.status(500).json({ error: 'Failed to decrypt email data' })
  }
})

emailsRouter.patch('/:id/read', (req: Request, res: Response) => {
  const user = (req as any).user
  const db = getDb()
  db.prepare(`
    UPDATE emails SET is_read = 1
    WHERE id = ? AND account_id IN (SELECT id FROM accounts WHERE user_id = ?)
  `).run(req.params.id, user.id)
  res.json({ ok: true })
})
