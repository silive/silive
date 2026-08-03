"use strict"

const assert = require("assert")
const fs = require("fs")
const path = require("path")
const mysql = require("mysql2/promise")
const { releaseOrderInventory, releaseOrderItemInventory } = require("../cms/inventory-ledger")
const {
  claimDueOrderPaymentTimeoutJobs,
  closeOrderForPaymentTimeout,
  enqueueOrderPaymentTimeout,
  failOrderPaymentTimeoutJob
} = require("../cms/order-payment-timeout")
const { claimPickupCode } = require("../cms/pickup-security")
const { markOrderPaidAndEnqueue } = require("../cms/wecom-order-outbox")
const {
  PAYMENT_FINANCE_EVENT_TYPE,
  claimDuePaymentFinanceEvents,
  completePaymentFinanceEvent,
  enqueuePaymentFinanceEvent,
  failPaymentFinanceEvent
} = require("../cms/payment-finance-outbox")
const { isPickupServiceFeeEligible } = require("../cms/pickup-service-fee")

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

async function assertProjectSchema(pool) {
  const requiredTables = [
    "products", "orders", "order_items", "order_payment_facts", "payment_finance_outbox",
    "order_payment_timeout_jobs", "order_inventory_releases", "order_inventory_release_events",
    "order_inventory_reservations", "refund_records", "refund_items", "promotion_relations",
    "promotion_relation_claims", "pickup_code_claims", "order_idempotency_keys",
    "reward_records", "store_settlement_records", "sales_agent_commissions"
  ]
  const [rows] = await pool.query(
    `SELECT table_name AS table_name FROM information_schema.tables
     WHERE table_schema=DATABASE() AND table_name IN (${requiredTables.map(() => "?").join(",")})`,
    requiredTables
  )
  const found = new Set(rows.map(row => row.table_name))
  const missing = requiredTables.filter(table => !found.has(table))
  if (missing.length) {
    throw new Error(`隔离库未使用项目完整初始化，缺少表：${missing.join(",")}`)
  }
}

async function insertProduct(pool, { id, stock, stockMode = "FINITE" }) {
  await pool.query(
    `INSERT INTO products
      (id, name, price, status, stock, stock_mode, inventory_version)
     VALUES (:id, :name, 1.00, 'on', :stock, :stockMode, 0)`,
    { id, name: `测试商品 ${id}`, stock, stockMode }
  )
}

async function insertOrder(pool, options = {}) {
  const id = String(options.id || "")
  await pool.query(
    `INSERT INTO orders
      (id, customer_name, product_name, amount, status, payment_status, refund_status,
       payment_expires_at, stock_reserved_at, created_at)
     VALUES
      (:id, '隔离验收客户', '隔离验收商品', 1.00, :status, :paymentStatus, :refundStatus,
       :paymentExpiresAt, :stockReservedAt, NOW())`,
    {
      id,
      status: options.status || "待支付",
      paymentStatus: options.paymentStatus || "待支付",
      refundStatus: options.refundStatus || null,
      paymentExpiresAt: options.paymentExpiresAt || null,
      stockReservedAt: options.stockReservedAt || null
    }
  )
}

async function insertOrderItem(pool, { id, orderId, productId, quantity, inventoryMode = "FINITE" }) {
  await pool.query(
    `INSERT INTO order_items
      (id, order_id, product_id, product_name, unit_price_cents, quantity, paid_amount_cents, inventory_mode)
     VALUES (:id, :orderId, :productId, :productName, 100, :quantity, :paidAmountCents, :inventoryMode)`,
    { id, orderId, productId, productName: `测试商品 ${productId}`, quantity, paidAmountCents: quantity * 100, inventoryMode }
  )
}

async function postJson(baseUrl, pathname, body, headers = {}) {
  const response = await fetch(new URL(pathname, baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body)
  })
  const payload = await response.json().catch(() => ({}))
  return { status: response.status, payload }
}

async function createMockSession(baseUrl) {
  const openid = await postJson(baseUrl, "/api/wechat/openid", { code: "isolated-acceptance" })
  assert.strictEqual(openid.status, 200, "隔离服务 mock openid 登录失败")
  const token = String(openid.payload.userSession || openid.payload.userToken || "")
  assert(token, "隔离服务未返回测试会话")
  return token
}

async function runCreateOrderConcurrencyAcceptance(pool, baseUrl) {
  const token = await createMockSession(baseUrl)
  const headers = { "x-user-session": token }
  await insertProduct(pool, { id: "P-API-SINGLE", stock: 1 })
  const requests = await Promise.all(Array.from({ length: 20 }, (_, index) =>
    postJson(baseUrl, "/api/orders", {
      productId: "P-API-SINGLE",
      quantity: 1,
      customerName: "隔离验收客户",
      deliveryType: "delivery",
      requestKey: `api-single-${index}`
    }, headers)
  ))
  assert.strictEqual(requests.filter(result => result.status === 200).length, 1, "库存为1时只允许一个真实订单创建成功")
  assert.strictEqual(requests.filter(result => result.status === 409).length, 19, "库存不足必须由订单接口返回409")
  const [[singleProduct]] = await pool.query("SELECT stock FROM products WHERE id='P-API-SINGLE'")
  const [[singleOrders]] = await pool.query("SELECT COUNT(*) count FROM order_items WHERE product_id='P-API-SINGLE'")
  const [[singleReservations]] = await pool.query("SELECT COUNT(*) count FROM order_inventory_reservations WHERE product_id='P-API-SINGLE'")
  assert.strictEqual(Number(singleProduct.stock), 0)
  assert.strictEqual(Number(singleOrders.count), 1)
  assert.strictEqual(Number(singleReservations.count), 1)

  await insertProduct(pool, { id: "P-API-FIVE", stock: 5 })
  const fiveRequests = await Promise.all(Array.from({ length: 20 }, (_, index) =>
    postJson(baseUrl, "/api/orders", {
      productId: "P-API-FIVE",
      quantity: 1,
      customerName: "隔离验收客户",
      deliveryType: "delivery",
      requestKey: `api-five-${index}`
    }, headers)
  ))
  assert.strictEqual(fiveRequests.filter(result => result.status === 200).length, 5, "库存为5时最多只能成功创建5个订单")
  const [[fiveProduct]] = await pool.query("SELECT stock FROM products WHERE id='P-API-FIVE'")
  assert.strictEqual(Number(fiveProduct.stock), 0)

  await insertProduct(pool, { id: "P-API-CART-A", stock: 1 })
  await insertProduct(pool, { id: "P-API-CART-B", stock: 0 })
  const mixedCart = await postJson(baseUrl, "/api/orders", {
    productId: "CART_ORDER",
    cartItems: [{ id: "P-API-CART-A", quantity: 1 }, { id: "P-API-CART-B", quantity: 1 }],
    customerName: "隔离验收客户",
    deliveryType: "delivery",
    requestKey: "api-cart-rollback"
  }, headers)
  assert.strictEqual(mixedCart.status, 409, "多商品任一库存不足必须整体回滚")
  const [[cartA]] = await pool.query("SELECT stock FROM products WHERE id='P-API-CART-A'")
  const [[cartOrders]] = await pool.query("SELECT COUNT(*) count FROM order_items WHERE product_id IN ('P-API-CART-A','P-API-CART-B')")
  assert.strictEqual(Number(cartA.stock), 1)
  assert.strictEqual(Number(cartOrders.count), 0)
}

async function main() {
  if (process.env.MYSQL_TEST_SKIP_DOTENV !== "true") loadEnv(path.join(__dirname, "..", ".env"))
  if (String(process.env.NODE_ENV || "").toLowerCase() === "production") {
    throw new Error("安全拒绝：不能在生产环境运行 MySQL 并发测试")
  }
  if (!process.env.MYSQL_TEST_DATABASE) {
    throw new Error("缺少 MYSQL_TEST_DATABASE，未运行 MySQL 并发测试")
  }
  const database = safeIdentifier(process.env.MYSQL_TEST_DATABASE)
  if (!process.env.MYSQL_USER) throw new Error("缺少 MYSQL_USER，未运行 MySQL 并发测试")
  const host = String(process.env.MYSQL_HOST || "127.0.0.1").trim()
  if (!/^(localhost|127\.0\.0\.1|::1)$/i.test(host)) {
    throw new Error("安全拒绝：隔离 MySQL 测试只允许回环地址")
  }
  const baseConfig = {
    host,
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD || "",
    namedPlaceholders: true,
    connectionLimit: 8,
    dateStrings: true
  }
  if (process.env.MYSQL_TEST_SCHEMA_INITIALIZED !== "true") {
    throw new Error("缺少 MYSQL_TEST_SCHEMA_INITIALIZED=true；必须先使用 cms/server.js 初始化隔离测试库")
  }
  const httpBaseUrl = String(process.env.MYSQL_TEST_HTTP_BASE_URL || "").trim()
  if (!/^http:\/\/127\.0\.0\.1:\d+\/?$/i.test(httpBaseUrl)) {
    throw new Error("MYSQL_TEST_HTTP_BASE_URL 必须是隔离服务的 http://127.0.0.1:<port>")
  }
  const pool = mysql.createPool({ ...baseConfig, database })
  try {
    await assertProjectSchema(pool)
    await runCreateOrderConcurrencyAcceptance(pool, httpBaseUrl)
    await insertProduct(pool, { id: "P1", stock: 5 })
    const purchase = () => withTransaction(pool, async connection => {
      const [rows] = await connection.query("SELECT stock FROM products WHERE id='P1' FOR UPDATE")
      if (Number(rows[0].stock) < 4) return false
      await connection.query(
        "UPDATE products SET stock=stock-4, inventory_version=inventory_version+1 WHERE id='P1' AND stock>=4"
      )
      return true
    })
    const purchaseResults = await Promise.all(Array.from({ length: 20 }, () => purchase()))
    assert.strictEqual(purchaseResults.filter(Boolean).length, 1)
    const [[stockRow]] = await pool.query("SELECT stock FROM products WHERE id='P1'")
    assert.strictEqual(Number(stockRow.stock), 1)
    const [staleAdminSave] = await pool.query(
      "UPDATE products SET stock=5, inventory_version=inventory_version+1 WHERE id='P1' AND inventory_version=0"
    )
    assert.strictEqual(Number(staleAdminSave.affectedRows), 0)

    await insertOrderItem(pool, { id: "OI1", orderId: "O-STOCK", productId: "P1", quantity: 4 })
    const release = () => withTransaction(pool, connection =>
      releaseOrderInventory(connection, "O-STOCK", "test cancellation")
    )
    const releaseResults = await Promise.all([release(), release()])
    assert.strictEqual(releaseResults.reduce((sum, item) => sum + item.releasedQuantity, 0), 4)
    const [[restoredStock]] = await pool.query("SELECT stock FROM products WHERE id='P1'")
    assert.strictEqual(Number(restoredStock.stock), 5)

    await insertProduct(pool, { id: "P-UNLIMITED", stock: 7, stockMode: "UNLIMITED" })
    await insertProduct(pool, { id: "P-MADE", stock: 9, stockMode: "MADE_TO_ORDER" })
    await insertOrderItem(pool, { id: "OI-UNLIMITED", orderId: "O-UNLIMITED", productId: "P-UNLIMITED", quantity: 2, inventoryMode: "UNLIMITED" })
    await insertOrderItem(pool, { id: "OI-MADE", orderId: "O-MADE", productId: "P-MADE", quantity: 3, inventoryMode: "MADE_TO_ORDER" })
    const skippedUnlimited = await withTransaction(pool, connection => releaseOrderInventory(connection, "O-UNLIMITED", "timeout skipped unlimited"))
    const skippedMadeToOrder = await withTransaction(pool, connection => releaseOrderInventory(connection, "O-MADE", "timeout skipped made to order"))
    const [[unlimitedStock]] = await pool.query("SELECT stock FROM products WHERE id='P-UNLIMITED'")
    const [[madeToOrderStock]] = await pool.query("SELECT stock FROM products WHERE id='P-MADE'")
    assert.strictEqual(skippedUnlimited.releasedQuantity, 0)
    assert.strictEqual(skippedMadeToOrder.releasedQuantity, 0)
    assert.strictEqual(Number(unlimitedStock.stock), 7)
    assert.strictEqual(Number(madeToOrderStock.stock), 9)

    await insertProduct(pool, { id: "P-MULTI-A", stock: 3 })
    await insertProduct(pool, { id: "P-MULTI-B", stock: 4 })
    await insertOrderItem(pool, { id: "OI-MULTI-A", orderId: "O-MULTI", productId: "P-MULTI-A", quantity: 2 })
    await insertOrderItem(pool, { id: "OI-MULTI-B", orderId: "O-MULTI", productId: "P-MULTI-B", quantity: 3 })
    const multiRelease = await withTransaction(pool, connection => releaseOrderInventory(connection, "O-MULTI", "multi item timeout"))
    const [[multiStockA]] = await pool.query("SELECT stock FROM products WHERE id='P-MULTI-A'")
    const [[multiStockB]] = await pool.query("SELECT stock FROM products WHERE id='P-MULTI-B'")
    assert.strictEqual(multiRelease.releasedQuantity, 5)
    assert.strictEqual(Number(multiStockA.stock), 5)
    assert.strictEqual(Number(multiStockB.stock), 7)

    await insertProduct(pool, { id: "P-PARTIAL-A", stock: 5 })
    await insertProduct(pool, { id: "P-PARTIAL-B", stock: 2 })
    await insertOrderItem(pool, { id: "OI-PARTIAL-A", orderId: "O-PARTIAL", productId: "P-PARTIAL-A", quantity: 2 })
    await insertOrderItem(pool, { id: "OI-PARTIAL-B", orderId: "O-PARTIAL", productId: "P-PARTIAL-B", quantity: 3 })
    await pool.query(
      `INSERT INTO order_inventory_releases
       (order_item_id, order_id, product_id, quantity, reason, created_at, updated_at)
       VALUES ('OI-PARTIAL-A','O-PARTIAL','P-PARTIAL-A',2,'previous close',NOW(),NOW())`
    )
    await pool.query(
      `INSERT INTO order_inventory_release_events
       (id, business_key, order_item_id, order_id, product_id, quantity, reason, source_type, source_id, created_at)
       VALUES ('EVT-PARTIAL-A-PREV','seed:O-PARTIAL:OI-PARTIAL-A','OI-PARTIAL-A','O-PARTIAL','P-PARTIAL-A',2,'previous close','seed','O-PARTIAL',NOW())`
    )
    const partialRelease = await withTransaction(pool, connection => releaseOrderInventory(connection, "O-PARTIAL", "retry partial release"))
    const [[partialStockA]] = await pool.query("SELECT stock FROM products WHERE id='P-PARTIAL-A'")
    const [[partialStockB]] = await pool.query("SELECT stock FROM products WHERE id='P-PARTIAL-B'")
    assert.strictEqual(partialRelease.releasedQuantity, 3)
    assert.strictEqual(Number(partialStockA.stock), 5)
    assert.strictEqual(Number(partialStockB.stock), 5)

    await insertProduct(pool, { id: "P-REFUND-PARTIAL", stock: 0 })
    await insertOrderItem(pool, { id: "OI-REFUND-PARTIAL", orderId: "O-REFUND-PARTIAL", productId: "P-REFUND-PARTIAL", quantity: 5 })
    const partialRefundOne = await withTransaction(pool, connection => releaseOrderItemInventory(connection, {
      orderItemId: "OI-REFUND-PARTIAL",
      requestedQuantity: 2,
      businessKey: "refund:RF-1:RI-1:OI-REFUND-PARTIAL",
      reason: "部分退款",
      sourceType: "partial_refund",
      sourceId: "RF-1"
    }))
    const duplicatePartialRefundOne = await withTransaction(pool, connection => releaseOrderItemInventory(connection, {
      orderItemId: "OI-REFUND-PARTIAL",
      requestedQuantity: 2,
      businessKey: "refund:RF-1:RI-1:OI-REFUND-PARTIAL",
      reason: "部分退款",
      sourceType: "partial_refund",
      sourceId: "RF-1"
    }))
    const partialRefundTwo = await withTransaction(pool, connection => releaseOrderItemInventory(connection, {
      orderItemId: "OI-REFUND-PARTIAL",
      requestedQuantity: 1,
      businessKey: "refund:RF-2:RI-2:OI-REFUND-PARTIAL",
      reason: "部分退款",
      sourceType: "partial_refund",
      sourceId: "RF-2"
    }))
    assert.strictEqual(partialRefundOne.releasedQuantity, 2)
    assert.strictEqual(duplicatePartialRefundOne.releasedQuantity, 0)
    assert.strictEqual(partialRefundTwo.releasedQuantity, 1)
    const finalRefundRelease = await withTransaction(pool, connection => releaseOrderInventory(connection, "O-REFUND-PARTIAL", {
      reason: "订单全额退款",
      sourceType: "full_refund",
      sourceId: "RF-3",
      releaseRemaining: true
    }))
    assert.strictEqual(finalRefundRelease.releasedQuantity, 2)
    const [[partialRefundStock]] = await pool.query("SELECT stock FROM products WHERE id='P-REFUND-PARTIAL'")
    const [[partialRefundAccumulator]] = await pool.query("SELECT quantity FROM order_inventory_releases WHERE order_item_id='OI-REFUND-PARTIAL'")
    const [[partialRefundEvents]] = await pool.query("SELECT COUNT(*) count FROM order_inventory_release_events WHERE order_item_id='OI-REFUND-PARTIAL'")
    assert.strictEqual(Number(partialRefundStock.stock), 5)
    assert.strictEqual(Number(partialRefundAccumulator.quantity), 5)
    assert.strictEqual(Number(partialRefundEvents.count), 3)
    await assert.rejects(
      () => withTransaction(pool, connection => releaseOrderItemInventory(connection, {
        orderItemId: "OI-REFUND-PARTIAL",
        requestedQuantity: 1,
        businessKey: "refund:RF-4:RI-4:OI-REFUND-PARTIAL",
        reason: "超出剩余数量",
        sourceType: "partial_refund",
        sourceId: "RF-4"
      })),
      error => error.statusCode === 409
    )

    await insertProduct(pool, { id: "P-REFUND-RACE", stock: 0 })
    await insertOrderItem(pool, { id: "OI-REFUND-RACE", orderId: "O-REFUND-RACE", productId: "P-REFUND-RACE", quantity: 5 })
    const releaseRefundRace = (refundId, quantity) => withTransaction(pool, connection => releaseOrderItemInventory(connection, {
      orderItemId: "OI-REFUND-RACE",
      requestedQuantity: quantity,
      businessKey: `refund:${refundId}:RI-${refundId}:OI-REFUND-RACE`,
      reason: "并发部分退款",
      sourceType: "partial_refund",
      sourceId: refundId
    }))
    const refundRaceResults = await Promise.all([releaseRefundRace("RF-RACE-1", 2), releaseRefundRace("RF-RACE-2", 2)])
    assert.strictEqual(refundRaceResults.reduce((sum, result) => sum + result.releasedQuantity, 0), 4)
    const [[refundRaceStock]] = await pool.query("SELECT stock FROM products WHERE id='P-REFUND-RACE'")
    const [[refundRaceAccumulator]] = await pool.query("SELECT quantity FROM order_inventory_releases WHERE order_item_id='OI-REFUND-RACE'")
    assert.strictEqual(Number(refundRaceStock.stock), 4)
    assert.strictEqual(Number(refundRaceAccumulator.quantity), 4)

    await insertProduct(pool, { id: "P-REFUND-DUPLICATE", stock: 0 })
    await insertOrderItem(pool, { id: "OI-REFUND-DUPLICATE", orderId: "O-REFUND-DUPLICATE", productId: "P-REFUND-DUPLICATE", quantity: 5 })
    const sameRefundNotification = () => withTransaction(pool, connection => releaseOrderItemInventory(connection, {
      orderItemId: "OI-REFUND-DUPLICATE",
      requestedQuantity: 2,
      businessKey: "refund:RF-DUP:RI-DUP:OI-REFUND-DUPLICATE",
      reason: "重复退款通知",
      sourceType: "partial_refund",
      sourceId: "RF-DUP"
    }))
    const duplicateRefundResults = await Promise.all(Array.from({ length: 20 }, sameRefundNotification))
    assert.strictEqual(duplicateRefundResults.reduce((sum, result) => sum + result.releasedQuantity, 0), 2)
    const [[duplicateRefundStock]] = await pool.query("SELECT stock FROM products WHERE id='P-REFUND-DUPLICATE'")
    const [[duplicateRefundEvents]] = await pool.query("SELECT COUNT(*) count FROM order_inventory_release_events WHERE order_item_id='OI-REFUND-DUPLICATE'")
    assert.strictEqual(Number(duplicateRefundStock.stock), 2)
    assert.strictEqual(Number(duplicateRefundEvents.count), 1)

    await insertProduct(pool, { id: "P-REFUND-FULL-RACE", stock: 0 })
    await insertOrderItem(pool, { id: "OI-REFUND-FULL-RACE", orderId: "O-REFUND-FULL-RACE", productId: "P-REFUND-FULL-RACE", quantity: 5 })
    const [partialFullRace, fullRefundRace] = await Promise.allSettled([
      withTransaction(pool, connection => releaseOrderItemInventory(connection, {
        orderItemId: "OI-REFUND-FULL-RACE",
        requestedQuantity: 2,
        businessKey: "refund:RF-FULL-RACE-PARTIAL:RI-1:OI-REFUND-FULL-RACE",
        reason: "部分退款与全额退款竞争",
        sourceType: "partial_refund",
        sourceId: "RF-FULL-RACE-PARTIAL"
      })),
      withTransaction(pool, connection => releaseOrderInventory(connection, "O-REFUND-FULL-RACE", {
        reason: "订单全额退款",
        sourceType: "full_refund",
        sourceId: "RF-FULL-RACE-FULL",
        releaseRemaining: true
      }))
    ])
    assert(["fulfilled", "rejected"].includes(partialFullRace.status))
    assert.strictEqual(fullRefundRace.status, "fulfilled")
    const [[fullRaceStock]] = await pool.query("SELECT stock FROM products WHERE id='P-REFUND-FULL-RACE'")
    const [[fullRaceAccumulator]] = await pool.query("SELECT quantity FROM order_inventory_releases WHERE order_item_id='OI-REFUND-FULL-RACE'")
    assert.strictEqual(Number(fullRaceStock.stock), 5)
    assert.strictEqual(Number(fullRaceAccumulator.quantity), 5)

    await insertProduct(pool, { id: "P-CANCEL-REFUND-RACE", stock: 0 })
    await insertOrderItem(pool, { id: "OI-CANCEL-REFUND-RACE", orderId: "O-CANCEL-REFUND-RACE", productId: "P-CANCEL-REFUND-RACE", quantity: 5 })
    const cancelRefundRace = await Promise.allSettled([
      withTransaction(pool, connection => releaseOrderItemInventory(connection, {
        orderItemId: "OI-CANCEL-REFUND-RACE",
        requestedQuantity: 2,
        businessKey: "refund:RF-CANCEL-RACE:RI-1:OI-CANCEL-REFUND-RACE",
        reason: "部分退款与取消竞争",
        sourceType: "partial_refund",
        sourceId: "RF-CANCEL-RACE"
      })),
      withTransaction(pool, connection => releaseOrderInventory(connection, "O-CANCEL-REFUND-RACE", {
        reason: "用户取消",
        sourceType: "user_cancel",
        sourceId: "O-CANCEL-REFUND-RACE",
        releaseRemaining: true
      }))
    ])
    assert(cancelRefundRace.some(result => result.status === "fulfilled"))
    const [[cancelRefundRaceStock]] = await pool.query("SELECT stock FROM products WHERE id='P-CANCEL-REFUND-RACE'")
    const [[cancelRefundRaceAccumulator]] = await pool.query("SELECT quantity FROM order_inventory_releases WHERE order_item_id='OI-CANCEL-REFUND-RACE'")
    assert.strictEqual(Number(cancelRefundRaceStock.stock), 5)
    assert.strictEqual(Number(cancelRefundRaceAccumulator.quantity), 5)

    await insertProduct(pool, { id: "P-REFUND-ROLLBACK", stock: 0, stockMode: "UNLIMITED" })
    await insertOrderItem(pool, { id: "OI-REFUND-ROLLBACK", orderId: "O-REFUND-ROLLBACK", productId: "P-REFUND-ROLLBACK", quantity: 2 })
    await assert.rejects(
      () => withTransaction(pool, connection => releaseOrderItemInventory(connection, {
        orderItemId: "OI-REFUND-ROLLBACK",
        requestedQuantity: 1,
        businessKey: "refund:RF-ROLLBACK:RI-ROLLBACK:OI-REFUND-ROLLBACK",
        reason: "事务回滚",
        sourceType: "partial_refund",
        sourceId: "RF-ROLLBACK"
      })),
      error => error.statusCode === 409
    )
    const [[inventoryRollbackEvents]] = await pool.query("SELECT COUNT(*) count FROM order_inventory_release_events WHERE order_item_id='OI-REFUND-ROLLBACK'")
    const [[inventoryRollbackAccumulator]] = await pool.query("SELECT COUNT(*) count FROM order_inventory_releases WHERE order_item_id='OI-REFUND-ROLLBACK'")
    assert.strictEqual(Number(inventoryRollbackEvents.count), 0)
    assert.strictEqual(Number(inventoryRollbackAccumulator.count), 0)

    await pool.query(
      `INSERT INTO order_idempotency_keys
        (user_id, operation, request_key, request_hash, order_id, created_at, expires_at)
       VALUES ('U1','CREATE_ORDER','SAME','A','O1',NOW(),DATE_ADD(NOW(), INTERVAL 1 DAY))`
    )
    await pool.query(
      `INSERT INTO order_idempotency_keys
        (user_id, operation, request_key, request_hash, order_id, created_at, expires_at)
       VALUES ('U2','CREATE_ORDER','SAME','B','O2',NOW(),DATE_ADD(NOW(), INTERVAL 1 DAY))`
    )
    await assert.rejects(
      () => pool.query(
        `INSERT INTO order_idempotency_keys
          (user_id, operation, request_key, request_hash, order_id, created_at, expires_at)
         VALUES ('U1','CREATE_ORDER','SAME','C','O3',NOW(),DATE_ADD(NOW(), INTERVAL 1 DAY))`
      ),
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

    await insertOrder(pool, { id: "PAY1" })
    const callbacks = await Promise.all(Array.from({ length: 20 }, () =>
      markOrderPaidAndEnqueue({
        pool,
        orderId: "PAY1",
        transactionId: "TX1",
        notificationType: "WECOM_ORDER_PAID"
      })
    ))
    assert.strictEqual(callbacks.filter(result => result.updated).length, 1)
    const [[notificationCount]] = await pool.query(
      "SELECT COUNT(*) count FROM order_notification_records WHERE order_id='PAY1'"
    )
    assert.strictEqual(Number(notificationCount.count), 1)
    const [[financeEventCount]] = await pool.query(
      "SELECT COUNT(*) count FROM payment_finance_outbox WHERE aggregate_id='PAY1'"
    )
    assert.strictEqual(Number(financeEventCount.count), 1)
    const [[paymentFactCount]] = await pool.query(
      "SELECT COUNT(*) count FROM order_payment_facts WHERE order_id='PAY1'"
    )
    assert.strictEqual(Number(paymentFactCount.count), 1)
    const [[paidOrder]] = await pool.query("SELECT payment_status FROM orders WHERE id='PAY1'")
    assert.strictEqual(paidOrder.payment_status, "已支付")

    await pool.query("CREATE TRIGGER reject_payment_finance_event BEFORE INSERT ON payment_finance_outbox FOR EACH ROW BEGIN IF NEW.aggregate_id='PAYROLL' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='test rollback'; END IF; END")
    await insertOrder(pool, { id: "PAYROLL" })
    await assert.rejects(
      () => markOrderPaidAndEnqueue({ pool, orderId: "PAYROLL", transactionId: "TXROLL" }),
      error => error.code === "ER_SIGNAL_EXCEPTION"
    )
    await pool.query("DROP TRIGGER reject_payment_finance_event")
    const [[rollbackOrder]] = await pool.query("SELECT payment_status FROM orders WHERE id='PAYROLL'")
    assert.strictEqual(rollbackOrder.payment_status, "待支付")
    const [[rollbackFacts]] = await pool.query("SELECT COUNT(*) count FROM order_payment_facts WHERE order_id='PAYROLL'")
    const [[rollbackEvents]] = await pool.query("SELECT COUNT(*) count FROM payment_finance_outbox WHERE aggregate_id='PAYROLL'")
    assert.strictEqual(Number(rollbackFacts.count), 0)
    assert.strictEqual(Number(rollbackEvents.count), 0)

    for (const [id, status, paymentStatus, refundStatus] of [
      ["PAY-CANCEL", "已取消", "待支付", ""],
      ["PAY-REFUNDING", "退款中", "已支付", "退款处理中"],
      ["PAY-REFUNDED", "已退款", "已退款", "退款成功"]
    ]) {
      await insertOrder(pool, { id, status, paymentStatus, refundStatus })
      await markOrderPaidAndEnqueue({ pool, orderId: id, transactionId: `TX-${id}` })
    }
    const [[blockedEventCount]] = await pool.query(
      "SELECT COUNT(*) count FROM payment_finance_outbox WHERE aggregate_id IN ('PAY-CANCEL','PAY-REFUNDING','PAY-REFUNDED')"
    )
    assert.strictEqual(Number(blockedEventCount.count), 0)

    await pool.query("UPDATE payment_finance_outbox SET status='COMPLETED' WHERE aggregate_id='PAY1'")
    const eventConnection = await pool.getConnection()
    try {
      assert.strictEqual(await enqueuePaymentFinanceEvent(eventConnection, { orderId: "CLAIM1", transactionId: "TX-CLAIM" }), true)
    } finally {
      eventConnection.release()
    }
    const [claimsA, claimsB] = await Promise.all([
      claimDuePaymentFinanceEvents({ pool, limit: 10 }),
      claimDuePaymentFinanceEvents({ pool, limit: 10 })
    ])
    const claims = [...claimsA, ...claimsB].filter(record => record.aggregate_id === "CLAIM1")
    assert.strictEqual(claims.length, 1)
    const completionConnection = await pool.getConnection()
    try {
      await completePaymentFinanceEvent(completionConnection, claims[0])
    } finally {
      completionConnection.release()
    }
    const [[completedEvent]] = await pool.query("SELECT status FROM payment_finance_outbox WHERE aggregate_id='CLAIM1'")
    assert.strictEqual(completedEvent.status, "COMPLETED")

    const retryConnection = await pool.getConnection()
    try {
      assert.strictEqual(await enqueuePaymentFinanceEvent(retryConnection, { orderId: "RETRY1", transactionId: "TX-RETRY" }), true)
    } finally {
      retryConnection.release()
    }
    const [retryClaim] = await claimDuePaymentFinanceEvents({ pool, limit: 10 })
    assert.strictEqual(retryClaim.aggregate_id, "RETRY1")
    assert.strictEqual(await failPaymentFinanceEvent({ pool, record: retryClaim, retryMinutes: 1, error: new Error("expected retry") }), true)
    await pool.query("UPDATE payment_finance_outbox SET available_at=DATE_SUB(NOW(), INTERVAL 1 SECOND) WHERE aggregate_id='RETRY1'")
    const [retryClaimAgain] = await claimDuePaymentFinanceEvents({ pool, limit: 10 })
    assert.strictEqual(retryClaimAgain.aggregate_id, "RETRY1")
    await pool.query("UPDATE payment_finance_outbox SET status='PROCESSING', locked_by='expired-lock', locked_at=DATE_SUB(NOW(), INTERVAL 10 MINUTE), available_at=NULL WHERE aggregate_id='RETRY1'")
    const [staleClaim] = await claimDuePaymentFinanceEvents({ pool, limit: 10, lockMinutes: 5 })
    assert.strictEqual(staleClaim.aggregate_id, "RETRY1")

    await Promise.all([
      pool.query(
        `INSERT IGNORE INTO reward_records
          (id, order_id, product_name, level, amount, status, created_at, updated_at, business_key)
         VALUES ('PF1','PAY-FIN','测试商品',1,1.00,'pending_confirm',NOW(),NOW(),'PAY-FIN:personal')`
      ),
      pool.query(
        `INSERT IGNORE INTO reward_records
          (id, order_id, product_name, level, amount, status, created_at, updated_at, business_key)
         VALUES ('PF1D','PAY-FIN','测试商品',1,1.00,'pending_confirm',NOW(),NOW(),'PAY-FIN:personal')`
      ),
      pool.query(
        `INSERT IGNORE INTO store_settlement_records
          (id, store_id, order_id, type, amount, status, created_at, business_key)
         VALUES ('SF1','STORE1','PAY-FIN','store_referral_commission',1.00,'pending_confirm',NOW(),'PAY-FIN:store-referral')`
      ),
      pool.query(
        `INSERT IGNORE INTO store_settlement_records
          (id, store_id, order_id, type, amount, status, created_at, business_key)
         VALUES ('SF1D','STORE1','PAY-FIN','store_referral_commission',1.00,'pending_confirm',NOW(),'PAY-FIN:store-referral')`
      ),
      pool.query(
        `INSERT IGNORE INTO sales_agent_commissions
          (id, business_key, sales_agent_id, store_id, order_id, type, amount, created_at)
         VALUES ('SA1','PAY-FIN:sales','A1','STORE1','PAY-FIN','sales_agent_commission',10.00,NOW())`
      ),
      pool.query(
        `INSERT IGNORE INTO sales_agent_commissions
          (id, business_key, sales_agent_id, store_id, order_id, type, amount, created_at)
         VALUES ('SA1D','PAY-FIN:sales','A1','STORE1','PAY-FIN','sales_agent_commission',10.00,NOW())`
      )
    ])
    const [[rewardEffectCount]] = await pool.query("SELECT COUNT(*) count FROM reward_records WHERE business_key='PAY-FIN:personal'")
    const [[storeEffectCount]] = await pool.query("SELECT COUNT(*) count FROM store_settlement_records WHERE business_key='PAY-FIN:store-referral'")
    const [[salesEffectCount]] = await pool.query("SELECT COUNT(*) count FROM sales_agent_commissions WHERE business_key='PAY-FIN:sales'")
    assert.strictEqual(Number(rewardEffectCount.count), 1)
    assert.strictEqual(Number(storeEffectCount.count), 1)
    assert.strictEqual(Number(salesEffectCount.count), 1)

    const writePickupFee = async (order, operatorStoreId) => {
      if (!isPickupServiceFeeEligible(order) || String(order.pickupStoreId) !== String(operatorStoreId)) return false
      const [result] = await pool.query(
        "INSERT IGNORE INTO store_settlement_records (id,business_key,order_id,store_id,type,amount) VALUES (:id,:businessKey,:orderId,:storeId,'pickup_service_fee',2.00)",
        {
          id: `PIC-${order.id}`,
          businessKey: `${order.id}:${operatorStoreId}:pickup_service_fee`,
          orderId: order.id,
          storeId: operatorStoreId
        }
      )
      return Number(result.affectedRows || 0) === 1
    }
    const pickupOrder = {
      id: "PICKUP-1",
      paymentStatus: "已支付",
      deliveryType: "pickup",
      pickupStoreId: "STORE-A",
      pickupStatus: "arrived_store",
      status: "待自提"
    }
    assert.strictEqual(await writePickupFee(pickupOrder, "STORE-A"), false)
    assert.strictEqual(await writePickupFee({ ...pickupOrder, pickupStatus: "picked_up", pickupVerifiedAt: "2026-08-03 10:00:00", status: "已完成" }, "STORE-B"), false)
    const verifiedPickup = { ...pickupOrder, pickupStatus: "picked_up", pickupVerifiedAt: "2026-08-03 10:00:00", status: "已完成" }
    assert.strictEqual(await writePickupFee(verifiedPickup, "STORE-A"), true)
    assert.strictEqual(await writePickupFee(verifiedPickup, "STORE-A"), false)
    assert.strictEqual(await writePickupFee({ ...pickupOrder, id: "PICKUP-CANCEL", status: "已取消" }, "STORE-A"), false)
    assert.strictEqual(await writePickupFee({ ...verifiedPickup, id: "DELIVERY-1", deliveryType: "delivery" }, "STORE-A"), false)
    await pool.query(
      `INSERT INTO store_settlement_records
        (id, business_key, order_id, store_id, type, amount, status, created_at)
       VALUES ('REF-PICKUP-1','PICKUP-1:STORE-A:store_referral_commission','PICKUP-1','STORE-A','store_referral_commission',3.00,'pending_confirm',NOW())`
    )
    const [[pickupFeeCount]] = await pool.query("SELECT COUNT(*) count FROM store_settlement_records WHERE order_id='PICKUP-1' AND type='pickup_service_fee'")
    const [[distinctStoreTypes]] = await pool.query("SELECT COUNT(DISTINCT type) count FROM store_settlement_records WHERE order_id='PICKUP-1'")
    assert.strictEqual(Number(pickupFeeCount.count), 1)
    assert.strictEqual(Number(distinctStoreTypes.count), 2)

    await pool.query(
      `INSERT INTO reward_records
        (id, order_id, product_name, level, amount, status, created_at, updated_at, business_key)
       VALUES ('F1','O1','测试商品',1,5.00,'unsettled',NOW(),NOW(),'O1:STORE1:referral')`
    )
    const settle = () => pool.query(
      "UPDATE reward_records SET status='settled', settled_at=NOW() WHERE id='F1' AND status='unsettled'"
    )
    const settled = await Promise.all([settle(), settle()])
    assert.strictEqual(settled.reduce((sum, [result]) => sum + Number(result.affectedRows), 0), 1)
    await Promise.all([
      pool.query(
        `INSERT IGNORE INTO reward_records
          (id, order_id, product_name, level, amount, status, created_at, updated_at, business_key, related_record_id)
         VALUES ('FC1','O1','退款扣回',1,-2.00,'chargeback',NOW(),NOW(),'chargeback:F1:R1','F1')`
      ),
      pool.query(
        `INSERT IGNORE INTO reward_records
          (id, order_id, product_name, level, amount, status, created_at, updated_at, business_key, related_record_id)
         VALUES ('FC2','O1','退款扣回',1,-2.00,'chargeback',NOW(),NOW(),'chargeback:F1:R1','F1')`
      )
    ])
    const [[chargebackCount]] = await pool.query(
      "SELECT COUNT(*) count FROM reward_records WHERE business_key='chargeback:F1:R1'"
    )
    assert.strictEqual(Number(chargebackCount.count), 1)

    await pool.query(
      `INSERT INTO promotion_relations
        (id, inviter_phone, inviter_name, inviter_code, invitee_phone, invitee_name, level, created_at)
       VALUES ('PR1','13800000001','邀请人A','PROMO-A','13900000003','被邀请人',1,NOW()),
              ('PR2','13800000002','邀请人B','PROMO-B','13900000003','被邀请人',1,NOW())`
    )
    await Promise.all([
      pool.query("INSERT IGNORE INTO promotion_relation_claims (invitee_phone,relation_id,created_at) VALUES ('13900000003','PR1',NOW())"),
      pool.query("INSERT IGNORE INTO promotion_relation_claims (invitee_phone,relation_id,created_at) VALUES ('13900000003','PR2',NOW())")
    ])
    const [[relationCount]] = await pool.query(
      "SELECT COUNT(*) count FROM promotion_relation_claims WHERE invitee_phone='13900000003'"
    )
    assert.strictEqual(Number(relationCount.count), 1)

    await pool.query(
      `INSERT INTO sales_agent_commissions
        (id, business_key, sales_agent_id, store_id, order_id, type, amount, created_at)
       VALUES ('S1','sales:O1:STORE1:A1','A1','STORE1','O1','sales_agent_commission',10.00,NOW())`
    )
    await Promise.all([
      pool.query(
        `INSERT IGNORE INTO sales_agent_commissions
          (id, business_key, sales_agent_id, store_id, order_id, type, amount, related_record_id, created_at)
         VALUES ('SR1','sales-reversal:S1:R1','A1','STORE1','O1','refund_adjustment',-2.00,'S1',NOW())`
      ),
      pool.query(
        `INSERT IGNORE INTO sales_agent_commissions
          (id, business_key, sales_agent_id, store_id, order_id, type, amount, related_record_id, created_at)
         VALUES ('SR1-DUP','sales-reversal:S1:R1','A1','STORE1','O1','refund_adjustment',-2.00,'S1',NOW())`
      )
    ])
    await pool.query(
      `INSERT INTO sales_agent_commissions
        (id, business_key, sales_agent_id, store_id, order_id, type, amount, related_record_id, created_at)
       VALUES ('SR2','sales-reversal:S1:R2','A1','STORE1','O1','refund_adjustment',-3.00,'S1',NOW())`
    )
    const [[salesReversalCount]] = await pool.query(
      "SELECT COUNT(*) count, SUM(amount) amount FROM sales_agent_commissions WHERE related_record_id='S1'"
    )
    assert.strictEqual(Number(salesReversalCount.count), 2)
    assert.strictEqual(Number(salesReversalCount.amount), -5)

    const enqueueTimeout = async orderId => withTransaction(pool, connection =>
      enqueueOrderPaymentTimeout(connection, {
        orderId,
        expiresAt: "2020-01-01 00:00:00"
      })
    )
    const insertTimeoutOrder = async (id, productId, stock, status = "待支付", paymentStatus = "待支付") => {
      await insertProduct(pool, { id: productId, stock })
      await insertOrder(pool, {
        id,
        status,
        paymentStatus,
        paymentExpiresAt: "2020-01-01 00:00:00",
        stockReservedAt: "2019-12-31 23:30:00"
      })
      await pool.query("UPDATE products SET stock=stock-2 WHERE id=:productId", { productId })
      await insertOrderItem(pool, { id: `ITEM-${id}`, orderId: id, productId, quantity: 2 })
      await pool.query(
        `INSERT INTO order_inventory_reservations
          (order_item_id, order_id, product_id, quantity, created_at)
         VALUES (:itemId,:orderId,:productId,2,NOW())`, {
        itemId: `ITEM-${id}`,
        orderId: id,
        productId
      })
      await enqueueTimeout(id)
    }

    await insertTimeoutOrder("TIMEOUT-1", "P-TIMEOUT-1", 5)
    const timeoutClaimBatches = await Promise.all(Array.from({ length: 20 }, () =>
      claimDueOrderPaymentTimeoutJobs({ pool, limit: 10, lockMinutes: 5 })
    ))
    const timeoutClaims = timeoutClaimBatches.flat().filter(record => record.order_id === "TIMEOUT-1")
    assert.strictEqual(timeoutClaims.length, 1)
    const timeoutResult = await closeOrderForPaymentTimeout({ pool, record: timeoutClaims[0] })
    assert.strictEqual(timeoutResult.outcome, "CLOSED")
    assert.strictEqual(timeoutResult.release.releasedQuantity, 2)
    const [[timeoutOrder]] = await pool.query("SELECT status,payment_status,stock_released_at FROM orders WHERE id='TIMEOUT-1'")
    const [[timeoutStock]] = await pool.query("SELECT stock FROM products WHERE id='P-TIMEOUT-1'")
    const [[timeoutJob]] = await pool.query("SELECT status FROM order_payment_timeout_jobs WHERE order_id='TIMEOUT-1'")
    assert.strictEqual(timeoutOrder.status, "已关闭")
    assert.strictEqual(timeoutOrder.payment_status, "支付超时关闭")
    assert(timeoutOrder.stock_released_at)
    assert.strictEqual(Number(timeoutStock.stock), 5)
    assert.strictEqual(timeoutJob.status, "COMPLETED")
    assert.strictEqual((await claimDueOrderPaymentTimeoutJobs({ pool, limit: 10 })).filter(record => record.order_id === "TIMEOUT-1").length, 0)

    await insertTimeoutOrder("TIMEOUT-FACT", "P-TIMEOUT-FACT", 5)
    await pool.query(
      `INSERT INTO order_payment_facts
        (id, order_id, transaction_id, payment_state, amount_verified, verified_at, created_at)
       VALUES ('FACT-TIMEOUT','TIMEOUT-FACT','TX-TIMEOUT-FACT','SUCCESS',1,NOW(),NOW())`
    )
    const [factClaim] = (await claimDueOrderPaymentTimeoutJobs({ pool, limit: 10 })).filter(record => record.order_id === "TIMEOUT-FACT")
    const factResult = await closeOrderForPaymentTimeout({ pool, record: factClaim })
    assert.strictEqual(factResult.outcome, "SKIPPED")
    const [[factOrder]] = await pool.query("SELECT status FROM orders WHERE id='TIMEOUT-FACT'")
    const [[factStock]] = await pool.query("SELECT stock FROM products WHERE id='P-TIMEOUT-FACT'")
    assert.strictEqual(factOrder.status, "待支付")
    assert.strictEqual(Number(factStock.stock), 3)

    await insertTimeoutOrder("TIMEOUT-PAID-AFTER", "P-TIMEOUT-PAID-AFTER", 5)
    const [latePaymentClaim] = (await claimDueOrderPaymentTimeoutJobs({ pool, limit: 10 })).filter(record => record.order_id === "TIMEOUT-PAID-AFTER")
    await closeOrderForPaymentTimeout({ pool, record: latePaymentClaim })
    const latePayment = await markOrderPaidAndEnqueue({
      pool,
      orderId: "TIMEOUT-PAID-AFTER",
      transactionId: "TX-TIMEOUT-PAID-AFTER"
    })
    assert.strictEqual(latePayment.outcome, "PAID_AFTER_CANCEL")
    const [[latePaymentStock]] = await pool.query("SELECT stock FROM products WHERE id='P-TIMEOUT-PAID-AFTER'")
    assert.strictEqual(Number(latePaymentStock.stock), 5)

    await insertTimeoutOrder("TIMEOUT-ROLLBACK", "P-TIMEOUT-ROLLBACK", 5)
    await pool.query("CREATE TRIGGER reject_timeout_audit BEFORE INSERT ON order_state_audit FOR EACH ROW BEGIN IF NEW.order_id='TIMEOUT-ROLLBACK' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='timeout rollback'; END IF; END")
    const [rollbackClaim] = (await claimDueOrderPaymentTimeoutJobs({ pool, limit: 10 })).filter(record => record.order_id === "TIMEOUT-ROLLBACK")
    await assert.rejects(
      () => closeOrderForPaymentTimeout({ pool, record: rollbackClaim }),
      error => error.code === "ER_SIGNAL_EXCEPTION"
    )
    await pool.query("DROP TRIGGER reject_timeout_audit")
    assert.strictEqual(await failOrderPaymentTimeoutJob({ pool, record: rollbackClaim, error: new Error("timeout rollback") }), true)
    const [[rollbackTimeoutOrder]] = await pool.query("SELECT status FROM orders WHERE id='TIMEOUT-ROLLBACK'")
    const [[rollbackTimeoutStock]] = await pool.query("SELECT stock FROM products WHERE id='P-TIMEOUT-ROLLBACK'")
    assert.strictEqual(rollbackTimeoutOrder.status, "待支付")
    assert.strictEqual(Number(rollbackTimeoutStock.stock), 3)

    await insertTimeoutOrder("TIMEOUT-STALE", "P-TIMEOUT-STALE", 5)
    await pool.query(
      `UPDATE order_payment_timeout_jobs
       SET status='PROCESSING', locked_by='crashed-worker',
           locked_at=DATE_SUB(NOW(), INTERVAL 10 MINUTE)
       WHERE order_id='TIMEOUT-STALE'`
    )
    const staleClaims = await claimDueOrderPaymentTimeoutJobs({ pool, limit: 10, lockMinutes: 5 })
    const staleTimeoutClaim = staleClaims.find(record => record.order_id === "TIMEOUT-STALE")
    assert(staleTimeoutClaim)
    assert.notStrictEqual(staleTimeoutClaim.locked_by, "crashed-worker")
    await closeOrderForPaymentTimeout({ pool, record: staleTimeoutClaim })

    await insertTimeoutOrder("TIMEOUT-RACE", "P-TIMEOUT-RACE", 5)
    const [raceClaim] = (await claimDueOrderPaymentTimeoutJobs({ pool, limit: 10 })).filter(record => record.order_id === "TIMEOUT-RACE")
    const [raceClose, racePayment] = await Promise.allSettled([
      closeOrderForPaymentTimeout({ pool, record: raceClaim }),
      markOrderPaidAndEnqueue({ pool, orderId: "TIMEOUT-RACE", transactionId: "TX-TIMEOUT-RACE" })
    ])
    assert.strictEqual(raceClose.status, "fulfilled")
    assert.strictEqual(racePayment.status, "fulfilled")
    const [[raceOrder]] = await pool.query("SELECT status,payment_status FROM orders WHERE id='TIMEOUT-RACE'")
    const [[raceStock]] = await pool.query("SELECT stock FROM products WHERE id='P-TIMEOUT-RACE'")
    assert(["待发货", "PAID_AFTER_CANCEL", "已关闭"].includes(raceOrder.status))
    assert(["已支付", "异常已支付", "支付超时关闭"].includes(raceOrder.payment_status))
    assert([3, 5].includes(Number(raceStock.stock)))

    await insertTimeoutOrder("TIMEOUT-CLOSE-RACE", "P-TIMEOUT-CLOSE-RACE", 5)
    const [closeRaceClaim] = (await claimDueOrderPaymentTimeoutJobs({ pool, limit: 10 })).filter(record => record.order_id === "TIMEOUT-CLOSE-RACE")
    const closeRaceResults = await Promise.all([
      closeOrderForPaymentTimeout({ pool, record: closeRaceClaim }),
      withTransaction(pool, connection => releaseOrderInventory(connection, "TIMEOUT-CLOSE-RACE", "管理员关闭")),
      withTransaction(pool, connection => releaseOrderInventory(connection, "TIMEOUT-CLOSE-RACE", "用户取消"))
    ])
    const [[closeRaceStock]] = await pool.query("SELECT stock FROM products WHERE id='P-TIMEOUT-CLOSE-RACE'")
    const [[closeRaceReleases]] = await pool.query("SELECT COUNT(*) count FROM order_inventory_releases WHERE order_id='TIMEOUT-CLOSE-RACE'")
    const closeRaceReleaseQuantity = closeRaceResults.reduce((sum, item) => sum + Number(item?.release?.releasedQuantity || item?.releasedQuantity || 0), 0)
    assert.strictEqual(Number(closeRaceStock.stock), 5)
    assert.strictEqual(Number(closeRaceReleases.count), 1)
    assert.strictEqual(closeRaceReleaseQuantity, 2)

    await insertTimeoutOrder("TIMEOUT-REFUND-RACE", "P-TIMEOUT-REFUND-RACE", 5)
    const [timeoutRefundClaim] = (await claimDueOrderPaymentTimeoutJobs({ pool, limit: 10 })).filter(record => record.order_id === "TIMEOUT-REFUND-RACE")
    const timeoutRefundResults = await Promise.allSettled([
      closeOrderForPaymentTimeout({ pool, record: timeoutRefundClaim }),
      withTransaction(pool, connection => releaseOrderItemInventory(connection, {
        orderItemId: "ITEM-TIMEOUT-REFUND-RACE",
        requestedQuantity: 1,
        businessKey: "refund:RF-TIMEOUT-RACE:RI-1:ITEM-TIMEOUT-REFUND-RACE",
        reason: "支付超时与部分退款竞争",
        sourceType: "partial_refund",
        sourceId: "RF-TIMEOUT-RACE"
      }))
    ])
    assert.strictEqual(timeoutRefundResults[0].status, "fulfilled")
    const [[timeoutRefundStock]] = await pool.query("SELECT stock FROM products WHERE id='P-TIMEOUT-REFUND-RACE'")
    const [[timeoutRefundAccumulator]] = await pool.query("SELECT quantity FROM order_inventory_releases WHERE order_item_id='ITEM-TIMEOUT-REFUND-RACE'")
    assert.strictEqual(Number(timeoutRefundStock.stock), 5)
    assert.strictEqual(Number(timeoutRefundAccumulator.quantity), 2)

    console.log(JSON.stringify({
      ok: true,
      isolatedDatabase: true,
      finiteInventoryNoOversell: true,
      inventoryReleaseIdempotent: true,
      unlimitedAndMadeToOrderNeverReleaseStock: true,
      multiItemAndPartialReleaseAreAccurate: true,
      idempotencyScopedByUser: true,
      pickupCollisionRetried: true,
      concurrentTwentyPaymentCallbacksIdempotent: true,
      paymentFinanceEventCommittedWithPayment: true,
      paymentTransactionRollsBackWhenOutboxInsertFails: true,
      blockedPaymentStatesDoNotCreateFinanceEvents: true,
      paymentFinanceWorkerClaimedOnce: true,
      paymentFinanceWorkerRetryAndStaleLockRecovery: true,
      paymentFinancialEffectsUseUniqueBusinessKeys: true,
      pickupServiceFeeOnlyAfterVerifiedPickup: true,
      pickupServiceFeeStoreScopedAndDistinctFromReferral: true,
      concurrentSettlementClaimedOnce: true,
      chargebackBusinessKeyUnique: true,
      salesPartialReversalBusinessKeyUnique: true,
      promotionInviteeUnique: true,
      paymentTimeoutTwentyWorkersClaimOnce: true,
      paymentTimeoutClosesAndReleasesFiniteStockOnce: true,
      paymentFactBlocksTimeoutRelease: true,
      latePaymentAfterTimeoutDoesNotRedeductStock: true,
      paymentTimeoutTransactionRollsBackOnAuditFailure: true,
      paymentTimeoutStaleLockRecovered: true,
      paymentTimeoutAndPaymentRaceIsSafe: true,
      cancelAdminAndTimeoutReleaseOnlyOnce: true,
      partialRefundAndFullRefundNeverExceedOrderedQuantity: true,
      partialRefundAndCancelNeverExceedOrderedQuantity: true,
      paymentTimeoutAndPartialRefundNeverExceedOrderedQuantity: true
    }, null, 2))
  } finally {
    if (pool) await pool.end().catch(() => {})
  }
}

main().catch(error => {
  console.error(error.message)
  process.exit(1)
})
