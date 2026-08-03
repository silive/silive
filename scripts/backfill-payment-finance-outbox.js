"use strict"

// This command only backfills payment-finance Outbox rows. It never writes ledgers directly.
const fs = require("fs")
const path = require("path")
const mysql = require("mysql2/promise")
const { compensateMissingPaymentFinanceEvents } = require("../cms/payment-finance-outbox")

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

function readOption(name, fallback = "") {
  const index = process.argv.indexOf(name)
  return index >= 0 ? String(process.argv[index + 1] || "") : fallback
}

function positiveInteger(value, fallback, maximum) {
  const number = Math.floor(Number(value))
  if (!Number.isFinite(number) || number <= 0) return fallback
  return Math.min(number, maximum)
}

function maskCursor(value) {
  const text = String(value || "")
  if (!text) return ""
  return text.length <= 6 ? "***" : `${text.slice(0, 2)}***${text.slice(-4)}`
}

async function main() {
  loadEnv(path.join(__dirname, "..", ".env"))
  const apply = process.argv.includes("--apply")
  const database = String(process.env.MYSQL_DATABASE || "").trim()
  if (!database || !process.env.MYSQL_USER) throw new Error("缺少 MySQL 连接配置")
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
    const result = await compensateMissingPaymentFinanceEvents({
      pool,
      apply,
      scanDays: positiveInteger(readOption("--days", "30"), 30, 3650),
      limit: positiveInteger(readOption("--limit", "100"), 100, 1000),
      batchSize: positiveInteger(readOption("--batch-size", "25"), 25, 100),
      cursor: readOption("--cursor", ""),
      startAt: readOption("--from", ""),
      endAt: readOption("--to", "")
    })
    console.log(JSON.stringify({
      ok: true,
      mode: apply ? "apply" : "dry-run",
      scanned: result.scanned,
      queued: result.queued,
      hasNextCursor: !!result.nextCursor,
      nextCursor: maskCursor(result.nextCursor)
    }, null, 2))
  } finally {
    await pool.end()
  }
}

main().catch(error => {
  console.error(String(error.message || error).replace(/password=[^\s]+/gi, "password=***"))
  process.exitCode = 1
})
