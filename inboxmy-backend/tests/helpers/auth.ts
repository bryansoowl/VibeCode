// tests/helpers/auth.ts
// Creates a user and returns a supertest agent with a valid session cookie.
import request from 'supertest'
import { app } from '../../src/server'
import { randomUUID } from 'crypto'
import { getDb } from '../../src/db'
import { deriveWrapKey, unwrapKey } from '../../src/crypto'

export interface TestUser {
  id: string
  email: string
  password: string
  agent: ReturnType<typeof request.agent>
  dataKey: Buffer
}

export async function createTestUser(
  email?: string,
  password = 'TestPass123!'
): Promise<TestUser> {
  const userEmail = email ?? `test-${randomUUID()}@example.com`
  const agent = request.agent(app)

  const res = await agent
    .post('/auth/signup')
    .send({ email: userEmail, password })

  if (res.status !== 200) {
    throw new Error(`createTestUser failed: ${res.status} ${JSON.stringify(res.body)}`)
  }

  // Derive the user's dataKey so tests can seed encrypted data with the correct key
  const db = getDb()
  const user = db.prepare(
    'SELECT pbkdf2_salt, data_key_enc FROM users WHERE email = ?'
  ).get(userEmail.toLowerCase()) as any
  const salt = Buffer.from(user.pbkdf2_salt, 'base64')
  const wrapKeyBuf = deriveWrapKey(password, salt)
  const dataKey = unwrapKey(user.data_key_enc, wrapKeyBuf)

  return { id: res.body.user.id, email: userEmail, password, agent, dataKey }
}
