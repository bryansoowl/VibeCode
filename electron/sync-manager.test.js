// electron/sync-manager.test.js
const { SyncManager } = require('./sync-manager.js')

// Minimal stub for mainWindow
function makeWindow(destroyed = false) {
  const sends = []
  return {
    isDestroyed: () => destroyed,
    webContents: { send: (event, ...args) => sends.push({ event, args }) },
    _sends: sends,
  }
}

// Capture apiRequest calls
function makeApiRequest(responses = {}) {
  const calls = []
  const fn = async (path, method = 'GET', body = null) => {
    calls.push({ path, method, body })
    return responses[path] ?? { status: 200, body: { accounts: [] } }
  }
  fn._calls = calls
  return fn
}

describe('SyncManager — computeBatchSize', () => {
  it('returns INITIAL_BATCH_SIZE for unknown account', () => {
    const sm = new SyncManager(makeApiRequest(), makeWindow(), 'http://localhost:3001')
    const size = sm.computeBatchSize('acc-unknown', 1)
    expect(size).toBe(100)
  })

  it('divides global budget by account count', () => {
    const sm = new SyncManager(makeApiRequest(), makeWindow(), 'http://localhost:3001')
    sm.accountBatchState.set('acc-1', { batchSize: 100, lastDurationMs: 0 })
    // 3 accounts → perAccountMax = floor(300/3) = 100 → clamped to min(100, 200) = 100
    const size = sm.computeBatchSize('acc-1', 3)
    expect(size).toBe(100)
  })

  it('does not exceed MAX_BATCH_SIZE regardless of account count', () => {
    const sm = new SyncManager(makeApiRequest(), makeWindow(), 'http://localhost:3001')
    sm.accountBatchState.set('acc-1', { batchSize: 200, lastDurationMs: 0 })
    const size = sm.computeBatchSize('acc-1', 1)
    expect(size).toBe(200)  // perAccountMax = 300 but capped at 200
  })
})

describe('SyncManager — nextBatchSize (auto-tune)', () => {
  it('increases by 25 when last batch was fast (< 3s)', () => {
    const sm = new SyncManager(makeApiRequest(), makeWindow(), 'http://localhost:3001')
    const next = sm.nextBatchSize(100, 2000, 200)
    expect(next).toBe(125)
  })

  it('decreases by 25 when last batch was slow (> 10s)', () => {
    const sm = new SyncManager(makeApiRequest(), makeWindow(), 'http://localhost:3001')
    const next = sm.nextBatchSize(100, 11000, 200)
    expect(next).toBe(75)
  })

  it('holds steady in the stable zone (3–10s)', () => {
    const sm = new SyncManager(makeApiRequest(), makeWindow(), 'http://localhost:3001')
    const next = sm.nextBatchSize(100, 6000, 200)
    expect(next).toBe(100)
  })

  it('clamps to MIN_BATCH_SIZE (50) when decremented below floor', () => {
    const sm = new SyncManager(makeApiRequest(), makeWindow(), 'http://localhost:3001')
    const next = sm.nextBatchSize(50, 11000, 200)
    expect(next).toBe(50)
  })

  it('clamps to perAccountMax when incremented above ceiling', () => {
    const sm = new SyncManager(makeApiRequest(), makeWindow(), 'http://localhost:3001')
    const next = sm.nextBatchSize(175, 1000, 175)  // perAccountMax = 175
    expect(next).toBe(175)  // would be 200, clamped to 175
  })
})

describe('SyncManager — concurrency', () => {
  it('does not exceed MAX_CONCURRENCY active slots', async () => {
    const sm = new SyncManager(makeApiRequest(), makeWindow(), 'http://localhost:3001')

    // Track max concurrent slots observed
    let maxSeen = 0
    const originalRun = sm.runJob.bind(sm)
    sm.runJob = async (job) => {
      maxSeen = Math.max(maxSeen, sm.activeSlots)
      await new Promise(r => setTimeout(r, 10))  // simulate async work
    }

    // Enqueue 6 jobs
    for (let i = 0; i < 6; i++) {
      sm.enqueue({ type: 'backfill', accountId: `acc-${i}`, priority: 2 })
    }

    // Wait for all to drain
    await new Promise(r => setTimeout(r, 200))
    expect(maxSeen).toBeLessThanOrEqual(3)
  })
})

describe('SyncManager — job queue priority', () => {
  it('burst jobs run before backfill jobs', async () => {
    const sm = new SyncManager(makeApiRequest(), makeWindow(), 'http://localhost:3001')

    const runOrder = []
    sm.runJob = async (job) => { runOrder.push(job.type) }

    // Enqueue backfill first, then burst — burst should run first
    sm.enqueue({ type: 'backfill', accountId: 'acc-1', priority: 2 })
    sm.enqueue({ type: 'burst', accountId: 'acc-1', priority: 0 })

    await new Promise(r => setTimeout(r, 50))
    // At least the first job dispatched should be burst
    expect(runOrder[0]).toBe('burst')
  })
})

describe('SyncManager — stop', () => {
  it('clears the job queue', () => {
    const sm = new SyncManager(makeApiRequest(), makeWindow(), 'http://localhost:3001')
    sm.enqueue({ type: 'backfill', accountId: 'acc-1', priority: 2 })
    sm.enqueue({ type: 'backfill', accountId: 'acc-2', priority: 2 })
    expect(sm.jobQueue.length).toBeGreaterThan(0)
    sm.stop()
    expect(sm.jobQueue.length).toBe(0)
  })
})
