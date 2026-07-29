"use strict"

const assert = require("assert")
const {
  PICKUP_ALPHABET,
  claimPickupCode,
  generatePickupCodeCandidate
} = require("../cms/pickup-security")
const {
  canReleaseOrderInventory,
  releaseOrderInventory
} = require("../cms/inventory-ledger")

function duplicateError() {
  const error = new Error("duplicate")
  error.code = "ER_DUP_ENTRY"
  return error
}

async function main() {
  const generated = new Set()
  for (let index = 0; index < 1000; index += 1) {
    const code = generatePickupCodeCandidate()
    assert.match(code, /^[A-HJ-NP-Z2-9]{6}$/)
    assert([...code].every(character => PICKUP_ALPHABET.includes(character)))
    generated.add(code)
  }
  assert(generated.size > 990, "cryptographic pickup candidates should have negligible collisions")

  let claimAttempts = 0
  const pickupConnection = {
    async query(sql, params) {
      assert.match(sql, /INSERT INTO pickup_code_claims/)
      claimAttempts += 1
      if (claimAttempts === 1) throw duplicateError()
      return [{ affectedRows: 1 }]
    }
  }
  const pickupOrder = { id: "ORDER-1", deliveryType: "pickup", pickupCode: "ABC234" }
  const claimedCode = await claimPickupCode(pickupConnection, pickupOrder)
  assert.strictEqual(claimAttempts, 2)
  assert.notStrictEqual(claimedCode, "ABC234")
  assert.strictEqual(pickupOrder.pickupCode, claimedCode)

  assert.strictEqual(canReleaseOrderInventory({ status: "已取消" }), true)
  assert.strictEqual(canReleaseOrderInventory({ status: "已退款", shippedAt: "2026-01-01" }), false)
  assert.strictEqual(canReleaseOrderInventory({ status: "已退款", pickupStatus: "picked_up" }), false)

  const releasedClaims = new Set()
  const stock = new Map([["PRODUCT-1", 2]])
  const inventoryConnection = {
    async query(sql, params) {
      if (sql.includes("FROM order_items")) {
        return [[
          { id: "ITEM-1", product_id: "PRODUCT-1", quantity: 3, inventory_mode: "FINITE" },
          { id: "ITEM-2", product_id: "PRODUCT-2", quantity: 8, inventory_mode: "UNLIMITED" }
        ]]
      }
      if (sql.includes("INSERT IGNORE INTO order_inventory_releases")) {
        if (releasedClaims.has(params.orderItemId)) return [{ affectedRows: 0 }]
        releasedClaims.add(params.orderItemId)
        return [{ affectedRows: 1 }]
      }
      if (sql.includes("stock=stock+:quantity")) {
        stock.set(params.productId, (stock.get(params.productId) || 0) + params.quantity)
        return [{ affectedRows: 1 }]
      }
      throw new Error(`unexpected SQL: ${sql}`)
    }
  }
  const firstRelease = await releaseOrderInventory(inventoryConnection, "ORDER-1", "cancel")
  const secondRelease = await releaseOrderInventory(inventoryConnection, "ORDER-1", "cancel")
  assert.deepStrictEqual(firstRelease, { releasedItems: 1, releasedQuantity: 3 })
  assert.deepStrictEqual(secondRelease, { releasedItems: 0, releasedQuantity: 0 })
  assert.strictEqual(stock.get("PRODUCT-1"), 5)

  console.log("security ledger tests passed")
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
