// tests/crypto.test.ts
import { randomBytes, createHash } from 'crypto'
import {
  encrypt, decrypt,
  encryptSystem, decryptSystem,
  wrapKey, unwrapKey,
  deriveWrapKey,
} from '../src/crypto'

describe('encryptSystem / decryptSystem (global ENCRYPTION_KEY)', () => {
  it('round-trips a plaintext string', () => {
    const plain = 'Hello, Malaysia!'
    const cipher = encryptSystem(plain)
    expect(cipher).not.toBe(plain)
    expect(decryptSystem(cipher)).toBe(plain)
  })

  it('produces different ciphertext for same input (random IV)', () => {
    const plain = 'same input'
    expect(encryptSystem(plain)).not.toBe(encryptSystem(plain))
  })

  it('throws on tampered ciphertext', () => {
    const cipher = encryptSystem('safe')
    const raw = Buffer.from(cipher, 'base64')
    raw[14] ^= 0xff  // flip a byte inside the 16-byte GCM tag (bytes 12–27)
    expect(() => decryptSystem(raw.toString('base64'))).toThrow()
  })
})

describe('encrypt / decrypt (explicit key)', () => {
  it('round-trips with a 32-byte key', () => {
    const key = randomBytes(32)
    const plain = 'per-user data'
    const cipher = encrypt(plain, key)
    expect(cipher).not.toBe(plain)
    expect(decrypt(cipher, key)).toBe(plain)
  })

  it('fails to decrypt with a different key', () => {
    const key1 = randomBytes(32)
    const key2 = randomBytes(32)
    const cipher = encrypt('secret', key1)
    expect(() => decrypt(cipher, key2)).toThrow()
  })

  it('produces different ciphertext each call (random IV)', () => {
    const key = randomBytes(32)
    expect(encrypt('abc', key)).not.toBe(encrypt('abc', key))
  })
})

describe('deriveWrapKey', () => {
  it('returns a 32-byte Buffer', () => {
    const salt = randomBytes(32)
    const key = deriveWrapKey('mypassword', salt)
    expect(Buffer.isBuffer(key)).toBe(true)
    expect(key.length).toBe(32)
  })

  it('is deterministic — same password+salt → same key', () => {
    const salt = randomBytes(32)
    const k1 = deriveWrapKey('password123', salt)
    const k2 = deriveWrapKey('password123', salt)
    expect(k1.equals(k2)).toBe(true)
  })

  it('different salts → different keys', () => {
    const s1 = randomBytes(32)
    const s2 = randomBytes(32)
    const k1 = deriveWrapKey('password', s1)
    const k2 = deriveWrapKey('password', s2)
    expect(k1.equals(k2)).toBe(false)
  })
})

describe('wrapKey / unwrapKey', () => {
  it('round-trips a 32-byte data key', () => {
    const dataKey = randomBytes(32)
    const wrappingKey = randomBytes(32)
    const enc = wrapKey(dataKey, wrappingKey)
    expect(typeof enc).toBe('string')
    const recovered = unwrapKey(enc, wrappingKey)
    expect(Buffer.isBuffer(recovered)).toBe(true)
    expect(recovered.equals(dataKey)).toBe(true)
  })

  it('fails to unwrap with a wrong wrapping key', () => {
    const dataKey = randomBytes(32)
    const rightKey = randomBytes(32)
    const wrongKey = randomBytes(32)
    const enc = wrapKey(dataKey, rightKey)
    expect(() => unwrapKey(enc, wrongKey)).toThrow()
  })
})
