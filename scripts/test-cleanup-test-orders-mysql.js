#!/usr/bin/env node
"use strict"

const assert = require("assert")
const crypto = require("crypto")
const fs = require("fs")
const os = require("os")
const path = require("path")
const mysql = require("mysql2/promise")
const {
  MAX_ORDERS,
  REQUIRED_DATABASE,
  assertConnectionSafety,
  readWhitelist,
  runCleanup
} = require("./cleanup-production-test-orders")

const SILENT_LOGGER = { log() {} }
const ORDER_TABLES = [
  "refund_items", "financial_record_item_allocations", "payment_finance_outbox",
  "order_notification_records", "wechat_fulfillment_records", "order_payment_timeout_jobs",
  "order_state_audit", "order_payment_facts", "pickup_code_claims", "order_request_keys",
  "order_idempotency_keys", "reward_records", "store_settlement_records",
  "sales_agent_commissions", "refund_records", "order_inventory_release_events",
  "order_inventory_releases", "order_inventory_reservations", "order_items", "orders"
]
const MASTER_TABLES = ["customers", "products", "partner_stores", "store_members", "sales_agents", "store_referral_attributions"]
const WHITELIST_IDS = Array.from({ length: 10 }, (_, index) => `TEST_ORDER_${String(index + 1).padStart(3, "0")}`)
const OUTSIDE_IDS = ["NORMAL_ORDER_001", "NORMAL_ORDER_002"]

function testEnv(overrides = {}) {
  return {
    NODE_ENV: "test",
    MYSQL_HOST: process.env.MYSQL_HOST || "127.0.0.1",
    MYSQL_TEST_PORT: process.env.MYSQL_TEST_PORT || process.env.MYSQL_PORT || "3306",
    MYSQL_TEST_USER: process.env.MYSQL_TEST_USER || "cleanup_test_user",
    MYSQL_TEST_PASSWORD: process.env.MYSQL_TEST_PASSWORD || "",
    MYSQL_TEST_DATABASE: process.env.MYSQL_TEST_DATABASE || REQUIRED_DATABASE,
    ...overrides
  }
}

function mysqlConfig() {
  const env = testEnv()
  return {
    host: env.MYSQL_HOST,
    port: Number(env.MYSQL_TEST_PORT),
    user: env.MYSQL_TEST_USER,
    password: env.MYSQL_TEST_PASSWORD,
    database: env.MYSQL_TEST_DATABASE,
    namedPlaceholders: true,
    dateStrings: true,
    connectionLimit: 4
  }
}

async function tableSet(pool) {
  const [rows] = await pool.query("SELECT table_name AS table_name FROM information_schema.tables WHERE table_schema=DATABASE()")
  return new Set(rows.map(row => String(row.table_name)))
}

async function assertProjectSchema(pool) {
  const tables = await tableSet(pool)
  const required = [...ORDER_TABLES, ...MASTER_TABLES]
  const missing = required.filter(table => !tables.has(table))
  assert.deepStrictEqual(missing, [], `必须先使用真实 cms/server.js 初始化隔离库，缺少：${missing.join(",")}`)
}

async function clearFixture(pool) {
  const tables = await tableSet(pool)
  if (tables.has("mystery_order_links")) await pool.query("DROP TABLE mystery_order_links")
  if (tables.has("reject_cleanup_delete")) await pool.query("DROP TRIGGER reject_cleanup_delete")
  await pool.query("SET FOREIGN_KEY_CHECKS=0")
  try {
    for (const table of [...ORDER_TABLES, ...MASTER_TABLES]) {
      if (tables.has(table)) await pool.query(`DELETE FROM \`${table}\``)
    }
  } finally {
    await pool.query("SET FOREIGN_KEY_CHECKS=1")
  }
}

async function insertMasters(pool) {
  await pool.query("INSERT INTO customers (id,name,phone,openid) VALUES ('CUSTOMER_TEST','纯虚构客户','13000000000','OPENID_FAKE')")
  await pool.query("INSERT INTO partner_stores (id,name,status) VALUES ('STORE_TEST','纯虚构门店','active')")
  await pool.query("INSERT INTO store_members (id,store_id,user_id,phone,status) VALUES ('MEMBER_TEST','STORE_TEST','CUSTOMER_TEST','13100000000','active')")
  await pool.query("INSERT INTO sales_agents (id,name,phone,status) VALUES ('SALES_TEST','虚构业务员','13200000000','active')")
}

async function insertProduct(pool, id, stock, stockMode) {
  await pool.query(
    `INSERT INTO products (id,name,price,status,stock,stock_mode,inventory_version)
     VALUES (:id,:name,10.00,'on',:stock,:stockMode,0)`,
    { id, name: `纯虚构商品 ${id}`, stock, stockMode }
  )
}

async function insertOrder(pool, options) {
  const {
    id, productId, itemId, mode = "FINITE", quantity = 3, released = 0,
    status = "待支付", paymentStatus = "待支付", refundStatus = null,
    transactionId = null, outside = false
  } = options
  const pickupCode = crypto.createHash("sha256").update(id).digest("hex").slice(0, 6).toUpperCase()
  await pool.query(
    `INSERT INTO orders
      (id,customer_name,phone,product_name,amount,status,payment_status,transaction_id,openid,user_id,
       product_id,refund_status,created_at,stock_reserved_at,pickup_store_id,pickup_code)
     VALUES
      (:id,'纯虚构客户','13000000000',:productName,30.00,:status,:paymentStatus,:transactionId,
       'OPENID_FAKE','CUSTOMER_TEST',:productId,:refundStatus,NOW(),NOW(),'STORE_TEST',:pickupCode)`,
    { id, productName: `纯虚构商品 ${productId}`, status, paymentStatus, transactionId, productId, refundStatus, pickupCode }
  )
  await pool.query(
    `INSERT INTO order_items
      (id,order_id,product_id,product_name,unit_price_cents,quantity,paid_amount_cents,inventory_mode)
     VALUES (:itemId,:id,:productId,:productName,1000,:quantity,:paidAmount,:mode)`,
    { itemId, id, productId, productName: `纯虚构商品 ${productId}`, quantity, paidAmount: quantity * 1000, mode }
  )
  if (mode === "FINITE") {
    await pool.query(
      `INSERT INTO order_inventory_reservations (order_item_id,order_id,product_id,quantity,created_at)
       VALUES (:itemId,:id,:productId,:quantity,NOW())`, { itemId, id, productId, quantity }
    )
  }
  if (released > 0) {
    await pool.query(
      `INSERT INTO order_inventory_releases (order_item_id,order_id,product_id,quantity,reason,created_at,updated_at)
       VALUES (:itemId,:id,:productId,:released,'虚构既有释放',NOW(),NOW())`, { itemId, id, productId, released }
    )
    await pool.query(
      `INSERT INTO order_inventory_release_events
        (id,business_key,order_item_id,order_id,product_id,quantity,reason,source_type,source_id,created_at)
       VALUES (:eventId,:businessKey,:itemId,:id,:productId,:released,'虚构既有释放','fixture',:id,NOW())`,
      { eventId: `EVENT_${itemId}`, businessKey: `fixture:${id}:${itemId}`, itemId, id, productId, released }
    )
  }
  if (transactionId) {
    await pool.query(
      `INSERT INTO order_payment_facts (id,order_id,transaction_id,payment_state,amount_verified,verified_at,created_at)
       VALUES (:factId,:id,:transactionId,'SUCCESS',1,NOW(),NOW())`,
      { factId: `FACT_${id}`, id, transactionId }
    )
  }
  await pool.query("INSERT INTO pickup_code_claims (code,order_id,created_at) VALUES (:code,:id,NOW())", { code: pickupCode, id })
  await pool.query("INSERT INTO order_request_keys (request_key,order_id,created_at) VALUES (:key,:id,NOW())", { key: `REQ_${id}`, id })
  await pool.query(
    `INSERT INTO order_idempotency_keys (user_id,operation,request_key,request_hash,order_id,created_at,expires_at)
     VALUES ('CUSTOMER_TEST','create',:key,REPEAT('a',64),:id,NOW(),DATE_ADD(NOW(),INTERVAL 1 DAY))`,
    { key: `IDEMP_${id}`, id }
  )
  await pool.query("INSERT INTO order_state_audit (order_id,new_order_status,action_source,created_at) VALUES (:id,:status,'fixture',NOW())", { id, status })
  await pool.query("INSERT INTO order_notification_records (order_id,notification_type,status,created_at,updated_at) VALUES (:id,'PAID','PENDING',NOW(),NOW())", { id })
  await pool.query("INSERT INTO wechat_fulfillment_records (order_id,business_node,status,created_at,updated_at) VALUES (:id,'CREATE','PENDING',NOW(),NOW())", { id })
  await pool.query("INSERT INTO order_payment_timeout_jobs (order_id,status,available_at,created_at,updated_at) VALUES (:id,'PENDING',NOW(),NOW(),NOW())", { id })
  await pool.query(
    `INSERT INTO payment_finance_outbox (event_type,business_key,aggregate_type,aggregate_id,status,created_at,updated_at)
     VALUES ('ORDER_PAID',:key,'ORDER',:id,'PENDING',NOW(),NOW())`, { key: `payment_finance:${id}`, id }
  )
  await pool.query(
    `INSERT INTO reward_records (id,order_id,product_name,amount,status,created_at,updated_at,business_key)
     VALUES (:recordId,:id,'纯虚构商品',1.00,'unsettled',NOW(),NOW(),:key)`,
    { recordId: `REWARD_${id}`, id, key: `reward:${id}` }
  )
  await pool.query(
    `INSERT INTO store_settlement_records (id,store_id,order_id,type,amount,status,created_at,updated_at,business_key)
     VALUES (:recordId,'STORE_TEST',:id,'pickup_service_fee',2.00,'pending_confirm',NOW(),NOW(),:key)`,
    { recordId: `STORE_FIN_${id}`, id, key: `store:${id}` }
  )
  await pool.query(
    `INSERT INTO sales_agent_commissions
      (id,business_key,sales_agent_id,store_id,order_id,type,amount,status,created_at)
     VALUES (:recordId,:key,'SALES_TEST','STORE_TEST',:id,'sales_agent_commission',3.00,'unsettled',NOW())`,
    { recordId: `SALES_FIN_${id}`, id, key: `sales:${id}` }
  )
  await pool.query(
    `INSERT INTO financial_record_item_allocations
      (id,ledger_type,record_id,order_id,order_item_id,quantity,allocated_amount_cents,created_at)
     VALUES (:allocationId,'reward',:recordId,:id,:itemId,:quantity,100,NOW())`,
    { allocationId: `ALLOC_${id}`, recordId: `REWARD_${id}`, id, itemId, quantity }
  )
  await pool.query(
    `INSERT INTO store_referral_attributions
      (id,token_hash,store_id,user_id,attribution_type,status,last_order_id,created_at,expires_at,updated_at)
     VALUES (:attributionId,:tokenHash,'STORE_TEST','CUSTOMER_TEST','store_external','active',:id,NOW(),DATE_ADD(NOW(),INTERVAL 1 DAY),NOW())`,
    { attributionId: `ATTR_${id}`, tokenHash: String(id).padEnd(64, "0").slice(0, 64), id }
  )
  if (!outside && id === "TEST_ORDER_003") {
    await pool.query("UPDATE orders SET refund_status='已退款',refund_no=:refundNo,refund_id=:refundExternal WHERE id=:id", { refundNo: `REFUND_NO_${id}`, refundExternal: `WX_REFUND_${id}`, id })
    await pool.query(
      `INSERT INTO refund_records
        (id,order_id,refund_no,wechat_refund_id,requested_amount_cents,success_amount_cents,status,requested_at,success_at,updated_at)
       VALUES (:refundId,:id,:refundNo,:refundExternal,3000,3000,'SUCCESS',NOW(),NOW(),NOW())`,
      { refundId: `REFUND_${id}`, id, refundNo: `REFUND_NO_${id}`, refundExternal: `WX_REFUND_${id}` }
    )
    await pool.query(
      `INSERT INTO refund_items
        (id,refund_record_id,order_item_id,refund_quantity,product_refund_cents,status,created_at,updated_at)
       VALUES (:refundItemId,:refundId,:itemId,:quantity,3000,'SUCCESS',NOW(),NOW())`,
      { refundItemId: `REFUND_ITEM_${id}`, refundId: `REFUND_${id}`, itemId, quantity }
    )
  }
  if (!outside && id === "TEST_ORDER_004") {
    await pool.query("UPDATE orders SET refund_status='部分退款' WHERE id=:id", { id })
    await pool.query(
      `INSERT INTO refund_records
        (id,order_id,refund_no,wechat_refund_id,requested_amount_cents,success_amount_cents,status,requested_at,success_at,updated_at)
       VALUES (:refundId,:id,:refundNo,:refundExternal,1000,1000,'SUCCESS',NOW(),NOW(),NOW())`,
      { refundId: `REFUND_${id}`, id, refundNo: `REFUND_NO_${id}`, refundExternal: `WX_REFUND_${id}` }
    )
    await pool.query(
      `INSERT INTO refund_items
        (id,refund_record_id,order_item_id,refund_quantity,product_refund_cents,status,created_at,updated_at)
       VALUES (:refundItemId,:refundId,:itemId,1,1000,'SUCCESS',NOW(),NOW())`,
      { refundItemId: `REFUND_ITEM_${id}`, refundId: `REFUND_${id}`, itemId }
    )
  }
}

async function seedMainFixture(pool) {
  await clearFixture(pool)
  await insertMasters(pool)
  const specs = [
    { mode: "FINITE", released: 0, stock: 7, status: "待支付", paymentStatus: "待支付" },
    { mode: "FINITE", released: 1, stock: 8, status: "已取消", paymentStatus: "已取消" },
    { mode: "FINITE", released: 3, stock: 10, status: "已退款", paymentStatus: "已退款", refundStatus: "已退款", paid: true },
    { mode: "UNLIMITED", released: 0, stock: 77, status: "待发货", paymentStatus: "已支付", paid: true },
    { mode: "MADE_TO_ORDER", released: 0, stock: 66, status: "制作中", paymentStatus: "已支付", paid: true },
    { mode: "FINITE", released: 3, stock: 10, status: "已关闭", paymentStatus: "已关闭" },
    { mode: "FINITE", released: 0, stock: 7, status: "待支付", paymentStatus: "待支付" },
    { mode: "FINITE", released: 2, stock: 9, status: "已取消", paymentStatus: "已取消" },
    { mode: "FINITE", released: 3, stock: 10, status: "已退款", paymentStatus: "已退款", paid: true },
    { mode: "FINITE", released: 0, stock: 7, status: "待支付", paymentStatus: "待支付" }
  ]
  for (let index = 0; index < specs.length; index += 1) {
    const id = WHITELIST_IDS[index]
    const productId = `PRODUCT_TEST_${String(index + 1).padStart(3, "0")}`
    const spec = specs[index]
    await insertProduct(pool, productId, spec.stock, spec.mode)
    await insertOrder(pool, {
      id, productId, itemId: `ITEM_TEST_${String(index + 1).padStart(3, "0")}`,
      ...spec, transactionId: spec.paid ? `TX_FAKE_${String(index + 1).padStart(3, "0")}` : null
    })
  }
  for (let index = 0; index < OUTSIDE_IDS.length; index += 1) {
    const id = OUTSIDE_IDS[index]
    const productId = `PRODUCT_NORMAL_${String(index + 1).padStart(3, "0")}`
    await insertProduct(pool, productId, 7, "FINITE")
    await insertOrder(pool, { id, productId, itemId: `ITEM_NORMAL_${index + 1}`, outside: true })
  }
}

async function snapshot(pool, whereIds = [...WHITELIST_IDS, ...OUTSIDE_IDS]) {
  const result = {}
  for (const table of ORDER_TABLES) {
    const [columns] = await pool.query(
      "SELECT column_name AS column_name FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name=:table",
      { table }
    )
    const names = new Set(columns.map(row => String(row.column_name)))
    let sql = `SELECT * FROM \`${table}\``
    let params = []
    if (names.has("order_id")) {
      sql += ` WHERE order_id IN (${whereIds.map(() => "?").join(",")})`
      params = whereIds
    } else if (table === "orders") {
      sql += ` WHERE id IN (${whereIds.map(() => "?").join(",")})`
      params = whereIds
    } else if (table === "payment_finance_outbox") {
      sql += ` WHERE aggregate_id IN (${whereIds.map(() => "?").join(",")})`
      params = whereIds
    } else if (table === "refund_items") {
      sql += ` WHERE refund_record_id IN (SELECT id FROM refund_records WHERE order_id IN (${whereIds.map(() => "?").join(",")}))`
      params = whereIds
    }
    sql += " ORDER BY 1"
    const [rows] = await pool.query(sql, params)
    result[table] = rows
  }
  const [products] = await pool.query(
    `SELECT id,stock,inventory_version FROM products
     WHERE id IN (SELECT DISTINCT product_id FROM order_items WHERE order_id IN (${whereIds.map(() => "?").join(",")}))
     ORDER BY id`,
    whereIds
  )
  result.products = products
  return result
}

async function count(pool, sql, params = {}) {
  const [[row]] = await pool.query(sql, params)
  return Number(row.count || 0)
}

async function main() {
  if (String(process.env.NODE_ENV || "").toLowerCase() === "production") throw new Error("安全拒绝：不能在生产环境运行")
  const pool = mysql.createPool(mysqlConfig())
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "order-cleanup-whitelist-"))
  const whitelistFile = path.join(tempDir, "order-whitelist.json")
  const emptyFile = path.join(tempDir, "empty.json")
  const tooManyFile = path.join(tempDir, "too-many.json")
  fs.writeFileSync(whitelistFile, JSON.stringify({ orderIds: [...WHITELIST_IDS, WHITELIST_IDS[0]] }))
  fs.writeFileSync(emptyFile, JSON.stringify({ orderIds: [] }))
  fs.writeFileSync(tooManyFile, JSON.stringify({ orderIds: Array.from({ length: MAX_ORDERS + 1 }, (_, i) => `ORDER_${i}`) }))
  const passed = []
  const check = (name, condition) => { assert(condition, name); passed.push(name) }
  try {
    await assertProjectSchema(pool)

    assert.throws(() => readWhitelist(""), /缺少 --whitelist-file/)
    check("02 缺少白名单安全停止", true)
    assert.throws(() => readWhitelist(emptyFile), /不能为空/)
    check("03 空白名单安全停止", true)
    assert.throws(() => readWhitelist(tooManyFile), /不得超过 20/)
    check("04 超过20笔安全停止", true)
    assert.throws(() => assertConnectionSafety(testEnv(), { apply: true, confirmed: false }), /confirm-delete-test-orders/)
    check("05 缺少确认参数安全停止", true)
    assert.throws(() => assertConnectionSafety(testEnv({ MYSQL_HOST: "10.0.0.8" }), { apply: false, confirmed: false }), /MYSQL_HOST/)
    check("06 非本地数据库安全停止", true)
    assert.throws(() => assertConnectionSafety(testEnv({ MYSQL_TEST_DATABASE: "shop" }), { apply: false, confirmed: false }), /vsc_security_test_/)
    check("07 非测试前缀数据库安全停止", true)
    assert.throws(() => assertConnectionSafety(testEnv({ NODE_ENV: "production" }), { apply: false, confirmed: false }), /NODE_ENV/)
    check("31 production环境安全停止", true)
    assert.throws(() => assertConnectionSafety(testEnv({ MYSQL_TEST_USER: "" }), { apply: false, confirmed: false }), /MYSQL_TEST_USER/)
    check("32 缺少测试用户名安全停止", true)

    await seedMainFixture(pool)
    const beforeDryRun = await snapshot(pool)
    const dryRun = await runCleanup({ argv: [`--whitelist-file=${whitelistFile}`], env: testEnv(), logger: SILENT_LOGGER })
    check("01 dry-run不改变任何表", JSON.stringify(await snapshot(pool)) === JSON.stringify(beforeDryRun))
    check("33 重复订单ID去重并报告", dryRun.report.duplicateOrderIdsRemoved === 1 && dryRun.report.whitelistCount === 10)
    check("34 dry-run汇总10笔可删除", dryRun.exitCode === 0 && dryRun.report.automaticDeleteCount === 10)
    const outsideBefore = await snapshot(pool, OUTSIDE_IDS)
    const mastersBefore = Object.fromEntries(await Promise.all(MASTER_TABLES.map(async table => [table, await count(pool, `SELECT COUNT(*) AS count FROM \`${table}\``)])))
    const apply = await runCleanup({
      argv: [`--whitelist-file=${whitelistFile}`, "--apply", "--confirm-delete-test-orders"],
      env: testEnv(), logger: SILENT_LOGGER
    })
    check("09 10笔指定订单完整清理", apply.exitCode === 0 && apply.report.deleted.orders === 10)
    check("08 白名单外2笔订单绝不删除", await count(pool, "SELECT COUNT(*) AS count FROM orders WHERE id IN (?,?)", OUTSIDE_IDS) === 2)
    check("11 白名单外订单关联数据保留", JSON.stringify(await snapshot(pool, OUTSIDE_IDS)) === JSON.stringify(outsideBefore))
    check("10 customers/products/stores等主数据保留", (await Promise.all(MASTER_TABLES.map(table => count(pool, `SELECT COUNT(*) AS count FROM \`${table}\``)))).every((value, index) => value === mastersBefore[MASTER_TABLES[index]]))
    const [targetStocks] = await pool.query("SELECT id,stock FROM products WHERE id LIKE 'PRODUCT_TEST_%' ORDER BY id")
    const stockMap = Object.fromEntries(targetStocks.map(row => [row.id, Number(row.stock)]))
    check("12 未释放FINITE库存正确归还", stockMap.PRODUCT_TEST_001 === 10)
    check("13 部分释放只归还剩余数量", stockMap.PRODUCT_TEST_002 === 10 && stockMap.PRODUCT_TEST_008 === 10)
    check("14 完整释放不重复增加", stockMap.PRODUCT_TEST_003 === 10 && stockMap.PRODUCT_TEST_006 === 10)
    check("15 UNLIMITED不改变库存", stockMap.PRODUCT_TEST_004 === 77)
    check("16 MADE_TO_ORDER不改变库存", stockMap.PRODUCT_TEST_005 === 66)
    const repeat = await runCleanup({
      argv: [`--whitelist-file=${whitelistFile}`, "--apply", "--confirm-delete-test-orders"], env: testEnv(), logger: SILENT_LOGGER
    })
    check("17 重复运行幂等安全", repeat.exitCode === 0 && repeat.report.notFoundCount === 10 && repeat.report.deleted.orders === 0)
    check("22 清理后无孤立order_items", await count(pool, "SELECT COUNT(*) AS count FROM order_items oi LEFT JOIN orders o ON o.id=oi.order_id WHERE o.id IS NULL") === 0)
    check("23 清理后无孤立refund_items", await count(pool, "SELECT COUNT(*) AS count FROM refund_items ri LEFT JOIN refund_records rr ON rr.id=ri.refund_record_id WHERE rr.id IS NULL") === 0)
    check("24 清理后无孤立Outbox", await count(pool, "SELECT COUNT(*) AS count FROM payment_finance_outbox p LEFT JOIN orders o ON o.id=p.aggregate_id WHERE p.aggregate_type='ORDER' AND o.id IS NULL") === 0)
    check("25 清理后无孤立库存事件", await count(pool, "SELECT COUNT(*) AS count FROM order_inventory_release_events e LEFT JOIN order_items oi ON oi.id=e.order_item_id WHERE oi.id IS NULL") === 0)
    check("26 清理后无负库存", await count(pool, "SELECT COUNT(*) AS count FROM products WHERE stock<0") === 0)
    check("27 库存事件与累计表一致", await count(pool, `SELECT COUNT(*) AS count FROM order_inventory_releases r LEFT JOIN (SELECT order_item_id,SUM(quantity) quantity FROM order_inventory_release_events GROUP BY order_item_id) e ON e.order_item_id=r.order_item_id WHERE r.quantity<>COALESCE(e.quantity,0)`) === 0)
    check("28 白名单外订单数据行数完全不变", JSON.stringify(await snapshot(pool, OUTSIDE_IDS)) === JSON.stringify(outsideBefore))
    check("29 实际删除数严格等于允许数", apply.report.deleted.orders === apply.report.automaticDeleteCount)

    await clearFixture(pool)
    await insertMasters(pool)
    await insertProduct(pool, "PRODUCT_SHARED", 7, "FINITE")
    await insertOrder(pool, { id: "TEST_SHARED_TX", productId: "PRODUCT_SHARED", itemId: "ITEM_SHARED", paymentStatus: "已支付", status: "待发货", transactionId: "TX_SHARED" })
    await insertProduct(pool, "PRODUCT_SHARED_OTHER", 7, "FINITE")
    await insertOrder(pool, { id: "NORMAL_SHARED_TX", productId: "PRODUCT_SHARED_OTHER", itemId: "ITEM_SHARED_OTHER" })
    await pool.query("UPDATE orders SET transaction_id='TX_SHARED' WHERE id='NORMAL_SHARED_TX'")
    fs.writeFileSync(whitelistFile, JSON.stringify({ orderIds: ["TEST_SHARED_TX"] }))
    const shared = await runCleanup({ argv: [`--whitelist-file=${whitelistFile}`], env: testEnv(), logger: SILENT_LOGGER })
    check("18 transaction_id共享进入MANUAL_REVIEW", shared.exitCode !== 0 && shared.report.manualReviewCount === 1)
    check("30 任一异常退出码非0", shared.exitCode !== 0)

    await pool.query("UPDATE orders SET transaction_id=NULL WHERE id='NORMAL_SHARED_TX'")
    await pool.query("UPDATE store_settlement_records SET status='settled',settled_at=NOW() WHERE order_id='TEST_SHARED_TX'")
    const settled = await runCleanup({ argv: [`--whitelist-file=${whitelistFile}`], env: testEnv(), logger: SILENT_LOGGER })
    check("19 已结算财务进入MANUAL_REVIEW", settled.exitCode !== 0 && settled.report.manualReview[0].reasons.some(reason => reason.includes("已结算")))

    await pool.query("UPDATE store_settlement_records SET status='pending_confirm',settled_at=NULL WHERE order_id='TEST_SHARED_TX'")
    await pool.query("CREATE TABLE mystery_order_links (id INT PRIMARY KEY AUTO_INCREMENT,order_id VARCHAR(32) NOT NULL)")
    await pool.query("INSERT INTO mystery_order_links (order_id) VALUES ('TEST_SHARED_TX')")
    const unknown = await runCleanup({ argv: [`--whitelist-file=${whitelistFile}`], env: testEnv(), logger: SILENT_LOGGER })
    check("20 未知关联数据安全停止", unknown.exitCode !== 0 && unknown.report.unknownAssociations.length === 1)
    await pool.query("DROP TABLE mystery_order_links")

    const rollbackBefore = await snapshot(pool, ["TEST_SHARED_TX"])
    const rollback = await assert.rejects(
      () => runCleanup({
        argv: [`--whitelist-file=${whitelistFile}`, "--apply", "--confirm-delete-test-orders"],
        env: testEnv({ CLEANUP_TEST_FAIL_AFTER_RELEASE: "true" }), logger: SILENT_LOGGER
      }), /测试注入/
    )
    void rollback
    check("21 事务中途异常整体回滚", JSON.stringify(await snapshot(pool, ["TEST_SHARED_TX"])) === JSON.stringify(rollbackBefore))
    check("35 回滚后订单仍完整存在", await count(pool, "SELECT COUNT(*) AS count FROM orders WHERE id='TEST_SHARED_TX'") === 1)
    check("36 回滚后库存无变化", (await pool.query("SELECT stock FROM products WHERE id='PRODUCT_SHARED'"))[0][0].stock === 7)

    console.log(JSON.stringify({
      ok: true,
      isolatedDatabase: testEnv().MYSQL_TEST_DATABASE,
      realMysqlTransactions: true,
      passedCount: passed.length,
      checks: passed
    }, null, 2))
  } finally {
    await clearFixture(pool).catch(() => {})
    await pool.end().catch(() => {})
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

main().catch(error => {
  console.error(error.stack || error.message)
  process.exit(1)
})
