// tests/middleware/auth.test.ts
import { describe, it, expect, afterAll } from 'vitest'
import { closeDb, getDb } from '../../src/db'
import { createTestUser } from '../helpers/auth'
import request from 'supertest'
import { app } from '../../src/server'

afterAll(() => closeDb())

describe('requireAuth middleware', () => {
  it('allows request through with valid session', async () => {
    const { agent } = await createTestUser()
    const res = await agent.get('/api/accounts')
    expect(res.status).toBe(200)
  })

  it('returns 401 with no cookie', async () => {
    const res = await request(app).get('/api/accounts')
    expect(res.status).toBe(401)
    expect(res.body.error).toBeDefined()
  })

  it('returns 401 with a made-up session id', async () => {
    const res = await request(app)
      .get('/api/accounts')
      .set('Cookie', 'session=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
    expect(res.status).toBe(401)
  })

  it('returns 401 for session older than 30 days', async () => {
    const { agent, id: userId } = await createTestUser()
    // Manually age the session in the DB
    getDb().prepare('UPDATE sessions SET created_at = ? WHERE user_id = ?')
      .run(Date.now() - (31 * 24 * 60 * 60 * 1000), userId)
    const res = await agent.get('/api/accounts')
    expect(res.status).toBe(401)
  })
})
