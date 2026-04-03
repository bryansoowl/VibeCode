// tests/parsers/spam-scorer.test.ts
import { describe, it, expect } from 'vitest'
import { scoreSpam } from '../../src/parsers/spam-scorer'
import type { NormalizedEmail } from '../../src/email/types'

function makeEmail(overrides: Partial<NormalizedEmail>): NormalizedEmail {
  return {
    id: '1', accountId: 'a', threadId: null,
    subject: 'Hello', sender: 'test@example.com', senderName: null,
    receivedAt: 0, isRead: false, category: null,
    bodyHtml: null, bodyText: null, snippet: null, rawSize: 0,
    folder: 'inbox', tab: 'primary', isImportant: false,
    ...overrides,
  }
}

describe('scoreSpam — clean emails score low', () => {
  it('normal TNB bill email scores below threshold', () => {
    const result = scoreSpam(makeEmail({
      subject: 'Your TNB eBill is ready',
      sender: 'billing@tnb.com.my',
      bodyText: 'Your electricity bill for March 2026 is RM 134.50. Please pay by 15 April.',
    }))
    expect(result.isSpam).toBe(false)
    expect(result.score).toBeLessThan(6)
  })

  it('standard newsletter scores below threshold', () => {
    const result = scoreSpam(makeEmail({
      subject: 'Weekly newsletter from Shopee',
      sender: 'newsletter@shopee.com',
      bodyText: 'Check out this week top deals on Shopee.',
    }))
    expect(result.isSpam).toBe(false)
  })
})

describe('scoreSpam — non-inbox emails are never spam', () => {
  it('returns score 0 for emails in spam folder (already confirmed spam)', () => {
    const result = scoreSpam(makeEmail({
      folder: 'spam',
      subject: 'You have won a million dollar prize!!!',
    }))
    expect(result.isSpam).toBe(false)
    expect(result.score).toBe(0)
  })

  it('returns score 0 for sent folder emails', () => {
    const result = scoreSpam(makeEmail({
      folder: 'sent',
      subject: 'claim your prize now!!!',
    }))
    expect(result.isSpam).toBe(false)
    expect(result.score).toBe(0)
  })
})

describe('scoreSpam — trigger phrases', () => {
  it('subject trigger phrase adds 3 points', () => {
    const result = scoreSpam(makeEmail({
      subject: 'You have won a prize',
      bodyText: 'Congratulations.',
    }))
    expect(result.score).toBeGreaterThanOrEqual(3)
  })

  it('body trigger phrase adds 1 point', () => {
    const clean = scoreSpam(makeEmail({ subject: 'Hello', bodyText: 'Normal message.' }))
    const withPhrase = scoreSpam(makeEmail({ subject: 'Hello', bodyText: 'dear friend, how are you?' }))
    expect(withPhrase.score).toBeGreaterThan(clean.score)
  })

  it('classic spam combination scores above threshold', () => {
    const result = scoreSpam(makeEmail({
      subject: 'You have won! Claim your prize NOW!!!',
      bodyText: 'dear winner, you have been selected. claim your prize. act now. wire transfer details inside.',
    }))
    expect(result.isSpam).toBe(true)
    expect(result.score).toBeGreaterThanOrEqual(6)
  })
})

describe('scoreSpam — structural subject signals', () => {
  it('excessive punctuation (!!!) adds 3 points', () => {
    const base = scoreSpam(makeEmail({ subject: 'Buy now' }))
    const noisy = scoreSpam(makeEmail({ subject: 'Buy now!!!' }))
    expect(noisy.score).toBeGreaterThan(base.score)
  })

  it('9+ consecutive caps in subject adds 2 points', () => {
    const base = scoreSpam(makeEmail({ subject: 'Hello there' }))
    const caps = scoreSpam(makeEmail({ subject: 'ACTIMMEDIATELY please' }))
    expect(caps.score).toBeGreaterThan(base.score)
  })

  it('subject with >60% caps ratio adds 3 points', () => {
    const result = scoreSpam(makeEmail({ subject: 'BUY THIS NOW CHEAP DEAL' }))
    expect(result.score).toBeGreaterThanOrEqual(3)
  })
})

describe('scoreSpam — body link density', () => {
  it('8+ links in body adds 2 points', () => {
    const manyLinks = Array(8).fill('https://example.com').join(' ')
    const result = scoreSpam(makeEmail({ subject: 'Hello', bodyText: manyLinks }))
    expect(result.score).toBeGreaterThanOrEqual(2)
  })

  it('15+ links stacks an extra 2 points on top', () => {
    const fewLinks = Array(8).fill('https://example.com').join(' ')
    const manyLinks = Array(15).fill('https://example.com').join(' ')
    const r8 = scoreSpam(makeEmail({ subject: 'Hello', bodyText: fewLinks }))
    const r15 = scoreSpam(makeEmail({ subject: 'Hello', bodyText: manyLinks }))
    expect(r15.score).toBeGreaterThan(r8.score)
  })
})

describe('scoreSpam — sender mismatch signal', () => {
  it('sender name with different domain than sender email adds 2 points', () => {
    const result = scoreSpam(makeEmail({
      subject: 'Hello',
      sender: 'real@gmail.com',
      senderName: 'paypal.com Support',
    }))
    expect(result.score).toBeGreaterThanOrEqual(2)
  })

  it('sender name matching sender domain does not add mismatch points', () => {
    const result = scoreSpam(makeEmail({
      subject: 'Hello',
      sender: 'support@paypal.com',
      senderName: 'PayPal Support',
    }))
    // senderName "PayPal Support" does not contain a domain pattern like x.xx
    expect(result.score).toBe(0)
  })
})
