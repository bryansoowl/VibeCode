import { describe, it, expect } from 'vitest'
import { shopeeParser } from '../../src/parsers/shopee'
import type { NormalizedEmail } from '../../src/email/types'

const base: NormalizedEmail = {
  id: '1', accountId: 'a', threadId: null, subject: 'Order Confirmed',
  sender: 'no-reply@shopee.com.my', senderName: null, receivedAt: 0,
  isRead: false, category: null, bodyHtml: null,
  bodyText: 'Your order #SG2410123456789 has been confirmed.\nTotal: RM 78.90',
  snippet: null, rawSize: 0,
}

describe('shopeeParser', () => {
  it('matches shopee sender', () => expect(shopeeParser.matches(base)).toBe(true))
  it('extracts amount and order ref', () => {
    const r = shopeeParser.parse(base)
    expect(r.category).toBe('receipt')
    expect(r.bill?.amountRm).toBe(78.90)
    expect(r.bill?.accountRef).toBe('SG2410123456789')
  })
})
