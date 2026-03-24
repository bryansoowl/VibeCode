// tests/routes/accounts.test.ts
import { describe, it, expect, afterAll } from 'vitest'
import request from 'supertest'
import { app } from '../../src/server'
import { getDb, closeDb } from '../../src/db'
import { encrypt } from '../../src/crypto'
import { randomUUID } from 'crypto'

function seedAccount(id: string, email: string) {
  getDb().prepare(`
    INSERT OR IGNORE INTO accounts (id, provider, email, token_enc, created_at)
    VALUES (?, 'gmail', ?, ?, ?)
  `).run(id, email, encrypt('{}'), Date.now())
}

afterAll(() => closeDb())

describe('GET /api/accounts', () => {
  it('returns list (may be empty)', async () => {
    const res = await request(app).get('/api/accounts')
    expect(res.status).toBe(200)
    expect(res.body.accounts).toBeInstanceOf(Array)
  })
})

describe('PATCH /api/accounts/:id/label', () => {
  it('updates the label', async () => {
    const id = randomUUID()
    seedAccount(id, `label-test-${id}@test.com`)
    const res = await request(app)
      .patch(`/api/accounts/${id}/label`)
      .send({ label: 'Work Gmail' })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    const row = getDb().prepare('SELECT label FROM accounts WHERE id = ?').get(id) as any
    expect(row.label).toBe('Work Gmail')
  })

  it('returns 400 for non-string label', async () => {
    const res = await request(app)
      .patch('/api/accounts/any-id/label')
      .send({ label: 123 })
    expect(res.status).toBe(400)
  })
})

describe('DELETE /api/accounts/:id', () => {
  it('deletes an existing account', async () => {
    const id = randomUUID()
    seedAccount(id, `delete-test-${id}@test.com`)
    const res = await request(app).delete(`/api/accounts/${id}`)
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    const row = getDb().prepare('SELECT id FROM accounts WHERE id = ?').get(id)
    expect(row).toBeUndefined()
  })

  it('returns 404 for non-existent account', async () => {
    const res = await request(app).delete('/api/accounts/does-not-exist')
    expect(res.status).toBe(404)
  })
})
