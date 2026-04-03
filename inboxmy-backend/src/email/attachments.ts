// src/email/attachments.ts
import { google } from 'googleapis'
import { getAuthedClient } from '../auth/gmail'
import { getAccessToken } from '../auth/outlook'

export interface AttachmentMeta {
  id: string
  name: string
  contentType: string
  size: number
}

export async function listAttachments(
  msgId: string,
  accountId: string,
  provider: string
): Promise<AttachmentMeta[]> {
  if (provider === 'gmail') return listGmailAttachments(msgId, accountId)
  return listOutlookAttachments(msgId, accountId)
}

export async function getAttachmentContent(
  msgId: string,
  accountId: string,
  provider: string,
  attId: string
): Promise<{ data: Buffer; contentType: string; name: string }> {
  if (provider === 'gmail') return getGmailAttachment(msgId, accountId, attId)
  return getOutlookAttachment(msgId, accountId, attId)
}

// ── Gmail ────────────────────────────────────────────────────────────────────

async function listGmailAttachments(msgId: string, accountId: string): Promise<AttachmentMeta[]> {
  const auth = await getAuthedClient(accountId)
  const gmail = google.gmail({ version: 'v1', auth })
  const msg = await gmail.users.messages.get({ userId: 'me', id: msgId, format: 'full' })
  return extractGmailAttachmentMeta(msg.data.payload)
}

function extractGmailAttachmentMeta(payload: any): AttachmentMeta[] {
  const result: AttachmentMeta[] = []
  function walk(part: any) {
    if (!part) return
    // Skip inline parts
    const disposition: string = (part.headers ?? []).find((h: any) => h.name?.toLowerCase() === 'content-disposition')?.value ?? ''
    if (part.filename && part.body?.attachmentId && !disposition.startsWith('inline')) {
      result.push({
        id: part.body.attachmentId,
        name: part.filename,
        contentType: part.mimeType || 'application/octet-stream',
        size: part.body.size || 0,
      })
    }
    for (const sub of part.parts ?? []) walk(sub)
  }
  walk(payload)
  return result
}

async function getGmailAttachment(
  msgId: string,
  accountId: string,
  attId: string
): Promise<{ data: Buffer; contentType: string; name: string }> {
  const auth = await getAuthedClient(accountId)
  const gmail = google.gmail({ version: 'v1', auth })

  // Fetch content and message in parallel
  const [attRes, msgRes] = await Promise.all([
    gmail.users.messages.attachments.get({ userId: 'me', messageId: msgId, id: attId }),
    gmail.users.messages.get({ userId: 'me', id: msgId, format: 'full' }),
  ])

  const data = Buffer.from(attRes.data.data ?? '', 'base64url')

  let name = 'attachment'
  let contentType = 'application/octet-stream'
  function walk(part: any) {
    if (!part) return
    if (part.body?.attachmentId === attId) {
      name = part.filename || name
      contentType = part.mimeType || contentType
    }
    for (const sub of part.parts ?? []) walk(sub)
  }
  walk(msgRes.data.payload)

  return { data, contentType, name }
}

// ── Outlook ──────────────────────────────────────────────────────────────────

async function listOutlookAttachments(msgId: string, accountId: string): Promise<AttachmentMeta[]> {
  const token = await getAccessToken(accountId)
  const res = await fetch(
    `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(msgId)}/attachments?$select=id,name,contentType,size,isInline`,
    { headers: { Authorization: `Bearer ${token}` } }
  )
  if (!res.ok) return []
  const data = await res.json() as any
  return (data.value ?? [])
    .filter((a: any) => !a.isInline)
    .map((a: any) => ({
      id: a.id as string,
      name: a.name as string,
      contentType: (a.contentType as string) || 'application/octet-stream',
      size: (a.size as number) || 0,
    }))
}

async function getOutlookAttachment(
  msgId: string,
  accountId: string,
  attId: string
): Promise<{ data: Buffer; contentType: string; name: string }> {
  const token = await getAccessToken(accountId)
  const res = await fetch(
    `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(msgId)}/attachments/${encodeURIComponent(attId)}`,
    { headers: { Authorization: `Bearer ${token}` } }
  )
  if (!res.ok) throw new Error(`Outlook attachment fetch failed: ${res.status}`)
  const att = await res.json() as any
  return {
    data: Buffer.from(att.contentBytes || '', 'base64'),
    contentType: att.contentType || 'application/octet-stream',
    name: att.name || 'attachment',
  }
}
