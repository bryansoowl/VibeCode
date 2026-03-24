import { Client } from '@microsoft/microsoft-graph-client'
import { getAccessToken } from '../auth/outlook'
import type { NormalizedEmail } from './types'

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
    : new Date(Date.now() - 30 * 86400_000).toISOString()

  const result = await client
    .api('/me/messages')
    .filter(`receivedDateTime gt ${since}`)
    .select('id,subject,from,receivedDateTime,isRead,bodyPreview,body,conversationId,size')
    .top(50)
    .get()

  return (result.value ?? []).map((msg: any) => normalizeGraphMessage(accountId, msg))
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
    category: null,
    bodyHtml: msg.body?.contentType === 'html' ? msg.body.content : null,
    bodyText: msg.body?.contentType === 'text' ? msg.body.content : null,
    snippet: msg.bodyPreview ?? null,
    rawSize: msg.size ?? 0,
  }
}
