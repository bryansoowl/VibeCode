// src/parsers/celcom-maxis.ts
import type { Parser, ParseResult } from './types'
import type { NormalizedEmail } from '../email/types'
import { extractRmAmount, extractDateMs, extractAccountRef } from './generic-bill'

const CELCOM_MAXIS = /@(?:celcom|maxis|digi|yes4g|umobile)\.com\.my/i

export const celcomMaxisParser: Parser = {
  name: 'Celcom/Maxis',
  matches: (e) => CELCOM_MAXIS.test(e.sender),
  parse: (e) => {
    const biller = /maxis/i.test(e.sender) ? 'Maxis' : /digi/i.test(e.sender) ? 'Digi' : 'Celcom'
    const body = e.bodyText ?? e.bodyHtml ?? ''
    return { category: 'bill', bill: { biller, amountRm: extractRmAmount(body),
      dueDateMs: extractDateMs(body), accountRef: extractAccountRef(body) } }
  },
}
