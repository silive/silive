"use strict"

const REFUNDED_VALUES = new Set(["已退款", "退款成功", "success", "refunded"])
const REFUNDING_VALUES = new Set(["退款中", "退款处理中", "processing", "refund_pending"])
const REFUND_FAILED_VALUES = new Set(["退款失败", "abnormal", "closed", "refund_failed"])
const PICKUP_READY_VALUES = new Set(["arrived_store", "ready_for_pickup", "arrived"])
const PICKUP_DONE_VALUES = new Set(["picked_up", "pickedup", "已自提"])

function normalized(value) {
  return String(value == null ? "" : value).trim().toLowerCase()
}

function isRefunded(order = {}) {
  return [order.status, order.paymentStatus, order.refundStatus, order.afterSalesStatus]
    .some(value => REFUNDED_VALUES.has(normalized(value)))
}

function isRefunding(order = {}) {
  return [order.status, order.paymentStatus, order.refundStatus, order.afterSalesStatus]
    .some(value => REFUNDING_VALUES.has(normalized(value)))
}

function isRefundFailed(order = {}) {
  return [order.refundStatus, order.afterSalesStatus]
    .some(value => REFUND_FAILED_VALUES.has(normalized(value)))
}

function isPickup(order = {}) {
  return normalized(order.deliveryType || order.delivery_type) === "pickup" ||
    !!(order.pickupStoreId || order.pickup_store_id)
}

function isPickupVerified(order = {}) {
  return PICKUP_DONE_VALUES.has(normalized(order.pickupStatus || order.pickup_status)) &&
    !!(order.pickupVerifiedAt || order.pickup_verified_at || order.forcePickupVerifiedAt || order.force_pickup_verified_at)
}

function fulfillmentStatus(order = {}) {
  if (isRefunded(order)) return "REFUNDED"
  if (isRefunding(order)) return "REFUND_PROCESSING"
  if (isRefundFailed(order)) return "REFUND_FAILED"
  if (normalized(order.status) === "已取消" || normalized(order.status) === "cancelled") return "CANCELLED"
  if (isPickup(order)) {
    if (isPickupVerified(order)) return "PICKED_UP"
    if (PICKUP_READY_VALUES.has(normalized(order.pickupStatus || order.pickup_status))) return "READY_FOR_PICKUP"
    if (normalized(order.pickupStatus || order.pickup_status) === "preparing" && normalized(order.status) === "已发货") {
      return "DELIVERING_TO_STORE"
    }
    return "PREPARING"
  }
  if (["已完成", "completed"].includes(normalized(order.status))) return "COMPLETED"
  if (["已发货", "shipped"].includes(normalized(order.status))) return "SHIPPED"
  return "PREPARING"
}

function serviceFeeStatus(order = {}, record = null) {
  if (!isPickup(order) || Number(order.pickupServiceFee || order.pickup_service_fee || 0) <= 0) return "NONE"
  const status = normalized(record && (record.effectiveStatus || record.status))
  if (status === "settled") return "SETTLED"
  if (status === "chargeback" || Number(record && record.amount || 0) < 0) return "CHARGEBACK"
  if (status === "cancelled") return "CANCELLED"
  if (isRefunded(order) && !isPickupVerified(order)) return "CANCELLED"
  if (isPickupVerified(order)) return status === "settled" ? "SETTLED" : "PAYABLE"
  return "ESTIMATED"
}

function displayStatusText(status, pickup) {
  const map = {
    REFUNDED: "已退款",
    REFUND_PROCESSING: "退款处理中",
    REFUND_FAILED: "退款失败",
    PICKED_UP: "已自提",
    COMPLETED: "已完成",
    READY_FOR_PICKUP: "待自提",
    DELIVERING_TO_STORE: "配送到门店中",
    SHIPPED: "待收货",
    PREPARING: "制作中",
    CANCELLED: "已取消"
  }
  if (status === "COMPLETED" && pickup) return "已自提"
  return map[status] || "处理中"
}

function availableActions(order = {}) {
  const status = fulfillmentStatus(order)
  if (["REFUNDED", "REFUND_PROCESSING", "CANCELLED"].includes(status)) return []
  if (isPickup(order)) {
    if (status === "PREPARING") return ["ARRIVE_STORE"]
    if (status === "READY_FOR_PICKUP") return ["VERIFY_PICKUP"]
    return []
  }
  if (status === "PREPARING") return ["SHIP"]
  if (status === "SHIPPED") return ["CONFIRM_RECEIPT"]
  return []
}

function lifecycleView(order = {}, pickupFeeRecord = null) {
  const status = fulfillmentStatus(order)
  const pickup = isPickup(order)
  return {
    fulfillmentType: pickup ? "PICKUP" : "DELIVERY",
    fulfillmentStatus: status,
    displayStatus: status,
    displayStatusText: displayStatusText(status, pickup),
    availableActions: availableActions(order),
    refundStatus: isRefunded(order) ? "REFUNDED" : isRefunding(order) ? "REFUND_PROCESSING" : isRefundFailed(order) ? "REFUND_FAILED" : "NONE",
    pickupStatus: order.pickupStatus || order.pickup_status || (pickup ? "preparing" : "none"),
    serviceFeeStatus: serviceFeeStatus(order, pickupFeeRecord)
  }
}

function assertAdminTransition(previous = {}, next = {}) {
  if (!previous.id || previous.id !== next.id) return
  if (isRefunded(previous)) {
    const immutable = ["status", "pickupStatus", "paymentStatus"]
    if (immutable.some(key => String(previous[key] || "") !== String(next[key] || ""))) {
      throw new Error("已退款订单不能继续修改配送、自提或完成状态")
    }
  }
  if (isPickup(previous) && !isPickupVerified(previous)) {
    if (["已完成", "completed"].includes(normalized(next.status)) ||
        PICKUP_DONE_VALUES.has(normalized(next.pickupStatus || next.pickup_status))) {
      throw new Error("该订单尚未完成自提核销，不能直接设为已完成。")
    }
  }
}

module.exports = {
  assertAdminTransition,
  availableActions,
  fulfillmentStatus,
  isPickup,
  isPickupVerified,
  isRefunded,
  isRefunding,
  lifecycleView,
  serviceFeeStatus
}
