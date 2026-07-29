"use strict"

const crypto = require("crypto")

async function enqueueFulfillment(pool, orderId, node) {
  if (!pool || !orderId || !node) return false
  const [result] = await pool.query(
    `INSERT IGNORE INTO wechat_fulfillment_records
      (order_id, business_node, status, attempt_count, next_retry_at, created_at, updated_at)
     VALUES (:orderId, :node, 'PENDING', 0, NOW(), NOW(), NOW())`,
    { orderId, node }
  )
  return Number(result.affectedRows || 0) === 1
}

async function claimDueFulfillment(pool, options = {}) {
  if (!pool) return []
  const limit = Math.max(1, Math.min(20, Number(options.limit || 5)))
  const maxAttempts = Math.max(1, Math.min(10, Number(options.maxAttempts || 4)))
  const lockMinutes = Math.max(1, Math.min(30, Number(options.lockMinutes || 3)))
  const [rows] = await pool.query(
    `SELECT id FROM wechat_fulfillment_records
     WHERE attempt_count < :maxAttempts
       AND (
         (status IN ('PENDING','RETRY') AND (next_retry_at IS NULL OR next_retry_at <= NOW()))
         OR (status = 'PROCESSING' AND COALESCE(processing_started_at, updated_at) < DATE_SUB(NOW(), INTERVAL ${lockMinutes} MINUTE))
       )
     ORDER BY COALESCE(next_retry_at, created_at), id
     LIMIT ${limit}`,
    { maxAttempts }
  )
  const claimed = []
  for (const row of rows) {
    const claimToken = crypto.randomUUID()
    const [result] = await pool.query(
      `UPDATE wechat_fulfillment_records
       SET status='PROCESSING', attempt_count=attempt_count+1, claim_token=:claimToken,
           processing_started_at=NOW(), updated_at=NOW()
       WHERE id=:id AND attempt_count < :maxAttempts
         AND (
           (status IN ('PENDING','RETRY') AND (next_retry_at IS NULL OR next_retry_at <= NOW()))
           OR (status='PROCESSING' AND COALESCE(processing_started_at, updated_at) < DATE_SUB(NOW(), INTERVAL ${lockMinutes} MINUTE))
         )`,
      { id: row.id, maxAttempts, claimToken }
    )
    if (Number(result.affectedRows || 0) !== 1) continue
    const [record] = await pool.query(
      "SELECT * FROM wechat_fulfillment_records WHERE id=:id AND claim_token=:claimToken LIMIT 1",
      { id: row.id, claimToken }
    )
    if (record[0]) claimed.push(record[0])
  }
  return claimed
}

module.exports = { claimDueFulfillment, enqueueFulfillment }
