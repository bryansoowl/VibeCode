// tests/crypto.test.ts
import { encrypt, decrypt } from '../src/crypto'

describe('crypto', () => {
  it('round-trips a plaintext string', () => {
    const plain = 'Hello, Malaysia!'
    const cipher = encrypt(plain)
    expect(cipher).not.toBe(plain)
    expect(decrypt(cipher)).toBe(plain)
  })

  it('produces different ciphertext for same input (random IV)', () => {
    const plain = 'same input'
    expect(encrypt(plain)).not.toBe(encrypt(plain))
  })

  it('throws on tampered ciphertext', () => {
    const cipher = encrypt('safe')
    expect(() => decrypt(cipher + 'x')).toThrow()
  })
})
