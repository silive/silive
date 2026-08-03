#!/usr/bin/env node
"use strict"

const crypto = require("crypto")
const mysql = require("mysql2/promise")

const REQUIRED_DATABASE = "vsc_security_test_migration_rehearsal"
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost"])

const REQUIRED_TABLES = [
  "payment_finance_outbox",
  "order_payment_timeout_jobs",
  "order_inventory_reservations",
  "order_inventory_release_events",
  "financial_record_item_allocations",
  "store_referral_attributions",
  "promotion_relation_claims"
]

const REQUIRED_COLUMNS = {
  orders: ["user_id", "user_token", "payment_expires_at", "stock_reserved_at", "stock_released_at"],
  order_payment_timeout_jobs: ["id", "order_id", "status", "attempt_count", "available_at", "locked_at", "locked_by", "processed_at", "last_error", "created_at", "updated_at"],
  payment_finance_outbox: ["event_type", "business_key", "aggregate_type", "aggregate_id", "payload_json", "status", "attempt_count", "available_at", "locked_at", "locked_by", "processed_at", "last_error"],
  refund_items: ["refund_quantity", "product_refund_cents", "discount_refund_cents", "shipping_refund_cents", "store_commission_reversal_cents", "personal_reward_reversal_cents", "pickup_service_fee_impact", "status", "updated_at"],
  reward_records: ["business_key", "related_record_id"],
  store_settlement_records: ["business_key", "related_record_id"],
  sales_agent_commissions: ["business_key", "related_record_id"],
  order_notification_records: ["claim_token", "processing_started_at"],
  order_inventory_releases: ["quantity", "updated_at"]
}

const REQUIRED_INDEXES = {
  payment_finance_outbox: ["uniq_payment_finance_business", "idx_payment_finance_due", "idx_payment_finance_order"],
  order_payment_timeout_jobs: ["uniq_payment_timeout_order", "idx_payment_timeout_due", "idx_payment_timeout_lock"],
  orders: ["idx_orders_payment_timeout"],
  order_inventory_release_events: ["uniq_inventory_release_event_business", "idx_inventory_release_event_item", "idx_inventory_release_event_order", "idx_inventory_release_event_source"],
  refund_items: ["uniq_refund_item_record", "idx_refund_item_order_item"],
  reward_records: ["uniq_reward_business"],
  store_settlement_records: ["uniq_store_settlement_business"],
  sales_agent_commissions: ["uniq_sales_agent_business"],
  promotion_relation_claims: ["PRIMARY", "uniq_promotion_relation_claim"],
  order_idempotency_keys: ["uniq_order_idempotency_scope", "idx_order_idempotency_order", "idx_order_idempotency_expiry"],
  pickup_code_claims: ["PRIMARY", "uniq_pickup_code_order"],
  order_payment_facts: ["uniq_payment_fact_transaction"]
}

function connectionConfig(env = process.env) {
  if (String(env.NODE_ENV || "").toLowerCase() === "production") throw new Error("安全拒绝：NODE_ENV=production")
  const host = String(env.MYSQL_HOST || "").trim().toLowerCase()
  if (!LOCAL_HOSTS.has(host)) throw new Error("安全拒绝：迁移彩排仅允许本机 MySQL")
  const database = String(env.MYSQL_TEST_DATABASE || "").trim()
  if (database !== REQUIRED_DATABASE || !database.startsWith("vsc_security_test_")) {
    throw new Error(`安全拒绝：只允许隔离数据库 ${REQUIRED_DATABASE}`)
  }
  const user = String(env.MYSQL_TEST_USER || "").trim()
  if (!user) throw new Error("安全拒绝：缺少 MYSQL_TEST_USER")
  if (/prod|production|online|master/i.test(`${host}/${database}/${user}`)) throw new Error("安全拒绝：连接信息疑似生产环境")
  return {
    host,
    port: Number(env.MYSQL_TEST_PORT || 3306),
    user,
    password: env.MYSQL_TEST_PASSWORD || "",
    database,
    namedPlaceholders: true,
    dateStrings: true,
    connectionLimit: 2
  }
}

function mask(value) {
  const text = String(value || "")
  if (!text) return ""
  return `***${crypto.createHash("sha256").update(text).digest("hex").slice(0, 8)}`
}

async function hasTable(connection, table) {
  const [[row]] = await connection.query(
    "SELECT COUNT(*) AS count FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name=:table",
    { table }
  )
  return Number(row.count) === 1
}

async function hasColumn(connection, table, column) {
  const [[row]] = await connection.query(
    "SELECT COUNT(*) AS count FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name=:table AND column_name=:column",
    { table, column }
  )
  return Number(row.count) === 1
}

async function duplicateCheck(connection, options) {
  const { name, table, columns, where = "1=1", sampleColumn = columns[0] } = options
  if (!await hasTable(connection, table)) return { name, table, status: "NOT_PRESENT", duplicateGroups: 0, maskedExamples: [] }
  for (const column of [...columns, sampleColumn]) {
    if (!await hasColumn(connection, table, column)) return { name, table, status: "COLUMN_NOT_PRESENT", duplicateGroups: 0, maskedExamples: [] }
  }
  const group = columns.map(column => `\`${column}\``).join(",")
  const [rows] = await connection.query(
    `SELECT MIN(\`${sampleColumn}\`) AS sample_value, COUNT(*) AS row_count
     FROM \`${table}\` WHERE ${where}
     GROUP BY ${group} HAVING COUNT(*)>1 ORDER BY row_count DESC LIMIT 5`
  )
  const [[total]] = await connection.query(
    `SELECT COUNT(*) AS count FROM (
       SELECT 1 FROM \`${table}\` WHERE ${where} GROUP BY ${group} HAVING COUNT(*)>1
     ) duplicate_groups`
  )
  return {
    name,
    table,
    status: Number(total.count) ? "MANUAL_REVIEW" : "PASS",
    duplicateGroups: Number(total.count || 0),
    maskedExamples: rows.map(row => mask(row.sample_value))
  }
}

async function safeCount(connection, table, predicate = "1=1") {
  if (!await hasTable(connection, table)) return null
  const [[row]] = await connection.query(`SELECT COUNT(*) AS count FROM \`${table}\` WHERE ${predicate}`)
  return Number(row.count || 0)
}

async function inspectMigrationReadiness(connection, env = process.env) {
  await connection.query("SET SESSION TRANSACTION READ ONLY")
  await connection.query("START TRANSACTION READ ONLY")
  try {
    const [tables] = await connection.query(
      "SELECT table_name AS table_name FROM information_schema.tables WHERE table_schema=DATABASE() AND table_type='BASE TABLE'"
    )
    const presentTables = new Set(tables.map(row => String(row.table_name)))
    const missingTables = REQUIRED_TABLES.filter(table => !presentTables.has(table))
    const missingColumns = []
    for (const [table, columns] of Object.entries(REQUIRED_COLUMNS)) {
      for (const column of columns) {
        if (!presentTables.has(table) || !await hasColumn(connection, table, column)) missingColumns.push(`${table}.${column}`)
      }
    }
    const [indexes] = await connection.query(
      "SELECT table_name AS table_name,index_name AS index_name FROM information_schema.statistics WHERE table_schema=DATABASE() GROUP BY table_name,index_name"
    )
    const presentIndexes = new Set(indexes.map(row => `${row.table_name}.${row.index_name}`))
    const missingIndexes = []
    for (const [table, names] of Object.entries(REQUIRED_INDEXES)) {
      for (const name of names) if (!presentIndexes.has(`${table}.${name}`)) missingIndexes.push(`${table}.${name}`)
    }
    const duplicateCandidates = []
    for (const check of [
      { name: "payment_transaction", table: "order_payment_facts", columns: ["transaction_id"], where: "transaction_id IS NOT NULL AND transaction_id<>''" },
      { name: "refund_no", table: "refund_records", columns: ["refund_no"], where: "refund_no IS NOT NULL AND refund_no<>''" },
      { name: "reward_business_key", table: "reward_records", columns: ["business_key"], where: "business_key IS NOT NULL AND business_key<>''" },
      { name: "store_business_key", table: "store_settlement_records", columns: ["business_key"], where: "business_key IS NOT NULL AND business_key<>''" },
      { name: "sales_business_key", table: "sales_agent_commissions", columns: ["business_key"], where: "business_key IS NOT NULL AND business_key<>''" },
      { name: "promotion_invitee", table: "promotion_relations", columns: ["invitee_phone"], where: "invitee_phone IS NOT NULL AND invitee_phone<>''" },
      { name: "order_idempotency_scope", table: "order_idempotency_keys", columns: ["user_id", "operation", "request_key"], sampleColumn: "request_key" },
      { name: "pickup_code", table: "pickup_code_claims", columns: ["code"] },
      { name: "pickup_order", table: "pickup_code_claims", columns: ["order_id"] }
    ]) duplicateCandidates.push(await duplicateCheck(connection, check))

    const historicalAnomalies = {
      negativeStock: await safeCount(connection, "products", "stock<0"),
      invalidOrderItemQuantity: await safeCount(connection, "order_items", "quantity<=0"),
      orphanOrderItems: presentTables.has("order_items") && presentTables.has("orders")
        ? Number((await connection.query("SELECT COUNT(*) AS count FROM order_items oi LEFT JOIN orders o ON o.id=oi.order_id WHERE o.id IS NULL"))[0][0].count || 0) : null,
      releaseExceedsOrdered: presentTables.has("order_inventory_releases") && presentTables.has("order_items")
        ? Number((await connection.query("SELECT COUNT(*) AS count FROM order_inventory_releases r JOIN order_items oi ON oi.id=r.order_item_id WHERE r.quantity>oi.quantity"))[0][0].count || 0) : null
    }
    const userTokenCount = presentTables.has("orders") && await hasColumn(connection, "orders", "user_token")
      ? await safeCount(connection, "orders", "user_token IS NOT NULL AND user_token<>''") : null
    const ordersMissingUserId = presentTables.has("orders") && await hasColumn(connection, "orders", "user_id")
      ? await safeCount(connection, "orders", "user_id IS NULL OR user_id='' ") : null
    const manualReviewCount = duplicateCandidates.reduce((sum, item) => sum + item.duplicateGroups, 0) +
      Object.values(historicalAnomalies).filter(value => Number(value || 0) > 0).length
    return {
      ok: manualReviewCount === 0,
      readOnly: true,
      database: REQUIRED_DATABASE,
      presentTableCount: presentTables.size,
      missingTables,
      missingColumns,
      missingIndexes,
      duplicateCandidates,
      userTokenCount,
      ordersMissingUserId,
      newOrdersRequireUserId: presentTables.has("orders") && await hasColumn(connection, "orders", "user_id"),
      aiPreviewMustRemainDisabled: String(env.AI_PREVIEW_ENABLED || "").toLowerCase() !== "true",
      historicalAnomalies,
      manualReviewCount
    }
  } finally {
    await connection.rollback().catch(() => {})
    await connection.query("SET SESSION TRANSACTION READ WRITE").catch(() => {})
  }
}

async function runPreflight({ env = process.env, logger = console } = {}) {
  const pool = mysql.createPool(connectionConfig(env))
  try {
    const connection = await pool.getConnection()
    try {
      const report = await inspectMigrationReadiness(connection, env)
      logger.log(JSON.stringify(report, null, 2))
      return { report, exitCode: report.ok ? 0 : 2 }
    } finally {
      connection.release()
    }
  } finally {
    await pool.end()
  }
}

if (require.main === module) {
  runPreflight().then(result => { process.exitCode = result.exitCode }).catch(error => {
    console.error(JSON.stringify({ ok: false, error: error.message }))
    process.exitCode = 1
  })
}

module.exports = {
  REQUIRED_COLUMNS,
  REQUIRED_DATABASE,
  REQUIRED_INDEXES,
  REQUIRED_TABLES,
  connectionConfig,
  inspectMigrationReadiness,
  runPreflight
}
