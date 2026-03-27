// electron/utils.js
// Pure utility functions — no Electron API imports, fully unit-testable.

/**
 * Generate a deduplication key for notified.json.
 * Format: billId_YYYY-MM
 * Same bill + same calendar month = same key → notifies once per monthly cycle.
 * A bill's new monthly invoice gets a fresh key the following month.
 *
 * @param {string} billId
 * @param {number} dateMs - epoch milliseconds (typically Date.now())
 * @returns {string}
 */
function makeNotificationKey(billId, dateMs) {
  const d = new Date(dateMs)
  const year = d.getUTCFullYear()
  const month = String(d.getUTCMonth() + 1).padStart(2, '0')
  return `${billId}_${year}-${month}`
}

module.exports = { makeNotificationKey }
