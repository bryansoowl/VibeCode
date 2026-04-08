// src/email/search.ts
// Canonical search tokenizer — used by BOTH sync pipeline and search API.
// This is the single source of truth. Do NOT duplicate this logic elsewhere.

const SEARCH_STOPWORDS = new Set([
  'the','a','an','is','it','in','on','at','to','for','of','and','or','with',
  'from','your','re','fwd','fw','hi','hello','dear','please','thank','thanks',
])

/** Max tokens stored per email (applied after dedup). */
export const SEARCH_TOKEN_CAP = 40

/**
 * Normalize text and split into search tokens.
 * - Lowercased
 * - Non-alphanumeric (except @ and .) replaced with spaces
 * - Tokens must be 2–64 chars, not in stopword list
 * Returns raw (unhashed) tokens.
 */
export function tokenizeForSearch(text: string): string[] {
  return (text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9@._]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(t => t.length >= 2 && t.length <= 64 && !SEARCH_STOPWORDS.has(t))
}
