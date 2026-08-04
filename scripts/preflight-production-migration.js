#!/usr/bin/env node
"use strict"

const crypto = require("crypto")
const fs = require("fs")
const path = require("path")
const mysql = require("mysql2/promise")
const guard = require("./lib/production-operation-guard")

const REQUIRED_DATABASE = "vsc_security_test_production_entry_rehearsal"
const MIGRATION_DIR = path.join(__dirname, "..", "migrations", "2026-08-blue-team")
const REQUIRED_TABLES = ["payment_finance_outbox", "order_payment_timeout_jobs", "order_inventory_reservations", "order_inventory_release_events", "financial_record_item_allocations", "store_referral_attributions", "promotion_relation_claims"]
const REQUIRED_COLUMNS = {
  orders: ["user_id", "user_token", "payment_expires_at", "stock_reserved_at", "stock_released_at"],
  order_payment_timeout_jobs: ["id", "order_id", "status", "attempt_count", "available_at", "locked_at", "locked_by", "processed_at", "last_error", "created_at", "updated_at"],
  payment_finance_outbox: ["event_type", "business_key", "aggregate_type", "aggregate_id", "payload_json", "status", "attempt_count", "available_at", "locked_at", "locked_by", "processed_at", "last_error"],
  refund_items: ["refund_quantity", "product_refund_cents", "discount_refund_cents", "shipping_refund_cents", "store_commission_reversal_cents", "personal_reward_reversal_cents", "pickup_service_fee_impact", "status", "updated_at"],
  reward_records: ["business_key", "related_record_id"], store_settlement_records: ["business_key", "related_record_id"], sales_agent_commissions: ["business_key", "related_record_id"], order_notification_records: ["claim_token", "processing_started_at"], order_inventory_releases: ["quantity", "updated_at"]
}
const REQUIRED_INDEXES = {
  payment_finance_outbox: ["uniq_payment_finance_business", "idx_payment_finance_due", "idx_payment_finance_order"], order_payment_timeout_jobs: ["uniq_payment_timeout_order", "idx_payment_timeout_due", "idx_payment_timeout_lock"], orders: ["idx_orders_payment_timeout"], order_inventory_release_events: ["uniq_inventory_release_event_business", "idx_inventory_release_event_item", "idx_inventory_release_event_order", "idx_inventory_release_event_source"], refund_items: ["uniq_refund_item_record", "idx_refund_item_order_item"], reward_records: ["uniq_reward_business"], store_settlement_records: ["uniq_store_settlement_business"], sales_agent_commissions: ["uniq_sales_agent_business"], promotion_relation_claims: ["PRIMARY", "uniq_promotion_relation_claim"], order_idempotency_keys: ["uniq_order_idempotency_scope", "idx_order_idempotency_order", "idx_order_idempotency_expiry"], pickup_code_claims: ["PRIMARY", "uniq_pickup_code_order"], order_payment_facts: ["uniq_payment_fact_transaction"]
}

function connectionConfig(env = process.env) {
  const mode = { kind: "isolated" }
  const config = guard.mysqlConfigForMode(env, mode)
  if (config.database !== REQUIRED_DATABASE) throw new Error(`安全拒绝：只允许隔离数据库 ${REQUIRED_DATABASE}`)
  if (/prod|production|online|master/i.test(`${config.host}/${config.user}`)) throw new Error("安全拒绝：连接信息疑似生产环境")
  return { ...config, connectionLimit: 2 }
}

function mask(value) { const text = String(value || ""); return text ? `***${crypto.createHash("sha256").update(text).digest("hex").slice(0, 8)}` : "" }
async function hasTable(connection, table) { const [[row]] = await connection.query("SELECT COUNT(*) AS count FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name=:table", { table }); return Number(row.count) === 1 }
async function hasColumn(connection, table, column) { const [[row]] = await connection.query("SELECT COUNT(*) AS count FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name=:table AND column_name=:column", { table, column }); return Number(row.count) === 1 }
async function safeCount(connection, table, predicate = "1=1") { if (!await hasTable(connection, table)) return null; const [[row]] = await connection.query(`SELECT COUNT(*) AS count FROM \`${table}\` WHERE ${predicate}`); return Number(row.count || 0) }

async function duplicateCheck(connection, options) {
  const { name, table, columns, where = "1=1", sampleColumn = columns[0] } = options
  if (!await hasTable(connection, table)) return { name, table, status: "NOT_PRESENT", duplicateGroups: 0, maskedExamples: [] }
  for (const column of [...columns, sampleColumn]) if (!await hasColumn(connection, table, column)) return { name, table, status: "COLUMN_NOT_PRESENT", duplicateGroups: 0, maskedExamples: [] }
  const group = columns.map(column => `\`${column}\``).join(",")
  const [rows] = await connection.query(`SELECT MIN(\`${sampleColumn}\`) AS sample_value,COUNT(*) AS row_count FROM \`${table}\` WHERE ${where} GROUP BY ${group} HAVING COUNT(*)>1 ORDER BY row_count DESC LIMIT 5`)
  const [[total]] = await connection.query(`SELECT COUNT(*) AS count FROM (SELECT 1 FROM \`${table}\` WHERE ${where} GROUP BY ${group} HAVING COUNT(*)>1) duplicate_groups`)
  return { name, table, status: Number(total.count) ? "MANUAL_REVIEW" : "PASS", duplicateGroups: Number(total.count || 0), maskedExamples: rows.map(row => mask(row.sample_value)) }
}

async function structuralFingerprint(connection) {
  const [tables] = await connection.query("SELECT table_name AS table_name,engine AS engine,table_collation AS table_collation FROM information_schema.tables WHERE table_schema=DATABASE() ORDER BY table_name")
  const [columns] = await connection.query("SELECT table_name AS table_name,column_name AS column_name,column_type AS column_type,is_nullable AS is_nullable,column_default AS column_default,extra AS extra FROM information_schema.columns WHERE table_schema=DATABASE() ORDER BY table_name,ordinal_position")
  const [indexes] = await connection.query("SELECT table_name AS table_name,index_name AS index_name,seq_in_index AS seq_in_index,column_name AS column_name,non_unique AS non_unique FROM information_schema.statistics WHERE table_schema=DATABASE() ORDER BY table_name,index_name,seq_in_index")
  return guard.sha256(JSON.stringify({ tables, columns, indexes }))
}

function migrationFiles() {
  const files = fs.readdirSync(MIGRATION_DIR).filter(file => /^00[1-7]_.*\.sql$/.test(file)).sort()
  if (files.length !== 7) throw new Error("安全拒绝：迁移文件必须严格为固定 7 个")
  return files.map(file => ({ file, sha256: guard.sha256File(path.join(MIGRATION_DIR, file)) }))
}

async function inspectMigrationReadiness(connection, env = process.env) {
  await connection.query("SET SESSION TRANSACTION READ ONLY")
  await connection.query("START TRANSACTION READ ONLY")
  try {
    const [tables] = await connection.query("SELECT table_name AS table_name FROM information_schema.tables WHERE table_schema=DATABASE() AND table_type='BASE TABLE'")
    const presentTables = new Set(tables.map(row => String(row.table_name)))
    const missingTables = REQUIRED_TABLES.filter(table => !presentTables.has(table)); const missingColumns = []
    for (const [table, columns] of Object.entries(REQUIRED_COLUMNS)) for (const column of columns) if (!presentTables.has(table) || !await hasColumn(connection, table, column)) missingColumns.push(`${table}.${column}`)
    const [indexes] = await connection.query("SELECT table_name AS table_name,index_name AS index_name FROM information_schema.statistics WHERE table_schema=DATABASE() GROUP BY table_name,index_name")
    const presentIndexes = new Set(indexes.map(row => `${row.table_name}.${row.index_name}`)); const missingIndexes = []
    for (const [table, names] of Object.entries(REQUIRED_INDEXES)) for (const name of names) if (!presentIndexes.has(`${table}.${name}`)) missingIndexes.push(`${table}.${name}`)
    const duplicateCandidates = []
    for (const check of [
      { name: "payment_transaction", table: "order_payment_facts", columns: ["transaction_id"], where: "transaction_id IS NOT NULL AND transaction_id<>''" }, { name: "refund_no", table: "refund_records", columns: ["refund_no"], where: "refund_no IS NOT NULL AND refund_no<>''" }, { name: "reward_business_key", table: "reward_records", columns: ["business_key"], where: "business_key IS NOT NULL AND business_key<>''" }, { name: "store_business_key", table: "store_settlement_records", columns: ["business_key"], where: "business_key IS NOT NULL AND business_key<>''" }, { name: "sales_business_key", table: "sales_agent_commissions", columns: ["business_key"], where: "business_key IS NOT NULL AND business_key<>''" }, { name: "promotion_invitee", table: "promotion_relations", columns: ["invitee_phone"], where: "invitee_phone IS NOT NULL AND invitee_phone<>''" }, { name: "order_idempotency_scope", table: "order_idempotency_keys", columns: ["user_id", "operation", "request_key"], sampleColumn: "request_key" }, { name: "pickup_code", table: "pickup_code_claims", columns: ["code"] }, { name: "pickup_order", table: "pickup_code_claims", columns: ["order_id"] }
    ]) duplicateCandidates.push(await duplicateCheck(connection, check))
    const historicalAnomalies = { negativeStock: await safeCount(connection, "products", "stock<0"), invalidOrderItemQuantity: await safeCount(connection, "order_items", "quantity<=0"), orphanOrderItems: presentTables.has("order_items") && presentTables.has("orders") ? Number((await connection.query("SELECT COUNT(*) AS count FROM order_items oi LEFT JOIN orders o ON o.id=oi.order_id WHERE o.id IS NULL"))[0][0].count || 0) : null, releaseExceedsOrdered: presentTables.has("order_inventory_releases") && presentTables.has("order_items") ? Number((await connection.query("SELECT COUNT(*) AS count FROM order_inventory_releases r JOIN order_items oi ON oi.id=r.order_item_id WHERE r.quantity>oi.quantity"))[0][0].count || 0) : null }
    const userTokenCount = presentTables.has("orders") && await hasColumn(connection, "orders", "user_token") ? await safeCount(connection, "orders", "user_token IS NOT NULL AND user_token<>''") : null
    const ordersMissingUserId = presentTables.has("orders") && await hasColumn(connection, "orders", "user_id") ? await safeCount(connection, "orders", "user_id IS NULL OR user_id='' ") : null
    const manualReviewCount = duplicateCandidates.reduce((sum, item) => sum + item.duplicateGroups, 0) + Object.values(historicalAnomalies).filter(value => Number(value || 0) > 0).length
    return { ok: manualReviewCount === 0, readOnly: true, database: (await guard.databaseFingerprint(connection)).database, presentTableCount: presentTables.size, missingTables, missingColumns, missingIndexes, duplicateCandidates, userTokenCount, ordersMissingUserId, newOrdersRequireUserId: presentTables.has("orders") && await hasColumn(connection, "orders", "user_id"), aiPreviewMustRemainDisabled: String(env.AI_PREVIEW_ENABLED || "").toLowerCase() !== "true", historicalAnomalies, manualReviewCount }
  } finally { await connection.rollback().catch(() => {}); await connection.query("SET SESSION TRANSACTION READ WRITE").catch(() => {}) }
}

function parseArgs(argv) {
  const common = guard.parseCommonOperationArgs(argv)
  return { ...common, outputPlan: common.raw.find(value => value.startsWith("--output-plan="))?.slice("--output-plan=".length) || "" }
}

async function runPreflight({ argv = process.argv.slice(2), env = process.env, logger = console, repoRoot = path.join(__dirname, "..") } = {}) {
  const args = parseArgs(argv); const mode = guard.assertMode(args, env, repoRoot)
  if (mode.kind === "isolated") {
    const pool = mysql.createPool(connectionConfig(env)); try { const connection = await pool.getConnection(); try { const report = await inspectMigrationReadiness(connection, env); logger.log(JSON.stringify(report, null, 2)); return { report, exitCode: report.ok ? 0 : 2 } } finally { connection.release() } } finally { await pool.end() }
  }
  if (!args.readOnly) throw new Error("安全拒绝：生产/彩排 preflight 必须提供 --read-only")
  guard.requireExternalPath(args.outputPlan, "--output-plan", repoRoot); guard.requireExternalPath(args.operationLog, "--operation-log", repoRoot)
  const config = guard.mysqlConfigForMode(env, mode); const pool = mysql.createPool(config)
  try {
    const connection = await pool.getConnection()
    try {
      const fingerprint = await guard.databaseFingerprint(connection); guard.assertFingerprint(fingerprint, args, mode)
      const report = await inspectMigrationReadiness(connection, env); const generatedMs = Date.now(); const generatedAt = new Date(generatedMs).toISOString()
      const plan = { version: 1, operation: "migration-preflight", mode: mode.kind, generatedAt, expiresAt: new Date(generatedMs + guard.MAX_PLAN_AGE_MS).toISOString(), gitSha: mode.state.sha, database: fingerprint.database, serverUuid: fingerprint.serverUuid, mysqlVersion: fingerprint.version, databaseFingerprint: guard.fingerprintDigest(fingerprint), structureFingerprint: await structuralFingerprint(connection), migrations: migrationFiles(), migrationPreflightAnomalies: report.manualReviewCount, uniqueIndexDuplicateCandidates: report.duplicateCandidates.reduce((sum, item) => sum + item.duplicateGroups, 0), estimatedTestOrderCount: null, userTokenNonEmptyCount: report.userTokenCount, aiPreviewEnabled: String(env.AI_PREVIEW_ENABLED || "").toLowerCase() === "true", pm2InstanceCount: Number(env.PM2_INSTANCE_COUNT || 0), backupPrerequisite: "NOT_CHECKED", conclusion: report.ok ? "PASS" : "BLOCKED" }
      fs.writeFileSync(args.outputPlan, `${JSON.stringify(plan, null, 2)}\n`, { mode: 0o600 }); fs.chmodSync(args.outputPlan, 0o600)
      guard.createOperationLog(args.operationLog, { operation: "migration-preflight", mode: mode.kind, gitSha: mode.state.sha, databaseFingerprint: guard.fingerprintDigest(fingerprint), planSha256: guard.sha256File(args.outputPlan), confirmedAt: generatedAt, result: plan.conclusion }, repoRoot)
      logger.log(JSON.stringify(plan, null, 2)); return { report: plan, exitCode: plan.conclusion === "PASS" ? 0 : 2 }
    } finally { connection.release() }
  } finally { await pool.end() }
}

if (require.main === module) runPreflight().then(result => { process.exitCode = result.exitCode }).catch(error => { console.error(JSON.stringify({ ok: false, error: error.message })); process.exitCode = 1 })
module.exports = { REQUIRED_COLUMNS, REQUIRED_DATABASE, REQUIRED_INDEXES, REQUIRED_TABLES, connectionConfig, inspectMigrationReadiness, migrationFiles, parseArgs, runPreflight, structuralFingerprint }
