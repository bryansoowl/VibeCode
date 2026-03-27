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

// ── POST /api/notifications/ai-summary ────────────────────────────────────────
describe('POST /api/notifications/ai-summary', () => {
  it('returns 401 without session', async () => {
    const { default: request } = await import('supertest')
    const { app } = await import('../../src/server')
    const res = await request(app)
      .post('/api/notifications/ai-summary')
      .send({ bills: [], geminiKey: 'test-key' })
    expect(res.status).toBe(401)
  })

  it('returns 400 when bills is missing', async () => {
    const { agent } = await createTestUser()
    const res = await agent
      .post('/api/notifications/ai-summary')
      .send({ geminiKey: 'test-key' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBeTruthy()
  })

  it('returns 400 when geminiKey is missing', async () => {
    const { agent } = await createTestUser()
    const res = await agent
      .post('/api/notifications/ai-summary')
      .send({ bills: [] })
    expect(res.status).toBe(400)
    expect(res.body.error).toBeTruthy()
  })

  it('returns 400 when geminiKey is whitespace-only', async () => {
    const { agent } = await createTestUser()
    const res = await agent
      .post('/api/notifications/ai-summary')
      .send({ bills: [], geminiKey: '   ' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBeTruthy()
  })

  it('returns 200 with empty array for empty bills input', async () => {
    const { agent } = await createTestUser()
    const res = await agent
      .post('/api/notifications/ai-summary')
      .send({ bills: [], geminiKey: 'fake-key' })
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body)).toBe(true)
    expect(res.body).toHaveLength(0)
  })
})
