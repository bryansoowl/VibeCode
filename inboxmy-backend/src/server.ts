// src/server.ts (minimal — will be replaced in Task 11)
import express from 'express'
import cors from 'cors'
import { accountsRouter } from './routes/accounts'
import { emailsRouter } from './routes/emails'
import { billsRouter } from './routes/bills'
import { syncRouter } from './routes/sync'

export const app = express()
app.use(express.json())
app.use(cors())
app.use('/api/accounts', accountsRouter)
app.use('/api/emails', emailsRouter)
app.use('/api/bills', billsRouter)
app.use('/api/sync', syncRouter)
app.get('/health', (req, res) => res.json({ ok: true }))
