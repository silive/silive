"use strict"

const assert = require("assert")
const fs = require("fs")
const path = require("path")
const {
  assertAdminTransition,
  fulfillmentStatus,
  lifecycleView,
  serviceFeeStatus
} = require("../cms/order-lifecycle")
const {
  claimDueFulfillment,
  enqueueFulfillment
} = require("../cms/wechat-fulfillment-outbox")

function pickupOrder(overrides = {}) {
  return {
    id: "ORDER-1",
    deliveryType: "pickup",
    paymentStatus: "已支付",
    status: "已发货",
    pickupStatus: "preparing",
    pickupServiceFee: "2.00",
    ...overrides
  }
}

class FulfillmentPool {
  constructor() {
    this.rows = []
    this.nextId = 1
  }

  async query(sql, params = {}) {
    if (sql.includes("INSERT IGNORE INTO wechat_fulfillment_records")) {
      const duplicate = this.rows.find(row => row.order_id === params.orderId && row.business_node === params.node)
      if (duplicate) return [{ affectedRows: 0 }]
      this.rows.push({
        id: this.nextId++,
        order_id: params.orderId,
        business_node: params.node,
        status: "PENDING",
        attempt_count: 0,
        next_retry_at: new Date(0),
        processing_started_at: null,
        claim_token: null
      })
      return [{ affectedRows: 1 }]
    }
    if (sql.includes("SELECT id FROM wechat_fulfillment_records")) {
      return [this.rows.filter(row =>
        row.attempt_count < Number(params.maxAttempts) &&
        ["PENDING", "RETRY"].includes(row.status)
      ).map(row => ({ id: row.id }))]
    }
    if (sql.includes("UPDATE wechat_fulfillment_records")) {
      const row = this.rows.find(item => item.id === params.id)
      if (!row || row.attempt_count >= Number(params.maxAttempts) || !["PENDING", "RETRY"].includes(row.status)) {
        return [{ affectedRows: 0 }]
      }
      row.status = "PROCESSING"
      row.attempt_count += 1
      row.claim_token = params.claimToken
      row.processing_started_at = new Date()
      return [{ affectedRows: 1 }]
    }
    if (sql.includes("SELECT * FROM wechat_fulfillment_records")) {
      return [[this.rows.find(row => row.id === params.id && row.claim_token === params.claimToken)].filter(Boolean)]
    }
    throw new Error(`Unexpected SQL in fulfillment test: ${sql}`)
  }
}

async function main() {
  assert.equal(fulfillmentStatus(pickupOrder()), "DELIVERING_TO_STORE")
  assert.equal(fulfillmentStatus(pickupOrder({ pickupStatus: "arrived_store" })), "READY_FOR_PICKUP")
  assert.equal(
    fulfillmentStatus(pickupOrder({ status: "已完成", pickupStatus: "picked_up" })),
    "PREPARING",
    "A pickup order is not verified merely because legacy status fields say completed."
  )
  assert.equal(
    fulfillmentStatus(pickupOrder({
      status: "已完成",
      pickupStatus: "picked_up",
      pickupVerifiedAt: "2026-07-29 10:00:00"
    })),
    "PICKED_UP"
  )
  assert.equal(
    lifecycleView(pickupOrder({
      status: "已完成",
      pickupStatus: "picked_up",
      pickupVerifiedAt: "2026-07-29 10:00:00",
      refundStatus: "退款成功"
    })).displayStatusText,
    "已退款",
    "Refund status must take precedence over fulfillment status."
  )
  assert.throws(
    () => assertAdminTransition(
      pickupOrder(),
      pickupOrder({ status: "已完成", pickupStatus: "picked_up" })
    ),
    /尚未完成自提核销/
  )

  assert.equal(serviceFeeStatus(pickupOrder()), "ESTIMATED")
  assert.equal(
    serviceFeeStatus(pickupOrder({
      status: "已完成",
      pickupStatus: "picked_up",
      pickupVerifiedAt: "2026-07-29 10:00:00"
    }), { status: "unsettled", amount: 2 }),
    "PAYABLE"
  )
  assert.equal(serviceFeeStatus(pickupOrder(), { status: "settled", amount: 2 }), "SETTLED")
  assert.equal(serviceFeeStatus(pickupOrder(), { status: "cancelled", amount: 2 }), "CANCELLED")
  assert.equal(serviceFeeStatus(pickupOrder(), { status: "unsettled", amount: -2 }), "CHARGEBACK")

  const pool = new FulfillmentPool()
  assert.equal(await enqueueFulfillment(pool, "ORDER-1", "PICKUP_READY"), true)
  assert.equal(await enqueueFulfillment(pool, "ORDER-1", "PICKUP_READY"), false)
  const claims = await Promise.all([
    claimDueFulfillment(pool, { limit: 5 }),
    claimDueFulfillment(pool, { limit: 5 })
  ])
  assert.equal(claims.flat().length, 1, "Concurrent workers must not claim the same task twice.")

  const root = path.resolve(__dirname, "..")
  const server = fs.readFileSync(path.join(root, "cms/server.js"), "utf8")
  const checkout = fs.readFileSync(path.join(root, "pages/checkout/checkout.js"), "utf8")
  const orders = fs.readFileSync(path.join(root, "pages/orders/orders.js"), "utf8")
  assert.match(server, /CREATE TABLE IF NOT EXISTS user_sessions/)
  assert.match(server, /CREATE TABLE IF NOT EXISTS order_request_keys/)
  assert.match(server, /upload_shipping_info/)
  assert.match(server, /upload_time: chinaIsoTime\(new Date\(\)\)/)
  assert.match(server, /startWechatFulfillmentWorker\(\)/)
  assert.match(server, /startRefundSyncWorker\(\)/)
  assert.match(server, /const queryRefundNo = order\.refundNo \|\| generateRefundNo\(order\.id\)/)
  assert.match(checkout, /ensureAuthenticated/)
  assert.match(checkout, /pendingOrderId/)
  assert.match(checkout, /requestKey: this\.data\.submitRequestKey/)
  assert.match(orders, /ensureAuthenticated/)

  console.log("order chain tests passed")
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
