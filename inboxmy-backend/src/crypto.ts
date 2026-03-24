// src/crypto.ts
import forge from 'node-forge'
import { config } from './config'

function getKey(): forge.util.ByteStringBuffer {
  return forge.util.createBuffer(
    forge.util.hexToBytes(config.encryptionKey)
  )
}

export function encrypt(plaintext: string): string {
  const iv = forge.random.getBytesSync(12)
  const cipher = forge.cipher.createCipher('AES-GCM', getKey())
  cipher.start({ iv })
  cipher.update(forge.util.createBuffer(plaintext, 'utf8'))
  cipher.finish()

  const encrypted = cipher.output.bytes()
  const tag = (cipher as any).mode.tag.bytes()

  const combined = iv + tag + encrypted
  return forge.util.encode64(combined)
}

export function decrypt(ciphertext: string): string {
  const combined = forge.util.decode64(ciphertext)
  const iv = combined.slice(0, 12)
  const tag = forge.util.createBuffer(combined.slice(12, 28))
  const encrypted = combined.slice(28)

  const decipher = forge.cipher.createDecipher('AES-GCM', getKey())
  decipher.start({ iv, tag })
  decipher.update(forge.util.createBuffer(encrypted))
  const pass = decipher.finish()

  if (!pass) throw new Error('Decryption failed: data may be tampered')
  return decipher.output.toString()
}
