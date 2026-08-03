"use strict"

const assert = require("assert")
const crypto = require("crypto")
const { spawn } = require("child_process")
const mysql = require("mysql2/promise")

const PROJECT_ROOT = require("path").resolve(__dirname, "..")
const HTTP_PORT = Number(process.env.MYSQL_TEST_HTTP_PORT || 3188)
const BASE_URL = `http://127.0.0.1:${HTTP_PORT}`

function safeConfig() {
  if (String(process.env.NODE_ENV || "").toLowerCase() === "production") {
    throw new Error("安全拒绝：不能在 production 环境运行订单归属测试")
  }
  const host = String(process.env.MYSQL_HOST || "127.0.0.1").trim()
  if (!/^(127\.0\.0\.1|localhost)$/i.test(host)) {
    throw new Error("安全拒绝：订单归属测试只允许 127.0.0.1 或 localhost")
  }
  const database = String(process.env.MYSQL_TEST_DATABASE || "").trim()
  if (!database) throw new Error("缺少 MYSQL_TEST_DATABASE")
  if (!/^vsc_security_test_[a-z0-9_]+$/i.test(database)) {
    throw new Error("安全拒绝：MYSQL_TEST_DATABASE 必须以 vsc_security_test_ 开头")
  }
  if (!process.env.MYSQL_USER) throw new Error("缺少 MYSQL_USER")
  return {
    host,
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD || "",
    database,
    namedPlaceholders: true,
    dateStrings: true
  }
}

function tokenHash(token) {
  return crypto.createHash("sha256").update(token).digest("hex")
}

async function request(pathname, options = {}) {
  const response = await fetch(new URL(pathname, BASE_URL), {
    method: options.method || "GET",
    headers: {
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(options.origin ? { origin: BASE_URL } : {}),
      ...(options.token ? { "x-user-session": options.token } : {}),
      ...(options.headers || {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  })
  const payload = await response.json().catch(() => ({}))
  return { status: response.status, payload, headers: response.headers }
}

async function waitForServer(child) {
  let lastError = ""
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode != null) throw new Error(`隔离服务提前退出：${child.exitCode}`)
    try {
      const health = await request("/api/health")
      if (health.status === 200 && health.payload.storage === "mysql") return
      lastError = `HTTP ${health.status}`
    } catch (error) {
      lastError = error.message
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`隔离服务启动超时：${lastError}`)
}

async function insertIdentity(pool, identity, token) {
  await pool.query(
    `INSERT INTO customers (id, name, nickname, phone, openid, orders, total_amount, last_contact, shopping_money)
     VALUES (:id, :name, :name, :phone, :openid, 0, 0, '2026-08-04', 0)`,
    identity
  )
  await pool.query(
    `INSERT INTO user_sessions (token_hash, openid, phone, created_at, expires_at, updated_at)
     VALUES (:tokenHash, :openid, :phone, NOW(), DATE_ADD(NOW(), INTERVAL 7 DAY), NOW())`,
    { tokenHash: tokenHash(token), openid: identity.openid, phone: identity.phone }
  )
}

async function main() {
  const config = safeConfig()
  const serverConfig = { ...config }
  delete serverConfig.database
  const root = await mysql.createConnection(serverConfig)
  await root.query(`DROP DATABASE IF EXISTS \`${config.database}\``)
  await root.query(`CREATE DATABASE \`${config.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`)
  await root.end()

  const child = spawn(process.execPath, ["cms/server.js"], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      MYSQL_TEST_SKIP_DOTENV: "true",
      MYSQL_TEST_ISOLATED: "true",
      MYSQL_TEST_DISABLE_WORKERS: "true",
      MYSQL_TEST_SKIP_SEED_DATA: "true",
      NODE_ENV: "test",
      STORAGE_MODE: "mysql",
      MYSQL_HOST: config.host,
      MYSQL_PORT: String(config.port),
      MYSQL_USER: config.user,
      MYSQL_PASSWORD: config.password,
      MYSQL_DATABASE: config.database,
      PORT: String(HTTP_PORT),
      ENABLE_HTTPS: "false",
      PAY_MOCK: "true",
      ADMIN_USER: "order_ownership_admin",
      ADMIN_PASSWORD: "fictional-order-ownership-admin-password"
    },
    stdio: ["ignore", "pipe", "pipe"]
  })
  let serverLog = ""
  child.stdout.on("data", chunk => { serverLog += chunk.toString() })
  child.stderr.on("data", chunk => { serverLog += chunk.toString() })

  let pool
  try {
    await waitForServer(child)
    pool = mysql.createPool({ ...config, connectionLimit: 4 })
    const userA = { id: "USER-A-INTERNAL", name: "虚构用户甲", phone: "13900000001", openid: "openid-fictional-a" }
    const userB = { id: "USER-B-INTERNAL", name: "虚构用户乙", phone: "13900000002", openid: "openid-fictional-b" }
    const tokenA1 = "fictional-session-a-first"
    const tokenA2 = "fictional-session-a-second"
    const tokenB = "fictional-session-b"
    await insertIdentity(pool, userA, tokenA1)
    await insertIdentity(pool, userB, tokenB)
    await pool.query(
      `INSERT INTO products (id, name, price, status, stock, stock_mode, inventory_version, product_type)
       VALUES ('PRODUCT-OWNERSHIP', '虚构归属测试商品', 9.90, 'on', 20, 'FINITE', 0, 'normal')`
    )

    const created = await request("/api/orders", {
      method: "POST",
      token: tokenA1,
      body: {
        productId: "PRODUCT-OWNERSHIP",
        quantity: 1,
        customerName: "虚构收货人",
        deliveryType: "delivery",
        address: "虚构测试地址",
        requestKey: "ownership-order-a-1",
        userId: userB.id,
        openid: userB.openid,
        phone: userB.phone,
        userToken: "plaintext-body-token-must-be-ignored",
        token: "plaintext-body-token-must-be-ignored"
      }
    })
    assert.strictEqual(created.status, 200, JSON.stringify(created.payload))
    const orderId = created.payload.data.id
    const [[orderRow]] = await pool.query(
      "SELECT id, user_id, openid, phone, user_token FROM orders WHERE id=:orderId",
      { orderId }
    )
    assert.strictEqual(orderRow.user_id, userA.id, "订单必须归属 Session 对应的内部 user_id")
    assert.strictEqual(orderRow.openid, userA.openid, "伪造 openid 必须无效")
    assert.strictEqual(orderRow.phone, userA.phone, "伪造手机号必须无效")
    assert.ok(orderRow.user_token == null || orderRow.user_token === "", "新订单 user_token 必须为空")

    const listA = await request("/api/orders", { token: tokenA1 })
    assert.strictEqual(listA.status, 200)
    assert.ok(listA.payload.some(order => order.id === orderId), "用户 A 列表应包含自己的订单")
    const detailA = await request(`/api/orders/${encodeURIComponent(orderId)}`, { token: tokenA1 })
    assert.strictEqual(detailA.status, 200)

    const listB = await request("/api/orders", { token: tokenB })
    assert.strictEqual(listB.status, 200)
    assert.ok(!listB.payload.some(order => order.id === orderId), "用户 B 列表不得出现用户 A 订单")
    const detailB = await request(`/api/orders/${encodeURIComponent(orderId)}`, { token: tokenB })
    assert.strictEqual(detailB.status, 404, "用户 B 不得读取用户 A 订单详情")
    const payB = await request("/api/pay/wechat", { method: "POST", token: tokenB, body: { orderId } })
    assert.strictEqual(payB.status, 403, "用户 B 不得支付用户 A 订单")

    await pool.query(
      "UPDATE orders SET status='待发货', payment_status='已支付', paid_at=NOW(), transaction_id='FICTIONAL-PAID-A' WHERE id=:orderId",
      { orderId }
    )
    const refundB = await request("/api/orders/refund", {
      method: "POST",
      token: tokenB,
      body: { orderId, refundType: "退款", refundReason: "虚构越权退款" }
    })
    assert.notStrictEqual(refundB.status, 200, "用户 B 不得申请用户 A 订单退款")
    const afterSalesB = await request(`/api/orders/${encodeURIComponent(orderId)}/after-sales/apply`, {
      method: "POST",
      token: tokenB,
      body: { afterSalesType: "补发", afterSalesReason: "虚构越权售后" }
    })
    assert.notStrictEqual(afterSalesB.status, 200, "用户 B 不得申请用户 A 订单售后")
    const [[unchangedAfterSales]] = await pool.query(
      "SELECT after_sales_status, after_sales_apply_count FROM orders WHERE id=:orderId",
      { orderId }
    )
    assert.ok(!unchangedAfterSales.after_sales_status || unchangedAfterSales.after_sales_status === "none")
    assert.strictEqual(Number(unchangedAfterSales.after_sales_apply_count || 0), 0)

    const logoutA = await request("/api/auth/logout", { method: "POST", token: tokenA1, origin: true })
    assert.strictEqual(logoutA.status, 200)
    const oldSession = await request("/api/orders", { token: tokenA1 })
    assert.strictEqual(oldSession.status, 401, "注销后的旧 Session 必须失效")
    await pool.query(
      `INSERT INTO user_sessions (token_hash, openid, phone, created_at, expires_at, updated_at)
       VALUES (:tokenHash, :openid, :phone, NOW(), DATE_ADD(NOW(), INTERVAL 7 DAY), NOW())`,
      { tokenHash: tokenHash(tokenA2), openid: userA.openid, phone: userA.phone }
    )
    const reloginList = await request("/api/orders", { token: tokenA2 })
    assert.strictEqual(reloginList.status, 200)
    assert.ok(reloginList.payload.some(order => order.id === orderId), "重新登录后必须通过 user_id 看到历史订单")

    const legacyTokenAttempt = await request(`/api/orders?userToken=${encodeURIComponent("plaintext-body-token-must-be-ignored")}`)
    assert.strictEqual(legacyTokenAttempt.status, 401, "旧 token 参数路径不得访问新订单")
    const legacyHeaderAttempt = await request("/api/orders", {
      headers: { "x-user-token": "plaintext-body-token-must-be-ignored" }
    })
    assert.strictEqual(legacyHeaderAttempt.status, 401, "旧 token 请求头路径不得访问新订单")

    const login = await request("/api/auth/login", {
      method: "POST",
      origin: true,
      body: { username: "order_ownership_admin", password: "fictional-order-ownership-admin-password" }
    })
    assert.strictEqual(login.status, 200)
    const cookie = String(login.headers.get("set-cookie") || "").split(";")[0]
    assert.ok(cookie)
    const adminCreate = await request("/api/admin/orders", {
      method: "PUT",
      origin: true,
      headers: { cookie },
      body: [{
        id: "ADMIN-FORGED-ORDER",
        customerName: "虚构后台客户",
        productName: "虚构后台订单",
        amount: "1.00",
        status: "待支付",
        paymentStatus: "待支付",
        userId: userB.id,
        userToken: "plaintext-admin-token-must-not-save"
      }]
    })
    assert.strictEqual(adminCreate.status, 400, "后台编辑接口不得创建或导入新订单")
    const [[adminCount]] = await pool.query("SELECT COUNT(*) count FROM orders WHERE id='ADMIN-FORGED-ORDER'")
    assert.strictEqual(Number(adminCount.count), 0)

    const currentOrder = (await request(`/api/orders/${encodeURIComponent(orderId)}`, { token: tokenA2 })).payload
    const adminEdit = await request("/api/admin/orders", {
      method: "PUT",
      origin: true,
      headers: { cookie },
      body: [{ ...currentOrder, remark: "虚构后台编辑", userToken: "plaintext-admin-token-must-not-save" }]
    })
    assert.strictEqual(adminEdit.status, 200, JSON.stringify(adminEdit.payload))
    const [[afterAdminEdit]] = await pool.query("SELECT user_id, user_token FROM orders WHERE id=:orderId", { orderId })
    assert.strictEqual(afterAdminEdit.user_id, userA.id)
    assert.ok(afterAdminEdit.user_token == null || afterAdminEdit.user_token === "")

    await pool.query(
      `INSERT INTO orders
        (id, customer_name, phone, product_name, amount, status, payment_status, user_id, user_token, created_at)
       VALUES
        ('LEGACY-TOKEN-FIXTURE', '虚构历史客户', :phone, '虚构历史商品', 1.00, '已完成', '已支付', NULL,
         'fictional-legacy-token-preserved', '2025-01-01 00:00:00')`,
      { phone: userA.phone }
    )
    const adminOrders = await request("/api/admin/orders", { headers: { cookie } })
    assert.strictEqual(adminOrders.status, 200)
    const legacyOrder = adminOrders.payload.find(order => order.id === "LEGACY-TOKEN-FIXTURE")
    assert.ok(legacyOrder)
    const legacyEdit = await request("/api/admin/orders", {
      method: "PUT",
      origin: true,
      headers: { cookie },
      body: [{ ...legacyOrder, remark: "虚构历史订单编辑" }]
    })
    assert.strictEqual(legacyEdit.status, 200)
    const [[legacyAfterEdit]] = await pool.query(
      "SELECT user_token FROM orders WHERE id='LEGACY-TOKEN-FIXTURE'"
    )
    assert.strictEqual(legacyAfterEdit.user_token, "fictional-legacy-token-preserved", "编辑历史订单不得清除旧兼容字段")

    const [[rawTokenCount]] = await pool.query(
      "SELECT COUNT(*) count FROM orders WHERE id<>'LEGACY-TOKEN-FIXTURE' AND COALESCE(user_token,'')<>''"
    )
    assert.strictEqual(Number(rawTokenCount.count), 0, "专项隔离库不得存在新写入的 orders.user_token")
    console.log(JSON.stringify({
      status: "PASS",
      orderId,
      userId: orderRow.user_id,
      userToken: orderRow.user_token,
      forgedIdentityIgnored: true,
      userBListDenied: true,
      userBDetailDenied: true,
      userBPaymentDenied: true,
      userBRefundDenied: true,
      userBAfterSalesDenied: true,
      oldSessionRevoked: true,
      reloginHistoryVisible: true,
      legacyTokenDenied: true,
      adminCreateDenied: true,
      adminEditDidNotWriteToken: true,
      legacyTokenPreservedOnEdit: true
    }, null, 2))
  } catch (error) {
    if (serverLog) console.error(serverLog.slice(-12000))
    throw error
  } finally {
    if (pool) await pool.end().catch(() => {})
    child.kill("SIGTERM")
    await new Promise(resolve => {
      if (child.exitCode != null) return resolve()
      child.once("exit", resolve)
      setTimeout(() => {
        child.kill("SIGKILL")
        resolve()
      }, 3000).unref()
    })
  }
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
