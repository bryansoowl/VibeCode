// src/parsers/steam.ts
import type { Parser, ParseResult } from './types'
import type { NormalizedEmail } from '../email/types'

// Matches transaction IDs like "5912345678901234567"
const TXID_PATTERN = /(?:transaction\s*id|txid|order\s*id)[:\s#]*([0-9]{10,20})/i

// USD / other currency amounts — e.g. "USD 12.99" or "$12.99"
const AMOUNT_PATTERN = /(?:USD|US\$|\$)\s*([0-9]+(?:\.[0-9]{2})?)/i

export const steamParser: Parser = {
  name: 'Steam',
  matches: (e) =>
    /@steampowered\.com|@valvesoftware\.com/i.test(e.sender) ||
    /steam/i.test(e.sender) && /purchase|order|receipt/i.test(e.subject),
  parse: (e): ParseResult => {
    const body = e.bodyText ?? e.bodyHtml ?? ''
    const plain = body.replace(/<[^>]*>/g, ' ')

    const txMatch = plain.match(TXID_PATTERN)
    const amtMatch = plain.match(AMOUNT_PATTERN)

    return {
      category: 'receipt',
      bill: {
        biller: 'Steam',
        amountRm: amtMatch ? parseFloat(amtMatch[1]) : null,
        dueDateMs: null,
        accountRef: txMatch ? txMatch[1] : null,
      },
    }
  },
}
