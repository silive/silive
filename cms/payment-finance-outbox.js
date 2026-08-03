const crypto = require("crypto")

const PAYMENT_FINANCE_EVENT_TYPE = "PAYMENT_FINANCE_POST_PROCESS"
const PAYMENT_FINANCE_MAX_ATTEMPTS = 12

function positiveInteger(value, fallback, maximum) {
  const number = Math.floor(Number(value))
  if (!Number.isFinite(number) || number <= 0) return fallback
  return Math.min(number, maximum)
}

function paymentFinanceBusinessKey(orderId, transactionId) {
  const safeOrderId = String(orderId || "").trim()
  const safeTransactionId = String(transactionId || "").trim() || "verified"
  if (!safeOrderId) throw new Error("支付财务事件缺少订单号")
  return `payment_success:${safeOrderId}:${safeTransactionId}`
}

async function enqueuePaymentFinanceEvent(connection, options = {}) {
  const orderId = String(options.orderId || "").trim()
  const transactionId = String(options.transactionId || "").trim()
  if (!connection || !orderId) throw new Error("支付财务事件参数不完整")
  const [result] = await connection.query(
    `INSERT IGNORE INTO payment_finance_outbox
      (event_type, business_key, aggregate_type, aggregate_id, payload_json,
       status, attempt_count, available_at, created_at, updated_at)
     VALUES
      (:eventType, :businessKey, 'order', :orderId, :payload,
       'PENDING', 0, NOW(), NOW(), NOW())`,
    {
      eventType: PAYMENT_FINANCE_EVENT_TYPE,
      businessKey: paymentFinanceBusinessKey(orderId, transactionId),
      orderId,
      payload: JSON.stringify({ orderId, paymentFact: transactionId ? "wechat_transaction" : "verified_payment" })
    }
  )
  return Number(result.affectedRows || 0) === 1
}

async function claimDuePaymentFinanceEvents(options = {}) {
  const pool = options.pool
  const limit = positiveInteger(options.limit, 10, 100)
  const lockMinutes = positiveInteger(options.lockMinutes, 5, 60)
  const maxAttempts = positiveInteger(options.maxAttempts, PAYMENT_FINANCE_MAX_ATTEMPTS, 50)
  if (!pool) return []

  const [rows] = await pool.query(
    `SELECT id
     FROM payment_finance_outbox
     WHERE event_type=:eventType
       AND attempt_count < :maxAttempts
       AND (
         (status IN ('PENDING','RETRY') AND (available_at IS NULL OR available_at <= NOW()))
         OR (status='PROCESSING' AND COALESCE(locked_at,updated_at) < DATE_SUB(NOW(), INTERVAL ${lockMinutes} MINUTE))
       )
     ORDER BY COALESCE(available_at,created_at), id
     LIMIT ${limit}`,
    { eventType: PAYMENT_FINANCE_EVENT_TYPE, maxAttempts }
  )

  const claimed = []
  for (const row of rows) {
    const lockedBy = crypto.randomUUID()
    const [result] = await pool.query(
      `UPDATE payment_finance_outbox
       SET status='PROCESSING', attempt_count=attempt_count+1,
           locked_at=NOW(), locked_by=:lockedBy, updated_at=NOW()
       WHERE id=:id
         AND event_type=:eventType
         AND attempt_count < :maxAttempts
         AND (
           (status IN ('PENDING','RETRY') AND (available_at IS NULL OR available_at <= NOW()))
           OR (status='PROCESSING' AND COALESCE(locked_at,updated_at) < DATE_SUB(NOW(), INTERVAL ${lockMinutes} MINUTE))
         )`,
      { id: row.id, lockedBy, eventType: PAYMENT_FINANCE_EVENT_TYPE, maxAttempts }
    )
    if (Number(result.affectedRows || 0) !== 1) continue
    const [records] = await pool.query(
      `SELECT id, aggregate_id, business_key, attempt_count, locked_by
       FROM payment_finance_outbox
       WHERE id=:id AND locked_by=:lockedBy LIMIT 1`,
      { id: row.id, lockedBy }
    )
    if (records[0]) claimed.push(records[0])
  }
  return claimed
}

async function completePaymentFinanceEvent(connection, record, status = "COMPLETED") {
  if (!connection || !record?.id || !record?.locked_by) throw new Error("支付财务事件完成参数不完整")
  const [result] = await connection.query(
    `UPDATE payment_finance_outbox
     SET status=:status, processed_at=NOW(), locked_at=NULL, locked_by=NULL,
         last_error=NULL, updated_at=NOW()
     WHERE id=:id AND status='PROCESSING' AND locked_by=:lockedBy`,
    { id: record.id, lockedBy: record.locked_by, status }
  )
  if (Number(result.affectedRows || 0) !== 1) throw new Error("支付财务事件认领已失效")
}

async function failPaymentFinanceEvent(options = {}) {
  const pool = options.pool
  const record = options.record || {}
  const maxAttempts = positiveInteger(options.maxAttempts, PAYMENT_FINANCE_MAX_ATTEMPTS, 50)
  const retryMinutes = positiveInteger(options.retryMinutes, 1, 60)
  if (!pool || !record.id || !record.locked_by) return false
  const attemptCount = Number(record.attempt_count || 0)
  const exhausted = attemptCount >= maxAttempts
  const [result] = await pool.query(
    `UPDATE payment_finance_outbox
     SET status=:status,
         available_at=${exhausted ? "NULL" : "DATE_ADD(NOW(), INTERVAL :retryMinutes MINUTE)"},
         locked_at=NULL, locked_by=NULL, last_error=:lastError, updated_at=NOW()
     WHERE id=:id AND status='PROCESSING' AND locked_by=:lockedBy`,
    {
      id: record.id,
      lockedBy: record.locked_by,
      status: exhausted ? "FAILED" : "RETRY",
      retryMinutes,
      lastError: String(options.error?.message || options.error || "支付财务事件处理失败").slice(0, 500)
    }
  )
  return Number(result.affectedRows || 0) === 1
}

async function compensateMissingPaymentFinanceEvents(options = {}) {
  const pool = options.pool
  const scanDays = positiveInteger(options.scanDays, 30, 3650)
  const limit = positiveInteger(options.limit, 100, 1000)
  const batchSize = positiveInteger(options.batchSize, 25, 100)
  const cursor = String(options.cursor || "").trim().replace(/[^A-Za-z0-9_-]/g, "").slice(0, 120)
  const startAt = String(options.startAt || "").trim().slice(0, 32)
  const endAt = String(options.endAt || "").trim().slice(0, 32)
  const apply = options.apply === true
  if (!pool) return { scanned: 0, queued: 0, dryRun: !apply, nextCursor: "" }
  const [orders] = await pool.query(
    `SELECT o.id, o.transaction_id
     FROM orders o
     LEFT JOIN payment_finance_outbox e
       ON e.event_type=:eventType
       AND e.aggregate_type='order'
       AND e.aggregate_id=o.id
     WHERE e.id IS NULL
       AND o.payment_status='已支付'
       AND COALESCE(o.status,'') NOT IN ('已取消','cancelled','canceled','已关闭','closed','已作废','void','已退款','退款中','退款处理中','PAID_AFTER_CANCEL')
       AND (:cursor = '' OR o.id > :cursor)
       AND (:startAt = '' OR COALESCE(o.paid_at,o.created_at) >= :startAt)
       AND (:endAt = '' OR COALESCE(o.paid_at,o.created_at) <= :endAt)
       AND (:startAt <> '' OR COALESCE(o.paid_at,o.created_at) >= DATE_SUB(NOW(), INTERVAL ${scanDays} DAY))
     ORDER BY o.id
     LIMIT ${limit}`,
    { eventType: PAYMENT_FINANCE_EVENT_TYPE, cursor, startAt, endAt }
  )
  if (!apply) {
    return {
      scanned: orders.length,
      queued: 0,
      dryRun: true,
      nextCursor: orders.length === limit ? String(orders[orders.length - 1].id || "") : ""
    }
  }
  let queued = 0
  for (let offset = 0; offset < orders.length; offset += batchSize) {
    const batch = orders.slice(offset, offset + batchSize)
    const connection = await pool.getConnection()
    try {
      await connection.beginTransaction()
      for (const order of batch) {
        if (await enqueuePaymentFinanceEvent(connection, {
          orderId: order.id,
          transactionId: order.transaction_id || ""
        })) queued += 1
      }
      await connection.commit()
    } catch (error) {
      await connection.rollback().catch(() => {})
      throw error
    } finally {
      connection.release()
    }
  }
  return {
    scanned: orders.length,
    queued,
    dryRun: false,
    nextCursor: orders.length === limit ? String(orders[orders.length - 1].id || "") : ""
  }
}

module.exports = {
  PAYMENT_FINANCE_EVENT_TYPE,
  PAYMENT_FINANCE_MAX_ATTEMPTS,
  claimDuePaymentFinanceEvents,
  compensateMissingPaymentFinanceEvents,
  completePaymentFinanceEvent,
  enqueuePaymentFinanceEvent,
  failPaymentFinanceEvent,
  paymentFinanceBusinessKey
}
