"use strict"

const crypto = require("crypto")

const PICKUP_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

function normalizePickupCode(value) {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6)
}

function generatePickupCodeCandidate() {
  let code = ""
  for (let index = 0; index < 6; index += 1) {
    code += PICKUP_ALPHABET[crypto.randomInt(PICKUP_ALPHABET.length)]
  }
  return code
}

function isPickupOrder(order = {}) {
  return order.deliveryType === "pickup" ||
    order.delivery_type === "pickup" ||
    !!order.pickupStoreId ||
    !!order.pickup_store_id
}

async function claimPickupCode(connection, order, maxAttempts = 20) {
  if (!connection || !isPickupOrder(order)) return ""
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const code = attempt === 0
      ? normalizePickupCode(order.pickupCode || order.pickup_code)
      : generatePickupCodeCandidate()
    if (!code) continue
    try {
      await connection.query(
        `INSERT INTO pickup_code_claims (code, order_id, created_at)
         VALUES (:code, :orderId, NOW())`,
        { code, orderId: order.id }
      )
      order.pickupCode = code
      return code
    } catch (error) {
      if (error?.code !== "ER_DUP_ENTRY") throw error
    }
  }
  throw new Error("暂时无法生成唯一取货码，请稍后重试")
}

module.exports = {
  PICKUP_ALPHABET,
  claimPickupCode,
  generatePickupCodeCandidate,
  normalizePickupCode
}
