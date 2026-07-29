"use strict"

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

function canReleaseOrderInventory(order = {}) {
  if (!isTerminalInventoryReleaseStatus(order)) return false
  if (isPickupVerified(order)) return false
  const status = String(order.status || "").trim().toLowerCase()
  if (["制作中", "已发货", "已完成", "shipped", "completed", "fulfilled"].includes(status)) return false
  return !(order.shippedAt || order.shipped_at || order.completedAt || order.completed_at)
}

async function releaseOrderInventory(connection, orderId, reason) {
  if (!connection || !orderId) return { releasedItems: 0, releasedQuantity: 0 }
  const [items] = await connection.query(
    `SELECT id, product_id, quantity, inventory_mode
     FROM order_items
     WHERE order_id=:orderId
     FOR UPDATE`,
    { orderId }
  )
  let releasedItems = 0
  let releasedQuantity = 0
  for (const item of items) {
    if (String(item.inventory_mode || "").toUpperCase() !== "FINITE") continue
    const quantity = Number(item.quantity || 0)
    if (!Number.isSafeInteger(quantity) || quantity <= 0) continue
    const [claim] = await connection.query(
      `INSERT IGNORE INTO order_inventory_releases
        (order_item_id, order_id, product_id, quantity, reason, created_at)
       VALUES
        (:orderItemId, :orderId, :productId, :quantity, :reason, NOW())`,
      {
        orderItemId: item.id,
        orderId,
        productId: item.product_id,
        quantity,
        reason: String(reason || "订单关闭").slice(0, 120)
      }
    )
    if (Number(claim.affectedRows || 0) !== 1) continue
    await connection.query(
      `UPDATE products
       SET stock=stock+:quantity,
           inventory_version=inventory_version+1
       WHERE id=:productId AND stock_mode='FINITE'`,
      { productId: item.product_id, quantity }
    )
    releasedItems += 1
    releasedQuantity += quantity
  }
  return { releasedItems, releasedQuantity }
}

module.exports = {
  canReleaseOrderInventory,
  isTerminalInventoryReleaseStatus,
  releaseOrderInventory
}
