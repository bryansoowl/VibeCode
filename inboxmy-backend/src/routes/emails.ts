// src/routes/emails.ts
import { Router, type Request, type Response } from 'express'
import { getDb } from '../db'
import { decrypt, encrypt } from '../crypto'
import { z } from 'zod'
import { listAttachments, getAttachmentContent } from '../email/attachments'

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
  snoozed:    z.enum(['1', 'true']).optional(),
  labelId:    z.string().uuid().optional(),
})

const EMAIL_SELECT = `SELECT e.id, e.account_id, e.thread_id, e.subject_enc,
  e.sender, e.sender_name, e.received_at, e.is_read, e.folder, e.tab,
  e.is_important, e.category, e.snippet, e.raw_size,
  (SELECT json_group_array(json_object('id', l.id, 'name', l.name, 'color', l.color))
   FROM email_labels el JOIN labels l ON l.id = el.label_id
   WHERE el.email_id = e.id) AS labels_json
  FROM emails e
  JOIN accounts a ON a.id = e.account_id`

emailsRouter.get('/', (req: Request, res: Response) => {
  const parsed = listQuery.safeParse(req.query)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })

  const { category, folder, tab, important, accountId, accountIds, limit, offset, search, unread, dateFrom, dateTo, snoozed, labelId } = parsed.data
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
  if (labelId) {
    const label = db.prepare('SELECT id FROM labels WHERE id = ? AND user_id = ?').get(labelId, user.id)
    if (!label) return res.status(404).json({ error: 'Label not found' })
    conditions.push(`e.id IN (SELECT email_id FROM email_labels WHERE label_id = ?)`)
    params.push(labelId)
  }
  if (unread)              { conditions.push('e.is_read = 0') }
  if (dateFromMs !== null) { conditions.push('e.received_at >= ?'); params.push(dateFromMs) }
  if (dateToMs !== null)   { conditions.push('e.received_at <= ?'); params.push(dateToMs) }
  if (snoozed) {
    conditions.push('e.snoozed_until IS NOT NULL')
  } else {
    conditions.push('e.snoozed_until IS NULL')
  }
  // Always exclude trash unless the user is explicitly viewing the trash folder
  if (folder !== 'trash') { conditions.push("e.folder != 'trash'") }
  // Always exclude drafts unless the user is explicitly viewing the drafts folder
  if (folder !== 'draft') { conditions.push("e.folder != 'draft'") }
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
        labels: r.labels_json ? JSON.parse(r.labels_json) : [],
        labels_json: undefined,
      }))
      return res.json({ emails, limit, offset, total })
    }

    // Search path — in-memory decrypt on inbox_index.
    // inbox_index holds ALL emails (burst + backfill + incremental).
    // email_search token index is used going forward once populated by new syncs.
    const iiConditions: string[] = ['a.user_id = ?']
    const iiParams: any[] = [user.id]

    if (folder)    { iiConditions.push('ii.folder = ?');      iiParams.push(folder) }
    if (tab)       { iiConditions.push('ii.tab = ?');         iiParams.push(tab) }
    if (important) { iiConditions.push('ii.is_important = 1') }
    if (category)  { iiConditions.push('ii.category = ?');    iiParams.push(category) }
    if (idList.length > 0) {
      iiConditions.push(`ii.account_id IN (${idList.map(() => '?').join(',')})`)
      iiParams.push(...idList)
    }
    if (labelId) {
      const label = db.prepare('SELECT id FROM labels WHERE id = ? AND user_id = ?').get(labelId, user.id)
      if (!label) return res.status(404).json({ error: 'Label not found' })
      iiConditions.push(`ii.provider_message_id IN (SELECT email_id FROM email_labels WHERE label_id = ?)`)
      iiParams.push(labelId)
    }
    if (unread)              { iiConditions.push('ii.is_read = 0') }
    if (dateFromMs !== null) { iiConditions.push('ii.received_at >= ?'); iiParams.push(dateFromMs) }
    if (dateToMs !== null)   { iiConditions.push('ii.received_at <= ?'); iiParams.push(dateToMs) }
    if (snoozed) {
      iiConditions.push('ii.snoozed_until IS NOT NULL')
    } else {
      iiConditions.push('ii.snoozed_until IS NULL')
    }
    if (folder !== 'trash') { iiConditions.push("ii.folder != 'trash'") }
    if (folder !== 'draft') { iiConditions.push("ii.folder != 'draft'") }
    if (folder === 'inbox' && !tab) { iiConditions.push("ii.tab != 'promotions'") }

    const II_WHERE = iiConditions.join(' AND ')
    const candidates = db.prepare(`
      SELECT ii.provider_message_id AS id, ii.account_id, ii.thread_id,
        ii.subject_preview_enc, ii.sender_email AS sender, ii.sender_name,
        ii.received_at, ii.is_read, ii.folder, ii.tab, ii.is_important,
        ii.category, ii.snippet_preview_enc, null AS raw_size
      FROM inbox_index ii
      JOIN accounts a ON a.id = ii.account_id
      WHERE ${II_WHERE}
      ORDER BY ii.received_at DESC
    `).all(...iiParams) as any[]

    const q = search.toLowerCase()
    const filtered: any[] = []
    for (const r of candidates) {
      try {
        const subject = decrypt(r.subject_preview_enc, user.dataKey)
        const snippet = r.snippet_preview_enc ? decrypt(r.snippet_preview_enc, user.dataKey) : null
        if (
          r.sender.toLowerCase().includes(q) ||
          subject.toLowerCase().includes(q) ||
          (snippet ?? '').toLowerCase().includes(q)
        ) {
          filtered.push({
            ...r,
            subject,
            snippet,
            subject_preview_enc: undefined,
            snippet_preview_enc: undefined,
            labels: [],
          })
        }
      } catch {
        // Skip rows that fail decryption
      }
    }

    const total = filtered.length
    const emails = filtered.slice(offset, offset + limit)
    return res.json({ emails, limit, offset, total })
  } catch {
    return res.status(500).json({ error: 'Failed to process emails' })
  }
})

// ── SHARED: compute all unread/badge counts for a user in one SQL query ──────
interface UnreadCounts {
  total_unread: number
  bills: number; govt: number; receipts: number; work: number
  important: number; promotions: number; snoozed: number
  sent: number; draft: number; spam: number; archived: number
}

function computeUnreadCounts(db: ReturnType<typeof getDb>, userId: string): UnreadCounts {
  return db.prepare(`
    SELECT
      COUNT(CASE WHEN e.is_read=0 AND e.snoozed_until IS NULL THEN 1 END) AS total_unread,
      COUNT(CASE WHEN e.is_read=0 AND e.snoozed_until IS NULL AND e.category='bill'    THEN 1 END) AS bills,
      COUNT(CASE WHEN e.is_read=0 AND e.snoozed_until IS NULL AND e.category='govt'    THEN 1 END) AS govt,
      COUNT(CASE WHEN e.is_read=0 AND e.snoozed_until IS NULL AND e.category='receipt' THEN 1 END) AS receipts,
      COUNT(CASE WHEN e.is_read=0 AND e.snoozed_until IS NULL AND e.category='work'    THEN 1 END) AS work,
      COUNT(CASE WHEN e.is_read=0 AND e.snoozed_until IS NULL AND e.is_important=1     THEN 1 END) AS important,
      COUNT(CASE WHEN e.is_read=0 AND e.snoozed_until IS NULL AND e.tab='promotions'   THEN 1 END) AS promotions,
      COUNT(CASE WHEN e.snoozed_until IS NOT NULL
                  AND e.snoozed_until > (strftime('%s','now') * 1000)                  THEN 1 END) AS snoozed,
      COUNT(CASE WHEN e.is_read=0 AND e.snoozed_until IS NULL AND e.folder='sent'      THEN 1 END) AS sent,
      COUNT(CASE WHEN e.is_read=0 AND e.snoozed_until IS NULL AND e.folder='draft'     THEN 1 END) AS draft,
      COUNT(CASE WHEN e.is_read=0 AND e.snoozed_until IS NULL AND e.folder='spam'      THEN 1 END) AS spam,
      COUNT(CASE WHEN e.is_read=0 AND e.snoozed_until IS NULL AND e.folder='archived'  THEN 1 END) AS archived
    FROM emails e
    JOIN accounts a ON a.id = e.account_id
    WHERE a.user_id = ?
  `).get(userId) as UnreadCounts
}

emailsRouter.get('/unread-counts', (req: Request, res: Response) => {
  const user = (req as any).user
  res.json(computeUnreadCounts(getDb(), user.id))
})

// GET /api/emails/:id/attachments — list attachments for an email
emailsRouter.get('/:id/attachments', async (req: Request, res: Response) => {
  const user = (req as any).user
  const db = getDb()
  const row = db.prepare(`
    SELECT e.id, e.account_id, a.provider
    FROM emails e
    JOIN accounts a ON a.id = e.account_id
    WHERE e.id = ? AND a.user_id = ?
  `).get(req.params.id, user.id) as any

  if (!row) return res.status(404).json({ error: 'Email not found' })

  try {
    const atts = await listAttachments(row.id, row.account_id, row.provider)
    res.json(atts)
  } catch {
    res.json([])
  }
})

// GET /api/emails/:id/attachments/:attId — proxy attachment content
emailsRouter.get('/:id/attachments/:attId', async (req: Request, res: Response) => {
  const user = (req as any).user
  const db = getDb()
  const row = db.prepare(`
    SELECT e.id, e.account_id, a.provider
    FROM emails e
    JOIN accounts a ON a.id = e.account_id
    WHERE e.id = ? AND a.user_id = ?
  `).get(req.params.id, user.id) as any

  if (!row) return res.status(404).json({ error: 'Email not found' })

  try {
    const { data, contentType, name } = await getAttachmentContent(
      row.id as string, row.account_id as string, row.provider as string, req.params.attId as string
    )
    const safeName = name.replace(/[^\w.\-() ]/g, '_')
    res.set('Content-Type', contentType)
    res.set('Content-Disposition', `inline; filename="${safeName}"`)
    res.set('Content-Length', String(data.length))
    res.send(data)
  } catch (err: any) {
    res.status(502).json({ error: err.message })
  }
})

// ── GET /api/emails/index — cursor-based inbox from inbox_index ───────────────
// NO OFFSET. NO JOIN in hot path. Ownership checked separately before the hot query.
// Uses idx_inbox_hot (WHERE snoozed_until IS NULL) for fast inbox rendering.
// next_cursor format: { before_ts, before_id } — distinct from backfill cursor format.
emailsRouter.get('/index', (req: Request, res: Response) => {
  const schema = z.object({
    accountId: z.string(),
    folder:    z.string().default('inbox'),
    tab:       z.string().default('primary'),
    limit:     z.coerce.number().min(1).max(100).default(50),
    before_ts: z.coerce.number().optional(),
    before_id: z.string().optional(),
  })

  const parsed = schema.safeParse(req.query)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })

  const { accountId, folder, tab, limit, before_ts, before_id } = parsed.data
  const user = (req as any).user
  const db = getDb()

  // Ownership check — keeps hot query JOIN-free
  const account = db.prepare(
    'SELECT id FROM accounts WHERE id = ? AND user_id = ?'
  ).get(accountId, user.id)
  if (!account) return res.status(404).json({ error: 'Account not found' })

  const hasCursor = before_ts !== undefined && before_id !== undefined
  const rows: any[] = hasCursor
    ? db.prepare(`
        SELECT * FROM inbox_index
        WHERE account_id = ?
          AND folder = ?
          AND tab = ?
          AND snoozed_until IS NULL
          AND (received_at, email_id) < (?, ?)
        ORDER BY received_at DESC, email_id DESC
        LIMIT ?
      `).all(accountId, folder, tab, before_ts, before_id, limit)
    : db.prepare(`
        SELECT * FROM inbox_index
        WHERE account_id = ?
          AND folder = ?
          AND tab = ?
          AND snoozed_until IS NULL
        ORDER BY received_at DESC, email_id DESC
        LIMIT ?
      `).all(accountId, folder, tab, limit)

  try {
    const emails = rows.map(r => ({
      ...r,
      subject: decrypt(r.subject_preview_enc, user.dataKey),
      snippet: r.snippet_preview_enc ? decrypt(r.snippet_preview_enc, user.dataKey) : null,
      subject_preview_enc: undefined,
      snippet_preview_enc: undefined,
    }))

    const next_cursor = rows.length === limit
      ? { before_ts: rows[rows.length - 1].received_at, before_id: rows[rows.length - 1].email_id }
      : null

    return res.json({ emails, next_cursor })
  } catch {
    return res.status(500).json({ error: 'Failed to decrypt index data' })
  }
})

// ── GET /api/emails/index/:id — on-demand body fetch (Phase 3) ───────────────
// 1. If email_body row exists → return cached decrypted body immediately
// 2. If not → fetch full email from provider, encrypt, store in email_body,
//    mark inbox_index.has_full_body=1, return body
// INSERT uses ON CONFLICT DO NOTHING (body is immutable once stored).
// INSERT + UPDATE wrapped in a transaction to keep has_full_body consistent.
emailsRouter.get('/index/:id', async (req: Request, res: Response) => {
  const user = (req as any).user
  const db = getDb()

  // Verify email exists and belongs to this user (JOIN is OK here — one-time ownership check)
  const indexRow = db.prepare(`
    SELECT ii.*, a.provider, a.id as acct_id
    FROM inbox_index ii
    JOIN accounts a ON a.id = ii.account_id
    WHERE ii.email_id = ? AND a.user_id = ?
  `).get(req.params.id, user.id) as any

  if (!indexRow) return res.status(404).json({ error: 'Email not found' })

  // ── Check cache ────────────────────────────────────────────────────────────
  const cached = db.prepare('SELECT * FROM email_body WHERE email_id = ?').get(req.params.id) as any
  if (cached) {
    return res.json({
      email_id: indexRow.email_id,
      account_id: indexRow.account_id,
      subject: decrypt(indexRow.subject_preview_enc, user.dataKey),
      sender_email: indexRow.sender_email,
      sender_name: indexRow.sender_name,
      received_at: indexRow.received_at,
      folder: indexRow.folder,
      tab: indexRow.tab,
      is_read: indexRow.is_read,
      is_important: indexRow.is_important,
      body: decrypt(cached.body_enc, user.dataKey),
      body_format: cached.body_format,
      has_full_body: 1,
      sync_state: 'complete',
    })
  }

  // ── Fetch from provider ────────────────────────────────────────────────────
  try {
    let bodyHtml: string | null = null
    let bodyText: string | null = null
    let rawHeaders: string | null = null

    if (indexRow.provider === 'gmail') {
      const { getAuthedClient } = await import('../auth/gmail')
      const { google } = await import('googleapis')
      const auth = await getAuthedClient(indexRow.account_id)
      const gmail = google.gmail({ version: 'v1', auth })
      const full = await gmail.users.messages.get({
        userId: 'me', id: indexRow.provider_message_id, format: 'full',
      })
      function extractBody(payload: any): { html: string | null; text: string | null } {
        let html: string | null = null
        let text: string | null = null
        function walk(part: any) {
          if (!part) return
          if (part.mimeType === 'text/html' && part.body?.data)
            html = Buffer.from(part.body.data, 'base64').toString('utf-8')
          else if (part.mimeType === 'text/plain' && part.body?.data)
            text = Buffer.from(part.body.data, 'base64').toString('utf-8')
          for (const sub of part.parts ?? []) walk(sub)
        }
        walk(payload)
        return { html, text }
      }
      const extracted = extractBody(full.data.payload)
      bodyHtml = extracted.html
      bodyText = extracted.text
      rawHeaders = JSON.stringify(full.data.payload?.headers ?? [])
    } else {
      const { getAccessToken } = await import('../auth/outlook')
      const token = await getAccessToken(indexRow.account_id)
      const msgRes = await fetch(
        `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(indexRow.provider_message_id)}?$select=body,internetMessageHeaders`,
        { headers: { Authorization: `Bearer ${token}` } }
      )
      if (!msgRes.ok) throw new Error(`Outlook body fetch failed: ${msgRes.status}`)
      const msg = await msgRes.json() as any
      bodyHtml = msg.body?.contentType === 'html' ? msg.body.content : null
      bodyText = msg.body?.contentType === 'text' ? msg.body.content : null
      rawHeaders = JSON.stringify(msg.internetMessageHeaders ?? [])
    }

    const body = bodyHtml ?? bodyText ?? ''
    const bodyFormat = bodyHtml ? 'html' : 'text'
    const bodyEnc = encrypt(body, user.dataKey)
    const headersEnc = rawHeaders ? encrypt(rawHeaders, user.dataKey) : null

    // ── Store atomically ────────────────────────────────────────────────────
    const storeBody = db.transaction(() => {
      db.prepare(`
        INSERT INTO email_body (email_id, body_enc, body_format, raw_headers_enc, fetched_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(email_id) DO NOTHING
      `).run(req.params.id, bodyEnc, bodyFormat, headersEnc, Date.now())

      db.prepare(`
        UPDATE inbox_index SET has_full_body = 1, sync_state = 'complete'
        WHERE email_id = ?
      `).run(req.params.id)
    })
    storeBody()

    return res.json({
      email_id: indexRow.email_id,
      account_id: indexRow.account_id,
      subject: decrypt(indexRow.subject_preview_enc, user.dataKey),
      sender_email: indexRow.sender_email,
      sender_name: indexRow.sender_name,
      received_at: indexRow.received_at,
      folder: indexRow.folder,
      tab: indexRow.tab,
      is_read: indexRow.is_read,
      is_important: indexRow.is_important,
      body,
      body_format: bodyFormat,
      has_full_body: 1,
      sync_state: 'complete',
    })
  } catch (err: any) {
    console.error(`[index/:id] Body fetch failed for ${req.params.id}:`, err.message)
    return res.status(502).json({ error: 'Failed to fetch email body' })
  }
})

emailsRouter.get('/:id', async (req: Request, res: Response) => {
  const user = (req as any).user
  const db = getDb()
  const row = db.prepare(`
    SELECT e.*,
      pb.biller, pb.amount_rm, pb.due_date, pb.account_ref, pb.status,
      (SELECT json_group_array(json_object('id', l.id, 'name', l.name, 'color', l.color))
       FROM email_labels el JOIN labels l ON l.id = el.label_id
       WHERE el.email_id = e.id) AS labels_json
    FROM emails e
    JOIN accounts a ON a.id = e.account_id
    LEFT JOIN parsed_bills pb ON pb.email_id = e.id
    WHERE e.id = ? AND a.user_id = ?
  `).get(req.params.id, user.id) as any

  if (!row) {
    // Backfill fallback: email is in inbox_index but not the emails table.
    // Look it up by provider_message_id, fetch body on demand, cache in email_body.
    const indexRow = db.prepare(`
      SELECT ii.*, a.provider
      FROM inbox_index ii
      JOIN accounts a ON a.id = ii.account_id
      WHERE ii.provider_message_id = ? AND a.user_id = ?
    `).get(req.params.id, user.id) as any

    if (!indexRow) return res.status(404).json({ error: 'Email not found' })

    try {
      const subject = decrypt(indexRow.subject_preview_enc, user.dataKey)
      const snippet = indexRow.snippet_preview_enc ? decrypt(indexRow.snippet_preview_enc, user.dataKey) : null

      const base = {
        id: req.params.id,
        account_id: indexRow.account_id,
        thread_id: indexRow.thread_id,
        subject, snippet,
        sender: indexRow.sender_email,
        sender_name: indexRow.sender_name,
        received_at: indexRow.received_at,
        is_read: indexRow.is_read,
        folder: indexRow.folder,
        tab: indexRow.tab,
        is_important: indexRow.is_important,
        category: indexRow.category,
        labels: [],
      }

      // Return cached body immediately if available
      const cached = db.prepare('SELECT * FROM email_body WHERE email_id = ?').get(indexRow.email_id) as any
      if (cached) {
        return res.json({ ...base, body: decrypt(cached.body_enc, user.dataKey), body_format: cached.body_format })
      }

      // Body not yet fetched — pull from provider now
      let bodyHtml: string | null = null
      let bodyText: string | null = null

      if (indexRow.provider === 'gmail') {
        const { getAuthedClient } = await import('../auth/gmail')
        const { google } = await import('googleapis')
        const auth = await getAuthedClient(indexRow.account_id)
        const gmail = google.gmail({ version: 'v1', auth })
        const full = await gmail.users.messages.get({
          userId: 'me', id: indexRow.provider_message_id, format: 'full',
        })
        function extractBody(payload: any): { html: string | null; text: string | null } {
          let html: string | null = null; let text: string | null = null
          function walk(part: any) {
            if (!part) return
            if (part.mimeType === 'text/html' && part.body?.data)
              html = Buffer.from(part.body.data, 'base64').toString('utf-8')
            else if (part.mimeType === 'text/plain' && part.body?.data)
              text = Buffer.from(part.body.data, 'base64').toString('utf-8')
            for (const sub of part.parts ?? []) walk(sub)
          }
          walk(payload); return { html, text }
        }
        const extracted = extractBody(full.data.payload)
        bodyHtml = extracted.html; bodyText = extracted.text
      } else {
        const { getAccessToken } = await import('../auth/outlook')
        const token = await getAccessToken(indexRow.account_id)
        const msgRes = await fetch(
          `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(indexRow.provider_message_id)}?$select=body`,
          { headers: { Authorization: `Bearer ${token}` } }
        )
        if (msgRes.ok) {
          const msg = await msgRes.json() as any
          bodyHtml = msg.body?.contentType === 'html' ? msg.body.content : null
          bodyText = msg.body?.contentType === 'text' ? msg.body.content : null
        }
      }

      const body = bodyHtml ?? bodyText ?? ''
      const bodyFormat = bodyHtml ? 'html' : 'text'

      db.transaction(() => {
        db.prepare(`
          INSERT INTO email_body (email_id, body_enc, body_format, fetched_at)
          VALUES (?, ?, ?, ?) ON CONFLICT(email_id) DO NOTHING
        `).run(indexRow.email_id, encrypt(body, user.dataKey), bodyFormat, Date.now())
        db.prepare(`UPDATE inbox_index SET has_full_body = 1, sync_state = 'complete' WHERE email_id = ?`)
          .run(indexRow.email_id)
      })()

      return res.json({ ...base, body, body_format: bodyFormat })
    } catch (err: any) {
      console.error(`[emails/:id] backfill body fetch failed for ${req.params.id}:`, err.message)
      return res.status(502).json({ error: 'Failed to fetch email body' })
    }
  }

  try {
    res.json({
      ...row,
      subject: decrypt(row.subject_enc, user.dataKey),
      body: row.body_enc ? decrypt(row.body_enc, user.dataKey) : null,
      snippet: row.snippet ? decrypt(row.snippet, user.dataKey) : null,
      subject_enc: undefined,
      body_enc: undefined,
      labels: row.labels_json ? JSON.parse(row.labels_json) : [],
      labels_json: undefined,
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

const readBody = z.object({ is_read: z.boolean() })

emailsRouter.patch('/:id/read', (req: Request, res: Response) => {
  const parsed = readBody.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })

  const user = (req as any).user
  const db = getDb()
  db.prepare(`
    UPDATE emails SET is_read = ?
    WHERE id = ? AND account_id IN (SELECT id FROM accounts WHERE user_id = ?)
  `).run(parsed.data.is_read ? 1 : 0, req.params.id, user.id)

  res.json({ ok: true, counts: computeUnreadCounts(db, user.id) })
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

const snoozeBody = z.object({
  until: z.number().int(),
})

emailsRouter.patch('/:id/snooze', (req: Request, res: Response) => {
  const parsed = snoozeBody.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })

  const now = Date.now()
  const maxSnooze = now + 365 * 24 * 60 * 60 * 1000
  if (parsed.data.until <= now) return res.status(400).json({ error: 'until must be in the future' })
  if (parsed.data.until > maxSnooze) return res.status(400).json({ error: 'until must be within 1 year' })

  const user = (req as any).user
  const db = getDb()
  const result = db.prepare(`
    UPDATE emails SET snoozed_until = ?
    WHERE id = ? AND account_id IN (SELECT id FROM accounts WHERE user_id = ?)
  `).run(parsed.data.until, req.params.id, user.id)

  if (result.changes === 0) return res.status(404).json({ error: 'Email not found' })
  res.json({ ok: true })
})

emailsRouter.delete('/:id/snooze', (req: Request, res: Response) => {
  const user = (req as any).user
  const db = getDb()
  const email = db.prepare(`
    SELECT id FROM emails WHERE id = ? AND account_id IN (SELECT id FROM accounts WHERE user_id = ?)
  `).get(req.params.id, user.id)
  if (!email) return res.status(404).json({ error: 'Email not found' })
  db.prepare('UPDATE emails SET snoozed_until = NULL WHERE id = ?').run(req.params.id)
  res.json({ ok: true })
})

// POST /api/emails/:id/labels/:labelId — assign label (INSERT OR IGNORE — idempotent)
emailsRouter.post('/:id/labels/:labelId', (req: Request, res: Response) => {
  const user = (req as any).user
  const db = getDb()

  const email = db.prepare(`
    SELECT e.id FROM emails e JOIN accounts a ON a.id = e.account_id
    WHERE e.id = ? AND a.user_id = ?
  `).get(req.params.id, user.id)
  if (!email) return res.status(404).json({ error: 'Email not found' })

  const label = db.prepare('SELECT id FROM labels WHERE id = ? AND user_id = ?').get(req.params.labelId, user.id)
  if (!label) return res.status(404).json({ error: 'Label not found' })

  db.prepare('INSERT OR IGNORE INTO email_labels (email_id, label_id) VALUES (?, ?)').run(req.params.id, req.params.labelId)
  res.json({ ok: true })
})

// DELETE /api/emails/:id/labels/:labelId — remove label assignment
emailsRouter.delete('/:id/labels/:labelId', (req: Request, res: Response) => {
  const user = (req as any).user
  const db = getDb()

  const email = db.prepare(`
    SELECT e.id FROM emails e JOIN accounts a ON a.id = e.account_id
    WHERE e.id = ? AND a.user_id = ?
  `).get(req.params.id, user.id)
  if (!email) return res.status(404).json({ error: 'Email not found' })

  const label = db.prepare('SELECT id FROM labels WHERE id = ? AND user_id = ?').get(req.params.labelId, user.id)
  if (!label) return res.status(404).json({ error: 'Label not found' })

  db.prepare('DELETE FROM email_labels WHERE email_id = ? AND label_id = ?').run(req.params.id, req.params.labelId)
  res.json({ ok: true })
})
