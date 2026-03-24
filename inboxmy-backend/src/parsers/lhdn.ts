// src/parsers/lhdn.ts
import type { Parser, ParseResult } from './types'
import type { NormalizedEmail } from '../email/types'

export const lhdnParser: Parser = {
  name: 'LHDN',
  matches: (e) =>
    /@(?:hasil|lhdn|irbm)\.gov\.my/i.test(e.sender) ||
    /lhdn|hasil|e-filing|e filing|cukai/i.test(e.subject),
  parse: (e) => ({ category: 'govt', bill: null }),
}
