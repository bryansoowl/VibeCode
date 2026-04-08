// electron/sync-manager.js
'use strict'

const MAX_CONCURRENCY = 3
const GLOBAL_BATCH_BUDGET = 300
const MIN_BATCH_SIZE = 50
const MAX_BATCH_SIZE = 200
const INITIAL_BATCH_SIZE = 100
const SYNC_INTERVAL_MS = 60_000
const BACKFILL_INTERVAL_MS = 2 * 60_000
const ACCOUNT_POLL_INTERVAL_MS = 30_000
const SYNC_STARTUP_DELAY_MS = 30_000
const BACKFILL_STARTUP_DELAY_MS = 90_000
const SYNC_COMPLETE_DEBOUNCE_MS = 500

class SyncManager {
  constructor(apiRequest, mainWindow, backendUrl, options = {}) {
    this.apiRequest = apiRequest
    this.mainWindow = mainWindow
    this.backendUrl = backendUrl
    this._onNewEmails = options.onNewEmails ?? null

    // Job queue: array used as min-heap sorted by priority (0=highest)
    this.jobQueue = []
    this.activeSlots = 0

    // Per-account adaptive batch state
    this.accountBatchState = new Map()

    // Known accounts for burst detection
    this.knownAccounts = new Set()

    // Timer handles
    this._syncTimer = null
    this._backfillTimer = null
    this._pollTimer = null
    this._syncCompleteDebounce = null

    this._stopped = false
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  async start() {
    this._stopped = false

    // Seed knownAccounts from existing accounts
    try {
      const [accountsRes, stateRes] = await Promise.all([
        this.apiRequest('/api/accounts'),
        this.apiRequest('/api/sync/state'),
      ])

      // Build persisted batch state map for seeding
      const persistedState = {}
      if (stateRes && stateRes.status === 200 && Array.isArray(stateRes.body?.states)) {
        for (const row of stateRes.body.states) {
          persistedState[row.account_id] = {
            batchSize: row.last_batch_size ?? INITIAL_BATCH_SIZE,
            lastDurationMs: row.last_batch_duration_ms ?? 0,
          }
        }
      }

      if (accountsRes && accountsRes.status === 200 && Array.isArray(accountsRes.body?.accounts)) {
        const accounts = accountsRes.body.accounts
        let burstIndex = 0
        for (const acc of accounts) {
          this.knownAccounts.add(acc.id)
          // Restore persisted batch size, fall back to initial
          this.accountBatchState.set(acc.id, persistedState[acc.id] ?? { batchSize: INITIAL_BATCH_SIZE, lastDurationMs: 0 })
          // Burst on every launch to quickly populate inbox
          this.enqueue({ type: 'burst', accountId: acc.id, priority: 0, burstIndex: burstIndex++ })
        }
      }
    } catch (e) {
      console.error('[sync-manager] start: failed to load accounts:', e.message)
    }

    // Account poller — detect new accounts mid-session
    this._pollTimer = setTimeout(() => {
      this._runPollTick()
      this._pollTimer = setInterval(() => this._runPollTick(), ACCOUNT_POLL_INTERVAL_MS)
    }, ACCOUNT_POLL_INTERVAL_MS)

    // Fast sync timer
    this._syncTimer = setTimeout(() => {
      this.enqueue({ type: 'fast', priority: 1 })
      this._syncTimer = setInterval(() => {
        this.enqueue({ type: 'fast', priority: 1 })
      }, SYNC_INTERVAL_MS)
    }, SYNC_STARTUP_DELAY_MS)

    // Backfill timer
    this._backfillTimer = setTimeout(() => {
      this._enqueueBackfill()
      this._backfillTimer = setInterval(() => this._enqueueBackfill(), BACKFILL_INTERVAL_MS)
    }, BACKFILL_STARTUP_DELAY_MS)
  }

  stop() {
    this._stopped = true
    // Clear all timers
    ;[this._syncTimer, this._backfillTimer, this._pollTimer].forEach(t => {
      if (t) { clearTimeout(t); clearInterval(t) }
    })
    if (this._syncCompleteDebounce) clearTimeout(this._syncCompleteDebounce)
    // Drain queue (fire-and-forget: active API calls complete naturally)
    this.jobQueue = []
  }

  // ── Job Queue ───────────────────────────────────────────────────────────────

  enqueue(job) {
    this.jobQueue.push(job)
    // Sort by priority ascending (0 = highest priority)
    this.jobQueue.sort((a, b) => a.priority - b.priority)
    // Defer dispatch so all synchronous enqueue calls complete first,
    // preserving priority ordering and keeping items visible in jobQueue.
    Promise.resolve().then(() => this._dispatch())
  }

  _dispatch() {
    if (this._stopped) return
    while (this.jobQueue.length > 0 && this.activeSlots < MAX_CONCURRENCY) {
      const job = this.jobQueue.shift()
      this.activeSlots++
      // Stagger burst jobs to reduce quota pressure
      const delay = (job.type === 'burst' && job.burstIndex > 0)
        ? job.burstIndex * 500
        : 0
      const run = () => this.runJob(job)
        .catch(e => console.error(`[sync-manager] job ${job.type}/${job.accountId} failed:`, e.message))
        .finally(() => {
          this.activeSlots--
          this._dispatch()
        })
      if (delay > 0) setTimeout(run, delay)
      else run()
    }
  }

  async runJob(job) {
    if (job.type === 'burst')    return this._runBurst(job)
    if (job.type === 'fast')     return this._runFast(job)
    if (job.type === 'backfill') return this._runBackfill(job)
  }

  // ── Job Runners ─────────────────────────────────────────────────────────────

  async _runBurst(job) {
    console.log(`[sync-manager] burst ${job.accountId}`)
    const res = await this.apiRequest('/api/sync/burst', 'POST', { accountId: job.accountId })
    if (!res || res.status !== 200) {
      console.log(`[sync-manager] burst ${job.accountId} failed (status ${res?.status ?? 'network'})`)
      return
    }
    console.log(`[sync-manager] burst ${job.accountId} — added ${res.body?.added ?? 0}`)
    this._notifySyncComplete()
  }

  async _runFast(_job) {
    const res = await this.apiRequest('/api/sync/trigger', 'POST', {})
    if (!res || res.status !== 200) return
    const { added = 0, emails = [] } = res.body ?? {}
    if (added > 0) {
      await this._handleNewEmails(added, emails)
    }
    this._notifySyncComplete()
    // Unsnooze due emails
    await this.apiRequest('/api/emails/unsnooze-due', 'POST', {}).catch(() => {})
  }

  async _runBackfill(job) {
    const activeAccountCount = this.knownAccounts.size || 1
    const batchSize = this.computeBatchSize(job.accountId, activeAccountCount)
    console.log(`[sync-manager] backfill ${job.accountId} batchSize=${batchSize}`)

    const t0 = Date.now()
    const res = await this.apiRequest('/api/sync/backfill', 'POST', {
      accountId: job.accountId,
      batchSize,
    })
    const durationMs = Date.now() - t0

    if (!res || res.status !== 200) {
      console.log(`[sync-manager] backfill ${job.accountId} failed (status ${res?.status ?? 'network'})`)
      return
    }

    await this.updateBatchState(job.accountId, batchSize, durationMs)

    const results = res.body?.results ?? []
    for (const r of results) {
      if (!r.skipped) {
        console.log(`[sync-manager] backfill ${job.accountId}/${r.folder} — added ${r.added}${r.complete ? ' (complete)' : ''}`)
      }
    }
  }

  // ── Adaptive Batch Sizing ───────────────────────────────────────────────────

  computeBatchSize(accountId, activeAccountCount) {
    const state = this.accountBatchState.get(accountId)
    const current = state?.batchSize ?? INITIAL_BATCH_SIZE
    const perAccountMax = Math.min(MAX_BATCH_SIZE, Math.floor(GLOBAL_BATCH_BUDGET / Math.max(1, activeAccountCount)))
    return Math.max(MIN_BATCH_SIZE, Math.min(current, perAccountMax))
  }

  nextBatchSize(current, lastDurationMs, perAccountMax) {
    let next = current
    if (lastDurationMs < 3000)  next = current + 25
    else if (lastDurationMs > 10000) next = current - 25
    return Math.max(MIN_BATCH_SIZE, Math.min(next, perAccountMax))
  }

  async updateBatchState(accountId, batchSize, durationMs) {
    const activeAccountCount = this.knownAccounts.size || 1
    const perAccountMax = Math.min(MAX_BATCH_SIZE, Math.floor(GLOBAL_BATCH_BUDGET / activeAccountCount))
    const newSize = this.nextBatchSize(batchSize, durationMs, perAccountMax)

    this.accountBatchState.set(accountId, { batchSize: newSize, lastDurationMs: durationMs })

    // Persist to backend
    await this.apiRequest(`/api/sync/state/${accountId}`, 'PATCH', {
      last_batch_size: newSize,
      last_batch_duration_ms: durationMs,
    }).catch(e => console.error('[sync-manager] persist batch state failed:', e.message))
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  async _runPollTick() {
    try {
      const res = await this.apiRequest('/api/accounts')
      if (!res || res.status !== 200 || !Array.isArray(res.body?.accounts)) return
      let burstIndex = 0
      for (const acc of res.body.accounts) {
        if (!this.knownAccounts.has(acc.id)) {
          this.knownAccounts.add(acc.id)
          this.accountBatchState.set(acc.id, { batchSize: INITIAL_BATCH_SIZE, lastDurationMs: 0 })
          this.enqueue({ type: 'burst', accountId: acc.id, priority: 0, burstIndex: burstIndex++ })
          console.log(`[sync-manager] new account detected: ${acc.id} — burst queued`)
        }
      }
    } catch (e) {
      console.error('[sync-manager] poll tick error:', e.message)
    }
  }

  _enqueueBackfill() {
    for (const accountId of this.knownAccounts) {
      this.enqueue({ type: 'backfill', accountId, priority: 2 })
    }
  }

  _notifySyncComplete() {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return
    // Trailing debounce — coalesces burst + fast sync events at launch
    if (this._syncCompleteDebounce) clearTimeout(this._syncCompleteDebounce)
    this._syncCompleteDebounce = setTimeout(() => {
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send('sync-complete')
      }
    }, SYNC_COMPLETE_DEBOUNCE_MS)
  }

  async _handleNewEmails(added, emails) {
    // Fetch unread count and notify renderer
    const res = await this.apiRequest('/api/emails/unread-counts').catch(() => null)
    if (!res || res.status !== 200) return
    const unreadCount = res.body?.total_unread ?? 0
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send('new-emails', { added, unreadCount, emails })
    }
    if (this._onNewEmails) this._onNewEmails({ added, unreadCount, emails })
  }
}

module.exports = { SyncManager }
