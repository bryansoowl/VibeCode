// src/parsers/shopee.ts
import type { Parser, ParseResult } from './types'
import type { NormalizedEmail } from '../email/types'
import { extractRmAmount } from './generic-bill'

const ORDER_PATTERN = /(?:order|pesanan)\s*(?:no\.?|id|#)?\s*[:\#]?\s*([A-Z0-9]{12,20})/i

const ORDER_WORDS = /order|pesanan|receipt|resit|confirmed|placed|delivered|shipped/i

export const shopeeParser: Parser = {
  name: 'Shopee',
  matches: (e) =>
    /@shopee\.com\.my|no-reply@shopee/i.test(e.sender) ||
    (/shopee/i.test(e.subject) && ORDER_WORDS.test(e.subject)),
  parse: (e) => {
    const body = e.bodyText ?? e.bodyHtml ?? ''
    const orderMatch = body.match(ORDER_PATTERN)
    return {
      category: 'receipt',
      bill: {
        biller: 'Shopee',
        amountRm: extractRmAmount(body),
        dueDateMs: null,
        accountRef: orderMatch ? orderMatch[1] : null,
      },
    }
  },
}
