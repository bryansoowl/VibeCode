// src/routes/auth.ts
import { Router } from 'express'
import { randomBytes, createHash } from 'crypto'
import { randomUUID } from 'crypto'
import nodemailer from 'nodemailer'
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

// POST /auth/forgot-password
authRouter.post('/forgot-password', async (req, res) => {
  const { email } = req.body
  // Always return 200 FIRST — prevents email enumeration and avoids ERR_HTTP_HEADERS_SENT
  // if any post-response side effect throws (DB insert, SMTP send).
  res.json({ ok: true })

  if (!email || typeof email !== 'string') return

  // All side effects wrapped in try/catch — errors log to console, never propagate
  try {
    const db = getDb()
    const user = db.prepare('SELECT id FROM users WHERE email = ?')
      .get((email as string).toLowerCase()) as any
    if (!user) return

    const rawToken = randomBytes(32).toString('hex')
    const tokenHash = createHash('sha256').update(rawToken).digest('hex')
    db.prepare(
      'INSERT INTO password_reset_tokens (id, user_id, token_hash, expires_at, used) VALUES (?, ?, ?, ?, 0)'
    ).run(randomUUID(), user.id, tokenHash, Date.now() + 3600_000)

    const resetLink = `${config.appUrl}/reset-password?token=${rawToken}`

    if (config.smtp.host) {
      const transporter = nodemailer.createTransport({
        host: config.smtp.host,
        port: config.smtp.port,
        auth: { user: config.smtp.user, pass: config.smtp.pass },
      })
      await transporter.sendMail({
        from: `InboxMY <noreply@${config.smtp.host}>`,
        to: email,
        subject: 'Reset your InboxMY password',
        text: `Click this link to reset your password (expires in 1 hour):\n\n${resetLink}`,
      })
    } else {
      console.log('[InboxMY] Password reset link:', resetLink)
    }
  } catch (err: any) {
    console.error('[auth] forgot-password side effect error:', err.message)
  }
})

// POST /auth/reset-password
authRouter.post('/reset-password', async (req, res) => {
  const { token, newPassword } = req.body
  if (!token || !newPassword) {
    return res.status(400).json({ error: 'token and newPassword are required' })
  }
  const pwErr = validatePassword(newPassword)
  if (pwErr) return res.status(400).json({ error: pwErr })

  const tokenHash = createHash('sha256').update(token as string).digest('hex')
  const db = getDb()
  const tokenRow = db.prepare(
    'SELECT id, user_id, expires_at, used FROM password_reset_tokens WHERE token_hash = ?'
  ).get(tokenHash) as any

  if (!tokenRow) return res.status(400).json({ error: 'Reset link is invalid.' })
  if (tokenRow.used) return res.status(400).json({ error: 'Reset link has already been used.' })
  if (tokenRow.expires_at < Date.now()) return res.status(400).json({ error: 'Reset link has expired. Request a new one.' })

  const user = db.prepare('SELECT id, pbkdf2_salt, recovery_enc FROM users WHERE id = ?')
    .get(tokenRow.user_id) as any

  const recoveryKeyBuf = Buffer.from(config.recoverySecret, 'hex')
  const dataKey = unwrapKey(user.recovery_enc, recoveryKeyBuf)

  const newSalt = randomBytes(32)
  const newWrapKey = deriveWrapKey(newPassword as string, newSalt)
  const newDataKeyEnc = wrapKey(dataKey, newWrapKey)
  const newPasswordHash = await bcrypt.hash(newPassword as string, 12)

  db.prepare(`
    UPDATE users SET password_hash = ?, pbkdf2_salt = ?, data_key_enc = ? WHERE id = ?
  `).run(newPasswordHash, newSalt.toString('base64'), newDataKeyEnc, user.id)

  db.prepare('UPDATE password_reset_tokens SET used = 1 WHERE id = ?').run(tokenRow.id)
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id)

  res.json({ ok: true })
})
