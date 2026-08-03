"use strict"

const assert = require("assert")
const { compensateMissingPaymentFinanceEvents } = require("../cms/payment-finance-outbox")

class BackfillPool {
  constructor() {
    this.orders = [{ id: "ORDER-A", transaction_id: "TX-A" }, { id: "ORDER-B", transaction_id: "TX-B" }]
    this.events = []
    this.writes = 0
  }

  async query(sql, params = {}) {
    if (sql.includes("SELECT o.id, o.transaction_id")) return [this.orders.filter(order => !params.cursor || order.id > params.cursor)]
    if (sql.includes("INSERT IGNORE INTO payment_finance_outbox")) {
      this.writes += 1
      if (this.events.includes(params.businessKey)) return [{ affectedRows: 0 }]
      this.events.push(params.businessKey)
      return [{ affectedRows: 1 }]
    }
    throw new Error(`Unexpected SQL: ${sql.slice(0, 80)}`)
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
}

async function main() {
  const pool = new BackfillPool()
  const dryRun = await compensateMissingPaymentFinanceEvents({ pool, limit: 10 })
  assert.strictEqual(dryRun.dryRun, true)
  assert.strictEqual(dryRun.scanned, 2)
  assert.strictEqual(pool.writes, 0)

  const applied = await compensateMissingPaymentFinanceEvents({ pool, apply: true, limit: 10, batchSize: 1 })
  assert.strictEqual(applied.dryRun, false)
  assert.strictEqual(applied.queued, 2)
  assert.strictEqual(pool.writes, 2)

  const repeated = await compensateMissingPaymentFinanceEvents({ pool, apply: true, limit: 10 })
  assert.strictEqual(repeated.queued, 0)
  console.log("payment finance backfill tests passed")
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
