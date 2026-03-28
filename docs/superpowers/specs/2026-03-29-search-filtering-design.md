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
| `accountIds` | comma-separated string | optional, max 6 entries, each non-empty | Filter to these account IDs (OR logic). Omit = all accounts. |

Existing params (`category`, `folder`, `tab`, `important`, `accountId`, `search`, `unread`, `limit`, `offset`) remain unchanged and fully compatible. `accountId` (single) continues to work; if both `accountId` and `accountIds` are provided, `accountIds` takes precedence.

### Search execution flow

**When `search` param is absent** (the common case):
- SQL query runs as today, with `dateFrom`/`dateTo`/`accountIds` conditions appended to the WHERE clause.
- No decryption overhead.

**When `search` param is present**:
1. SQL fetches up to 2000 candidate rows matching all indexed filters (folder, tab, category, accountIds, dateFrom/dateTo, unread). Only `id`, `account_id`, `subject_enc`, `sender`, `sender_name`, `received_at`, `is_read`, `category`, `snippet`, `raw_size` are selected.
2. Node decrypts `subject_enc` and `snippet` for each candidate using `user.dataKey`.
3. In-memory filter: keep rows where `sender`, `subject`, or `snippet` contains the search term (case-insensitive string match).
4. Total count is derived from the filtered set length.
5. `limit`/`offset` are applied to the filtered set before returning.
6. Response shape is unchanged: `{ emails, total, limit, offset }`.

The 2000-row candidate cap prevents memory spikes. At InboxMY's scale (≤6 accounts, typical mailbox sizes) this is sufficient. If a user's filtered candidate set exceeds 2000 rows, the search operates on the most recent 2000 by `received_at DESC`.

### SQL changes

`dateFrom` maps to: `AND e.received_at >= ?` (timestamp = start of day in MYT, i.e. UTC+8)
`dateTo` maps to: `AND e.received_at <= ?` (timestamp = end of day in MYT)
`accountIds` (when non-empty) maps to: `AND e.account_id IN (?, ?, ...)` — each ID verified to belong to the current user via the existing `JOIN accounts a ON a.id = e.account_id WHERE a.user_id = ?` constraint.

No schema migrations are required.

### Zod schema additions

```typescript
const listQuery = z.object({
  // ... existing fields ...
  dateFrom:   z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dateTo:     z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  accountIds: z.string().optional(), // comma-separated, split + validated in handler
})
```

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
- `accountIds` joined as a comma-separated string if the array is non-empty.

**Reset behaviour:**
- Switching sidebar folders resets `currentDateFrom`, `currentDateTo`, and `currentFilter` (unread/all) — same as today.
- Account pill selection (`currentAccountIds`) persists across folder switches — it is a cross-folder filter.
- Clicking "Clear all filters" (new button, appears when any filter is active) resets everything including account pills.

---

## 3. Filter Bar UI

The filter bar is reorganised into two rows:

**Row 1 — Date presets + custom picker** (new, between search box and existing pills row):

```
[ Today ] [ This week ] [ This month ] [ Last 3 months ] [ Custom ▾ ]
```

- Each preset pill sets `currentDateFrom`/`currentDateTo` and calls `loadEmails(true)`.
- Active preset gets the existing `.active` class styling.
- Clicking an active preset clears the date range.
- Only one preset can be active at a time; selecting a new preset deactivates the previous one.
- **Custom pill**: toggles a compact inline date-range panel containing two `<input type="date">` fields (From / To) and an "Apply" button. When a custom range is active the pill label changes to `Custom ✕`; clicking ✕ clears it.
- If `dateFrom` is set without `dateTo`, the query has no upper bound (emails from that date to now). If `dateTo` is set without `dateFrom`, the query has no lower bound.

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

**"Clear filters" affordance:**
- A small `× Clear filters` text link appears to the right of the date preset row whenever any date filter or account filter is active.
- Clicking it resets `currentDateFrom`, `currentDateTo`, `currentAccountIds` to null/empty and reloads.

---

## 4. Error Handling

- Invalid `dateFrom`/`dateTo` format → zod returns 400 with field-level errors (same as existing validation).
- `dateTo` before `dateFrom` → backend swaps them silently (user intent is clear).
- Unknown `accountIds` entries (IDs not belonging to the user) are silently ignored — the `JOIN accounts a WHERE a.user_id = ?` constraint already prevents cross-user data leakage.
- Decryption failure on a candidate row during in-memory search → that row is skipped (same pattern as the existing `GET /api/emails` handler).
- Search returning 0 results → existing empty-state UI handles this.

---

## 5. Testing

### Backend (Vitest)

File: `inboxmy-backend/src/routes/emails.test.ts` (extend existing file)

- `dateFrom` filter returns only emails on/after the given date.
- `dateTo` filter returns only emails on/before the given date.
- `dateFrom` + `dateTo` together return emails within the range.
- `accountIds` with a single ID returns only emails from that account.
- `accountIds` with multiple IDs returns emails from any of those accounts (OR).
- `accountIds` containing an ID from another user returns no results (security check).
- `search` matches on sender field (existing behaviour, unchanged).
- `search` matches on decrypted subject.
- `search` matches on decrypted snippet.
- `search` + `dateFrom`/`dateTo` combined narrows results correctly.
- 2000-row candidate cap: with >2000 candidates, pagination still returns correct page.

### Frontend (manual smoke test checklist)

- Selecting a date preset filters the email list correctly.
- Selecting "Custom", setting dates, clicking Apply filters correctly.
- Clearing a preset removes the filter.
- Account pill toggles in/out; multi-select returns combined results.
- "Clear filters" resets all date and account filters.
- Account pills hidden when only one account connected.
- Date filters reset on folder switch; account pills persist.

---

## 6. Out of Scope

- Bill panel search/filtering (deferred to a future plan).
- SQLite FTS5 index (privacy trade-off; revisit if performance degrades at scale).
- Saved searches or search history.
- Sorting options (by sender, subject, etc.).
