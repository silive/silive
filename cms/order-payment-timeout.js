"use strict"

const crypto = require("crypto")
const { releaseOrderInventory } = require("./inventory-ledger")

const ORDER_PAYMENT_TIMEOUT_MAX_ATTEMPTS = 12
const PENDING_PAYMENT_VALUES = new Set(["待支付", "未支付", "unpaid", "pending_payment"])
const TERMINAL_ORDER_VALUES = new Set([
  "已取消", "取消", "已关闭", "关闭", "作废", "已退款", "退款中", "退款处理中",
  "cancelled", "canceled", "closed", "void", "refunded", "refund_processing", "paid_after_cancel"
])

function positiveInteger(value, fallback, maximum) {
  const number = Math.floor(Number(value))
  if (!Number.isFinite(number) || number <= 0) return fallback
  return Math.min(number, maximum)
}

function paymentTimeoutMinutes(value = process.env.ORDER_PAYMENT_TIMEOUT_MINUTES) {
  return positiveInteger(value, 30, 24 * 60)
}

function paymentExpiresAt(now = new Date(), timeoutMinutes = paymentTimeoutMinutes()) {
  const date = new Date(now.getTime() + positiveInteger(timeoutMinutes, 30, 24 * 60) * 60 * 1000)
  return date
}

function normalized(value) {
  return String(value || "").trim().toLowerCase()
}

function isPendingPaymentOrder(order = {}) {
  const status = normalized(order.status)
  const paymentStatus = normalized(order.payment_status || order.paymentStatus)
  if (!PENDING_PAYMENT_VALUES.has(status) || !PENDING_PAYMENT_VALUES.has(paymentStatus)) return false
  return !order.transaction_id && !order.transactionId && !order.paid_at && !order.paidAt
}

function isTerminalOrder(order = {}) {
  return [order.status, order.payment_status || order.paymentStatus, order.refund_status || order.refundStatus,
    order.after_sales_status || order.afterSalesStatus]
    .some(value => TERMINAL_ORDER_VALUES.has(normalized(value)))
}

function hasPaidOrderEvidence(order = {}) {
  const values = [order.status, order.payment_status || order.paymentStatus]
    .map(normalized)
  return values.some(value => ["已支付", "paid", "success", "支付成功", "异常已支付", "paid_after_cancel"].includes(value)) ||
    !!(order.transaction_id || order.transactionId || order.paid_at || order.paidAt)
}

function safeDate(value) {
  if (!value) return null
  const date = new Date(String(value).replace(" ", "T"))
  return Number.isNaN(date.getTime()) ? null : date
}

function isExpired(order = {}, now = new Date()) {
  const expiresAt = safeDate(order.payment_expires_at || order.paymentExpiresAt)
  return !!expiresAt && expiresAt.getTime() <= now.getTime()
}

function timeoutCandidateDecision(order = {}, hasVerifiedPaymentFact, now = new Date()) {
  if (hasVerifiedPaymentFact) return { action: "CANCEL", reason: "已存在已核验支付事实" }
  if (hasPaidOrderEvidence(order)) return { action: "CANCEL", reason: "订单已存在支付证据" }
  if (isTerminalOrder(order)) return { action: "CANCEL", reason: "订单已进入终态" }
  if (!isPendingPaymentOrder(order)) return { action: "RETRY", reason: "订单支付状态仍在处理中" }
  if (!isExpired(order, now)) return { action: "RETRY", reason: "订单尚未到支付截止时间" }
  return { action: "CLOSE" }
}

async function enqueueOrderPaymentTimeout(connection, options = {}) {
  const orderId = String(options.orderId || "").trim()
  const expiresAt = options.expiresAt
  if (!connection || !orderId || !expiresAt) throw new Error("支付超时任务参数不完整")
  const [result] = await connection.query(
    `INSERT IGNORE INTO order_payment_timeout_jobs
      (order_id, status, attempt_count, available_at, created_at, updated_at)
     VALUES (:orderId, 'PENDING', 0, :expiresAt, NOW(), NOW())`,
    { orderId, expiresAt }
  )
  return Number(result.affectedRows || 0) === 1
}

async function claimDueOrderPaymentTimeoutJobs(options = {}) {
  const pool = options.pool
  const limit = positiveInteger(options.limit, 20, 100)
  const lockMinutes = positiveInteger(options.lockMinutes, 5, 60)
  const maxAttempts = positiveInteger(options.maxAttempts, ORDER_PAYMENT_TIMEOUT_MAX_ATTEMPTS, 50)
  if (!pool) return []
  const [rows] = await pool.query(
    `SELECT id
     FROM order_payment_timeout_jobs
     WHERE attempt_count < :maxAttempts
       AND (
         (status IN ('PENDING','RETRY') AND available_at <= NOW())
         OR (status='PROCESSING' AND COALESCE(locked_at,updated_at) < DATE_SUB(NOW(), INTERVAL ${lockMinutes} MINUTE))
       )
     ORDER BY available_at, id
     LIMIT ${limit}`,
    { maxAttempts }
  )
  const claimed = []
  for (const row of rows) {
    const lockedBy = crypto.randomUUID()
    const [result] = await pool.query(
      `UPDATE order_payment_timeout_jobs
       SET status='PROCESSING', attempt_count=attempt_count+1, locked_at=NOW(),
           locked_by=:lockedBy, updated_at=NOW()
       WHERE id=:id
         AND attempt_count < :maxAttempts
         AND (
           (status IN ('PENDING','RETRY') AND available_at <= NOW())
           OR (status='PROCESSING' AND COALESCE(locked_at,updated_at) < DATE_SUB(NOW(), INTERVAL ${lockMinutes} MINUTE))
         )`,
      { id: row.id, lockedBy, maxAttempts }
    )
    if (Number(result.affectedRows || 0) !== 1) continue
    const [records] = await pool.query(
      `SELECT id, order_id, attempt_count, locked_by
       FROM order_payment_timeout_jobs
       WHERE id=:id AND locked_by=:lockedBy LIMIT 1`,
      { id: row.id, lockedBy }
    )
    if (records[0]) claimed.push(records[0])
  }
  return claimed
}

async function updateTimeoutJob(connection, record, status, options = {}) {
  const [result] = await connection.query(
    `UPDATE order_payment_timeout_jobs
     SET status=:status, processed_at=${["COMPLETED", "CANCELLED"].includes(status) ? "NOW()" : "processed_at"},
         available_at=${status === "RETRY" ? "DATE_ADD(NOW(), INTERVAL :retryMinutes MINUTE)" : "available_at"},
         locked_at=NULL, locked_by=NULL, last_error=:lastError, updated_at=NOW()
     WHERE id=:id AND status='PROCESSING' AND locked_by=:lockedBy`,
    {
      id: record.id,
      lockedBy: record.locked_by,
      status,
      retryMinutes: positiveInteger(options.retryMinutes, 1, 60),
      lastError: options.lastError ? String(options.lastError).slice(0, 500) : null
    }
  )
  if (Number(result.affectedRows || 0) !== 1) throw new Error("支付超时任务认领已失效")
}

async function closeOrderForPaymentTimeout(options = {}) {
  const pool = options.pool
  const record = options.record || {}
  if (!pool || !record.id || !record.locked_by || !record.order_id) throw new Error("支付超时任务参数不完整")
  const connection = await pool.getConnection()
  try {
    await connection.beginTransaction()
    const [jobs] = await connection.query(
      `SELECT id, order_id, status, locked_by
       FROM order_payment_timeout_jobs WHERE id=:id FOR UPDATE`,
      { id: record.id }
    )
    const job = jobs[0]
    if (!job || job.status !== "PROCESSING" || job.locked_by !== record.locked_by) {
      throw new Error("支付超时任务认领已失效")
    }
    const [orders] = await connection.query(
      `SELECT id, status, payment_status, transaction_id, paid_at, refund_status, after_sales_status,
              payment_expires_at, stock_reserved_at, stock_released_at
       FROM orders WHERE id=:orderId FOR UPDATE`,
      { orderId: record.order_id }
    )
    const order = orders[0]
    if (!order) {
      await updateTimeoutJob(connection, record, "CANCELLED", { lastError: "订单不存在" })
      await connection.commit()
      return { outcome: "MISSING" }
    }
    const [facts] = await connection.query(
      `SELECT id FROM order_payment_facts
       WHERE order_id=:orderId AND payment_state='SUCCESS' AND amount_verified=1
       LIMIT 1 FOR UPDATE`,
      { orderId: order.id }
    )
    const decision = timeoutCandidateDecision(order, !!facts[0])
    if (decision.action === "CANCEL") {
      await updateTimeoutJob(connection, record, "CANCELLED", { lastError: decision.reason })
      await connection.commit()
      return { outcome: "SKIPPED", reason: decision.reason }
    }
    if (decision.action === "RETRY") {
      await updateTimeoutJob(connection, record, "RETRY", { lastError: decision.reason })
      await connection.commit()
      return { outcome: "RETRY", reason: decision.reason }
    }
    const [closed] = await connection.query(
      `UPDATE orders
       SET status='已关闭', payment_status='支付超时关闭',
           stock_released_at=CASE
             WHEN stock_reserved_at IS NOT NULL THEN COALESCE(stock_released_at, NOW())
             ELSE stock_released_at
           END
       WHERE id=:orderId
         AND status IN ('待支付','未支付','unpaid','pending_payment')
         AND payment_status IN ('待支付','未支付','unpaid','pending_payment')
         AND transaction_id IS NULL
         AND paid_at IS NULL
         AND payment_expires_at IS NOT NULL
         AND payment_expires_at <= NOW()`,
      { orderId: order.id }
    )
    if (Number(closed.affectedRows || 0) !== 1) {
      await updateTimeoutJob(connection, record, "RETRY", { lastError: "订单状态在关闭前发生变化" })
      await connection.commit()
      return { outcome: "RETRY", reason: "订单状态在关闭前发生变化" }
    }
    const release = await releaseOrderInventory(connection, order.id, {
      reason: "支付超时关闭",
      sourceType: "payment_timeout",
      sourceId: order.id,
      releaseRemaining: true
    })
    await connection.query(
      `INSERT INTO order_state_audit
        (order_id, old_order_status, new_order_status, action_source, operator_id, reason, created_at)
       VALUES (:orderId, :oldStatus, '已关闭', 'payment_timeout_worker', 'system', '支付超时关闭，已释放有限库存', NOW())`,
      { orderId: order.id, oldStatus: order.status || "" }
    )
    await updateTimeoutJob(connection, record, "COMPLETED")
    await connection.commit()
    return { outcome: "CLOSED", release }
  } catch (error) {
    await connection.rollback().catch(() => {})
    throw error
  } finally {
    connection.release()
  }
}

async function failOrderPaymentTimeoutJob(options = {}) {
  const pool = options.pool
  const record = options.record || {}
  const maxAttempts = positiveInteger(options.maxAttempts, ORDER_PAYMENT_TIMEOUT_MAX_ATTEMPTS, 50)
  if (!pool || !record.id || !record.locked_by) return false
  const exhausted = Number(record.attempt_count || 0) >= maxAttempts
  const [result] = await pool.query(
    `UPDATE order_payment_timeout_jobs
     SET status=:status,
         available_at=${exhausted ? "NULL" : "DATE_ADD(NOW(), INTERVAL :retryMinutes MINUTE)"},
         locked_at=NULL, locked_by=NULL, last_error=:lastError, updated_at=NOW()
     WHERE id=:id AND status='PROCESSING' AND locked_by=:lockedBy`,
    {
      id: record.id,
      lockedBy: record.locked_by,
      status: exhausted ? "FAILED" : "RETRY",
      retryMinutes: positiveInteger(options.retryMinutes, 1, 60),
      lastError: String(options.error?.message || options.error || "支付超时任务失败").slice(0, 500)
    }
  )
  return Number(result.affectedRows || 0) === 1
}

module.exports = {
  ORDER_PAYMENT_TIMEOUT_MAX_ATTEMPTS,
  claimDueOrderPaymentTimeoutJobs,
  closeOrderForPaymentTimeout,
  enqueueOrderPaymentTimeout,
  failOrderPaymentTimeoutJob,
  isExpired,
  isPendingPaymentOrder,
  paymentExpiresAt,
  paymentTimeoutMinutes,
  timeoutCandidateDecision
}
