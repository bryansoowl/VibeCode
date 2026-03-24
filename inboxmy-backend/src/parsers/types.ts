// src/parsers/types.ts
import type { NormalizedEmail, EmailCategory } from '../email/types'

export interface ParsedBill {
  biller: string
  amountRm: number | null
  dueDateMs: number | null
  accountRef: string | null
}

export interface ParseResult {
  category: EmailCategory
  bill: ParsedBill | null
}

export interface Parser {
  name: string
  matches(email: NormalizedEmail): boolean
  parse(email: NormalizedEmail): ParseResult
}
