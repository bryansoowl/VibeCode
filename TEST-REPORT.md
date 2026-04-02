# InboxMY — Test Report
**Date:** 2026-04-02  
**Version:** 0.7.0  
**Total tests:** 282 (was 239 — +43 new tests added in Plan 11)
**Result:** ALL PASS ✅

---

## How to run all tests

```bash
# Run everything (Electron utils + backend)
npm run test:all

# Run only backend tests (143 tests)
npm run test:backend

# Run only Electron utility tests (4 tests)
npm run test:utils
```

---

## Test Results by Suite

### 1. Electron — `electron/utils.test.js` (4 tests) ✅

| # | Test | Result |
|---|------|--------|
| 1 | `makeNotificationKey` — same bill same month → same key | PASS |
| 2 | `makeNotificationKey` — same bill different month → different key | PASS |
| 3 | `makeNotificationKey` — different bills same month → different keys | PASS |
| 4 | `makeNotificationKey` — key format is `billId_YYYY-MM` | PASS |

---

### 2. Backend — `tests/crypto.test.ts` (10 tests) ✅

| # | Test | Result |
|---|------|--------|
| 1 | `encryptSystem/decryptSystem` — round-trips a plaintext string | PASS |
| 2 | `encryptSystem/decryptSystem` — produces different ciphertext for same input (random IV) | PASS |
| 3 | `encryptSystem/decryptSystem` — throws on tampered ciphertext | PASS |
| 4 | `encrypt/decrypt` — round-trips with a 32-byte key | PASS |
| 5 | `encrypt/decrypt` — fails to decrypt with a different key | PASS |
| 6 | `encrypt/decrypt` — produces different ciphertext each call (random IV) | PASS |
| 7 | `deriveWrapKey` — returns a 32-byte Buffer | PASS |
| 8 | `deriveWrapKey` — is deterministic (same password+salt → same key) | PASS |
| 9 | `deriveWrapKey` — different salts → different keys | PASS |
| 10 | `wrapKey/unwrapKey` — round-trips a 32-byte data key | PASS |
| 11 | `wrapKey/unwrapKey` — fails to unwrap with a wrong wrapping key | PASS |

---

### 3. Backend — `tests/config.test.ts` (6 tests) ✅

| # | Test | Result |
|---|------|--------|
| 1 | `validateConfig` — shows `[✓]` for Gmail when both Google creds are set | PASS |
| 2 | `validateConfig` — shows `[ ]` for Gmail and setup hint when Google Client ID missing | PASS |
| 3 | `validateConfig` — shows `[ ]` for Gmail when Google Client Secret missing | PASS |
| 4 | `validateConfig` — shows `[✓]` for Outlook when both Microsoft creds are set | PASS |
| 5 | `validateConfig` — shows `[ ]` for Outlook and setup hint when Microsoft creds missing | PASS |
| 6 | `validateConfig` — does not print setup hint when all creds are set | PASS |

---

### 4. Backend — `tests/setup.test.ts` (9 tests) ✅

| # | Test | Result |
|---|------|--------|
| 1 | `isValidGoogleClientId` — accepts a valid Google client ID | PASS |
| 2 | `isValidGoogleClientId` — rejects ID not ending with `.apps.googleusercontent.com` | PASS |
| 3 | `isValidGoogleClientId` — rejects empty string | PASS |
| 4 | `isValidGoogleClientId` — rejects ID missing `.apps` prefix | PASS |
| 5 | `isValidAzureClientId` — accepts a valid UUID | PASS |
| 6 | `isValidAzureClientId` — rejects a non-UUID string | PASS |
| 7 | `isValidAzureClientId` — rejects empty string | PASS |
| 8 | `isValidAzureClientId` — rejects UUID with wrong segment lengths | PASS |
| 9 | `isValidSecret` — accepts a non-empty string | PASS |
| 10 | `isValidSecret` — rejects empty string | PASS |
| 11 | `isValidSecret` — rejects whitespace-only string | PASS |
| 12 | `buildEnvContent` — writes all variables including Plan 4 secrets | PASS |
| 13 | `buildEnvContent` — writes empty strings for skipped providers | PASS |

---

### 5. Backend — `tests/middleware/auth.test.ts` (4 tests) ✅

| # | Test | Result |
|---|------|--------|
| 1 | `requireAuth` middleware — allows request through with valid session | PASS |
| 2 | `requireAuth` middleware — returns 401 with no cookie | PASS |
| 3 | `requireAuth` middleware — returns 401 with a made-up session ID | PASS |
| 4 | `requireAuth` middleware — returns 401 for session older than 30 days | PASS |

---

### 6. Backend — `tests/routes/auth.test.ts` (11 tests) ✅

| # | Test | Result |
|---|------|--------|
| 1 | `POST /auth/signup` — creates a user and returns a session cookie | PASS |
| 2 | `POST /auth/signup` — returns 409 for duplicate email | PASS |
| 3 | `POST /auth/signup` — returns 400 for password under 8 chars | PASS |
| 4 | `POST /auth/signup` — returns 400 for missing email | PASS |
| 5 | `POST /auth/login` — returns a session cookie on correct credentials | PASS |
| 6 | `POST /auth/login` — returns 401 for wrong password | PASS |
| 7 | `POST /auth/login` — returns 401 for unknown email | PASS |
| 8 | `GET /auth/me` — returns the user when authenticated | PASS |
| 9 | `GET /auth/me` — returns 401 without a session | PASS |
| 10 | `POST /auth/logout` — clears the session and subsequent `/auth/me` returns 401 | PASS |

---

### 7. Backend — `tests/routes/auth-reset.test.ts` (4 tests) ✅

| # | Test | Result |
|---|------|--------|
| 1 | `POST /auth/reset-password` — resets password and allows login with new password | PASS |
| 2 | `POST /auth/reset-password` — rejects old password after reset | PASS |
| 3 | `POST /auth/reset-password` — returns 400 for expired token | PASS |
| 4 | `POST /auth/reset-password` — returns 400 for already-used token | PASS |

---

### 8. Backend — `tests/routes/accounts.test.ts` (8 tests) ✅

| # | Test | Result |
|---|------|--------|
| 1 | `GET /api/accounts` — returns list for authenticated user | PASS |
| 2 | `GET /api/accounts` — returns 401 without session | PASS |
| 3 | `PATCH /api/accounts/:id/label` — updates the label | PASS |
| 4 | `PATCH /api/accounts/:id/label` — returns 400 for non-string label | PASS |
| 5 | `DELETE /api/accounts/:id` — deletes an existing account | PASS |
| 6 | `DELETE /api/accounts/:id` — returns 404 for non-existent account | PASS |
| 7 | `GET /api/accounts` — returns `token_expired = 0` by default | PASS |
| 8 | `PATCH /api/accounts/:id/label` — accepts empty string label | PASS |
| 9 | `DELETE /api/accounts/:id` — deletes associated emails via ON DELETE CASCADE | PASS |

---

### 9. Backend — `tests/routes/emails.test.ts` (22 tests) ✅

**Unread count (6 tests)**

| # | Test | Result |
|---|------|--------|
| 1 | `GET /api/emails/unread-count` — returns count of unread inbox non-promotions emails | PASS |
| 2 | `GET /api/emails/unread-count` — excludes read emails | PASS |
| 3 | `GET /api/emails/unread-count` — excludes Promotions tab emails | PASS |
| 4 | `GET /api/emails/unread-count` — excludes non-inbox folders | PASS |
| 5 | `GET /api/emails/unread-count` — does not count another user's emails | PASS |
| 6 | `GET /api/emails/unread-count` — returns 401 without session | PASS |

**Date filters (5 tests)**

| # | Test | Result |
|---|------|--------|
| 7 | `GET /api/emails` — `dateFrom` returns only emails on or after that date | PASS |
| 8 | `GET /api/emails` — `dateTo` returns only emails on or before that date | PASS |
| 9 | `GET /api/emails` — `dateFrom + dateTo` combined return emails within range | PASS |
| 10 | `GET /api/emails` — swaps `dateFrom` and `dateTo` silently when inverted | PASS |
| 11 | `GET /api/emails` — returns 400 for invalid `dateFrom` format | PASS |

**Account filter (4 tests)**

| # | Test | Result |
|---|------|--------|
| 12 | `GET /api/emails` — single `accountIds` returns only emails from that account | PASS |
| 13 | `GET /api/emails` — multiple `accountIds` returns emails from any (OR logic) | PASS |
| 14 | `GET /api/emails` — another user's `accountId` returns no results | PASS |
| 15 | `GET /api/emails` — all-empty `accountIds` (e.g. `",,,""`) treated as absent | PASS |

**In-memory search (7 tests)**

| # | Test | Result |
|---|------|--------|
| 16 | `GET /api/emails` — search matches on sender field | PASS |
| 17 | `GET /api/emails` — search matches on decrypted subject | PASS |
| 18 | `GET /api/emails` — search matches on decrypted snippet | PASS |
| 19 | `GET /api/emails` — search is case-insensitive | PASS |
| 20 | `GET /api/emails` — search combined with `dateFrom` narrows results | PASS |
| 21 | `GET /api/emails` — search combined with `accountIds` filters by account | PASS |
| 22 | `GET /api/emails` — `total` reflects in-memory filtered count, not raw SQL count | PASS |
| 23 | `GET /api/emails` — in-memory pagination: offset slices the filtered set | PASS |

---

### 10. Backend — `tests/routes/sync.test.ts` (5 tests) ✅

| # | Test | Result |
|---|------|--------|
| 1 | `POST /api/sync/trigger` (all accounts) — returns `{ added, emails }` when new emails found | PASS |
| 2 | `POST /api/sync/trigger` (all accounts) — returns `{ added: 0, emails: [] }` when no new emails | PASS |
| 3 | `POST /api/sync/trigger` (all accounts) — returns 401 without session | PASS |
| 4 | `POST /api/sync/trigger` (single account) — returns `{ added, emails, errors }` for specific account | PASS |
| 5 | `POST /api/sync/trigger` (single account) — returns 404 when accountId belongs to different user | PASS |

---

### 11. Backend — `tests/routes/notifications.test.ts` (12 tests) ✅

| # | Test | Result |
|---|------|--------|
| 1 | `PATCH /api/bills/auto-mark-overdue` — marks unpaid bill with past due_date as overdue | PASS |
| 2 | `PATCH /api/bills/auto-mark-overdue` — does not mark unpaid bill with future due_date | PASS |
| 3 | `PATCH /api/bills/auto-mark-overdue` — does not re-mark a paid bill | PASS |
| 4 | `PATCH /api/bills/auto-mark-overdue` — does not affect another user's bills | PASS |
| 5 | `PATCH /api/bills/auto-mark-overdue` — does not mark bill due exactly now (strict `<`) | PASS |
| 6 | `PATCH /api/bills/auto-mark-overdue` — returns 401 without session | PASS |
| 7 | `GET /api/notifications/due-soon` — returns unpaid bills due within 72h | PASS |
| 8 | `GET /api/notifications/due-soon` — includes bill due at exactly now+72h (inclusive boundary) | PASS |
| 9 | `GET /api/notifications/due-soon` — excludes unpaid bills due after 72h | PASS |
| 10 | `GET /api/notifications/due-soon` — returns overdue bills regardless of due_date | PASS |
| 11 | `GET /api/notifications/due-soon` — excludes paid bills | PASS |
| 12 | `GET /api/notifications/due-soon` — returns 401 without session | PASS |
| 13 | `POST /api/notifications/ai-summary` — returns 401 without session | PASS |
| 14 | `POST /api/notifications/ai-summary` — returns 400 when `bills` missing | PASS |
| 15 | `POST /api/notifications/ai-summary` — returns 400 when `geminiKey` missing | PASS |
| 16 | `POST /api/notifications/ai-summary` — returns 400 when `geminiKey` is whitespace-only | PASS |
| 17 | `POST /api/notifications/ai-summary` — returns 200 with empty array for empty bills input | PASS |

---

### 12. Backend — `tests/parsers/tnb.test.ts` (4 tests) ✅

| # | Test | Result |
|---|------|--------|
| 1 | `tnbParser` — matches TNB sender | PASS |
| 2 | `tnbParser` — does not match unrelated sender | PASS |
| 3 | `tnbParser` — extracts amount from TNB text body | PASS |
| 4 | `tnbParser` — extracts amount from TNB HTML body | PASS |

---

### 13. Backend — `tests/parsers/lhdn.test.ts` (tests) ✅

See file for full list — all PASS.

---

### 14. Backend — `tests/parsers/shopee.test.ts` (tests) ✅

See file for full list — all PASS.

---

### 15. Backend — `tests/parsers/generic-bill.test.ts` (tests) ✅

See file for full list — all PASS.

---

### 16. Backend — `tests/parsers/remaining.test.ts` (8 tests) ✅

| # | Test | Result |
|---|------|--------|
| 1 | `unifiParser` — matches Unifi sender | PASS |
| 2 | `unifiParser` — extracts amount | PASS |
| 3 | `celcomMaxisParser` — matches Maxis sender | PASS |
| 4 | `celcomMaxisParser` — labels biller as Maxis | PASS |
| 5 | `celcomMaxisParser` — labels biller as Digi | PASS |
| 6 | `tngParser` — matches TnG domain | PASS |
| 7 | `tngParser` — extracts reload amount | PASS |
| 8 | `lazadaParser` — matches Lazada sender | PASS |
| 9 | `lazadaParser` — extracts amount and order ref | PASS |

---

### 18. Backend — `tests/email/send.test.ts` (5 tests) ✅

| # | Test | Result |
|---|------|--------|
| 1 | `sendEmail` Gmail — calls `gmail.users.messages.send` with a base64url raw payload | PASS |
| 2 | `sendEmail` Gmail — propagates auth errors from `getAuthedClient` | PASS |
| 3 | `sendEmail` Outlook — calls Graph API `sendMail` with correct JSON body | PASS |
| 4 | `sendEmail` Outlook — propagates re-auth errors from `getAccessToken` | PASS |
| 5 | `sendEmail` Outlook — throws when Graph API returns non-ok response | PASS |

---

### 19. Backend — `tests/routes/send.test.ts` (10 tests) ✅

| # | Test | Result |
|---|------|--------|
| 1 | `POST /api/emails/send` — returns 401 without session cookie | PASS |
| 2 | `POST /api/emails/send` — happy path: sends email and saves sent copy in DB | PASS |
| 3 | `POST /api/emails/send` — auto-picks accountId from replyToEmailId | PASS |
| 4 | `POST /api/emails/send` — returns 400 when accountId missing and no replyToEmailId | PASS |
| 5 | `POST /api/emails/send` — returns 400 for invalid to email address | PASS |
| 6 | `POST /api/emails/send` — returns 400 when body exceeds 50 KB | PASS |
| 7 | `POST /api/emails/send` — returns 404 when replyToEmailId belongs to another user | PASS |
| 8 | `POST /api/emails/send` — returns 404 when accountId belongs to another user | PASS |
| 9 | `POST /api/emails/send` — returns 502 and does not save DB row when sendEmail throws generic error | PASS |
| 10 | `POST /api/emails/send` — returns 401 with reconnect:true when sendEmail throws re-auth error | PASS |

---

### 20. Backend — `tests/routes/emails.test.ts` additions (Plan 10) ✅

| # | Test | Result |
|---|------|--------|
| 1 | `PATCH /api/emails/:id/folder` — moves email to a valid folder | PASS |
| 2 | `PATCH /api/emails/:id/folder` — returns 400 for invalid folder value | PASS |
| 3 | `PATCH /api/emails/:id/folder` — returns 404 when email belongs to another user | PASS |
| 4 | `PATCH /api/emails/:id/folder` — returns 401 without session cookie | PASS |
| 5 | `GET /api/emails?folder=archive` — returns 200 and lists archived emails | PASS |

---

### 21. Backend — `tests/routes/labels.test.ts` (15 tests) ✅

| # | Test | Result |
|---|------|--------|
| 1 | `GET /api/labels` — returns empty array when user has no labels | PASS |
| 2 | `GET /api/labels` — returns 401 without session | PASS |
| 3 | `GET /api/labels` — returns labels with count field | PASS |
| 4 | `POST /api/labels` — creates a label with name and default color | PASS |
| 5 | `POST /api/labels` — creates a label with custom color | PASS |
| 6 | `POST /api/labels` — returns 400 when name exceeds 50 chars | PASS |
| 7 | `POST /api/labels` — returns 400 when color is not a valid hex | PASS |
| 8 | `POST /api/labels` — returns 409 for duplicate name within same user | PASS |
| 9 | `POST /api/labels` — two different users can have labels with same name | PASS |
| 10 | `PATCH /api/labels/:id` — renames a label | PASS |
| 11 | `PATCH /api/labels/:id` — recolors a label | PASS |
| 12 | `PATCH /api/labels/:id` — returns 404 when label belongs to another user | PASS |
| 13 | `DELETE /api/labels/:id` — deletes a label | PASS |
| 14 | `DELETE /api/labels/:id` — cascades to email_labels on delete | PASS |
| 15 | `DELETE /api/labels/:id` — returns 404 when label belongs to another user | PASS |

---

### 22. Backend — `tests/routes/snooze.test.ts` (15 tests) ✅

| # | Test | Result |
|---|------|--------|
| 1 | `PATCH /api/emails/:id/snooze` — sets snoozed_until on the email | PASS |
| 2 | `PATCH /api/emails/:id/snooze` — returns 400 for past timestamp | PASS |
| 3 | `PATCH /api/emails/:id/snooze` — returns 400 for timestamp more than 1 year out | PASS |
| 4 | `PATCH /api/emails/:id/snooze` — returns 404 when email belongs to another user | PASS |
| 5 | `PATCH /api/emails/:id/snooze` — returns 401 without session | PASS |
| 6 | `DELETE /api/emails/:id/snooze` — clears snoozed_until | PASS |
| 7 | `DELETE /api/emails/:id/snooze` — returns 404 when email belongs to another user | PASS |
| 8 | `DELETE /api/emails/:id/snooze` — returns 200 idempotently when email is not snoozed | PASS |
| 9 | `GET /api/emails` — excludes snoozed emails from default list | PASS |
| 10 | `GET /api/emails` — shows only snoozed emails with `?snoozed=1` | PASS |
| 11 | `GET /api/emails` — snoozed email is excluded from `folder=inbox` view | PASS |
| 12 | `POST /api/emails/unsnooze-due` — restores emails whose snoozed_until is in the past | PASS |
| 13 | `POST /api/emails/unsnooze-due` — does not restore emails snoozed until the future | PASS |
| 14 | `POST /api/emails/unsnooze-due` — returns 401 without session | PASS |
| 15 | `GET /api/emails/unread-count` — does not count snoozed-but-unread emails | PASS |

---

### 23. Backend — `tests/routes/email-labels.test.ts` (13 tests) ✅

| # | Test | Result |
|---|------|--------|
| 1 | `POST /api/emails/:id/labels/:labelId` — assigns a label to an email | PASS |
| 2 | `POST /api/emails/:id/labels/:labelId` — is idempotent (second call returns 200, no duplicate row) | PASS |
| 3 | `POST /api/emails/:id/labels/:labelId` — returns 404 when email belongs to another user | PASS |
| 4 | `POST /api/emails/:id/labels/:labelId` — returns 404 when label belongs to another user | PASS |
| 5 | `POST /api/emails/:id/labels/:labelId` — returns 401 without session | PASS |
| 6 | `DELETE /api/emails/:id/labels/:labelId` — removes a label from an email | PASS |
| 7 | `DELETE /api/emails/:id/labels/:labelId` — returns 404 when label belongs to another user | PASS |
| 8 | `GET /api/emails` — includes labels array in email list response | PASS |
| 9 | `GET /api/emails/:id` — includes labels array in single email response | PASS |
| 10 | `GET /api/emails` — unlabelled email has `labels: []` | PASS |
| 11 | `GET /api/emails` — multi-label email appears exactly once in list | PASS |
| 12 | `GET /api/emails?labelId=` — filters emails by label | PASS |
| 13 | `GET /api/emails?labelId=` — returns 404 when labelId belongs to another user | PASS |

---

### 17. Backend — `tests/ai/notifier.test.ts` (4 tests) ✅

| # | Test | Result |
|---|------|--------|
| 1 | `getNotifications` — returns AI copy for TNB bill | PASS |
| 2 | `getNotifications` — suppresses Shopee promo when AI says `shouldNotify: false` | PASS |
| 3 | `getNotifications` — falls back to plain copy when Gemini throws | PASS |
| 4 | `getNotifications` — falls back to plain copy when Gemini returns malformed JSON | PASS |
| 5 | `getNotifications` — returns empty array for empty input | PASS |

---

## Gaps & Improvements Needed for a Fully Functional BlueMail-Like App

### HIGH PRIORITY — ✅ Addressed in Plan 8 & Plan 9

All high-priority and medium-priority gaps are now covered.

### MEDIUM PRIORITY — ✅ Addressed in Plan 9

| Area | Status | Notes |
|------|--------|-------|
| `GET /api/emails` folder filter | ✅ Tested | **Bug found & fixed**: `folder`/`tab`/`is_important` were missing from `EMAIL_SELECT` — now returned in all email list responses |
| `GET /api/emails` tab filter | ✅ Tested | Same fix as above |
| `GET /api/emails` unread filter | ✅ Tested | Production code was correct |
| Parser — MySejahtera | ✅ Tested | 6 tests in `tests/parsers/mysejahtera.test.ts` |
| Parser — spam scorer | ✅ Tested | 14 tests in `tests/parsers/spam-scorer.test.ts` |
| Concurrent account sync | ✅ Tested | `INSERT OR IGNORE` + SQLite serialization prevents duplicates |
| Account limit (6-account cap) | ✅ Tested + Implemented | **Missing feature added**: `connect/gmail` and `connect/outlook` now enforce 6-account cap |
| Session cookie attributes | ✅ Tested | HttpOnly + SameSite=Lax verified for signup and login |
| Rate limiting (auth routes) | ✅ Documented | Intentionally skipped in test env via `skip: () => NODE_ENV === 'test'` — test documents this intent |

### LOW PRIORITY — Requires Additional Tooling

These items are genuinely not feasible with the current Vitest/Node setup:

| Area | Why Not Automated | Tooling Required |
|------|------------------|-----------------|
| Frontend JS (`frontend/app.js`) | 56KB vanilla JS in browser context | jsdom + vitest browser mode, or Playwright |
| Frontend filter pills / date picker | DOM interaction required | Playwright component tests |
| Electron IPC bridge (`preload.js`) | Needs Electron test harness | `playwright-electron` or Spectron |
| End-to-end flow | Full app + OAuth mocking required | Playwright + OAuth mock server |

These are tracked as future work. Adding Playwright would unlock all four in one investment.

### FUTURE: BlueMail Feature Parity Gaps

Features BlueMail has that InboxMY does not yet have:

| Feature | Status |
|---------|--------|
| Compose / Reply / Forward | Backend done (Plan 10); frontend compose UI pending |
| Drag to folder / archive | Not implemented |
| Offline mode (cached inbox without server) | Not implemented |
| Mobile app | Desktop-only (Electron) |
| Smart groups / user-created labels | ✅ Done (Plan 11) |
| Snooze emails | ✅ Done (Plan 11) |
| Focused inbox (primary tab filter) | ✅ Done (Plan 11) |
| Calendar integration | Not implemented (Plan 12) |

---

## Summary

```
Total test files:  25  (backend) + 1 (electron utils) = 26
Total tests:      282  (+43 added in Plan 11, was 239)
  Backend:        278
  Electron utils:   4
Passing:          282
Failing:            0
Coverage gaps:     Frontend/E2E only (requires Playwright — see above)
```

**Plan 8 added (34 tests):**
- `tests/routes/bills.test.ts` — 16 new tests (GET /api/bills, PATCH /api/bills/:id/status)
- `tests/routes/emails.test.ts` — 18 new tests (basic list, single email, mark-read, delete)
- Bug found: seed helper used wrong encryption key → GET /api/bills returned 500

**Plan 9 added (38 tests):**
- `tests/parsers/mysejahtera.test.ts` — 6 new tests
- `tests/parsers/spam-scorer.test.ts` — 14 new tests
- `tests/routes/emails.test.ts` — 12 new tests (folder/tab/unread filters)
- `tests/routes/auth.test.ts` — 4 new tests (session cookie attributes, rate limit documentation)
- `tests/routes/accounts.test.ts` — 3 new tests (6-account cap)
- `tests/email/sync-engine.test.ts` — 1 new test (concurrent sync dedup)

**Bugs found by Plan 9 tests:**
1. `EMAIL_SELECT` missing `folder`, `tab`, `is_important` fields — email list API returned incomplete data. Fixed in `src/routes/emails.ts`.
2. 6-account cap stated in README but not enforced in backend. Implemented in `src/routes/accounts.ts`.

**Plan 10 added (20 tests):**
- `tests/email/send.test.ts` — 5 new tests (sendEmail unit: Gmail MIME, Outlook Graph API)
- `tests/routes/send.test.ts` — 10 new tests (POST /api/emails/send integration)
- `tests/routes/emails.test.ts` — 5 new tests (PATCH /:id/folder, GET ?folder=archive)

**Plan 11 added (43 tests):**
- `tests/routes/labels.test.ts` — 15 new tests (GET/POST/PATCH/DELETE /api/labels, count field, ownership guards, cascade)
- `tests/routes/snooze.test.ts` — 15 new tests (PATCH/DELETE snooze, GET list exclusion, unsnooze-due, unread-count fix, idempotent unsnooze)
- `tests/routes/email-labels.test.ts` — 13 new tests (POST/DELETE label assignment, labels in responses, labelId filter, cross-user guards)
