# Plan 7: Search + Filtering Improvements — Design Spec

**Date:** 2026-03-29
**Status:** Approved

---

## Overview

Add full-text search across sender/subject/snippet, date range filtering (presets + custom picker), and multi-account filtering (account pills) to the InboxMY email list. Scope is email list only — bills panel is unchanged.

---

## 1. Backend API Changes

### `GET /api/emails` — new query parameters

| Param | Type | Validation | Description |
|---|---|---|---|
| `dateFrom` | `YYYY-MM-DD` string | optional, regex `^\d{4}-\d{2}-\d{2}$` | Include emails received on or after this date (start of day, UTC+8) |
| `dateTo` | `YYYY-MM-DD` string | optional, regex `^\d{4}-\d{2}-\d{2}$` | Include emails received on or before this date (end of day, UTC+8) |
| `accountIds` | comma-separated string | optional, max 6 non-empty entries after splitting | Filter to these account IDs (OR logic). Omit = all accounts. |

Existing params (`category`, `folder`, `tab`, `important`, `accountId`, `search`, `unread`, `limit`, `offset`) remain unchanged and fully compatible. `accountId` (single) continues to work; if both `accountId` and `accountIds` are provided, `accountIds` takes precedence.

### Search execution flow

**When `search` param is absent** (the common case):
- SQL query runs as today, with `dateFrom`/`dateTo`/`accountIds` conditions appended to the WHERE clause.
- No decryption overhead.

**When `search` param is present**:
1. SQL fetches up to 2000 candidate rows matching all indexed filters (folder, tab, category, accountIds, dateFrom/dateTo, unread), ordered by `received_at DESC`. The SQL query must **NOT** apply any `search` filter — only the in-memory pass does (step 3). The existing `AND e.sender LIKE ?` SQL clause must be removed from both the data query and the count query when the in-memory path is active. The implicit `AND e.tab != 'promotions'` rule (applied when `folder=inbox` and no explicit `tab` param) must still be included in the candidate query. Columns selected: `id`, `account_id`, `subject_enc` (ciphertext), `sender`, `sender_name`, `received_at`, `is_read`, `category`, `snippet` (**ciphertext** — stored encrypted despite the column name lacking `_enc` suffix, consistent with existing handler), `raw_size`.
2. Node decrypts `subject_enc` → `subject` and `snippet` (ciphertext) → `snippet` (plaintext) for each candidate using `user.dataKey`. Both fields hold AES-256-GCM ciphertext and must be decrypted before string matching.
3. In-memory filter: keep rows where `sender`, `subject`, or `snippet` contains the search term (case-insensitive string match).
4. Total count is derived from the filtered set length. **Known limitation:** if the candidate set was capped at 2000, `total` reflects at most 2000, not the true match count across the full mailbox. This is an accepted trade-off of the in-memory search approach.
5. `limit`/`offset` are applied to the filtered set before returning.
6. Response shape is unchanged: `{ emails, total, limit, offset }`.

The 2000-row candidate cap prevents memory spikes. At InboxMY's scale (≤6 accounts, typical mailbox sizes) this is sufficient.

### SQL changes

`dateFrom` maps to: `AND e.received_at >= ?`
- Value: `new Date('YYYY-MM-DDT00:00:00+08:00').getTime()` — **milliseconds** since epoch (matching the `received_at` column, which stores Gmail `internalDate` / `new Date(...).getTime()` values in ms).

`dateTo` maps to: `AND e.received_at <= ?`
- Value: `new Date('YYYY-MM-DDT23:59:59.999+08:00').getTime()` — **milliseconds** since epoch, end of day MYT.

`accountIds` (when non-empty) maps to: `AND e.account_id IN (?, ?, ...)` — each ID is verified to belong to the current user via the existing `JOIN accounts a ON a.id = e.account_id WHERE a.user_id = ?` constraint.

No schema migrations are required.

### Zod schema additions

```typescript
const listQuery = z.object({
  // ... existing fields ...
  dateFrom:   z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dateTo:     z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  accountIds: z.string().optional(), // comma-separated; handler splits and validates
})
```

**Handler-level `accountIds` validation** (after zod parsing):
1. Split on commas: `ids = accountIds.split(',').filter(s => s.trim().length > 0)`
2. If `ids` is empty after filtering, treat `accountIds` as absent (no filter).
3. If any entry is an empty string after trim, skip it silently (don't 400).
4. Cap at 6 entries; ignore extras beyond the 6th.

### Date swap

If `dateTo` < `dateFrom` (after conversion to milliseconds), the backend swaps them silently before executing the query. User intent is unambiguous. This is tested (see Section 5).

---

## 2. Frontend State

Three new state variables in `app.js`:

```js
let currentDateFrom   = null;  // 'YYYY-MM-DD' string or null
let currentDateTo     = null;  // 'YYYY-MM-DD' string or null
let currentAccountIds = [];    // string[] of account IDs; [] = all accounts
```

`buildEmailParams()` is updated to include these when set:
- `dateFrom` / `dateTo` passed as-is if non-null.
- `accountIds` joined as a comma-separated string if the array is non-empty. When `currentAccountIds` is non-empty, `currentAccountId` (the single-account sidebar filter) is **not** sent — `accountIds` fully replaces it. This prevents silent override conflicts. The sidebar single-account highlight continues to set `currentAccountId` as before; the account pills set `currentAccountIds`; they are mutually exclusive in `buildEmailParams()`: if `currentAccountIds.length > 0`, use `accountIds`; otherwise use `accountId` if set.

**Reset behaviour:**
- Switching sidebar folders resets `currentDateFrom`, `currentDateTo`, and `currentFilter` (unread/all) — same as today.
- Account pill selection (`currentAccountIds`) persists across folder switches — it is a cross-folder filter.
- Clicking "× Clear filters" resets `currentDateFrom`, `currentDateTo`, and `currentAccountIds` only. It does **not** reset `currentSearch` (the text search box) or `currentFilter` (the unread/all toggle) — those are separate and remain active.

---

## 3. Filter Bar UI

The filter bar is reorganised into two rows:

**Row 1 — Date presets + custom picker** (new, between search box and existing pills row):

```
[ Today ] [ This week ] [ This month ] [ Last 3 months ] [ Custom ▾ ]    × Clear filters
```

- Each preset pill sets `currentDateFrom`/`currentDateTo` and calls `loadEmails(true)`.
- Active preset gets the existing `.active` class styling.
- Clicking an active preset clears the date range.
- Only one preset can be active at a time; selecting a new preset deactivates the previous one.
- **Custom pill**: toggles a compact inline date-range panel containing two `<input type="date">` fields (From / To) and an "Apply" button. When a custom range is active the pill label changes to `Custom ✕`; clicking ✕ clears it.
- If `dateFrom` is set without `dateTo`, the query has no upper bound (emails from that date to now). If `dateTo` is set without `dateFrom`, the query has no lower bound.
- **"× Clear filters"** text link appears at the right of this row whenever any date filter or account filter is active. Clicking it resets `currentDateFrom`, `currentDateTo`, and `currentAccountIds` to null/empty and calls `loadEmails(true)`. Does not clear the search box or unread toggle.

**Row 2 — Existing category/unread pills + account pills** (existing row, extended):

```
[ All ] [ Unread ] [ Bills ] [ Govt ] [ Receipts ]    |    [ acc1@gmail ✕ ] [ acc2@outlook ]
                                                            ↑ account pills, right-aligned
```

- Account pills are rendered dynamically from `accountsData` when accounts load (same timing as the existing sidebar account list render).
- Each pill shows the account label (or email truncated to ~20 chars) with a `title` attribute for the full address.
- Clicking a pill toggles that account ID in/out of `currentAccountIds` and calls `loadEmails(true)`.
- Active (selected) account pills use the same `.active` styling.
- No account selected = all accounts (no `accountIds` param sent).
- Account pills are hidden if only one account is connected (single account — filter adds no value).

---

## 4. Error Handling

- Invalid `dateFrom`/`dateTo` format → zod returns 400 with field-level errors (same as existing validation).
- `dateTo` before `dateFrom` → backend swaps them silently (see Section 1, Date swap). Note: format errors return 400 while logical date inversion is silently corrected — this asymmetry is intentional; user intent with an inverted range is unambiguous whereas a malformed string indicates a client bug.
- Unknown `accountIds` entries (IDs not belonging to the user) are silently ignored — the `JOIN accounts a WHERE a.user_id = ?` constraint already prevents cross-user data leakage.
- Decryption failure on a candidate row during in-memory search → that row is skipped (same pattern as the existing `GET /api/emails` handler).
- Search returning 0 results → existing empty-state UI handles this.

---

## 5. Testing

### Backend (Vitest)

File: `inboxmy-backend/src/routes/emails.test.ts` (extend existing file)

- `dateFrom` filter returns only emails on/after the given date (boundary inclusive, ms precision).
- `dateTo` filter returns only emails on/before the given date (boundary inclusive, ms precision).
- `dateFrom` + `dateTo` together return emails within the range.
- `dateTo` earlier than `dateFrom` → backend swaps and returns the correct range.
- `accountIds` with a single ID returns only emails from that account.
- `accountIds` with multiple IDs returns emails from any of those accounts (OR).
- `accountIds` containing an ID from another user returns no results (security check).
- `accountIds=,,,` (all empty entries) is treated as absent — returns all accounts.
- `search` matches on sender field (now in-memory match, consistent with subject/snippet; no longer a SQL LIKE).
- `search` matches on decrypted subject.
- `search` matches on decrypted snippet.
- `search` + `dateFrom`/`dateTo` combined narrows results correctly.
- 2000-row candidate cap: with >2000 candidates, `limit`/`offset` still returns the correct page slice.
- 2000-row candidate cap: `total` in the response reflects the in-memory filtered count (≤2000), not the raw DB row count.
- `search` + `accountIds` combined narrows results to matching emails in the specified accounts only.

### Frontend (manual smoke test checklist)

- Selecting a date preset filters the email list correctly.
- Selecting "Custom", setting dates, clicking Apply filters correctly.
- Clearing a preset removes the filter.
- Account pill toggles in/out; multi-select returns combined results.
- "× Clear filters" resets date and account filters but leaves search box and unread toggle intact.
- Account pills hidden when only one account connected.
- Date filters reset on folder switch; account pills persist across folder switch.

---

## 6. Out of Scope

- Bill panel search/filtering (deferred to a future plan).
- SQLite FTS5 index (privacy trade-off; revisit if performance degrades at scale).
- Saved searches or search history.
- Sorting options (by sender, subject, etc.).
