"use strict"

const crypto = require("crypto")

const MAX_ITEM_QUANTITY = 99
const MAX_ORDER_QUANTITY = 200
const INVENTORY_MODES = new Set(["FINITE", "UNLIMITED", "MADE_TO_ORDER"])

function strictPositiveInteger(value, field = "商品数量", maximum = MAX_ITEM_QUANTITY) {
  if (typeof value === "string" && !/^[1-9]\d*$/.test(value.trim())) {
    throw Object.assign(new Error(`${field}必须是正整数`), { statusCode: 400 })
  }
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number <= 0 || number > maximum) {
    throw Object.assign(new Error(`${field}必须是1-${maximum}之间的正整数`), { statusCode: 400 })
  }
  return number
}

function yuanToCents(value, field = "金额") {
  const text = String(value == null ? "" : value).trim()
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) {
    throw Object.assign(new Error(`${field}格式不正确`), { statusCode: 400 })
  }
  const [yuan, decimals = ""] = text.split(".")
  const cents = Number(yuan) * 100 + Number(decimals.padEnd(2, "0"))
  if (!Number.isSafeInteger(cents) || cents < 0) {
    throw Object.assign(new Error(`${field}超出允许范围`), { statusCode: 400 })
  }
  return cents
}

function centsToYuan(cents) {
  if (!Number.isSafeInteger(cents)) throw new Error("金额必须使用整数分")
  return (cents / 100).toFixed(2)
}

function normalizeInventoryMode(product = {}) {
  const explicit = String(product.stockMode || product.stock_mode || "").trim().toUpperCase()
  if (INVENTORY_MODES.has(explicit)) return explicit
  const type = String(product.productType || product.product_type || "").toLowerCase()
  if (type !== "normal") return "MADE_TO_ORDER"
  const stock = Number(product.stock || 0)
  return Number.isSafeInteger(stock) && stock > 0 ? "FINITE" : "UNLIMITED"
}

function orderItemSnapshot(product, quantity, options = {}) {
  const unitPriceCents = yuanToCents(product.price || 0, "商品单价")
  const itemId = String(options.id || `OI${crypto.randomUUID().replace(/-/g, "")}`).slice(0, 60)
  return {
    id: itemId,
    productId: String(product.id || ""),
    skuId: String(options.skuId || options.sku_id || ""),
    productName: String(product.name || "未命名商品"),
    skuName: String(options.skuName || options.sku_name || ""),
    imageUrl: String(product.cartThumbUrl || product.thumbUrl || product.imageUrl || ""),
    unitPriceCents,
    quantity: strictPositiveInteger(quantity),
    productDiscountCents: 0,
    orderDiscountCents: 0,
    paidAmountCents: unitPriceCents * strictPositiveInteger(quantity),
    inventoryMode: normalizeInventoryMode(product),
    customizationJson: JSON.stringify(options.customization || {})
  }
}

function validateOrderItems(items = []) {
  if (!Array.isArray(items) || !items.length) {
    throw Object.assign(new Error("订单至少需要一个商品"), { statusCode: 400 })
  }
  const normalized = items.map(item => ({
    ...item,
    quantity: strictPositiveInteger(item.quantity)
  }))
  const totalQuantity = normalized.reduce((sum, item) => sum + item.quantity, 0)
  if (totalQuantity > MAX_ORDER_QUANTITY) {
    throw Object.assign(new Error(`整单商品数量不能超过${MAX_ORDER_QUANTITY}`), { statusCode: 400 })
  }
  return normalized
}

function canonicalRequestHash(value) {
  function normalize(input) {
    if (Array.isArray(input)) return input.map(normalize)
    if (!input || typeof input !== "object") return input
    return Object.keys(input).sort().reduce((output, key) => {
      if (["requestKey", "idempotencyKey", "userToken", "userSession", "token", "openid"].includes(key)) return output
      output[key] = normalize(input[key])
      return output
    }, {})
  }
  return crypto.createHash("sha256").update(JSON.stringify(normalize(value))).digest("hex")
}

function validateRefundItems(orderItems = [], previousRefundItems = [], requested = []) {
  if (!Array.isArray(requested) || !requested.length) {
    throw Object.assign(new Error("请选择退款商品和数量"), { statusCode: 400 })
  }
  const refundedByItem = new Map()
  for (const item of previousRefundItems) {
    if (String(item.status || "").toUpperCase() !== "SUCCESS") continue
    refundedByItem.set(
      String(item.orderItemId || item.order_item_id),
      (refundedByItem.get(String(item.orderItemId || item.order_item_id)) || 0) + Number(item.refundQuantity || item.refund_quantity || 0)
    )
  }
  const seen = new Set()
  return requested.map(request => {
    const orderItemId = String(request.orderItemId || request.order_item_id || "")
    if (!orderItemId || seen.has(orderItemId)) {
      throw Object.assign(new Error("退款商品明细重复或缺失"), { statusCode: 400 })
    }
    seen.add(orderItemId)
    const source = orderItems.find(item => String(item.id) === orderItemId)
    if (!source) throw Object.assign(new Error("退款商品不属于该订单"), { statusCode: 400 })
    const quantity = strictPositiveInteger(request.quantity || request.refundQuantity, "退款数量", source.quantity)
    const alreadyRefunded = refundedByItem.get(orderItemId) || 0
    if (alreadyRefunded + quantity > Number(source.quantity || 0)) {
      throw Object.assign(new Error(`退款数量超过${source.productName || "商品"}剩余可退数量`), { statusCode: 409 })
    }
    const maxCents = Math.floor(Number(source.paidAmountCents || source.paid_amount_cents || 0) * quantity / Number(source.quantity || 1))
    const refundAmountCents = request.refundAmountCents == null
      ? maxCents
      : strictPositiveInteger(request.refundAmountCents, "退款金额", maxCents)
    if (refundAmountCents > maxCents) {
      throw Object.assign(new Error("退款金额超过该商品剩余可退金额"), { statusCode: 409 })
    }
    return {
      orderItemId,
      skuId: source.skuId || source.sku_id || "",
      refundQuantity: quantity,
      productRefundCents: refundAmountCents,
      discountRefundCents: 0,
      shippingRefundCents: 0
    }
  })
}

module.exports = {
  MAX_ITEM_QUANTITY,
  MAX_ORDER_QUANTITY,
  canonicalRequestHash,
  centsToYuan,
  normalizeInventoryMode,
  orderItemSnapshot,
  strictPositiveInteger,
  validateOrderItems,
  validateRefundItems,
  yuanToCents
}
