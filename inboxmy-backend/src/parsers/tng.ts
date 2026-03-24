// src/parsers/tng.ts
import type { Parser, ParseResult } from './types'
import type { NormalizedEmail } from '../email/types'
import { extractRmAmount } from './generic-bill'

export const tngParser: Parser = {
  name: 'Touch n Go',
  matches: (e) => /@tngdigital\.com\.my|touchngo\.com\.my/i.test(e.sender),
  parse: (e) => {
    const body = e.bodyText ?? e.bodyHtml ?? ''
    return { category: 'bill', bill: { biller: 'TnG', amountRm: extractRmAmount(body), dueDateMs: null, accountRef: null } }
  },
}
