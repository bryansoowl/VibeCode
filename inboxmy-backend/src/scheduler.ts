// src/scheduler.ts
import cron from 'node-cron'
import { syncAllAccounts } from './email/sync-engine'
import { config } from './config'

export function startScheduler(): void {
  const interval = config.syncIntervalMinutes
  const mins = Math.max(1, Math.min(59, interval))

  cron.schedule(`*/${mins} * * * *`, async () => {
    console.log(`[sync] Starting scheduled sync (every ${mins}m)`)
    try {
      await syncAllAccounts()
      console.log('[sync] Completed')
    } catch (err) {
      console.error('[sync] Error:', err)
    }
  })

  console.log(`[scheduler] Sync scheduled every ${mins} minutes`)
}
