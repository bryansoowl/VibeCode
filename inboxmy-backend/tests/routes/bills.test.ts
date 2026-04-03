// tests/routes/bills.test.ts
import { describe, it, expect, afterAll } from 'vitest'
import { closeDb, getDb } from '../../src/db'
import { encryptSystem, encrypt } from '../../src/crypto'
import { randomUUID } from 'crypto'
import { createTestUser } from '../helpers/auth'

afterAll(() => closeDb())

// ── Seed helpers ───────────────────────────────────────────────────────────────

function seedBill(userId: string, opts: {
  status?: 'unpaid' | 'paid' | 'overdue'
  dueDateMs?: number | null
  biller?: string
  amountRm?: number
  dataKey?: Buffer
}) {
  const db = getDb()
  const accountId = randomUUID()
  const emailId = randomUUID()
  const billId = randomUUID()
  // subject_enc must be encrypted with the user's dataKey (not the system key)
  // so the bills route can decrypt it. Fall back to a zero-key for tests that
  // don't need to read the decrypted subject.
  const key = opts.dataKey ?? Buffer.alloc(32)

  db.prepare(`
    INSERT INTO accounts (id, provider, email, token_enc, created_at, user_id)
    VALUES (?, 'gmail', ?, ?, ?, ?)
  `).run(accountId, `${accountId}@test.com`, encryptSystem('{}'), Date.now(), userId)

  db.prepare(`
    INSERT INTO emails (id, account_id, subject_enc, sender, received_at)
    VALUES (?, ?, ?, 'test@test.com', ?)
  `).run(emailId, accountId, encrypt('Test Bill', key), Date.now())

  db.prepare(`
    INSERT INTO parsed_bills (id, email_id, biller, amount_rm, due_date, status, parsed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    billId, emailId,
    opts.biller ?? 'TNB',
    opts.amountRm ?? 100.00,
    opts.dueDateMs !== undefined ? opts.dueDateMs : Date.now() + 7 * 24 * 60 * 60 * 1000,
    opts.status ?? 'unpaid',
    Date.now()
  )

  return { billId, accountId, emailId }
}

// ── GET /api/bills ─────────────────────────────────────────────────────────────

describe('GET /api/bills', () => {
  it('returns 401 without session', async () => {
    const { default: request } = await import('supertest')
    const { app } = await import('../../src/server')
    const res = await request(app).get('/api/bills')
    expect(res.status).toBe(401)
  })

  it('returns an empty bills array when user has no bills', async () => {
    const { agent } = await createTestUser()
    const res = await agent.get('/api/bills')
    expect(res.status).toBe(200)
    expect(res.body.bills).toBeInstanceOf(Array)
    expect(res.body.bills).toHaveLength(0)
  })

  it('returns bills belonging to the current user', async () => {
    const { agent, id: userId, dataKey } = await createTestUser()
    seedBill(userId, { biller: 'TNB', amountRm: 134.50, dataKey })
    seedBill(userId, { biller: 'Unifi', amountRm: 129.00, dataKey })

    const res = await agent.get('/api/bills')
    expect(res.status).toBe(200)
    expect(res.body.bills).toHaveLength(2)
    const billers = res.body.bills.map((b: any) => b.biller)
    expect(billers).toContain('TNB')
    expect(billers).toContain('Unifi')
  })

  it('does not return another user\'s bills', async () => {
    const { id: userId1 } = await createTestUser()
    const { agent: agent2 } = await createTestUser()
    seedBill(userId1, { biller: 'TNB' })

    const res = await agent2.get('/api/bills')
    expect(res.status).toBe(200)
    expect(res.body.bills).toHaveLength(0)
  })

  it('each bill row has the expected fields', async () => {
    const { agent, id: userId, dataKey } = await createTestUser()
    const futureMs = Date.now() + 14 * 24 * 60 * 60 * 1000
    seedBill(userId, { biller: 'TNB', amountRm: 88.00, status: 'unpaid', dueDateMs: futureMs, dataKey })

    const res = await agent.get('/api/bills')
    expect(res.status).toBe(200)
    const bill = res.body.bills[0]
    expect(bill).toHaveProperty('id')
    expect(bill).toHaveProperty('biller', 'TNB')
    expect(bill).toHaveProperty('amount_rm', 88.00)
    expect(bill).toHaveProperty('status', 'unpaid')
    expect(bill).toHaveProperty('due_date')
    expect(bill).toHaveProperty('subject')   // decrypted subject from the joined email
    expect(bill.subject_enc).toBeUndefined() // encrypted field must be stripped
  })

  it('filters by status=unpaid and excludes paid bills', async () => {
    const { agent, id: userId, dataKey } = await createTestUser()
    seedBill(userId, { status: 'unpaid', dataKey })
    seedBill(userId, { status: 'paid', dataKey })

    const res = await agent.get('/api/bills?status=unpaid')
    expect(res.status).toBe(200)
    expect(res.body.bills.every((b: any) => b.status === 'unpaid')).toBe(true)
  })

  it('filters by status=paid', async () => {
    const { agent, id: userId, dataKey } = await createTestUser()
    seedBill(userId, { status: 'paid', dataKey })
    seedBill(userId, { status: 'unpaid', dataKey })

    const res = await agent.get('/api/bills?status=paid')
    expect(res.status).toBe(200)
    expect(res.body.bills.every((b: any) => b.status === 'paid')).toBe(true)
  })

  it('returns 400 for an invalid status filter', async () => {
    const { agent } = await createTestUser()
    const res = await agent.get('/api/bills?status=suspicious')
    expect(res.status).toBe(400)
  })

  it('returns bills ordered by due_date ascending', async () => {
    const { agent, id: userId, dataKey } = await createTestUser()
    const now = Date.now()
    seedBill(userId, { dueDateMs: now + 7 * 24 * 60 * 60 * 1000, dataKey })   // 7 days
    seedBill(userId, { dueDateMs: now + 2 * 24 * 60 * 60 * 1000, dataKey })   // 2 days (should be first)

    const res = await agent.get('/api/bills')
    expect(res.status).toBe(200)
    expect(res.body.bills).toHaveLength(2)
    expect(res.body.bills[0].due_date).toBeLessThan(res.body.bills[1].due_date)
  })
})

// ── PATCH /api/bills/:id/status ────────────────────────────────────────────────

describe('PATCH /api/bills/:id/status', () => {
  it('returns 401 without session', async () => {
    const { default: request } = await import('supertest')
    const { app } = await import('../../src/server')
    const res = await request(app)
      .patch('/api/bills/some-id/status')
      .send({ status: 'paid' })
    expect(res.status).toBe(401)
  })

  it('marks an unpaid bill as paid', async () => {
    const { agent, id: userId } = await createTestUser()
    const { billId } = seedBill(userId, { status: 'unpaid' })

    const res = await agent.patch(`/api/bills/${billId}/status`).send({ status: 'paid' })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)

    const row = getDb().prepare('SELECT status FROM parsed_bills WHERE id = ?').get(billId) as any
    expect(row.status).toBe('paid')
  })

  it('marks a paid bill back to unpaid', async () => {
    const { agent, id: userId } = await createTestUser()
    const { billId } = seedBill(userId, { status: 'paid' })

    const res = await agent.patch(`/api/bills/${billId}/status`).send({ status: 'unpaid' })
    expect(res.status).toBe(200)

    const row = getDb().prepare('SELECT status FROM parsed_bills WHERE id = ?').get(billId) as any
    expect(row.status).toBe('unpaid')
  })

  it('marks a bill as overdue', async () => {
    const { agent, id: userId } = await createTestUser()
    const { billId } = seedBill(userId, { status: 'unpaid' })

    const res = await agent.patch(`/api/bills/${billId}/status`).send({ status: 'overdue' })
    expect(res.status).toBe(200)

    const row = getDb().prepare('SELECT status FROM parsed_bills WHERE id = ?').get(billId) as any
    expect(row.status).toBe('overdue')
  })

  it('returns 400 for an invalid status value', async () => {
    const { agent, id: userId } = await createTestUser()
    const { billId } = seedBill(userId, { status: 'unpaid' })

    const res = await agent.patch(`/api/bills/${billId}/status`).send({ status: 'unknown' })
    expect(res.status).toBe(400)
  })

  it('returns 404 for a bill that does not exist', async () => {
    const { agent } = await createTestUser()
    const res = await agent.patch('/api/bills/does-not-exist/status').send({ status: 'paid' })
    expect(res.status).toBe(404)
  })

  it('returns 404 when the bill belongs to a different user', async () => {
    const { id: userId1 } = await createTestUser()
    const { agent: agent2 } = await createTestUser()
    const { billId } = seedBill(userId1, { status: 'unpaid' })

    const res = await agent2.patch(`/api/bills/${billId}/status`).send({ status: 'paid' })
    expect(res.status).toBe(404)

    // Confirm bill was NOT changed
    const row = getDb().prepare('SELECT status FROM parsed_bills WHERE id = ?').get(billId) as any
    expect(row.status).toBe('unpaid')
  })
})
