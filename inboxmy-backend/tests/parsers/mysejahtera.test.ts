// tests/parsers/mysejahtera.test.ts
import { describe, it, expect } from 'vitest'
import { mysejahteraParser } from '../../src/parsers/mysejahtera'
import type { NormalizedEmail } from '../../src/email/types'

const base: NormalizedEmail = {
  id: '1', accountId: 'a', threadId: null, subject: 'Notification',
  sender: '', senderName: null, receivedAt: 0, isRead: false,
  category: null, bodyHtml: null, bodyText: null, snippet: null, rawSize: 0,
}

describe('mysejahteraParser — matches', () => {
  it('matches sender containing "mysejahtera"', () => {
    expect(mysejahteraParser.matches({ ...base, sender: 'noreply@mysejahtera.gov.my' })).toBe(true)
  })

  it('matches subject containing "mysejahtera" (case-insensitive)', () => {
    expect(mysejahteraParser.matches({ ...base, sender: 'govt@example.com', subject: 'MySejahtera Health Update' })).toBe(true)
  })

  it('matches case-insensitive in sender', () => {
    expect(mysejahteraParser.matches({ ...base, sender: 'MYSEJAHTERA@gov.my' })).toBe(true)
  })

  it('does not match unrelated sender and subject', () => {
    expect(mysejahteraParser.matches({ ...base, sender: 'billing@tnb.com.my', subject: 'TNB Bill' })).toBe(false)
  })
})

describe('mysejahteraParser — parse', () => {
  it('classifies as govt category', () => {
    const result = mysejahteraParser.parse({ ...base, sender: 'noreply@mysejahtera.gov.my' })
    expect(result.category).toBe('govt')
  })

  it('returns null bill (no financial data to extract)', () => {
    const result = mysejahteraParser.parse({ ...base, sender: 'noreply@mysejahtera.gov.my' })
    expect(result.bill).toBeNull()
  })
})
