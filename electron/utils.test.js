// electron/utils.test.js
const { makeNotificationKey } = require('./utils.js')

describe('makeNotificationKey', () => {
  it('same bill same month → same key (deduplicates)', () => {
    const jan1  = new Date('2026-01-01T00:00:00Z').getTime()
    const jan31 = new Date('2026-01-31T23:59:59Z').getTime()
    expect(makeNotificationKey('bill-abc', jan1)).toBe(makeNotificationKey('bill-abc', jan31))
  })

  it('same bill different month → different key (re-notifies)', () => {
    const jan = new Date('2026-01-15').getTime()
    const feb = new Date('2026-02-15').getTime()
    expect(makeNotificationKey('bill-abc', jan)).not.toBe(makeNotificationKey('bill-abc', feb))
  })

  it('different bills same month → different keys', () => {
    const ts = new Date('2026-01-15').getTime()
    expect(makeNotificationKey('bill-abc', ts)).not.toBe(makeNotificationKey('bill-xyz', ts))
  })

  it('key format is billId_YYYY-MM', () => {
    const ts = new Date('2026-03-27').getTime()
    expect(makeNotificationKey('my-bill', ts)).toBe('my-bill_2026-03')
  })
})
