// tests/ai/notifier.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest'

// Mock @google/generative-ai before importing notifier
vi.mock('@google/generative-ai', () => {
  const mockGenerateContent = vi.fn()
  return {
    GoogleGenerativeAI: vi.fn().mockImplementation(function () {
      return {
        getGenerativeModel: vi.fn().mockReturnValue({
          generateContent: mockGenerateContent,
        }),
      }
    }),
    _mockGenerateContent: mockGenerateContent,
  }
})

// Import after mock is set up
const { getNotifications } = await import('../../src/ai/notifier')
const { _mockGenerateContent } = await import('@google/generative-ai') as any

const TNB_BILL = {
  id: 'bill-tnb-1',
  biller: 'TNB',
  amountRm: 142.80,
  dueDateMs: Date.now() + 2 * 24 * 60 * 60 * 1000,
  status: 'unpaid' as const,
  daysUntilDue: 2,
}

const SHOPEE_PROMO = {
  id: 'bill-shopee-1',
  biller: 'Shopee',
  amountRm: 5.50,
  dueDateMs: Date.now() + 24 * 60 * 60 * 1000,
  status: 'unpaid' as const,
  daysUntilDue: 1,
}

afterEach(() => {
  vi.clearAllMocks()
})

describe('getNotifications — AI success path', () => {
  it('returns AI copy for TNB bill', async () => {
    _mockGenerateContent.mockResolvedValue({
      response: {
        text: () => JSON.stringify([
          { billId: 'bill-tnb-1', shouldNotify: true, title: 'TNB eBill due Friday', body: 'RM142.80 due in 2 days. Pay on time!' }
        ])
      }
    })

    const results = await getNotifications([TNB_BILL], 'fake-api-key')
    expect(results).toHaveLength(1)
    expect(results[0].billId).toBe('bill-tnb-1')
    expect(results[0].shouldNotify).toBe(true)
    expect(results[0].title).toContain('TNB')
  })

  it('suppresses Shopee promo when AI says shouldNotify: false', async () => {
    _mockGenerateContent.mockResolvedValue({
      response: {
        text: () => JSON.stringify([
          { billId: 'bill-shopee-1', shouldNotify: false, title: '', body: '' }
        ])
      }
    })

    const results = await getNotifications([SHOPEE_PROMO], 'fake-api-key')
    expect(results[0].shouldNotify).toBe(false)
  })
})

describe('getNotifications — fallback path', () => {
  it('falls back to plain copy when Gemini throws', async () => {
    _mockGenerateContent.mockRejectedValue(new Error('Network error'))

    const results = await getNotifications([TNB_BILL], 'fake-api-key')
    expect(results).toHaveLength(1)
    expect(results[0].shouldNotify).toBe(true)
    expect(results[0].billId).toBe('bill-tnb-1')
    expect(results[0].title.length).toBeGreaterThan(0)
  })

  it('falls back to plain copy when Gemini returns malformed JSON', async () => {
    _mockGenerateContent.mockResolvedValue({
      response: { text: () => 'NOT VALID JSON {{' }
    })

    const results = await getNotifications([TNB_BILL], 'fake-api-key')
    expect(results).toHaveLength(1)
    expect(results[0].shouldNotify).toBe(true)
  })

  it('returns empty array for empty input', async () => {
    const results = await getNotifications([], 'fake-api-key')
    expect(results).toHaveLength(0)
    expect(_mockGenerateContent).not.toHaveBeenCalled()
  })
})
