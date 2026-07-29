"use strict"

const assert = require("assert")
const crypto = require("crypto")
const mysql = require("mysql2/promise")
const { releaseOrderInventory } = require("../cms/inventory-ledger")
const { claimPickupCode } = require("../cms/pickup-security")
const { markOrderPaidAndEnqueue } = require("../cms/wecom-order-outbox")

function safeIdentifier(value) {
  const text = String(value || "")
  if (!/^vsc_security_test_[a-z0-9_]+$/i.test(text)) {
    throw new Error("MYSQL_TEST_DATABASE 必须使用 vsc_security_test_ 前缀")
  }
  return text
}

async function withTransaction(pool, work) {
  const connection = await pool.getConnection()
  try {
    await connection.beginTransaction()
    const result = await work(connection)
    await connection.commit()
    return result
  } catch (error) {
    await connection.rollback().catch(() => {})
    throw error
  } finally {
    connection.release()
  }
}

async function main() {
  const database = safeIdentifier(
    process.env.MYSQL_TEST_DATABASE ||
    `vsc_security_test_${Date.now()}_${crypto.randomBytes(2).toString("hex")}`
  )
  if (!process.env.MYSQL_USER) throw new Error("缺少 MYSQL_USER，未运行 MySQL 并发测试")
  const baseConfig = {
    host: process.env.MYSQL_HOST || "127.0.0.1",
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD || "",
    namedPlaceholders: true,
    connectionLimit: 8,
    dateStrings: true
  }
  const admin = await mysql.createConnection(baseConfig)
  let pool
  try {
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`)
    pool = mysql.createPool({ ...baseConfig, database })
    await pool.query(`CREATE TABLE products (
      id VARCHAR(32) PRIMARY KEY,
      stock INT NOT NULL,
      stock_mode VARCHAR(30) NOT NULL,
      inventory_version INT NOT NULL DEFAULT 0
    )`)
    await pool.query(`CREATE TABLE orders (
      id VARCHAR(32) PRIMARY KEY,
      status VARCHAR(30),
      payment_status VARCHAR(30),
      refund_status VARCHAR(30),
      after_sales_status VARCHAR(30),
      transaction_id VARCHAR(80),
      paid_at DATETIME
    )`)
    await pool.query(`CREATE TABLE order_items (
      id VARCHAR(60) PRIMARY KEY,
      order_id VARCHAR(32),
      product_id VARCHAR(32),
      quantity INT,
      inventory_mode VARCHAR(30)
    )`)
    await pool.query(`CREATE TABLE order_inventory_releases (
      order_item_id VARCHAR(60) PRIMARY KEY,
      order_id VARCHAR(32),
      product_id VARCHAR(32),
      quantity INT,
      reason VARCHAR(120),
      created_at DATETIME
    )`)
    await pool.query(`CREATE TABLE pickup_code_claims (
      code VARCHAR(20) PRIMARY KEY,
      order_id VARCHAR(40) UNIQUE,
      created_at DATETIME
    )`)
    await pool.query(`CREATE TABLE order_payment_facts (
      id VARCHAR(64) PRIMARY KEY,
      order_id VARCHAR(32),
      transaction_id VARCHAR(80) UNIQUE,
      payment_state VARCHAR(30),
      amount_verified TINYINT,
      verified_at DATETIME,
      created_at DATETIME
    )`)
    await pool.query(`CREATE TABLE order_state_audit (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      order_id VARCHAR(32),
      old_order_status VARCHAR(30),
      new_order_status VARCHAR(30),
      action_source VARCHAR(60),
      reason VARCHAR(255),
      operator_id VARCHAR(80),
      created_at DATETIME
    )`)
    await pool.query(`CREATE TABLE order_notification_records (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      order_id VARCHAR(32),
      notification_type VARCHAR(50),
      status VARCHAR(30),
      attempt_count INT,
      next_retry_at DATETIME,
      created_at DATETIME,
      updated_at DATETIME,
      UNIQUE KEY uniq_notification (order_id, notification_type)
    )`)
    await pool.query(`CREATE TABLE order_idempotency_keys (
      user_id VARCHAR(80),
      operation VARCHAR(40),
      request_key VARCHAR(100),
      request_hash CHAR(64),
      order_id VARCHAR(32),
      UNIQUE KEY uniq_scope (user_id, operation, request_key)
    )`)
    await pool.query(`CREATE TABLE finance_records (
      id VARCHAR(60) PRIMARY KEY,
      business_key VARCHAR(180) UNIQUE,
      status VARCHAR(30),
      amount_cents INT,
      related_record_id VARCHAR(60)
    )`)
    await pool.query(`CREATE TABLE promotion_relations (
      invitee_user_id VARCHAR(80) PRIMARY KEY,
      inviter_user_id VARCHAR(80)
    )`)

    await pool.query("INSERT INTO products VALUES ('P1', 5, 'FINITE', 0)")
    const purchase = () => withTransaction(pool, async connection => {
      const [rows] = await connection.query("SELECT stock FROM products WHERE id='P1' FOR UPDATE")
      if (Number(rows[0].stock) < 4) return false
      await connection.query(
        "UPDATE products SET stock=stock-4, inventory_version=inventory_version+1 WHERE id='P1' AND stock>=4"
      )
      return true
    })
    const purchaseResults = await Promise.all([purchase(), purchase()])
    assert.strictEqual(purchaseResults.filter(Boolean).length, 1)
    const [[stockRow]] = await pool.query("SELECT stock FROM products WHERE id='P1'")
    assert.strictEqual(Number(stockRow.stock), 1)
    const [staleAdminSave] = await pool.query(
      "UPDATE products SET stock=5, inventory_version=inventory_version+1 WHERE id='P1' AND inventory_version=0"
    )
    assert.strictEqual(Number(staleAdminSave.affectedRows), 0)

    await pool.query("INSERT INTO order_items VALUES ('OI1','O-STOCK','P1',4,'FINITE')")
    const release = () => withTransaction(pool, connection =>
      releaseOrderInventory(connection, "O-STOCK", "test cancellation")
    )
    const releaseResults = await Promise.all([release(), release()])
    assert.strictEqual(releaseResults.reduce((sum, item) => sum + item.releasedQuantity, 0), 4)
    const [[restoredStock]] = await pool.query("SELECT stock FROM products WHERE id='P1'")
    assert.strictEqual(Number(restoredStock.stock), 5)

    await pool.query(
      "INSERT INTO order_idempotency_keys VALUES ('U1','CREATE_ORDER','SAME','A','O1')"
    )
    await pool.query(
      "INSERT INTO order_idempotency_keys VALUES ('U2','CREATE_ORDER','SAME','B','O2')"
    )
    await assert.rejects(
      () => pool.query("INSERT INTO order_idempotency_keys VALUES ('U1','CREATE_ORDER','SAME','C','O3')"),
      error => error.code === "ER_DUP_ENTRY"
    )

    const pickupConnection = await pool.getConnection()
    try {
      const first = { id: "OP1", deliveryType: "pickup", pickupCode: "ABC234" }
      const second = { id: "OP2", deliveryType: "pickup", pickupCode: "ABC234" }
      await claimPickupCode(pickupConnection, first)
      await claimPickupCode(pickupConnection, second)
      assert.notStrictEqual(first.pickupCode, second.pickupCode)
    } finally {
      pickupConnection.release()
    }

    await pool.query("INSERT INTO orders (id,status,payment_status) VALUES ('PAY1','待支付','待支付')")
    const callbacks = await Promise.all([
      markOrderPaidAndEnqueue({
        pool,
        orderId: "PAY1",
        transactionId: "TX1",
        notificationType: "WECOM_ORDER_PAID"
      }),
      markOrderPaidAndEnqueue({
        pool,
        orderId: "PAY1",
        transactionId: "TX1",
        notificationType: "WECOM_ORDER_PAID"
      })
    ])
    assert.strictEqual(callbacks.filter(result => result.updated).length, 1)
    const [[notificationCount]] = await pool.query(
      "SELECT COUNT(*) count FROM order_notification_records WHERE order_id='PAY1'"
    )
    assert.strictEqual(Number(notificationCount.count), 1)

    await pool.query("INSERT INTO finance_records VALUES ('F1','O1:STORE1:referral','unsettled',500,NULL)")
    const settle = () => pool.query(
      "UPDATE finance_records SET status='settled' WHERE id='F1' AND status='unsettled'"
    )
    const settled = await Promise.all([settle(), settle()])
    assert.strictEqual(settled.reduce((sum, [result]) => sum + Number(result.affectedRows), 0), 1)
    await Promise.all([
      pool.query("INSERT IGNORE INTO finance_records VALUES ('FC1','chargeback:F1:R1','unsettled',-200,'F1')"),
      pool.query("INSERT IGNORE INTO finance_records VALUES ('FC2','chargeback:F1:R1','unsettled',-200,'F1')")
    ])
    const [[chargebackCount]] = await pool.query(
      "SELECT COUNT(*) count FROM finance_records WHERE business_key='chargeback:F1:R1'"
    )
    assert.strictEqual(Number(chargebackCount.count), 1)

    await Promise.all([
      pool.query("INSERT IGNORE INTO promotion_relations VALUES ('U3','U1')"),
      pool.query("INSERT IGNORE INTO promotion_relations VALUES ('U3','U2')")
    ])
    const [[relationCount]] = await pool.query(
      "SELECT COUNT(*) count FROM promotion_relations WHERE invitee_user_id='U3'"
    )
    assert.strictEqual(Number(relationCount.count), 1)

    console.log(JSON.stringify({
      ok: true,
      isolatedDatabase: true,
      finiteInventoryNoOversell: true,
      inventoryReleaseIdempotent: true,
      idempotencyScopedByUser: true,
      pickupCollisionRetried: true,
      concurrentPaymentCallbackIdempotent: true,
      concurrentSettlementClaimedOnce: true,
      chargebackBusinessKeyUnique: true,
      promotionInviteeUnique: true
    }, null, 2))
  } finally {
    if (pool) await pool.end().catch(() => {})
    await admin.query(`DROP DATABASE IF EXISTS \`${database}\``).catch(() => {})
    await admin.end().catch(() => {})
  }
}

main().catch(error => {
  console.error(error.message)
  process.exit(1)
})
