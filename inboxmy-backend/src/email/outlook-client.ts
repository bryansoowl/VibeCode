import { Client } from '@microsoft/microsoft-graph-client'
import { getAccessToken } from '../auth/outlook'
import type { NormalizedEmail, NormalizedEmailMetadata } from './types'

export async function fetchNewEmails(
  accountId: string,
  sinceMs: number | null
): Promise<NormalizedEmail[]> {
  const accessToken = await getAccessToken(accountId)
  const client = Client.init({
    authProvider: (done) => done(null, accessToken),
  })

  const since = sinceMs
    ? new Date(sinceMs).toISOString()
    : new Date(Date.now() - 90 * 86400_000).toISOString()

  const result = await client
    .api('/me/messages')
    .filter(`receivedDateTime gt ${since}`)
    .select('id,subject,from,receivedDateTime,isRead,bodyPreview,body,conversationId')
    .top(500)
    .get()

  return (result.value ?? []).map((msg: any) => normalizeGraphMessage(accountId, msg))
}

/**
 * Fetch email metadata only (no body) — used by Phase 1 fast sync and Phase 2 backfill.
 * @param accountId - The account to fetch for
 * @param beforeMs - Optional: fetch emails older than this timestamp (for backfill pagination)
 * @param limit - Max emails to fetch (default 100, backfill uses 25)
 */
export async function fetchEmailsMetadata(
  accountId: string,
  beforeMs?: number,
  limit = 100
): Promise<NormalizedEmailMetadata[]> {
  const accessToken = await getAccessToken(accountId)
  const client = Client.init({
    authProvider: (done) => done(null, accessToken),
  })

  const before = beforeMs
    ? new Date(beforeMs).toISOString()
    : new Date(Date.now() - 90 * 86400_000).toISOString()

  const result = await client
    .api('/me/messages')
    .filter(`receivedDateTime lt ${before}`)
    .select('id,subject,from,receivedDateTime,isRead,bodyPreview,conversationId,importance')
    .top(limit)
    .get()

  return (result.value ?? []).map((msg: any) => normalizeGraphMetadata(accountId, msg))
}

function normalizeGraphMessage(accountId: string, msg: any): NormalizedEmail {
  const from = msg.from?.emailAddress
  return {
    id: msg.id,
    accountId,
    threadId: msg.conversationId ?? null,
    subject: msg.subject ?? '(no subject)',
    sender: (from?.address ?? '').toLowerCase(),
    senderName: from?.name ?? null,
    receivedAt: new Date(msg.receivedDateTime).getTime(),
    isRead: msg.isRead,
    folder: 'inbox',
    tab: 'primary',  // Outlook has no CATEGORY_* equivalent; Focused/Other not yet mapped
    isImportant: msg.importance === 'high',
    category: null,
    bodyHtml: msg.body?.contentType === 'html' ? msg.body.content : null,
    bodyText: msg.body?.contentType === 'text' ? msg.body.content : null,
    snippet: msg.bodyPreview ?? null,
    rawSize: msg.size ?? 0,
  }
}

function normalizeGraphMetadata(accountId: string, msg: any): NormalizedEmailMetadata {
  const from = msg.from?.emailAddress
  return {
    id: msg.id,
    accountId,
    threadId: msg.conversationId ?? null,
    subject: msg.subject ?? '(no subject)',
    sender: (from?.address ?? '').toLowerCase(),
    senderName: from?.name ?? null,
    receivedAt: new Date(msg.receivedDateTime).getTime(),
    isRead: msg.isRead,
    folder: 'inbox',
    tab: 'primary',
    isImportant: msg.importance === 'high',
    category: null,
    snippet: msg.bodyPreview ?? null,
    rawSize: msg.size ?? 0,
  }
}
