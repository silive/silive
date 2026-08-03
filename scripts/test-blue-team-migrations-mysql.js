#!/usr/bin/env node
"use strict"

const assert = require("assert")
const crypto = require("crypto")
const fs = require("fs")
const os = require("os")
const path = require("path")
const { spawn } = require("child_process")
const mysql = require("mysql2/promise")
const { runCleanup } = require("./cleanup-production-test-orders")
const { REQUIRED_DATABASE, connectionConfig, inspectMigrationReadiness } = require("./preflight-production-migration")
const { runMigrations, schemaSnapshot } = require("./run-blue-team-migrations")

const SILENT = { log() {} }
const TEST_ORDERS = Array.from({ length: 10 }, (_, index) => `MIG_TEST_ORDER_${String(index + 1).padStart(2, "0")}`)
const NORMAL_ORDERS = ["MIG_NORMAL_ORDER_01", "MIG_NORMAL_ORDER_02"]

function envConfig(overrides = {}) {
  return {
    ...process.env,
    NODE_ENV: "test",
    MYSQL_HOST: process.env.MYSQL_HOST || "127.0.0.1",
    MYSQL_TEST_PORT: process.env.MYSQL_TEST_PORT || "3306",
    MYSQL_TEST_USER: process.env.MYSQL_TEST_USER || "migration_test_user",
    MYSQL_TEST_PASSWORD: process.env.MYSQL_TEST_PASSWORD || "",
    MYSQL_TEST_DATABASE: REQUIRED_DATABASE,
    AI_PREVIEW_ENABLED: "false",
    ...overrides
  }
}

function serviceEnv(port, disableWorkers) {
  const env = envConfig()
  return {
    ...env,
    MYSQL_TEST_SKIP_DOTENV: "true",
    MYSQL_TEST_ISOLATED: "true",
    MYSQL_TEST_SKIP_SEED_DATA: "true",
    MYSQL_TEST_DATABASE_READY: "true",
    MYSQL_TEST_DISABLE_WORKERS: disableWorkers ? "true" : "false",
    STARTUP_HISTORY_COMPENSATION_ENABLED: "false",
    STORAGE_MODE: "mysql",
    MYSQL_PORT: env.MYSQL_TEST_PORT,
    MYSQL_USER: env.MYSQL_TEST_USER,
    MYSQL_PASSWORD: env.MYSQL_TEST_PASSWORD,
    MYSQL_DATABASE: env.MYSQL_TEST_DATABASE,
    PORT: String(port),
    ENABLE_HTTPS: "false",
    PUBLIC_BASE_URL: `http://127.0.0.1:${port}`,
    PAY_MOCK: "true",
    AI_PREVIEW_ENABLED: "false",
    WECOM_ORDER_WEBHOOK_URL: "",
    WECHAT_APPID: "",
    WECHAT_SECRET: "",
    OPENAI_API_KEY: ""
  }
}

async function startService({ port, disableWorkers }) {
  const child = spawn(process.execPath, [path.join(__dirname, "..", "cms", "server.js")], {
    cwd: path.join(__dirname, ".."),
    env: serviceEnv(port, disableWorkers),
    stdio: ["ignore", "pipe", "pipe"]
  })
  let output = ""
  child.stdout.on("data", chunk => { output += chunk.toString() })
  child.stderr.on("data", chunk => { output += chunk.toString() })
  const baseUrl = `http://127.0.0.1:${port}`
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`cms/server.js 启动失败：${output.slice(-2000)}`)
    try {
      const response = await fetch(`${baseUrl}/api/home`)
      if (response.ok) return { child, baseUrl, output: () => output }
    } catch (error) {}
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  child.kill("SIGTERM")
  throw new Error(`cms/server.js 启动超时：${output.slice(-2000)}`)
}

async function stopService(service) {
  if (!service?.child || service.child.exitCode != null) return
  service.child.kill("SIGTERM")
  await Promise.race([
    new Promise(resolve => service.child.once("exit", resolve)),
    new Promise(resolve => setTimeout(resolve, 3000))
  ])
  if (service.child.exitCode == null) service.child.kill("SIGKILL")
}

async function resetDatabase(pool) {
  const [tables] = await pool.query("SELECT table_name AS table_name FROM information_schema.tables WHERE table_schema=DATABASE()")
  await pool.query("SET FOREIGN_KEY_CHECKS=0")
  try {
    for (const row of tables) await pool.query(`DROP TABLE \`${row.table_name}\``)
  } finally {
    await pool.query("SET FOREIGN_KEY_CHECKS=1")
  }
}

async function dropIndexIfPresent(pool, table, index) {
  const [[row]] = await pool.query(
    "SELECT COUNT(*) AS count FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name=:table AND index_name=:index",
    { table, index }
  )
  if (Number(row.count)) await pool.query(`ALTER TABLE \`${table}\` DROP INDEX \`${index}\``)
}

async function dropColumnIfPresent(pool, table, column) {
  const [[row]] = await pool.query(
    "SELECT COUNT(*) AS count FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name=:table AND column_name=:column",
    { table, column }
  )
  if (Number(row.count)) await pool.query(`ALTER TABLE \`${table}\` DROP COLUMN \`${column}\``)
}

async function buildOldProductionShape(pool) {
  for (const table of [
    "payment_finance_outbox", "order_payment_timeout_jobs", "order_inventory_reservations",
    "order_inventory_release_events", "financial_record_item_allocations", "store_referral_attributions",
    "promotion_relation_claims"
  ]) await pool.query(`DROP TABLE IF EXISTS \`${table}\``)

  for (const [table, index] of [
    ["orders", "idx_orders_payment_timeout"],
    ["order_payment_facts", "uniq_payment_fact_transaction"],
    ["refund_items", "idx_refund_item_order_item"],
    ["reward_records", "uniq_reward_business"],
    ["store_settlement_records", "uniq_store_settlement_business"],
    ["sales_agent_commissions", "uniq_sales_agent_business"],
    ["order_idempotency_keys", "uniq_order_idempotency_scope"],
    ["order_idempotency_keys", "idx_order_idempotency_order"],
    ["order_idempotency_keys", "idx_order_idempotency_expiry"],
    ["pickup_code_claims", "uniq_pickup_code_order"]
  ]) await dropIndexIfPresent(pool, table, index)

  for (const [table, column] of [
    ["orders", "payment_expires_at"], ["orders", "stock_reserved_at"], ["orders", "stock_released_at"],
    ["order_inventory_releases", "updated_at"],
    ["order_notification_records", "claim_token"], ["order_notification_records", "processing_started_at"],
    ["reward_records", "business_key"], ["reward_records", "related_record_id"],
    ["store_settlement_records", "business_key"], ["store_settlement_records", "related_record_id"],
    ["sales_agent_commissions", "business_key"], ["sales_agent_commissions", "related_record_id"]
  ]) await dropColumnIfPresent(pool, table, column)
  await pool.query("ALTER TABLE store_settlement_records MODIFY COLUMN type VARCHAR(20) NULL")
}

async function seedOldFixture(pool) {
  await pool.query("INSERT INTO customers (id,name,phone,openid) VALUES ('MIG_CUSTOMER','虚构迁移客户','13000000000','FAKE_OPENID_MIG')")
  await pool.query("INSERT INTO partner_stores (id,name,status) VALUES ('MIG_STORE','虚构迁移门店','active')")
  await pool.query("INSERT INTO store_members (id,store_id,user_id,phone,status) VALUES ('MIG_MEMBER','MIG_STORE','MIG_CUSTOMER','13100000000','active')")
  await pool.query("INSERT INTO sales_agents (id,name,phone,status) VALUES ('MIG_SALES','虚构迁移业务员','13200000000','active')")
  const specs = [
    { mode: "FINITE", released: 0, stock: 7, status: "待支付", payment: "待支付" },
    { mode: "FINITE", released: 1, stock: 8, status: "已取消", payment: "已取消" },
    { mode: "FINITE", released: 3, stock: 10, status: "已退款", payment: "已退款", refund: "已退款", paid: true },
    { mode: "UNLIMITED", released: 0, stock: 77, status: "待发货", payment: "已支付", refund: "部分退款", paid: true },
    { mode: "MADE_TO_ORDER", released: 0, stock: 66, status: "制作中", payment: "已支付", paid: true },
    { mode: "FINITE", released: 3, stock: 10, status: "已关闭", payment: "已关闭" },
    { mode: "FINITE", released: 0, stock: 7, status: "待支付", payment: "待支付" },
    { mode: "FINITE", released: 2, stock: 9, status: "已取消", payment: "已取消" },
    { mode: "FINITE", released: 3, stock: 10, status: "待发货", payment: "已支付", paid: true },
    { mode: "FINITE", released: 0, stock: 7, status: "待支付", payment: "待支付" }
  ]
  const all = [
    ...TEST_ORDERS.map((id, index) => ({ id, spec: specs[index], normal: false })),
    ...NORMAL_ORDERS.map((id, index) => ({ id, spec: { mode: index ? "UNLIMITED" : "FINITE", released: 0, stock: index ? 55 : 7, status: "待支付", payment: "待支付" }, normal: true }))
  ]
  for (let index = 0; index < all.length; index += 1) {
    const { id, spec, normal } = all[index]
    const suffix = String(index + 1).padStart(2, "0")
    const productId = `MIG_PRODUCT_${suffix}`
    const itemId = `MIG_ITEM_${suffix}`
    const transactionId = spec.paid ? `FAKE_TX_MIG_${suffix}` : null
    const pickupCode = crypto.createHash("sha256").update(id).digest("hex").slice(0, 6).toUpperCase()
    await pool.query(
      "INSERT INTO products (id,name,price,status,stock,stock_mode,inventory_version) VALUES (:id,:name,10,'on',:stock,:mode,0)",
      { id: productId, name: `虚构迁移商品${suffix}`, stock: spec.stock, mode: spec.mode }
    )
    await pool.query(
      `INSERT INTO orders
        (id,customer_name,phone,product_name,amount,status,payment_status,transaction_id,openid,user_id,user_token,
         product_id,refund_status,refund_no,refund_id,created_at,delivery_type,pickup_store_id,pickup_code,pickup_status)
       VALUES (:id,'虚构迁移客户','13000000000',:productName,30,:status,:payment,:transactionId,
         'FAKE_OPENID_MIG','MIG_CUSTOMER',:legacyToken,:productId,:refundStatus,:refundNo,:refundExternal,
         DATE_ADD('2026-01-01',INTERVAL :day DAY),'pickup','MIG_STORE',:pickupCode,'none')`,
      {
        id, productName: `虚构迁移商品${suffix}`, status: spec.status, payment: spec.payment, transactionId,
        legacyToken: `LEGACY_FAKE_TOKEN_${suffix}`, productId, refundStatus: spec.refund || null,
        refundNo: spec.refund ? `FAKE_REFUND_NO_${suffix}` : null,
        refundExternal: spec.refund ? `FAKE_WX_REFUND_${suffix}` : null,
        day: index, pickupCode
      }
    )
    await pool.query(
      `INSERT INTO order_items
        (id,order_id,product_id,product_name,unit_price_cents,quantity,paid_amount_cents,inventory_mode)
       VALUES (:itemId,:orderId,:productId,:productName,1000,3,3000,:mode)`,
      { itemId, orderId: id, productId, productName: `虚构迁移商品${suffix}`, mode: spec.mode }
    )
    if (spec.released > 0) {
      await pool.query(
        `INSERT INTO order_inventory_releases (order_item_id,order_id,product_id,quantity,reason,created_at)
         VALUES (:itemId,:orderId,:productId,:quantity,'虚构旧释放记录',NOW())`,
        { itemId, orderId: id, productId, quantity: spec.released }
      )
    }
    if (transactionId) {
      await pool.query(
        `INSERT INTO order_payment_facts (id,order_id,transaction_id,payment_state,amount_verified,verified_at,created_at)
         VALUES (:factId,:orderId,:transactionId,'SUCCESS',1,NOW(),NOW())`,
        { factId: `MIG_FACT_${suffix}`, orderId: id, transactionId }
      )
    }
    if (spec.refund) {
      const refundId = `MIG_REFUND_${suffix}`
      await pool.query(
        `INSERT INTO refund_records
          (id,order_id,refund_no,wechat_refund_id,requested_amount_cents,success_amount_cents,status,requested_at,success_at,updated_at)
         VALUES (:refundId,:orderId,:refundNo,:wechatRefundId,:requested,:success,'SUCCESS',NOW(),NOW(),NOW())`,
        {
          refundId, orderId: id, refundNo: `FAKE_REFUND_NO_${suffix}`, wechatRefundId: `FAKE_WX_REFUND_${suffix}`,
          requested: spec.refund === "部分退款" ? 1000 : 3000, success: spec.refund === "部分退款" ? 1000 : 3000
        }
      )
      await pool.query(
        `INSERT INTO refund_items
          (id,refund_record_id,order_item_id,refund_quantity,product_refund_cents,status,created_at,updated_at)
         VALUES (:id,:refundId,:itemId,:quantity,:amount,'SUCCESS',NOW(),NOW())`,
        { id: `MIG_REFUND_ITEM_${suffix}`, refundId, itemId, quantity: spec.refund === "部分退款" ? 1 : 3, amount: spec.refund === "部分退款" ? 1000 : 3000 }
      )
    }
    await pool.query("INSERT INTO pickup_code_claims (code,order_id,created_at) VALUES (:code,:orderId,NOW())", { code: pickupCode, orderId: id })
    await pool.query(
      `INSERT INTO order_idempotency_keys (user_id,operation,request_key,request_hash,order_id,created_at,expires_at)
       VALUES ('MIG_CUSTOMER','create',:requestKey,REPEAT('b',64),:orderId,NOW(),DATE_ADD(NOW(),INTERVAL 1 DAY))`,
      { requestKey: `MIG_REQUEST_${suffix}`, orderId: id }
    )
    await pool.query("INSERT INTO order_state_audit (order_id,new_order_status,action_source,created_at) VALUES (:orderId,:status,'old_fixture',NOW())", { orderId: id, status: spec.status })
    await pool.query("INSERT INTO order_notification_records (order_id,notification_type,status,created_at,updated_at) VALUES (:orderId,'PAID','COMPLETED',NOW(),NOW())", { orderId: id })
    await pool.query("INSERT INTO wechat_fulfillment_records (order_id,business_node,status,created_at,updated_at) VALUES (:orderId,'CREATE','COMPLETED',NOW(),NOW())", { orderId: id })
    await pool.query(
      `INSERT INTO promotion_relations (id,inviter_phone,invitee_phone,level,created_at)
       VALUES (:id,:inviter,:invitee,1,NOW())`,
      { id: `MIG_REL_${suffix}`, inviter: `1330000${String(index).padStart(4, "0")}`, invitee: `1340000${String(index).padStart(4, "0")}` }
    )
    await pool.query(
      `INSERT INTO reward_records (id,order_id,product_name,amount,status,created_at,updated_at)
       VALUES (:id,:orderId,'虚构迁移商品',1,:status,NOW(),NOW())`,
      { id: `MIG_REWARD_${suffix}`, orderId: id, status: normal && index === 10 ? "settled" : "unsettled" }
    )
    await pool.query(
      `INSERT INTO store_settlement_records (id,store_id,order_id,type,amount,status,created_at,settled_at,updated_at)
       VALUES (:id,'MIG_STORE',:orderId,'pickup_service_fee',2,:status,NOW(),:settledAt,NOW())`,
      { id: `MIG_STORE_FIN_${suffix}`, orderId: id, status: normal && index === 10 ? "settled" : "pending_confirm", settledAt: normal && index === 10 ? new Date() : null }
    )
    await pool.query(
      `INSERT INTO sales_agent_commissions (id,sales_agent_id,store_id,order_id,type,amount,status,created_at,settled_at)
       VALUES (:id,'MIG_SALES','MIG_STORE',:orderId,'sales_agent_commission',3,:status,NOW(),:settledAt)`,
      { id: `MIG_SALES_FIN_${suffix}`, orderId: id, status: normal && index === 10 ? "settled" : "unsettled", settledAt: normal && index === 10 ? new Date() : null }
    )
  }
}

async function semanticSnapshot(pool) {
  const queries = {
    orders: "SELECT id,status,payment_status,transaction_id,user_id,user_token,refund_status,amount FROM orders ORDER BY id",
    products: "SELECT id,stock,stock_mode,inventory_version FROM products ORDER BY id",
    items: "SELECT id,order_id,product_id,quantity,inventory_mode,paid_amount_cents FROM order_items ORDER BY id",
    facts: "SELECT id,order_id,transaction_id,payment_state,amount_verified FROM order_payment_facts ORDER BY id",
    releases: "SELECT order_item_id,order_id,product_id,quantity,reason FROM order_inventory_releases ORDER BY order_item_id",
    refunds: "SELECT id,order_id,refund_no,wechat_refund_id,requested_amount_cents,success_amount_cents,status FROM refund_records ORDER BY id",
    refundItems: "SELECT id,refund_record_id,order_item_id,refund_quantity,product_refund_cents,status FROM refund_items ORDER BY id",
    rewards: "SELECT id,order_id,amount,status FROM reward_records ORDER BY id",
    storeFinance: "SELECT id,order_id,amount,status,settled_at FROM store_settlement_records ORDER BY id",
    salesFinance: "SELECT id,order_id,amount,status,settled_at FROM sales_agent_commissions ORDER BY id",
    relations: "SELECT id,inviter_phone,invitee_phone,level FROM promotion_relations ORDER BY id",
    pickup: "SELECT code,order_id FROM pickup_code_claims ORDER BY code",
    idempotency: "SELECT user_id,operation,request_key,request_hash,order_id,expires_at FROM order_idempotency_keys ORDER BY id"
  }
  const result = {}
  for (const [key, sql] of Object.entries(queries)) result[key] = (await pool.query(sql))[0]
  return result
}

async function addControlledLegacyAuditFacts(pool) {
  await pool.query(
    `INSERT INTO order_inventory_reservations (order_item_id,order_id,product_id,quantity,created_at)
     SELECT id,order_id,product_id,quantity,NOW() FROM order_items WHERE inventory_mode='FINITE'`
  )
  const [releases] = await pool.query("SELECT order_item_id,order_id,product_id,quantity FROM order_inventory_releases WHERE quantity>0")
  for (const row of releases) {
    const businessKey = `legacy_release:${row.order_item_id}`
    await pool.query(
      `INSERT INTO order_inventory_release_events
        (id,business_key,order_item_id,order_id,product_id,quantity,reason,source_type,source_id,created_at)
       VALUES (:id,:businessKey,:orderItemId,:orderId,:productId,:quantity,'虚构旧释放审计事实','legacy_release',:sourceId,NOW())`,
      {
        id: `IRE${crypto.createHash("sha256").update(businessKey).digest("hex").slice(0, 52)}`,
        businessKey, orderItemId: row.order_item_id, orderId: row.order_id, productId: row.product_id,
        quantity: Number(row.quantity), sourceId: row.order_item_id
      }
    )
  }
}

async function orderSnapshot(pool, orderIds) {
  const result = {}
  for (const table of [
    "orders", "order_items", "order_payment_facts", "order_inventory_releases", "order_inventory_release_events",
    "order_inventory_reservations", "refund_records", "reward_records", "store_settlement_records",
    "sales_agent_commissions", "pickup_code_claims", "order_idempotency_keys", "order_state_audit",
    "order_notification_records", "wechat_fulfillment_records"
  ]) {
    const orderColumn = table === "orders" ? "id" : "order_id"
    const [rows] = await pool.query(`SELECT * FROM \`${table}\` WHERE \`${orderColumn}\` IN (${orderIds.map(() => "?").join(",")}) ORDER BY 1`, orderIds)
    result[table] = rows
  }
  return result
}

async function postJson(url, body, headers = {}) {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) })
  return { status: response.status, body: await response.json().catch(() => ({})) }
}

async function count(pool, sql, params = []) {
  const [[row]] = await pool.query(sql, params)
  return Number(row.count || 0)
}

async function main() {
  const env = envConfig()
  const pool = mysql.createPool(connectionConfig(env))
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "migration-rehearsal-"))
  const whitelistFile = path.join(tempDir, "migration-order-whitelist.json")
  let service
  const checks = []
  const check = (name, value) => { assert(value, name); checks.push(name) }
  try {
    await resetDatabase(pool)
    service = await startService({ port: Number(process.env.MIGRATION_TEST_SCHEMA_PORT || 33221), disableWorkers: true })
    await stopService(service)
    service = null
    await buildOldProductionShape(pool)
    await seedOldFixture(pool)
    const oldSchema = await schemaSnapshot(pool)
    check("01 旧结构未提前创建新表", !oldSchema.tables.includes("payment_finance_outbox") && !oldSchema.tables.includes("order_inventory_release_events"))
    const beforeMigration = await semanticSnapshot(pool)
    const preflightConnection = await pool.getConnection()
    let preflight
    try { preflight = await inspectMigrationReadiness(preflightConnection, env) } finally { preflightConnection.release() }
    check("02 preflight严格只读并识别缺失对象", preflight.readOnly && preflight.missingTables.length >= 7 && preflight.userTokenCount === 12)
    check("03 preflight无虚构数据异常", preflight.ok && preflight.manualReviewCount === 0)

    const first = await runMigrations({ env, logger: SILENT })
    check("04 旧结构第一次迁移成功", first.ok && first.migrationFileCount === 7)
    check("05 新表全部创建", first.addedTables.includes("payment_finance_outbox") && first.addedTables.includes("order_payment_timeout_jobs") && first.addedTables.includes("order_inventory_release_events"))
    check("06 新字段全部创建", first.addedColumns.includes("orders.payment_expires_at") && first.addedColumns.includes("order_inventory_releases.updated_at"))
    check("07 迁移不删除或修改旧业务数据", JSON.stringify(await semanticSnapshot(pool)) === JSON.stringify(beforeMigration))
    const migratedSchema = await schemaSnapshot(pool)
    const requiredIndexes = [
      "payment_finance_outbox.uniq_payment_finance_business", "payment_finance_outbox.idx_payment_finance_due",
      "order_payment_timeout_jobs.idx_payment_timeout_due", "orders.idx_orders_payment_timeout",
      "order_inventory_release_events.uniq_inventory_release_event_business", "refund_items.idx_refund_item_order_item",
      "reward_records.uniq_reward_business", "store_settlement_records.uniq_store_settlement_business",
      "sales_agent_commissions.uniq_sales_agent_business", "promotion_relation_claims.PRIMARY",
      "order_idempotency_keys.uniq_order_idempotency_scope", "pickup_code_claims.uniq_pickup_code_order"
    ]
    check("08 唯一和Worker索引全部存在", requiredIndexes.every(index => migratedSchema.indexes.includes(index)))
    const [[timeoutColumn]] = await pool.query("SELECT column_type AS column_type,is_nullable AS is_nullable,column_default AS column_default,extra AS extra FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='order_payment_timeout_jobs' AND column_name='id'")
    check("09 超时任务结构与当前Worker一致", timeoutColumn.column_type === "bigint unsigned" && timeoutColumn.extra.includes("auto_increment"))
    const [engines] = await pool.query("SELECT engine AS engine,table_collation AS table_collation FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name IN ('payment_finance_outbox','order_payment_timeout_jobs','order_inventory_reservations','order_inventory_release_events')")
    check("10 新表引擎和字符集正确", engines.length === 4 && engines.every(row => row.engine === "InnoDB" && row.table_collation === "utf8mb4_unicode_ci"))

    const beforeSecond = await semanticSnapshot(pool)
    const schemaBeforeSecond = await schemaSnapshot(pool)
    const second = await runMigrations({ env, logger: SILENT })
    check("11 第二次完整迁移安全", second.ok && second.executions.every(item => item.exitCode === 0))
    check("12 第二次迁移不改变业务数据", JSON.stringify(await semanticSnapshot(pool)) === JSON.stringify(beforeSecond))
    check("13 第二次迁移不改变迁移对象", JSON.stringify(await schemaSnapshot(pool)) === JSON.stringify(schemaBeforeSecond))

    await pool.query("INSERT INTO promotion_relations (id,invitee_phone,created_at) SELECT 'MIG_DUPLICATE',invitee_phone,NOW() FROM promotion_relations ORDER BY id LIMIT 1")
    const schemaBeforeDuplicateGate = await schemaSnapshot(pool)
    await assert.rejects(() => runMigrations({ env, logger: SILENT }), /MANUAL_REVIEW/)
    check("14 重复数据使唯一索引迁移安全停止", JSON.stringify(await schemaSnapshot(pool)) === JSON.stringify(schemaBeforeDuplicateGate))
    await pool.query("DELETE FROM promotion_relations WHERE id='MIG_DUPLICATE'")

    await addControlledLegacyAuditFacts(pool)
    const rowsBeforeStartup = await semanticSnapshot(pool)
    const schemaBeforeStartup = await schemaSnapshot(pool)
    service = await startService({ port: Number(process.env.MIGRATION_TEST_SERVICE_PORT || 33222), disableWorkers: false })
    await new Promise(resolve => setTimeout(resolve, 1200))
    check("15 真实新服务健康启动", service.child.exitCode == null && (await fetch(`${service.baseUrl}/api/home`)).ok)
    check("16 服务启动未补建历史财务或改订单状态", JSON.stringify(await semanticSnapshot(pool)) === JSON.stringify(rowsBeforeStartup))
    check("17 服务启动未补建结构", JSON.stringify(await schemaSnapshot(pool)) === JSON.stringify(schemaBeforeStartup))
    check("18 支付和超时Worker可稳定启动", !/worker.*error|retry.*storm|启动失败/i.test(service.output()))
    check("19 AI预览默认关闭", (await postJson(`${service.baseUrl}/api/ai/preview`, {})).status === 404)

    fs.writeFileSync(whitelistFile, JSON.stringify({ orderIds: TEST_ORDERS }))
    const outsideBefore = await orderSnapshot(pool, NORMAL_ORDERS)
    const masterCounts = {
      customers: await count(pool, "SELECT COUNT(*) AS count FROM customers"),
      products: await count(pool, "SELECT COUNT(*) AS count FROM products"),
      stores: await count(pool, "SELECT COUNT(*) AS count FROM partner_stores"),
      members: await count(pool, "SELECT COUNT(*) AS count FROM store_members"),
      sales: await count(pool, "SELECT COUNT(*) AS count FROM sales_agents")
    }
    const cleanupEnv = {
      ...env,
      MYSQL_TEST_DATABASE: REQUIRED_DATABASE
    }
    const dryRun = await runCleanup({ argv: [`--whitelist-file=${whitelistFile}`], env: cleanupEnv, logger: SILENT })
    check("20 迁移后清理dry-run识别10笔", dryRun.exitCode === 0 && dryRun.report.automaticDeleteCount === 10 && dryRun.report.manualReviewCount === 0)
    const apply = await runCleanup({ argv: [`--whitelist-file=${whitelistFile}`, "--apply", "--confirm-delete-test-orders"], env: cleanupEnv, logger: SILENT })
    check("21 迁移后清理apply只删除10笔", apply.exitCode === 0 && apply.report.deleted.orders === 10)
    check("22 白名单外2笔逐行不变", JSON.stringify(await orderSnapshot(pool, NORMAL_ORDERS)) === JSON.stringify(outsideBefore))
    check("23 主数据不删除", masterCounts.customers === await count(pool, "SELECT COUNT(*) AS count FROM customers") && masterCounts.products === await count(pool, "SELECT COUNT(*) AS count FROM products") && masterCounts.stores === await count(pool, "SELECT COUNT(*) AS count FROM partner_stores") && masterCounts.members === await count(pool, "SELECT COUNT(*) AS count FROM store_members") && masterCounts.sales === await count(pool, "SELECT COUNT(*) AS count FROM sales_agents"))
    const repeat = await runCleanup({ argv: [`--whitelist-file=${whitelistFile}`, "--apply", "--confirm-delete-test-orders"], env: cleanupEnv, logger: SILENT })
    check("24 清理重复执行幂等", repeat.exitCode === 0 && repeat.report.notFoundCount === 10 && repeat.report.deleted.orders === 0)

    await pool.query("INSERT INTO products (id,name,price,status,stock,stock_mode,inventory_version) VALUES ('MIG_API_PRODUCT','虚构API商品',10,'on',2,'FINITE',0)")
    const login = await postJson(`${service.baseUrl}/api/wechat/openid`, { code: "migration-isolated-login" })
    const token = String(login.body.userSession || login.body.userToken || "")
    assert(token)
    const created = await postJson(`${service.baseUrl}/api/orders`, {
      productId: "MIG_API_PRODUCT", quantity: 1, customerName: "虚构API客户", deliveryType: "delivery", requestKey: "migration-new-order"
    }, { "x-user-session": token })
    check(`25 迁移后真实新订单创建成功（status=${created.status}, message=${created.body.message || ""}, logs=${service.output().slice(-1200)}）`, created.status === 200)
    const [[newOrder]] = await pool.query("SELECT id,user_id,user_token FROM orders WHERE product_id='MIG_API_PRODUCT' ORDER BY created_at DESC LIMIT 1")
    check("26 新订单不写user_token且使用user_id", !!newOrder.user_id && !newOrder.user_token)

    const consistency = {
      negativeStock: await count(pool, "SELECT COUNT(*) AS count FROM products WHERE stock<0"),
      releaseExceedsOrdered: await count(pool, "SELECT COUNT(*) AS count FROM order_inventory_releases r JOIN order_items oi ON oi.id=r.order_item_id WHERE r.quantity>oi.quantity"),
      releaseEventMismatch: await count(pool, "SELECT COUNT(*) AS count FROM order_inventory_releases r LEFT JOIN (SELECT order_item_id,SUM(quantity) quantity FROM order_inventory_release_events GROUP BY order_item_id) e ON e.order_item_id=r.order_item_id WHERE r.quantity<>COALESCE(e.quantity,0)"),
      duplicateFinanceKeys: await count(pool, "SELECT COUNT(*) AS count FROM (SELECT business_key FROM reward_records WHERE business_key IS NOT NULL AND business_key<>'' GROUP BY business_key HAVING COUNT(*)>1) x") + await count(pool, "SELECT COUNT(*) AS count FROM (SELECT business_key FROM store_settlement_records WHERE business_key IS NOT NULL AND business_key<>'' GROUP BY business_key HAVING COUNT(*)>1) x") + await count(pool, "SELECT COUNT(*) AS count FROM (SELECT business_key FROM sales_agent_commissions WHERE business_key IS NOT NULL AND business_key<>'' GROUP BY business_key HAVING COUNT(*)>1) x"),
      duplicateOutboxKeys: await count(pool, "SELECT COUNT(*) AS count FROM (SELECT business_key FROM payment_finance_outbox GROUP BY business_key HAVING COUNT(*)>1) x"),
      duplicateTransactions: await count(pool, "SELECT COUNT(*) AS count FROM (SELECT transaction_id FROM order_payment_facts WHERE transaction_id IS NOT NULL AND transaction_id<>'' GROUP BY transaction_id HAVING COUNT(DISTINCT order_id)>1) x"),
      orphanOrderItems: await count(pool, "SELECT COUNT(*) AS count FROM order_items oi LEFT JOIN orders o ON o.id=oi.order_id WHERE o.id IS NULL"),
      orphanRefundItems: await count(pool, "SELECT COUNT(*) AS count FROM refund_items ri LEFT JOIN refund_records rr ON rr.id=ri.refund_record_id WHERE rr.id IS NULL"),
      orphanInventoryEvents: await count(pool, "SELECT COUNT(*) AS count FROM order_inventory_release_events e LEFT JOIN order_items oi ON oi.id=e.order_item_id WHERE oi.id IS NULL"),
      orphanOutbox: await count(pool, "SELECT COUNT(*) AS count FROM payment_finance_outbox p LEFT JOIN orders o ON o.id=p.aggregate_id WHERE p.aggregate_type='ORDER' AND o.id IS NULL"),
      newOrderUserToken: await count(pool, "SELECT COUNT(*) AS count FROM orders WHERE id=? AND user_token IS NOT NULL AND user_token<>''", [newOrder.id]),
      failedWorkerTasks: await count(pool, "SELECT COUNT(*) AS count FROM payment_finance_outbox WHERE status='FAILED'") + await count(pool, "SELECT COUNT(*) AS count FROM order_payment_timeout_jobs WHERE status='FAILED'")
    }
    check("27 数据一致性终检全部为0", Object.values(consistency).every(value => value === 0))
    check("28 Worker没有失败任务积压", consistency.failedWorkerTasks === 0)
    check("29 启动未清理旧user_token", await count(pool, "SELECT COUNT(*) AS count FROM orders WHERE id IN (?,?) AND user_token IS NOT NULL AND user_token<>''", NORMAL_ORDERS) === 2)
    check("30 未发送外部通知或调用外部支付AI", !/https:\/\/qyapi\.weixin|api\.mch\.weixin|api\.openai/i.test(service.output()))

    console.log(JSON.stringify({
      ok: true,
      database: REQUIRED_DATABASE,
      migrationFiles: first.migrationFileCount,
      firstExecutionLog: first.executions,
      firstMigration: "PASS",
      secondMigration: "PASS",
      secondMigrationBusinessDataChanges: 0,
      serviceStartup: "PASS",
      startupHistoricalWrites: 0,
      cleanupDryRun: dryRun.report.automaticDeleteCount,
      cleanupApply: apply.report.deleted.orders,
      outsideOrdersChanged: 0,
      newOrderUserToken: consistency.newOrderUserToken,
      consistencyAnomalies: Object.values(consistency).reduce((sum, value) => sum + value, 0),
      checkCount: checks.length,
      checks
    }, null, 2))
  } finally {
    await stopService(service).catch(() => {})
    await pool.end().catch(() => {})
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

main().catch(error => {
  console.error(error.stack || error.message)
  process.exit(1)
})
