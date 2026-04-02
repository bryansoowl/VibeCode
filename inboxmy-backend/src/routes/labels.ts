// src/routes/labels.ts
import { Router, type Request, type Response } from 'express'
import { z } from 'zod'
import { randomUUID } from 'crypto'
import { getDb } from '../db'

export const labelsRouter = Router()

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/

const createBody = z.object({
  name:  z.string().min(1).max(50),
  color: z.string().regex(HEX_COLOR).optional(),
})

const patchBody = z.object({
  name:  z.string().min(1).max(50).optional(),
  color: z.string().regex(HEX_COLOR).optional(),
})

// GET /api/labels — list user's labels with email count
labelsRouter.get('/', (req: Request, res: Response) => {
  const user = (req as any).user
  const rows = getDb().prepare(`
    SELECT l.id, l.name, l.color,
      (SELECT COUNT(*) FROM email_labels el
       JOIN emails e ON e.id = el.email_id
       JOIN accounts a ON a.id = e.account_id
       WHERE el.label_id = l.id AND a.user_id = ?) as count
    FROM labels l
    WHERE l.user_id = ?
    ORDER BY l.created_at ASC
  `).all(user.id, user.id)
  res.json(rows)
})

// POST /api/labels — create label
labelsRouter.post('/', (req: Request, res: Response) => {
  const parsed = createBody.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })

  const user = (req as any).user
  const db = getDb()
  const { name, color = '#6B7280' } = parsed.data
  const id = randomUUID()

  // Check for duplicate name within this user
  const existing = db.prepare('SELECT id FROM labels WHERE user_id = ? AND name = ?').get(user.id, name)
  if (existing) return res.status(409).json({ error: 'Label name already exists' })

  db.prepare(
    'INSERT INTO labels (id, user_id, name, color, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(id, user.id, name, color, Date.now())

  res.status(201).json({ id, name, color })
})

// PATCH /api/labels/:id — rename / recolor
labelsRouter.patch('/:id', (req: Request, res: Response) => {
  const parsed = patchBody.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })

  const user = (req as any).user
  const db = getDb()
  const label = db.prepare('SELECT id FROM labels WHERE id = ? AND user_id = ?').get(req.params.id, user.id)
  if (!label) return res.status(404).json({ error: 'Label not found' })

  const { name, color } = parsed.data
  if (name !== undefined) db.prepare('UPDATE labels SET name = ? WHERE id = ?').run(name, req.params.id)
  if (color !== undefined) db.prepare('UPDATE labels SET color = ? WHERE id = ?').run(color, req.params.id)

  res.json({ ok: true })
})

// DELETE /api/labels/:id — delete label (cascades to email_labels)
labelsRouter.delete('/:id', (req: Request, res: Response) => {
  const user = (req as any).user
  const db = getDb()
  const result = db.prepare('DELETE FROM labels WHERE id = ? AND user_id = ?').run(req.params.id, user.id)
  if (result.changes === 0) return res.status(404).json({ error: 'Label not found' })
  res.json({ ok: true })
})
