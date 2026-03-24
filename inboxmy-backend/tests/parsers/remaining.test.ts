import { describe, it, expect } from 'vitest'
import { unifiParser } from '../../src/parsers/unifi'
import { celcomMaxisParser } from '../../src/parsers/celcom-maxis'
import { tngParser } from '../../src/parsers/tng'
import { lazadaParser } from '../../src/parsers/lazada'
import type { NormalizedEmail } from '../../src/email/types'

const base: NormalizedEmail = {
  id: '1', accountId: 'a', threadId: null, subject: 'Bill',
  sender: '', senderName: null, receivedAt: 0, isRead: false,
  category: null, bodyHtml: null, bodyText: null, snippet: null, rawSize: 0,
}

describe('unifiParser', () => {
  it('matches Unifi sender', () => {
    expect(unifiParser.matches({ ...base, sender: 'billing@unifi.com.my' })).toBe(true)
  })
  it('extracts amount', () => {
    const r = unifiParser.parse({ ...base, sender: 'billing@unifi.com.my',
      bodyText: 'Jumlah: RM 129.00 Tarikh: 10/05/2026' })
    expect(r.category).toBe('bill')
    expect(r.bill?.amountRm).toBe(129.00)
    expect(r.bill?.biller).toBe('Unifi')
  })
})

describe('celcomMaxisParser', () => {
  it('matches Maxis sender', () => {
    expect(celcomMaxisParser.matches({ ...base, sender: 'bill@maxis.com.my' })).toBe(true)
  })
  it('labels biller as Maxis', () => {
    const r = celcomMaxisParser.parse({ ...base, sender: 'bill@maxis.com.my',
      bodyText: 'RM 88.00 due 01/06/2026' })
    expect(r.bill?.biller).toBe('Maxis')
  })
  it('labels biller as Digi', () => {
    const r = celcomMaxisParser.parse({ ...base, sender: 'noreply@digi.com.my',
      bodyText: 'RM 45.00' })
    expect(r.bill?.biller).toBe('Digi')
  })
})

describe('tngParser', () => {
  it('matches TnG domain', () => {
    expect(tngParser.matches({ ...base, sender: 'noreply@tngdigital.com.my' })).toBe(true)
  })
  it('extracts reload amount', () => {
    const r = tngParser.parse({ ...base, sender: 'noreply@tngdigital.com.my',
      bodyText: 'Reload berjaya: RM 50.00' })
    expect(r.bill?.amountRm).toBe(50.00)
    expect(r.bill?.biller).toBe('TnG')
  })
})

describe('lazadaParser', () => {
  it('matches Lazada sender', () => {
    expect(lazadaParser.matches({ ...base, sender: 'noreply@lazada.com.my' })).toBe(true)
  })
  it('extracts amount and order ref', () => {
    const r = lazadaParser.parse({ ...base, sender: 'noreply@lazada.com.my',
      bodyText: 'Order no. 123456789 confirmed. Total paid: RM 199.00' })
    expect(r.category).toBe('receipt')
    expect(r.bill?.amountRm).toBe(199.00)
    expect(r.bill?.accountRef).toBe('123456789')
  })
})
