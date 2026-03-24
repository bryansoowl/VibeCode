// src/email/types.ts
export type EmailCategory = 'bill' | 'govt' | 'receipt' | 'work' | null

export interface NormalizedEmail {
  id: string            // provider message id
  accountId: string
  threadId: string | null
  subject: string       // plaintext (will be encrypted on store)
  sender: string        // email address
  senderName: string | null
  receivedAt: number    // unix ms
  isRead: boolean
  category: EmailCategory
  bodyHtml: string | null
  bodyText: string | null
  snippet: string | null
  rawSize: number
}
