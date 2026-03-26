// src/parsers/generic-bill.ts
import type { Parser, ParseResult } from './types'
import type { NormalizedEmail } from '../email/types'

const RM_PATTERN = /RM\s*([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{2})?)/i

const DATE_PATTERNS = [
  /(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/,
  /(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{4})/i,
  /(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{1,2}),?\s+(\d{4})/i,
]

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
}

const ACCOUNT_PATTERNS = [
  /(?:akaun|account|bil|bill|no\.?)\s*(?:no\.?)?\s*[:\#]?\s*(\d{6,14})/i,
  /(?:customer|pelanggan)\s*(?:id|no)?\s*[:\#]?\s*(\d{6,14})/i,
]

// Strong indicators that an email is an actual bill or payment notice
const BILL_KEYWORDS = /\b(due date|payment due|amount due|bayaran perlu|tarikh bayaran|tarikh akhir bayaran|sila bayar|please pay|pay by|bill amount|jumlah bil|baki tertunggak|outstanding balance|minimum payment|invois|invoice no|statement of account|penyata akaun|overdue|tertunggak|debit note|notice of payment|notis bayaran)\b/i

// Subject-line patterns that strongly suggest a bill notice
const BILL_SUBJECTS = /\b(invoice|invois|bill|bil|statement|penyata|payment (due|notice|reminder)|notis bayaran|e-bill|ebill|resit rasmi|official receipt)\b/i

// Patterns that indicate the email is promotional — exclude these even if RM amounts exist
const PROMO_EXCLUSIONS = /\b(% off|sale|promo|promotion|discount|clearance|voucher|coupon|flash sale|limited time|shop now|buy now|free (delivery|shipping)|new arrival|today only|special (offer|price)|member exclusive|rewards|rebate|cashback|win|lucky draw)\b/i

export function extractRmAmount(text: string): number | null {
  const plain = text.replace(/<[^>]*>/g, ' ')
  const match = plain.match(RM_PATTERN)
  if (!match) return null
  return parseFloat(match[1].replace(/,/g, ''))
}

export function extractDateMs(text: string): number | null {
  const plain = text.replace(/<[^>]*>/g, ' ')

  for (const pattern of DATE_PATTERNS) {
    const m = plain.match(pattern)
    if (!m) continue

    try {
      if (/\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4}/.test(m[0])) {
        const [, d, mo, y] = m
        return new Date(parseInt(y), parseInt(mo) - 1, parseInt(d)).getTime()
      }
      if (/\d{1,2}\s+[A-Za-z]/.test(m[0])) {
        const [, d, mon, y] = m
        return new Date(parseInt(y), MONTHS[mon.toLowerCase().slice(0, 3)], parseInt(d)).getTime()
      }
      if (/[A-Za-z].*\d{1,2}/.test(m[0])) {
        const [, mon, d, y] = m
        return new Date(parseInt(y), MONTHS[mon.toLowerCase().slice(0, 3)], parseInt(d)).getTime()
      }
    } catch { continue }
  }
  return null
}

export function extractAccountRef(text: string): string | null {
  const plain = text.replace(/<[^>]*>/g, ' ')
  for (const pattern of ACCOUNT_PATTERNS) {
    const m = plain.match(pattern)
    if (m) return m[1]
  }
  return null
}

export const genericBillParser: Parser = {
  name: 'Generic',
  matches(email: NormalizedEmail): boolean {
    const subject = email.subject ?? ''
    const body = (email.bodyText ?? email.bodyHtml ?? '').replace(/<[^>]*>/g, ' ')
    const fullText = subject + ' ' + body

    // Must have an RM amount
    if (!RM_PATTERN.test(body)) return false

    // Skip obvious promotional emails
    if (PROMO_EXCLUSIONS.test(subject)) return false

    // Must look like a bill: either the subject matches bill patterns,
    // or the body contains explicit payment/bill language
    return BILL_SUBJECTS.test(subject) || BILL_KEYWORDS.test(fullText)
  },
  parse(email: NormalizedEmail): ParseResult {
    const body = email.bodyText ?? email.bodyHtml ?? ''
    return {
      category: 'bill',
      bill: {
        biller: 'Unknown',
        amountRm: extractRmAmount(body),
        dueDateMs: extractDateMs(body),
        accountRef: extractAccountRef(body),
      },
    }
  },
}
