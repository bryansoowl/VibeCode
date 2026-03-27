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
