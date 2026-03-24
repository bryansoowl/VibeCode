// src/parsers/unifi.ts
import type { Parser, ParseResult } from './types'
import type { NormalizedEmail } from '../email/types'
import { extractRmAmount, extractDateMs, extractAccountRef } from './generic-bill'

export const unifiParser: Parser = {
  name: 'Unifi',
  matches: (e) => /@unifi\.com\.my|tmpoint|telekom\.com\.my/i.test(e.sender),
  parse: (e) => ({
    category: 'bill',
    bill: { biller: 'Unifi', amountRm: extractRmAmount(e.bodyText ?? e.bodyHtml ?? ''),
      dueDateMs: extractDateMs(e.bodyText ?? e.bodyHtml ?? ''),
      accountRef: extractAccountRef(e.bodyText ?? e.bodyHtml ?? '') },
  }),
}
