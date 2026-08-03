"use strict"

const assert = require("assert")
const {
  PICKUP_ALPHABET,
  claimPickupCode,
  generatePickupCodeCandidate
} = require("../cms/pickup-security")
const {
  canReleaseOrderInventory,
  canRestockRefundedInventory,
  releaseOrderInventory,
  releaseOrderItemInventory
} = require("../cms/inventory-ledger")

function duplicateError() {
  const error = new Error("duplicate")
  error.code = "ER_DUP_ENTRY"
  return error
}

function createInventoryConnection() {
  const state = {
    items: new Map([
      ["ITEM-1", { id: "ITEM-1", order_id: "ORDER-1", product_id: "PRODUCT-1", quantity: 3, inventory_mode: "FINITE" }],
      ["ITEM-2", { id: "ITEM-2", order_id: "ORDER-1", product_id: "PRODUCT-2", quantity: 8, inventory_mode: "UNLIMITED" }],
      ["ITEM-PARTIAL", { id: "ITEM-PARTIAL", order_id: "ORDER-PARTIAL", product_id: "PRODUCT-PARTIAL", quantity: 5, inventory_mode: "FINITE" }],
      ["ITEM-TERMINAL", { id: "ITEM-TERMINAL", order_id: "ORDER-TERMINAL", product_id: "PRODUCT-TERMINAL", quantity: 5, inventory_mode: "FINITE" }],
      ["ITEM-MADE", { id: "ITEM-MADE", order_id: "ORDER-MADE", product_id: "PRODUCT-MADE", quantity: 2, inventory_mode: "MADE_TO_ORDER" }]
    ]),
    releases: new Map(),
    events: new Map(),
    stock: new Map([["PRODUCT-1", 2], ["PRODUCT-PARTIAL", 0], ["PRODUCT-TERMINAL", 0], ["PRODUCT-2", 9], ["PRODUCT-MADE", 9]])
  }
  return {
    state,
    async query(sql, params = {}) {
      const compact = String(sql).replace(/\s+/g, " ")
      if (compact.includes("FROM order_items WHERE order_id")) {
        return [[...state.items.values()].filter(item => item.order_id === params.orderId)]
      }
      if (compact.includes("FROM order_items WHERE id")) {
        const item = state.items.get(params.orderItemId)
        return [item ? [item] : []]
      }
      if (compact.includes("FROM order_inventory_release_events")) {
        const event = state.events.get(params.businessKey)
        return [event ? [event] : []]
      }
      if (compact.includes("INSERT INTO order_inventory_releases")) {
        if (!state.releases.has(params.orderItemId)) {
          state.releases.set(params.orderItemId, {
            order_item_id: params.orderItemId,
            order_id: params.orderId,
            product_id: params.productId,
            quantity: 0
          })
        }
        return [{ affectedRows: 1 }]
      }
      if (compact.includes("FROM order_inventory_releases")) {
        const release = state.releases.get(params.orderItemId)
        return [release ? [release] : []]
      }
      if (compact.includes("INSERT INTO order_inventory_release_events")) {
        if (state.events.has(params.businessKey)) throw duplicateError()
        state.events.set(params.businessKey, { id: params.eventId, quantity: params.quantity })
        return [{ affectedRows: 1 }]
      }
      if (compact.includes("UPDATE order_inventory_releases")) {
        const release = state.releases.get(params.orderItemId)
        if (!release || release.quantity + params.quantity > params.orderedQuantity) return [{ affectedRows: 0 }]
        release.quantity += params.quantity
        return [{ affectedRows: 1 }]
      }
      if (compact.includes("UPDATE products")) {
        state.stock.set(params.productId, (state.stock.get(params.productId) || 0) + params.quantity)
        return [{ affectedRows: 1 }]
      }
      throw new Error(`unexpected SQL: ${compact}`)
    }
  }
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
    async query(sql) {
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
  assert.strictEqual(canRestockRefundedInventory({ status: "待发货" }), true)
  assert.strictEqual(canRestockRefundedInventory({ status: "已发货" }), false)
  assert.strictEqual(canRestockRefundedInventory({ pickupStatus: "picked_up" }), false)
  assert.strictEqual(canRestockRefundedInventory({ completedAt: "2026-08-03" }), false)

  const inventoryConnection = createInventoryConnection()
  const firstRelease = await releaseOrderInventory(inventoryConnection, "ORDER-1", {
    reason: "用户取消",
    sourceType: "user_cancel",
    sourceId: "ORDER-1",
    releaseRemaining: true
  })
  const secondRelease = await releaseOrderInventory(inventoryConnection, "ORDER-1", {
    reason: "用户取消",
    sourceType: "user_cancel",
    sourceId: "ORDER-1",
    releaseRemaining: true
  })
  assert.deepStrictEqual(firstRelease, { releasedItems: 1, releasedQuantity: 3 })
  assert.deepStrictEqual(secondRelease, { releasedItems: 0, releasedQuantity: 0 })
  assert.strictEqual(inventoryConnection.state.stock.get("PRODUCT-1"), 5)
  assert.strictEqual(inventoryConnection.state.events.size, 1)

  const partialOne = await releaseOrderItemInventory(inventoryConnection, {
    orderItemId: "ITEM-PARTIAL",
    requestedQuantity: 2,
    businessKey: "refund:REFUND-1:REFUND-ITEM-1:ITEM-PARTIAL",
    reason: "部分退款",
    sourceType: "partial_refund",
    sourceId: "REFUND-1"
  })
  const partialTwo = await releaseOrderItemInventory(inventoryConnection, {
    orderItemId: "ITEM-PARTIAL",
    requestedQuantity: 1,
    businessKey: "refund:REFUND-2:REFUND-ITEM-2:ITEM-PARTIAL",
    reason: "部分退款",
    sourceType: "partial_refund",
    sourceId: "REFUND-2"
  })
  assert.strictEqual(partialOne.releasedQuantity, 2)
  assert.strictEqual(partialTwo.releasedQuantity, 1)
  assert.strictEqual(inventoryConnection.state.releases.get("ITEM-PARTIAL").quantity, 3)
  assert.strictEqual(inventoryConnection.state.stock.get("PRODUCT-PARTIAL"), 3)
  await assert.rejects(
    () => releaseOrderItemInventory(inventoryConnection, {
      orderItemId: "ITEM-PARTIAL",
      requestedQuantity: 3,
      businessKey: "refund:REFUND-3:REFUND-ITEM-3:ITEM-PARTIAL",
      reason: "超量退款",
      sourceType: "partial_refund",
      sourceId: "REFUND-3"
    }),
    error => error.statusCode === 409
  )
  const finalRelease = await releaseOrderInventory(inventoryConnection, "ORDER-PARTIAL", {
    reason: "订单全额退款",
    sourceType: "full_refund",
    sourceId: "REFUND-3",
    releaseRemaining: true
  })
  const duplicateFinalRelease = await releaseOrderInventory(inventoryConnection, "ORDER-PARTIAL", {
    reason: "订单全额退款",
    sourceType: "full_refund",
    sourceId: "REFUND-3",
    releaseRemaining: true
  })
  assert.deepStrictEqual(finalRelease, { releasedItems: 1, releasedQuantity: 2 })
  assert.deepStrictEqual(duplicateFinalRelease, { releasedItems: 0, releasedQuantity: 0 })
  assert.strictEqual(inventoryConnection.state.releases.get("ITEM-PARTIAL").quantity, 5)
  assert.strictEqual(inventoryConnection.state.stock.get("PRODUCT-PARTIAL"), 5)
  assert.strictEqual(inventoryConnection.state.events.size, 4)

  await releaseOrderItemInventory(inventoryConnection, {
    orderItemId: "ITEM-TERMINAL",
    requestedQuantity: 2,
    businessKey: "refund:REFUND-TERMINAL:ITEM:ITEM-TERMINAL",
    reason: "部分退款",
    sourceType: "partial_refund",
    sourceId: "REFUND-TERMINAL"
  })
  const adminClose = await releaseOrderInventory(inventoryConnection, "ORDER-TERMINAL", {
    reason: "管理员关闭",
    sourceType: "admin_close",
    sourceId: "ORDER-TERMINAL",
    releaseRemaining: true
  })
  const timeoutAfterClose = await releaseOrderInventory(inventoryConnection, "ORDER-TERMINAL", {
    reason: "支付超时关闭",
    sourceType: "payment_timeout",
    sourceId: "ORDER-TERMINAL",
    releaseRemaining: true
  })
  assert.deepStrictEqual(adminClose, { releasedItems: 1, releasedQuantity: 3 })
  assert.deepStrictEqual(timeoutAfterClose, { releasedItems: 0, releasedQuantity: 0 })
  assert.strictEqual(inventoryConnection.state.releases.get("ITEM-TERMINAL").quantity, 5)
  assert.strictEqual(inventoryConnection.state.stock.get("PRODUCT-TERMINAL"), 5)

  const noRelease = await releaseOrderInventory(inventoryConnection, "ORDER-MADE", {
    reason: "取消按单生产商品",
    sourceType: "user_cancel",
    sourceId: "ORDER-MADE",
    releaseRemaining: true
  })
  assert.deepStrictEqual(noRelease, { releasedItems: 0, releasedQuantity: 0 })
  assert.strictEqual(inventoryConnection.state.stock.get("PRODUCT-MADE"), 9)

  console.log("security ledger tests passed")
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
