const assert = require("assert")
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

async function main() {
  loadEnv(path.join(__dirname, "..", ".env"))
  const pool = mysql.createPool({
    host: process.env.MYSQL_HOST || "127.0.0.1",
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE || "very_simple_custom",
    namedPlaceholders: true,
    connectionLimit: 3
  })
  const orderId = `WECOMTEST${Date.now()}`.slice(0, 32)
  try {
    const insertSql = `INSERT IGNORE INTO order_notification_records
      (order_id, notification_type, status, attempt_count, next_retry_at, created_at, updated_at)
      VALUES (:orderId, 'WECOM_ORDER_PAID', 'PENDING', 0, NOW(), NOW(), NOW())`
    const [first] = await pool.query(insertSql, { orderId })
    const [duplicate] = await pool.query(insertSql, { orderId })
    assert.strictEqual(Number(first.affectedRows), 1)
    assert.strictEqual(Number(duplicate.affectedRows), 0)

    const [[record]] = await pool.query(
      "SELECT id FROM order_notification_records WHERE order_id = :orderId AND notification_type = 'WECOM_ORDER_PAID'",
      { orderId }
    )
    const claimSql = `UPDATE order_notification_records
      SET status = 'PROCESSING', attempt_count = attempt_count + 1, updated_at = NOW()
      WHERE id = :id
        AND status IN ('PENDING', 'RETRY')
        AND (next_retry_at IS NULL OR next_retry_at <= NOW())
        AND attempt_count < 4`
    const claims = await Promise.all([
      pool.query(claimSql, { id: record.id }),
      pool.query(claimSql, { id: record.id })
    ])
    assert.strictEqual(claims.reduce((sum, result) => sum + Number(result[0].affectedRows || 0), 0), 1)

    console.log(JSON.stringify({
      ok: true,
      uniqueConstraintVerified: true,
      concurrentClaimVerified: true
    }, null, 2))
  } finally {
    await pool.query(
      "DELETE FROM order_notification_records WHERE order_id = :orderId AND notification_type = 'WECOM_ORDER_PAID'",
      { orderId }
    ).catch(() => {})
    await pool.end()
  }
}

main().catch(error => {
  console.error(error.message)
  process.exit(1)
})
