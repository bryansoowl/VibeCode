// src/middleware/auth.ts
import type { Request, Response, NextFunction } from 'express'
import { getDb } from '../db'
import { config } from '../config'
import { unwrapKey } from '../crypto'

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 days absolute TTL — exported so server.ts OAuth callbacks use the same value

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const sessionId = (req as any).cookies?.session
  if (!sessionId) return res.status(401).json({ error: 'Not authenticated' })

  const db = getDb()
  const row = db.prepare(`
    SELECT s.user_id, s.key_enc, s.created_at, u.email
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.id = ?
  `).get(sessionId) as any

  if (!row) return res.status(401).json({ error: 'Session not found' })

  if (Date.now() - row.created_at > SESSION_TTL_MS) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId)
    return res.status(401).json({ error: 'Session expired' })
  }

  const sessionSecretBuf = Buffer.from(config.sessionSecret, 'hex')
  const dataKey = unwrapKey(row.key_enc, sessionSecretBuf)
  ;(req as any).user = { id: row.user_id, email: row.email, dataKey }
  next()
}
