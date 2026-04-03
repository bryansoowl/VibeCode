// src/routes/send.ts
import { Router, type Request, type Response } from 'express'
import { z } from 'zod'
import { randomUUID } from 'crypto'
import { getDb } from '../db'
import { encrypt } from '../crypto'
import { sendEmail } from '../email/send'

export const sendRouter = Router()

const MAX_BODY_BYTES = 50 * 1024 // 50 KB

const sendSchema = z.object({
  to: z.string().email(),
  subject: z.string().min(1),
  body: z.string(),
  accountId: z.string().uuid().optional(),
  replyToEmailId: z.string().min(1).optional(),
})

sendRouter.post('/', async (req: Request, res: Response) => {
  const parsed = sendSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })

  const { to, subject, body, accountId: rawAccountId, replyToEmailId } = parsed.data

  if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) {
    return res.status(400).json({ error: 'body exceeds 50 KB limit' })
  }

  if (!rawAccountId && !replyToEmailId) {
    return res.status(400).json({ error: 'accountId or replyToEmailId is required' })
  }

  const user = (req as any).user
  const db = getDb()

  let accountId: string

  if (replyToEmailId) {
    const email = db.prepare(`
      SELECT e.account_id FROM emails e
      JOIN accounts a ON a.id = e.account_id
      WHERE e.id = ? AND a.user_id = ?
    `).get(replyToEmailId, user.id) as any

    if (!email) return res.status(404).json({ error: 'Email not found' })
    accountId = email.account_id
  } else {
    const account = db.prepare(
      'SELECT id FROM accounts WHERE id = ? AND user_id = ?'
    ).get(rawAccountId, user.id) as any

    if (!account) return res.status(404).json({ error: 'Account not found' })
    accountId = rawAccountId!
  }

  try {
    await sendEmail(accountId, { to, subject, bodyHtml: body })
  } catch (err: any) {
    const msg: string = err?.message ?? ''
    if (msg.includes('re-auth required')) {
      return res.status(401).json({ error: msg, reconnect: true })
    }
    return res.status(502).json({ error: msg })
  }

  const id = randomUUID()
  const now = Date.now()

  db.prepare(`
    INSERT INTO emails (id, account_id, subject_enc, sender, received_at, is_read, folder, tab)
    VALUES (?, ?, ?, ?, ?, 1, 'sent', 'primary')
  `).run(id, accountId, encrypt(subject, user.dataKey), to, now)

  return res.status(200).json({ id })
})
