// src/parsers/lazada.ts
import type { Parser, ParseResult } from './types'
import type { NormalizedEmail } from '../email/types'
import { extractRmAmount } from './generic-bill'

const ORDER_WORDS = /order|pesanan|receipt|resit|confirmed|placed|delivered|shipped/i

export const lazadaParser: Parser = {
  name: 'Lazada',
  matches: (e) =>
    /@lazada\.com\.my|@emails\.lazada/i.test(e.sender) ||
    (/lazada/i.test(e.subject) && ORDER_WORDS.test(e.subject)),
  parse: (e) => {
    const body = e.bodyText ?? e.bodyHtml ?? ''
    const orderMatch = body.match(/order\s*(?:no\.?|id|#)?\s*[:\#]?\s*(\d{6,})/i)
    return {
      category: 'receipt',
      bill: {
        biller: 'Lazada',
        amountRm: extractRmAmount(body),
        dueDateMs: null,
        accountRef: orderMatch ? orderMatch[1] : null,
      },
    }
  },
}
