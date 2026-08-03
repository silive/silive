#!/usr/bin/env node
"use strict"

const fs = require("fs")
const path = require("path")
const mysql = require("mysql2/promise")
const { connectionConfig, inspectMigrationReadiness } = require("./preflight-production-migration")

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

async function runMigrations({ env = process.env, logger = console } = {}) {
  const config = connectionConfig(env)
  const files = fs.readdirSync(MIGRATION_DIR).filter(file => file.endsWith(".sql")).sort()
  if (!files.length) throw new Error("迁移目录为空")
  const pool = mysql.createPool(config)
  try {
    const connection = await pool.getConnection()
    try {
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
  runMigrations,
  schemaSnapshot,
  splitSql
}
