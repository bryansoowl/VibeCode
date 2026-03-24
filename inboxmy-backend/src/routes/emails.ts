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
  const db = getDb()

  let query = `SELECT e.id, e.account_id, e.thread_id, e.subject_enc,
    e.sender, e.sender_name, e.received_at, e.is_read, e.category,
    e.snippet, e.raw_size
    FROM emails e WHERE 1=1`
  const params: any[] = []

  if (category) { query += ' AND e.category = ?'; params.push(category) }
  if (accountId) { query += ' AND e.account_id = ?'; params.push(accountId) }
  if (search) { query += ' AND e.sender LIKE ?'; params.push(`%${search}%`) }

  query += ' ORDER BY e.received_at DESC LIMIT ? OFFSET ?'
  params.push(limit, offset)

  const rows = db.prepare(query).all(...params) as any[]
  try {
    const emails = rows.map(r => ({
      ...r,
      subject: decrypt(r.subject_enc),
      snippet: r.snippet ? decrypt(r.snippet) : null,
      subject_enc: undefined,
    }))
    res.json({ emails, limit, offset })
  } catch {
    res.status(500).json({ error: 'Failed to decrypt email data' })
  }
})

emailsRouter.get('/:id', (req: Request, res: Response) => {
  const db = getDb()
  const row = db.prepare(`
    SELECT e.*, pb.biller, pb.amount_rm, pb.due_date, pb.account_ref, pb.status
    FROM emails e
    LEFT JOIN parsed_bills pb ON pb.email_id = e.id
    WHERE e.id = ?
  `).get(req.params.id) as any

  if (!row) return res.status(404).json({ error: 'Email not found' })

  try {
    res.json({
      ...row,
      subject: decrypt(row.subject_enc),
      body: row.body_enc ? decrypt(row.body_enc) : null,
      snippet: row.snippet ? decrypt(row.snippet) : null,
      subject_enc: undefined,
      body_enc: undefined,
    })
  } catch {
    res.status(500).json({ error: 'Failed to decrypt email data' })
  }
})

emailsRouter.patch('/:id/read', (req: Request, res: Response) => {
  const db = getDb()
  db.prepare('UPDATE emails SET is_read = 1 WHERE id = ?').run(req.params.id)
  res.json({ ok: true })
})
