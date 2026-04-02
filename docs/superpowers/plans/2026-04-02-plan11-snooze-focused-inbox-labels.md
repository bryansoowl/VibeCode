# Plan 11: Snooze + Focused Inbox + Smart Groups (Labels) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Gmail-style snooze, focused inbox, and user-created labels (with right-click context menu) to InboxMY.

**Architecture:** Migration 7 adds `snoozed_until` column on `emails`, a `labels` table, and an `email_labels` junction table. New `src/routes/labels.ts` handles label CRUD. `src/routes/emails.ts` gains snooze endpoints, `POST /api/emails/unsnooze-due` (called by Electron every 60s), and label-related query extensions. The frontend gains a right-click context menu with snooze/move/label submenus, plus Focused and Snoozed sidebar entries and a dynamic Labels section.

**Tech Stack:** TypeScript + Express + better-sqlite3 (backend), Vanilla JS (frontend), Zod (validation), Vitest + supertest (tests)

**Spec:** `docs/superpowers/specs/2026-04-02-plan11-snooze-focused-inbox-smart-groups-design.md`

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Modify | `inboxmy-backend/src/db/migrations.ts` | Add Migration 7: snoozed_until, labels, email_labels |
| **Create** | `inboxmy-backend/src/routes/labels.ts` | CRUD for labels + label assignment on emails |
| Modify | `inboxmy-backend/src/routes/emails.ts` | Snooze endpoints, unsnooze-due, snooze filter on GET, mark-unread support, labelId param, labels in response, unread-count fix |
| Modify | `inboxmy-backend/src/server.ts` | Register unsnoozeDueRouter and labelsRouter |
| Modify | `electron/main.js` | Call POST /api/emails/unsnooze-due in runSyncTick |
| **Create** | `inboxmy-backend/tests/routes/labels.test.ts` | Labels CRUD tests |
| **Create** | `inboxmy-backend/tests/routes/snooze.test.ts` | Snooze endpoint tests |
| **Create** | `inboxmy-backend/tests/routes/email-labels.test.ts` | Email-label assignment tests |
| Modify | `inboxmy-backend/tests/routes/emails.test.ts` | labelId filter + labels field in response |
| Modify | `frontend/app.js` | Context menu, snooze submenu, label submenu, sidebar additions |
| Modify | `frontend/index.html` | Context menu HTML, sidebar Focused/Snoozed/Labels entries |

---

## Task 1: Migration 7 — DB Schema

**Files:**
- Modify: `inboxmy-backend/src/db/migrations.ts:80` (append to MIGRATIONS array)

> No unit test needed — migrations run automatically on DB initialisation and are exercised by every test that calls `getDb()`.

- [ ] **Step 1: Add Migration 7 to the MIGRATIONS array**

In `src/db/migrations.ts`, append a 7th entry to the `MIGRATIONS` array (after the last `'ALTER TABLE accounts ADD COLUMN gmail_history_id TEXT;'` entry):

```typescript
  // Migration 7: snooze, labels, email-label junction
  `
  ALTER TABLE emails ADD COLUMN snoozed_until INTEGER;
  CREATE INDEX IF NOT EXISTS idx_emails_snoozed ON emails(snoozed_until)
    WHERE snoozed_until IS NOT NULL;
  CREATE TABLE IF NOT EXISTS labels (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    color      TEXT NOT NULL DEFAULT '#6B7280',
    created_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_labels_user_name ON labels(user_id, name);
  CREATE INDEX IF NOT EXISTS idx_labels_user ON labels(user_id);
  CREATE TABLE IF NOT EXISTS email_labels (
    email_id  TEXT NOT NULL REFERENCES emails(id) ON DELETE CASCADE,
    label_id  TEXT NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
    PRIMARY KEY (email_id, label_id)
  );
  CREATE INDEX IF NOT EXISTS idx_email_labels_label ON email_labels(label_id);
  `,
```

- [ ] **Step 2: Verify migration runs cleanly**

```powershell
cd inboxmy-backend
$env:ENCRYPTION_KEY="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
$env:DATA_DIR="./data-test"
npx tsx -e "import('./src/db').then(m => { m.getDb(); m.closeDb(); console.log('Migration 7 OK') })"
```

Expected: `Migration 7 OK` with no errors.

- [ ] **Step 3: Commit**

```bash
git add inboxmy-backend/src/db/migrations.ts
git commit -m "feat(db): add migration 7 — snoozed_until, labels, email_labels"
```

---

## Task 2: Labels CRUD — Tests (RED)

**Files:**
- **Create**: `inboxmy-backend/tests/routes/labels.test.ts`

- [ ] **Step 1: Create the failing test file**

```typescript
// tests/routes/labels.test.ts
import { describe, it, expect, afterAll } from 'vitest'
import request from 'supertest'
import { app } from '../../src/server'
import { getDb, closeDb } from '../../src/db'
import { randomUUID } from 'crypto'
import { encryptSystem } from '../../src/crypto'
import { createTestUser } from '../helpers/auth'

afterAll(() => closeDb())

function seedAccount(userId: string) {
  const id = randomUUID()
  getDb().prepare(
    `INSERT OR IGNORE INTO accounts (id, provider, email, token_enc, created_at, user_id)
     VALUES (?, 'gmail', ?, ?, ?, ?)`
  ).run(id, `${id}@label-test.com`, encryptSystem('{}'), Date.now(), userId)
  return id
}

function seedEmail(userId: string, accountId: string) {
  const id = randomUUID()
  getDb().prepare(
    `INSERT INTO emails (id, account_id, subject_enc, sender, received_at, is_read, folder, tab)
     VALUES (?, ?, ?, ?, ?, 0, 'inbox', 'primary')`
  ).run(id, accountId, encryptSystem('Subject'), 'from@test.com', Date.now())
  return id
}

describe('GET /api/labels', () => {
  it('returns empty array when user has no labels', async () => {
    const { agent } = await createTestUser()
    const res = await agent.get('/api/labels')
    expect(res.status).toBe(200)
    expect(res.body).toEqual([])
  })

  it('returns 401 without session', async () => {
    const res = await request(app).get('/api/labels')
    expect(res.status).toBe(401)
  })

  it('returns labels with count field', async () => {
    const { agent, id: userId } = await createTestUser()
    const accountId = seedAccount(userId)
    const emailId = seedEmail(userId, accountId)
    // Create label
    const create = await agent.post('/api/labels').send({ name: 'Work', color: '#3B82F6' })
    expect(create.status).toBe(201)
    const labelId = create.body.id
    // Assign to email
    await agent.post(`/api/emails/${emailId}/labels/${labelId}`)
    // List
    const res = await agent.get('/api/labels')
    expect(res.status).toBe(200)
    expect(res.body).toHaveLength(1)
    expect(res.body[0].count).toBe(1)
    expect(res.body[0].name).toBe('Work')
    expect(res.body[0].color).toBe('#3B82F6')
  })
})

describe('POST /api/labels', () => {
  it('creates a label with name and default color', async () => {
    const { agent } = await createTestUser()
    const res = await agent.post('/api/labels').send({ name: 'Finance' })
    expect(res.status).toBe(201)
    expect(res.body.id).toBeDefined()
    expect(res.body.name).toBe('Finance')
    expect(res.body.color).toBe('#6B7280')
  })

  it('creates a label with custom color', async () => {
    const { agent } = await createTestUser()
    const res = await agent.post('/api/labels').send({ name: 'Urgent', color: '#EF4444' })
    expect(res.status).toBe(201)
    expect(res.body.color).toBe('#EF4444')
  })

  it('returns 400 when name exceeds 50 chars', async () => {
    const { agent } = await createTestUser()
    const res = await agent.post('/api/labels').send({ name: 'x'.repeat(51) })
    expect(res.status).toBe(400)
  })

  it('returns 400 when color is not a valid hex', async () => {
    const { agent } = await createTestUser()
    const res = await agent.post('/api/labels').send({ name: 'Test', color: 'red' })
    expect(res.status).toBe(400)
  })

  it('returns 409 for duplicate name within same user', async () => {
    const { agent } = await createTestUser()
    await agent.post('/api/labels').send({ name: 'Dup' })
    const res = await agent.post('/api/labels').send({ name: 'Dup' })
    expect(res.status).toBe(409)
  })

  it('two different users can have labels with same name', async () => {
    const { agent: a1 } = await createTestUser()
    const { agent: a2 } = await createTestUser()
    const r1 = await a1.post('/api/labels').send({ name: 'Shared' })
    const r2 = await a2.post('/api/labels').send({ name: 'Shared' })
    expect(r1.status).toBe(201)
    expect(r2.status).toBe(201)
  })
})

describe('PATCH /api/labels/:id', () => {
  it('renames a label', async () => {
    const { agent } = await createTestUser()
    const { body: { id } } = await agent.post('/api/labels').send({ name: 'Old' })
    const res = await agent.patch(`/api/labels/${id}`).send({ name: 'New' })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    const row = getDb().prepare('SELECT name FROM labels WHERE id = ?').get(id) as any
    expect(row.name).toBe('New')
  })

  it('recolors a label', async () => {
    const { agent } = await createTestUser()
    const { body: { id } } = await agent.post('/api/labels').send({ name: 'Colorful' })
    const res = await agent.patch(`/api/labels/${id}`).send({ color: '#10B981' })
    expect(res.status).toBe(200)
    const row = getDb().prepare('SELECT color FROM labels WHERE id = ?').get(id) as any
    expect(row.color).toBe('#10B981')
  })

  it('returns 404 when label belongs to another user', async () => {
    const { id: userId1 } = await createTestUser()
    const labelId = randomUUID()
    getDb().prepare(
      `INSERT INTO labels (id, user_id, name, color, created_at) VALUES (?, ?, ?, ?, ?)`
    ).run(labelId, userId1, 'User1Label', '#6B7280', Date.now())
    const { agent: agent2 } = await createTestUser()
    const res = await agent2.patch(`/api/labels/${labelId}`).send({ name: 'Hijack' })
    expect(res.status).toBe(404)
  })
})

describe('DELETE /api/labels/:id', () => {
  it('deletes a label', async () => {
    const { agent } = await createTestUser()
    const { body: { id } } = await agent.post('/api/labels').send({ name: 'ToDelete' })
    const res = await agent.delete(`/api/labels/${id}`)
    expect(res.status).toBe(200)
    const row = getDb().prepare('SELECT id FROM labels WHERE id = ?').get(id)
    expect(row).toBeUndefined()
  })

  it('cascades to email_labels on delete', async () => {
    const { agent, id: userId } = await createTestUser()
    const accountId = seedAccount(userId)
    const emailId = seedEmail(userId, accountId)
    const { body: { id: labelId } } = await agent.post('/api/labels').send({ name: 'CascadeTest' })
    await agent.post(`/api/emails/${emailId}/labels/${labelId}`)
    // Confirm assignment exists
    const before = getDb().prepare('SELECT * FROM email_labels WHERE label_id = ?').all(labelId)
    expect(before).toHaveLength(1)
    // Delete label
    await agent.delete(`/api/labels/${labelId}`)
    // Junction row should be gone
    const after = getDb().prepare('SELECT * FROM email_labels WHERE label_id = ?').all(labelId)
    expect(after).toHaveLength(0)
  })

  it('returns 404 when label belongs to another user', async () => {
    const { id: userId1 } = await createTestUser()
    const labelId = randomUUID()
    getDb().prepare(
      `INSERT INTO labels (id, user_id, name, color, created_at) VALUES (?, ?, ?, ?, ?)`
    ).run(labelId, userId1, 'Protected', '#6B7280', Date.now())
    const { agent: agent2 } = await createTestUser()
    const res = await agent2.delete(`/api/labels/${labelId}`)
    expect(res.status).toBe(404)
  })
})
```

- [ ] **Step 2: Run to confirm RED**

```powershell
cd inboxmy-backend
$env:ENCRYPTION_KEY="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
$env:DATA_DIR="./data-test"
npx vitest run tests/routes/labels.test.ts
```

Expected: all tests fail (404 — routes not registered yet).

---

## Task 3: Labels CRUD — Implementation (GREEN)

**Files:**
- **Create**: `inboxmy-backend/src/routes/labels.ts`
- Modify: `inboxmy-backend/src/server.ts`

- [ ] **Step 1: Create `src/routes/labels.ts`**

```typescript
// src/routes/labels.ts
import { Router, type Request, type Response } from 'express'
import { z } from 'zod'
import { randomUUID } from 'crypto'
import { getDb } from '../db'

export const labelsRouter = Router()

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/

const createBody = z.object({
  name:  z.string().min(1).max(50),
  color: z.string().regex(HEX_COLOR).optional(),
})

const patchBody = z.object({
  name:  z.string().min(1).max(50).optional(),
  color: z.string().regex(HEX_COLOR).optional(),
})

// GET /api/labels — list user's labels with email count
labelsRouter.get('/', (req: Request, res: Response) => {
  const user = (req as any).user
  const rows = getDb().prepare(`
    SELECT l.id, l.name, l.color,
      (SELECT COUNT(*) FROM email_labels el
       JOIN emails e ON e.id = el.email_id
       JOIN accounts a ON a.id = e.account_id
       WHERE el.label_id = l.id AND a.user_id = ?) as count
    FROM labels l
    WHERE l.user_id = ?
    ORDER BY l.created_at ASC
  `).all(user.id, user.id)
  res.json(rows)
})

// POST /api/labels — create label
labelsRouter.post('/', (req: Request, res: Response) => {
  const parsed = createBody.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })

  const user = (req as any).user
  const db = getDb()
  const { name, color = '#6B7280' } = parsed.data
  const id = randomUUID()

  // Check for duplicate name within this user
  const existing = db.prepare('SELECT id FROM labels WHERE user_id = ? AND name = ?').get(user.id, name)
  if (existing) return res.status(409).json({ error: 'Label name already exists' })

  db.prepare(
    'INSERT INTO labels (id, user_id, name, color, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(id, user.id, name, color, Date.now())

  res.status(201).json({ id, name, color })
})

// PATCH /api/labels/:id — rename / recolor
labelsRouter.patch('/:id', (req: Request, res: Response) => {
  const parsed = patchBody.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })

  const user = (req as any).user
  const db = getDb()
  const label = db.prepare('SELECT id FROM labels WHERE id = ? AND user_id = ?').get(req.params.id, user.id)
  if (!label) return res.status(404).json({ error: 'Label not found' })

  const { name, color } = parsed.data
  if (name !== undefined) db.prepare('UPDATE labels SET name = ? WHERE id = ?').run(name, req.params.id)
  if (color !== undefined) db.prepare('UPDATE labels SET color = ? WHERE id = ?').run(color, req.params.id)

  res.json({ ok: true })
})

// DELETE /api/labels/:id — delete label (cascades to email_labels)
labelsRouter.delete('/:id', (req: Request, res: Response) => {
  const user = (req as any).user
  const db = getDb()
  const result = db.prepare('DELETE FROM labels WHERE id = ? AND user_id = ?').run(req.params.id, user.id)
  if (result.changes === 0) return res.status(404).json({ error: 'Label not found' })
  res.json({ ok: true })
})
```

- [ ] **Step 2: Register labelsRouter in `src/server.ts`**

Add the import after the `sendRouter` import line:
```typescript
import { labelsRouter } from './routes/labels'
```

Add the route mount after `app.use('/api/sync', syncRouter)`:
```typescript
app.use('/api/labels', labelsRouter)
```

- [ ] **Step 3: Run tests to verify GREEN**

```powershell
npx vitest run tests/routes/labels.test.ts
```

Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add inboxmy-backend/src/routes/labels.ts inboxmy-backend/src/server.ts inboxmy-backend/tests/routes/labels.test.ts
git commit -m "feat(api): add labels CRUD — GET/POST/PATCH/DELETE /api/labels"
```

---

## Task 4: Snooze Endpoints — Tests (RED)

**Files:**
- **Create**: `inboxmy-backend/tests/routes/snooze.test.ts`

- [ ] **Step 1: Create the failing test file**

```typescript
// tests/routes/snooze.test.ts
import { describe, it, expect, afterAll } from 'vitest'
import request from 'supertest'
import { app } from '../../src/server'
import { getDb, closeDb } from '../../src/db'
import { encryptSystem } from '../../src/crypto'
import { randomUUID } from 'crypto'
import { createTestUser } from '../helpers/auth'

afterAll(() => closeDb())

function seedAccount(userId: string) {
  const id = randomUUID()
  getDb().prepare(
    `INSERT OR IGNORE INTO accounts (id, provider, email, token_enc, created_at, user_id)
     VALUES (?, 'gmail', ?, ?, ?, ?)`
  ).run(id, `${id}@snooze-test.com`, encryptSystem('{}'), Date.now(), userId)
  return id
}

function seedEmail(userId: string, accountId: string, overrides: Record<string, any> = {}) {
  const id = randomUUID()
  getDb().prepare(
    `INSERT INTO emails (id, account_id, subject_enc, sender, received_at, is_read, folder, tab)
     VALUES (?, ?, ?, ?, ?, 0, 'inbox', 'primary')`
  ).run(id, accountId, encryptSystem('Snooze Test'), 'from@test.com', Date.now())
  if (Object.keys(overrides).length > 0) {
    const sets = Object.keys(overrides).map(k => `${k} = ?`).join(', ')
    getDb().prepare(`UPDATE emails SET ${sets} WHERE id = ?`).run(...Object.values(overrides), id)
  }
  return id
}

const FUTURE = Date.now() + 3 * 60 * 60 * 1000   // +3 hours
const PAST   = Date.now() - 1 * 60 * 60 * 1000   // -1 hour
const YEAR_PLUS = Date.now() + 366 * 24 * 60 * 60 * 1000  // >1 year

describe('PATCH /api/emails/:id/snooze', () => {
  it('sets snoozed_until on the email', async () => {
    const { agent, id: userId } = await createTestUser()
    const accountId = seedAccount(userId)
    const emailId = seedEmail(userId, accountId)
    const res = await agent.patch(`/api/emails/${emailId}/snooze`).send({ until: FUTURE })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    const row = getDb().prepare('SELECT snoozed_until FROM emails WHERE id = ?').get(emailId) as any
    expect(row.snoozed_until).toBe(FUTURE)
  })

  it('returns 400 for past timestamp', async () => {
    const { agent, id: userId } = await createTestUser()
    const accountId = seedAccount(userId)
    const emailId = seedEmail(userId, accountId)
    const res = await agent.patch(`/api/emails/${emailId}/snooze`).send({ until: PAST })
    expect(res.status).toBe(400)
  })

  it('returns 400 for timestamp more than 1 year out', async () => {
    const { agent, id: userId } = await createTestUser()
    const accountId = seedAccount(userId)
    const emailId = seedEmail(userId, accountId)
    const res = await agent.patch(`/api/emails/${emailId}/snooze`).send({ until: YEAR_PLUS })
    expect(res.status).toBe(400)
  })

  it('returns 404 when email belongs to another user', async () => {
    const { id: userId1 } = await createTestUser()
    const accountId = seedAccount(userId1)
    const emailId = seedEmail(userId1, accountId)
    const { agent: agent2 } = await createTestUser()
    const res = await agent2.patch(`/api/emails/${emailId}/snooze`).send({ until: FUTURE })
    expect(res.status).toBe(404)
  })

  it('returns 401 without session', async () => {
    const res = await request(app).patch(`/api/emails/${randomUUID()}/snooze`).send({ until: FUTURE })
    expect(res.status).toBe(401)
  })
})

describe('DELETE /api/emails/:id/snooze', () => {
  it('clears snoozed_until', async () => {
    const { agent, id: userId } = await createTestUser()
    const accountId = seedAccount(userId)
    const emailId = seedEmail(userId, accountId, { snoozed_until: FUTURE })
    const res = await agent.delete(`/api/emails/${emailId}/snooze`)
    expect(res.status).toBe(200)
    const row = getDb().prepare('SELECT snoozed_until FROM emails WHERE id = ?').get(emailId) as any
    expect(row.snoozed_until).toBeNull()
  })

  it('returns 404 when email belongs to another user', async () => {
    const { id: userId1 } = await createTestUser()
    const accountId = seedAccount(userId1)
    const emailId = seedEmail(userId1, accountId, { snoozed_until: FUTURE })
    const { agent: agent2 } = await createTestUser()
    const res = await agent2.delete(`/api/emails/${emailId}/snooze`)
    expect(res.status).toBe(404)
  })
})

describe('GET /api/emails — snooze exclusion', () => {
  it('excludes snoozed emails from default list', async () => {
    const { agent, id: userId } = await createTestUser()
    const accountId = seedAccount(userId)
    const normalId = seedEmail(userId, accountId)
    const snoozedId = seedEmail(userId, accountId, { snoozed_until: FUTURE })

    const res = await agent.get('/api/emails')
    expect(res.status).toBe(200)
    const ids = res.body.emails.map((e: any) => e.id)
    expect(ids).toContain(normalId)
    expect(ids).not.toContain(snoozedId)
  })

  it('shows only snoozed emails with ?snoozed=1', async () => {
    const { agent, id: userId } = await createTestUser()
    const accountId = seedAccount(userId)
    const normalId = seedEmail(userId, accountId)
    const snoozedId = seedEmail(userId, accountId, { snoozed_until: FUTURE })

    const res = await agent.get('/api/emails?snoozed=1')
    expect(res.status).toBe(200)
    const ids = res.body.emails.map((e: any) => e.id)
    expect(ids).toContain(snoozedId)
    expect(ids).not.toContain(normalId)
  })

  it('snoozed email is excluded from folder=inbox view', async () => {
    const { agent, id: userId } = await createTestUser()
    const accountId = seedAccount(userId)
    const snoozedId = seedEmail(userId, accountId, { snoozed_until: FUTURE })
    const res = await agent.get('/api/emails?folder=inbox')
    const ids = res.body.emails.map((e: any) => e.id)
    expect(ids).not.toContain(snoozedId)
  })
})

describe('POST /api/emails/unsnooze-due', () => {
  it('restores emails whose snoozed_until is in the past', async () => {
    const { agent, id: userId } = await createTestUser()
    const accountId = seedAccount(userId)
    const emailId = seedEmail(userId, accountId, { snoozed_until: PAST })

    const res = await agent.post('/api/emails/unsnooze-due')
    expect(res.status).toBe(200)
    expect(res.body.restored).toBeGreaterThanOrEqual(1)

    const row = getDb().prepare('SELECT snoozed_until FROM emails WHERE id = ?').get(emailId) as any
    expect(row.snoozed_until).toBeNull()
  })

  it('does not restore emails snoozed until the future', async () => {
    const { agent, id: userId } = await createTestUser()
    const accountId = seedAccount(userId)
    const emailId = seedEmail(userId, accountId, { snoozed_until: FUTURE })

    await agent.post('/api/emails/unsnooze-due')

    const row = getDb().prepare('SELECT snoozed_until FROM emails WHERE id = ?').get(emailId) as any
    expect(row.snoozed_until).toBe(FUTURE)
  })

  it('returns 401 without session', async () => {
    const res = await request(app).post('/api/emails/unsnooze-due')
    expect(res.status).toBe(401)
  })
})

describe('GET /api/emails/unread-count — snooze exclusion', () => {
  it('does not count snoozed-but-unread emails', async () => {
    const { agent, id: userId } = await createTestUser()
    const accountId = seedAccount(userId)
    seedEmail(userId, accountId)  // normal unread inbox
    seedEmail(userId, accountId, { snoozed_until: FUTURE })  // snoozed unread

    const res = await agent.get('/api/emails/unread-count')
    expect(res.status).toBe(200)
    // Only the non-snoozed email should be counted
    expect(res.body.count).toBe(1)
  })
})
```

- [ ] **Step 2: Run to confirm RED**

```powershell
npx vitest run tests/routes/snooze.test.ts
```

Expected: all tests fail (404 routes not registered, unread-count includes snoozed).

---

## Task 5: Snooze Endpoints — Implementation (GREEN)

**Files:**
- Modify: `inboxmy-backend/src/routes/emails.ts`
- **Create**: `inboxmy-backend/src/routes/unsnooze.ts`
- Modify: `inboxmy-backend/src/server.ts`

- [ ] **Step 1: Create `src/routes/unsnooze.ts`** (separate file, mounted before emailsRouter — same pattern as sendRouter)

```typescript
// src/routes/unsnooze.ts
import { Router, type Request, type Response } from 'express'
import { getDb } from '../db'

export const unsnoozeDueRouter = Router()

// POST /api/emails/unsnooze-due — restore emails whose snooze time has passed
// Called by Electron's runSyncTick every 60s via net.request with session cookie
unsnoozeDueRouter.post('/', (req: Request, res: Response) => {
  const user = (req as any).user
  const now = Date.now()
  const result = getDb().prepare(`
    UPDATE emails SET snoozed_until = NULL
    WHERE snoozed_until IS NOT NULL AND snoozed_until <= ?
      AND account_id IN (SELECT id FROM accounts WHERE user_id = ?)
  `).run(now, user.id)
  res.json({ restored: result.changes })
})
```

- [ ] **Step 2: Add snooze PATCH/DELETE handlers to `src/routes/emails.ts`**

Add after the existing `emailsRouter.patch('/:id/folder', ...)` handler (at the end of the file):

```typescript
const snoozeBody = z.object({
  until: z.number().int(),
})

emailsRouter.patch('/:id/snooze', (req: Request, res: Response) => {
  const parsed = snoozeBody.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })

  const now = Date.now()
  const maxSnooze = now + 365 * 24 * 60 * 60 * 1000
  if (parsed.data.until <= now) return res.status(400).json({ error: 'until must be in the future' })
  if (parsed.data.until > maxSnooze) return res.status(400).json({ error: 'until must be within 1 year' })

  const user = (req as any).user
  const db = getDb()
  const result = db.prepare(`
    UPDATE emails SET snoozed_until = ?
    WHERE id = ? AND account_id IN (SELECT id FROM accounts WHERE user_id = ?)
  `).run(parsed.data.until, req.params.id, user.id)

  if (result.changes === 0) return res.status(404).json({ error: 'Email not found' })
  res.json({ ok: true })
})

emailsRouter.delete('/:id/snooze', (req: Request, res: Response) => {
  const user = (req as any).user
  const db = getDb()
  const result = db.prepare(`
    UPDATE emails SET snoozed_until = NULL
    WHERE id = ? AND account_id IN (SELECT id FROM accounts WHERE user_id = ?)
  `).run(req.params.id, user.id)
  if (result.changes === 0) return res.status(404).json({ error: 'Email not found' })
  res.json({ ok: true })
})
```

- [ ] **Step 3: Add snooze filter to `GET /api/emails` list query**

In `src/routes/emails.ts`:

1. Add `snoozed` to the `listQuery` zod object:
```typescript
snoozed: z.enum(['1', 'true']).optional(),
```

2. Destructure `snoozed` from `parsed.data` in the GET handler.

3. Add snooze conditions after the existing `if (dateToMs !== null)` line:
```typescript
if (snoozed) {
  conditions.push('e.snoozed_until IS NOT NULL')
} else {
  conditions.push('e.snoozed_until IS NULL')
}
```

- [ ] **Step 4: Fix `GET /api/emails/unread-count` to exclude snoozed**

Change the query in `emailsRouter.get('/unread-count', ...)` from:
```typescript
WHERE a.user_id = ? AND e.is_read = 0 AND e.folder = 'inbox' AND e.tab != 'promotions'
```
to:
```typescript
WHERE a.user_id = ? AND e.is_read = 0 AND e.folder = 'inbox' AND e.tab != 'promotions' AND e.snoozed_until IS NULL
```

- [ ] **Step 4b: Extend `PATCH /api/emails/:id/read` to support mark-as-unread**

The context menu needs to toggle read state in both directions. Extend the existing handler to accept an optional `{ read: boolean }` body (defaults to `true` for backward compatibility):

Replace the existing `emailsRouter.patch('/:id/read', ...)` handler with:
```typescript
const readBody = z.object({ read: z.boolean().optional() })

emailsRouter.patch('/:id/read', (req: Request, res: Response) => {
  const parsed = readBody.safeParse(req.body)
  const isRead = parsed.success && parsed.data.read === false ? 0 : 1
  const user = (req as any).user
  const db = getDb()
  db.prepare(`
    UPDATE emails SET is_read = ?
    WHERE id = ? AND account_id IN (SELECT id FROM accounts WHERE user_id = ?)
  `).run(isRead, req.params.id, user.id)
  res.json({ ok: true })
})
```

This is backward-compatible: callers that send no body (or `{ read: true }`) still mark as read. The context menu sends `{ read: false }` to mark as unread.

- [ ] **Step 5: Register unsnoozeDueRouter in `src/server.ts`**

Add import:
```typescript
import { unsnoozeDueRouter } from './routes/unsnooze'
```

Mount before `emailsRouter` (following the `sendRouter` pattern):
```typescript
app.use('/api/emails/unsnooze-due', unsnoozeDueRouter)
```

The full order in server.ts should be:
```typescript
app.use('/api/emails/send', sendRouter)
app.use('/api/emails/unsnooze-due', unsnoozeDueRouter)
app.use('/api/emails', emailsRouter)
```

- [ ] **Step 6: Run tests to verify GREEN**

```powershell
npx vitest run tests/routes/snooze.test.ts
```

Expected: all tests pass.

- [ ] **Step 7: Run full suite to check no regressions**

```powershell
npm run test:backend
```

Expected: all tests pass.

- [ ] **Step 8: Commit**

```bash
git add inboxmy-backend/src/routes/emails.ts inboxmy-backend/src/routes/unsnooze.ts inboxmy-backend/src/server.ts inboxmy-backend/tests/routes/snooze.test.ts
git commit -m "feat(api): add snooze endpoints, unsnooze-due, snooze filter on GET /api/emails"
```

---

## Task 6: Email-Label Assignment — Tests (RED)

**Files:**
- **Create**: `inboxmy-backend/tests/routes/email-labels.test.ts`

- [ ] **Step 1: Create the failing test file**

```typescript
// tests/routes/email-labels.test.ts
import { describe, it, expect, afterAll } from 'vitest'
import request from 'supertest'
import { app } from '../../src/server'
import { getDb, closeDb } from '../../src/db'
import { encryptSystem } from '../../src/crypto'
import { randomUUID } from 'crypto'
import { createTestUser } from '../helpers/auth'

afterAll(() => closeDb())

function seedAccount(userId: string) {
  const id = randomUUID()
  getDb().prepare(
    `INSERT OR IGNORE INTO accounts (id, provider, email, token_enc, created_at, user_id)
     VALUES (?, 'gmail', ?, ?, ?, ?)`
  ).run(id, `${id}@el-test.com`, encryptSystem('{}'), Date.now(), userId)
  return id
}

function seedEmail(userId: string, accountId: string) {
  const id = randomUUID()
  getDb().prepare(
    `INSERT INTO emails (id, account_id, subject_enc, sender, received_at, is_read, folder, tab)
     VALUES (?, ?, ?, ?, ?, 0, 'inbox', 'primary')`
  ).run(id, accountId, encryptSystem('Label Test'), 'from@test.com', Date.now())
  return id
}

async function createLabel(agent: any, name: string) {
  const res = await agent.post('/api/labels').send({ name })
  return res.body.id as string
}

describe('POST /api/emails/:id/labels/:labelId', () => {
  it('assigns a label to an email', async () => {
    const { agent, id: userId } = await createTestUser()
    const accountId = seedAccount(userId)
    const emailId = seedEmail(userId, accountId)
    const labelId = await createLabel(agent, 'Assignment')
    const res = await agent.post(`/api/emails/${emailId}/labels/${labelId}`)
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    const row = getDb().prepare('SELECT * FROM email_labels WHERE email_id = ? AND label_id = ?').get(emailId, labelId)
    expect(row).toBeDefined()
  })

  it('is idempotent — second call still returns 200', async () => {
    const { agent, id: userId } = await createTestUser()
    const accountId = seedAccount(userId)
    const emailId = seedEmail(userId, accountId)
    const labelId = await createLabel(agent, 'Idempotent')
    await agent.post(`/api/emails/${emailId}/labels/${labelId}`)
    const res = await agent.post(`/api/emails/${emailId}/labels/${labelId}`)
    expect(res.status).toBe(200)
    const rows = getDb().prepare('SELECT * FROM email_labels WHERE email_id = ? AND label_id = ?').all(emailId, labelId)
    expect(rows).toHaveLength(1)  // not duplicated
  })

  it('returns 404 when email belongs to another user', async () => {
    const { id: userId1 } = await createTestUser()
    const accountId1 = seedAccount(userId1)
    const emailId = seedEmail(userId1, accountId1)
    const { agent: agent2, id: userId2 } = await createTestUser()
    const labelId = await createLabel(agent2, 'CrossEmail')
    const res = await agent2.post(`/api/emails/${emailId}/labels/${labelId}`)
    expect(res.status).toBe(404)
  })

  it('returns 404 when label belongs to another user', async () => {
    const { id: userId1 } = await createTestUser()
    const labelId = randomUUID()
    getDb().prepare(
      `INSERT INTO labels (id, user_id, name, color, created_at) VALUES (?, ?, ?, ?, ?)`
    ).run(labelId, userId1, 'Other Label', '#6B7280', Date.now())
    const { agent: agent2, id: userId2 } = await createTestUser()
    const accountId2 = seedAccount(userId2)
    const emailId = seedEmail(userId2, accountId2)
    const res = await agent2.post(`/api/emails/${emailId}/labels/${labelId}`)
    expect(res.status).toBe(404)
  })

  it('returns 401 without session', async () => {
    const res = await request(app).post(`/api/emails/${randomUUID()}/labels/${randomUUID()}`)
    expect(res.status).toBe(401)
  })
})

describe('DELETE /api/emails/:id/labels/:labelId', () => {
  it('removes a label from an email', async () => {
    const { agent, id: userId } = await createTestUser()
    const accountId = seedAccount(userId)
    const emailId = seedEmail(userId, accountId)
    const labelId = await createLabel(agent, 'ToRemove')
    await agent.post(`/api/emails/${emailId}/labels/${labelId}`)
    const res = await agent.delete(`/api/emails/${emailId}/labels/${labelId}`)
    expect(res.status).toBe(200)
    const row = getDb().prepare('SELECT * FROM email_labels WHERE email_id = ? AND label_id = ?').get(emailId, labelId)
    expect(row).toBeUndefined()
  })

  it('returns 404 when label belongs to another user', async () => {
    const { id: userId1 } = await createTestUser()
    const labelId = randomUUID()
    getDb().prepare(
      `INSERT INTO labels (id, user_id, name, color, created_at) VALUES (?, ?, ?, ?, ?)`
    ).run(labelId, userId1, 'OtherUserLabel', '#6B7280', Date.now())
    const { agent: agent2, id: userId2 } = await createTestUser()
    const accountId2 = seedAccount(userId2)
    const emailId = seedEmail(userId2, accountId2)
    const res = await agent2.delete(`/api/emails/${emailId}/labels/${labelId}`)
    expect(res.status).toBe(404)
  })
})

describe('Labels appear in GET /api/emails response', () => {
  it('includes labels array in email list response', async () => {
    const { agent, id: userId } = await createTestUser()
    const accountId = seedAccount(userId)
    const emailId = seedEmail(userId, accountId)
    const labelId = await createLabel(agent, 'InList')
    await agent.post(`/api/emails/${emailId}/labels/${labelId}`)

    const res = await agent.get('/api/emails')
    expect(res.status).toBe(200)
    const email = res.body.emails.find((e: any) => e.id === emailId)
    expect(email).toBeDefined()
    expect(email.labels).toBeInstanceOf(Array)
    expect(email.labels).toHaveLength(1)
    expect(email.labels[0].name).toBe('InList')
  })

  it('includes labels array in GET /api/emails/:id response', async () => {
    const { agent, id: userId } = await createTestUser()
    const accountId = seedAccount(userId)
    const emailId = seedEmail(userId, accountId)
    const labelId = await createLabel(agent, 'InDetail')
    await agent.post(`/api/emails/${emailId}/labels/${labelId}`)

    const res = await agent.get(`/api/emails/${emailId}`)
    expect(res.status).toBe(200)
    expect(res.body.labels).toBeInstanceOf(Array)
    expect(res.body.labels[0].name).toBe('InDetail')
  })

  it('unlabelled email has labels: []', async () => {
    const { agent, id: userId } = await createTestUser()
    const accountId = seedAccount(userId)
    const emailId = seedEmail(userId, accountId)
    const res = await agent.get('/api/emails')
    const email = res.body.emails.find((e: any) => e.id === emailId)
    expect(email.labels).toEqual([])
  })

  it('multi-label email appears exactly once in list', async () => {
    const { agent, id: userId } = await createTestUser()
    const accountId = seedAccount(userId)
    const emailId = seedEmail(userId, accountId)
    const labelId1 = await createLabel(agent, 'Multi1')
    const labelId2 = await createLabel(agent, 'Multi2')
    await agent.post(`/api/emails/${emailId}/labels/${labelId1}`)
    await agent.post(`/api/emails/${emailId}/labels/${labelId2}`)

    const res = await agent.get('/api/emails')
    const matching = res.body.emails.filter((e: any) => e.id === emailId)
    expect(matching).toHaveLength(1)  // not duplicated
    expect(matching[0].labels).toHaveLength(2)
  })
})

describe('GET /api/emails?labelId=', () => {
  it('filters emails by label', async () => {
    const { agent, id: userId } = await createTestUser()
    const accountId = seedAccount(userId)
    const labelledId = seedEmail(userId, accountId)
    const unlabelledId = seedEmail(userId, accountId)
    const labelId = await createLabel(agent, 'FilterTest')
    await agent.post(`/api/emails/${labelledId}/labels/${labelId}`)

    const res = await agent.get(`/api/emails?labelId=${labelId}`)
    expect(res.status).toBe(200)
    const ids = res.body.emails.map((e: any) => e.id)
    expect(ids).toContain(labelledId)
    expect(ids).not.toContain(unlabelledId)
  })

  it('returns 404 when labelId belongs to another user', async () => {
    const { id: userId1 } = await createTestUser()
    const labelId = randomUUID()
    getDb().prepare(
      `INSERT INTO labels (id, user_id, name, color, created_at) VALUES (?, ?, ?, ?, ?)`
    ).run(labelId, userId1, 'OtherLabel', '#6B7280', Date.now())
    const { agent: agent2 } = await createTestUser()
    const res = await agent2.get(`/api/emails?labelId=${labelId}`)
    expect(res.status).toBe(404)
  })
})
```

- [ ] **Step 2: Run to confirm RED**

```powershell
npx vitest run tests/routes/email-labels.test.ts
```

Expected: most tests fail (no handlers for label assignment, no `labels` field in responses).

---

## Task 7: Email-Label Assignment — Implementation (GREEN)

**Files:**
- Modify: `inboxmy-backend/src/routes/emails.ts`
- Modify: `inboxmy-backend/src/routes/labels.ts`

- [ ] **Step 1: Add label assignment routes to `src/routes/emails.ts`**

Append to the end of `emails.ts`:

```typescript
// POST /api/emails/:id/labels/:labelId — assign label (INSERT OR IGNORE — idempotent)
emailsRouter.post('/:id/labels/:labelId', (req: Request, res: Response) => {
  const user = (req as any).user
  const db = getDb()

  // Verify email belongs to user
  const email = db.prepare(`
    SELECT e.id FROM emails e JOIN accounts a ON a.id = e.account_id
    WHERE e.id = ? AND a.user_id = ?
  `).get(req.params.id, user.id)
  if (!email) return res.status(404).json({ error: 'Email not found' })

  // Verify label belongs to user
  const label = db.prepare('SELECT id FROM labels WHERE id = ? AND user_id = ?').get(req.params.labelId, user.id)
  if (!label) return res.status(404).json({ error: 'Label not found' })

  db.prepare('INSERT OR IGNORE INTO email_labels (email_id, label_id) VALUES (?, ?)').run(req.params.id, req.params.labelId)
  res.json({ ok: true })
})

// DELETE /api/emails/:id/labels/:labelId — remove label
emailsRouter.delete('/:id/labels/:labelId', (req: Request, res: Response) => {
  const user = (req as any).user
  const db = getDb()

  // Verify email belongs to user
  const email = db.prepare(`
    SELECT e.id FROM emails e JOIN accounts a ON a.id = e.account_id
    WHERE e.id = ? AND a.user_id = ?
  `).get(req.params.id, user.id)
  if (!email) return res.status(404).json({ error: 'Email not found' })

  // Verify label belongs to user
  const label = db.prepare('SELECT id FROM labels WHERE id = ? AND user_id = ?').get(req.params.labelId, user.id)
  if (!label) return res.status(404).json({ error: 'Label not found' })

  db.prepare('DELETE FROM email_labels WHERE email_id = ? AND label_id = ?').run(req.params.id, req.params.labelId)
  res.json({ ok: true })
})
```

- [ ] **Step 2: Add `labels` correlated subquery to `EMAIL_SELECT` and response handling**

In `src/routes/emails.ts`, update the `EMAIL_SELECT` constant to include the labels subquery:

```typescript
const EMAIL_SELECT = `SELECT e.id, e.account_id, e.thread_id, e.subject_enc,
  e.sender, e.sender_name, e.received_at, e.is_read, e.folder, e.tab,
  e.is_important, e.category, e.snippet, e.raw_size,
  (SELECT json_group_array(json_object('id', l.id, 'name', l.name, 'color', l.color))
   FROM email_labels el JOIN labels l ON l.id = el.label_id
   WHERE el.email_id = e.id) AS labels_json
  FROM emails e
  JOIN accounts a ON a.id = e.account_id`
```

Update the email mapping in the fast path (`rows.map(...)`) and search path (`filtered.push(...)`) to parse `labels_json`:

In the fast path, change:
```typescript
const emails = rows.map(r => ({
  ...r,
  subject: decrypt(r.subject_enc, user.dataKey),
  snippet: r.snippet ? decrypt(r.snippet, user.dataKey) : null,
  subject_enc: undefined,
}))
```
to:
```typescript
const emails = rows.map(r => ({
  ...r,
  subject: decrypt(r.subject_enc, user.dataKey),
  snippet: r.snippet ? decrypt(r.snippet, user.dataKey) : null,
  subject_enc: undefined,
  labels: r.labels_json ? JSON.parse(r.labels_json) : [],
  labels_json: undefined,
}))
```

In the search path, change:
```typescript
filtered.push({ ...r, subject, snippet, subject_enc: undefined })
```
to:
```typescript
filtered.push({
  ...r, subject, snippet,
  subject_enc: undefined,
  labels: r.labels_json ? JSON.parse(r.labels_json) : [],
  labels_json: undefined,
})
```

- [ ] **Step 3: Add `labels` to `GET /api/emails/:id` response**

In the `emailsRouter.get('/:id', ...)` handler, update the SELECT query to include labels:

```typescript
const row = db.prepare(`
  SELECT e.*,
    pb.biller, pb.amount_rm, pb.due_date, pb.account_ref, pb.status,
    (SELECT json_group_array(json_object('id', l.id, 'name', l.name, 'color', l.color))
     FROM email_labels el JOIN labels l ON l.id = el.label_id
     WHERE el.email_id = e.id) AS labels_json
  FROM emails e
  JOIN accounts a ON a.id = e.account_id
  LEFT JOIN parsed_bills pb ON pb.email_id = e.id
  WHERE e.id = ? AND a.user_id = ?
`).get(req.params.id, user.id) as any
```

And add `labels` parsing to the response:
```typescript
res.json({
  ...row,
  subject: decrypt(row.subject_enc, user.dataKey),
  body: row.body_enc ? decrypt(row.body_enc, user.dataKey) : null,
  snippet: row.snippet ? decrypt(row.snippet, user.dataKey) : null,
  subject_enc: undefined,
  body_enc: undefined,
  labels: row.labels_json ? JSON.parse(row.labels_json) : [],
  labels_json: undefined,
})
```

- [ ] **Step 4: Add `labelId` param to `GET /api/emails` list query**

In `listQuery` zod object, add:
```typescript
labelId: z.string().uuid().optional(),
```

Destructure `labelId` from `parsed.data`.

After the existing account filter block, add:
```typescript
if (labelId) {
  // Verify label belongs to user — return 404 if not
  const label = db.prepare('SELECT id FROM labels WHERE id = ? AND user_id = ?').get(labelId, user.id)
  if (!label) return res.status(404).json({ error: 'Label not found' })
  conditions.push(`e.id IN (SELECT email_id FROM email_labels WHERE label_id = ?)`)
  params.push(labelId)
}
```

- [ ] **Step 5: Run tests to verify GREEN**

```powershell
npx vitest run tests/routes/email-labels.test.ts
```

Expected: all tests pass.

- [ ] **Step 6: Run full suite**

```powershell
npm run test:backend
```

Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add inboxmy-backend/src/routes/emails.ts inboxmy-backend/src/routes/labels.ts inboxmy-backend/tests/routes/email-labels.test.ts
git commit -m "feat(api): add email-label assignment, labels in GET /api/emails response, labelId filter"
```

---

## Task 8: Electron — Call unsnooze-due in runSyncTick

**Files:**
- Modify: `electron/main.js`

> No automated test for this — it requires Electron's `net.request`. Manual verification: snooze an email via the UI, wait >60s, confirm it reappears in inbox.

- [ ] **Step 1: Add unsnooze-due call to `runSyncTick` in `electron/main.js`**

At the end of the `runSyncTick` function body (after the `mainWindow.webContents.send('sync-complete')` call), add:

```javascript
// Restore any emails whose snooze time has passed
await new Promise((resolve) => {
  const unsnoozReq = net.request({
    url: `${BACKEND_URL}/api/emails/unsnooze-due`,
    method: 'POST',
    session: winSession,
  })
  unsnoozReq.on('response', (res) => {
    res.on('data', () => {})
    res.on('end', resolve)
  })
  unsnoozReq.on('error', () => resolve())
  unsnoozReq.setHeader('Content-Length', '0')
  unsnoozReq.end()
})
```

- [ ] **Step 2: Commit**

```bash
git add electron/main.js
git commit -m "feat(electron): call unsnooze-due in runSyncTick every 60s"
```

---

## Task 9: Frontend — Sidebar Additions (Focused, Snoozed, Labels)

**Files:**
- Modify: `frontend/app.js`
- Modify: `frontend/index.html`

> No automated test — frontend JS. Verify manually via running app.

- [ ] **Step 1: Add Focused, Snoozed entries to `FOLDER_PARAMS` and `titles` in `app.js`**

In `FOLDER_PARAMS` (around line 180), add:
```javascript
focused:    { folder: 'inbox', tab: 'primary' },
snoozed:    { snoozed: '1' },
```

In `setFolder`'s `titles` object (around line 373), add:
```javascript
focused: 'Focused', snoozed: 'Snoozed',
```

- [ ] **Step 2: Add label state + functions to `app.js`**

After the state block (around line 170), add:
```javascript
let userLabels = []     // [{ id, name, color, count }]
let currentLabelId = null  // active label filter

async function loadLabels() {
  try {
    userLabels = await apiFetch('/api/labels')
    renderLabelsSidebar()
  } catch { /* silent */ }
}

function renderLabelsSidebar() {
  const wrap = document.getElementById('sb-labels-section')
  if (!wrap) return
  if (userLabels.length === 0) { wrap.style.display = 'none'; return }
  wrap.style.display = ''
  const list = document.getElementById('sb-labels-list')
  if (!list) return
  list.innerHTML = userLabels.map(l => `
    <div class="sb-item sb-label-item${currentLabelId === l.id ? ' active' : ''}"
         onclick="setLabelFolder('${l.id}', this)"
         data-label-id="${l.id}">
      <span class="sb-label-dot" style="background:${escHtml(l.color)}"></span>
      <span class="sb-label-name">${escHtml(l.name)}</span>
      ${l.count > 0 ? `<span class="sb-badge">${l.count}</span>` : ''}
    </div>
  `).join('')
}

function setLabelFolder(labelId, el) {
  currentLabelId = labelId
  currentFolder = 'label'
  currentFilter = 'all'
  currentDateFrom = null
  currentDateTo = null
  document.querySelectorAll('.sb-item').forEach(i => i.classList.remove('active'))
  if (el) el.classList.add('active')
  const label = userLabels.find(l => l.id === labelId)
  document.getElementById('folder-title').textContent = label ? label.name : 'Label'
  loadEmails(true)
}
```

- [ ] **Step 3: Update `buildEmailParams` to handle snoozed and labelId**

In `buildEmailParams`, after the `folderParams` line:
```javascript
function buildEmailParams(offset = 0) {
  let folderParams = FOLDER_PARAMS[currentFolder] || { folder: 'inbox' }
  // Label folder is a special case — use labelId param instead of folderParams
  if (currentFolder === 'label' && currentLabelId) {
    folderParams = { labelId: currentLabelId }
  }
  // ... rest unchanged
}
```

- [ ] **Step 4: Add sidebar HTML for Focused, Snoozed, Labels in `frontend/index.html`**

Find the existing sidebar items section (look for `id="folder-inbox"` or similar). Add Focused and Snoozed entries near the top of the sidebar folder list:

```html
<div class="sb-item active" id="folder-focused" onclick="setFolder('focused', this)">
  <span class="sb-icon">⭐</span> Focused
  <span class="sb-badge" id="badge-focused"></span>
</div>
<div class="sb-item" id="folder-snoozed" onclick="setFolder('snoozed', this)">
  <span class="sb-icon">🕐</span> Snoozed
  <span class="sb-badge" id="badge-snoozed"></span>
</div>
```

Add the Labels section below the existing sidebar folders:
```html
<div id="sb-labels-section" style="display:none">
  <div class="sb-section-header">LABELS</div>
  <div id="sb-labels-list"></div>
  <div class="sb-item sb-label-new" onclick="promptNewLabel()">
    <span>＋ New label</span>
  </div>
</div>
```

- [ ] **Step 5: Add badge refresh for Focused and Snoozed + call loadLabels on startup**

Add to the `refreshBadges` function (or equivalent startup call):
```javascript
async function refreshFocusedBadge() {
  try {
    const data = await apiFetch('/api/emails?folder=inbox&tab=primary&unread=1&limit=1')
    const el = document.getElementById('badge-focused')
    if (el) el.textContent = data.total > 0 ? (data.total > 99 ? '99+' : data.total) : ''
  } catch { /* silent */ }
}

async function refreshSnoozedBadge() {
  try {
    const data = await apiFetch('/api/emails?snoozed=1&limit=1')
    const el = document.getElementById('badge-snoozed')
    if (el) el.textContent = data.total > 0 ? (data.total > 99 ? '99+' : data.total) : ''
  } catch { /* silent */ }
}

async function promptNewLabel() {
  const name = prompt('Label name:')
  if (!name || !name.trim()) return
  try {
    await apiFetch('/api/labels', { method: 'POST', body: JSON.stringify({ name: name.trim() }) })
    await loadLabels()
  } catch (e) {
    showToast('Could not create label: ' + (e?.message || 'Unknown error'))
  }
}
```

Call `loadLabels()`, `refreshFocusedBadge()`, and `refreshSnoozedBadge()` from the app initialisation block (wherever `refreshUnreadCount()` is called on startup).

- [ ] **Step 6: Commit**

```bash
git add frontend/app.js frontend/index.html
git commit -m "feat(frontend): add Focused and Snoozed sidebar entries, Labels section"
```

---

## Task 10: Frontend — Context Menu Base Component

**Files:**
- Modify: `frontend/app.js`
- Modify: `frontend/index.html`

- [ ] **Step 1: Add context menu HTML to `frontend/index.html`**

Before the closing `</body>` tag, add:

```html
<!-- Right-click context menu -->
<div id="ctx-menu" style="display:none;position:fixed;z-index:9999;background:var(--surface);border:1px solid var(--border);border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,0.15);min-width:220px;padding:4px 0;font-size:13px">
  <div class="ctx-item" id="ctx-reply"       onclick="ctxAction('reply')">↩ Reply</div>
  <div class="ctx-item" id="ctx-reply-all"   onclick="ctxAction('reply-all')">↩↩ Reply all</div>
  <div class="ctx-item" id="ctx-forward"     onclick="ctxAction('forward')">↪ Forward</div>
  <div class="ctx-divider"></div>
  <div class="ctx-item" id="ctx-archive"     onclick="ctxAction('archive')">⬚ Archive</div>
  <div class="ctx-item" id="ctx-delete"      onclick="ctxAction('delete')">🗑 Delete</div>
  <div class="ctx-item" id="ctx-toggle-read" onclick="ctxAction('toggle-read')">✉ Mark as unread</div>
  <div class="ctx-item ctx-has-sub" id="ctx-snooze">🕐 Snooze ▶
    <div class="ctx-submenu" id="ctx-snooze-sub">
      <div class="ctx-item" onclick="ctxSnoozePreset('later-today')">Later today</div>
      <div class="ctx-item" onclick="ctxSnoozePreset('tomorrow')">Tomorrow (9:00 AM)</div>
      <div class="ctx-item" onclick="ctxSnoozePreset('weekend')">This weekend (Sat 9:00 AM)</div>
      <div class="ctx-item" onclick="ctxSnoozePreset('next-week')">Next week (Mon 9:00 AM)</div>
      <div class="ctx-divider"></div>
      <div class="ctx-item" onclick="ctxSnoozeCustom()">Custom date/time…</div>
      <div id="ctx-snooze-custom-wrap" style="display:none;padding:6px 12px">
        <input type="datetime-local" id="ctx-snooze-datetime" style="width:100%;font-size:12px">
        <button onclick="ctxSnoozeApplyCustom()" style="margin-top:4px;width:100%">Snooze</button>
      </div>
    </div>
  </div>
  <div class="ctx-divider"></div>
  <div class="ctx-item ctx-has-sub" id="ctx-moveto">📁 Move to ▶
    <div class="ctx-submenu" id="ctx-moveto-sub">
      <div class="ctx-item" onclick="ctxMoveTo('inbox')">Inbox</div>
      <div class="ctx-item" onclick="ctxMoveTo('sent')">Sent</div>
      <div class="ctx-item" onclick="ctxMoveTo('draft')">Drafts</div>
      <div class="ctx-item" onclick="ctxMoveTo('spam')">Spam</div>
      <div class="ctx-item" onclick="ctxMoveTo('trash')">Trash</div>
      <div class="ctx-item" onclick="ctxMoveTo('archive')">Archive</div>
    </div>
  </div>
  <div class="ctx-item ctx-has-sub" id="ctx-labelAs">🏷 Label as ▶
    <div class="ctx-submenu" id="ctx-labelAs-sub">
      <div id="ctx-labels-list"></div>
      <div class="ctx-divider"></div>
      <div class="ctx-item" onclick="ctxNewLabel()">＋ New label…</div>
      <div id="ctx-new-label-wrap" style="display:none;padding:6px 12px">
        <input type="text" id="ctx-new-label-input" placeholder="Label name" style="width:100%;font-size:12px">
        <button onclick="ctxCreateAndAssignLabel()" style="margin-top:4px;width:100%">Create &amp; assign</button>
      </div>
    </div>
  </div>
  <div class="ctx-divider"></div>
  <div class="ctx-item" id="ctx-find-sender" onclick="ctxAction('find-sender')">🔍 Find emails from</div>
</div>
```

Add CSS to `<style>` block:
```css
.ctx-item { padding: 7px 16px; cursor: pointer; white-space: nowrap; position: relative; }
.ctx-item:hover { background: var(--hover); }
.ctx-divider { height: 1px; background: var(--border); margin: 4px 0; }
.ctx-has-sub .ctx-submenu {
  display: none; position: absolute; left: 100%; top: -4px;
  background: var(--surface); border: 1px solid var(--border);
  border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,0.15);
  min-width: 180px; padding: 4px 0; z-index: 10000;
}
.ctx-has-sub:hover .ctx-submenu { display: block; }
```

- [ ] **Step 2: Add context menu JS to `app.js`**

Add the following context menu logic:

```javascript
// ── CONTEXT MENU ─────────────────────────────────────────────────────────────
let ctxEmailId = null
let ctxEmailData = null  // { id, is_read, sender, sender_name, folder }

function closeCtxMenu() {
  const menu = document.getElementById('ctx-menu')
  if (menu) menu.style.display = 'none'
  ctxEmailId = null
  ctxEmailData = null
}

document.addEventListener('click', (e) => {
  if (!document.getElementById('ctx-menu')?.contains(e.target)) closeCtxMenu()
})
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeCtxMenu()
})
document.getElementById('el-items')?.addEventListener('scroll', closeCtxMenu)

function openCtxMenu(e, emailId, emailData) {
  e.preventDefault()
  ctxEmailId = emailId
  ctxEmailData = emailData

  // Toggle read label
  const toggleEl = document.getElementById('ctx-toggle-read')
  if (toggleEl) toggleEl.textContent = emailData.is_read ? '✉ Mark as unread' : '✉ Mark as read'

  // Find from sender
  const senderEl = document.getElementById('ctx-find-sender')
  if (senderEl) senderEl.textContent = `🔍 Find emails from ${emailData.sender_name || emailData.sender}`

  // Populate label submenu
  renderCtxLabelList()

  const menu = document.getElementById('ctx-menu')
  menu.style.display = 'block'

  // Position — keep within viewport
  const menuW = 220, menuH = 340
  let x = e.clientX, y = e.clientY
  if (x + menuW > window.innerWidth)  x = window.innerWidth - menuW - 8
  if (y + menuH > window.innerHeight) y = window.innerHeight - menuH - 8
  menu.style.left = x + 'px'
  menu.style.top  = y + 'px'
}

function renderCtxLabelList() {
  const list = document.getElementById('ctx-labels-list')
  if (!list || !ctxEmailData) return
  const emailLabels = ctxEmailData.labels || []
  const assignedIds = new Set(emailLabels.map(l => l.id))
  list.innerHTML = userLabels.map(l => `
    <div class="ctx-item" onclick="ctxToggleLabel('${l.id}')">
      <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${escHtml(l.color)};margin-right:8px"></span>
      ${escHtml(l.name)}
      ${assignedIds.has(l.id) ? ' ✓' : ''}
    </div>
  `).join('')
}

async function ctxAction(action) {
  if (!ctxEmailId) return
  const id = ctxEmailId
  const data = ctxEmailData
  closeCtxMenu()

  if (action === 'reply' || action === 'reply-all' || action === 'forward') {
    if (typeof openCompose === 'function') {
      openCompose({ mode: action, emailId: id })
    } else {
      showToast('Compose coming soon')
    }
    return
  }

  if (action === 'archive') {
    await apiFetch(`/api/emails/${id}/folder`, { method: 'PATCH', body: JSON.stringify({ folder: 'archive' }) })
    removeEmailFromList(id)
    return
  }

  if (action === 'delete') {
    await apiFetch(`/api/emails/${id}/folder`, { method: 'PATCH', body: JSON.stringify({ folder: 'trash' }) })
    removeEmailFromList(id)
    return
  }

  if (action === 'toggle-read') {
    const newRead = !data.is_read
    await apiFetch(`/api/emails/${id}/read`, { method: 'PATCH', body: JSON.stringify({ read: newRead }) })
    const row = document.getElementById('row-' + id)
    if (row) row.classList.toggle('unread', !newRead)
    const cached = emailCache.find(e => e.id === id)
    if (cached) cached.is_read = newRead
    return
  }

  if (action === 'find-sender') {
    const searchInput = document.getElementById('search-input')
    if (searchInput) {
      searchInput.value = data.sender
      filterEmails(data.sender)
    }
    return
  }
}

function removeEmailFromList(id) {
  const row = document.getElementById('row-' + id)
  if (row) row.remove()
  emailCache = emailCache.filter(e => e.id !== id)
  const countEl = document.getElementById('email-count')
  if (countEl) countEl.textContent = emailCache.length + (emailHasMore ? '+' : '') + ' email' + (emailCache.length !== 1 ? 's' : '')
}

async function ctxMoveTo(folder) {
  if (!ctxEmailId) return
  const id = ctxEmailId
  closeCtxMenu()
  await apiFetch(`/api/emails/${id}/folder`, { method: 'PATCH', body: JSON.stringify({ folder }) })
  removeEmailFromList(id)
}

async function ctxToggleLabel(labelId) {
  if (!ctxEmailId || !ctxEmailData) return
  const id = ctxEmailId
  const assignedIds = new Set((ctxEmailData.labels || []).map(l => l.id))
  if (assignedIds.has(labelId)) {
    await apiFetch(`/api/emails/${id}/labels/${labelId}`, { method: 'DELETE' })
    ctxEmailData.labels = (ctxEmailData.labels || []).filter(l => l.id !== labelId)
  } else {
    await apiFetch(`/api/emails/${id}/labels/${labelId}`, { method: 'POST' })
    const label = userLabels.find(l => l.id === labelId)
    if (label) ctxEmailData.labels = [...(ctxEmailData.labels || []), label]
  }
  renderCtxLabelList()
  await loadLabels()  // refresh sidebar counts
}

function ctxNewLabel() {
  const wrap = document.getElementById('ctx-new-label-wrap')
  if (wrap) { wrap.style.display = ''; document.getElementById('ctx-new-label-input')?.focus() }
}

async function ctxCreateAndAssignLabel() {
  const input = document.getElementById('ctx-new-label-input')
  const name = input?.value?.trim()
  if (!name) return
  try {
    const label = await apiFetch('/api/labels', { method: 'POST', body: JSON.stringify({ name }) })
    await apiFetch(`/api/emails/${ctxEmailId}/labels/${label.id}`, { method: 'POST' })
    if (input) input.value = ''
    const wrap = document.getElementById('ctx-new-label-wrap')
    if (wrap) wrap.style.display = 'none'
    await loadLabels()
  } catch (e) {
    showToast('Could not create label: ' + (e?.message || 'error'))
  }
}
```

- [ ] **Step 3: Wire `contextmenu` event on email rows**

In the `renderEmailRow` function (find it in `app.js`), add the `contextmenu` event to the row element. After the row is created (find where `div.id = 'row-' + email.id` is set), add:

```javascript
div.addEventListener('contextmenu', (e) => {
  openCtxMenu(e, email.id, {
    id: email.id,
    is_read: email.is_read,
    sender: email.sender,
    sender_name: email.sender_name,
    folder: email.folder,
    labels: email.labels || [],
  })
})
```

- [ ] **Step 4: Snooze submenu functions**

```javascript
function ctxSnoozePreset(preset) {
  if (!ctxEmailId) return
  const now = new Date()
  let until

  if (preset === 'later-today') {
    until = Date.now() + 3 * 60 * 60 * 1000
  } else if (preset === 'tomorrow') {
    const d = new Date(now); d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0)
    until = d.getTime()
  } else if (preset === 'weekend') {
    const d = new Date(now)
    const daysToSat = (6 - d.getDay() + 7) % 7 || 7
    d.setDate(d.getDate() + daysToSat); d.setHours(9, 0, 0, 0)
    until = d.getTime()
  } else if (preset === 'next-week') {
    const d = new Date(now)
    const daysToMon = (1 - d.getDay() + 7) % 7 || 7
    d.setDate(d.getDate() + daysToMon); d.setHours(9, 0, 0, 0)
    until = d.getTime()
  }

  const id = ctxEmailId
  closeCtxMenu()
  apiFetch(`/api/emails/${id}/snooze`, { method: 'PATCH', body: JSON.stringify({ until }) })
    .then(() => { removeEmailFromList(id); refreshSnoozedBadge() })
    .catch(e => showToast('Snooze failed: ' + e.message))
}

function ctxSnoozeCustom() {
  const wrap = document.getElementById('ctx-snooze-custom-wrap')
  if (wrap) { wrap.style.display = ''; document.getElementById('ctx-snooze-datetime')?.focus() }
}

async function ctxSnoozeApplyCustom() {
  const input = document.getElementById('ctx-snooze-datetime')
  if (!input || !input.value) return
  const until = new Date(input.value).getTime()
  if (isNaN(until) || until <= Date.now()) { showToast('Please pick a future date/time'); return }
  const id = ctxEmailId
  closeCtxMenu()
  try {
    await apiFetch(`/api/emails/${id}/snooze`, { method: 'PATCH', body: JSON.stringify({ until }) })
    removeEmailFromList(id)
    refreshSnoozedBadge()
  } catch (e) {
    showToast('Snooze failed: ' + e.message)
  }
}
```

- [ ] **Step 5: Commit**

```bash
git add frontend/app.js frontend/index.html
git commit -m "feat(frontend): add Gmail-style right-click context menu with snooze, move, label submenus"
```

---

## Task 11: Run Full Test Suite + Update Docs

**Files:**
- Modify: `README.md`
- Modify: `TEST-REPORT.md`

- [ ] **Step 1: Run all tests**

```powershell
# From repo root
npm run test:all
```

Expected: all tests pass. New total should be ~274 (270 backend + 4 utils).

- [ ] **Step 2: Update README test counts**

In `README.md`:
- Change `239 tests` → actual total from test run
- Change `235 backend` → actual backend count from test run
- Add Plan 11 test section listing `tests/routes/labels.test.ts`, `tests/routes/snooze.test.ts`, `tests/routes/email-labels.test.ts`
- Update Plans Reference table: mark Plan 11 as `✅ Done`
- Update Roadmap table: fill in Plan 11 deliverables
- Update Next Session Prompt to reflect Plan 11 completion

- [ ] **Step 3: Update TEST-REPORT.md**

- Update date, version, total count
- Add new test suites (labels, snooze, email-labels)
- Update summary block with Plan 11 additions

- [ ] **Step 4: Commit**

```bash
git add README.md TEST-REPORT.md
git commit -m "docs: update README and TEST-REPORT for Plan 11 completion"
```
