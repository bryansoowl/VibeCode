// src/email/sync-engine.ts
import { getDb } from '../db'
import { encrypt, deriveSearchKey, searchTokenHash } from '../crypto'
import { tokenizeForSearch, SEARCH_TOKEN_CAP } from './search'
import { fetchNewEmails as fetchGmail } from './gmail-client'
import { fetchNewEmails as fetchOutlook } from './outlook-client'
import { parseEmail } from '../parsers'
import { scoreSpam } from '../parsers/spam-scorer'
import { randomUUID } from 'crypto'
import type { NormalizedEmail } from './types'

const AUTH_ERRORS = /invalid_grant|\b401\b|token has been expired or revoked|\bunauthorized\b|re-auth required/i

export interface NewEmailSummary {
  id: string
  sender: string
  senderName: string | null
  subject: string   // plaintext from NormalizedEmail.subject before encryption, max 200 chars
  accountId: string
}

export async function syncAccount(
  accountId: string,
  dataKey: Buffer
): Promise<{ added: number; errors: string[]; newEmails: NewEmailSummary[] }> {
  const db = getDb()
  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId) as any
  if (!account) throw new Error(`Account ${accountId} not found`)

  const logId = db.prepare(
    'INSERT INTO sync_log (account_id, started_at) VALUES (?, ?)'
  ).run(accountId, Date.now()).lastInsertRowid

  const errors: string[] = []
  let added = 0
  const newEmails: NewEmailSummary[] = []

  try {
    const sinceMs = account.last_synced ?? null
    const historyId = account.gmail_history_id ?? null
    console.log(`[sync] Fetching emails for ${account.email} (${account.provider})…`)

    let emails: NormalizedEmail[]
    let newHistoryId: string | null = null

    if (account.provider === 'gmail') {
      const result = await fetchGmail(accountId, sinceMs, historyId)
      emails = result.emails
      newHistoryId = result.newHistoryId
    } else {
      emails = await fetchOutlook(accountId, sinceMs)
    }

    console.log(`[sync] Fetched ${emails.length} emails, processing…`)

    const insertEmail = db.prepare(`
      INSERT OR IGNORE INTO emails
        (id, account_id, thread_id, subject_enc, sender, sender_name,
         received_at, is_read, folder, tab, is_important, category, body_enc, snippet, raw_size)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)

    const insertIndex = db.prepare(`
      INSERT INTO inbox_index
        (email_id, account_id, provider_message_id, thread_id,
         sender_email, sender_name, subject_preview_enc, snippet_preview_enc,
         received_at, folder, tab, is_read, is_important, category)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id, provider_message_id) DO NOTHING
    `)

    const insertBill = db.prepare(`
      INSERT INTO parsed_bills (id, email_id, biller, amount_rm, due_date, account_ref, parsed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)

    const deleteStaleDraft = db.prepare(`
      DELETE FROM emails
      WHERE account_id = ? AND thread_id = ? AND folder = 'draft' AND id != ?
    `)
    const deleteStaleDraftIndex = db.prepare(`
      DELETE FROM inbox_index
      WHERE account_id = ? AND thread_id = ? AND folder = 'draft' AND provider_message_id != ?
    `)

    const insertSearchToken = db.prepare(`
      INSERT OR IGNORE INTO email_search (email_id, account_id, token_hash)
      VALUES (?, ?, ?)
    `)

    // Derive once per sync call — not per email, not per token
    const searchKey = deriveSearchKey(dataKey)

    const syncAll = db.transaction((emails: NormalizedEmail[]) => {
      const staged: NewEmailSummary[] = []
      for (const email of emails) {
        const parsed = parseEmail(email)
        const body = email.bodyHtml ?? email.bodyText ?? ''

        const spamResult = scoreSpam(email)
        const finalFolder = spamResult.isSpam ? 'spam' : (email.folder ?? 'inbox')
        const finalTab    = finalFolder === 'spam' ? 'primary' : (email.tab ?? 'primary')

        // Remove stale draft copies for the same thread before inserting the latest
        if (finalFolder === 'draft' && email.threadId) {
          deleteStaleDraft.run(accountId, email.threadId, email.id)
          deleteStaleDraftIndex.run(accountId, email.threadId, email.id)
        }

        const result = insertEmail.run(
          email.id, accountId, email.threadId ?? null,
          encrypt(email.subject, dataKey),
          email.sender, email.senderName ?? null,
          email.receivedAt, email.isRead ? 1 : 0,
          finalFolder,
          finalTab,
          email.isImportant ? 1 : 0,
          parsed.category ?? null,
          body ? encrypt(body, dataKey) : null,
          email.snippet ? encrypt(email.snippet, dataKey) : null,
          email.rawSize
        )

        if (result.changes > 0) {
          added++
          // Don't notify for drafts — they're not incoming messages
          if (finalFolder !== 'draft') {
            staged.push({
              id: email.id,
              sender: email.sender,
              senderName: email.senderName ?? null,
              subject: (email.subject ?? '').slice(0, 200),
              accountId,
            })
          }
          // Save UUID so email_search can reference the same inbox_index row (Fix 5)
          const emailUuid = randomUUID()
          insertIndex.run(
            emailUuid,
            accountId,
            email.id,
            email.threadId ?? null,
            email.sender,
            email.senderName ?? null,
            encrypt(email.subject, dataKey),
            email.snippet ? encrypt(email.snippet, dataKey) : null,
            email.receivedAt,
            finalFolder,
            finalTab,
            email.isRead ? 1 : 0,
            email.isImportant ? 1 : 0,
            parsed.category ?? null
          )

          // Search token indexing — runs on plaintext BEFORE encryption
          // Dedup tokens first, then cap, then hash (Fix 2 + Fix 6)
          const tokens = [...new Set(
            [email.sender, email.subject, email.snippet ?? ''].flatMap(tokenizeForSearch)
          )].slice(0, SEARCH_TOKEN_CAP)
          for (const token of tokens) {
            insertSearchToken.run(emailUuid, accountId, searchTokenHash(token, searchKey))
          }

          if (parsed.bill?.amountRm != null || parsed.bill?.dueDateMs != null) {
            insertBill.run(
              randomUUID(), email.id, parsed.bill.biller,
              parsed.bill.amountRm ?? null, parsed.bill.dueDateMs ?? null,
              parsed.bill.accountRef ?? null, Date.now()
            )
          }
        }
      }
      return staged
    })

    const staged = syncAll(emails)
    newEmails.push(...staged)

    db.prepare(
      'UPDATE accounts SET last_synced = ?, token_expired = 0, gmail_history_id = COALESCE(?, gmail_history_id) WHERE id = ?'
    ).run(Date.now(), newHistoryId, accountId)

    // ── Update sync_state ────────────────────────────────────────────────────
    db.prepare(`
      INSERT INTO sync_state (account_id, last_fast_sync_at, fast_sync_cursor)
      VALUES (?, ?, ?)
      ON CONFLICT(account_id) DO UPDATE SET
        last_fast_sync_at = excluded.last_fast_sync_at,
        fast_sync_cursor  = COALESCE(excluded.fast_sync_cursor, fast_sync_cursor)
    `).run(accountId, Date.now(), newHistoryId ?? null)

    // ── Seed backfill cursors (idempotent) ────────────────────────────────────
    for (const folder of ['inbox', 'sent', 'spam']) {
      db.prepare(`
        INSERT INTO sync_backfill_cursors (account_id, folder, complete)
        VALUES (?, ?, 0)
        ON CONFLICT(account_id, folder) DO NOTHING
      `).run(accountId, folder)
    }

    db.prepare('UPDATE sync_log SET finished_at = ?, emails_added = ? WHERE id = ?')
      .run(Date.now(), added, logId)

    if (added > 0) console.log(`[sync] Done — added ${added} emails`)

  } catch (err: any) {
    console.error(`[sync] Error for ${accountId}:`, err.message)
    if (AUTH_ERRORS.test(err.message)) {
      db.prepare('UPDATE accounts SET token_expired = 1 WHERE id = ?').run(accountId)
    }
    errors.push(err.message)
    db.prepare('UPDATE sync_log SET finished_at = ?, error = ? WHERE id = ?')
      .run(Date.now(), err.message, logId)
  }

  return { added, errors, newEmails }
}

export async function syncAllAccounts(
  userId: string,
  dataKey: Buffer
): Promise<{ added: number; newEmails: NewEmailSummary[] }> {
  const db = getDb()
  const accounts = db.prepare('SELECT id FROM accounts WHERE user_id = ?').all(userId) as any[]
  let totalAdded = 0
  const allNewEmails: NewEmailSummary[] = []
  for (const acc of accounts) {
    const result = await syncAccount(acc.id, dataKey)
    totalAdded += result.added
    allNewEmails.push(...result.newEmails)
  }
  return { added: totalAdded, newEmails: allNewEmails }
}
