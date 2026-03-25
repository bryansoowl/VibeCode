// src/crypto.ts
import forge from 'node-forge'
import { pbkdf2Sync } from 'crypto'
import { config } from './config'

// ─── Internal AES-256-GCM helpers ────────────────────────────────────────────

function aesEncrypt(plaintext: string, keyBuf: Buffer): string {
  const keyBytes = forge.util.createBuffer(keyBuf.toString('binary'))
  const iv = forge.random.getBytesSync(12)
  const cipher = forge.cipher.createCipher('AES-GCM', keyBytes)
  cipher.start({ iv })
  cipher.update(forge.util.createBuffer(plaintext, 'utf8'))
  cipher.finish()
  const combined = iv + (cipher as any).mode.tag.bytes() + cipher.output.bytes()
  return forge.util.encode64(combined)
}

function aesDecrypt(ciphertext: string, keyBuf: Buffer): string {
  const keyBytes = forge.util.createBuffer(keyBuf.toString('binary'))
  const combined = forge.util.decode64(ciphertext)
  const iv = combined.slice(0, 12)
  const tag = forge.util.createBuffer(combined.slice(12, 28))
  const encrypted = combined.slice(28)
  const decipher = forge.cipher.createDecipher('AES-GCM', keyBytes)
  decipher.start({ iv, tag })
  decipher.update(forge.util.createBuffer(encrypted))
  if (!decipher.finish()) throw new Error('Decryption failed: data may be tampered')
  return decipher.output.toString()
}

// ─── Explicit-key API (per-user data) ────────────────────────────────────────

export function encrypt(plaintext: string, key: Buffer): string {
  return aesEncrypt(plaintext, key)
}

export function decrypt(ciphertext: string, key: Buffer): string {
  return aesDecrypt(ciphertext, key)
}

// ─── System-key API (OAuth tokens — uses global ENCRYPTION_KEY) ──────────────

export function encryptSystem(plaintext: string): string {
  const keyBuf = Buffer.from(config.encryptionKey, 'hex')
  return aesEncrypt(plaintext, keyBuf)
}

export function decryptSystem(ciphertext: string): string {
  const keyBuf = Buffer.from(config.encryptionKey, 'hex')
  return aesDecrypt(ciphertext, keyBuf)
}

// ─── Key derivation (PBKDF2) ─────────────────────────────────────────────────
// Uses pbkdf2Sync — only called on sign-up/login paths, not hot path.
// 310,000 iterations per OWASP 2023 recommendation for SHA-256.

export function deriveWrapKey(password: string, salt: Buffer): Buffer {
  return pbkdf2Sync(password, salt, 310_000, 32, 'sha256')
}

// ─── Key wrapping (data key storage) ─────────────────────────────────────────

export function wrapKey(dataKey: Buffer, wrappingKey: Buffer): string {
  return aesEncrypt(dataKey.toString('binary'), wrappingKey)
}

export function unwrapKey(enc: string, wrappingKey: Buffer): Buffer {
  const binaryStr = aesDecrypt(enc, wrappingKey)
  return Buffer.from(binaryStr, 'binary')
}
