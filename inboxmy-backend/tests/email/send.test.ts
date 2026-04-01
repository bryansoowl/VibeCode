// tests/email/send.test.ts
import { vi, describe, it, expect, beforeEach, afterAll } from 'vitest'

// Mock auth modules before importing send
vi.mock('../../src/auth/gmail', () => ({
  getAuthedClient: vi.fn(),
}))
vi.mock('../../src/auth/outlook', () => ({
  getAccessToken: vi.fn(),
}))

// Mock googleapis — intercept the gmail client
const mockSend = vi.fn()
vi.mock('googleapis', () => ({
  google: {
    gmail: vi.fn().mockReturnValue({
      users: { messages: { send: mockSend } },
    }),
  },
}))

import { getAuthedClient } from '../../src/auth/gmail'
import { getAccessToken } from '../../src/auth/outlook'
import { getDb, closeDb } from '../../src/db'
import { encryptSystem } from '../../src/crypto'
import { randomUUID } from 'crypto'

afterAll(() => closeDb())

function seedAccount(provider: 'gmail' | 'outlook' = 'gmail') {
  const id = randomUUID()
  getDb().prepare(`
    INSERT INTO accounts (id, provider, email, token_enc, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, provider, `${id}@send-test.com`, encryptSystem('{}'), Date.now())
  return id
}

describe('sendEmail — Gmail', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mockSend.mockResolvedValue({ data: {} })
    vi.mocked(getAuthedClient).mockResolvedValue({} as any)
  })

  it('calls gmail.users.messages.send with a base64url raw payload', async () => {
    const accountId = seedAccount('gmail')
    const { sendEmail } = await import('../../src/email/send')
    await sendEmail(accountId, {
      to: 'dest@example.com',
      subject: 'Hello',
      bodyHtml: '<p>Hi there</p>',
    })
    expect(mockSend).toHaveBeenCalledOnce()
    const call = mockSend.mock.calls[0][0]
    expect(call.userId).toBe('me')
    expect(call.requestBody.raw).toBeDefined()

    // Decode and validate RFC 2822 headers
    const decoded = Buffer.from(call.requestBody.raw, 'base64url').toString('utf8')
    expect(decoded).toContain('From:')
    expect(decoded).toContain('To: dest@example.com')
    expect(decoded).toContain('Subject: Hello')
    expect(decoded).toContain('Content-Type: text/html')
  })

  it('propagates auth errors from getAuthedClient', async () => {
    const accountId = seedAccount('gmail')
    vi.mocked(getAuthedClient).mockRejectedValue(new Error('invalid_grant'))
    const { sendEmail } = await import('../../src/email/send')
    await expect(sendEmail(accountId, { to: 'a@b.com', subject: 'x', bodyHtml: 'y' }))
      .rejects.toThrow('invalid_grant')
  })
})

describe('sendEmail — Outlook', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(getAccessToken).mockResolvedValue('fake-token')
    global.fetch = vi.fn().mockResolvedValue({ ok: true } as any)
  })

  it('calls Graph API sendMail with correct JSON body', async () => {
    const accountId = seedAccount('outlook')
    const { sendEmail } = await import('../../src/email/send')
    await sendEmail(accountId, {
      to: 'dest@example.com',
      subject: 'Hello Outlook',
      bodyHtml: '<p>Hi</p>',
    })
    expect(global.fetch).toHaveBeenCalledOnce()
    const [url, opts] = (global.fetch as any).mock.calls[0]
    expect(url).toBe('https://graph.microsoft.com/v1.0/me/sendMail')
    const body = JSON.parse(opts.body)
    expect(body.message.subject).toBe('Hello Outlook')
    expect(body.message.toRecipients[0].emailAddress.address).toBe('dest@example.com')
    expect(body.message.body.content).toBe('<p>Hi</p>')
  })

  it('propagates re-auth errors from getAccessToken', async () => {
    const accountId = seedAccount('outlook')
    vi.mocked(getAccessToken).mockRejectedValue(
      new Error('Outlook account not found in MSAL cache — re-auth required')
    )
    const { sendEmail } = await import('../../src/email/send')
    await expect(sendEmail(accountId, { to: 'a@b.com', subject: 'x', bodyHtml: 'y' }))
      .rejects.toThrow('re-auth required')
  })

  it('throws when Graph API returns non-ok response', async () => {
    const accountId = seedAccount('outlook')
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => 'Forbidden',
    } as any)
    const { sendEmail } = await import('../../src/email/send')
    await expect(sendEmail(accountId, { to: 'a@b.com', subject: 'x', bodyHtml: 'y' }))
      .rejects.toThrow()
  })
})
