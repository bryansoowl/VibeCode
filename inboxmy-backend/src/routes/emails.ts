// src/routes/emails.ts
import { Router, type Request, type Response } from 'express'
import { getDb } from '../db'
import { decrypt } from '../crypto'
import { z } from 'zod'

export const emailsRouter = Router()

const listQuery = z.object({
  category:  z.enum(['bill', 'govt', 'receipt', 'work']).optional(),
  folder:    z.enum(['inbox', 'sent', 'spam', 'draft', 'trash']).optional(),
  tab:       z.enum(['primary', 'promotions', 'social', 'updates', 'forums']).optional(),
  important: z.enum(['1', 'true']).optional(),
  accountId: z.string().optional(),
  limit:     z.coerce.number().min(1).max(100).default(50),
  offset:    z.coerce.number().min(0).default(0),
  search:    z.string().max(100).optional(),
  unread:    z.enum(['1', 'true']).optional(),
})

emailsRouter.get('/', (req: Request, res: Response) => {
  const parsed = listQuery.safeParse(req.query)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })

  const { category, folder, tab, important, accountId, limit, offset, search, unread } = parsed.data
  const user = (req as any).user
  const db = getDb()

  let query = `SELECT e.id, e.account_id, e.thread_id, e.subject_enc,
    e.sender, e.sender_name, e.received_at, e.is_read, e.category,
    e.snippet, e.raw_size
    FROM emails e
    JOIN accounts a ON a.id = e.account_id
    WHERE a.user_id = ?`
  const params: any[] = [user.id]

  if (folder)    { query += ' AND e.folder = ?';      params.push(folder) }
  if (tab)       { query += ' AND e.tab = ?';         params.push(tab) }
  if (important) { query += ' AND e.is_important = 1' }
  if (category)  { query += ' AND e.category = ?';    params.push(category) }
  if (accountId) { query += ' AND e.account_id = ?';  params.push(accountId) }
  if (search)    { query += ' AND e.sender LIKE ?';   params.push(`%${search}%`) }
  if (unread)    { query += ' AND e.is_read = 0' }

  // "Inbox" view excludes Promotions (they live in their own tab, like Gmail).
  // Only applies when folder=inbox with no explicit tab override.
  if (folder === 'inbox' && !tab) {
    query += " AND e.tab != 'promotions'"
  }

  // Count total matching rows (same filters, no limit/offset)
  let countQuery = `SELECT COUNT(*) as total FROM emails e JOIN accounts a ON a.id = e.account_id WHERE a.user_id = ?`
  const countParams: any[] = [user.id]
  if (folder)    { countQuery += ' AND e.folder = ?';      countParams.push(folder) }
  if (tab)       { countQuery += ' AND e.tab = ?';         countParams.push(tab) }
  if (important) { countQuery += ' AND e.is_important = 1' }
  if (category)  { countQuery += ' AND e.category = ?';    countParams.push(category) }
  if (accountId) { countQuery += ' AND e.account_id = ?';  countParams.push(accountId) }
  if (search)    { countQuery += ' AND e.sender LIKE ?';   countParams.push(`%${search}%`) }
  if (unread)    { countQuery += ' AND e.is_read = 0' }
  if (folder === 'inbox' && !tab) {
    countQuery += " AND e.tab != 'promotions'"
  }

  query += ' ORDER BY e.received_at DESC LIMIT ? OFFSET ?'
  params.push(limit, offset)

  const rows = db.prepare(query).all(...params) as any[]
  const { total } = db.prepare(countQuery).get(...countParams) as any
  try {
    const emails = rows.map(r => ({
      ...r,
      subject: decrypt(r.subject_enc, user.dataKey),
      snippet: r.snippet ? decrypt(r.snippet, user.dataKey) : null,
      subject_enc: undefined,
    }))
    res.json({ emails, limit, offset, total })
  } catch {
    res.status(500).json({ error: 'Failed to decrypt email data' })
  }
})

emailsRouter.get('/unread-count', (req: Request, res: Response) => {
  const user = (req as any).user
  const db = getDb()
  const row = db.prepare(`
    SELECT COUNT(*) as count FROM emails e
    JOIN accounts a ON a.id = e.account_id
    WHERE a.user_id = ? AND e.is_read = 0 AND e.folder = 'inbox' AND e.tab != 'promotions'
  `).get(user.id) as { count: number }
  res.json({ count: row.count })
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

// Wipe ALL synced emails for the current user (across all accounts) and
// reset every account's last_synced so the next sync re-fetches from scratch.
emailsRouter.delete('/', (req: Request, res: Response) => {
  const user = (req as any).user
  const db = getDb()
  db.prepare(
    'DELETE FROM emails WHERE account_id IN (SELECT id FROM accounts WHERE user_id = ?)'
  ).run(user.id)
  db.prepare('UPDATE accounts SET last_synced = NULL WHERE user_id = ?').run(user.id)
  res.json({ ok: true })
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
