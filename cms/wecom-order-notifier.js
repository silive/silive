const https = require("https")

const NOTIFICATION_TYPE = "WECOM_ORDER_PAID"
const MAX_ATTEMPTS = 4
const RETRY_DELAYS_MINUTES = [1, 5, 15]
const MAX_MESSAGE_BYTES = 3900

function cleanText(value, maxLength = 120) {
  return String(value == null ? "" : value)
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength)
}

function escapeMarkdown(value, maxLength) {
  return cleanText(value, maxLength)
    .replace(/&/g, "＆")
    .replace(/</g, "＜")
    .replace(/>/g, "＞")
}

function phoneTail(value) {
  const digits = String(value || "").replace(/\D/g, "")
  return digits ? digits.slice(-4) : ""
}

function deliveryArea(value) {
  const text = cleanText(value, 120)
  if (!text) return ""
  const district = text.match(/^(.{2,30}?(?:区|县|旗))/)
  if (district) return district[1]
  const city = text.match(/^(.{2,24}?(?:市|州|盟))/)
  return city ? city[1] : ""
}

function parseCartItems(remark) {
  const line = String(remark || "")
    .split(/\r?\n/)
    .find(item => item.trim().startsWith("购物车："))
  if (!line) return []
  return line.replace(/^购物车：/, "").split(/[，,]/).map(item => {
    const match = item.trim().match(/^(.+?)[x×](\d+)$/i)
    return match ? { name: match[1].trim(), quantity: Number(match[2]) || 1 } : null
  }).filter(Boolean)
}

function extractQuantity(order = {}) {
  const quantities = Array.from(String(order.remark || "").matchAll(/[x×](\d+)/gi))
    .map(match => Number(match[1] || 0))
    .filter(Boolean)
  return quantities.length ? quantities.reduce((sum, value) => sum + value, 0) : 1
}

function orderItems(order = {}) {
  const explicitItems = Array.isArray(order.items) ? order.items : []
  const items = explicitItems.length ? explicitItems.map(item => ({
    name: item.name || item.productName || item.title,
    specification: item.specification || item.spec || item.skuName || "",
    quantity: Math.max(1, Number(item.quantity || item.qty || 1))
  })) : parseCartItems(order.remark)
  if (items.length) return items.filter(item => cleanText(item.name, 100))
  return [{
    name: order.productName || "商品",
    specification: order.specification || order.spec || "",
    quantity: extractQuantity(order)
  }]
}

function customerRemark(order = {}) {
  const internalPrefixes = ["购物车：", "购物车商品ID：", "普通商品：", "新人福利："]
  const remark = String(order.remark || "").split(/\r?\n/)
    .map(item => item.trim())
    .filter(item => item && !internalPrefixes.some(prefix => item.startsWith(prefix)))
    .join("；")
  return cleanText(order.customRequest || remark, 80)
}

function formatChinaTime(value) {
  const date = value ? new Date(String(value).replace(" ", "T")) : new Date()
  if (Number.isNaN(date.getTime())) return cleanText(value, 30)
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(date).replace(/\//g, "-")
}

function buildOrderPaidMarkdown(order = {}) {
  const items = orderItems(order)
  const shownItems = items.slice(0, 5)
  const lines = [
    "**🔔 非常智造收到新订单**",
    "",
    `> 订单编号：${escapeMarkdown(order.id || order.orderId || "未知", 50)}`
  ]
  shownItems.forEach((item, index) => {
    const specification = cleanText(item.specification, 60)
    const label = specification ? `${item.name}（${specification}）` : item.name
    lines.push(`> ${index === 0 ? "商品" : "　　"}：${escapeMarkdown(label, 120)} × ${Math.max(1, Number(item.quantity || 1))}`)
  })
  if (items.length > shownItems.length) lines.push(`> 　　：另有${items.length - shownItems.length}项商品`)

  const amount = Number(order.amount || order.paidAmount || 0)
  lines.push(`> 实付金额：¥${Number.isFinite(amount) ? amount.toFixed(2) : "0.00"}`)

  const isPickup = String(order.deliveryType || "").toLowerCase() === "pickup"
  lines.push(`> 交付方式：${isPickup ? "门店自提" : "配送"}`)
  if (isPickup) {
    const storeName = order.pickupStore?.name || order.pickupStoreName || ""
    if (storeName) lines.push(`> 自提门店：${escapeMarkdown(storeName, 80)}`)
  } else {
    const area = deliveryArea(order.address)
    if (area) lines.push(`> 配送区域：${escapeMarkdown(area, 40)}`)
  }

  const remark = customerRemark(order)
  if (remark) lines.push(`> 顾客备注：${escapeMarkdown(remark, 80)}`)
  const tail = phoneTail(order.phone)
  if (tail) lines.push(`> 联系方式：尾号${tail}`)
  const paidAt = formatChinaTime(order.paidAt || order.paid_at || new Date())
  if (paidAt) lines.push(`> 支付时间：${paidAt}`)

  let content = lines.join("\n")
  while (Buffer.byteLength(content) > MAX_MESSAGE_BYTES && content.length > 100) {
    content = `${content.slice(0, -50)}…`
  }
  return content
}

function buildTestMarkdown(options = {}) {
  return [
    "**✅ 非常智造订单提醒测试成功**",
    "",
    `> 当前运行环境：${escapeMarkdown(options.environment || process.env.NODE_ENV || "unknown", 40)}`,
    `> 服务名称：${escapeMarkdown(options.serviceName || "very-simple-cms", 60)}`,
    `> 测试时间：${formatChinaTime(options.testTime || new Date())}`
  ].join("\n")
}

function redactWebhook(value) {
  return String(value || "")
    .replace(/([?&]key=)[^&\s]+/gi, "$1***")
    .replace(/https:\/\/qyapi\.weixin\.qq\.com\/cgi-bin\/webhook\/send\?[^\s]*/gi, "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=***")
}

function safeError(error) {
  return redactWebhook(error?.message || error || "企业微信通知失败").slice(0, 450)
}

function requestJson(url, body, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const target = new URL(url)
    const payload = JSON.stringify(body)
    const req = https.request({
      hostname: target.hostname,
      port: target.port || 443,
      path: `${target.pathname}${target.search}`,
      method: "POST",
      timeout: timeoutMs,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
        "User-Agent": "very-simple-cms/1.0"
      }
    }, response => {
      const chunks = []
      response.on("data", chunk => chunks.push(chunk))
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString()
        let data
        try {
          data = text ? JSON.parse(text) : {}
        } catch (error) {
          data = { errmsg: "企业微信返回非JSON响应" }
        }
        resolve({ statusCode: response.statusCode || 0, data })
      })
    })
    req.on("timeout", () => req.destroy(new Error("企业微信通知请求超时")))
    req.on("error", reject)
    req.write(payload)
    req.end()
  })
}

async function sendWecomMarkdown(options = {}) {
  const webhookUrl = String(options.webhookUrl || "").trim()
  if (!webhookUrl) throw new Error("未配置企业微信订单提醒")
  const requester = options.requester || requestJson
  const result = await requester(webhookUrl, {
    msgtype: "markdown",
    markdown: { content: String(options.content || "") }
  }, options.timeoutMs || 5000)
  if (Number(result.statusCode) < 200 || Number(result.statusCode) >= 300) {
    throw new Error(`企业微信通知HTTP失败：${Number(result.statusCode) || "unknown"}`)
  }
  if (Number(result.data?.errcode) !== 0) {
    throw new Error(`企业微信通知失败：${result.data?.errcode ?? "unknown"} ${cleanText(result.data?.errmsg, 120)}`)
  }
  return { ok: true, errcode: 0 }
}

function retryDelayMinutes(attemptCount) {
  return RETRY_DELAYS_MINUTES[Math.max(0, Number(attemptCount || 1) - 1)] || 0
}

module.exports = {
  MAX_ATTEMPTS,
  NOTIFICATION_TYPE,
  RETRY_DELAYS_MINUTES,
  buildOrderPaidMarkdown,
  buildTestMarkdown,
  customerRemark,
  deliveryArea,
  orderItems,
  phoneTail,
  redactWebhook,
  retryDelayMinutes,
  safeError,
  sendWecomMarkdown
}
