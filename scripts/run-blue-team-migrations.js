#!/usr/bin/env node
"use strict"

const fs = require("fs")
const path = require("path")
const mysql = require("mysql2/promise")
const guard = require("./lib/production-operation-guard")
const { connectionConfig, inspectMigrationReadiness, migrationFiles, structuralFingerprint } = require("./preflight-production-migration")

const MIGRATION_DIR = path.join(__dirname, "..", "migrations", "2026-08-blue-team")

function splitSql(source) {
  const withoutComments = source.split(/\r?\n/)
    .filter(line => !line.trim().startsWith("--"))
    .join("\n")
  const statements = []
  let current = ""
  let quote = ""
  for (let index = 0; index < withoutComments.length; index += 1) {
    const char = withoutComments[index]
    const previous = withoutComments[index - 1]
    if (quote) {
      current += char
      if (char === quote && previous !== "\\") quote = ""
      continue
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char
      current += char
      continue
    }
    if (char === ";") {
      if (current.trim()) statements.push(current.trim())
      current = ""
    } else current += char
  }
  if (current.trim()) statements.push(current.trim())
  return statements
}

async function schemaSnapshot(connection) {
  const [tables] = await connection.query(
    "SELECT table_name AS table_name FROM information_schema.tables WHERE table_schema=DATABASE() AND table_type='BASE TABLE' ORDER BY table_name"
  )
  const [columns] = await connection.query(
    "SELECT table_name AS table_name,column_name AS column_name FROM information_schema.columns WHERE table_schema=DATABASE() ORDER BY table_name,ordinal_position"
  )
  const [indexes] = await connection.query(
    "SELECT table_name AS table_name,index_name AS index_name FROM information_schema.statistics WHERE table_schema=DATABASE() GROUP BY table_name,index_name ORDER BY table_name,index_name"
  )
  return {
    tables: tables.map(row => String(row.table_name)),
    columns: columns.map(row => `${row.table_name}.${row.column_name}`),
    indexes: indexes.map(row => `${row.table_name}.${row.index_name}`)
  }
}

function difference(after, before) {
  const existing = new Set(before)
  return after.filter(value => !existing.has(value))
}

function parseCreateIndex(statement) {
  const match = statement.match(/^CREATE\s+(UNIQUE\s+)?INDEX\s+`?([a-zA-Z0-9_]+)`?\s+ON\s+`?([a-zA-Z0-9_]+)`?\s*\(([^)]+)\)/i)
  if (!match) return null
  return {
    unique: !!match[1],
    name: match[2],
    table: match[3],
    columns: match[4].split(",").map(value => value.replace(/`/g, "").trim().split(/\s+/)[0])
  }
}

function parseAddColumn(statement) {
  const match = statement.match(/^ALTER\s+TABLE\s+`?([a-zA-Z0-9_]+)`?\s+ADD\s+COLUMN\s+`?([a-zA-Z0-9_]+)`?/i)
  return match ? { table: match[1], column: match[2] } : null
}

async function findEquivalentIndex(connection, parsed) {
  const [rows] = await connection.query(
    `SELECT index_name AS index_name,non_unique AS non_unique,column_name AS column_name,seq_in_index AS seq_in_index
     FROM information_schema.statistics
     WHERE table_schema=DATABASE() AND table_name=:table
     ORDER BY index_name,seq_in_index`,
    { table: parsed.table }
  )
  const groups = new Map()
  for (const row of rows) {
    const name = String(row.index_name)
    if (!groups.has(name)) groups.set(name, { unique: Number(row.non_unique) === 0, columns: [] })
    groups.get(name).columns.push(String(row.column_name))
  }
  for (const [name, definition] of groups) {
    if (definition.unique === parsed.unique && JSON.stringify(definition.columns) === JSON.stringify(parsed.columns)) return name
  }
  return ""
}

async function executeStatement(connection, statement) {
  const addedColumn = parseAddColumn(statement)
  if (addedColumn) {
    const [[row]] = await connection.query(
      "SELECT COUNT(*) AS count FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name=:table AND column_name=:column",
      addedColumn
    )
    if (Number(row.count)) return { skipped: true, reason: `existing_column:${addedColumn.table}.${addedColumn.column}` }
  }
  const parsed = parseCreateIndex(statement)
  if (parsed) {
    const equivalent = await findEquivalentIndex(connection, parsed)
    if (equivalent) return { skipped: true, reason: `equivalent_index:${equivalent}` }
  }
  try {
    const [result] = await connection.query(statement)
    return { skipped: false, affectedRows: Number(result?.affectedRows || 0) }
  } catch (error) {
    if (error.code === "ER_DUP_KEYNAME" && parsed) {
      const equivalent = await findEquivalentIndex(connection, parsed)
      if (equivalent) return { skipped: true, reason: `existing_index:${equivalent}` }
    }
    if (error.code === "ER_DUP_ENTRY") {
      throw Object.assign(new Error(`MANUAL_REVIEW：唯一索引候选存在重复数据（${parsed?.table || "unknown"}）`), { cause: error })
    }
    throw error
  }
}

async function businessRowCounts(connection) {
  const targetTables = [
    "customers", "products", "partner_stores", "store_members", "orders", "order_items",
    "order_payment_facts", "order_inventory_releases", "refund_records", "refund_items",
    "promotion_relations", "reward_records", "store_settlement_records", "sales_agent_commissions",
    "pickup_code_claims", "order_idempotency_keys", "wechat_fulfillment_records", "order_notification_records"
  ]
  const [tables] = await connection.query(
    "SELECT table_name AS table_name FROM information_schema.tables WHERE table_schema=DATABASE()"
  )
  const present = new Set(tables.map(row => String(row.table_name)))
  const result = {}
  for (const table of targetTables) {
    if (!present.has(table)) continue
    const [[row]] = await connection.query(`SELECT COUNT(*) AS count FROM \`${table}\``)
    result[table] = Number(row.count || 0)
  }
  return result
}

function parseArgs(argv) {
  const common = guard.parseCommonOperationArgs(argv)
  const value = name => common.raw.find(arg => arg.startsWith(`${name}=`))?.slice(name.length + 1) || ""
  return {
    ...common,
    preflightPlan: value("--preflight-plan"),
    preflightPlanSha256: value("--preflight-plan-sha256"),
    confirmSeven: common.raw.includes("--confirm-run-seven-migrations")
  }
}

async function validateControlledExecution(connection, args, mode, env, repoRoot) {
  if (mode.kind === "production" && !args.apply) throw new Error("安全拒绝：生产迁移必须明确提供 --apply")
  if (args.apply && !args.confirmSeven) throw new Error("安全拒绝：apply 必须同时提供 --confirm-run-seven-migrations")
  for (const [label, value] of Object.entries({ "--preflight-plan": args.preflightPlan, "--preflight-plan-sha256": args.preflightPlanSha256, "--backup-manifest": args.backupManifest, "--operation-log": args.operationLog })) if (!value) throw new Error(`安全拒绝：缺少 ${label}`)
  const planRead = guard.readJson(args.preflightPlan, "preflight 计划文件", repoRoot)
  if (planRead.sha256 !== args.preflightPlanSha256) throw new Error("安全拒绝：preflight 计划摘要不一致")
  guard.assertPlanFresh(planRead.value, args.expectedGitSha)
  const fingerprint = await guard.databaseFingerprint(connection); guard.assertFingerprint(fingerprint, args, mode)
  if (planRead.value.database !== fingerprint.database || planRead.value.serverUuid !== fingerprint.serverUuid || planRead.value.databaseFingerprint !== guard.fingerprintDigest(fingerprint)) throw new Error("安全拒绝：计划数据库指纹不一致")
  if (planRead.value.structureFingerprint !== await structuralFingerprint(connection)) throw new Error("安全拒绝：数据库结构在 dry-run 后发生变化")
  const files = migrationFiles()
  if (JSON.stringify(planRead.value.migrations) !== JSON.stringify(files)) throw new Error("安全拒绝：迁移文件或 SHA-256 已变化")
  if (Number(planRead.value.uniqueIndexDuplicateCandidates || 0) !== 0 || planRead.value.conclusion !== "PASS") throw new Error("安全拒绝：preflight 存在重复候选或未通过")
  if (String(env.AI_PREVIEW_ENABLED || "").toLowerCase() === "true") throw new Error("安全拒绝：AI_PREVIEW_ENABLED=true")
  const backup = guard.assertBackupManifest(args.backupManifest, fingerprint, repoRoot)
  const disk = guard.assertDiskSpace(path.dirname(backup.manifest.backupFile), backup.backupSize, env)
  guard.requireExternalPath(args.operationLog, "--operation-log", repoRoot)
  return { fingerprint, planRead, files: files.map(item => item.file), backup, disk }
}

async function runMigrations({ argv = process.argv.slice(2), env = process.env, logger = console, repoRoot = path.join(__dirname, "..") } = {}) {
  const args = parseArgs(argv)
  const mode = guard.assertMode(args, env, repoRoot)
  const config = mode.kind === "isolated" ? connectionConfig(env) : guard.mysqlConfigForMode(env, mode)
  const files = mode.kind === "isolated" ? fs.readdirSync(MIGRATION_DIR).filter(file => file.endsWith(".sql")).sort() : migrationFiles().map(item => item.file)
  if (!files.length) throw new Error("迁移目录为空")
  const pool = mysql.createPool(config)
  try {
    const connection = await pool.getConnection()
    try {
      const controlled = mode.kind === "isolated" ? null : await validateControlledExecution(connection, args, mode, env, repoRoot)
      if (controlled && !args.apply) {
        const report = { ok: true, mode: mode.kind, dryRun: true, databaseFingerprint: guard.fingerprintDigest(controlled.fingerprint), migrationFileCount: files.length, migrationFiles: files, preflightPlanSha256: controlled.planRead.sha256, backupManifestSha256: controlled.backup.manifestSha256, disk: controlled.disk }
        guard.createOperationLog(args.operationLog, { operation: "migration-dry-run", mode: mode.kind, gitSha: args.expectedGitSha, databaseFingerprint: report.databaseFingerprint, planSha256: controlled.planRead.sha256, confirmedAt: new Date().toISOString(), result: "PASS" }, repoRoot)
        logger.log(JSON.stringify(report, null, 2)); return report
      }
      const preflight = await inspectMigrationReadiness(connection, env)
      if (!preflight.ok) {
        const error = new Error(`MANUAL_REVIEW：迁移前检查发现 ${preflight.manualReviewCount} 项数据异常`)
        error.preflight = preflight
        throw error
      }
      const initialSchema = await schemaSnapshot(connection)
      const initialRows = await businessRowCounts(connection)
      const executions = []
      for (let order = 0; order < files.length; order += 1) {
        const file = files[order]
        const startedAt = new Date().toISOString()
        const before = await schemaSnapshot(connection)
        const statements = splitSql(fs.readFileSync(path.join(MIGRATION_DIR, file), "utf8"))
        const statementResults = []
        try {
          for (const statement of statements) statementResults.push(await executeStatement(connection, statement))
        } catch (error) {
          error.message = `${file} 执行失败，已停止后续迁移：${error.message}`
          throw error
        }
        const after = await schemaSnapshot(connection)
        executions.push({
          order: order + 1,
          file,
          startedAt,
          endedAt: new Date().toISOString(),
          exitCode: 0,
          statementCount: statements.length,
          skippedStatements: statementResults.filter(result => result.skipped).length,
          addedTables: difference(after.tables, before.tables),
          addedColumns: difference(after.columns, before.columns),
          addedIndexes: difference(after.indexes, before.indexes),
          businessDataModified: false
        })
      }
      const finalSchema = await schemaSnapshot(connection)
      const finalRows = await businessRowCounts(connection)
      const report = {
        ok: true,
        mode: mode.kind,
        database: config.database,
        migrationFileCount: files.length,
        executions,
        addedTables: difference(finalSchema.tables, initialSchema.tables),
        addedColumns: difference(finalSchema.columns, initialSchema.columns),
        addedIndexes: difference(finalSchema.indexes, initialSchema.indexes),
        businessRowCountsBefore: initialRows,
        businessRowCountsAfter: finalRows,
        businessRowCountChanges: Object.fromEntries(Object.keys({ ...initialRows, ...finalRows }).map(table => [table, Number(finalRows[table] || 0) - Number(initialRows[table] || 0)]))
      }
      if (controlled) guard.createOperationLog(args.operationLog, { operation: "migration-apply", mode: mode.kind, gitSha: args.expectedGitSha, databaseFingerprint: guard.fingerprintDigest(controlled.fingerprint), planSha256: controlled.planRead.sha256, confirmedAt: new Date().toISOString(), result: "PASS", migrationFiles: files }, repoRoot)
      logger.log(JSON.stringify(report, null, 2))
      return report
    } finally {
      connection.release()
    }
  } finally {
    await pool.end()
  }
}

if (require.main === module) {
  runMigrations().catch(error => {
    const output = { ok: false, error: error.message }
    if (error.preflight) output.preflight = error.preflight
    console.error(JSON.stringify(output, null, 2))
    process.exitCode = 1
  })
}

module.exports = {
  MIGRATION_DIR,
  businessRowCounts,
  parseCreateIndex,
  parseAddColumn,
  parseArgs,
  runMigrations,
  schemaSnapshot,
  splitSql
}
