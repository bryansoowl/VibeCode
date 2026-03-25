// tests/helpers/auth.ts
// Creates a user and returns a supertest agent with a valid session cookie.
import request from 'supertest'
import { app } from '../../src/server'
import { randomUUID } from 'crypto'

export interface TestUser {
  id: string
  email: string
  password: string
  agent: ReturnType<typeof request.agent>
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

  return { id: res.body.user.id, email: userEmail, password, agent }
}
