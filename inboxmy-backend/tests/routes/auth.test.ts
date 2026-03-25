// tests/routes/auth.test.ts
import { describe, it, expect, afterAll } from 'vitest'
import request from 'supertest'
import { app } from '../../src/server'
import { closeDb, getDb } from '../../src/db'
import { randomUUID } from 'crypto'

afterAll(() => closeDb())

function email() { return `auth-${randomUUID()}@example.com` }

describe('POST /auth/signup', () => {
  it('creates a user and returns a session cookie', async () => {
    const res = await request(app)
      .post('/auth/signup')
      .send({ email: email(), password: 'Password123!' })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.user.email).toBeDefined()
    expect(res.body.user.id).toBeDefined()
    const cookie = res.headers['set-cookie']
    expect(cookie).toBeDefined()
    expect(Array.isArray(cookie) ? cookie[0] : cookie).toContain('HttpOnly')
  })

  it('returns 409 for duplicate email', async () => {
    const e = email()
    await request(app).post('/auth/signup').send({ email: e, password: 'Password123!' })
    const res = await request(app).post('/auth/signup').send({ email: e, password: 'Password123!' })
    expect(res.status).toBe(409)
  })

  it('returns 400 for password under 8 chars', async () => {
    const res = await request(app)
      .post('/auth/signup')
      .send({ email: email(), password: 'short' })
    expect(res.status).toBe(400)
  })

  it('returns 400 for missing email', async () => {
    const res = await request(app).post('/auth/signup').send({ password: 'Password123!' })
    expect(res.status).toBe(400)
  })
})

describe('POST /auth/login', () => {
  it('returns a session cookie on correct credentials', async () => {
    const e = email()
    await request(app).post('/auth/signup').send({ email: e, password: 'Password123!' })
    const res = await request(app).post('/auth/login').send({ email: e, password: 'Password123!' })
    expect(res.status).toBe(200)
    expect(res.body.user.email).toBe(e)
    expect(res.headers['set-cookie']).toBeDefined()
  })

  it('returns 401 for wrong password', async () => {
    const e = email()
    await request(app).post('/auth/signup').send({ email: e, password: 'Password123!' })
    const res = await request(app).post('/auth/login').send({ email: e, password: 'WrongPass!' })
    expect(res.status).toBe(401)
    expect(res.body.error).toBe('Invalid email or password')
  })

  it('returns 401 for unknown email', async () => {
    const res = await request(app)
      .post('/auth/login')
      .send({ email: 'nobody@example.com', password: 'Password123!' })
    expect(res.status).toBe(401)
  })
})

describe('GET /auth/me', () => {
  it('returns the user when authenticated', async () => {
    const agent = request.agent(app)
    const e = email()
    await agent.post('/auth/signup').send({ email: e, password: 'Password123!' })
    const res = await agent.get('/auth/me')
    expect(res.status).toBe(200)
    expect(res.body.user.email).toBe(e)
  })

  it('returns 401 without a session', async () => {
    const res = await request(app).get('/auth/me')
    expect(res.status).toBe(401)
  })
})

describe('POST /auth/logout', () => {
  it('clears the session and subsequent /auth/me returns 401', async () => {
    const agent = request.agent(app)
    await agent.post('/auth/signup').send({ email: email(), password: 'Password123!' })
    await agent.post('/auth/logout')
    const res = await agent.get('/auth/me')
    expect(res.status).toBe(401)
  })
})
