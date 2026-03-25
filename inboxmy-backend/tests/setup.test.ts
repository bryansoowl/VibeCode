import { describe, it, expect } from 'vitest'
import {
  isValidGoogleClientId,
  isValidAzureClientId,
  isValidSecret,
  buildEnvContent,
} from '../scripts/setup'

describe('isValidGoogleClientId', () => {
  it('accepts a valid Google client ID', () => {
    expect(isValidGoogleClientId('202736727260-abc.apps.googleusercontent.com')).toBe(true)
  })

  it('rejects ID that does not end with .apps.googleusercontent.com', () => {
    expect(isValidGoogleClientId('notvalid')).toBe(false)
  })

  it('rejects empty string', () => {
    expect(isValidGoogleClientId('')).toBe(false)
  })

  it('rejects ID ending with just googleusercontent.com (missing .apps prefix)', () => {
    expect(isValidGoogleClientId('123.googleusercontent.com')).toBe(false)
  })
})

describe('isValidAzureClientId', () => {
  it('accepts a valid UUID', () => {
    expect(isValidAzureClientId('b14dc905-7164-429e-b85b-daf15dae9b87')).toBe(true)
  })

  it('rejects a non-UUID string', () => {
    expect(isValidAzureClientId('notauuid')).toBe(false)
  })

  it('rejects empty string', () => {
    expect(isValidAzureClientId('')).toBe(false)
  })

  it('rejects UUID with wrong segment lengths', () => {
    expect(isValidAzureClientId('b14dc905-7164-429e-b85b-daf15dae9b8')).toBe(false)
  })
})

describe('isValidSecret', () => {
  it('accepts a non-empty string', () => {
    expect(isValidSecret('GOCSPX-something')).toBe(true)
  })

  it('rejects empty string', () => {
    expect(isValidSecret('')).toBe(false)
  })

  it('rejects whitespace-only string', () => {
    expect(isValidSecret('   ')).toBe(false)
  })
})

describe('buildEnvContent', () => {
  it('writes all 10 variables', () => {
    const content = buildEnvContent({
      encryptionKey: 'a'.repeat(64),
      googleClientId: 'test.apps.googleusercontent.com',
      googleClientSecret: 'gsecret',
      microsoftClientId: 'b14dc905-7164-429e-b85b-daf15dae9b87',
      microsoftClientSecret: 'msecret',
    })

    expect(content).toContain('ENCRYPTION_KEY=' + 'a'.repeat(64))
    expect(content).toContain('GOOGLE_CLIENT_ID=test.apps.googleusercontent.com')
    expect(content).toContain('GOOGLE_CLIENT_SECRET=gsecret')
    expect(content).toContain('GOOGLE_REDIRECT_URI=http://localhost:3001/auth/gmail/callback')
    expect(content).toContain('MICROSOFT_CLIENT_ID=b14dc905-7164-429e-b85b-daf15dae9b87')
    expect(content).toContain('MICROSOFT_CLIENT_SECRET=msecret')
    expect(content).toContain('MICROSOFT_REDIRECT_URI=http://localhost:3001/auth/outlook/callback')
    expect(content).toContain('PORT=3001')
    expect(content).toContain('DATA_DIR=./data')
    expect(content).toContain('SYNC_INTERVAL_MINUTES=15')
  })

  it('writes empty strings for skipped providers', () => {
    const content = buildEnvContent({
      encryptionKey: 'a'.repeat(64),
      googleClientId: '',
      googleClientSecret: '',
      microsoftClientId: '',
      microsoftClientSecret: '',
    })

    expect(content).toContain('GOOGLE_CLIENT_ID=')
    expect(content).toContain('GOOGLE_CLIENT_SECRET=')
    expect(content).toContain('MICROSOFT_CLIENT_ID=')
    expect(content).toContain('MICROSOFT_CLIENT_SECRET=')
  })
})
