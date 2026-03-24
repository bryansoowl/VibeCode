// src/parsers/tnb.ts
import type { Parser, ParseResult } from './types'
import type { NormalizedEmail } from '../email/types'
import { extractRmAmount, extractDateMs, extractAccountRef } from './generic-bill'

const TNB_SENDERS = /(@tnb\.com\.my|tenagaenasional)/i
const TNB_SUBJECTS = /bil|invoice|bayaran|payment|elektrik/i

export const tnbParser: Parser = {
  name: 'TNB',

  matches(email: NormalizedEmail): boolean {
    return TNB_SENDERS.test(email.sender) ||
      (TNB_SUBJECTS.test(email.subject) && /tnb/i.test(email.subject))
  },

  parse(email: NormalizedEmail): ParseResult {
    const body = email.bodyText ?? email.bodyHtml ?? ''
    return {
      category: 'bill',
      bill: {
        biller: 'TNB',
        amountRm: extractRmAmount(body),
        dueDateMs: extractDateMs(body),
        accountRef: extractAccountRef(body),
      },
    }
  },
}
