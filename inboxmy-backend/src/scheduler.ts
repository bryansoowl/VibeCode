// src/scheduler.ts
// NOTE: Per-user sync requires a user's dataKey which is only available during
// an authenticated request. Background sync is disabled in Plan 4 pending a
// service-account re-auth pattern in a future plan.
export function startScheduler(): void {
  console.log('[scheduler] Background sync disabled (Plan 4 — requires per-user dataKey)')
}
