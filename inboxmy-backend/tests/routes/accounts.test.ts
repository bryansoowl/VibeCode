// tests/routes/accounts.test.ts
import { describe, it, expect, afterAll } from 'vitest'
import { closeDb, getDb } from '../../src/db'
import { encryptSystem } from '../../src/crypto'
import { randomUUID } from 'crypto'
import { createTestUser } from '../helpers/auth'

afterAll(() => closeDb())

function seedAccount(userId: string, id: string, email: string) {
  getDb().prepare(`
    INSERT OR IGNORE INTO accounts (id, provider, email, token_enc, created_at, user_id)
    VALUES (?, 'gmail', ?, ?, ?, ?)
  `).run(id, email, encryptSystem('{}'), Date.now(), userId)
}

describe('GET /api/accounts', () => {
  it('returns list for authenticated user', async () => {
    const { agent } = await createTestUser()
    const res = await agent.get('/api/accounts')
    expect(res.status).toBe(200)
    expect(res.body.accounts).toBeInstanceOf(Array)
  })

  it('returns 401 without session', async () => {
    const { default: request } = await import('supertest')
    const { app } = await import('../../src/server')
    const res = await request(app).get('/api/accounts')
    expect(res.status).toBe(401)
  })
})

describe('PATCH /api/accounts/:id/label', () => {
  it('updates the label', async () => {
    const { agent, id: userId } = await createTestUser()
    const id = randomUUID()
    seedAccount(userId, id, `label-test-${id}@test.com`)
    const res = await agent.patch(`/api/accounts/${id}/label`).send({ label: 'Work Gmail' })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    const row = getDb().prepare('SELECT label FROM accounts WHERE id = ?').get(id) as any
    expect(row.label).toBe('Work Gmail')
  })

  it('returns 400 for non-string label', async () => {
    const { agent } = await createTestUser()
    const res = await agent.patch('/api/accounts/any-id/label').send({ label: 123 })
    expect(res.status).toBe(400)
  })
})

describe('DELETE /api/accounts/:id', () => {
  it('deletes an existing account', async () => {
    const { agent, id: userId } = await createTestUser()
    const id = randomUUID()
    seedAccount(userId, id, `delete-test-${id}@test.com`)
    const res = await agent.delete(`/api/accounts/${id}`)
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    const row = getDb().prepare('SELECT id FROM accounts WHERE id = ?').get(id)
    expect(row).toBeUndefined()
  })

  it('returns 404 for non-existent account', async () => {
    const { agent } = await createTestUser()
    const res = await agent.delete('/api/accounts/does-not-exist')
    expect(res.status).toBe(404)
  })
})
