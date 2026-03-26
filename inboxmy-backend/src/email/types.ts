// src/email/types.ts
export type EmailCategory = 'bill' | 'govt' | 'receipt' | 'work' | null
export type EmailFolder = 'inbox' | 'sent' | 'spam' | 'draft' | 'trash'
export type EmailTab    = 'primary' | 'promotions' | 'social' | 'updates' | 'forums'

export interface NormalizedEmail {
  id: string            // provider message id
  accountId: string
  threadId: string | null
  subject: string       // plaintext (will be encrypted on store)
  sender: string        // email address
  senderName: string | null
  receivedAt: number    // unix ms
  isRead: boolean
  folder: EmailFolder   // inbox / sent / spam / draft / trash
  tab: EmailTab         // Gmail inbox tab: primary / promotions / social / updates / forums
  isImportant: boolean  // Gmail IMPORTANT label or Outlook high importance
  category: EmailCategory
  bodyHtml: string | null
  bodyText: string | null
  snippet: string | null
  rawSize: number
}
