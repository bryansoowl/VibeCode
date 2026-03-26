// tests/routes/auth-reset.test.ts
import { describe, it, expect, afterAll } from 'vitest'
import request from 'supertest'
import { app } from '../../src/server'
import { closeDb, getDb } from '../../src/db'
import { createHash, randomBytes } from 'crypto'
import { randomUUID } from 'crypto'

afterAll(() => closeDb())

function email() { return `reset-${randomUUID()}@example.com` }

describe('POST /auth/forgot-password', () => {
  it('always returns 200 (prevents email enumeration)', async () => {
    const res = await request(app)
      .post('/auth/forgot-password')
      .send({ email: 'nobody@example.com' })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
  })

  it('creates a reset token for existing user', async () => {
    const e = email()
    await request(app).post('/auth/signup').send({ email: e, password: 'Password123!' })
    await request(app).post('/auth/forgot-password').send({ email: e })
    const user = getDb().prepare('SELECT id FROM users WHERE email = ?').get(e) as any
    const token = getDb().prepare(
      'SELECT id FROM password_reset_tokens WHERE user_id = ? AND used = 0'
    ).get(user.id)
    expect(token).toBeDefined()
  })
})

describe('POST /auth/reset-password', () => {
  async function setupReset() {
    const e = email()
    await request(app).post('/auth/signup').send({ email: e, password: 'OldPass123!' })
    const user = getDb().prepare('SELECT id FROM users WHERE email = ?').get(e) as any

    const rawToken = randomBytes(32).toString('hex')
    const tokenHash = createHash('sha256').update(rawToken).digest('hex')
    getDb().prepare(
      'INSERT INTO password_reset_tokens (id, user_id, token_hash, expires_at, used) VALUES (?, ?, ?, ?, 0)'
    ).run(randomUUID(), user.id, tokenHash, Date.now() + 3600_000)

    return { email: e, userId: user.id, rawToken }
  }

  it('resets password and allows login with new password', async () => {
    const { email: e, rawToken } = await setupReset()
    const res = await request(app)
      .post('/auth/reset-password')
      .send({ token: rawToken, newPassword: 'NewPass456!' })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)

    const loginRes = await request(app)
      .post('/auth/login')
      .send({ email: e, password: 'NewPass456!' })
    expect(loginRes.status).toBe(200)
  })

  it('rejects old password after reset', async () => {
    const { email: e, rawToken } = await setupReset()
    await request(app).post('/auth/reset-password').send({ token: rawToken, newPassword: 'NewPass456!' })
    const loginRes = await request(app).post('/auth/login').send({ email: e, password: 'OldPass123!' })
    expect(loginRes.status).toBe(401)
  })

  it('returns 400 for expired token', async () => {
    const { rawToken } = await setupReset()
    const tokenHash = createHash('sha256').update(rawToken).digest('hex')
    getDb().prepare('UPDATE password_reset_tokens SET expires_at = ? WHERE token_hash = ?')
      .run(Date.now() - 1000, tokenHash)
    const res = await request(app)
      .post('/auth/reset-password')
      .send({ token: rawToken, newPassword: 'NewPass456!' })
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('expired')
  })

  it('returns 400 for already-used token', async () => {
    const { rawToken } = await setupReset()
    await request(app).post('/auth/reset-password').send({ token: rawToken, newPassword: 'NewPass456!' })
    const res = await request(app)
      .post('/auth/reset-password')
      .send({ token: rawToken, newPassword: 'AnotherPass789!' })
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('used')
  })
})
