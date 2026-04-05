// src/scheduler.ts
// Background scheduling has moved to electron/main.js (Plan 6).
// This stub is retained so server.ts compiles without changes.
export function startScheduler(): void {
  console.log('[scheduler] Background sync disabled - scheduling handled by Electron main process')
}
