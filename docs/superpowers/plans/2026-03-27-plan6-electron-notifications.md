# Plan 6 — Electron Shell + Overdue Detection + Windows Notifications + AI

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert InboxMY into a BlueMail-style Electron desktop app with overdue bill detection, Windows toast notifications, a background scheduler, and Gemini 2.0 Flash AI notification copy.

**Architecture:** The existing Express/TypeScript backend runs as a child process spawned by `electron/main.js`. A `BrowserWindow` loads `http://localhost:3000`. A `contextBridge` preload exposes `window.inboxmy.*` IPC methods to the renderer. A scheduler in the main process fires every 60 min (and 30s after startup), marks overdue bills, fetches due-soon bills, generates AI copy via Gemini, fires native Windows toasts, and sends live updates to the renderer. Gemini API key stored via `safeStorage` (Windows DPAPI).

**Tech Stack:** Electron 31, electron-builder (NSIS), electron-auto-launch, TypeScript/Express backend, better-sqlite3, @google/generative-ai, Vitest, vanilla JS frontend.

**Spec:** `docs/superpowers/specs/2026-03-27-plan6-electron-notifications-design.md`

---

## File Map

All paths from repo root (`VibeCode/`). Backend source = `inboxmy-backend/src/`, backend tests = `inboxmy-backend/tests/`.

| File | Action | Responsibility |
|---|---|---|
| `package.json` | Create | Root Electron package — scripts, build config, deps |
| `vitest.config.mjs` | Create | Root vitest config for electron/utils tests |
| `electron/main.js` | Create | Main process: spawn backend, BrowserWindow, tray, IPC, scheduler |
| `electron/preload.js` | Create | contextBridge: window.inboxmy.* |
| `electron/utils.js` | Create | Pure utilities: makeNotificationKey (testable without Electron) |
| `electron/utils.test.js` | Create | Vitest tests for makeNotificationKey |
| `electron/assets/tray-icon.png` | Create | 16×16 tray icon (placeholder PNG) |
| `electron/assets/icon.png` | Create | Notification icon (placeholder PNG) |
| `electron/assets/icon.ico` | Create | Windows app icon for electron-builder NSIS installer |
| `inboxmy-backend/src/ai/notifier.ts` | Create | Gemini 2.0 Flash integration + fallback plain copy |
| `inboxmy-backend/src/routes/notifications.ts` | Create | GET /api/notifications/due-soon, POST /api/notifications/ai-summary |
| `inboxmy-backend/tests/routes/notifications.test.ts` | Create | Tests for auto-mark-overdue + due-soon + ai-summary |
| `inboxmy-backend/tests/ai/notifier.test.ts` | Create | Unit tests for notifier with mocked Gemini SDK |
| `inboxmy-backend/src/routes/bills.ts` | Modify | Add PATCH /api/bills/auto-mark-overdue |
| `inboxmy-backend/src/server.ts` | Modify | Mount notificationsRouter at /api/notifications |
| `inboxmy-backend/src/scheduler.ts` | Modify | Update comment only |
| `inboxmy-backend/package.json` | Modify | Add @google/generative-ai dependency |
| `frontend/index.html` | Modify | Overdue banner CSS, banner HTML, Settings AI section HTML |
| `frontend/app.js` | Modify | renderOverdueBanner(), Settings AI IPC, deep link handler |
| `README.md` | Modify | Electron-first docs, business model, updated test table |
| `SETUP.md` | Modify | AI Notifications optional setup section |

---

## Task 1: Backend — Install AI dependency + scaffold notifications route

**Files:**
- Modify: `inboxmy-backend/package.json`
- Create: `inboxmy-backend/src/routes/notifications.ts`
- Modify: `inboxmy-backend/src/server.ts`

- [ ] **Step 1: Add @google/generative-ai to backend package.json**

In `inboxmy-backend/`, run:
```bash
cd inboxmy-backend
npm install @google/generative-ai
```

- [ ] **Step 2: Create notifications route stub**

Create `inboxmy-backend/src/routes/notifications.ts`:
```typescript
// src/routes/notifications.ts
import { Router } from 'express'

export const notificationsRouter = Router()

// Endpoints implemented in Tasks 3 and 5
```

- [ ] **Step 3: Mount the router in server.ts**

In `inboxmy-backend/src/server.ts`, add after the existing router imports (around line 11):
```typescript
import { notificationsRouter } from './routes/notifications'
```

Add after line `app.use('/api/bills', billsRouter)` (around line 100):
```typescript
app.use('/api/notifications', notificationsRouter)
```

- [ ] **Step 4: Verify existing tests still pass**

```bash
cd inboxmy-backend
$env:ENCRYPTION_KEY="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
$env:DATA_DIR="./data-test"
npm test
```
Expected: 88 tests passing.

- [ ] **Step 5: Commit**

```bash
git add inboxmy-backend/package.json inboxmy-backend/package-lock.json inboxmy-backend/src/routes/notifications.ts inboxmy-backend/src/server.ts
git commit -m "feat: add @google/generative-ai dep, scaffold notifications router"
```

---

## Task 2: TDD — `PATCH /api/bills/auto-mark-overdue`

**Files:**
- Create: `inboxmy-backend/tests/routes/notifications.test.ts`
- Modify: `inboxmy-backend/src/routes/bills.ts`

- [ ] **Step 1: Write the failing tests**

Create `inboxmy-backend/tests/routes/notifications.test.ts`:
```typescript
// tests/routes/notifications.test.ts
import { describe, it, expect, afterAll } from 'vitest'
import { closeDb, getDb } from '../../src/db'
import { encryptSystem } from '../../src/crypto'
import { randomUUID } from 'crypto'
import { createTestUser } from '../helpers/auth'

afterAll(() => closeDb())

// ── Seed helper ────────────────────────────────────────────────────────────────
function seedBill(userId: string, opts: {
  status?: string
  dueDateMs?: number | null
  biller?: string
  amountRm?: number
}) {
  const db = getDb()
  const accountId = randomUUID()
  const emailId = randomUUID()
  const billId = randomUUID()

  db.prepare(`
    INSERT INTO accounts (id, provider, email, token_enc, created_at, user_id)
    VALUES (?, 'gmail', ?, ?, ?, ?)
  `).run(accountId, `${accountId}@test.com`, encryptSystem('{}'), Date.now(), userId)

  db.prepare(`
    INSERT INTO emails (id, account_id, subject_enc, sender, received_at)
    VALUES (?, ?, ?, 'test@test.com', ?)
  `).run(emailId, accountId, encryptSystem('Test Bill'), Date.now())

  db.prepare(`
    INSERT INTO parsed_bills (id, email_id, biller, amount_rm, due_date, status, parsed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    billId, emailId,
    opts.biller ?? 'TNB',
    opts.amountRm ?? 100.00,
    opts.dueDateMs !== undefined ? opts.dueDateMs : Date.now() - 1000,
    opts.status ?? 'unpaid',
    Date.now()
  )

  return { billId, accountId, emailId }
}

// ── PATCH /api/bills/auto-mark-overdue ─────────────────────────────────────────
describe('PATCH /api/bills/auto-mark-overdue', () => {
  it('marks unpaid bill with past due_date as overdue', async () => {
    const { agent, id: userId } = await createTestUser()
    const pastDue = Date.now() - 60_000 // 1 minute ago
    const { billId } = seedBill(userId, { status: 'unpaid', dueDateMs: pastDue })

    const res = await agent.patch('/api/bills/auto-mark-overdue')
    expect(res.status).toBe(200)
    expect(res.body.marked).toBeGreaterThanOrEqual(1)

    const row = getDb().prepare('SELECT status FROM parsed_bills WHERE id = ?').get(billId) as any
    expect(row.status).toBe('overdue')
  })

  it('does not mark unpaid bill with future due_date', async () => {
    const { agent, id: userId } = await createTestUser()
    const futureDue = Date.now() + 7 * 24 * 60 * 60 * 1000 // 7 days from now
    const { billId } = seedBill(userId, { status: 'unpaid', dueDateMs: futureDue })

    await agent.patch('/api/bills/auto-mark-overdue')

    const row = getDb().prepare('SELECT status FROM parsed_bills WHERE id = ?').get(billId) as any
    expect(row.status).toBe('unpaid')
  })

  it('does not re-mark a paid bill even if due_date is past', async () => {
    const { agent, id: userId } = await createTestUser()
    const pastDue = Date.now() - 60_000
    const { billId } = seedBill(userId, { status: 'paid', dueDateMs: pastDue })

    await agent.patch('/api/bills/auto-mark-overdue')

    const row = getDb().prepare('SELECT status FROM parsed_bills WHERE id = ?').get(billId) as any
    expect(row.status).toBe('paid')
  })

  it('does not affect another user\'s bills', async () => {
    const { id: userId1 } = await createTestUser()
    const { agent: agent2 } = await createTestUser()
    const pastDue = Date.now() - 60_000
    const { billId } = seedBill(userId1, { status: 'unpaid', dueDateMs: pastDue })

    await agent2.patch('/api/bills/auto-mark-overdue')

    const row = getDb().prepare('SELECT status FROM parsed_bills WHERE id = ?').get(billId) as any
    expect(row.status).toBe('unpaid') // still unpaid — user2 can't touch user1's bills
  })

  it('does not mark a bill whose due_date equals exactly now (strict less-than boundary)', async () => {
    // The SQL uses `due_date < ?` (strict). A bill due at the exact moment
    // the query runs is NOT yet overdue — it has not passed yet.
    // We approximate "exact now" by using Date.now() at query time; in practice
    // a bill timestamped 1ms in the future will not be marked.
    const { agent, id: userId } = await createTestUser()
    const notYetPast = Date.now() + 500 // 500ms in the future — effectively "right now"
    const { billId } = seedBill(userId, { status: 'unpaid', dueDateMs: notYetPast })

    await agent.patch('/api/bills/auto-mark-overdue')

    const row = getDb().prepare('SELECT status FROM parsed_bills WHERE id = ?').get(billId) as any
    expect(row.status).toBe('unpaid') // not yet overdue
  })

  it('returns 401 without session', async () => {
    const { default: request } = await import('supertest')
    const { app } = await import('../../src/server')
    const res = await request(app).patch('/api/bills/auto-mark-overdue')
    expect(res.status).toBe(401)
  })
})
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd inboxmy-backend
$env:ENCRYPTION_KEY="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
$env:DATA_DIR="./data-test"
npx vitest run tests/routes/notifications.test.ts
```
Expected: FAIL — "Cannot PATCH /api/bills/auto-mark-overdue" (404).

- [ ] **Step 3: Implement `PATCH /api/bills/auto-mark-overdue` in bills.ts**

In `inboxmy-backend/src/routes/bills.ts`, add before the existing `billsRouter.patch('/:id/status', ...)` (important: the literal route `/auto-mark-overdue` must be registered before the parameterised `/:id/status` route to avoid Express matching `auto-mark-overdue` as an `:id`):

```typescript
// PATCH /api/bills/auto-mark-overdue
// Marks all unpaid bills whose due_date has passed as 'overdue'.
// Called by the Electron scheduler before each notification check.
billsRouter.patch('/auto-mark-overdue', (req, res) => {
  const user = (req as any).user
  const db = getDb()
  const now = Date.now()

  const result = db.prepare(`
    UPDATE parsed_bills SET status = 'overdue'
    WHERE status = 'unpaid'
      AND due_date IS NOT NULL
      AND due_date < ?
      AND email_id IN (
        SELECT e.id FROM emails e
        JOIN accounts a ON a.id = e.account_id
        WHERE a.user_id = ?
      )
  `).run(now, user.id)

  res.json({ marked: result.changes })
})
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
cd inboxmy-backend
$env:ENCRYPTION_KEY="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
$env:DATA_DIR="./data-test"
npx vitest run tests/routes/notifications.test.ts
```
Expected: 5 tests passing (the auto-mark-overdue group only — due-soon tests don't exist yet).

- [ ] **Step 5: Commit**

```bash
git add inboxmy-backend/src/routes/bills.ts inboxmy-backend/tests/routes/notifications.test.ts
git commit -m "feat: add PATCH /api/bills/auto-mark-overdue with TDD (5 tests)"
```

---

## Task 3: TDD — `GET /api/notifications/due-soon`

**Files:**
- Modify: `inboxmy-backend/tests/routes/notifications.test.ts` (add tests)
- Modify: `inboxmy-backend/src/routes/notifications.ts` (implement endpoint)

- [ ] **Step 1: Add due-soon tests to notifications.test.ts**

Append to `inboxmy-backend/tests/routes/notifications.test.ts`:
```typescript
// ── GET /api/notifications/due-soon ───────────────────────────────────────────
describe('GET /api/notifications/due-soon', () => {
  it('returns unpaid bills due within 72h', async () => {
    const { agent, id: userId } = await createTestUser()
    const in24h = Date.now() + 24 * 60 * 60 * 1000
    const { billId } = seedBill(userId, { status: 'unpaid', dueDateMs: in24h })

    const res = await agent.get('/api/notifications/due-soon')
    expect(res.status).toBe(200)
    expect(res.body.bills.some((b: any) => b.id === billId)).toBe(true)
  })

  it('includes bill due at exactly now+72h (inclusive boundary)', async () => {
    const { agent, id: userId } = await createTestUser()
    const exactly72h = Date.now() + 72 * 60 * 60 * 1000
    const { billId } = seedBill(userId, { status: 'unpaid', dueDateMs: exactly72h })

    const res = await agent.get('/api/notifications/due-soon')
    expect(res.status).toBe(200)
    expect(res.body.bills.some((b: any) => b.id === billId)).toBe(true)
  })

  it('excludes unpaid bills due after 72h', async () => {
    const { agent, id: userId } = await createTestUser()
    const in5days = Date.now() + 5 * 24 * 60 * 60 * 1000
    const { billId } = seedBill(userId, { status: 'unpaid', dueDateMs: in5days })

    const res = await agent.get('/api/notifications/due-soon')
    expect(res.status).toBe(200)
    expect(res.body.bills.some((b: any) => b.id === billId)).toBe(false)
  })

  it('returns overdue bills regardless of due_date', async () => {
    const { agent, id: userId } = await createTestUser()
    const pastDue = Date.now() - 3 * 24 * 60 * 60 * 1000
    const { billId } = seedBill(userId, { status: 'overdue', dueDateMs: pastDue })

    const res = await agent.get('/api/notifications/due-soon')
    expect(res.status).toBe(200)
    expect(res.body.bills.some((b: any) => b.id === billId)).toBe(true)
  })

  it('excludes paid bills', async () => {
    const { agent, id: userId } = await createTestUser()
    const in24h = Date.now() + 24 * 60 * 60 * 1000
    const { billId } = seedBill(userId, { status: 'paid', dueDateMs: in24h })

    const res = await agent.get('/api/notifications/due-soon')
    expect(res.status).toBe(200)
    expect(res.body.bills.some((b: any) => b.id === billId)).toBe(false)
  })

  it('returns 401 without session', async () => {
    const { default: request } = await import('supertest')
    const { app } = await import('../../src/server')
    const res = await request(app).get('/api/notifications/due-soon')
    expect(res.status).toBe(401)
  })
})
```

- [ ] **Step 2: Run to confirm new tests fail**

```bash
cd inboxmy-backend
$env:ENCRYPTION_KEY="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
$env:DATA_DIR="./data-test"
npx vitest run tests/routes/notifications.test.ts
```
Expected: 5 pass, 6 fail (404 on due-soon).

- [ ] **Step 3: Implement `GET /api/notifications/due-soon`**

Replace the stub in `inboxmy-backend/src/routes/notifications.ts`:
```typescript
// src/routes/notifications.ts
import { Router } from 'express'
import { getDb } from '../db'

export const notificationsRouter = Router()

notificationsRouter.get('/due-soon', (req, res) => {
  const user = (req as any).user
  const db = getDb()
  const now = Date.now()
  const window72h = now + 72 * 60 * 60 * 1000

  const rows = db.prepare(`
    SELECT pb.id, pb.biller, pb.amount_rm, pb.due_date, pb.status
    FROM parsed_bills pb
    JOIN emails e ON e.id = pb.email_id
    JOIN accounts a ON a.id = e.account_id
    WHERE a.user_id = ?
      AND (
        pb.status = 'overdue'
        OR (
          pb.status = 'unpaid'
          AND pb.due_date IS NOT NULL
          AND pb.due_date >= ?
          AND pb.due_date <= ?
        )
      )
    ORDER BY pb.due_date ASC
  `).all(user.id, now, window72h)

  res.json({ bills: rows })
})
```

- [ ] **Step 4: Run to confirm all 11 tests pass**

```bash
cd inboxmy-backend
$env:ENCRYPTION_KEY="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
$env:DATA_DIR="./data-test"
npx vitest run tests/routes/notifications.test.ts
```
Expected: 11 tests passing.

- [ ] **Step 5: Commit**

```bash
git add inboxmy-backend/src/routes/notifications.ts inboxmy-backend/tests/routes/notifications.test.ts
git commit -m "feat: add GET /api/notifications/due-soon with TDD (11 tests total)"
```

---

## Task 4: TDD — AI Notifier (`src/ai/notifier.ts`)

**Files:**
- Create: `inboxmy-backend/tests/ai/notifier.test.ts`
- Create: `inboxmy-backend/src/ai/notifier.ts`

- [ ] **Step 1: Write the failing tests**

Create `inboxmy-backend/tests/ai/notifier.test.ts`:
```typescript
// tests/ai/notifier.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest'

// Mock @google/generative-ai before importing notifier
vi.mock('@google/generative-ai', () => {
  const mockGenerateContent = vi.fn()
  return {
    GoogleGenerativeAI: vi.fn().mockImplementation(() => ({
      getGenerativeModel: vi.fn().mockReturnValue({
        generateContent: mockGenerateContent,
      }),
    })),
    _mockGenerateContent: mockGenerateContent,
  }
})

// Import after mock is set up
const { getNotifications } = await import('../../src/ai/notifier')
const { _mockGenerateContent } = await import('@google/generative-ai') as any

const TNB_BILL = {
  id: 'bill-tnb-1',
  biller: 'TNB',
  amountRm: 142.80,
  dueDateMs: Date.now() + 2 * 24 * 60 * 60 * 1000,
  status: 'unpaid' as const,
  daysUntilDue: 2,
}

const SHOPEE_PROMO = {
  id: 'bill-shopee-1',
  biller: 'Shopee',
  amountRm: 5.50,
  dueDateMs: Date.now() + 24 * 60 * 60 * 1000,
  status: 'unpaid' as const,
  daysUntilDue: 1,
}

afterEach(() => {
  vi.clearAllMocks()
})

describe('getNotifications — AI success path', () => {
  it('returns AI copy for TNB bill', async () => {
    _mockGenerateContent.mockResolvedValue({
      response: {
        text: () => JSON.stringify([
          { billId: 'bill-tnb-1', shouldNotify: true, title: 'TNB eBill due Friday', body: 'RM142.80 due in 2 days. Pay on time!' }
        ])
      }
    })

    const results = await getNotifications([TNB_BILL], 'fake-api-key')
    expect(results).toHaveLength(1)
    expect(results[0].billId).toBe('bill-tnb-1')
    expect(results[0].shouldNotify).toBe(true)
    expect(results[0].title).toContain('TNB')
  })

  it('suppresses Shopee promo when AI says shouldNotify: false', async () => {
    _mockGenerateContent.mockResolvedValue({
      response: {
        text: () => JSON.stringify([
          { billId: 'bill-shopee-1', shouldNotify: false, title: '', body: '' }
        ])
      }
    })

    const results = await getNotifications([SHOPEE_PROMO], 'fake-api-key')
    expect(results[0].shouldNotify).toBe(false)
  })
})

describe('getNotifications — fallback path', () => {
  it('falls back to plain copy when Gemini throws', async () => {
    _mockGenerateContent.mockRejectedValue(new Error('Network error'))

    const results = await getNotifications([TNB_BILL], 'fake-api-key')
    expect(results).toHaveLength(1)
    expect(results[0].shouldNotify).toBe(true)
    expect(results[0].billId).toBe('bill-tnb-1')
    expect(results[0].title.length).toBeGreaterThan(0)
  })

  it('falls back to plain copy when Gemini returns malformed JSON', async () => {
    _mockGenerateContent.mockResolvedValue({
      response: { text: () => 'NOT VALID JSON {{' }
    })

    const results = await getNotifications([TNB_BILL], 'fake-api-key')
    expect(results).toHaveLength(1)
    expect(results[0].shouldNotify).toBe(true)
  })

  it('returns empty array for empty input', async () => {
    const results = await getNotifications([], 'fake-api-key')
    expect(results).toHaveLength(0)
    expect(_mockGenerateContent).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run to confirm tests fail**

```bash
cd inboxmy-backend
$env:ENCRYPTION_KEY="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
$env:DATA_DIR="./data-test"
npx vitest run tests/ai/notifier.test.ts
```
Expected: FAIL — cannot find module `../../src/ai/notifier`.

- [ ] **Step 3: Create `src/ai/notifier.ts`**

Create the directory and file:
```typescript
// src/ai/notifier.ts
import { GoogleGenerativeAI } from '@google/generative-ai'

export interface BillForNotification {
  id: string
  biller: string
  amountRm: number | null
  dueDateMs: number | null
  status: 'unpaid' | 'overdue'
  daysUntilDue: number  // negative = overdue
}

export interface NotificationResult {
  billId: string
  shouldNotify: boolean
  title: string   // max 60 chars
  body: string    // max 120 chars
}

const SYSTEM_PROMPT = `You are a notification assistant for InboxMY, a Malaysian email app.
Given a list of bills, decide which ones are worth a Windows toast notification and write concise copy. Rules:
- ALWAYS notify: TNB, Unifi, Celcom, Maxis, Digi, TnG, LHDN, any amount > RM50
- SUPPRESS: Shopee/Lazada promotional emails, amounts < RM10
- For overdue bills: lead with urgency ("overdue", "unpaid")
- For due-soon: mention days remaining and amount
- Title: max 60 chars. Body: max 120 chars. Friendly, Malaysian English.
Return ONLY a JSON array (no markdown, no code fences): [{ billId, shouldNotify, title, body }]`

function plainCopy(bills: BillForNotification[]): NotificationResult[] {
  return bills.map(b => {
    const amt = b.amountRm != null ? `RM${Number(b.amountRm).toFixed(2)}` : ''
    const when = b.daysUntilDue < 0
      ? `${Math.abs(b.daysUntilDue)} day(s) overdue`
      : b.daysUntilDue === 0
      ? 'due today'
      : `due in ${b.daysUntilDue} day(s)`
    return {
      billId: b.id,
      shouldNotify: true,
      title: `${b.biller} — ${when}`.slice(0, 60),
      body: [amt, when].filter(Boolean).join(' ').slice(0, 120),
    }
  })
}

export async function getNotifications(
  bills: BillForNotification[],
  geminiKey: string
): Promise<NotificationResult[]> {
  if (!bills.length) return []

  try {
    const genAI = new GoogleGenerativeAI(geminiKey)
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' })

    const prompt = SYSTEM_PROMPT + '\n\nBills:\n' + JSON.stringify(bills)
    const result = await model.generateContent(prompt)
    const text = result.response.text()

    const parsed = JSON.parse(text)
    if (!Array.isArray(parsed)) throw new Error('Gemini response was not an array')
    return parsed as NotificationResult[]
  } catch (err) {
    console.error('[notifier] Gemini error — using plain copy:', (err as Error).message)
    return plainCopy(bills)
  }
}
```

- [ ] **Step 4: Run to confirm all 5 tests pass**

```bash
cd inboxmy-backend
$env:ENCRYPTION_KEY="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
$env:DATA_DIR="./data-test"
npx vitest run tests/ai/notifier.test.ts
```
Expected: 5 tests passing.

- [ ] **Step 5: Commit**

```bash
git add inboxmy-backend/src/ai/notifier.ts inboxmy-backend/tests/ai/notifier.test.ts
git commit -m "feat: add AI notifier with Gemini 2.0 Flash + fallback (5 tests)"
```

---

## Task 5: `POST /api/notifications/ai-summary` + scheduler stub + full backend test run

**Files:**
- Modify: `inboxmy-backend/src/routes/notifications.ts`
- Modify: `inboxmy-backend/src/scheduler.ts`

- [ ] **Step 1: Add `POST /api/notifications/ai-summary` to notifications.ts**

Add to the bottom of `inboxmy-backend/src/routes/notifications.ts`:
```typescript
import { getNotifications } from '../ai/notifier'
import type { BillForNotification } from '../ai/notifier'

// POST /api/notifications/ai-summary
// Accepts bills array + Gemini key, returns NotificationResult[].
// Key is passed per-request and never stored server-side.
// SECURITY: Do not add any body logging middleware — key must not appear in logs.
notificationsRouter.post('/ai-summary', async (req, res) => {
  const { bills, geminiKey } = req.body
  if (!Array.isArray(bills) || typeof geminiKey !== 'string' || !geminiKey.trim()) {
    return res.status(400).json({ error: 'bills (array) and geminiKey (string) required' })
  }

  try {
    const results = await getNotifications(bills as BillForNotification[], geminiKey)
    res.json(results)
  } catch {
    res.status(500).json({ error: 'Notification generation failed' })
  }
})
```

> **Important:** Add `import { getNotifications } from '../ai/notifier'` and `import type { BillForNotification } from '../ai/notifier'` at the top of the file alongside the existing imports.

- [ ] **Step 2: Update scheduler stub comment**

In `inboxmy-backend/src/scheduler.ts`, replace the existing comment:
```typescript
// src/scheduler.ts
// Background scheduling has moved to electron/main.js (Plan 6).
// This stub is retained so server.ts compiles without changes.
export function startScheduler(): void {
  console.log('[scheduler] Background sync disabled — scheduling handled by Electron main process (Plan 6)')
}
```

- [ ] **Step 3: Run full backend test suite**

```bash
cd inboxmy-backend
$env:ENCRYPTION_KEY="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
$env:DATA_DIR="./data-test"
npm test
```
Expected: 105+ tests passing (88 previous + 12 notification route tests + 5 notifier tests).

- [ ] **Step 4: Commit**

```bash
git add inboxmy-backend/src/routes/notifications.ts inboxmy-backend/src/scheduler.ts
git commit -m "feat: add POST /api/notifications/ai-summary, update scheduler comment"
```

---

## Task 6: Root `package.json` + Electron utilities + utils tests

**Files:**
- Create: `package.json` (root)
- Create: `vitest.config.mjs` (root)
- Create: `electron/utils.js`
- Create: `electron/utils.test.js`

- [ ] **Step 1: Create root `package.json`**

Create `package.json` at the repo root (`VibeCode/`):
```json
{
  "name": "inboxmy",
  "version": "0.6.0",
  "description": "Privacy-first unified email dashboard for Malaysia",
  "main": "electron/main.js",
  "scripts": {
    "electron:dev": "concurrently \"npm run dev --prefix inboxmy-backend\" \"wait-on http://localhost:3000/health && electron .\"",
    "start": "npm run build --prefix inboxmy-backend && electron .",
    "build": "npm run build --prefix inboxmy-backend && electron-builder",
    "dist": "npm run build --prefix inboxmy-backend && electron-builder --publish never",
    "test:utils": "vitest run --config vitest.config.mjs"
  },
  "devDependencies": {
    "concurrently": "^9.0.0",
    "electron": "^31.0.0",
    "electron-builder": "^24.0.0",
    "vitest": "^2.0.0",
    "wait-on": "^8.0.0"
  },
  "dependencies": {
    "electron-auto-launch": "^5.0.6",
    "electron-updater": "^6.0.0"
  },
  "build": {
    "appId": "my.inbox.app",
    "productName": "InboxMY",
    "win": {
      "target": "nsis",
      "icon": "electron/assets/icon.ico"
    },
    "nsis": {
      "oneClick": false,
      "allowToChangeInstallationDirectory": true
    },
    "files": [
      "electron/**/*",
      "frontend/**/*",
      "inboxmy-backend/dist/**/*",
      "inboxmy-backend/node_modules/**/*",
      "inboxmy-backend/package.json"
    ],
    "extraResources": [
      { "from": "inboxmy-backend/data", "to": "data" }
    ]
  }
}
```

- [ ] **Step 2: Create root vitest config**

Create `vitest.config.mjs` at the repo root:
```js
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    include: ['electron/**/*.test.js'],
  },
})
```

> **Note:** The `.mjs` extension forces Node to treat the config as ESM regardless of the root `package.json` (which has no `"type": "module"`). The test files (`electron/utils.test.js`) use `require()` (CommonJS). This combination — ESM config + CJS test files — is intentional and fully supported by Vitest 2.x. Do not add `"type": "module"` to the root `package.json`; Electron's main process requires CommonJS.

- [ ] **Step 3: Install root dependencies**

```bash
cd C:/Users/bryan.GOAT/Downloads/VibeCode
npm install
```
Expected: Creates root `node_modules/` with electron, electron-builder, electron-auto-launch, etc.

- [ ] **Step 4: Create `electron/utils.js`**

```bash
mkdir -p C:/Users/bryan.GOAT/Downloads/VibeCode/electron/assets
```

Create `electron/utils.js`:
```js
// electron/utils.js
// Pure utility functions — no Electron API imports, fully unit-testable.

/**
 * Generate a deduplication key for notified.json.
 * Format: billId_YYYY-MM
 * Same bill + same calendar month = same key → notifies once per monthly cycle.
 * A bill's new monthly invoice gets a fresh key the following month.
 *
 * @param {string} billId
 * @param {number} dateMs - epoch milliseconds (typically Date.now())
 * @returns {string}
 */
function makeNotificationKey(billId, dateMs) {
  const d = new Date(dateMs)
  const year = d.getFullYear()
  const month = String(d.getMonth() + 1).padStart(2, '0')
  return `${billId}_${year}-${month}`
}

module.exports = { makeNotificationKey }
```

- [ ] **Step 5: Write `electron/utils.test.js`**

Create `electron/utils.test.js`:
```js
// electron/utils.test.js
const { makeNotificationKey } = require('./utils.js')

describe('makeNotificationKey', () => {
  it('same bill same month → same key (deduplicates)', () => {
    const jan1  = new Date('2026-01-01T00:00:00Z').getTime()
    const jan31 = new Date('2026-01-31T23:59:59Z').getTime()
    expect(makeNotificationKey('bill-abc', jan1)).toBe(makeNotificationKey('bill-abc', jan31))
  })

  it('same bill different month → different key (re-notifies)', () => {
    const jan = new Date('2026-01-15').getTime()
    const feb = new Date('2026-02-15').getTime()
    expect(makeNotificationKey('bill-abc', jan)).not.toBe(makeNotificationKey('bill-abc', feb))
  })

  it('different bills same month → different keys', () => {
    const ts = new Date('2026-01-15').getTime()
    expect(makeNotificationKey('bill-abc', ts)).not.toBe(makeNotificationKey('bill-xyz', ts))
  })

  it('key format is billId_YYYY-MM', () => {
    const ts = new Date('2026-03-27').getTime()
    expect(makeNotificationKey('my-bill', ts)).toBe('my-bill_2026-03')
  })
})
```

- [ ] **Step 6: Run utils tests**

```bash
cd C:/Users/bryan.GOAT/Downloads/VibeCode
npm run test:utils
```
Expected: 4 tests passing.

- [ ] **Step 7: Commit**

```bash
git add package.json vitest.config.mjs electron/utils.js electron/utils.test.js
git commit -m "feat: add root package.json, Electron utils with makeNotificationKey (4 tests)"
```

---

## Task 7: `electron/preload.js`

**Files:**
- Create: `electron/preload.js`

- [ ] **Step 1: Create `electron/preload.js`**

```js
// electron/preload.js
// Exposes a safe, typed bridge from the main process to the renderer via contextBridge.
// contextIsolation: true — renderer cannot access Node.js or Electron directly.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('inboxmy', {
  // Manually trigger a Windows toast from the renderer
  notify: (title, body) =>
    ipcRenderer.invoke('fire-notification', { title, body }),

  // Receive live bill alert data from the scheduler
  onBillAlert: (cb) =>
    ipcRenderer.on('bill-alert', (_, data) => cb(data)),

  // Deep link: navigate to a specific bill after toast click
  onNavigateToBill: (cb) =>
    ipcRenderer.on('navigate-to-bill', (_, billId) => cb(billId)),

  // Gemini API key — stored encrypted via safeStorage (Windows DPAPI)
  saveGeminiKey: (key) =>
    ipcRenderer.invoke('save-gemini-key', key),
  getGeminiKey: () =>
    ipcRenderer.invoke('get-gemini-key'),

  // Auto-launch at Windows startup toggle
  setAutoLaunch: (enabled) =>
    ipcRenderer.invoke('set-auto-launch', enabled),
  getAutoLaunch: () =>
    ipcRenderer.invoke('get-auto-launch'),
})
```

- [ ] **Step 2: Commit**

```bash
git add electron/preload.js
git commit -m "feat: add electron/preload.js with contextBridge IPC bridge"
```

---

## Task 8: `electron/main.js`

**Files:**
- Create: `electron/main.js`
- Create: `electron/assets/tray-icon.png` (placeholder)
- Create: `electron/assets/icon.png` (placeholder)

- [ ] **Step 1: Create placeholder icon assets**

The icon files must exist for Electron to launch and for electron-builder to package. Generate minimal valid placeholders:

```bash
cd C:/Users/bryan.GOAT/Downloads/VibeCode

node -e "
const fs = require('fs')

// Minimal valid 1x1 red PNG (68 bytes)
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI6QAAAABJRU5ErkJggg==', 'base64')
fs.writeFileSync('electron/assets/tray-icon.png', png)
fs.writeFileSync('electron/assets/icon.png', png)

// Minimal valid ICO file (1x1 pixel) — required by electron-builder NSIS
// ICO header + 1x1 1-bit BMP image — smallest valid .ico accepted by Windows
const ico = Buffer.from([
  0x00,0x00,           // reserved
  0x01,0x00,           // type: 1 = icon
  0x01,0x00,           // image count: 1
  0x01,                // width: 1px
  0x01,                // height: 1px
  0x00,                // color count: 0 (>= 8bpp)
  0x00,                // reserved
  0x01,0x00,           // color planes
  0x20,0x00,           // bits per pixel: 32
  0x28,0x00,0x00,0x00, // size of image data
  0x16,0x00,0x00,0x00, // offset to image data (22 bytes)
  // BITMAPINFOHEADER (40 bytes)
  0x28,0x00,0x00,0x00, // header size
  0x01,0x00,0x00,0x00, // width: 1
  0x02,0x00,0x00,0x00, // height: 2 (XOR + AND mask)
  0x01,0x00,           // color planes: 1
  0x20,0x00,           // bits per pixel: 32
  0x00,0x00,0x00,0x00, // compression: none
  0x08,0x00,0x00,0x00, // image size
  0x00,0x00,0x00,0x00, // x pixels per meter
  0x00,0x00,0x00,0x00, // y pixels per meter
  0x00,0x00,0x00,0x00, // colors in table
  0x00,0x00,0x00,0x00, // important colors
  // pixel data (1 pixel, BGRA: red)
  0x00,0x00,0xff,0xff,
  // AND mask (1 byte padded to 4-byte boundary)
  0x00,0x00,0x00,0x00
])
fs.writeFileSync('electron/assets/icon.ico', ico)

console.log('Assets created: tray-icon.png, icon.png, icon.ico')
"
```

> **Note:** These are minimal placeholder assets. Before shipping, replace them with:
> - `tray-icon.png` — 16×16 PNG with transparent background
> - `icon.png` — 256×256 PNG for notifications
> - `icon.ico` — multi-size ICO (256, 64, 48, 32, 16) for NSIS installer + taskbar
> The NSIS installer (`npm run dist`) will fail if `icon.ico` is missing.

- [ ] **Step 2: Create `electron/main.js`**

```js
// electron/main.js
'use strict'

const {
  app, BrowserWindow, Tray, Menu, Notification,
  nativeImage, net, ipcMain, safeStorage,
} = require('electron')
const path = require('path')
const fs = require('fs')
const { spawn } = require('child_process')
const AutoLaunch = require('electron-auto-launch')
const { makeNotificationKey } = require('./utils.js')

const PORT = 3000
let mainWindow = null
let tray = null
let backendProcess = null

// ── Settings (userData/inboxmy-settings.json) ─────────────────────────────────

function getSettingsPath() {
  return path.join(app.getPath('userData'), 'inboxmy-settings.json')
}

function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(getSettingsPath(), 'utf8'))
  } catch {
    return {}
  }
}

function saveSettings(settings) {
  fs.writeFileSync(getSettingsPath(), JSON.stringify(settings, null, 2))
}

// ── Notified bills deduplication (userData/notified.json) ─────────────────────

function getNotifiedPath() {
  return path.join(app.getPath('userData'), 'notified.json')
}

function loadNotified() {
  try {
    return JSON.parse(fs.readFileSync(getNotifiedPath(), 'utf8'))
  } catch {
    return {}
  }
}

function saveNotified(notified) {
  fs.writeFileSync(getNotifiedPath(), JSON.stringify(notified))
}

// ── Taskbar badge (Windows: setOverlayIcon, not setBadgeCount) ────────────────

function setWindowsBadge(win, count) {
  if (!win || win.isDestroyed()) return
  if (count === 0) {
    win.setOverlayIcon(null, '')
    return
  }
  // Generate a small red circle badge with count (max "9+")
  const label = count > 9 ? '9+' : String(count)
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16">
    <circle cx="8" cy="8" r="8" fill="#e8402a"/>
    <text x="8" y="12" text-anchor="middle" font-family="Arial" font-size="${label.length > 1 ? 8 : 10}" font-weight="bold" fill="white">${label}</text>
  </svg>`
  const img = nativeImage.createFromDataURL(
    'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64')
  )
  win.setOverlayIcon(img, `${count} bill alert${count > 1 ? 's' : ''}`)
}

// ── Backend spawn ─────────────────────────────────────────────────────────────

function startBackend() {
  return new Promise((resolve, reject) => {
    const backendDir = path.join(__dirname, '../inboxmy-backend')
    const serverScript = path.join(backendDir, 'dist/server.js')

    backendProcess = spawn(process.execPath, [serverScript], {
      cwd: backendDir,
      env: { ...process.env, DATA_DIR: path.join(app.getPath('userData'), 'data') },
      stdio: ['ignore', 'inherit', 'inherit'],
    })

    backendProcess.on('error', reject)

    // Poll /health every 500ms — give up after 20s (40 attempts)
    let attempts = 0
    const timer = setInterval(() => {
      attempts++
      if (attempts > 40) {
        clearInterval(timer)
        return reject(new Error('Backend did not start within 20s'))
      }

      const req = net.request(`http://localhost:${PORT}/health`)
      req.on('response', res => {
        if (res.statusCode === 200) {
          clearInterval(timer)
          resolve()
        }
      })
      req.on('error', () => {}) // not ready yet, ignore
      req.end()
    }, 500)
  })
}

// ── BrowserWindow ─────────────────────────────────────────────────────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      webSecurity: true,
      nodeIntegration: false,
    },
    show: false,
    title: 'InboxMY',
  })

  mainWindow.loadURL(`http://localhost:${PORT}`)

  mainWindow.once('ready-to-show', () => {
    mainWindow.show()
  })

  // BlueMail-style: close → hide to tray, not quit
  mainWindow.on('close', event => {
    if (!app.isQuitting) {
      event.preventDefault()
      mainWindow.hide()
    }
  })
}

// ── System tray ───────────────────────────────────────────────────────────────

function createTray() {
  const iconPath = path.join(__dirname, 'assets/tray-icon.png')
  tray = new Tray(iconPath)
  tray.setToolTip('InboxMY')

  const menu = Menu.buildFromTemplate([
    {
      label: 'Open InboxMY',
      click: () => { mainWindow.show(); mainWindow.focus() },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        app.isQuitting = true
        if (backendProcess) backendProcess.kill()
        app.exit(0)
      },
    },
  ])

  tray.setContextMenu(menu)
  tray.on('click', () => { mainWindow.show(); mainWindow.focus() })
}

// ── IPC handlers ──────────────────────────────────────────────────────────────

function setupIPC() {
  // Manual notification trigger from renderer
  ipcMain.handle('fire-notification', (_, { title, body }) => {
    new Notification({ title, body }).show()
  })

  // Gemini key — stored encrypted via safeStorage (Windows DPAPI)
  ipcMain.handle('save-gemini-key', (_, key) => {
    const settings = loadSettings()
    settings.geminiKeyEnc = safeStorage.encryptString(key).toString('base64')
    saveSettings(settings)
  })

  ipcMain.handle('get-gemini-key', () => {
    const settings = loadSettings()
    if (!settings.geminiKeyEnc) return null
    try {
      return safeStorage.decryptString(Buffer.from(settings.geminiKeyEnc, 'base64'))
    } catch {
      return null
    }
  })

  // Auto-launch toggle
  const autoLauncher = new AutoLaunch({ name: 'InboxMY' })

  ipcMain.handle('set-auto-launch', async (_, enabled) => {
    const settings = loadSettings()
    settings.autoLaunch = enabled
    saveSettings(settings)
    if (enabled) {
      await autoLauncher.enable()
    } else {
      await autoLauncher.disable()
    }
  })

  ipcMain.handle('get-auto-launch', () => {
    const settings = loadSettings()
    return settings.autoLaunch ?? false
  })
}

// ── Notification scheduler ────────────────────────────────────────────────────

function makeRequest(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const req = net.request({
      method,
      url: `http://localhost:${PORT}${urlPath}`,
      session: mainWindow.webContents.session, // must be explicit — main process net does not inherit renderer session
    })

    req.setHeader('Content-Type', 'application/json')

    let data = ''
    req.on('response', res => {
      if (res.statusCode === 401) {
        console.log('[scheduler] skipped tick — not authenticated')
        resolve(null)
        return
      }
      res.on('data', chunk => { data += chunk })
      res.on('end', () => {
        try { resolve(JSON.parse(data)) } catch { resolve(null) }
      })
    })
    req.on('error', reject)

    if (body) req.write(JSON.stringify(body))
    req.end()
  })
}

async function runSchedulerTick() {
  try {
    // 1. Auto-mark overdue
    const markResult = await makeRequest('PATCH', '/api/bills/auto-mark-overdue', {})
    if (markResult === null) return // 401 — not logged in

    // 2. Fetch due-soon bills
    const dueSoonResult = await makeRequest('GET', '/api/notifications/due-soon', null)
    if (!dueSoonResult) return

    const bills = dueSoonResult.bills ?? []

    // Update taskbar badge (even if no bills — clears badge)
    setWindowsBadge(mainWindow, bills.length)

    if (!bills.length) {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('bill-alert', { bills: [] })
      }
      return
    }

    // 3. Try to get AI copy
    let notifications = null
    const settings = loadSettings()
    if (settings.geminiKeyEnc && safeStorage.isEncryptionAvailable()) {
      try {
        const geminiKey = safeStorage.decryptString(
          Buffer.from(settings.geminiKeyEnc, 'base64')
        )
        const billsForAI = bills.map(b => ({
          id: b.id,
          biller: b.biller,
          amountRm: b.amount_rm,
          dueDateMs: b.due_date,
          status: b.status,
          daysUntilDue: b.due_date
            ? Math.round((b.due_date - Date.now()) / 86_400_000)
            : 0,
        }))
        notifications = await makeRequest('POST', '/api/notifications/ai-summary', {
          bills: billsForAI,
          geminiKey,
        })
      } catch (err) {
        console.error('[scheduler] AI summary failed:', err)
      }
    }

    // Fallback: plain copy if AI failed or no key
    if (!Array.isArray(notifications)) {
      notifications = bills.map(b => ({
        billId: b.id,
        shouldNotify: true,
        title: `${b.biller} — ${b.status === 'overdue' ? 'Overdue' : 'Due soon'}`.slice(0, 60),
        body: b.amount_rm
          ? `RM${Number(b.amount_rm).toFixed(2)} ${b.status === 'overdue' ? 'is unpaid' : 'due soon'}`.slice(0, 120)
          : '',
      }))
    }

    // 4. Fire toast for each unseen bill
    const notified = loadNotified()
    const now = Date.now()
    let fired = 0

    for (const n of notifications) {
      if (!n.shouldNotify) continue

      const key = makeNotificationKey(n.billId, now)
      if (notified[key]) continue

      const billId = n.billId
      const notification = new Notification({
        title: n.title,
        body: n.body,
        icon: path.join(__dirname, 'assets/icon.png'),
        actions: [{ type: 'button', text: 'View Bill' }],
        closeButtonText: 'Dismiss',
      })

      notification.on('action', () => {
        mainWindow.show()
        mainWindow.focus()
        mainWindow.webContents.send('navigate-to-bill', billId)
      })

      notification.show()
      notified[key] = true
      fired++
    }

    if (fired > 0) saveNotified(notified)

    // 5. Send live update to renderer (updates banner if window is open)
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('bill-alert', { bills })
    }

  } catch (err) {
    console.error('[scheduler] tick error:', err)
  }
}

function startScheduler() {
  // Fire 30s after launch (give user time to log in), then every 60 min
  setTimeout(() => {
    runSchedulerTick()
    setInterval(runSchedulerTick, 60 * 60 * 1000)
  }, 30_000)
}

// ── App lifecycle ─────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  try {
    await startBackend()
    console.log('[main] Backend ready')

    createWindow()
    createTray()
    setupIPC()

    // Auto-launch: sync with saved preference
    const settings = loadSettings()
    const autoLauncher = new AutoLaunch({ name: 'InboxMY' })
    if (settings.autoLaunch) {
      await autoLauncher.enable()
    } else {
      await autoLauncher.disable().catch(() => {}) // may not be registered yet
    }

    startScheduler()
  } catch (err) {
    console.error('[main] Failed to start InboxMY:', err)
    app.exit(1)
  }
})

// Prevent quitting when all windows are closed (tray app)
app.on('window-all-closed', () => {
  // intentionally empty
})

app.on('before-quit', () => {
  app.isQuitting = true
  if (backendProcess) {
    backendProcess.kill()
  }
})
```

- [ ] **Step 3: Commit**

```bash
git add electron/main.js electron/assets/tray-icon.png electron/assets/icon.png
git commit -m "feat: add electron/main.js — BrowserWindow, tray, scheduler, IPC"
```

---

## Task 9: Frontend — Overdue banner

**Files:**
- Modify: `frontend/index.html`
- Modify: `frontend/app.js`

- [ ] **Step 1: Add overdue banner CSS to `frontend/index.html`**

Find the `/* RIGHT PANEL */` CSS section in `frontend/index.html` and add before it:
```css
/* OVERDUE BANNER */
.overdue-banner{display:flex;align-items:center;gap:8px;padding:10px 14px;background:var(--coral-bg);border-bottom:1px solid rgba(232,64,42,.2);font-size:12px;color:var(--ink2);flex-shrink:0}
.ob-icon{color:var(--coral);font-size:14px;flex-shrink:0}
.ob-text{flex:1;line-height:1.4}
.ob-view{padding:3px 10px;border-radius:5px;border:1px solid var(--coral);background:transparent;color:var(--coral);font-size:11px;font-weight:600;cursor:pointer;font-family:var(--sans);white-space:nowrap}
.ob-view:hover{background:var(--coral-bg)}
.ob-dismiss{background:none;border:none;color:var(--ink4);font-size:18px;cursor:pointer;padding:0 2px;line-height:1;flex-shrink:0}
.ob-dismiss:hover{color:var(--ink2)}
```

- [ ] **Step 2: Add overdue banner + AI settings HTML to `frontend/index.html`**

The overdue banner is injected dynamically by JS (no static HTML needed in right-panel). Add the AI Notifications section to the Settings modal. Find the closing `</div>` of the "Danger zone" section and add before the closing `</div>` of `.modal-body` (around line 509):

```html
      <div style="margin-top:24px;border-top:1px solid var(--border);padding-top:20px">
        <div class="modal-section-label">AI Notifications</div>
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
          <label style="font-size:12px;color:var(--ink2);font-weight:500;width:110px;flex-shrink:0">Gemini API Key</label>
          <input type="password" id="gemini-key-input" placeholder="Paste your Gemini API key…"
            style="flex:1;padding:6px 10px;border:1px solid var(--border);border-radius:7px;font-size:12px;font-family:var(--sans);color:var(--ink);background:var(--cream);outline:none">
          <button onclick="saveGeminiKey()" style="padding:6px 14px;border-radius:7px;background:var(--coral);color:#fff;border:none;font-size:12px;font-weight:600;cursor:pointer;font-family:var(--sans)">Save</button>
        </div>
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
          <label style="font-size:12px;color:var(--ink2);font-weight:500;width:110px;flex-shrink:0">Status</label>
          <span id="gemini-status" style="font-size:12px;color:var(--ink4)">Checking…</span>
        </div>
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
          <label style="font-size:12px;color:var(--ink2);font-weight:500;width:110px;flex-shrink:0">Launch at startup</label>
          <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
            <input type="checkbox" id="auto-launch-toggle" onchange="toggleAutoLaunch(this.checked)"
              style="width:14px;height:14px;accent-color:var(--coral)">
            <span style="font-size:12px;color:var(--ink3)">Start InboxMY with Windows</span>
          </label>
        </div>
        <div style="font-size:11px;color:var(--ink4);margin-top:4px">
          Get a free Gemini key at <a href="https://aistudio.google.com" target="_blank" style="color:var(--teal)">aistudio.google.com</a>
        </div>
      </div>
```

- [ ] **Step 3: Add banner logic to `frontend/app.js`**

Add these functions. Place them just before the `// ── SETTINGS MODAL` section (around line 808):

```js
// ── OVERDUE BANNER ─────────────────────────────────────────────────────────────
function renderOverdueBanner(bills) {
  const existing = document.getElementById('overdue-banner');
  if (existing) existing.remove();

  if (sessionStorage.getItem('overdue-banner-dismissed')) return;

  const overdue = bills.filter(b => b.status === 'overdue');
  if (!overdue.length) return;

  const total = overdue.reduce((sum, b) => sum + (b.amount_rm || 0), 0);
  const n = overdue.length;

  const banner = document.createElement('div');
  banner.id = 'overdue-banner';
  banner.className = 'overdue-banner';
  banner.innerHTML = `
    <span class="ob-icon">⚠</span>
    <span class="ob-text">You have <strong>${n}</strong> overdue bill${n > 1 ? 's' : ''} — Total <strong>RM${total.toFixed(2)}</strong></span>
    <button class="ob-view" onclick="setFolder('bills', document.getElementById('folder-bills'))">View all</button>
    <button class="ob-dismiss" onclick="dismissOverdueBanner()">×</button>
  `;

  const rightPanel = document.getElementById('right-panel');
  if (rightPanel) rightPanel.insertBefore(banner, rightPanel.firstChild);
}

function dismissOverdueBanner() {
  sessionStorage.setItem('overdue-banner-dismissed', '1');
  const banner = document.getElementById('overdue-banner');
  if (banner) banner.remove();
}
```

- [ ] **Step 4: Call `renderOverdueBanner` from `loadBills`**

In `frontend/app.js`, find `loadBills()` (around line 612). After `renderBillsPanel(bills, orders)` add:
```js
    renderOverdueBanner(bills);
```

The updated `loadBills` try block should end with:
```js
    renderBillsPanel(bills, orders);
    renderOverdueBanner(bills);
```

- [ ] **Step 5: Commit**

```bash
git add frontend/index.html frontend/app.js
git commit -m "feat: add overdue bill banner in right panel (dismissible per session)"
```

---

## Task 10: Frontend — Settings AI section + deep link handler

**Files:**
- Modify: `frontend/app.js`

- [ ] **Step 1: Add AI Settings functions to `app.js`**

Add these functions to the `// ── SETTINGS MODAL` section (after `closeSettings()`):

```js
// ── AI NOTIFICATIONS (Electron IPC) ───────────────────────────────────────────
async function loadAISettings() {
  if (!window.inboxmy) return; // not running in Electron

  const geminiStatusEl = document.getElementById('gemini-status');
  const geminiInput = document.getElementById('gemini-key-input');
  const autoLaunchToggle = document.getElementById('auto-launch-toggle');

  // Load Gemini key status
  const key = await window.inboxmy.getGeminiKey();
  if (geminiStatusEl) {
    if (key) {
      geminiStatusEl.innerHTML = '<span style="color:var(--green)">● Active</span>';
      if (geminiInput) geminiInput.placeholder = '••••••••••••••••';
    } else {
      geminiStatusEl.innerHTML = '<span style="color:var(--ink4)">○ Not configured</span>';
    }
  }

  // Load auto-launch state
  const autoLaunch = await window.inboxmy.getAutoLaunch();
  if (autoLaunchToggle) autoLaunchToggle.checked = autoLaunch;
}

async function saveGeminiKey() {
  if (!window.inboxmy) return;
  const input = document.getElementById('gemini-key-input');
  if (!input || !input.value.trim()) {
    showToast('Please enter a Gemini API key');
    return;
  }
  await window.inboxmy.saveGeminiKey(input.value.trim());
  input.value = '';
  await loadAISettings();
  showToast('Gemini key saved!');
}

async function toggleAutoLaunch(enabled) {
  if (!window.inboxmy) return;
  await window.inboxmy.setAutoLaunch(enabled);
  showToast(enabled ? 'InboxMY will launch at startup' : 'Auto-launch disabled');
}
```

- [ ] **Step 2: Call `loadAISettings()` from `openSettings()`**

Find `function openSettings()` (around line 809):
```js
function openSettings() {
  document.getElementById('profile-dropdown').classList.remove('open');
  renderSettingsAccounts();
  loadAISettings(); // load Gemini key + auto-launch state
  document.getElementById('settings-modal').classList.add('open');
}
```

- [ ] **Step 3: Add Electron deep link + bill-alert handler**

Add at the end of `frontend/app.js` (after all existing code, before the closing of any IIFE if present, or just at the end):

```js
// ── ELECTRON INTEGRATION ───────────────────────────────────────────────────────
if (window.inboxmy) {
  // Deep link: navigate to a specific bill when user clicks "View Bill" on a toast
  window.inboxmy.onNavigateToBill(function(billId) {
    setFolder('bills', document.getElementById('folder-bills'));
    // Give the bills panel time to render, then scroll to + highlight the bill
    setTimeout(function() {
      const el = document.querySelector('[data-bill-id="' + billId + '"]');
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.style.transition = 'background 0.3s';
        el.style.background = 'var(--amber-bg)';
        setTimeout(function() { el.style.background = ''; }, 2000);
      }
    }, 300);
  });

  // Live bill alert from scheduler — refresh banner without full page reload
  window.inboxmy.onBillAlert(function(data) {
    if (data && data.bills) {
      renderOverdueBanner(data.bills);
    }
  });
}
```

- [ ] **Step 4: Add `data-bill-id` attribute to bill rows in `renderBillsPanel`**

For the deep link to work, bill rows need a `data-bill-id` attribute. In `frontend/app.js`, find `renderBillsPanel` (around line 644). Inside the bills loop, find the line:
```js
el.className = 'bill-item'
```
Immediately after it (before `el.innerHTML = ...`), add:
```js
el.setAttribute('data-bill-id', b.id)
```

> **Important:** The outer `<div class="bill-item">` is created with `document.createElement('div')`, not via an innerHTML string — so the attribute must be set with `setAttribute`, not embedded in a template literal. Do not try to add it inside `el.innerHTML`.

- [ ] **Step 5: Run full backend tests to confirm nothing broken**

```bash
cd inboxmy-backend
$env:ENCRYPTION_KEY="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
$env:DATA_DIR="./data-test"
npm test
```
Expected: 104+ tests passing.

- [ ] **Step 6: Commit**

```bash
git add frontend/app.js frontend/index.html
git commit -m "feat: add AI settings IPC, auto-launch toggle, deep link handler in frontend"
```

---

## Task 11: README + SETUP update + final verification

**Files:**
- Modify: `README.md`
- Modify: `SETUP.md`

- [ ] **Step 1: Update README.md**

Replace the entire README. Key changes from the current version:
- Change "How to Run" to Electron-first (`npm install` at root, `npm run electron:dev`)
- Update test table with Plan 6 test files
- Update Roadmap — mark Plan 6 as ✅ Done
- Add "Business Model" section
- Remove all references to `node server.js` and `cd inboxmy-backend && npm start` as primary run method
- Update "What's Built" table with Electron shell and AI notifier rows
- Update "Next Session Prompt" with Plan 6 completion status

The new "How to run" section should be:
```markdown
## How to Run

### Development (Electron + live backend reload)

```powershell
# From the repo root (VibeCode/)
npm install          # first time only
npm run electron:dev # starts backend + Electron window
```

### Build Windows installer

```powershell
npm run dist
# Creates dist/InboxMY Setup 0.6.0.exe
```

### Backend only (no Electron — for API testing)

```powershell
cd inboxmy-backend
$env:ENCRYPTION_KEY="..."
$env:DATA_DIR="./data-test"
npm run dev   # tsx watch — hot reload
```
```

- [ ] **Step 2: Update SETUP.md — add AI Notifications section**

Add at the end of SETUP.md before any existing "Next steps" section:

```markdown
## AI Notifications (Optional)

InboxMY uses Gemini 2.0 Flash to write smart Windows notification copy for your bills.
This is optional — if you skip this step, notifications will use plain text copy instead.

1. Go to [aistudio.google.com](https://aistudio.google.com) and sign in with your Google account
2. Click **Create API key** → choose a project → copy the key
3. Open InboxMY → click your avatar → **Settings** → scroll to **AI Notifications**
4. Paste the key into the **Gemini API Key** field → click **Save**
5. Status changes to **● Active** — notifications will use AI copy on the next scheduler tick (every 60 min)

Your Gemini API key is stored encrypted on your Windows account using Windows DPAPI.
It is never sent anywhere except directly to the Gemini API when a notification is being generated.

The Gemini free tier (15 requests/minute) is more than sufficient for personal use.
```

- [ ] **Step 3: Run full backend test suite one final time**

```bash
cd inboxmy-backend
$env:ENCRYPTION_KEY="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
$env:DATA_DIR="./data-test"
npm test
```
Expected: **105+ tests passing** in the backend suite (88 previous + 12 notification route tests + 5 notifier tests). This counts only `inboxmy-backend` tests.

Combined total across all test suites (backend + utils): **109+ tests**.

- [ ] **Step 4: Run utils tests**

```bash
cd C:/Users/bryan.GOAT/Downloads/VibeCode
npm run test:utils
```
Expected: 4 tests passing.

- [ ] **Step 5: Final commit**

```bash
git add README.md SETUP.md
git commit -m "docs: update README and SETUP for Electron + AI notifications (Plan 6 complete)"
```

---

## Test Summary

| File | Tests | What they cover |
|---|---|---|
| `inboxmy-backend/tests/routes/notifications.test.ts` | 12 | auto-mark-overdue (6 incl. boundary) + due-soon (6) |
| `inboxmy-backend/tests/ai/notifier.test.ts` | 5 | Gemini success, suppress, fallback × 3 |
| `electron/utils.test.js` | 4 | makeNotificationKey deduplication |
| All previous tests | 88 | Unchanged |
| **Total** | **109+** | |

---

## Manual Verification Checklist (after running `npm run electron:dev`)

- [ ] Electron window opens and loads the InboxMY dashboard
- [ ] Closing the window hides it (does not quit); tray icon visible
- [ ] Tray icon right-click shows "Open InboxMY" / "Quit"
- [ ] Settings → AI Notifications section visible
- [ ] Paste a Gemini key → Save → status shows "● Active"
- [ ] Launch at startup toggle can be toggled on/off
- [ ] Seed a bill with `due_date = Date.now() - 1000` and `status = 'unpaid'` in the DB, wait 30s → toast fires + banner appears
- [ ] Click "View Bill" on toast → window opens + navigates to Bills folder
- [ ] Dismiss overdue banner → does not reappear until page reload

---

## Out of Scope (Future Plans)

- Real-time push sync (Gmail Pub/Sub, Outlook Graph webhooks) → Plan 7
- InboxMY Premium subscription + hosted AI proxy → Plan 8
- Settings sync across devices → Plan 9
- macOS / Linux support
- E2E Electron tests (Playwright/Spectron)
