import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { validateConfig } from '../src/config'

describe('validateConfig', () => {
  let logs: string[]

  beforeEach(() => {
    logs = []
    vi.spyOn(console, 'log').mockImplementation((msg: string) => { logs.push(msg) })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('shows [✓] for Gmail when both Google creds are set', () => {
    process.env.GOOGLE_CLIENT_ID = 'test.apps.googleusercontent.com'
    process.env.GOOGLE_CLIENT_SECRET = 'a-secret'
    delete process.env.MICROSOFT_CLIENT_ID
    delete process.env.MICROSOFT_CLIENT_SECRET

    validateConfig()

    const output = logs.join('\n')
    expect(output).toContain('[✓] Gmail')
  })

  it('shows [ ] for Gmail and setup hint when Google Client ID is missing', () => {
    delete process.env.GOOGLE_CLIENT_ID
    process.env.GOOGLE_CLIENT_SECRET = 'a-secret'

    validateConfig()

    const output = logs.join('\n')
    expect(output).toContain('[ ] Gmail')
    expect(output).toContain('npm run setup')
  })

  it('shows [ ] for Gmail when Google Client Secret is missing', () => {
    process.env.GOOGLE_CLIENT_ID = 'test.apps.googleusercontent.com'
    delete process.env.GOOGLE_CLIENT_SECRET

    validateConfig()

    const output = logs.join('\n')
    expect(output).toContain('[ ] Gmail')
  })

  it('shows [✓] for Outlook when both Microsoft creds are set', () => {
    process.env.MICROSOFT_CLIENT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    process.env.MICROSOFT_CLIENT_SECRET = 'a-secret'

    validateConfig()

    const output = logs.join('\n')
    expect(output).toContain('[✓] Outlook')
  })

  it('shows [ ] for Outlook and setup hint when Microsoft creds are missing', () => {
    delete process.env.MICROSOFT_CLIENT_ID
    delete process.env.MICROSOFT_CLIENT_SECRET

    validateConfig()

    const output = logs.join('\n')
    expect(output).toContain('[ ] Outlook')
    expect(output).toContain('npm run setup')
  })

  it('does not print setup hint when all creds are set', () => {
    process.env.GOOGLE_CLIENT_ID = 'test.apps.googleusercontent.com'
    process.env.GOOGLE_CLIENT_SECRET = 'a-secret'
    process.env.MICROSOFT_CLIENT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    process.env.MICROSOFT_CLIENT_SECRET = 'a-secret'

    validateConfig()

    const output = logs.join('\n')
    expect(output).not.toContain('npm run setup')
  })
})
