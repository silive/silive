"use strict"

const assert = require("assert")
const {
  PAYMENT_FINANCE_EVENT_TYPE,
  claimDuePaymentFinanceEvents,
  completePaymentFinanceEvent,
  enqueuePaymentFinanceEvent,
  failPaymentFinanceEvent,
  paymentFinanceBusinessKey
} = require("../cms/payment-finance-outbox")
const { isPickupServiceFeeEligible } = require("../cms/pickup-service-fee")

class FakePool {
  constructor() {
    this.rows = []
    this.nextId = 1
  }

  async getConnection() {
    return {
      beginTransaction: async () => {},
      commit: async () => {},
      rollback: async () => {},
      release: () => {},
      query: (sql, params) => this.query(sql, params)
    }
  }

  async query(sql, params = {}) {
    if (sql.includes("INSERT IGNORE INTO payment_finance_outbox")) {
      if (this.rows.some(row => row.business_key === params.businessKey)) return [{ affectedRows: 0 }]
      this.rows.push({
        id: this.nextId++,
        event_type: params.eventType,
        business_key: params.businessKey,
        aggregate_id: params.orderId,
        status: "PENDING",
        attempt_count: 0,
        locked_by: null,
        available: true
      })
      return [{ affectedRows: 1 }]
    }
    if (sql.includes("SET status='PROCESSING'")) {
      const row = this.rows.find(item => item.id === params.id)
      if (!row || row.event_type !== params.eventType || row.attempt_count >= Number(params.maxAttempts) ||
        !((['PENDING', 'RETRY'].includes(row.status) && row.available) || row.status === 'PROCESSING_STALE')) {
        return [{ affectedRows: 0 }]
      }
      row.status = "PROCESSING"
      row.attempt_count += 1
      row.locked_by = params.lockedBy
      return [{ affectedRows: 1 }]
    }
    if (sql.includes("SELECT id, aggregate_id, business_key")) {
      const row = this.rows.find(item => item.id === params.id && item.locked_by === params.lockedBy)
      return [row ? [{
        id: row.id,
        aggregate_id: row.aggregate_id,
        business_key: row.business_key,
        attempt_count: row.attempt_count,
        locked_by: row.locked_by
      }] : []]
    }
    if (sql.includes("SELECT id") && sql.includes("FROM payment_finance_outbox")) {
      return [this.rows.filter(row =>
        row.event_type === params.eventType &&
        row.attempt_count < Number(params.maxAttempts) &&
        ((["PENDING", "RETRY"].includes(row.status) && row.available) || row.status === "PROCESSING_STALE")
      ).map(row => ({ id: row.id }))]
    }
    if (sql.includes("SET status=:status, processed_at=NOW()")) {
      const row = this.rows.find(item => item.id === params.id && item.status === "PROCESSING" && item.locked_by === params.lockedBy)
      if (!row) return [{ affectedRows: 0 }]
      row.status = params.status
      row.locked_by = null
      return [{ affectedRows: 1 }]
    }
    if (sql.includes("SET status=:status,") && sql.includes("last_error=:lastError")) {
      const row = this.rows.find(item => item.id === params.id && item.status === "PROCESSING" && item.locked_by === params.lockedBy)
      if (!row) return [{ affectedRows: 0 }]
      row.status = params.status
      row.locked_by = null
      row.available = params.status === "RETRY"
      return [{ affectedRows: 1 }]
    }
    throw new Error(`Unexpected payment-finance SQL: ${sql.slice(0, 100)}`)
  }
}

async function main() {
  const pool = new FakePool()
  const connection = await pool.getConnection()
  assert.strictEqual(paymentFinanceBusinessKey("ORDER-1", "TX-1"), "payment_success:ORDER-1:TX-1")
  assert.strictEqual(await enqueuePaymentFinanceEvent(connection, { orderId: "ORDER-1", transactionId: "TX-1" }), true)
  assert.strictEqual(await enqueuePaymentFinanceEvent(connection, { orderId: "ORDER-1", transactionId: "TX-1" }), false)
  assert.strictEqual(pool.rows.length, 1)
  assert.strictEqual(pool.rows[0].event_type, PAYMENT_FINANCE_EVENT_TYPE)

  const [claimsA, claimsB] = await Promise.all([
    claimDuePaymentFinanceEvents({ pool, limit: 10 }),
    claimDuePaymentFinanceEvents({ pool, limit: 10 })
  ])
  assert.strictEqual(claimsA.length + claimsB.length, 1, "concurrent workers must only claim one event")
  const claimed = [...claimsA, ...claimsB][0]
  assert.strictEqual(claimed.aggregate_id, "ORDER-1")
  await completePaymentFinanceEvent(connection, claimed)
  assert.strictEqual(pool.rows[0].status, "COMPLETED")
  assert.strictEqual((await claimDuePaymentFinanceEvents({ pool, limit: 10 })).length, 0)

  assert.strictEqual(await enqueuePaymentFinanceEvent(connection, { orderId: "ORDER-2", transactionId: "TX-2" }), true)
  const [retryRecord] = await claimDuePaymentFinanceEvents({ pool, limit: 10 })
  assert.strictEqual(await failPaymentFinanceEvent({ pool, record: retryRecord, retryMinutes: 1, error: new Error("simulated failure") }), true)
  assert.strictEqual(pool.rows.find(row => row.aggregate_id === "ORDER-2").status, "RETRY")
  const [retried] = await claimDuePaymentFinanceEvents({ pool, limit: 10 })
  assert.strictEqual(retried.aggregate_id, "ORDER-2")

  const verifiedPickup = {
    paymentStatus: "已支付",
    deliveryType: "pickup",
    pickupStoreId: "STORE-A",
    pickupStatus: "picked_up",
    pickupVerifiedAt: "2026-08-03 10:00:00",
    status: "已完成"
  }
  assert.strictEqual(isPickupServiceFeeEligible(verifiedPickup), true)
  assert.strictEqual(isPickupServiceFeeEligible({ ...verifiedPickup, pickupVerifiedAt: "" }), false)
  assert.strictEqual(isPickupServiceFeeEligible({ ...verifiedPickup, paymentStatus: "待支付" }), false)
  assert.strictEqual(isPickupServiceFeeEligible({ ...verifiedPickup, status: "已退款" }), false)
  assert.strictEqual(isPickupServiceFeeEligible({ ...verifiedPickup, deliveryType: "delivery" }), false)
  assert.strictEqual(isPickupServiceFeeEligible({ ...verifiedPickup, pickupStoreId: "" }), false)

  console.log("payment finance outbox tests passed")
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
