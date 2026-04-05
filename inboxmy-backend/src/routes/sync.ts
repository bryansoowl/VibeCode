// src/routes/sync.ts
import { Router } from 'express'
import { getDb } from '../db'
import { syncAccount, syncAllAccounts } from '../email/sync-engine'
import { fetchEmailsMetadata as fetchGmailMetadata } from '../email/gmail-client'
import { fetchEmailsMetadata as fetchOutlookMetadata } from '../email/outlook-client'
import { encrypt } from '../crypto'
import { randomUUID } from 'crypto'

export const syncRouter = Router()

syncRouter.post('/backfill', async (req, res) => {
  const { accountId } = req.body
  const user = (req as any).user
  const db = getDb()

  if (!accountId) return res.status(400).json({ error: 'accountId required' })

  const account = db.prepare(
    'SELECT id, provider FROM accounts WHERE id = ? AND user_id = ?'
  ).get(accountId, user.id) as any
  if (!account) return res.status(404).json({ error: 'Account not found' })

  const BATCH_SIZE = 25
  const BACKFILL_FOLDERS = ['inbox', 'sent', 'spam'] as const
  const results: Array<{ folder: string; added: number; complete: boolean; skipped?: boolean }> = []

  const insertIndex = db.prepare(`
    INSERT INTO inbox_index
      (email_id, account_id, provider_message_id, thread_id,
       sender_email, sender_name, subject_preview_enc, snippet_preview_enc,
       received_at, folder, tab, is_read, is_important, category)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(account_id, provider_message_id) DO NOTHING
  `)

  for (const folder of BACKFILL_FOLDERS) {
    const cursorRow = db.prepare(
      'SELECT cursor, complete FROM sync_backfill_cursors WHERE account_id = ? AND folder = ?'
    ).get(accountId, folder) as any

    if (!cursorRow || cursorRow.complete === 1) {
      results.push({ folder, added: 0, complete: true, skipped: true })
      continue
    }

    const parsedCursor: { received_at: number; email_id: string } | null =
      cursorRow.cursor ? JSON.parse(cursorRow.cursor) : null

    const beforeMs = parsedCursor?.received_at ?? undefined
    let batch: any[] = []
    try {
      const fetcher = account.provider === 'gmail' ? fetchGmailMetadata : fetchOutlookMetadata
      batch = await fetcher(accountId, beforeMs, BATCH_SIZE)
    } catch (err: any) {
      console.error(`[backfill] Provider fetch failed for ${accountId}/${folder}:`, err.message)
      results.push({ folder, added: 0, complete: false })
      continue
    }

    const insertedIds: string[] = []
    for (const email of batch) {
      const newUuid = randomUUID()
      const finalFolder = email.folder ?? folder
      const finalTab = email.tab ?? 'primary'

      const r = insertIndex.run(
        newUuid, accountId, email.id, email.threadId ?? null,
        email.sender, email.senderName ?? null,
        encrypt(email.subject, user.dataKey),
        email.snippet ? encrypt(email.snippet, user.dataKey) : null,
        email.receivedAt, finalFolder, finalTab,
        email.isRead ? 1 : 0, email.isImportant ? 1 : 0, email.category ?? null
      )
      if (r.changes > 0) insertedIds.push(newUuid)
    }

    const isComplete = batch.length < BATCH_SIZE

    // Cursor scoped to inserted_ids only — prevents stalling by never querying globally
    let newCursorJson: string | null = cursorRow.cursor
    if (insertedIds.length > 0) {
      const placeholders = insertedIds.map(() => '?').join(',')
      const oldestInserted = db.prepare(`
        SELECT received_at, email_id FROM inbox_index
        WHERE email_id IN (${placeholders})
        ORDER BY received_at ASC, email_id ASC
        LIMIT 1
      `).get(insertedIds) as any
      if (oldestInserted) {
        newCursorJson = JSON.stringify({
          received_at: oldestInserted.received_at,
          email_id: oldestInserted.email_id,
        })
      }
    }

    db.prepare(`
      UPDATE sync_backfill_cursors
      SET cursor = ?, complete = ?
      WHERE account_id = ? AND folder = ?
    `).run(newCursorJson, isComplete ? 1 : 0, accountId, folder)

    results.push({ folder, added: insertedIds.length, complete: isComplete })
  }

  db.prepare(`
    INSERT INTO sync_state (account_id, last_backfill_at)
    VALUES (?, ?)
    ON CONFLICT(account_id) DO UPDATE SET last_backfill_at = excluded.last_backfill_at
  `).run(accountId, Date.now())

  res.json({ results })
})

syncRouter.post('/trigger', async (req, res) => {
  const { accountId } = req.body
  const user = (req as any).user

  if (accountId) {
    const account = getDb().prepare(
      'SELECT id FROM accounts WHERE id = ? AND user_id = ?'
    ).get(accountId, user.id)
    if (!account) return res.status(404).json({ error: 'Account not found' })
  }

  const target = accountId ? `account ${accountId}` : 'all accounts'
  console.log(`[sync] Manual trigger — ${target}`)
  try {
    if (accountId) {
      const result = await syncAccount(accountId, user.dataKey)
      console.log(`[sync] Done — added ${result.added} emails`)
      res.json({ added: result.added, emails: result.newEmails, errors: result.errors })
    } else {
      const result = await syncAllAccounts(user.id, user.dataKey)
      console.log(`[sync] Done — all accounts, added ${result.added} emails`)
      res.json({ added: result.added, emails: result.newEmails })
    }
  } catch (err: any) {
    console.error('[sync] Failed:', err.message)
    res.status(500).json({ error: err.message })
  }
})
