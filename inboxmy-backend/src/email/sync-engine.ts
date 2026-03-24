import { getDb } from '../db'
import { encrypt } from '../crypto'
import { fetchNewEmails as fetchGmail } from './gmail-client'
import { fetchNewEmails as fetchOutlook } from './outlook-client'
import { parseEmail } from '../parsers'
import { randomUUID } from 'crypto'
import type { NormalizedEmail } from './types'

export async function syncAccount(accountId: string): Promise<{ added: number; errors: string[] }> {
  const db = getDb()
  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId) as any
  if (!account) throw new Error(`Account ${accountId} not found`)

  const logId = db.prepare(
    'INSERT INTO sync_log (account_id, started_at) VALUES (?, ?)'
  ).run(accountId, Date.now()).lastInsertRowid

  const errors: string[] = []
  let added = 0

  try {
    const sinceMs = account.last_synced ?? null
    const emails: NormalizedEmail[] = account.provider === 'gmail'
      ? await fetchGmail(accountId, sinceMs)
      : await fetchOutlook(accountId, sinceMs)

    const insertEmail = db.prepare(`
      INSERT OR IGNORE INTO emails
        (id, account_id, thread_id, subject_enc, sender, sender_name,
         received_at, is_read, category, body_enc, snippet, raw_size)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)

    const insertBill = db.prepare(`
      INSERT INTO parsed_bills (id, email_id, biller, amount_rm, due_date, account_ref, parsed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)

    const syncAll = db.transaction((emails: NormalizedEmail[]) => {
      for (const email of emails) {
        const parsed = parseEmail(email)
        const body = email.bodyHtml ?? email.bodyText ?? ''

        const result = insertEmail.run(
          email.id, accountId, email.threadId ?? null,
          encrypt(email.subject),
          email.sender, email.senderName ?? null,
          email.receivedAt, email.isRead ? 1 : 0,
          parsed.category ?? null,
          body ? encrypt(body) : null,
          email.snippet ? encrypt(email.snippet) : null,
          email.rawSize
        )

        if (result.changes > 0) {
          added++
          if (parsed.bill?.amountRm != null || parsed.bill?.dueDateMs != null) {
            insertBill.run(
              randomUUID(), email.id, parsed.bill.biller,
              parsed.bill.amountRm ?? null, parsed.bill.dueDateMs ?? null,
              parsed.bill.accountRef ?? null, Date.now()
            )
          }
        }
      }
    })

    syncAll(emails)

    db.prepare('UPDATE accounts SET last_synced = ? WHERE id = ?').run(Date.now(), accountId)
    db.prepare('UPDATE sync_log SET finished_at = ?, emails_added = ? WHERE id = ?')
      .run(Date.now(), added, logId)

  } catch (err: any) {
    errors.push(err.message)
    db.prepare('UPDATE sync_log SET finished_at = ?, error = ? WHERE id = ?')
      .run(Date.now(), err.message, logId)
  }

  return { added, errors }
}

export async function syncAllAccounts(): Promise<void> {
  const db = getDb()
  const accounts = db.prepare('SELECT id FROM accounts').all() as any[]
  for (const acc of accounts) {
    await syncAccount(acc.id)
  }
}
