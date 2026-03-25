// src/routes/auth.ts
import { Router } from 'express'
import { randomBytes, createHash } from 'crypto'
import { randomUUID } from 'crypto'
import bcrypt from 'bcryptjs'
import { getDb } from '../db'
import { config } from '../config'
import {
  deriveWrapKey, wrapKey, unwrapKey,
} from '../crypto'
import { requireAuth } from '../middleware/auth'

export const authRouter = Router()

const SESSION_COOKIE_OPTS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax' as const,
  path: '/',
}

function validatePassword(password: string): string | null {
  if (typeof password !== 'string') return 'Password is required'
  if (password.length < 8) return 'Password must be at least 8 characters'
  if (Buffer.byteLength(password, 'utf8') > 72) return 'Password must be 72 bytes or fewer'
  return null
}

// POST /auth/signup
authRouter.post('/signup', async (req, res) => {
  const { email, password } = req.body
  if (!email || typeof email !== 'string') {
    return res.status(400).json({ error: 'Email is required' })
  }
  const pwErr = validatePassword(password)
  if (pwErr) return res.status(400).json({ error: pwErr })

  const db = getDb()
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase())
  if (existing) return res.status(409).json({ error: 'Email already registered' })

  const userId = randomUUID()
  const passwordHash = await bcrypt.hash(password, 12)
  const pbkdf2Salt = randomBytes(32)
  const dataKey = randomBytes(32)
  const wrapKeyBuf = deriveWrapKey(password, pbkdf2Salt)
  const dataKeyEnc = wrapKey(dataKey, wrapKeyBuf)
  const recoveryKeyBuf = Buffer.from(config.recoverySecret, 'hex')
  const recoveryEnc = wrapKey(dataKey, recoveryKeyBuf)

  db.prepare(`
    INSERT INTO users (id, email, password_hash, pbkdf2_salt, data_key_enc, recovery_enc, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(userId, email.toLowerCase(), passwordHash, pbkdf2Salt.toString('base64'), dataKeyEnc, recoveryEnc, Date.now())

  // Create session
  const sessionId = randomBytes(32).toString('hex')
  const sessionSecretBuf = Buffer.from(config.sessionSecret, 'hex')
  const keyEnc = wrapKey(dataKey, sessionSecretBuf)
  db.prepare('INSERT INTO sessions (id, user_id, key_enc, created_at) VALUES (?, ?, ?, ?)')
    .run(sessionId, userId, keyEnc, Date.now())

  res.cookie('session', sessionId, SESSION_COOKIE_OPTS)
  res.json({ ok: true, user: { id: userId, email: email.toLowerCase() } })
})

// POST /auth/login
authRouter.post('/login', async (req, res) => {
  const { email, password } = req.body
  if (!email || !password) {
    return res.status(401).json({ error: 'Invalid email or password' })
  }

  const db = getDb()
  const user = db.prepare(
    'SELECT id, email, password_hash, pbkdf2_salt, data_key_enc FROM users WHERE email = ?'
  ).get((email as string).toLowerCase()) as any

  if (!user) return res.status(401).json({ error: 'Invalid email or password' })

  const match = await bcrypt.compare(password, user.password_hash)
  if (!match) return res.status(401).json({ error: 'Invalid email or password' })

  const pbkdf2Salt = Buffer.from(user.pbkdf2_salt, 'base64')
  const wrapKeyBuf = deriveWrapKey(password, pbkdf2Salt)
  const dataKey = unwrapKey(user.data_key_enc, wrapKeyBuf)

  const sessionId = randomBytes(32).toString('hex')
  const sessionSecretBuf = Buffer.from(config.sessionSecret, 'hex')
  const keyEnc = wrapKey(dataKey, sessionSecretBuf)
  db.prepare('INSERT INTO sessions (id, user_id, key_enc, created_at) VALUES (?, ?, ?, ?)')
    .run(sessionId, user.id, keyEnc, Date.now())

  res.cookie('session', sessionId, SESSION_COOKIE_OPTS)
  res.json({ ok: true, user: { id: user.id, email: user.email } })
})

// POST /auth/logout
authRouter.post('/logout', requireAuth, (req, res) => {
  const sessionId = req.cookies?.session
  if (sessionId) {
    getDb().prepare('DELETE FROM sessions WHERE id = ?').run(sessionId)
  }
  res.clearCookie('session', { path: '/' })
  res.json({ ok: true })
})

// GET /auth/me
authRouter.get('/me', requireAuth, (req, res) => {
  res.json({ user: { id: (req as any).user.id, email: (req as any).user.email } })
})
