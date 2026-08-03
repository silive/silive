"use strict"

// Historical accumulator rows predate release events. This script only records
// their existing quantity as a legacy event; it never changes stock or totals.
const crypto = require("crypto")
const fs = require("fs")
const path = require("path")
const mysql = require("mysql2/promise")

function loadEnv(file) {
  if (!fs.existsSync(file)) return
  for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith("#")) continue
    const separator = line.indexOf("=")
    if (separator < 1) continue
    const key = line.slice(0, separator).trim()
    const value = line.slice(separator + 1).trim().replace(/^(['"])(.*)\1$/, "$2")
    if (process.env[key] == null) process.env[key] = value
  }
}

function positiveInteger(value, fallback, maximum) {
  const number = Math.floor(Number(value))
  if (!Number.isSafeInteger(number) || number <= 0) return fallback
  return Math.min(number, maximum)
}

function argument(name, fallback = "") {
  const index = process.argv.indexOf(name)
  return index >= 0 ? String(process.argv[index + 1] || "") : fallback
}

function masked(value) {
  const text = String(value || "")
  return text.length <= 6 ? "***" : `***${text.slice(-6)}`
}

function legacyEventId(orderItemId) {
  return `IRE${crypto.createHash("sha256").update(`legacy_release:${orderItemId}`).digest("hex").slice(0, 52)}`
}

async function main() {
  loadEnv(path.join(__dirname, "..", ".env"))
  const apply = process.argv.includes("--apply")
  const limit = positiveInteger(argument("--limit", "100"), 100, 500)
  const orderItemId = argument("--order-item-id", "")
  if (apply && String(process.env.NODE_ENV || "").toLowerCase() === "production") {
    throw new Error("安全拒绝：生产环境仅允许库存释放事件 dry-run")
  }
  if (apply && process.env.INVENTORY_RELEASE_EVENT_BACKFILL_CONFIRM !== "APPLY") {
    throw new Error("安全拒绝：--apply 还需要 INVENTORY_RELEASE_EVENT_BACKFILL_CONFIRM=APPLY")
  }
  if (!process.env.MYSQL_USER) throw new Error("缺少 MYSQL_USER")
  const pool = mysql.createPool({
    host: process.env.MYSQL_HOST || "127.0.0.1",
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD || "",
    database: process.env.MYSQL_DATABASE || "very_simple_custom",
    namedPlaceholders: true,
    connectionLimit: 2
  })
  try {
    const [rows] = await pool.query(
      `SELECT r.order_item_id, r.order_id, r.product_id, r.quantity, oi.quantity AS ordered_quantity
       FROM order_inventory_releases r
       JOIN order_items oi ON oi.id=r.order_item_id
       LEFT JOIN order_inventory_release_events e
         ON e.business_key=CONCAT('legacy_release:', r.order_item_id)
       WHERE e.id IS NULL
         AND r.quantity > 0
         AND (:orderItemId='' OR r.order_item_id=:orderItemId)
       ORDER BY r.created_at ASC, r.order_item_id ASC
       LIMIT ${limit}`,
      { orderItemId }
    )
    const valid = rows.filter(row => Number(row.quantity) <= Number(row.ordered_quantity))
    const invalid = rows.filter(row => Number(row.quantity) > Number(row.ordered_quantity))
    let inserted = 0
    if (apply) {
      for (const row of valid) {
        const connection = await pool.getConnection()
        try {
          await connection.beginTransaction()
          const [lockedRows] = await connection.query(
            `SELECT r.order_item_id, r.order_id, r.product_id, r.quantity, oi.quantity AS ordered_quantity
             FROM order_inventory_releases r
             JOIN order_items oi ON oi.id=r.order_item_id
             WHERE r.order_item_id=:orderItemId LIMIT 1 FOR UPDATE`,
            { orderItemId: row.order_item_id }
          )
          const locked = lockedRows[0]
          if (!locked || Number(locked.quantity) <= 0 || Number(locked.quantity) > Number(locked.ordered_quantity)) {
            await connection.commit()
            continue
          }
          const businessKey = `legacy_release:${locked.order_item_id}`
          const [result] = await connection.query(
            `INSERT IGNORE INTO order_inventory_release_events
              (id, business_key, order_item_id, order_id, product_id, quantity, reason, source_type, source_id, created_at)
             VALUES (:id, :businessKey, :orderItemId, :orderId, :productId, :quantity,
                     '历史库存释放兼容记录', 'legacy_release', :sourceId, NOW())`,
            {
              id: legacyEventId(locked.order_item_id),
              businessKey,
              orderItemId: locked.order_item_id,
              orderId: locked.order_id,
              productId: locked.product_id,
              quantity: Number(locked.quantity),
              sourceId: locked.order_item_id
            }
          )
          inserted += Number(result.affectedRows || 0)
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
      eligible: valid.length,
      invalidCumulativeRows: invalid.length,
      inserted,
      sampleOrderItemSuffixes: valid.slice(0, 5).map(row => masked(row.order_item_id))
    }, null, 2))
  } finally {
    await pool.end()
  }
}

main().catch(error => {
  console.error(String(error.message || error).replace(/password=[^\s]+/gi, "password=***"))
  process.exitCode = 1
})
