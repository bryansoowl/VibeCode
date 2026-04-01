// src/routes/emails.ts
import { Router, type Request, type Response } from 'express'
import { getDb } from '../db'
import { decrypt } from '../crypto'
import { z } from 'zod'

export const emailsRouter = Router()

const FOLDER_VALUES = ['inbox', 'sent', 'spam', 'draft', 'trash', 'archive'] as const

const listQuery = z.object({
  category:   z.enum(['bill', 'govt', 'receipt', 'work']).optional(),
  folder:     z.enum(FOLDER_VALUES).optional(),
  tab:        z.enum(['primary', 'promotions', 'social', 'updates', 'forums']).optional(),
  important:  z.enum(['1', 'true']).optional(),
  accountId:  z.string().optional(),
  accountIds: z.string().optional(),
  limit:      z.coerce.number().min(1).max(100).default(50),
  offset:     z.coerce.number().min(0).default(0),
  search:     z.string().max(100).optional(),
  unread:     z.enum(['1', 'true']).optional(),
  dateFrom:   z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dateTo:     z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
})

const EMAIL_SELECT = `SELECT e.id, e.account_id, e.thread_id, e.subject_enc,
  e.sender, e.sender_name, e.received_at, e.is_read, e.folder, e.tab,
  e.is_important, e.category, e.snippet, e.raw_size
  FROM emails e
  JOIN accounts a ON a.id = e.account_id`

emailsRouter.get('/', (req: Request, res: Response) => {
  const parsed = listQuery.safeParse(req.query)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })

  const { category, folder, tab, important, accountId, accountIds, limit, offset, search, unread, dateFrom, dateTo } = parsed.data
  const user = (req as any).user
  const db = getDb()

  // accountIds (multi) takes precedence over accountId (single)
  const idList = accountIds
    ? accountIds.split(',').filter(s => s.trim().length > 0).slice(0, 6)
    : accountId ? [accountId] : []

  // Convert YYYY-MM-DD to milliseconds (MYT = UTC+8)
  let dateFromMs: number | null = null
  let dateToMs: number | null = null
  if (dateFrom) dateFromMs = new Date(`${dateFrom}T00:00:00+08:00`).getTime()
  if (dateTo)   dateToMs   = new Date(`${dateTo}T23:59:59.999+08:00`).getTime()
  // Swap silently if inverted (user intent is clear)
  if (dateFromMs !== null && dateToMs !== null && dateToMs < dateFromMs) {
    ;[dateFromMs, dateToMs] = [dateToMs, dateFromMs]
  }

  // Build shared WHERE clause
  const conditions: string[] = ['a.user_id = ?']
  const params: any[] = [user.id]

  if (folder)    { conditions.push('e.folder = ?');      params.push(folder) }
  if (tab)       { conditions.push('e.tab = ?');         params.push(tab) }
  if (important) { conditions.push('e.is_important = 1') }
  if (category)  { conditions.push('e.category = ?');    params.push(category) }
  if (idList.length > 0) {
    conditions.push(`e.account_id IN (${idList.map(() => '?').join(',')})`)
    params.push(...idList)
  }
  if (unread)              { conditions.push('e.is_read = 0') }
  if (dateFromMs !== null) { conditions.push('e.received_at >= ?'); params.push(dateFromMs) }
  if (dateToMs !== null)   { conditions.push('e.received_at <= ?'); params.push(dateToMs) }
  // Inbox always excludes Promotions tab unless an explicit tab filter is set
  if (folder === 'inbox' && !tab) { conditions.push("e.tab != 'promotions'") }

  const WHERE = conditions.join(' AND ')

  try {
    if (!search) {
      // Fast path: SQL pagination, no decryption overhead
      const rows = db.prepare(`${EMAIL_SELECT} WHERE ${WHERE} ORDER BY e.received_at DESC LIMIT ? OFFSET ?`).all(...params, limit, offset) as any[]
      const { total } = db.prepare(`SELECT COUNT(*) as total FROM emails e JOIN accounts a ON a.id = e.account_id WHERE ${WHERE}`).get(...params) as any
      const emails = rows.map(r => ({
        ...r,
        subject: decrypt(r.subject_enc, user.dataKey),
        snippet: r.snippet ? decrypt(r.snippet, user.dataKey) : null,
        subject_enc: undefined,
      }))
      return res.json({ emails, limit, offset, total })
    }

    // In-memory search path: fetch up to 2000 candidates, decrypt, filter
    const candidates = db.prepare(`${EMAIL_SELECT} WHERE ${WHERE} ORDER BY e.received_at DESC LIMIT 2000`).all(...params) as any[]

    const q = search.toLowerCase()
    const filtered: any[] = []
    for (const r of candidates) {
      try {
        const subject = decrypt(r.subject_enc, user.dataKey)
        const snippet = r.snippet ? decrypt(r.snippet, user.dataKey) : null
        if (
          r.sender.toLowerCase().includes(q) ||
          subject.toLowerCase().includes(q) ||
          (snippet ?? '').toLowerCase().includes(q)
        ) {
          filtered.push({ ...r, subject, snippet, subject_enc: undefined })
        }
      } catch {
        // Skip rows that fail decryption rather than aborting the whole response
      }
    }

    const total = filtered.length
    const emails = filtered.slice(offset, offset + limit)
    return res.json({ emails, limit, offset, total })
  } catch {
    return res.status(500).json({ error: 'Failed to process emails' })
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

const folderBody = z.object({
  folder: z.enum(FOLDER_VALUES),
})

emailsRouter.patch('/:id/folder', (req: Request, res: Response) => {
  const parsed = folderBody.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })

  const user = (req as any).user
  const db = getDb()
  const result = db.prepare(`
    UPDATE emails SET folder = ?
    WHERE id = ? AND account_id IN (SELECT id FROM accounts WHERE user_id = ?)
  `).run(parsed.data.folder, req.params.id, user.id)

  if (result.changes === 0) return res.status(404).json({ error: 'Email not found' })
  res.json({ ok: true })
})
