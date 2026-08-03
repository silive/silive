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
  if (!database) throw new Error("请显式提供只读审计数据库名：node scripts/audit-payment-finance-outbox.js <database>")
  if (!/^[A-Za-z0-9_]+$/.test(database)) throw new Error("数据库名格式无效")
  if (!process.env.MYSQL_USER) throw new Error("缺少 MYSQL_USER")
  const pool = mysql.createPool({
    host: process.env.MYSQL_HOST || "127.0.0.1",
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD || "",
    database,
    namedPlaceholders: true,
    connectionLimit: 2,
    dateStrings: true
  })
  try {
    const [[summary]] = await pool.query(
      `SELECT
        SUM(CASE WHEN e.id IS NULL THEN 1 ELSE 0 END) AS paid_missing_event,
        SUM(CASE WHEN e.status IN ('PENDING','RETRY','PROCESSING','FAILED') THEN 1 ELSE 0 END) AS pending_or_failed_events,
        SUM(CASE WHEN e.status='COMPLETED'
          AND (COALESCE(o.referrer_store_id,'')<>'' OR COALESCE(o.referrer_user_id,'')<>'' OR COALESCE(o.parent_referrer_user_id,'')<>'' OR COALESCE(o.pickup_store_id,'')<>'')
          AND
          NOT EXISTS (SELECT 1 FROM reward_records r WHERE r.order_id=o.id)
          AND NOT EXISTS (SELECT 1 FROM store_settlement_records s WHERE s.order_id=o.id)
          AND NOT EXISTS (SELECT 1 FROM sales_agent_commissions a WHERE a.order_id=o.id AND a.type='sales_agent_commission')
          THEN 1 ELSE 0 END) AS completed_candidate_missing_financial_record
       FROM orders o
       LEFT JOIN payment_finance_outbox e
         ON e.event_type='PAYMENT_FINANCE_POST_PROCESS'
         AND e.aggregate_type='order'
         AND e.aggregate_id=o.id
       WHERE o.payment_status='已支付'
         AND COALESCE(o.status,'') NOT IN ('已取消','cancelled','canceled','已关闭','closed','已作废','void','已退款','退款中','退款处理中','PAID_AFTER_CANCEL')`
    )
    const [duplicates] = await pool.query(
      `SELECT COUNT(*) AS duplicate_business_keys
       FROM (
         SELECT business_key
         FROM payment_finance_outbox
         GROUP BY business_key
         HAVING COUNT(*) > 1
       ) duplicate_keys`
    )
    const [stale] = await pool.query(
      `SELECT
         SUM(status='PROCESSING' AND COALESCE(locked_at,updated_at) < DATE_SUB(NOW(), INTERVAL 5 MINUTE)) AS stale_processing,
         SUM(status='FAILED') AS failed
       FROM payment_finance_outbox
       WHERE event_type='PAYMENT_FINANCE_POST_PROCESS'`
    )
    console.log(JSON.stringify({
      readOnly: true,
      database: "configured",
      paidMissingEvent: Number(summary.paid_missing_event || 0),
      pendingOrFailedEvents: Number(summary.pending_or_failed_events || 0),
      completedCandidateMissingFinancialRecord: Number(summary.completed_candidate_missing_financial_record || 0),
      duplicateBusinessKeys: Number(duplicates[0]?.duplicate_business_keys || 0),
      staleProcessing: Number(stale[0]?.stale_processing || 0),
      failed: Number(stale[0]?.failed || 0)
    }, null, 2))
  } finally {
    await pool.end()
  }
}

main().catch(error => {
  console.error(String(error.message || error).replace(/password=[^\s]+/gi, "password=***"))
  process.exitCode = 1
})
