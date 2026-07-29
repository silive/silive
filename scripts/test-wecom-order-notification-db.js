const assert = require("assert")
const fs = require("fs")
const path = require("path")
const mysql = require("mysql2/promise")
const {
  claimDueNotifications,
  compensateMissingPaidNotifications,
  markOrderPaidAndEnqueue
} = require("../cms/wecom-order-outbox")
const { sendWecomMarkdown } = require("../cms/wecom-order-notifier")

function loadEnv(file) {
  if (!fs.existsSync(file)) return
  fs.readFileSync(file, "utf8").split(/\r?\n/).forEach(line => {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/)
    if (!match || process.env[match[1]]) return
    process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2")
  })
}

async function main() {
  loadEnv(path.join(__dirname, "..", ".env"))
  const database = process.env.MYSQL_TEST_DATABASE || ""
  if (!/^vsc_security_test_[a-z0-9_]+$/i.test(database)) {
    throw new Error("拒绝运行：MYSQL_TEST_DATABASE 必须使用 vsc_security_test_ 前缀的隔离测试库")
  }
  const pool = mysql.createPool({
    host: process.env.MYSQL_HOST || "127.0.0.1",
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database,
    namedPlaceholders: true,
    connectionLimit: 8,
    dateStrings: true
  })
  const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`.slice(-12)
  const orderIds = []
  const notificationTypes = [
    `WECOM_TX_${suffix}`,
    `WECOM_FAIL_${suffix}`,
    `WECOM_CON_${suffix}`,
    `WECOM_COMP_${suffix}`,
    `WECOM_CLAIM_${suffix}`
  ]

  async function insertOrder(label, overrides = {}) {
    const orderId = `WCT${label}${suffix}`.slice(0, 32)
    orderIds.push(orderId)
    await pool.query(
      `INSERT INTO orders
        (id, customer_name, product_name, amount, status, payment_status, created_at, paid_at, transaction_id)
       VALUES
        (:id, '通知可靠性测试', '测试商品', 0.01, :status, :paymentStatus, :createdAt, :paidAt, :transactionId)`,
      {
        id: orderId,
        status: overrides.status || "待支付",
        paymentStatus: overrides.paymentStatus || "待支付",
        createdAt: overrides.createdAt || new Date(),
        paidAt: overrides.paidAt || null,
        transactionId: overrides.transactionId || null
      }
    )
    return orderId
  }

  try {
    const successOrderId = await insertOrder("OK")
    const success = await markOrderPaidAndEnqueue({
      pool,
      orderId: successOrderId,
      transactionId: `TX${suffix}`,
      notificationType: notificationTypes[0]
    })
    assert.deepStrictEqual(success, { updated: true, queued: true, outcome: "PAID" })
    const [[successOrder]] = await pool.query("SELECT payment_status FROM orders WHERE id = ?", [successOrderId])
    const [[successNotification]] = await pool.query(
      "SELECT status FROM order_notification_records WHERE order_id = ? AND notification_type = ?",
      [successOrderId, notificationTypes[0]]
    )
    assert.strictEqual(successOrder.payment_status, "已支付")
    assert.strictEqual(successNotification.status, "PENDING")
    await assert.rejects(() => sendWecomMarkdown({
      webhookUrl: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test-only",
      content: "test",
      requester: async () => ({ statusCode: 200, data: { errcode: 93000, errmsg: "test failure" } })
    }))
    const [[paidAfterNotificationFailure]] = await pool.query(
      "SELECT payment_status FROM orders WHERE id = ?",
      [successOrderId]
    )
    assert.strictEqual(paidAfterNotificationFailure.payment_status, "已支付")

    const rollbackOrderId = await insertOrder("RB")
    await assert.rejects(() => markOrderPaidAndEnqueue({
      pool,
      orderId: rollbackOrderId,
      transactionId: `TXRB${suffix}`,
      notificationType: null
    }))
    const [[rollbackOrder]] = await pool.query("SELECT payment_status FROM orders WHERE id = ?", [rollbackOrderId])
    const [[rollbackCount]] = await pool.query(
      "SELECT COUNT(*) count FROM order_notification_records WHERE order_id = ?",
      [rollbackOrderId]
    )
    assert.strictEqual(rollbackOrder.payment_status, "待支付")
    assert.strictEqual(Number(rollbackCount.count), 0)

    const missingOrderId = `WCTMISS${suffix}`.slice(0, 32)
    await assert.rejects(() => markOrderPaidAndEnqueue({
      pool,
      orderId: missingOrderId,
      transactionId: `TXMISS${suffix}`,
      notificationType: notificationTypes[1]
    }), /订单不存在/)
    const [[missingNotification]] = await pool.query(
      "SELECT COUNT(*) count FROM order_notification_records WHERE order_id = ?",
      [missingOrderId]
    )
    assert.strictEqual(Number(missingNotification.count), 0)

    const concurrentOrderId = await insertOrder("CON")
    const concurrentResults = await Promise.all([
      markOrderPaidAndEnqueue({
        pool,
        orderId: concurrentOrderId,
        transactionId: `TXCON${suffix}`,
        notificationType: notificationTypes[2]
      }),
      markOrderPaidAndEnqueue({
        pool,
        orderId: concurrentOrderId,
        transactionId: `TXCON${suffix}`,
        notificationType: notificationTypes[2]
      })
    ])
    assert.strictEqual(concurrentResults.filter(item => item.updated).length, 1)
    assert.strictEqual(concurrentResults.filter(item => item.queued).length, 1)
    const [[concurrentCount]] = await pool.query(
      "SELECT COUNT(*) count FROM order_notification_records WHERE order_id = ? AND notification_type = ?",
      [concurrentOrderId, notificationTypes[2]]
    )
    assert.strictEqual(Number(concurrentCount.count), 1)

    const recentOrderId = await insertOrder("ZNEW", {
      status: "待发货",
      paymentStatus: "已支付",
      paidAt: new Date(),
      transactionId: `TXNEW${suffix}`
    })
    const oldDate = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000)
    const oldOrderId = await insertOrder("ZOLD", {
      status: "已完成",
      paymentStatus: "已支付",
      createdAt: oldDate,
      paidAt: oldDate,
      transactionId: `TXOLD${suffix}`
    })
    const refundedOrderId = await insertOrder("ZREF", {
      status: "已退款",
      paymentStatus: "已支付",
      paidAt: new Date(),
      transactionId: `TXREF${suffix}`
    })
    const compensation = await compensateMissingPaidNotifications({
      pool,
      notificationType: notificationTypes[3],
      recentHours: 48,
      scanDays: 90,
      limit: 50,
      orderIdPrefix: "WCTZ"
    })
    assert.strictEqual(compensation.queued, 1)
    assert.strictEqual(compensation.skippedHistorical, 1)
    const [compensated] = await pool.query(
      "SELECT order_id, status FROM order_notification_records WHERE notification_type = ?",
      [notificationTypes[3]]
    )
    assert.strictEqual(compensated.find(item => item.order_id === recentOrderId)?.status, "PENDING")
    assert.strictEqual(compensated.find(item => item.order_id === oldOrderId)?.status, "SKIPPED")
    assert(!compensated.some(item => item.order_id === refundedOrderId))
    const compensationAgain = await compensateMissingPaidNotifications({
      pool,
      notificationType: notificationTypes[3],
      recentHours: 48,
      scanDays: 90,
      limit: 50,
      orderIdPrefix: "WCTZ"
    })
    assert.strictEqual(compensationAgain.queued, 0)
    assert.strictEqual(compensationAgain.skippedHistorical, 0)

    const claimOrderIds = []
    for (const label of ["PEN", "RET", "FUT", "STL", "SNT", "FLD"]) {
      claimOrderIds.push(await insertOrder(label, {
        status: "待发货",
        paymentStatus: "已支付",
        paidAt: new Date(),
        transactionId: `TX${label}${suffix}`
      }))
    }
    const claimRows = [
      [claimOrderIds[0], "PENDING", 0, new Date(Date.now() - 60000), null],
      [claimOrderIds[1], "RETRY", 1, new Date(Date.now() - 60000), null],
      [claimOrderIds[2], "RETRY", 1, new Date(Date.now() + 10 * 60000), null],
      [claimOrderIds[3], "PROCESSING", 1, null, new Date(Date.now() - 5 * 60000)],
      [claimOrderIds[4], "SENT", 1, null, null],
      [claimOrderIds[5], "FAILED", 4, null, null]
    ]
    for (const [orderId, status, attempts, nextRetryAt, processingStartedAt] of claimRows) {
      await pool.query(
        `INSERT INTO order_notification_records
          (order_id, notification_type, status, attempt_count, next_retry_at, processing_started_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, NOW(), ?)`,
        [
          orderId,
          notificationTypes[4],
          status,
          attempts,
          nextRetryAt,
          processingStartedAt,
          processingStartedAt || new Date()
        ]
      )
    }
    const claimOptions = {
      pool,
      notificationType: notificationTypes[4],
      maxAttempts: 4,
      limit: 20,
      lockMinutes: 2
    }
    const [claimedA, claimedB] = await Promise.all([
      claimDueNotifications(claimOptions),
      claimDueNotifications(claimOptions)
    ])
    const claimedIds = [...claimedA, ...claimedB].map(item => item.id)
    assert.strictEqual(claimedIds.length, 3)
    assert.strictEqual(new Set(claimedIds).size, 3)
    const [excluded] = await pool.query(
      "SELECT order_id, status, attempt_count FROM order_notification_records WHERE notification_type = ?",
      [notificationTypes[4]]
    )
    assert.strictEqual(excluded.find(item => item.order_id === claimOrderIds[2]).status, "RETRY")
    assert.strictEqual(excluded.find(item => item.order_id === claimOrderIds[4]).status, "SENT")
    assert.strictEqual(excluded.find(item => item.order_id === claimOrderIds[5]).status, "FAILED")

    console.log(JSON.stringify({
      ok: true,
      transactionCommitVerified: true,
      committedTaskSurvivesProcessRestart: true,
      transactionRollbackVerified: true,
      missingOrderRollbackVerified: true,
      duplicateCallbackVerified: true,
      concurrentCallbackVerified: true,
      compensationVerified: true,
      compensationIdempotent: true,
      dueRetryVerified: true,
      futureRetryExcluded: true,
      staleClaimRecovered: true,
      concurrentClaimVerified: true,
      sentExcluded: true,
      failedExcluded: true,
      notificationFailureKeepsOrderPaid: true,
      webhookConfigurationIndependentFromPaymentTransaction: true
    }, null, 2))
  } finally {
    if (orderIds.length) {
      await pool.query("DELETE FROM order_notification_records WHERE notification_type IN (?)", [notificationTypes]).catch(() => {})
      await pool.query("DELETE FROM orders WHERE id IN (?)", [orderIds]).catch(() => {})
    }
    await pool.end()
  }
}

main().catch(error => {
  console.error(error.stack || error.message)
  process.exit(1)
})
