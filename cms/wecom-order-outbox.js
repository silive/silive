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
      `SELECT id, status, payment_status, refund_status, after_sales_status
       FROM orders WHERE id = :orderId FOR UPDATE`,
      { orderId }
    )
    if (!orders[0]) throw new Error("本地订单不存在，无法确认支付")
    const order = orders[0]
    const status = String(order.status || "").trim().toLowerCase()
    const paymentStatus = String(order.payment_status || "").trim().toLowerCase()
    const refundStatus = String(order.refund_status || "").trim().toLowerCase()
    const afterSalesStatus = String(order.after_sales_status || "").trim().toLowerCase()
    const paymentFactId = crypto.createHash("sha256")
      .update(`${orderId}:${transactionId || "wechat-success"}`)
      .digest("hex")
    await connection.query(
      `INSERT IGNORE INTO order_payment_facts
        (id, order_id, transaction_id, payment_state, amount_verified, verified_at, created_at)
       VALUES
        (:id, :orderId, :transactionId, 'SUCCESS', 1, NOW(), NOW())`,
      { id: paymentFactId, orderId, transactionId }
    )

    const refunded = ["已退款", "退款成功", "refunded", "success"].includes(status) ||
      ["已退款", "refunded"].includes(paymentStatus) ||
      ["退款成功", "refunded", "success"].includes(refundStatus) ||
      ["refunded"].includes(afterSalesStatus)
    const refunding = ["退款中", "退款处理中", "refund_processing"].includes(status) ||
      ["退款处理中", "processing", "refund_pending"].includes(refundStatus) ||
      ["refund_pending"].includes(afterSalesStatus)
    const cancelled = ["已取消", "cancelled", "canceled", "已关闭", "closed", "已作废", "void"].includes(status)

    if (refunded || refunding) {
      await connection.query(
        `INSERT INTO order_state_audit
          (order_id, old_order_status, new_order_status, action_source, reason, operator_id, created_at)
         VALUES
          (:orderId, :previousStatus, :nextStatus, 'wechat_pay_notify',
           '退款或退款处理中订单收到支付成功事实，未恢复履约', 'system', NOW())`,
        {
          orderId,
          previousStatus: order.status || "",
          nextStatus: order.status || ""
        }
      )
      await connection.commit()
      return { updated: false, queued: false, outcome: "PAYMENT_FACT_ONLY" }
    }

    if (cancelled) {
      const [result] = await connection.query(
        `UPDATE orders
         SET payment_status = '异常已支付',
             status = 'PAID_AFTER_CANCEL',
             transaction_id = COALESCE(NULLIF(transaction_id, ''), :transactionId),
             paid_at = COALESCE(paid_at, NOW())
         WHERE id = :orderId
           AND status IN ('已取消','cancelled','canceled','已关闭','closed','已作废','void')`,
        { orderId, transactionId }
      )
      await connection.query(
        `INSERT INTO order_state_audit
          (order_id, old_order_status, new_order_status, action_source, reason, operator_id, created_at)
         VALUES
          (:orderId, :previousStatus, 'PAID_AFTER_CANCEL', 'wechat_pay_notify',
           '订单取消或关闭后确认真实付款，已阻止自动履约和收益创建', 'system', NOW())`,
        { orderId, previousStatus: order.status || "" }
      )
      await connection.commit()
      return {
        updated: Number(result.affectedRows || 0) === 1,
        queued: false,
        outcome: "PAID_AFTER_CANCEL"
      }
    }

    let updated = false
    if (String(order.payment_status || "") !== "已支付") {
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

    if (!notificationType) throw new Error("支付通知类型不能为空")
    const [notificationResult] = await connection.query(
      `INSERT IGNORE INTO order_notification_records
        (order_id, notification_type, status, attempt_count, next_retry_at, created_at, updated_at)
       VALUES
        (:orderId, :notificationType, 'PENDING', 0, NOW(), NOW(), NOW())`,
      { orderId, notificationType }
    )
    await connection.commit()
    return {
      updated,
      queued: Number(notificationResult.affectedRows || 0) === 1,
      outcome: updated ? "PAID" : "ALREADY_PAID"
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
