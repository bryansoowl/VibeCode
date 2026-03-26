// src/parsers/spam-scorer.ts
// Multi-signal spam scorer applied on top of Gmail's own spam detection.
// Only runs on emails Gmail already delivered to inbox (folder !== 'spam').
// Score >= SPAM_THRESHOLD → override folder to 'spam'.

import type { NormalizedEmail } from '../email/types'

export interface SpamResult {
  isSpam: boolean
  score: number
}

const SPAM_THRESHOLD = 6

// High-confidence spam phrases — match in subject (+3 each) or body (+1 each)
const TRIGGER_PHRASES = [
  'you have won', "you've won", 'you won', 'claim your prize', 'claim now',
  'act now', 'act immediately', 'limited offer expires',
  'make money fast', 'earn money online', 'cash prize', 'million dollar',
  'nigerian prince', 'dear beneficiary', 'wire transfer details',
  'investment opportunity guaranteed', 'double your money',
  'risk free', '100% free money', 'loan approved instantly',
  'credit approved', 'payday loan', 'you have been selected',
  'dear friend', 'dear winner', 'congratulations you',
  'casino bonus', 'gambling jackpot', 'weight loss guaranteed',
  'diet pill', 'enlarge your', 'click here to claim',
  'verify your account now', 'your account has been suspended',
  'confirm your payment details', 'update your billing',
]

// Subject-level pattern signals
const EXCESSIVE_PUNCTS = /[!?]{3,}/          // !!!  ???  !?!
const CONSEC_CAPS      = /[A-Z]{9,}/          // 9+ consecutive caps e.g. ACTIMMEDIATELY
const DOLLAR_FLOOD     = /\${3,}/             // $$$
const LINK_FLOOD       = /https?:\/\//gi      // count links in body

function capsRatio(str: string): number {
  const letters = str.replace(/[^a-zA-Z]/g, '')
  if (letters.length < 6) return 0
  return str.replace(/[^A-Z]/g, '').length / letters.length
}

export function scoreSpam(email: NormalizedEmail): SpamResult {
  // Never re-score emails already confirmed spam or non-inbox
  if (email.folder !== 'inbox') return { isSpam: false, score: 0 }

  let score = 0
  const subject = email.subject ?? ''
  const subjectLower = subject.toLowerCase()
  const rawBody  = (email.bodyText ?? email.bodyHtml ?? '').replace(/<[^>]*>/g, ' ')
  const bodyLower = rawBody.toLowerCase()

  // ── Trigger phrases ──────────────────────────────────────────────
  let subjectPhraseHits = 0
  let bodyPhraseHits    = 0
  for (const phrase of TRIGGER_PHRASES) {
    if (subjectLower.includes(phrase) && subjectPhraseHits < 2) {
      score += 3; subjectPhraseHits++
    }
    if (bodyLower.includes(phrase) && bodyPhraseHits < 4) {
      score += 1; bodyPhraseHits++
    }
  }

  // ── Subject structural signals ────────────────────────────────────
  if (EXCESSIVE_PUNCTS.test(subject)) score += 3   // HURRY!!! BUY NOW!!!
  if (CONSEC_CAPS.test(subject))      score += 2   // ACTIMMEDIATELY
  if (DOLLAR_FLOOD.test(subject))     score += 2   // $$$
  if (capsRatio(subject) > 0.60)      score += 3   // MOSTLY ALL CAPS SUBJECT

  // ── Body link density (many links = bulk mailer) ──────────────────
  const linkMatches = rawBody.match(LINK_FLOOD)
  if (linkMatches && linkMatches.length >= 8)  score += 2
  if (linkMatches && linkMatches.length >= 15) score += 2  // stacks

  // ── Sender signals ────────────────────────────────────────────────
  // Mismatched sender name (display name contains different domain)
  const senderDomain = (email.sender ?? '').split('@')[1] ?? ''
  const nameContainsDomain = /[a-z]{4,}\.[a-z]{2,}/i.test(email.senderName ?? '')
  if (nameContainsDomain && email.senderName && !email.senderName.includes(senderDomain)) {
    score += 2
  }

  return { isSpam: score >= SPAM_THRESHOLD, score }
}
