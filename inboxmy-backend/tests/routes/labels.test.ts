// tests/routes/labels.test.ts
import { describe, it, expect, afterAll } from 'vitest'
import request from 'supertest'
import { app } from '../../src/server'
import { getDb, closeDb } from '../../src/db'
import { randomUUID } from 'crypto'
import { encryptSystem } from '../../src/crypto'
import { createTestUser } from '../helpers/auth'

afterAll(() => closeDb())

function seedAccount(userId: string) {
  const id = randomUUID()
  getDb().prepare(
    `INSERT OR IGNORE INTO accounts (id, provider, email, token_enc, created_at, user_id)
     VALUES (?, 'gmail', ?, ?, ?, ?)`
  ).run(id, `${id}@label-test.com`, encryptSystem('{}'), Date.now(), userId)
  return id
}

function seedEmail(userId: string, accountId: string) {
  const id = randomUUID()
  getDb().prepare(
    `INSERT INTO emails (id, account_id, subject_enc, sender, received_at, is_read, folder, tab)
     VALUES (?, ?, ?, ?, ?, 0, 'inbox', 'primary')`
  ).run(id, accountId, encryptSystem('Subject'), 'from@test.com', Date.now())
  return id
}

describe('GET /api/labels', () => {
  it('returns empty array when user has no labels', async () => {
    const { agent } = await createTestUser()
    const res = await agent.get('/api/labels')
    expect(res.status).toBe(200)
    expect(res.body).toEqual([])
  })

  it('returns 401 without session', async () => {
    const res = await request(app).get('/api/labels')
    expect(res.status).toBe(401)
  })

  it('returns labels with count field', async () => {
    const { agent, id: userId } = await createTestUser()
    const accountId = seedAccount(userId)
    const emailId = seedEmail(userId, accountId)
    // Create label
    const create = await agent.post('/api/labels').send({ name: 'Work', color: '#3B82F6' })
    expect(create.status).toBe(201)
    const labelId = create.body.id
    // Assign to email
    await agent.post(`/api/emails/${emailId}/labels/${labelId}`)
    // List
    const res = await agent.get('/api/labels')
    expect(res.status).toBe(200)
    expect(res.body).toHaveLength(1)
    expect(res.body[0].count).toBe(1)
    expect(res.body[0].name).toBe('Work')
    expect(res.body[0].color).toBe('#3B82F6')
  })
})

describe('POST /api/labels', () => {
  it('creates a label with name and default color', async () => {
    const { agent } = await createTestUser()
    const res = await agent.post('/api/labels').send({ name: 'Finance' })
    expect(res.status).toBe(201)
    expect(res.body.id).toBeDefined()
    expect(res.body.name).toBe('Finance')
    expect(res.body.color).toBe('#6B7280')
  })

  it('creates a label with custom color', async () => {
    const { agent } = await createTestUser()
    const res = await agent.post('/api/labels').send({ name: 'Urgent', color: '#EF4444' })
    expect(res.status).toBe(201)
    expect(res.body.color).toBe('#EF4444')
  })

  it('returns 400 when name exceeds 50 chars', async () => {
    const { agent } = await createTestUser()
    const res = await agent.post('/api/labels').send({ name: 'x'.repeat(51) })
    expect(res.status).toBe(400)
  })

  it('returns 400 when color is not a valid hex', async () => {
    const { agent } = await createTestUser()
    const res = await agent.post('/api/labels').send({ name: 'Test', color: 'red' })
    expect(res.status).toBe(400)
  })

  it('returns 409 for duplicate name within same user', async () => {
    const { agent } = await createTestUser()
    await agent.post('/api/labels').send({ name: 'Dup' })
    const res = await agent.post('/api/labels').send({ name: 'Dup' })
    expect(res.status).toBe(409)
  })

  it('two different users can have labels with same name', async () => {
    const { agent: a1 } = await createTestUser()
    const { agent: a2 } = await createTestUser()
    const r1 = await a1.post('/api/labels').send({ name: 'Shared' })
    const r2 = await a2.post('/api/labels').send({ name: 'Shared' })
    expect(r1.status).toBe(201)
    expect(r2.status).toBe(201)
  })
})

describe('PATCH /api/labels/:id', () => {
  it('renames a label', async () => {
    const { agent } = await createTestUser()
    const { body: { id } } = await agent.post('/api/labels').send({ name: 'Old' })
    const res = await agent.patch(`/api/labels/${id}`).send({ name: 'New' })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    const row = getDb().prepare('SELECT name FROM labels WHERE id = ?').get(id) as any
    expect(row.name).toBe('New')
  })

  it('recolors a label', async () => {
    const { agent } = await createTestUser()
    const { body: { id } } = await agent.post('/api/labels').send({ name: 'Colorful' })
    const res = await agent.patch(`/api/labels/${id}`).send({ color: '#10B981' })
    expect(res.status).toBe(200)
    const row = getDb().prepare('SELECT color FROM labels WHERE id = ?').get(id) as any
    expect(row.color).toBe('#10B981')
  })

  it('returns 404 when label belongs to another user', async () => {
    const { id: userId1 } = await createTestUser()
    const labelId = randomUUID()
    getDb().prepare(
      `INSERT INTO labels (id, user_id, name, color, created_at) VALUES (?, ?, ?, ?, ?)`
    ).run(labelId, userId1, 'User1Label', '#6B7280', Date.now())
    const { agent: agent2 } = await createTestUser()
    const res = await agent2.patch(`/api/labels/${labelId}`).send({ name: 'Hijack' })
    expect(res.status).toBe(404)
  })
})

describe('DELETE /api/labels/:id', () => {
  it('deletes a label', async () => {
    const { agent } = await createTestUser()
    const { body: { id } } = await agent.post('/api/labels').send({ name: 'ToDelete' })
    const res = await agent.delete(`/api/labels/${id}`)
    expect(res.status).toBe(200)
    const row = getDb().prepare('SELECT id FROM labels WHERE id = ?').get(id)
    expect(row).toBeUndefined()
  })

  it('cascades to email_labels on delete', async () => {
    const { agent, id: userId } = await createTestUser()
    const accountId = seedAccount(userId)
    const emailId = seedEmail(userId, accountId)
    const { body: { id: labelId } } = await agent.post('/api/labels').send({ name: 'CascadeTest' })
    await agent.post(`/api/emails/${emailId}/labels/${labelId}`)
    // Confirm assignment exists
    const before = getDb().prepare('SELECT * FROM email_labels WHERE label_id = ?').all(labelId)
    expect(before).toHaveLength(1)
    // Delete label
    await agent.delete(`/api/labels/${labelId}`)
    // Junction row should be gone
    const after = getDb().prepare('SELECT * FROM email_labels WHERE label_id = ?').all(labelId)
    expect(after).toHaveLength(0)
  })

  it('returns 404 when label belongs to another user', async () => {
    const { id: userId1 } = await createTestUser()
    const labelId = randomUUID()
    getDb().prepare(
      `INSERT INTO labels (id, user_id, name, color, created_at) VALUES (?, ?, ?, ?, ?)`
    ).run(labelId, userId1, 'Protected', '#6B7280', Date.now())
    const { agent: agent2 } = await createTestUser()
    const res = await agent2.delete(`/api/labels/${labelId}`)
    expect(res.status).toBe(404)
  })
})
