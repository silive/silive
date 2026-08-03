"use strict"

const TERMINAL_OR_REFUND_STATES = new Set([
  "已取消", "cancelled", "canceled", "已关闭", "closed", "已作废", "void",
  "已退款", "refunded", "退款中", "退款处理中", "refund_processing", "refund_pending"
])

function normalized(value) {
  return String(value || "").trim().toLowerCase()
}

function isPaidOrder(order = {}) {
  return ["已支付", "paid", "success"].includes(normalized(order.paymentStatus || order.payment_status)) ||
    !!String(order.transactionId || order.transaction_id || "").trim() ||
    !!(order.paidAt || order.paid_at)
}

function isPickupServiceFeeEligible(order = {}) {
  const status = normalized(order.status)
  const refundStatus = normalized(order.refundStatus || order.refund_status)
  const afterSalesStatus = normalized(order.afterSalesStatus || order.after_sales_status)
  const pickupStatus = normalized(order.pickupStatus || order.pickup_status)
  const deliveryType = normalized(order.deliveryType || order.delivery_type)
  const verified = !!(order.pickupVerifiedAt || order.pickup_verified_at || order.forcePickupVerifiedAt || order.force_pickup_verified_at)

  if (!isPaidOrder(order)) return false
  if (deliveryType !== "pickup" || !String(order.pickupStoreId || order.pickup_store_id || "").trim()) return false
  if (TERMINAL_OR_REFUND_STATES.has(status) || TERMINAL_OR_REFUND_STATES.has(refundStatus) || TERMINAL_OR_REFUND_STATES.has(afterSalesStatus)) return false
  return verified && ["picked_up", "pickedup", "已自提"].includes(pickupStatus)
}

module.exports = {
  isPickupServiceFeeEligible,
  isPaidOrder
}
