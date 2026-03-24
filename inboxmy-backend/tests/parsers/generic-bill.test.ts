import { describe, it, expect } from 'vitest'
import { extractRmAmount, extractDateMs } from '../../src/parsers/generic-bill'

describe('extractRmAmount', () => {
  it.each([
    ['RM 134.50', 134.50],
    ['RM134.50', 134.50],
    ['RM 1,234.00', 1234.00],
    ['no amount here', null],
  ])('parses "%s"', (text, expected) => {
    expect(extractRmAmount(text)).toBe(expected)
  })
})

describe('extractDateMs', () => {
  it('parses DD/MM/YYYY', () => {
    const ms = extractDateMs('Due: 15/04/2026')
    expect(new Date(ms!).getFullYear()).toBe(2026)
    expect(new Date(ms!).getMonth()).toBe(3)
    expect(new Date(ms!).getDate()).toBe(15)
  })
  it('parses "15 April 2026"', () => {
    const ms = extractDateMs('Pay by 15 April 2026')
    expect(new Date(ms!).getMonth()).toBe(3)
  })
})
