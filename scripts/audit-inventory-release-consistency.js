"use strict"

// Read-only reconciliation helper. It intentionally has no --apply mode.
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

async function main() {
  loadEnv(path.join(__dirname, "..", ".env"))
  const database = String(process.argv[2] || process.env.MYSQL_AUDIT_DATABASE || "").trim()
  if (!database || !/^[A-Za-z0-9_]+$/.test(database)) throw new Error("请显式提供只读审计数据库名")
  if (!process.env.MYSQL_USER) throw new Error("缺少 MYSQL_USER")
  const pool = mysql.createPool({
    host: process.env.MYSQL_HOST || "127.0.0.1",
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD || "",
    database,
    namedPlaceholders: true,
    connectionLimit: 2
  })
  try {
    const [[summary]] = await pool.query(
      `SELECT
        SUM(CASE WHEN r.quantity > oi.quantity THEN 1 ELSE 0 END) AS accumulator_exceeds_ordered,
        SUM(CASE WHEN r.quantity < 0 THEN 1 ELSE 0 END) AS negative_accumulator,
        SUM(CASE WHEN r.quantity > 0 AND event_total.total_quantity IS NULL THEN 1 ELSE 0 END) AS legacy_rows_without_event,
        SUM(CASE WHEN event_total.total_quantity > oi.quantity THEN 1 ELSE 0 END) AS events_exceed_ordered,
        SUM(CASE WHEN event_total.total_quantity IS NOT NULL AND r.quantity <> event_total.total_quantity
                 AND event_total.has_legacy_event=0 THEN 1 ELSE 0 END) AS accumulator_event_mismatch
       FROM order_inventory_releases r
       JOIN order_items oi ON oi.id=r.order_item_id
       LEFT JOIN (
         SELECT order_item_id, SUM(quantity) AS total_quantity,
                MAX(source_type='legacy_release') AS has_legacy_event
         FROM order_inventory_release_events
         GROUP BY order_item_id
       ) event_total ON event_total.order_item_id=r.order_item_id`
    )
    const [[refundCoverage]] = await pool.query(
      `SELECT
        SUM(CASE WHEN oi.inventory_mode='FINITE' AND e.id IS NULL THEN 1 ELSE 0 END) AS successful_refund_items_without_release_event,
        SUM(CASE WHEN oi.inventory_mode='FINITE' AND e.id IS NOT NULL
                   AND (o.shipped_at IS NOT NULL OR o.completed_at IS NOT NULL
                        OR o.pickup_verified_at IS NOT NULL OR o.force_pickup_verified_at IS NOT NULL)
                 THEN 1 ELSE 0 END) AS fulfilled_orders_with_refund_release_event,
        SUM(CASE WHEN oi.inventory_mode<>'FINITE' AND e.id IS NOT NULL THEN 1 ELSE 0 END) AS non_finite_items_with_release_event
       FROM refund_items ri
       JOIN refund_records rr ON rr.id=ri.refund_record_id AND rr.status='SUCCESS'
       JOIN order_items oi ON oi.id=ri.order_item_id
       JOIN orders o ON o.id=oi.order_id
       LEFT JOIN order_inventory_release_events e
         ON e.order_item_id=ri.order_item_id
        AND e.source_type IN ('partial_refund','full_refund')
       WHERE ri.status='SUCCESS'`
    )
    console.log(JSON.stringify({
      readOnly: true,
      accumulatorExceedsOrdered: Number(summary.accumulator_exceeds_ordered || 0),
      negativeAccumulator: Number(summary.negative_accumulator || 0),
      legacyRowsWithoutEvent: Number(summary.legacy_rows_without_event || 0),
      eventsExceedOrdered: Number(summary.events_exceed_ordered || 0),
      accumulatorEventMismatch: Number(summary.accumulator_event_mismatch || 0),
      successfulRefundItemsWithoutReleaseEvent: Number(refundCoverage.successful_refund_items_without_release_event || 0),
      fulfilledOrdersWithRefundReleaseEvent: Number(refundCoverage.fulfilled_orders_with_refund_release_event || 0),
      nonFiniteItemsWithReleaseEvent: Number(refundCoverage.non_finite_items_with_release_event || 0)
    }, null, 2))
  } finally {
    await pool.end()
  }
}

main().catch(error => {
  console.error(String(error.message || error).replace(/password=[^\s]+/gi, "password=***"))
  process.exitCode = 1
})
