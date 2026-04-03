// src/parsers/index.ts
import { tnbParser } from './tnb'
import { unifiParser } from './unifi'
import { celcomMaxisParser } from './celcom-maxis'
import { tngParser } from './tng'
import { lhdnParser } from './lhdn'
import { mysejahteraParser } from './mysejahtera'
import { shopeeParser } from './shopee'
import { lazadaParser } from './lazada'
import { steamParser } from './steam'
import { genericBillParser } from './generic-bill'
import type { Parser, ParseResult } from './types'
import type { NormalizedEmail } from '../email/types'

const PARSERS: Parser[] = [
  tnbParser,
  unifiParser,
  celcomMaxisParser,
  tngParser,
  lhdnParser,
  mysejahteraParser,
  shopeeParser,
  lazadaParser,
  steamParser,
  genericBillParser,
]

export function parseEmail(email: NormalizedEmail): ParseResult {
  for (const parser of PARSERS) {
    if (parser.matches(email)) return parser.parse(email)
  }
  return { category: null, bill: null }
}
