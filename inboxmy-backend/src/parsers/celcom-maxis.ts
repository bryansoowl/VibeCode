// src/parsers/celcom-maxis.ts
import type { Parser, ParseResult } from './types'
import type { NormalizedEmail } from '../email/types'
import { extractRmAmount, extractDateMs, extractAccountRef } from './generic-bill'

const CELCOM_MAXIS_SENDER = /@(?:celcom|maxis|digi|yes4g|umobile)\.com\.my/i
const CELCOM_MAXIS_BRAND  = /\b(celcom|maxis|digi|u mobile|umobile)\b/i
const BILL_WORDS = /bil|invoice|invois|bayaran|payment|statement|penyata|e-bill|ebill/i

export const celcomMaxisParser: Parser = {
  name: 'Celcom/Maxis',
  matches: (e) =>
    CELCOM_MAXIS_SENDER.test(e.sender) ||
    (CELCOM_MAXIS_BRAND.test(e.subject) && BILL_WORDS.test(e.subject)),
  parse: (e) => {
    const src = e.sender + ' ' + e.subject
    const biller = /maxis/i.test(src) ? 'Maxis'
      : /digi/i.test(src) ? 'Digi'
      : /u.?mobile/i.test(src) ? 'U Mobile'
      : 'Celcom'
    const body = e.bodyText ?? e.bodyHtml ?? ''
    return { category: 'bill', bill: { biller, amountRm: extractRmAmount(body),
      dueDateMs: extractDateMs(body), accountRef: extractAccountRef(body) } }
  },
}
