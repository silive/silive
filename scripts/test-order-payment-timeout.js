"use strict"

const assert = require("assert")
const fs = require("fs")
const path = require("path")
const {
  isExpired,
  isPendingPaymentOrder,
  paymentExpiresAt,
  paymentTimeoutMinutes,
  timeoutCandidateDecision
} = require("../cms/order-payment-timeout")

const now = new Date("2026-08-03T12:00:00.000Z")
const expiredFiniteOrder = {
  id: "ORDER-EXPIRED",
  status: "待支付",
  paymentStatus: "待支付",
  paymentExpiresAt: "2026-08-03 11:30:00",
  stockReservedAt: "2026-08-03 11:00:00"
}

assert.strictEqual(paymentTimeoutMinutes(""), 30)
assert.strictEqual(paymentTimeoutMinutes("45"), 45)
assert.strictEqual(paymentTimeoutMinutes("999999"), 24 * 60)
assert.strictEqual(paymentExpiresAt(now, 30).toISOString(), "2026-08-03T12:30:00.000Z")
assert.strictEqual(isPendingPaymentOrder(expiredFiniteOrder), true)
assert.strictEqual(isExpired(expiredFiniteOrder, now), true)
assert.deepStrictEqual(timeoutCandidateDecision(expiredFiniteOrder, false, now), { action: "CLOSE" })
assert.deepStrictEqual(
  timeoutCandidateDecision({ ...expiredFiniteOrder, paymentExpiresAt: "2026-08-03T12:30:00.000Z" }, false, now),
  { action: "RETRY", reason: "订单尚未到支付截止时间" }
)
assert.deepStrictEqual(
  timeoutCandidateDecision(expiredFiniteOrder, true, now),
  { action: "CANCEL", reason: "已存在已核验支付事实" }
)
assert.deepStrictEqual(
  timeoutCandidateDecision({ ...expiredFiniteOrder, paymentStatus: "已支付", paidAt: "2026-08-03 11:40:00" }, false, now),
  { action: "CANCEL", reason: "订单已存在支付证据" }
)
assert.deepStrictEqual(
  timeoutCandidateDecision({ ...expiredFiniteOrder, status: "已关闭", paymentStatus: "支付超时关闭" }, false, now),
  { action: "CANCEL", reason: "订单已进入终态" }
)
assert.deepStrictEqual(
  timeoutCandidateDecision({ ...expiredFiniteOrder, paymentStatus: "支付处理中" }, false, now),
  { action: "RETRY", reason: "订单支付状态仍在处理中" }
)

const server = fs.readFileSync(path.join(__dirname, "..", "cms", "server.js"), "utf8")
const timeoutModule = fs.readFileSync(path.join(__dirname, "..", "cms", "order-payment-timeout.js"), "utf8")
assert.match(server, /payment_expires_at/)
assert.match(server, /order_inventory_reservations/)
assert.match(server, /order_payment_timeout_jobs/)
assert.match(server, /enqueueOrderPaymentTimeout\(connection/)
assert.match(server, /startOrderPaymentTimeoutWorker\(\)/)
assert.match(timeoutModule, /sourceType: "payment_timeout"/)
assert.match(timeoutModule, /releaseRemaining: true/)
assert.match(timeoutModule, /payment_status='支付超时关闭'/)

console.log("order payment timeout tests passed")
