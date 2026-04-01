// src/email/send.ts
import { google } from 'googleapis'
import { getAuthedClient } from '../auth/gmail'
import { getAccessToken } from '../auth/outlook'
import { getDb } from '../db'

export async function sendEmail(
  accountId: string,
  opts: { to: string; subject: string; bodyHtml: string }
): Promise<void> {
  const db = getDb()
  const account = db.prepare('SELECT provider, email FROM accounts WHERE id = ?').get(accountId) as any
  if (!account) throw new Error(`Account ${accountId} not found`)

  if (account.provider === 'gmail') {
    const auth = await getAuthedClient(accountId)
    const gmail = google.gmail({ version: 'v1', auth })

    const mime = [
      `From: ${account.email}`,
      `To: ${opts.to}`,
      `Subject: ${opts.subject}`,
      'MIME-Version: 1.0',
      'Content-Type: text/html; charset=utf-8',
      '',
      opts.bodyHtml,
    ].join('\r\n')

    await gmail.users.messages.send({
      userId: 'me',
      requestBody: { raw: Buffer.from(mime).toString('base64url') },
    })
  } else {
    // Outlook via Graph API
    const token = await getAccessToken(accountId)
    const res = await fetch('https://graph.microsoft.com/v1.0/me/sendMail', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message: {
          subject: opts.subject,
          body: { contentType: 'HTML', content: opts.bodyHtml },
          toRecipients: [{ emailAddress: { address: opts.to } }],
        },
      }),
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Outlook sendMail failed: ${res.status} ${text}`)
    }
  }
}
