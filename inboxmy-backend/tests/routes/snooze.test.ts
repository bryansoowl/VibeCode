// tests/routes/snooze.test.ts
import { describe, it, expect, afterAll } from 'vitest'
import request from 'supertest'
import { app } from '../../src/server'
import { getDb, closeDb } from '../../src/db'
import { encryptSystem, encrypt } from '../../src/crypto'
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

function seedEmail(userId: string, accountId: string, overrides: Record<string, any> = {}, dataKey?: Buffer) {
  const id = randomUUID()
  const subjectEnc = dataKey ? encrypt('Snooze Test', dataKey) : encryptSystem('Snooze Test')
  getDb().prepare(
    `INSERT INTO emails (id, account_id, subject_enc, sender, received_at, is_read, folder, tab)
     VALUES (?, ?, ?, ?, ?, 0, 'inbox', 'primary')`
  ).run(id, accountId, subjectEnc, 'from@test.com', Date.now())
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

  it('returns 200 idempotently when email is not snoozed', async () => {
    const { agent, id: userId } = await createTestUser()
    const accountId = seedAccount(userId)
    const emailId = seedEmail(userId, accountId)  // not snoozed
    const res = await agent.delete(`/api/emails/${emailId}/snooze`)
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
  })
})

describe('GET /api/emails — snooze exclusion', () => {
  it('excludes snoozed emails from default list', async () => {
    const { agent, id: userId, dataKey } = await createTestUser()
    const accountId = seedAccount(userId)
    const normalId = seedEmail(userId, accountId, {}, dataKey)
    const snoozedId = seedEmail(userId, accountId, { snoozed_until: FUTURE }, dataKey)

    const res = await agent.get('/api/emails')
    expect(res.status).toBe(200)
    const ids = res.body.emails.map((e: any) => e.id)
    expect(ids).toContain(normalId)
    expect(ids).not.toContain(snoozedId)
  })

  it('shows only snoozed emails with ?snoozed=1', async () => {
    const { agent, id: userId, dataKey } = await createTestUser()
    const accountId = seedAccount(userId)
    const normalId = seedEmail(userId, accountId, {}, dataKey)
    const snoozedId = seedEmail(userId, accountId, { snoozed_until: FUTURE }, dataKey)

    const res = await agent.get('/api/emails?snoozed=1')
    expect(res.status).toBe(200)
    const ids = res.body.emails.map((e: any) => e.id)
    expect(ids).toContain(snoozedId)
    expect(ids).not.toContain(normalId)
  })

  it('snoozed email is excluded from folder=inbox view', async () => {
    const { agent, id: userId, dataKey } = await createTestUser()
    const accountId = seedAccount(userId)
    const snoozedId = seedEmail(userId, accountId, { snoozed_until: FUTURE }, dataKey)
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
