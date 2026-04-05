// src/email/gmail-client.ts
import { google } from 'googleapis'
import { getAuthedClient } from '../auth/gmail'
import type { NormalizedEmail, NormalizedEmailMetadata } from './types'

const FETCH_LIMIT = 500  // per full sync run

export async function fetchNewEmails(
  accountId: string,
  sinceMs: number | null,
  historyId: string | null
): Promise<{ emails: NormalizedEmail[], newHistoryId: string | null }> {
  const auth = await getAuthedClient(accountId)
  const gmail = google.gmail({ version: 'v1', auth })

  console.log(`[gmail] sinceMs=${sinceMs} historyId=${historyId}`)

  // ── Incremental mode (History API) ──────────────────────────────────────────
  // Only use incremental mode when we also have a sinceMs — if sinceMs is null
  // it means a full resync was requested, so skip straight to full sync.
  if (historyId && sinceMs) {
    console.log(`[gmail] incremental mode, historyId=${historyId}`)
    try {
      const history = await gmail.users.history.list({
        userId: 'me',
        startHistoryId: historyId,
        historyTypes: ['messageAdded'],
      })

      const newHistoryId = history.data.historyId ?? historyId
      const records = history.data.history ?? []
      console.log(`[gmail] history records=${records.length} newHistoryId=${newHistoryId}`)

      // Collect unique IDs of newly added messages
      const messageIds = new Set<string>()
      for (const record of records) {
        for (const added of record.messagesAdded ?? []) {
          if (added.message?.id) messageIds.add(added.message.id)
        }
      }

      console.log(`[gmail] incremental: ${messageIds.size} new message(s)`)
      if (messageIds.size === 0) return { emails: [], newHistoryId }

      // Fetch full details only for the new messages
      const emails: NormalizedEmail[] = []
      for (const id of messageIds) {
        try {
          const full = await gmail.users.messages.get({ userId: 'me', id, format: 'full' })
          emails.push(normalizeGmailMessage(accountId, full.data))
        } catch { /* skip individual failures */ }
      }

      return { emails, newHistoryId }
    } catch (err: any) {
      // 404 means historyId is too old — fall through to full sync below
      if (err.code !== 404 && err.status !== 404) throw err
      console.log(`[gmail] historyId stale for ${accountId}, falling back to full sync`)
    }
  }

  // ── Full sync ────────────────────────────────────────────────────────────────
  const BUFFER_MS = 24 * 60 * 60 * 1000
  const query = sinceMs
    ? `after:${Math.floor((sinceMs - BUFFER_MS) / 1000)}`
    : 'newer_than:90d'

  console.log(`[gmail] full sync query="${query}"`)

  let list: any
  try {
    list = await gmail.users.messages.list({
      userId: 'me',
      q: query,
      maxResults: FETCH_LIMIT,
      includeSpamTrash: true,
    })
  } catch (err: any) {
    console.error(`[gmail] messages.list error: ${err.message} code=${err.code} status=${err.status}`)
    throw err
  }

  console.log(`[gmail] messages.list returned ${list.data.messages?.length ?? 0} results, nextPageToken=${list.data.nextPageToken ?? 'none'}`)

  const messages = list.data.messages ?? []
  const emails: NormalizedEmail[] = []

  for (const msg of messages) {
    try {
      const full = await gmail.users.messages.get({
        userId: 'me',
        id: msg.id!,
        format: 'full',
      })
      emails.push(normalizeGmailMessage(accountId, full.data))
    } catch (err: any) {
      console.error(`[gmail] messages.get error for ${msg.id}: ${err.message}`)
    }
  }

  // Capture current historyId so future syncs can use incremental mode
  let newHistoryId: string | null = null
  try {
    const profile = await gmail.users.getProfile({ userId: 'me' })
    newHistoryId = profile.data.historyId ?? null
    console.log(`[gmail] captured newHistoryId=${newHistoryId}`)
  } catch (err: any) {
    console.error(`[gmail] getProfile error: ${err.message}`)
  }

  return { emails, newHistoryId }
}

/**
 * Fetch email metadata only (no body) — used by Phase 1 fast sync and Phase 2 backfill.
 * @param accountId - The account to fetch for
 * @param beforeMs - Optional: fetch emails received before this unix ms timestamp (for backfill pagination)
 * @param limit - Max emails to fetch (default 100, backfill uses 25)
 */
export async function fetchEmailsMetadata(
  accountId: string,
  beforeMs?: number,
  limit = 100
): Promise<NormalizedEmailMetadata[]> {
  const auth = await getAuthedClient(accountId)
  const gmail = google.gmail({ version: 'v1', auth })

  // Build date query
  const query = beforeMs
    ? `before:${Math.floor(beforeMs / 1000)}`
    : 'newer_than:90d'

  console.log(`[gmail] fetchEmailsMetadata accountId=${accountId} query="${query}" limit=${limit}`)

  let list: any
  try {
    list = await gmail.users.messages.list({
      userId: 'me',
      q: query,
      maxResults: limit,
      includeSpamTrash: true,
    })
  } catch (err: any) {
    console.error(`[gmail] messages.list error: ${err.message}`)
    throw err
  }

  const messages = list.data.messages ?? []
  const results: NormalizedEmailMetadata[] = []

  for (const msg of messages) {
    try {
      const meta = await gmail.users.messages.get({
        userId: 'me',
        id: msg.id!,
        format: 'metadata',
        metadataHeaders: ['From', 'Subject', 'Date'],
      })
      results.push(normalizeGmailMetadata(accountId, meta.data))
    } catch (err: any) {
      console.error(`[gmail] messages.get metadata error for ${msg.id}: ${err.message}`)
    }
  }

  return results
}

function normalizeGmailMetadata(accountId: string, msg: any): NormalizedEmailMetadata {
  const headers: Record<string, string> = {}
  for (const h of msg.payload?.headers ?? []) {
    headers[h.name.toLowerCase()] = h.value
  }

  const labelIds: string[] = msg.labelIds ?? []
  const from = headers['from'] ?? ''
  const senderMatch = from.match(/^(.+?)\s*<([^>]+)>$/)
  const senderEmail = senderMatch ? senderMatch[2] : from
  const senderName = senderMatch ? senderMatch[1].replace(/"/g, '').trim() : null

  return {
    id: msg.id,
    accountId,
    threadId: msg.threadId ?? null,
    subject: headers['subject'] ?? '(no subject)',
    sender: senderEmail.toLowerCase(),
    senderName,
    receivedAt: parseInt(msg.internalDate ?? '0'),
    isRead: !labelIds.includes('UNREAD'),
    folder: gmailFolder(labelIds),
    tab: gmailTab(labelIds),
    isImportant: labelIds.includes('IMPORTANT'),
    category: null,
    snippet: msg.snippet ?? null,
    rawSize: msg.sizeEstimate ?? 0,
  }
}

function gmailFolder(labelIds: string[]): import('./types').EmailFolder {
  if (labelIds.includes('DRAFT')) return 'draft'
  if (labelIds.includes('TRASH')) return 'trash'
  if (labelIds.includes('SPAM'))  return 'spam'
  if (labelIds.includes('SENT'))  return 'sent'
  return 'inbox'
}

function gmailTab(labelIds: string[]): import('./types').EmailTab {
  if (labelIds.includes('CATEGORY_PROMOTIONS')) return 'promotions'
  if (labelIds.includes('CATEGORY_SOCIAL'))     return 'social'
  if (labelIds.includes('CATEGORY_UPDATES'))    return 'updates'
  if (labelIds.includes('CATEGORY_FORUMS'))     return 'forums'
  return 'primary'
}

function normalizeGmailMessage(accountId: string, msg: any): NormalizedEmail {
  const headers: Record<string, string> = {}
  for (const h of msg.payload?.headers ?? []) {
    headers[h.name.toLowerCase()] = h.value
  }

  const labelIds: string[] = msg.labelIds ?? []
  const from = headers['from'] ?? ''
  const senderMatch = from.match(/^(.+?)\s*<([^>]+)>$/)
  const senderEmail = senderMatch ? senderMatch[2] : from
  const senderName = senderMatch ? senderMatch[1].replace(/"/g, '').trim() : null

  const { htmlBody, textBody } = extractBody(msg.payload)

  return {
    id: msg.id,
    accountId,
    threadId: msg.threadId ?? null,
    subject: headers['subject'] ?? '(no subject)',
    sender: senderEmail.toLowerCase(),
    senderName,
    receivedAt: parseInt(msg.internalDate ?? '0'),
    isRead: !labelIds.includes('UNREAD'),
    folder: gmailFolder(labelIds),
    tab: gmailTab(labelIds),
    isImportant: labelIds.includes('IMPORTANT'),
    category: null,
    bodyHtml: htmlBody,
    bodyText: textBody,
    snippet: msg.snippet ?? null,
    rawSize: msg.sizeEstimate ?? 0,
  }
}

function extractBody(payload: any): { htmlBody: string | null; textBody: string | null } {
  let htmlBody: string | null = null
  let textBody: string | null = null

  function walk(part: any) {
    if (!part) return
    if (part.mimeType === 'text/html' && part.body?.data) {
      htmlBody = Buffer.from(part.body.data, 'base64').toString('utf-8')
    } else if (part.mimeType === 'text/plain' && part.body?.data) {
      textBody = Buffer.from(part.body.data, 'base64').toString('utf-8')
    }
    for (const sub of part.parts ?? []) walk(sub)
  }

  walk(payload)
  return { htmlBody, textBody }
}
