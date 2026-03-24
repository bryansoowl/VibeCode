import { describe, it, expect } from 'vitest'
import { tnbParser } from '../../src/parsers/tnb'
import type { NormalizedEmail } from '../../src/email/types'

function makeEmail(overrides: Partial<NormalizedEmail>): NormalizedEmail {
  return {
    id: 'test-1', accountId: 'acc-1', threadId: null,
    subject: '', sender: '', senderName: null,
    receivedAt: Date.now(), isRead: false, category: null,
    bodyHtml: null, bodyText: null, snippet: null, rawSize: 0,
    ...overrides,
  }
}

describe('tnbParser', () => {
  it('matches TNB sender', () => {
    expect(tnbParser.matches(makeEmail({ sender: 'billing@tnb.com.my' }))).toBe(true)
  })
  it('does not match unrelated sender', () => {
    expect(tnbParser.matches(makeEmail({ sender: 'hello@shopee.com' }))).toBe(false)
  })
  it('extracts amount from TNB body', () => {
    const result = tnbParser.parse(makeEmail({
      sender: 'billing@tnb.com.my',
      bodyText: 'Jumlah bil anda ialah RM 134.50\nTarikh akhir bayaran: 15/04/2026\nNo. Akaun: 210123456789',
    }))
    expect(result.category).toBe('bill')
    expect(result.bill?.amountRm).toBe(134.50)
    expect(result.bill?.biller).toBe('TNB')
  })
  it('extracts amount from TNB HTML body', () => {
    const result = tnbParser.parse(makeEmail({
      sender: 'no-reply@tnb.com.my',
      bodyHtml: '<p>Amount Due: <strong>RM 89.20</strong></p>',
    }))
    expect(result.bill?.amountRm).toBe(89.20)
  })
})
