// tests/routes/email-labels.test.ts
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
  ).run(id, `${id}@el-test.com`, encryptSystem('{}'), Date.now(), userId)
  return id
}

function seedEmail(accountId: string, dataKey: Buffer) {
  const id = randomUUID()
  getDb().prepare(
    `INSERT INTO emails (id, account_id, subject_enc, sender, received_at, is_read, folder, tab)
     VALUES (?, ?, ?, ?, ?, 0, 'inbox', 'primary')`
  ).run(id, accountId, encrypt('Label Test', dataKey), 'from@test.com', Date.now())
  return id
}

async function createLabel(agent: any, name: string) {
  const res = await agent.post('/api/labels').send({ name })
  return res.body.id as string
}

describe('POST /api/emails/:id/labels/:labelId', () => {
  it('assigns a label to an email', async () => {
    const { agent, id: userId, dataKey } = await createTestUser()
    const accountId = seedAccount(userId)
    const emailId = seedEmail(accountId, dataKey)
    const labelId = await createLabel(agent, 'Assignment')
    const res = await agent.post(`/api/emails/${emailId}/labels/${labelId}`)
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    const row = getDb().prepare('SELECT * FROM email_labels WHERE email_id = ? AND label_id = ?').get(emailId, labelId)
    expect(row).toBeDefined()
  })

  it('is idempotent — second call still returns 200', async () => {
    const { agent, id: userId, dataKey } = await createTestUser()
    const accountId = seedAccount(userId)
    const emailId = seedEmail(accountId, dataKey)
    const labelId = await createLabel(agent, 'Idempotent')
    await agent.post(`/api/emails/${emailId}/labels/${labelId}`)
    const res = await agent.post(`/api/emails/${emailId}/labels/${labelId}`)
    expect(res.status).toBe(200)
    const rows = getDb().prepare('SELECT * FROM email_labels WHERE email_id = ? AND label_id = ?').all(emailId, labelId)
    expect(rows).toHaveLength(1)  // not duplicated
  })

  it('returns 404 when email belongs to another user', async () => {
    const { id: userId1, dataKey: dataKey1 } = await createTestUser()
    const accountId1 = seedAccount(userId1)
    const emailId = seedEmail(accountId1, dataKey1)
    const { agent: agent2 } = await createTestUser()
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
    const { agent: agent2, id: userId2, dataKey: dataKey2 } = await createTestUser()
    const accountId2 = seedAccount(userId2)
    const emailId = seedEmail(accountId2, dataKey2)
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
    const { agent, id: userId, dataKey } = await createTestUser()
    const accountId = seedAccount(userId)
    const emailId = seedEmail(accountId, dataKey)
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
    const { agent: agent2, id: userId2, dataKey: dataKey2 } = await createTestUser()
    const accountId2 = seedAccount(userId2)
    const emailId = seedEmail(accountId2, dataKey2)
    const res = await agent2.delete(`/api/emails/${emailId}/labels/${labelId}`)
    expect(res.status).toBe(404)
  })
})

describe('Labels appear in GET /api/emails response', () => {
  it('includes labels array in email list response', async () => {
    const { agent, id: userId, dataKey } = await createTestUser()
    const accountId = seedAccount(userId)
    const emailId = seedEmail(accountId, dataKey)
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
    const { agent, id: userId, dataKey } = await createTestUser()
    const accountId = seedAccount(userId)
    const emailId = seedEmail(accountId, dataKey)
    const labelId = await createLabel(agent, 'InDetail')
    await agent.post(`/api/emails/${emailId}/labels/${labelId}`)

    const res = await agent.get(`/api/emails/${emailId}`)
    expect(res.status).toBe(200)
    expect(res.body.labels).toBeInstanceOf(Array)
    expect(res.body.labels[0].name).toBe('InDetail')
  })

  it('unlabelled email has labels: []', async () => {
    const { agent, id: userId, dataKey } = await createTestUser()
    const accountId = seedAccount(userId)
    const emailId = seedEmail(accountId, dataKey)
    const res = await agent.get('/api/emails')
    const email = res.body.emails.find((e: any) => e.id === emailId)
    expect(email.labels).toEqual([])
  })

  it('multi-label email appears exactly once in list', async () => {
    const { agent, id: userId, dataKey } = await createTestUser()
    const accountId = seedAccount(userId)
    const emailId = seedEmail(accountId, dataKey)
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
    const { agent, id: userId, dataKey } = await createTestUser()
    const accountId = seedAccount(userId)
    const labelledId = seedEmail(accountId, dataKey)
    const unlabelledId = seedEmail(accountId, dataKey)
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
