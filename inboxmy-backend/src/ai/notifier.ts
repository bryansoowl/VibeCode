// src/ai/notifier.ts
import { GoogleGenerativeAI } from '@google/generative-ai'

export interface BillForNotification {
  id: string
  biller: string
  amountRm: number | null
  dueDateMs: number | null
  status: 'unpaid' | 'overdue'
  daysUntilDue: number  // negative = overdue
}

export interface NotificationResult {
  billId: string
  shouldNotify: boolean
  title: string   // max 60 chars
  body: string    // max 120 chars
}

const SYSTEM_PROMPT = `You are a notification assistant for InboxMY, a Malaysian email app.
Given a list of bills, decide which ones are worth a Windows toast notification and write concise copy. Rules:
- ALWAYS notify: TNB, Unifi, Celcom, Maxis, Digi, TnG, LHDN, any amount > RM50
- SUPPRESS: Shopee/Lazada promotional emails, amounts < RM10
- For overdue bills: lead with urgency ("overdue", "unpaid")
- For due-soon: mention days remaining and amount
- Title: max 60 chars. Body: max 120 chars. Friendly, Malaysian English.
Return ONLY a JSON array (no markdown, no code fences): [{ billId, shouldNotify, title, body }]`

function plainCopy(bills: BillForNotification[]): NotificationResult[] {
  return bills.map(b => {
    const amt = b.amountRm != null ? `RM${Number(b.amountRm).toFixed(2)}` : ''
    const when = b.daysUntilDue < 0
      ? `${Math.abs(b.daysUntilDue)} day(s) overdue`
      : b.daysUntilDue === 0
      ? 'due today'
      : `due in ${b.daysUntilDue} day(s)`
    return {
      billId: b.id,
      shouldNotify: true,
      title: `${b.biller} — ${when}`.slice(0, 60),
      body: [amt, when].filter(Boolean).join(' ').slice(0, 120),
    }
  })
}

export async function getNotifications(
  bills: BillForNotification[],
  geminiKey: string
): Promise<NotificationResult[]> {
  if (!bills.length) return []

  try {
    const genAI = new GoogleGenerativeAI(geminiKey)
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' })

    const prompt = SYSTEM_PROMPT + '\n\nBills:\n' + JSON.stringify(bills)
    const result = await model.generateContent(prompt)
    const text = result.response.text()

    const parsed = JSON.parse(text)
    if (!Array.isArray(parsed)) throw new Error('Gemini response was not an array')
    return parsed as NotificationResult[]
  } catch (err) {
    console.error('[notifier] Gemini error — using plain copy:', (err as Error).message)
    return plainCopy(bills)
  }
}
