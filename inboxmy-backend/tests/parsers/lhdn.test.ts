import { describe, it, expect } from 'vitest'
import { lhdnParser } from '../../src/parsers/lhdn'
import type { NormalizedEmail } from '../../src/email/types'

const base: NormalizedEmail = {
  id: '1', accountId: 'a', threadId: null, subject: '',
  sender: '', senderName: null, receivedAt: 0, isRead: false,
  category: null, bodyHtml: null, bodyText: null, snippet: null, rawSize: 0,
}

describe('lhdnParser', () => {
  it('matches LHDN domain', () => {
    expect(lhdnParser.matches({ ...base, sender: 'efiling@hasil.gov.my' })).toBe(true)
  })
  it('matches LHDN subject keyword', () => {
    expect(lhdnParser.matches({ ...base, sender: 'noreply@gov.my', subject: 'e-Filing 2025 Notification' })).toBe(true)
  })
  it('categorises as govt', () => {
    const r = lhdnParser.parse({ ...base, sender: 'noreply@hasil.gov.my' })
    expect(r.category).toBe('govt')
    expect(r.bill).toBeNull()
  })
})
