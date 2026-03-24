// src/email/gmail-client.ts
import { google } from 'googleapis'
import { getAuthedClient } from '../auth/gmail'
import type { NormalizedEmail } from './types'

const FETCH_LIMIT = 50  // per sync run

export async function fetchNewEmails(
  accountId: string,
  sinceMs: number | null
): Promise<NormalizedEmail[]> {
  const auth = await getAuthedClient(accountId)
  const gmail = google.gmail({ version: 'v1', auth })

  const query = sinceMs
    ? `after:${Math.floor(sinceMs / 1000)}`
    : 'newer_than:30d'

  const list = await gmail.users.messages.list({
    userId: 'me',
    q: query,
    maxResults: FETCH_LIMIT,
  })

  const messages = list.data.messages ?? []
  const emails: NormalizedEmail[] = []

  for (const msg of messages) {
    const full = await gmail.users.messages.get({
      userId: 'me',
      id: msg.id!,
      format: 'full',
    })

    emails.push(normalizeGmailMessage(accountId, full.data))
  }

  return emails
}

function normalizeGmailMessage(accountId: string, msg: any): NormalizedEmail {
  const headers: Record<string, string> = {}
  for (const h of msg.payload?.headers ?? []) {
    headers[h.name.toLowerCase()] = h.value
  }

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
    isRead: !(msg.labelIds ?? []).includes('UNREAD'),
    category: null,  // set by parser
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
