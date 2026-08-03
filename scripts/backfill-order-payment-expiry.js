"use strict"

const crypto = require("crypto")
const fs = require("fs")
const path = require("path")
const mysql = require("mysql2/promise")
const {
  enqueueOrderPaymentTimeout,
  paymentTimeoutMinutes
} = require("../cms/order-payment-timeout")

function loadEnv(file) {
  if (!fs.existsSync(file)) return
  for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith("#")) continue
    const index = line.indexOf("=")
    if (index < 1) continue
    const key = line.slice(0, index).trim()
    const value = line.slice(index + 1).trim().replace(/^(['"])(.*)\1$/, "$2")
    if (process.env[key] == null) process.env[key] = value
  }
}

function argument(name, fallback = "") {
  const index = process.argv.indexOf(name)
  return index >= 0 ? String(process.argv[index + 1] || "") : fallback
}

function positiveInteger(value, fallback, maximum) {
  const number = Math.floor(Number(value))
  if (!Number.isFinite(number) || number <= 0) return fallback
  return Math.min(number, maximum)
}

function maskedOrder(value) {
  const text = String(value || "")
  return text.length <= 6 ? "***" : `***${text.slice(-6)}`
}

async function main() {
  loadEnv(path.join(__dirname, "..", ".env"))
  const apply = process.argv.includes("--apply")
  const limit = positiveInteger(argument("--limit", "100"), 100, 500)
  const startAt = argument("--start-at", "")
  const endAt = argument("--end-at", "")
  const timeoutMinutes = paymentTimeoutMinutes()
  if (apply && String(process.env.NODE_ENV || "").toLowerCase() === "production") {
    throw new Error("安全拒绝：生产环境仅允许 dry-run；不得执行 --apply")
  }
  if (apply && process.env.ORDER_PAYMENT_EXPIRY_BACKFILL_CONFIRM !== "APPLY") {
    throw new Error("安全拒绝：--apply 还需要 ORDER_PAYMENT_EXPIRY_BACKFILL_CONFIRM=APPLY")
  }
  const pool = mysql.createPool({
    host: process.env.MYSQL_HOST || "127.0.0.1",
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER || "",
    password: process.env.MYSQL_PASSWORD || "",
    database: process.env.MYSQL_DATABASE || "very_simple_custom",
    namedPlaceholders: true,
    connectionLimit: 2
  })
  try {
    const [rows] = await pool.query(
      `SELECT DISTINCT o.id, o.created_at,
              EXISTS(
                SELECT 1 FROM order_payment_facts f
                WHERE f.order_id=o.id AND f.payment_state='SUCCESS' AND f.amount_verified=1
              ) AS has_verified_payment_fact
       FROM orders o
       INNER JOIN order_items oi
         ON oi.order_id=o.id AND oi.inventory_mode='FINITE'
       LEFT JOIN order_inventory_releases r ON r.order_item_id=oi.id
       LEFT JOIN order_payment_timeout_jobs j ON j.order_id=o.id
       WHERE o.payment_expires_at IS NULL
         AND o.status IN ('待支付','未支付','unpaid','pending_payment')
         AND o.payment_status IN ('待支付','未支付','unpaid','pending_payment')
         AND o.transaction_id IS NULL
         AND o.paid_at IS NULL
         AND r.order_item_id IS NULL
         AND j.id IS NULL
         AND (:startAt='' OR o.created_at >= :startAt)
         AND (:endAt='' OR o.created_at <= :endAt)
       ORDER BY o.created_at ASC, o.id ASC
       LIMIT ${limit}`,
      { startAt, endAt }
    )
    const safe = rows.filter(row => !Number(row.has_verified_payment_fact || 0))
    const conflicts = rows.length - safe.length
    let updated = 0
    if (apply) {
      for (const row of safe) {
        const connection = await pool.getConnection()
        try {
          await connection.beginTransaction()
          const [result] = await connection.query(
            `UPDATE orders
             SET payment_expires_at=DATE_ADD(COALESCE(created_at,NOW()), INTERVAL ${timeoutMinutes} MINUTE),
                 stock_reserved_at=COALESCE(stock_reserved_at, created_at, NOW())
             WHERE id=:orderId
               AND payment_expires_at IS NULL
               AND status IN ('待支付','未支付','unpaid','pending_payment')
               AND payment_status IN ('待支付','未支付','unpaid','pending_payment')
               AND transaction_id IS NULL AND paid_at IS NULL`,
            { orderId: row.id }
          )
          if (Number(result.affectedRows || 0) === 1) {
            await enqueueOrderPaymentTimeout(connection, {
              orderId: row.id,
              expiresAt: new Date(new Date(String(row.created_at).replace(" ", "T")).getTime() + timeoutMinutes * 60 * 1000)
            })
            updated += 1
          }
          await connection.commit()
        } catch (error) {
          await connection.rollback().catch(() => {})
          throw error
        } finally {
          connection.release()
        }
      }
    }
    console.log(JSON.stringify({
      dryRun: !apply,
      scanned: rows.length,
      eligible: safe.length,
      conflicts,
      updated,
      limit,
      timeoutMinutes,
      sampleOrderSuffixes: safe.slice(0, 5).map(row => maskedOrder(row.id)),
      runId: crypto.randomUUID()
    }, null, 2))
  } finally {
    await pool.end()
  }
}

main().catch(error => {
  console.error(String(error.message || error).replace(/(password=)[^\s]+/gi, "$1***"))
  process.exit(1)
})
