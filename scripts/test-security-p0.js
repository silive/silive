"use strict"

const assert = require("assert")
const {
  markOrderPaidAndEnqueue
} = require("../cms/wecom-order-outbox")
const {
  hashAttributionToken,
  issueAttributionToken
} = require("../cms/store-attribution")

function fakePool(order) {
  const state = {
    order: { ...order },
    committed: false,
    rolledBack: false,
    notifications: 0,
    paymentFacts: 0,
    audits: []
  }
  const connection = {
    async beginTransaction() {},
    async commit() { state.committed = true },
    async rollback() { state.rolledBack = true },
    release() {},
    async query(sql, params) {
      if (sql.includes("SELECT id, status, payment_status")) return [[state.order]]
      if (sql.includes("INSERT IGNORE INTO order_payment_facts")) {
        state.paymentFacts += 1
        return [{ affectedRows: 1 }]
      }
      if (sql.includes("INSERT INTO order_state_audit")) {
        state.audits.push(params)
        return [{ affectedRows: 1 }]
      }
      if (sql.includes("SET payment_status = '异常已支付'")) {
        state.order.status = "PAID_AFTER_CANCEL"
        state.order.payment_status = "异常已支付"
        return [{ affectedRows: 1 }]
      }
      if (sql.includes("SET payment_status = '已支付'")) {
        state.order.status = "待发货"
        state.order.payment_status = "已支付"
        return [{ affectedRows: 1 }]
      }
      if (sql.includes("INSERT IGNORE INTO order_notification_records")) {
        state.notifications += 1
        return [{ affectedRows: 1 }]
      }
      throw new Error(`unexpected SQL: ${sql.slice(0, 80)}`)
    }
  }
  return {
    state,
    pool: { async getConnection() { return connection } }
  }
}

async function main() {
  const tokenA = issueAttributionToken()
  const tokenB = issueAttributionToken()
  assert.notStrictEqual(tokenA, tokenB)
  assert.strictEqual(tokenA.length >= 40, true)
  assert.strictEqual(hashAttributionToken(tokenA).length, 64)
  assert.strictEqual(hashAttributionToken(tokenA), hashAttributionToken(tokenA))

  const paid = fakePool({
    id: "ORDER-PAID",
    status: "待支付",
    payment_status: "待支付",
    refund_status: "",
    after_sales_status: ""
  })
  const paidResult = await markOrderPaidAndEnqueue({
    pool: paid.pool,
    orderId: "ORDER-PAID",
    transactionId: "TX-PAID",
    notificationType: "WECOM_ORDER_PAID"
  })
  assert.deepStrictEqual(paidResult, { updated: true, queued: true, outcome: "PAID" })
  assert.strictEqual(paid.state.notifications, 1)
  assert.strictEqual(paid.state.paymentFacts, 1)

  const refunded = fakePool({
    id: "ORDER-REFUNDED",
    status: "已退款",
    payment_status: "已退款",
    refund_status: "退款成功",
    after_sales_status: "refunded"
  })
  const refundedResult = await markOrderPaidAndEnqueue({
    pool: refunded.pool,
    orderId: "ORDER-REFUNDED",
    transactionId: "TX-REFUNDED",
    notificationType: "WECOM_ORDER_PAID"
  })
  assert.strictEqual(refundedResult.outcome, "PAYMENT_FACT_ONLY")
  assert.strictEqual(refunded.state.order.status, "已退款")
  assert.strictEqual(refunded.state.notifications, 0)

  const cancelled = fakePool({
    id: "ORDER-CANCELLED",
    status: "已取消",
    payment_status: "待支付",
    refund_status: "",
    after_sales_status: ""
  })
  const cancelledResult = await markOrderPaidAndEnqueue({
    pool: cancelled.pool,
    orderId: "ORDER-CANCELLED",
    transactionId: "TX-CANCELLED",
    notificationType: "WECOM_ORDER_PAID"
  })
  assert.strictEqual(cancelledResult.outcome, "PAID_AFTER_CANCEL")
  assert.strictEqual(cancelled.state.order.status, "PAID_AFTER_CANCEL")
  assert.strictEqual(cancelled.state.notifications, 0)

  console.log("security P0 tests passed")
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
