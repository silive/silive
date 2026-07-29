const crypto = require("crypto")

function positiveInteger(value, fallback, maximum) {
  const number = Math.floor(Number(value))
  if (!Number.isFinite(number) || number <= 0) return fallback
  return Math.min(number, maximum)
}

async function markOrderPaidAndEnqueue(options = {}) {
  const pool = options.pool
  const orderId = String(options.orderId || "").trim()
  const transactionId = String(options.transactionId || "").trim()
  const notificationType = options.notificationType == null ? null : String(options.notificationType).trim()
  if (!pool || !orderId) throw new Error("支付事务参数不完整")

  const connection = await pool.getConnection()
  try {
    await connection.beginTransaction()
    const [orders] = await connection.query(
      "SELECT id, payment_status FROM orders WHERE id = :orderId FOR UPDATE",
      { orderId }
    )
    if (!orders[0]) throw new Error("本地订单不存在，无法确认支付")

    let updated = false
    if (String(orders[0].payment_status || "") !== "已支付") {
      const [result] = await connection.query(
        `UPDATE orders
         SET payment_status = '已支付',
             status = '待发货',
             transaction_id = :transactionId,
             paid_at = NOW()
         WHERE id = :orderId AND payment_status <> '已支付'`,
        { orderId, transactionId }
      )
      if (Number(result.affectedRows || 0) !== 1) throw new Error("订单支付状态更新失败")
      updated = true
    }

    const [notificationResult] = await connection.query(
      `INSERT INTO order_notification_records
        (order_id, notification_type, status, attempt_count, next_retry_at, created_at, updated_at)
       VALUES
        (:orderId, :notificationType, 'PENDING', 0, NOW(), NOW(), NOW())
       ON DUPLICATE KEY UPDATE id = id`,
      { orderId, notificationType }
    )
    await connection.commit()
    return {
      updated,
      queued: Number(notificationResult.affectedRows || 0) === 1
    }
  } catch (error) {
    await connection.rollback().catch(() => {})
    throw error
  } finally {
    connection.release()
  }
}

async function claimDueNotifications(options = {}) {
  const pool = options.pool
  const notificationType = String(options.notificationType || "").trim()
  const maxAttempts = positiveInteger(options.maxAttempts, 4, 20)
  const limit = positiveInteger(options.limit, 10, 50)
  const lockMinutes = positiveInteger(options.lockMinutes, 2, 60)
  if (!pool || !notificationType) return []

  const [rows] = await pool.query(
    `SELECT id
     FROM order_notification_records
     WHERE notification_type = :notificationType
       AND attempt_count < :maxAttempts
       AND (
         (status IN ('PENDING', 'RETRY') AND (next_retry_at IS NULL OR next_retry_at <= NOW()))
         OR (
           status = 'PROCESSING'
           AND COALESCE(processing_started_at, updated_at) < DATE_SUB(NOW(), INTERVAL ${lockMinutes} MINUTE)
         )
       )
     ORDER BY COALESCE(next_retry_at, created_at), id
     LIMIT ${limit}`,
    { notificationType, maxAttempts }
  )

  const claimed = []
  for (const row of rows) {
    const claimToken = crypto.randomUUID()
    const [result] = await pool.query(
      `UPDATE order_notification_records
       SET status = 'PROCESSING',
           attempt_count = attempt_count + 1,
           claim_token = :claimToken,
           processing_started_at = NOW(),
           updated_at = NOW()
       WHERE id = :id
         AND notification_type = :notificationType
         AND attempt_count < :maxAttempts
         AND (
           (status IN ('PENDING', 'RETRY') AND (next_retry_at IS NULL OR next_retry_at <= NOW()))
           OR (
             status = 'PROCESSING'
             AND COALESCE(processing_started_at, updated_at) < DATE_SUB(NOW(), INTERVAL ${lockMinutes} MINUTE)
           )
         )`,
      { id: row.id, notificationType, maxAttempts, claimToken }
    )
    if (Number(result.affectedRows || 0) !== 1) continue
    const [records] = await pool.query(
      `SELECT id, order_id, attempt_count, claim_token
       FROM order_notification_records
       WHERE id = :id AND claim_token = :claimToken
       LIMIT 1`,
      { id: row.id, claimToken }
    )
    if (records[0]) claimed.push(records[0])
  }
  return claimed
}

async function compensateMissingPaidNotifications(options = {}) {
  const pool = options.pool
  const notificationType = String(options.notificationType || "").trim()
  const recentHours = positiveInteger(options.recentHours, 48, 720)
  const scanDays = positiveInteger(options.scanDays, 90, 365)
  const limit = positiveInteger(options.limit, 200, 1000)
  const orderIdPrefix = String(options.orderIdPrefix || "").replace(/[^\w-]/g, "").slice(0, 20)
  if (!pool || !notificationType) return { scanned: 0, queued: 0, skippedHistorical: 0 }

  const [orders] = await pool.query(
    `SELECT o.id,
            CASE WHEN COALESCE(o.paid_at, o.created_at) >= DATE_SUB(NOW(), INTERVAL ${recentHours} HOUR)
              THEN 1 ELSE 0 END AS is_recent
     FROM orders o
     LEFT JOIN order_notification_records n
       ON n.order_id = o.id AND n.notification_type = :notificationType
     WHERE n.id IS NULL
       AND o.payment_status = '已支付'
       AND (:orderIdPrefix = '' OR o.id LIKE :orderIdLike)
       AND COALESCE(o.paid_at, o.created_at) >= DATE_SUB(NOW(), INTERVAL ${scanDays} DAY)
       AND COALESCE(o.status, '') NOT IN ('已退款', '已取消', '退款中', '已关闭', '已作废')
     ORDER BY COALESCE(o.paid_at, o.created_at) DESC
     LIMIT ${limit}`,
    {
      notificationType,
      orderIdPrefix,
      orderIdLike: `${orderIdPrefix}%`
    }
  )

  let queued = 0
  let skippedHistorical = 0
  for (const order of orders) {
    const recent = Number(order.is_recent || 0) === 1
    const [result] = await pool.query(
      `INSERT IGNORE INTO order_notification_records
        (order_id, notification_type, status, attempt_count, last_error, next_retry_at, created_at, updated_at)
       VALUES
        (:orderId, :notificationType, :status, 0, :lastError, ${recent ? "NOW()" : "NULL"}, NOW(), NOW())`,
      {
        orderId: order.id,
        notificationType,
        status: recent ? "PENDING" : "SKIPPED",
        lastError: recent ? null : "历史订单超过补发窗口，未推送企业微信群"
      }
    )
    if (Number(result.affectedRows || 0) !== 1) continue
    if (recent) queued += 1
    else skippedHistorical += 1
  }
  return { scanned: orders.length, queued, skippedHistorical }
}

module.exports = {
  claimDueNotifications,
  compensateMissingPaidNotifications,
  markOrderPaidAndEnqueue
}
