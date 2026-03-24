// src/parsers/mysejahtera.ts
import type { Parser, ParseResult } from './types'
import type { NormalizedEmail } from '../email/types'

export const mysejahteraParser: Parser = {
  name: 'MySejahtera',
  matches: (e) => /mysejahtera/i.test(e.sender) || /mysejahtera/i.test(e.subject),
  parse: (e) => ({ category: 'govt', bill: null }),
}
