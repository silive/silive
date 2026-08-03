"use strict"

const crypto = require("crypto")

function inventoryError(message, statusCode = 409) {
  return Object.assign(new Error(message), { statusCode })
}

function isPickupVerified(order = {}) {
  return String(order.pickupStatus || order.pickup_status || "") === "picked_up" ||
    !!(order.pickupVerifiedAt || order.pickup_verified_at || order.forcePickupVerifiedAt || order.force_pickup_verified_at)
}

function isTerminalInventoryReleaseStatus(order = {}) {
  const values = [
    order.status,
    order.paymentStatus || order.payment_status,
    order.refundStatus || order.refund_status,
    order.afterSalesStatus || order.after_sales_status
  ].map(value => String(value || "").trim().toLowerCase())
  return values.some(value => [
    "已取消", "已关闭", "已退款", "取消", "关闭", "作废",
    "cancelled", "canceled", "closed", "void", "refunded"
  ].includes(value))
}

function isFulfilledOrShipped(order = {}) {
  const status = String(order.status || "").trim().toLowerCase()
  if (["制作中", "已发货", "已完成", "shipped", "completed", "fulfilled"].includes(status)) return true
  return !!(
    order.shippedAt || order.shipped_at || order.arrivedStoreAt || order.arrived_store_at ||
    order.completedAt || order.completed_at || order.pickedUpAt || order.picked_up_at
  )
}

function canReleaseOrderInventory(order = {}) {
  return isTerminalInventoryReleaseStatus(order) && !isPickupVerified(order) && !isFulfilledOrShipped(order)
}

// A refund returns stock only before any shipment, pickup verification, or fulfillment.
function canRestockRefundedInventory(order = {}) {
  return !isPickupVerified(order) && !isFulfilledOrShipped(order)
}

function positiveInteger(value, field) {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number <= 0) throw inventoryError(`${field}必须是正整数`, 400)
  return number
}

function text(value, fallback, maximum) {
  return String(value == null || value === "" ? fallback : value).slice(0, maximum)
}

function normalizeReleaseOptions(orderId, reasonOrOptions) {
  const legacy = typeof reasonOrOptions === "string" || reasonOrOptions == null
  const options = legacy ? { reason: reasonOrOptions } : reasonOrOptions
  const sourceType = text(options.sourceType, "legacy_release", 40)
  const sourceId = text(options.sourceId, orderId, 80)
  return {
    reason: text(options.reason, "订单关闭", 120),
    sourceType,
    sourceId,
    releaseRemaining: options.releaseRemaining !== false
  }
}

function releaseBusinessKey(sourceType, sourceId, orderItemId) {
  return `${sourceType}:${sourceId}:${orderItemId}`.slice(0, 180)
}

async function releaseOrderItemInventory(connection, options = {}) {
  if (!connection || !options.orderItemId) throw inventoryError("库存释放参数不完整", 400)
  const orderItemId = String(options.orderItemId)
  const [itemRows] = await connection.query(
    `SELECT id, order_id, product_id, quantity, inventory_mode
     FROM order_items WHERE id=:orderItemId LIMIT 1 FOR UPDATE`,
    { orderItemId }
  )
  const item = itemRows[0]
  if (!item) throw inventoryError("订单商品不存在", 404)
  if (String(item.inventory_mode || "").toUpperCase() !== "FINITE") {
    return { releasedQuantity: 0, skipped: "non_finite" }
  }

  const orderedQuantity = positiveInteger(item.quantity, "订单商品数量")
  const sourceType = text(options.sourceType, "legacy_release", 40)
  const sourceId = text(options.sourceId, item.order_id, 80)
  const businessKey = text(options.businessKey, releaseBusinessKey(sourceType, sourceId, item.id), 180)
  const reason = text(options.reason, "订单关闭", 120)

  const [existingEvents] = await connection.query(
    `SELECT id, quantity FROM order_inventory_release_events
     WHERE business_key=:businessKey LIMIT 1 FOR UPDATE`,
    { businessKey }
  )
  if (existingEvents[0]) {
    return {
      releasedQuantity: 0,
      idempotent: true,
      eventId: existingEvents[0].id,
      cumulativeReleasedQuantity: null
    }
  }

  // The row is both the cumulative counter and the serialization point for legacy releases.
  await connection.query(
    `INSERT INTO order_inventory_releases
      (order_item_id, order_id, product_id, quantity, reason, created_at, updated_at)
     VALUES (:orderItemId, :orderId, :productId, 0, :reason, NOW(), NOW())
     ON DUPLICATE KEY UPDATE updated_at=updated_at`,
    { orderItemId: item.id, orderId: item.order_id, productId: item.product_id, reason }
  )
  const [releaseRows] = await connection.query(
    `SELECT quantity FROM order_inventory_releases
     WHERE order_item_id=:orderItemId LIMIT 1 FOR UPDATE`,
    { orderItemId: item.id }
  )
  const cumulativeReleasedQuantity = Number(releaseRows[0]?.quantity || 0)
  if (!Number.isSafeInteger(cumulativeReleasedQuantity) || cumulativeReleasedQuantity < 0 || cumulativeReleasedQuantity > orderedQuantity) {
    throw inventoryError("库存释放累计数量异常", 500)
  }
  const remainingQuantity = orderedQuantity - cumulativeReleasedQuantity
  const releaseRemaining = options.releaseRemaining === true
  const requestedQuantity = releaseRemaining
    ? remainingQuantity
    : positiveInteger(options.requestedQuantity, "本次库存释放数量")

  if (requestedQuantity > remainingQuantity) {
    throw inventoryError("库存释放数量超过订单商品剩余数量")
  }
  if (requestedQuantity === 0) {
    return { releasedQuantity: 0, remainingQuantity: 0, cumulativeReleasedQuantity }
  }

  const eventId = text(options.eventId, `IRE${crypto.createHash("sha256").update(businessKey).digest("hex").slice(0, 52)}`, 80)
  const [event] = await connection.query(
    `INSERT INTO order_inventory_release_events
      (id, business_key, order_item_id, order_id, product_id, quantity, reason, source_type, source_id, created_at)
     VALUES (:eventId, :businessKey, :orderItemId, :orderId, :productId, :quantity, :reason, :sourceType, :sourceId, NOW())`,
    {
      eventId,
      businessKey,
      orderItemId: item.id,
      orderId: item.order_id,
      productId: item.product_id,
      quantity: requestedQuantity,
      reason,
      sourceType,
      sourceId
    }
  )
  if (Number(event.affectedRows || 0) !== 1) throw inventoryError("库存释放事件写入失败", 500)

  const [accumulator] = await connection.query(
    `UPDATE order_inventory_releases
     SET quantity=quantity+:quantity, reason=:reason, updated_at=NOW()
     WHERE order_item_id=:orderItemId AND quantity+:quantity<=:orderedQuantity`,
    { orderItemId: item.id, quantity: requestedQuantity, orderedQuantity, reason }
  )
  if (Number(accumulator.affectedRows || 0) !== 1) {
    throw inventoryError("库存释放累计数量超过订单商品数量")
  }

  const [stock] = await connection.query(
    `UPDATE products
     SET stock=stock+:quantity, inventory_version=inventory_version+1
     WHERE id=:productId AND stock_mode='FINITE'`,
    { productId: item.product_id, quantity: requestedQuantity }
  )
  if (Number(stock.affectedRows || 0) !== 1) {
    throw inventoryError("有限库存商品不存在或库存模式已变化", 409)
  }
  return {
    releasedQuantity: requestedQuantity,
    remainingQuantity: remainingQuantity - requestedQuantity,
    cumulativeReleasedQuantity: cumulativeReleasedQuantity + requestedQuantity,
    eventId
  }
}

async function releaseOrderInventory(connection, orderId, reasonOrOptions) {
  if (!connection || !orderId) return { releasedItems: 0, releasedQuantity: 0 }
  const options = normalizeReleaseOptions(orderId, reasonOrOptions)
  const [items] = await connection.query(
    `SELECT id, product_id, quantity, inventory_mode
     FROM order_items WHERE order_id=:orderId FOR UPDATE`,
    { orderId }
  )
  let releasedItems = 0
  let releasedQuantity = 0
  for (const item of items) {
    if (String(item.inventory_mode || "").toUpperCase() !== "FINITE") continue
    const release = await releaseOrderItemInventory(connection, {
      orderItemId: item.id,
      releaseRemaining: options.releaseRemaining,
      businessKey: releaseBusinessKey(options.sourceType, options.sourceId, item.id),
      reason: options.reason,
      sourceType: options.sourceType,
      sourceId: options.sourceId
    })
    if (release.releasedQuantity > 0) releasedItems += 1
    releasedQuantity += Number(release.releasedQuantity || 0)
  }
  return { releasedItems, releasedQuantity }
}

module.exports = {
  canReleaseOrderInventory,
  canRestockRefundedInventory,
  isTerminalInventoryReleaseStatus,
  releaseBusinessKey,
  releaseOrderInventory,
  releaseOrderItemInventory
}
