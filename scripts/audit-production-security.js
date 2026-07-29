"use strict"

const fs = require("fs")
const path = require("path")
const mysql = require("mysql2/promise")

function loadEnv(file) {
  if (!fs.existsSync(file)) return
  fs.readFileSync(file, "utf8").split(/\r?\n/).forEach(line => {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/)
    if (!match || process.env[match[1]]) return
    process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2")
  })
}

function maskedId(value) {
  const text = String(value || "")
  if (text.length <= 8) return text ? `${text.slice(0, 2)}***` : ""
  return `${text.slice(0, 4)}***${text.slice(-4)}`
}

function number(value) {
  return Number(value || 0)
}

async function main() {
  loadEnv(path.join(__dirname, "..", ".env"))
  if (!process.env.MYSQL_USER || !process.env.MYSQL_DATABASE) {
    throw new Error("缺少生产数据库只读审计所需环境变量")
  }
  const pool = mysql.createPool({
    host: process.env.MYSQL_HOST || "127.0.0.1",
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD || "",
    database: process.env.MYSQL_DATABASE,
    namedPlaceholders: true,
    connectionLimit: 2,
    dateStrings: true
  })
  const schema = process.env.MYSQL_DATABASE
  const tables = new Map()

  async function columns(table) {
    if (tables.has(table)) return tables.get(table)
    const [rows] = await pool.query(
      `SELECT COLUMN_NAME
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA=:schema AND TABLE_NAME=:table`,
      { schema, table }
    )
    const result = new Set(rows.map(row => row.COLUMN_NAME))
    tables.set(table, result)
    return result
  }

  async function exists(table, required = []) {
    const available = await columns(table)
    return available.size > 0 && required.every(column => available.has(column))
  }

  async function metric(name, sql, params = {}) {
    try {
      const [rows] = await pool.query(sql, params)
      const row = rows[0] || {}
      return {
        name,
        count: number(row.count),
        amount: row.amount == null ? undefined : number(row.amount).toFixed(2),
        earliest: row.earliest || undefined,
        latest: row.latest || undefined,
        examples: rows.slice(0, 5).map(item => maskedId(item.example_id)).filter(Boolean)
      }
    } catch (error) {
      return { name, unavailable: true, reason: String(error.code || error.message).slice(0, 100) }
    }
  }

  const results = []
  const orderColumns = await columns("orders")
  const hasOrders = orderColumns.size > 0
  if (hasOrders) {
    if (
      orderColumns.has("referrer_store_id") &&
      orderColumns.has("store_attribution_id") &&
      await exists("store_settlement_records", ["order_id", "type", "amount"])
    ) {
      results.push(await metric(
        "paid_store_commission_without_server_attribution",
        `SELECT COUNT(DISTINCT o.id) count,
                COALESCE(SUM(s.amount),0) amount,
                MIN(o.created_at) earliest,
                MAX(o.created_at) latest,
                MIN(o.id) example_id
         FROM orders o
         JOIN store_settlement_records s ON s.order_id=o.id
         WHERE s.type IN ('store_referral_commission','referral','referral_commission')
           AND COALESCE(o.referrer_store_id,'')<>''
           AND COALESCE(o.store_attribution_id,'')=''`
      ))
    }
    if (orderColumns.has("store_order_type")) {
      const [rows] = await pool.query(
        `SELECT COALESCE(NULLIF(store_order_type,''),'unknown') source_type,
                COUNT(*) count,
                COALESCE(SUM(amount),0) amount
         FROM orders
         WHERE COALESCE(referrer_store_id,'')<>''
         GROUP BY COALESCE(NULLIF(store_order_type,''),'unknown')`
      )
      results.push({
        name: "store_order_attribution_breakdown",
        values: rows.map(row => ({
          sourceType: row.source_type,
          count: number(row.count),
          amount: number(row.amount).toFixed(2)
        }))
      })
    }
    if (orderColumns.has("user_token")) {
      results.push(await metric(
        "orders_with_raw_user_token",
        `SELECT COUNT(*) count, MIN(created_at) earliest, MAX(created_at) latest, MIN(id) example_id
         FROM orders WHERE COALESCE(user_token,'')<>''`
      ))
    }
    const cancelledValues = "'已取消','cancelled','canceled','已关闭','closed','已作废','void'"
    if (orderColumns.has("transaction_id") && orderColumns.has("paid_at")) {
      results.push(await metric(
        "cancelled_or_closed_with_payment_fact",
        `SELECT COUNT(*) count, COALESCE(SUM(amount),0) amount,
                MIN(created_at) earliest, MAX(created_at) latest, MIN(id) example_id
         FROM orders
         WHERE LOWER(COALESCE(status,'')) IN (${cancelledValues})
           AND (COALESCE(transaction_id,'')<>'' OR paid_at IS NOT NULL)`
      ))
    }
    if (orderColumns.has("refund_status")) {
      results.push(await metric(
        "refunded_orders_showing_paid_again",
        `SELECT COUNT(*) count, COALESCE(SUM(amount),0) amount,
                MIN(created_at) earliest, MAX(created_at) latest, MIN(id) example_id
         FROM orders
         WHERE LOWER(COALESCE(refund_status,'')) IN ('退款成功','refunded','success')
           AND LOWER(COALESCE(payment_status,'')) IN ('已支付','paid','success')`
      ))
    }
    if (orderColumns.has("pickup_code")) {
      const [rows] = await pool.query(
        `SELECT
           COUNT(*) total,
           SUM(CASE WHEN pickup_code REGEXP '^[A-Z0-9]{6}$' THEN 1 ELSE 0 END) uppercase_alnum,
           SUM(CASE WHEN pickup_code REGEXP '[a-z]' THEN 1 ELSE 0 END) lowercase_count,
           SUM(CASE WHEN pickup_code REGEXP '[^A-Za-z0-9]' OR CHAR_LENGTH(pickup_code)<>6 THEN 1 ELSE 0 END) nonstandard_count,
           COUNT(*)-COUNT(DISTINCT UPPER(pickup_code)) duplicate_case_insensitive
         FROM orders WHERE COALESCE(pickup_code,'')<>''`
      )
      results.push({ name: "pickup_code_character_set", ...(rows[0] || {}) })
    }
  }

  if (await exists("store_settlement_records", ["order_id", "store_id", "type", "status"])) {
    results.push(await metric(
      "duplicate_store_finance_business_keys",
      `SELECT COUNT(*) count, MIN(example_id) example_id
       FROM (
         SELECT MIN(id) example_id
         FROM store_settlement_records
         WHERE type<>'chargeback'
         GROUP BY order_id, store_id, type
         HAVING COUNT(*)>1
       ) duplicated`
    ))
    results.push(await metric(
      "financial_state_timestamp_inconsistency",
      `SELECT COUNT(*) count, MIN(created_at) earliest, MAX(created_at) latest, MIN(id) example_id
       FROM store_settlement_records
       WHERE (status='settled' AND settled_at IS NULL)
          OR (status IN ('pending_confirm','unsettled') AND settled_at IS NOT NULL)`
    ))
    if (hasOrders && orderColumns.has("refund_status")) {
      results.push(await metric(
        "settled_store_income_missing_chargeback_after_refund",
        `SELECT COUNT(*) count, COALESCE(SUM(ABS(s.amount)),0) amount,
                MIN(s.created_at) earliest, MAX(s.created_at) latest, MIN(s.order_id) example_id
         FROM store_settlement_records s
         JOIN orders o ON o.id=s.order_id
         LEFT JOIN store_settlement_records c
           ON c.related_record_id=s.id AND (c.type='chargeback' OR c.amount<0)
         WHERE s.status='settled'
           AND s.amount>0
           AND LOWER(COALESCE(o.refund_status,'')) IN ('退款成功','refunded','success')
           AND c.id IS NULL`
      ))
    }
  }

  if (await exists("order_idempotency_keys", ["request_key"])) {
    const idempotencyColumns = await columns("order_idempotency_keys")
    results.push({
      name: "idempotency_schema",
      scopedByUser: idempotencyColumns.has("user_id"),
      hashesRequest: idempotencyColumns.has("request_hash"),
      operationScoped: idempotencyColumns.has("operation")
    })
  }

  if (await exists("refund_records", ["order_id"])) {
    const hasRefundItems = await exists("refund_items", ["refund_record_id", "order_item_id"])
    results.push(await metric(
      "refund_records_without_item_details",
      hasRefundItems
        ? `SELECT COUNT(*) count, MIN(r.created_at) earliest, MAX(r.created_at) latest, MIN(r.order_id) example_id
           FROM refund_records r
           LEFT JOIN refund_items i ON i.refund_record_id=r.id
           WHERE i.refund_record_id IS NULL`
        : `SELECT COUNT(*) count, MIN(created_at) earliest, MAX(created_at) latest, MIN(order_id) example_id
           FROM refund_records`
    ))
  }

  if (await exists("promotion_relations", ["invitee_user_id", "inviter_user_id"])) {
    results.push(await metric(
      "invalid_or_duplicate_promotion_relations",
      `SELECT COUNT(*) count, MIN(invitee_user_id) example_id
       FROM promotion_relations
       WHERE invitee_user_id=inviter_user_id
          OR COALESCE(invitee_user_id,'')=''
          OR COALESCE(inviter_user_id,'')=''`
    ))
  }

  if (await exists("order_items", ["order_id", "quantity"])) {
    results.push(await metric(
      "abnormal_order_item_quantity",
      `SELECT COUNT(*) count, MIN(order_id) example_id
       FROM order_items
       WHERE quantity<=0 OR quantity<>FLOOR(quantity) OR quantity>99`
    ))
  }

  if (await exists("products", ["stock", "stock_mode"])) {
    results.push(await metric(
      "negative_finite_inventory",
      `SELECT COUNT(*) count, MIN(id) example_id
       FROM products WHERE UPPER(COALESCE(stock_mode,''))='FINITE' AND stock<0`
    ))
  }

  const [databaseRow] = await pool.query("SELECT DATABASE() current_database, VERSION() mysql_version")
  const report = {
    generatedAt: new Date().toISOString(),
    readOnly: true,
    storage: {
      mode: "mysql",
      databaseConfigured: !!databaseRow[0]?.current_database,
      mysqlVersion: databaseRow[0]?.mysql_version || ""
    },
    dependencies: {
      node: process.version,
      mysql2: require("mysql2/package.json").version
    },
    results
  }
  console.log(JSON.stringify(report, null, 2))
  await pool.end()
}

main().catch(error => {
  console.error(JSON.stringify({
    ok: false,
    message: String(error.code || error.message).slice(0, 160)
  }))
  process.exit(1)
})
