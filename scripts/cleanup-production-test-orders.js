#!/usr/bin/env node
"use strict"

const fs = require("fs")
const path = require("path")
const mysql = require("mysql2/promise")
const { releaseOrderItemInventory } = require("../cms/inventory-ledger")
const guard = require("./lib/production-operation-guard")
const { structuralFingerprint } = require("./preflight-production-migration")

const MAX_ORDERS = 20
const REQUIRED_DATABASE = "vsc_security_test_order_cleanup"
const ALLOWED_DATABASES = new Set([REQUIRED_DATABASE, "vsc_security_test_migration_rehearsal", "vsc_security_test_production_entry_rehearsal"])
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost"])
const SETTLED_STATUSES = new Set(["settled", "completed", "paid", "confirmed", "已结算", "已支付"])

const DIRECT_TABLES = [
  "pickup_code_claims",
  "order_request_keys",
  "order_idempotency_keys",
  "order_state_audit",
  "order_payment_facts",
  "order_payment_timeout_jobs",
  "order_notification_records",
  "wechat_fulfillment_records",
  "financial_record_item_allocations",
  "reward_records",
  "store_settlement_records",
  "sales_agent_commissions",
  "order_inventory_release_events",
  "order_inventory_releases",
  "order_inventory_reservations"
]

const KNOWN_ASSOCIATIONS = new Map([
  ["orders", ["id", "transaction_id", "refund_id", "refund_no"]],
  ["order_items", ["order_id", "id"]],
  ["refund_records", ["order_id", "id", "refund_no", "wechat_refund_id"]],
  ["refund_items", ["refund_record_id", "order_item_id"]],
  ["payment_finance_outbox", ["aggregate_id", "business_key"]],
  ["store_referral_attributions", ["last_order_id"]],
  ...DIRECT_TABLES.map(table => [table, table === "order_payment_facts"
    ? ["order_id", "transaction_id"]
    : table === "order_inventory_release_events"
      ? ["order_id", "order_item_id", "business_key", "source_id"]
      : table === "order_inventory_releases" || table === "order_inventory_reservations"
        ? ["order_id", "order_item_id"]
        : table === "financial_record_item_allocations"
          ? ["order_id", "order_item_id", "record_id"]
          : table === "sales_agent_commissions"
            ? ["order_id", "order_no", "business_key", "related_record_id"]
            : ["order_id", "business_key", "related_record_id"]])
])

const DELETE_ORDER = [
  "refund_items",
  "financial_record_item_allocations",
  "payment_finance_outbox",
  "order_notification_records",
  "wechat_fulfillment_records",
  "order_payment_timeout_jobs",
  "order_state_audit",
  "order_payment_facts",
  "pickup_code_claims",
  "order_request_keys",
  "order_idempotency_keys",
  "reward_records",
  "store_settlement_records",
  "sales_agent_commissions",
  "refund_records",
  "order_inventory_release_events",
  "order_inventory_releases",
  "order_inventory_reservations",
  "order_items",
  "orders"
]

function usage() {
  return [
    "默认 dry-run：node scripts/cleanup-production-test-orders.js --whitelist-file=/absolute/path/order-whitelist.json",
    "实际删除：追加 --apply --confirm-delete-test-orders"
  ].join("\n")
}

function parseArgs(argv) {
  const common = guard.parseCommonOperationArgs(argv)
  const args = { ...common, confirmed: false, whitelistFile: "", expectedCount: "", confirmExactCount: "", outputCleanupPlan: "", cleanupPlan: "", cleanupPlanSha256: "" }
  for (const arg of argv) {
    if (arg === "--apply") args.apply = true
    else if (arg === "--confirm-delete-test-orders") args.confirmed = true
    else if (arg.startsWith("--whitelist-file=")) args.whitelistFile = arg.slice("--whitelist-file=".length)
    else if (arg === "--production" || arg === "--rehearsal" || arg === "--dry-run" || arg === "--confirm-production" || arg === "--read-only") continue
    else if (/^--(expected-database|expected-server-uuid|expected-git-sha|backup-manifest|operation-log)=/.test(arg)) continue
    else if (arg.startsWith("--expected-count=")) args.expectedCount = arg.slice("--expected-count=".length)
    else if (arg.startsWith("--confirm-exact-count=")) args.confirmExactCount = arg.slice("--confirm-exact-count=".length)
    else if (arg.startsWith("--output-cleanup-plan=")) args.outputCleanupPlan = arg.slice("--output-cleanup-plan=".length)
    else if (arg.startsWith("--cleanup-plan=")) args.cleanupPlan = arg.slice("--cleanup-plan=".length)
    else if (arg.startsWith("--cleanup-plan-sha256=")) args.cleanupPlanSha256 = arg.slice("--cleanup-plan-sha256=".length)
    else throw new Error(`未知参数：${arg}`)
  }
  return args
}

function assertConnectionSafety(env, args) {
  if (String(env.NODE_ENV || "").trim().toLowerCase() === "production") {
    throw new Error("安全拒绝：NODE_ENV=production")
  }
  const host = String(env.MYSQL_HOST || "").trim()
  if (!LOCAL_HOSTS.has(host.toLowerCase())) throw new Error("安全拒绝：MYSQL_HOST 必须是 127.0.0.1 或 localhost")
  const database = String(env.MYSQL_TEST_DATABASE || "").trim()
  if (!database) throw new Error("安全拒绝：缺少 MYSQL_TEST_DATABASE")
  if (!/^vsc_security_test_[a-z0-9_]+$/i.test(database)) throw new Error("安全拒绝：数据库名必须以 vsc_security_test_ 开头")
  if (!ALLOWED_DATABASES.has(database)) throw new Error(`安全拒绝：本专项只允许已登记的隔离数据库`)
  const user = String(env.MYSQL_TEST_USER || "").trim()
  if (!user) throw new Error("安全拒绝：缺少 MYSQL_TEST_USER 测试用户名")
  if (/prod|production|online|master/i.test(`${host}/${database}/${user}`)) throw new Error("安全拒绝：连接信息疑似生产环境")
  if (args.apply && !args.confirmed) throw new Error("安全拒绝：apply 必须同时提供 --confirm-delete-test-orders")
  return {
    host,
    port: Number(env.MYSQL_TEST_PORT || 3306),
    user,
    password: env.MYSQL_TEST_PASSWORD || "",
    database,
    namedPlaceholders: true,
    dateStrings: true,
    connectionLimit: 4
  }
}

function readWhitelist(filename) {
  if (!filename) throw new Error(`缺少 --whitelist-file\n${usage()}`)
  if (!path.isAbsolute(filename)) throw new Error("白名单文件必须使用绝对路径")
  let payload
  try {
    payload = JSON.parse(fs.readFileSync(filename, "utf8"))
  } catch (error) {
    throw new Error(`无法读取白名单文件：${error.message}`)
  }
  if (!payload || !Array.isArray(payload.orderIds)) throw new Error("白名单格式错误：orderIds 必须是数组")
  const normalized = payload.orderIds.map(value => String(value || "").trim())
  if (normalized.some(value => !value)) throw new Error("白名单不能包含空订单ID")
  if (!normalized.length) throw new Error("白名单不能为空")
  if (normalized.some(value => value.length > 32)) throw new Error("白名单订单ID长度超过 orders.id 上限")
  const unique = [...new Set(normalized)]
  if (unique.length > MAX_ORDERS) throw new Error(`白名单去重后不得超过 ${MAX_ORDERS} 笔`)
  return { orderIds: unique, duplicateCount: normalized.length - unique.length }
}

function maskId(value) {
  const text = String(value || "")
  if (text.length <= 4) return `${text.slice(0, 1)}***`
  return `${text.slice(0, 2)}***${text.slice(-2)}`
}

function placeholders(values, prefix) {
  return values.map((_, index) => `:${prefix}${index}`).join(",")
}

function bind(values, prefix) {
  return Object.fromEntries(values.map((value, index) => [`${prefix}${index}`, value]))
}

async function existingTables(connection) {
  const [rows] = await connection.query(
    "SELECT table_name AS table_name FROM information_schema.tables WHERE table_schema=DATABASE() AND table_type='BASE TABLE'"
  )
  return new Set(rows.map(row => String(row.table_name)))
}

async function assertRequiredSchema(connection, tables) {
  const required = ["orders", "products", "order_items", "order_inventory_releases", "order_inventory_release_events", "order_inventory_reservations"]
  const missing = required.filter(table => !tables.has(table))
  if (missing.length) throw new Error(`隔离库结构不完整，缺少：${missing.join(",")}`)
}

async function loadTargetGraph(connection, orderIds, lock = false) {
  const params = bind(orderIds, "order")
  const inOrders = placeholders(orderIds, "order")
  const [orders] = await connection.query(
    `SELECT * FROM orders WHERE id IN (${inOrders}) ORDER BY id${lock ? " FOR UPDATE" : ""}`,
    params
  )
  const foundIds = orders.map(row => String(row.id))
  if (!foundIds.length) return { orders, items: [], refunds: [], refundItems: [], facts: [] }
  const foundParams = bind(foundIds, "found")
  const inFound = placeholders(foundIds, "found")
  const [items] = await connection.query(
    `SELECT * FROM order_items WHERE order_id IN (${inFound}) ORDER BY order_id,id${lock ? " FOR UPDATE" : ""}`,
    foundParams
  )
  const [refunds] = await connection.query(
    `SELECT * FROM refund_records WHERE order_id IN (${inFound}) ORDER BY order_id,id${lock ? " FOR UPDATE" : ""}`,
    foundParams
  )
  const [facts] = await connection.query(
    `SELECT * FROM order_payment_facts WHERE order_id IN (${inFound}) ORDER BY order_id,id${lock ? " FOR UPDATE" : ""}`,
    foundParams
  )
  const refundIds = refunds.map(row => String(row.id))
  let refundItems = []
  if (refundIds.length) {
    const [rows] = await connection.query(
      `SELECT * FROM refund_items WHERE refund_record_id IN (${placeholders(refundIds, "refund")})${lock ? " FOR UPDATE" : ""}`,
      bind(refundIds, "refund")
    )
    refundItems = rows
  }
  return { orders, items, refunds, refundItems, facts }
}

async function findUnknownAssociations(connection, tables, graph) {
  const [columns] = await connection.query(
    `SELECT table_name AS table_name,column_name AS column_name
     FROM information_schema.columns
     WHERE table_schema=DATABASE()
       AND column_name IN ('order_id','order_no','order_item_id','refund_id','refund_no','wechat_refund_id',
         'refund_record_id','transaction_id','business_key','aggregate_id','last_order_id','source_id','record_id','related_record_id')`
  )
  const unknown = new Map()
  for (const row of columns) {
    const table = String(row.table_name)
    const column = String(row.column_name)
    if (!tables.has(table)) continue
    const knownColumns = KNOWN_ASSOCIATIONS.get(table)
    if (!knownColumns || !knownColumns.includes(column)) {
      if (!unknown.has(table)) unknown.set(table, [])
      unknown.get(table).push(column)
    }
  }
  const values = {
    order_id: graph.orders.map(row => String(row.id)),
    order_no: graph.orders.map(row => String(row.id)),
    last_order_id: graph.orders.map(row => String(row.id)),
    aggregate_id: graph.orders.map(row => String(row.id)),
    order_item_id: graph.items.map(row => String(row.id)),
    refund_id: graph.orders.flatMap(row => [row.refund_id]).concat(graph.refunds.flatMap(row => [row.id, row.refund_no, row.wechat_refund_id])).filter(Boolean).map(String),
    refund_no: graph.orders.flatMap(row => [row.refund_no]).concat(graph.refunds.map(row => row.refund_no)).filter(Boolean).map(String),
    wechat_refund_id: graph.refunds.map(row => row.wechat_refund_id).filter(Boolean).map(String),
    refund_record_id: graph.refunds.map(row => String(row.id)),
    transaction_id: graph.orders.flatMap(row => [row.transaction_id]).concat(graph.facts.map(row => row.transaction_id)).filter(Boolean).map(String),
    source_id: graph.orders.map(row => String(row.id)),
    record_id: [],
    related_record_id: []
  }
  const targetOrderIds = values.order_id
  if (targetOrderIds.length) {
    for (const table of ["reward_records", "store_settlement_records", "sales_agent_commissions"]) {
      if (!tables.has(table)) continue
      const [rows] = await connection.query(
        `SELECT id FROM \`${table}\` WHERE order_id IN (${placeholders(targetOrderIds, "graphOrder")})`, bind(targetOrderIds, "graphOrder")
      )
      values.record_id.push(...rows.map(row => String(row.id)))
      values.related_record_id.push(...rows.map(row => String(row.id)))
    }
    values.source_id.push(...values.refund_record_id)
  }
  const hits = []
  for (const [table, tableColumns] of unknown) {
    for (const column of tableColumns) {
      let count = 0
      if (column === "business_key") {
        const needles = [...new Set(Object.values(values).flat())]
        for (const needle of needles) {
          const [rows] = await connection.query(`SELECT 1 FROM \`${table}\` WHERE \`${column}\` LIKE :needle LIMIT 1`, { needle: `%${needle}%` })
          if (rows.length) { count = 1; break }
        }
      } else if (values[column]?.length) {
        const candidates = [...new Set(values[column])]
        const [rows] = await connection.query(
          `SELECT COUNT(*) AS count FROM \`${table}\` WHERE \`${column}\` IN (${placeholders(candidates, "candidate")})`,
          bind(candidates, "candidate")
        )
        count = Number(rows[0].count || 0)
      }
      hits.push({ table, column, count })
    }
  }
  return hits
}

async function countByTable(connection, tables, graph) {
  const counts = Object.fromEntries(DELETE_ORDER.map(table => [table, 0]))
  const ids = graph.orders.map(row => String(row.id))
  if (!ids.length) return counts
  const orderParams = bind(ids, "countOrder")
  const orderIn = placeholders(ids, "countOrder")
  for (const table of DIRECT_TABLES) {
    if (!tables.has(table)) continue
    const [rows] = await connection.query(
      `SELECT COUNT(*) AS count FROM \`${table}\` WHERE order_id IN (${orderIn})`, orderParams
    )
    counts[table] = Number(rows[0].count || 0)
  }
  counts.orders = graph.orders.length
  counts.order_items = graph.items.length
  counts.refund_records = graph.refunds.length
  counts.refund_items = graph.refundItems.length
  if (tables.has("payment_finance_outbox")) {
    const [rows] = await connection.query(
      `SELECT COUNT(*) AS count FROM payment_finance_outbox WHERE aggregate_type='ORDER' AND aggregate_id IN (${orderIn})`, orderParams
    )
    counts.payment_finance_outbox = Number(rows[0].count || 0)
  }
  return counts
}

function normalizeStatus(value) {
  return String(value || "").trim().toLowerCase()
}

function isSettled(row) {
  return SETTLED_STATUSES.has(normalizeStatus(row.status)) || !!row.settled_at || !!row.batch_id
}

async function reviewOrder(connection, tables, order, graph) {
  const orderId = String(order.id)
  const reasons = []
  const items = graph.items.filter(row => String(row.order_id) === orderId)
  const refunds = graph.refunds.filter(row => String(row.order_id) === orderId)
  const facts = graph.facts.filter(row => String(row.order_id) === orderId)
  const paid = ["已支付", "已退款", "paid", "refunded"].includes(normalizeStatus(order.payment_status))
  const successFacts = facts.filter(row => normalizeStatus(row.payment_state) === "success" && Number(row.amount_verified) === 1)
  if (successFacts.length && !paid) reasons.push("支付事实与订单支付状态矛盾")
  if (paid && order.transaction_id && !successFacts.length) reasons.push("已支付订单缺少可追溯支付事实")
  if (["已退款", "refunded"].includes(normalizeStatus(order.refund_status)) && !refunds.some(row => normalizeStatus(row.status) === "success")) {
    reasons.push("订单退款状态与退款记录矛盾")
  }
  const transactionIds = [...new Set([order.transaction_id, ...facts.map(row => row.transaction_id)].filter(Boolean).map(String))]
  for (const transactionId of transactionIds) {
    const [[sharedOrders]] = await connection.query(
      "SELECT COUNT(DISTINCT id) AS count FROM orders WHERE transaction_id=:transactionId AND id<>:orderId",
      { transactionId, orderId }
    )
    const [[sharedFacts]] = await connection.query(
      "SELECT COUNT(DISTINCT order_id) AS count FROM order_payment_facts WHERE transaction_id=:transactionId AND order_id<>:orderId",
      { transactionId, orderId }
    )
    if (Number(sharedOrders.count) || Number(sharedFacts.count)) reasons.push("transaction_id 被其他订单共享")
  }

  const refundKeys = [...new Set([
    order.refund_id,
    order.refund_no,
    ...refunds.flatMap(row => [row.id, row.refund_no, row.wechat_refund_id])
  ].filter(Boolean).map(String))]
  for (const refundKey of refundKeys) {
    const [[sharedRefunds]] = await connection.query(
      `SELECT COUNT(DISTINCT order_id) AS count FROM refund_records
       WHERE order_id<>:orderId AND (id=:refundKey OR refund_no=:refundKey OR wechat_refund_id=:refundKey)`,
      { orderId, refundKey }
    )
    const [[sharedOrderRefunds]] = await connection.query(
      `SELECT COUNT(DISTINCT id) AS count FROM orders
       WHERE id<>:orderId AND (refund_id=:refundKey OR refund_no=:refundKey)`,
      { orderId, refundKey }
    )
    if (Number(sharedRefunds.count) || Number(sharedOrderRefunds.count)) reasons.push("refund_id 或 refund_no 被其他订单共享")
  }

  const itemIds = items.map(row => String(row.id))
  if (itemIds.length) {
    const [[outsideRefundItems]] = await connection.query(
      `SELECT COUNT(*) AS count FROM refund_items ri
       JOIN refund_records rr ON rr.id=ri.refund_record_id
       WHERE ri.order_item_id IN (${placeholders(itemIds, "reviewItem")}) AND rr.order_id<>:orderId`,
      { ...bind(itemIds, "reviewItem"), orderId }
    )
    if (Number(outsideRefundItems.count)) reasons.push("订单商品被白名单外退款记录引用")
    const [[outsideAllocations]] = await connection.query(
      `SELECT COUNT(*) AS count FROM financial_record_item_allocations
       WHERE order_item_id IN (${placeholders(itemIds, "allocationItem")}) AND order_id<>:orderId`,
      { ...bind(itemIds, "allocationItem"), orderId }
    )
    if (Number(outsideAllocations.count)) reasons.push("订单商品被白名单外财务分摊引用")
  }

  for (const [table, orderColumn] of [
    ["reward_records", "order_id"],
    ["store_settlement_records", "order_id"],
    ["sales_agent_commissions", "order_id"],
    ["order_inventory_release_events", "order_id"],
    ["payment_finance_outbox", "aggregate_id"]
  ]) {
    if (!tables.has(table)) continue
    const qualifier = table === "payment_finance_outbox" ? " AND aggregate_type='ORDER'" : ""
    const [keys] = await connection.query(
      `SELECT business_key FROM \`${table}\` WHERE \`${orderColumn}\`=:orderId${qualifier} AND business_key IS NOT NULL AND business_key<>''`,
      { orderId }
    )
    const businessKeys = [...new Set(keys.map(row => String(row.business_key)))]
    if (!businessKeys.length) continue
    const [[sharedKeys]] = await connection.query(
      `SELECT COUNT(*) AS count FROM \`${table}\`
       WHERE business_key IN (${placeholders(businessKeys, "businessKey")}) AND \`${orderColumn}\`<>:orderId${qualifier}`,
      { ...bind(businessKeys, "businessKey"), orderId }
    )
    if (Number(sharedKeys.count)) reasons.push(`${table}.business_key 被其他订单共享`)
  }

  const inventory = []
  for (const item of items) {
    const mode = String(item.inventory_mode || "").toUpperCase()
    const quantity = Number(item.quantity)
    if (!Number.isSafeInteger(quantity) || quantity <= 0) {
      reasons.push("订单商品数量结构不完整")
      continue
    }
    const [[product]] = await connection.query("SELECT id,stock,stock_mode FROM products WHERE id=:id", { id: item.product_id })
    if (!product) {
      reasons.push("订单商品对应主数据不存在")
      continue
    }
    const [releaseRows] = await connection.query(
      "SELECT quantity FROM order_inventory_releases WHERE order_item_id=:id", { id: item.id }
    )
    const [eventRows] = await connection.query(
      "SELECT COALESCE(SUM(quantity),0) AS quantity FROM order_inventory_release_events WHERE order_item_id=:id", { id: item.id }
    )
    const released = Number(releaseRows[0]?.quantity || 0)
    const eventTotal = Number(eventRows[0]?.quantity || 0)
    if (!Number.isSafeInteger(released) || released < 0 || released > quantity || eventTotal !== released) {
      reasons.push("库存释放事件与累计记录不一致")
      continue
    }
    const [reservations] = await connection.query(
      "SELECT quantity,product_id,order_id FROM order_inventory_reservations WHERE order_item_id=:id", { id: item.id }
    )
    if (mode === "FINITE") {
      if (String(product.stock_mode || "").toUpperCase() !== "FINITE") reasons.push("商品库存模式已变化")
      if (reservations.length !== 1 || Number(reservations[0].quantity) !== quantity || String(reservations[0].order_id) !== orderId) {
        reasons.push("有限库存预占结构无法确认")
      }
    } else if (!["UNLIMITED", "MADE_TO_ORDER"].includes(mode)) {
      reasons.push("未知库存模式")
    }
    inventory.push({ orderItemId: String(item.id), orderedQuantity: quantity, cumulativeReleasedQuantity: released, remainingReservedQuantity: mode === "FINITE" ? quantity - released : 0, inventoryMode: mode })
  }

  for (const table of ["reward_records", "store_settlement_records", "sales_agent_commissions"]) {
    if (!tables.has(table)) continue
    const [rows] = await connection.query(`SELECT * FROM \`${table}\` WHERE order_id=:orderId`, { orderId })
    if (rows.some(isSettled)) reasons.push(`${table} 存在已结算财务`)
    const targetIds = new Set(rows.map(row => String(row.id)))
    if (targetIds.size && rows.some(row => row.related_record_id && !targetIds.has(String(row.related_record_id)))) {
      const relatedIds = rows.map(row => row.related_record_id).filter(Boolean).map(String)
      const [related] = await connection.query(
        `SELECT id,order_id FROM \`${table}\` WHERE id IN (${placeholders(relatedIds, "related")})`, bind(relatedIds, "related")
      )
      if (related.some(row => row.order_id && String(row.order_id) !== orderId)) reasons.push(`${table} 引用了其他订单的财务记录`)
    }
  }
  return { orderId, reasons: [...new Set(reasons)], inventory }
}

async function analyze(connection, tables, whitelist, lock = false) {
  const graph = await loadTargetGraph(connection, whitelist.orderIds, lock)
  const found = new Set(graph.orders.map(row => String(row.id)))
  const missing = whitelist.orderIds.filter(id => !found.has(id))
  const unknownHits = await findUnknownAssociations(connection, tables, graph)
  const reviews = []
  for (const order of graph.orders) reviews.push(await reviewOrder(connection, tables, order, graph))
  if (unknownHits.length) {
    const reason = `存在未识别关联：${unknownHits.map(hit => `${hit.table}.${hit.column}`).join(",")}`
    for (const review of reviews) review.reasons.push(reason)
  }
  const manual = reviews.filter(review => review.reasons.length)
  const automatic = reviews.filter(review => !review.reasons.length)
  const tableCounts = await countByTable(connection, tables, graph)
  const inventoryQuantity = automatic.flatMap(review => review.inventory).reduce((sum, item) => sum + item.remainingReservedQuantity, 0)
  const orderIds = graph.orders.map(row => String(row.id))
  let finance = { orderAmount: 0, refundAmount: 0, rewardAmount: 0, storeAmount: 0, salesAmount: 0 }
  if (orderIds.length) {
    const params = bind(orderIds, "financeOrder")
    const inList = placeholders(orderIds, "financeOrder")
    const [[orders]] = await connection.query(`SELECT COALESCE(SUM(amount),0) AS amount FROM orders WHERE id IN (${inList})`, params)
    const [[refunds]] = await connection.query(`SELECT COALESCE(SUM(success_amount_cents),0) AS cents FROM refund_records WHERE order_id IN (${inList})`, params)
    finance.orderAmount = Number(orders.amount || 0)
    finance.refundAmount = Number(refunds.cents || 0) / 100
    for (const [table, key] of [["reward_records", "rewardAmount"], ["store_settlement_records", "storeAmount"], ["sales_agent_commissions", "salesAmount"]]) {
      if (!tables.has(table)) continue
      const [[row]] = await connection.query(`SELECT COALESCE(SUM(amount),0) AS amount FROM \`${table}\` WHERE order_id IN (${inList})`, params)
      finance[key] = Number(row.amount || 0)
    }
  }
  return { graph, missing, unknownHits, reviews, manual, automatic, tableCounts, inventoryQuantity, finance }
}

function publicReport(mode, whitelist, analysis, deleted = null) {
  return {
    ok: analysis.manual.length === 0,
    mode,
    whitelistCount: whitelist.orderIds.length,
    duplicateOrderIdsRemoved: whitelist.duplicateCount,
    automaticDeleteCount: analysis.automatic.length,
    manualReviewCount: analysis.manual.length,
    notFoundCount: analysis.missing.length,
    expectedDeletesByTable: analysis.tableCounts,
    inventoryQuantity: analysis.inventoryQuantity,
    financeSummary: analysis.finance,
    maskedExampleIds: whitelist.orderIds.slice(0, 3).map(maskId),
    manualReview: analysis.manual.map(review => ({ orderId: maskId(review.orderId), reasons: review.reasons })),
    unknownAssociations: analysis.unknownHits.map(hit => ({ table: hit.table, column: hit.column, count: hit.count })),
    deleted
  }
}

function cleanupStateDigest(analysis) {
  const orders = analysis.graph.orders.map(order => ({
    id: guard.sha256(String(order.id)), status: String(order.status || ""), paymentStatus: String(order.payment_status || ""), refundStatus: String(order.refund_status || ""), transaction: !!order.transaction_id
  })).sort((a, b) => a.id.localeCompare(b.id))
  const items = analysis.graph.items.map(item => ({ id: guard.sha256(String(item.id)), orderId: guard.sha256(String(item.order_id)), quantity: Number(item.quantity), productId: guard.sha256(String(item.product_id)) })).sort((a, b) => a.id.localeCompare(b.id))
  const refunds = analysis.graph.refunds.map(row => ({ id: guard.sha256(String(row.id)), orderId: guard.sha256(String(row.order_id)), status: String(row.status || ""), amount: Number(row.success_amount_cents || 0) })).sort((a, b) => a.id.localeCompare(b.id))
  return guard.sha256(JSON.stringify({ orders, items, refunds, tableCounts: analysis.tableCounts, inventoryQuantity: analysis.inventoryQuantity, finance: analysis.finance, manual: analysis.manual.length, missing: analysis.missing.length }))
}

function buildCleanupPlan({ mode, gitSha, fingerprint, whitelistSha256, whitelist, analysis, structureFingerprint }) {
  const generatedAt = new Date().toISOString()
  return {
    version: 1, operation: "test-order-cleanup", mode, generatedAt,
    expiresAt: new Date(Date.now() + guard.MAX_PLAN_AGE_MS).toISOString(), gitSha,
    database: fingerprint.database, serverUuid: fingerprint.serverUuid, databaseFingerprint: guard.fingerprintDigest(fingerprint),
    whitelistSha256, whitelistCount: whitelist.orderIds.length, maskedOrderIdentifiers: whitelist.orderIds.map(value => guard.sha256(value).slice(0, 16)),
    expectedDeletesByTable: analysis.tableCounts, expectedInventoryReturn: analysis.inventoryQuantity,
    financeSummary: analysis.finance, manualReviewCount: analysis.manual.length, notFoundCount: analysis.missing.length,
    structureFingerprint, stateDigest: cleanupStateDigest(analysis), conclusion: analysis.manual.length === 0 && analysis.missing.length === 0 ? "PASS" : "BLOCKED"
  }
}

async function validateControlledCleanup(connection, args, mode, env, repoRoot, whitelist) {
  if (!args.operationLog) throw new Error("安全拒绝：缺少 --operation-log")
  guard.requireExternalPath(args.operationLog, "--operation-log", repoRoot)
  const fingerprint = await guard.databaseFingerprint(connection); guard.assertFingerprint(fingerprint, args, mode)
  if (String(env.AI_PREVIEW_ENABLED || "").toLowerCase() === "true") throw new Error("安全拒绝：AI_PREVIEW_ENABLED=true")
  if (mode.kind === "production" && !args.dryRun && !args.apply) throw new Error("安全拒绝：生产清理必须明确选择 --dry-run 或 --apply")
  if (!args.apply) {
    if (!args.dryRun) throw new Error("安全拒绝：彩排 dry-run 必须明确提供 --dry-run")
    if (!args.expectedCount || Number(args.expectedCount) !== 10 || whitelist.orderIds.length !== 10) throw new Error("安全拒绝：生产/彩排 dry-run 必须确认 --expected-count=10 且白名单为10笔")
    if (!args.outputCleanupPlan) throw new Error("安全拒绝：缺少 --output-cleanup-plan")
    guard.requireExternalPath(args.outputCleanupPlan, "--output-cleanup-plan", repoRoot)
    return { fingerprint, whitelistSha256: guard.sha256File(args.whitelistFile) }
  }
  if (!args.confirmed || Number(args.confirmExactCount) !== 10 || whitelist.orderIds.length !== 10) throw new Error("安全拒绝：apply 必须同时提供 --confirm-delete-test-orders、--confirm-exact-count=10 且白名单为10笔")
  for (const [label, value] of Object.entries({ "--cleanup-plan": args.cleanupPlan, "--cleanup-plan-sha256": args.cleanupPlanSha256, "--backup-manifest": args.backupManifest })) if (!value) throw new Error(`安全拒绝：缺少 ${label}`)
  const planRead = guard.readJson(args.cleanupPlan, "清理计划文件", repoRoot)
  if (planRead.sha256 !== args.cleanupPlanSha256) throw new Error("安全拒绝：清理计划摘要不一致")
  guard.assertPlanFresh(planRead.value, args.expectedGitSha)
  if (planRead.value.database !== fingerprint.database || planRead.value.serverUuid !== fingerprint.serverUuid || planRead.value.databaseFingerprint !== guard.fingerprintDigest(fingerprint)) throw new Error("安全拒绝：清理计划数据库指纹不一致")
  const currentWhitelistSha = guard.sha256File(args.whitelistFile)
  if (planRead.value.whitelistSha256 !== currentWhitelistSha) throw new Error("安全拒绝：白名单文件摘要已变化")
  const backup = guard.assertBackupManifest(args.backupManifest, fingerprint, repoRoot)
  const disk = guard.assertDiskSpace(path.dirname(backup.manifest.backupFile), backup.backupSize, env)
  return { fingerprint, planRead, whitelistSha256: currentWhitelistSha, backup, disk }
}

async function deleteTargets(connection, tables, analysis, env = process.env) {
  const orderIds = analysis.automatic.map(review => review.orderId)
  if (!orderIds.length) return Object.fromEntries(DELETE_ORDER.map(table => [table, 0]))
  const itemIds = analysis.graph.items.filter(row => orderIds.includes(String(row.order_id))).map(row => String(row.id))
  const refundIds = analysis.graph.refunds.filter(row => orderIds.includes(String(row.order_id))).map(row => String(row.id))
  const deleted = Object.fromEntries(DELETE_ORDER.map(table => [table, 0]))

  for (const review of analysis.automatic) {
    for (const item of review.inventory) {
      if (item.inventoryMode !== "FINITE" || item.remainingReservedQuantity === 0) continue
      await releaseOrderItemInventory(connection, {
        orderItemId: item.orderItemId,
        releaseRemaining: true,
        businessKey: `test_order_cleanup:${review.orderId}:${item.orderItemId}`,
        reason: "测试订单白名单清理",
        sourceType: "test_order_cleanup",
        sourceId: review.orderId
      })
    }
  }
  if (env.CLEANUP_TEST_FAIL_AFTER_RELEASE === "true") throw new Error("测试注入：库存释放后回滚")

  if (refundIds.length && tables.has("refund_items")) {
    const [result] = await connection.query(
      `DELETE FROM refund_items WHERE refund_record_id IN (${placeholders(refundIds, "deleteRefund")})`, bind(refundIds, "deleteRefund")
    )
    deleted.refund_items = Number(result.affectedRows || 0)
  }
  const params = bind(orderIds, "deleteOrder")
  const inOrders = placeholders(orderIds, "deleteOrder")
  for (const table of DELETE_ORDER) {
    if (["refund_items", "order_items", "orders", "payment_finance_outbox"].includes(table) || !tables.has(table)) continue
    const [result] = await connection.query(`DELETE FROM \`${table}\` WHERE order_id IN (${inOrders})`, params)
    deleted[table] = Number(result.affectedRows || 0)
  }
  if (tables.has("payment_finance_outbox")) {
    const [result] = await connection.query(
      `DELETE FROM payment_finance_outbox WHERE aggregate_type='ORDER' AND aggregate_id IN (${inOrders})`, params
    )
    deleted.payment_finance_outbox = Number(result.affectedRows || 0)
  }
  if (tables.has("store_referral_attributions")) {
    await connection.query(`UPDATE store_referral_attributions SET last_order_id=NULL WHERE last_order_id IN (${inOrders})`, params)
  }
  if (itemIds.length) {
    const [result] = await connection.query(
      `DELETE FROM order_items WHERE id IN (${placeholders(itemIds, "deleteItem")})`, bind(itemIds, "deleteItem")
    )
    deleted.order_items = Number(result.affectedRows || 0)
  }
  const [ordersResult] = await connection.query(`DELETE FROM orders WHERE id IN (${inOrders})`, params)
  deleted.orders = Number(ordersResult.affectedRows || 0)
  if (deleted.orders !== orderIds.length) throw new Error("实际删除订单数与允许删除数量不一致")

  const [remaining] = await connection.query(`SELECT id FROM orders WHERE id IN (${inOrders})`, params)
  if (remaining.length) throw new Error("事务内一致性检查失败：目标订单仍存在")
  for (const table of DIRECT_TABLES) {
    if (!tables.has(table)) continue
    const [[row]] = await connection.query(`SELECT COUNT(*) AS count FROM \`${table}\` WHERE order_id IN (${inOrders})`, params)
    if (Number(row.count)) throw new Error(`事务内一致性检查失败：${table} 仍有关联记录`)
  }
  return deleted
}

async function runCleanup({ argv = process.argv.slice(2), env = process.env, logger = console, repoRoot = path.join(__dirname, "..") } = {}) {
  const args = parseArgs(argv)
  const mode = guard.assertMode(args, env, repoRoot)
  if (mode.kind !== "isolated") guard.requireExternalPath(args.whitelistFile, "--whitelist-file", repoRoot)
  const whitelist = readWhitelist(args.whitelistFile)
  const config = mode.kind === "isolated" ? assertConnectionSafety(env, args) : guard.mysqlConfigForMode(env, mode)
  const pool = mysql.createPool(config)
  try {
    const connection = await pool.getConnection()
    try {
      const tables = await existingTables(connection)
      await assertRequiredSchema(connection, tables)
      const controlled = mode.kind === "isolated" ? null : await validateControlledCleanup(connection, args, mode, env, repoRoot, whitelist)
      if (!args.apply) {
        const analysis = await analyze(connection, tables, whitelist, false)
        const report = publicReport("DRY_RUN", whitelist, analysis)
        if (controlled) {
          const plan = buildCleanupPlan({ mode: mode.kind, gitSha: args.expectedGitSha, fingerprint: controlled.fingerprint, whitelistSha256: controlled.whitelistSha256, whitelist, analysis, structureFingerprint: await structuralFingerprint(connection) })
          fs.writeFileSync(args.outputCleanupPlan, `${JSON.stringify(plan, null, 2)}\n`, { mode: 0o600 }); fs.chmodSync(args.outputCleanupPlan, 0o600)
          guard.createOperationLog(args.operationLog, { operation: "cleanup-dry-run", mode: mode.kind, gitSha: args.expectedGitSha, databaseFingerprint: guard.fingerprintDigest(controlled.fingerprint), planSha256: guard.sha256File(args.outputCleanupPlan), confirmedAt: new Date().toISOString(), result: plan.conclusion }, repoRoot)
          report.cleanupPlan = { sha256: guard.sha256File(args.outputCleanupPlan), conclusion: plan.conclusion, stateDigest: plan.stateDigest }
          report.plan = plan
          logger.log(JSON.stringify(report, null, 2))
          return { report, exitCode: plan.conclusion === "PASS" ? 0 : 2 }
        }
        logger.log(JSON.stringify(report, null, 2))
        return { report, exitCode: analysis.manual.length ? 2 : 0 }
      }
      await connection.beginTransaction()
      try {
        const analysis = await analyze(connection, tables, whitelist, true)
        if (controlled) {
          if (controlled.planRead.value.structureFingerprint !== await structuralFingerprint(connection)) throw new Error("安全拒绝：数据库结构在清理计划后发生变化")
          if (controlled.planRead.value.stateDigest !== cleanupStateDigest(analysis)) throw new Error("安全拒绝：清理计划状态已漂移")
          if (controlled.planRead.value.manualReviewCount !== 0 || controlled.planRead.value.whitelistCount !== 10 || analysis.automatic.length !== 10 || analysis.missing.length) throw new Error("安全拒绝：订单数量、状态或 MANUAL_REVIEW 与计划不一致")
        }
        if (analysis.manual.length) {
          const report = publicReport("APPLY_BLOCKED", whitelist, analysis)
          await connection.rollback()
          logger.log(JSON.stringify(report, null, 2))
          return { report, exitCode: 2 }
        }
        const deleted = await deleteTargets(connection, tables, analysis, env)
        await connection.commit()
        const report = publicReport("APPLY", whitelist, analysis, deleted)
        if (controlled) guard.createOperationLog(args.operationLog, { operation: "cleanup-apply", mode: mode.kind, gitSha: args.expectedGitSha, databaseFingerprint: guard.fingerprintDigest(controlled.fingerprint), planSha256: controlled.planRead.sha256, confirmedAt: new Date().toISOString(), result: "PASS", deletedOrders: deleted.orders }, repoRoot)
        logger.log(JSON.stringify(report, null, 2))
        return { report, exitCode: 0 }
      } catch (error) {
        await connection.rollback().catch(() => {})
        throw error
      }
    } finally {
      connection.release()
    }
  } finally {
    await pool.end().catch(() => {})
  }
}

if (require.main === module) {
  runCleanup().then(result => {
    process.exitCode = result.exitCode
  }).catch(error => {
    console.error(JSON.stringify({ ok: false, error: error.message }))
    process.exitCode = 1
  })
}

module.exports = {
  ALLOWED_DATABASES,
  DELETE_ORDER,
  KNOWN_ASSOCIATIONS,
  MAX_ORDERS,
  REQUIRED_DATABASE,
  assertConnectionSafety,
  maskId,
  cleanupStateDigest,
  buildCleanupPlan,
  parseArgs,
  readWhitelist,
  runCleanup
}
