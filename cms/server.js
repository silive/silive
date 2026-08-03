const http = require("http")
const https = require("https")
const fs = require("fs")
const path = require("path")
const crypto = require("crypto")
const { execFileSync } = require("child_process")
const {
  MAX_PRODUCT_IMAGE_SIZE,
  optimizeProductImageUpload
} = require("./product-image-optimizer")
const {
  MAX_ATTEMPTS: WECOM_NOTIFICATION_MAX_ATTEMPTS,
  NOTIFICATION_TYPE: WECOM_ORDER_PAID_NOTIFICATION,
  buildOrderPaidMarkdown,
  retryDelayMinutes: wecomRetryDelayMinutes,
  safeError: safeWecomError,
  sendWecomMarkdown
} = require("./wecom-order-notifier")
const {
  claimDueNotifications,
  compensateMissingPaidNotifications,
  markOrderPaidAndEnqueue
} = require("./wecom-order-outbox")
const {
  PAYMENT_FINANCE_MAX_ATTEMPTS,
  claimDuePaymentFinanceEvents,
  completePaymentFinanceEvent,
  failPaymentFinanceEvent
} = require("./payment-finance-outbox")
const { isPickupServiceFeeEligible } = require("./pickup-service-fee")
const {
  assertAdminTransition,
  isPickupVerified,
  lifecycleView
} = require("./order-lifecycle")
const {
  claimDueFulfillment,
  enqueueFulfillment
} = require("./wechat-fulfillment-outbox")
const {
  ATTRIBUTION_TTL_MS,
  hashAnonymousVisitor,
  hashAttributionToken,
  issueAttributionToken,
  safeAttributionSource
} = require("./store-attribution")
const {
  canonicalRequestHash,
  centsToYuan,
  normalizeInventoryMode,
  orderItemSnapshot,
  strictPositiveInteger,
  validateOrderItems,
  validateRefundItems,
  yuanToCents
} = require("./order-domain")
const {
  canReleaseOrderInventory,
  canRestockRefundedInventory,
  releaseOrderInventory,
  releaseOrderItemInventory
} = require("./inventory-ledger")
const {
  ORDER_PAYMENT_TIMEOUT_MAX_ATTEMPTS,
  claimDueOrderPaymentTimeoutJobs,
  closeOrderForPaymentTimeout,
  enqueueOrderPaymentTimeout,
  failOrderPaymentTimeoutJob,
  paymentExpiresAt,
  paymentTimeoutMinutes
} = require("./order-payment-timeout")
const {
  aiPreviewRouteDecision,
  isAiPreviewEnabled
} = require("./ai-preview-access")
const {
  claimPickupCode,
  generatePickupCodeCandidate
} = require("./pickup-security")

let mysql
try {
  mysql = require("mysql2/promise")
} catch (error) {
  mysql = null
}
let sharp
try {
  sharp = require("sharp")
} catch (error) {
  sharp = null
}
let QRCode
try {
  QRCode = require("qrcode")
} catch (error) {
  QRCode = null
}

const ROOT = path.join(__dirname, "..")
// Isolated database acceptance explicitly supplies every connection value and
// must never inherit a developer or production-like .env file.
if (process.env.MYSQL_TEST_SKIP_DOTENV !== "true") loadEnv(path.join(ROOT, ".env"))

const IS_PRODUCTION = process.env.NODE_ENV === "production"
const AI_PREVIEW_ENABLED = isAiPreviewEnabled()
// Historical compatibility writes are operational backfills, not schema
// initialization. They must be explicitly enabled after a reviewed dry-run.
const STARTUP_HISTORY_COMPENSATION_ENABLED = String(process.env.STARTUP_HISTORY_COMPENSATION_ENABLED || "").trim().toLowerCase() === "true"
const ORDER_PAYMENT_TIMEOUT_MINUTES = paymentTimeoutMinutes()
const STORAGE_MODE = String(process.env.STORAGE_MODE || "mysql").trim().toLowerCase()
const PORT = Number(process.env.PORT || 3000)
const HTTPS_PORT = Number(process.env.HTTPS_PORT || 3443)
const ENABLE_HTTPS = process.env.ENABLE_HTTPS !== "false"
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || (ENABLE_HTTPS ? `https://127.0.0.1:${HTTPS_PORT}` : `http://127.0.0.1:${PORT}`)
const WECHAT_APPID = process.env.WECHAT_APPID || ""
const WECHAT_SECRET = process.env.WECHAT_SECRET || ""
const WECHAT_PICKUP_TEMPLATE_ID = process.env.WECHAT_PICKUP_TEMPLATE_ID || ""
const PAY_MOCK_ENV = String(process.env.PAY_MOCK || "").toLowerCase()
const PAY_MOCK = IS_PRODUCTION ? false : process.env.PAY_MOCK !== "false"
const MOCK_WECHAT_OPENID = "mock-openid-local"
const MOCK_WECHAT_PHONE = "13812345678"
const MOCK_WECHAT_USER_SESSION = "mock-user-session-local"
const STORE_REFERRER_TTL_MS = 30 * 24 * 60 * 60 * 1000
const adminFile = path.join(__dirname, "admin.html")
const loginFile = path.join(__dirname, "login.html")
const testFile = path.join(__dirname, "test.html")
const uploadsDir = path.join(__dirname, "uploads")
const salesLeadUploadsDir = path.join(uploadsDir, "sales-leads")
const productUploadsDir = path.join(uploadsDir, "products")
const publicLogoFile = path.join(ROOT, "assets", "logo.png")
const brandQrLogoFile = path.join(ROOT, "assets", "logo-orange.png")
const BRAND_QR_LOGO_VERSION = "orange-v5-release"
const seedDir = path.join(__dirname, "data")
const importTempDir = path.join(seedDir, "import-temp")
const certDir = path.join(seedDir, "certs")
const homeFile = path.join(seedDir, "home.json")
const ordersFile = path.join(seedDir, "orders.json")
const customersFile = path.join(seedDir, "customers.json")
const settingsFile = path.join(seedDir, "settings.json")
const promotionRelationsFile = path.join(seedDir, "promotion-relations.json")
const promotionVisitsFile = path.join(seedDir, "promotion-visits.json")
const orderRecommendationEventsFile = path.join(seedDir, "order-recommendation-events.json")
const rewardRulesFile = path.join(seedDir, "reward-rules.json")
const rewardRecordsFile = path.join(seedDir, "reward-records.json")
const partnerStoresFile = path.join(seedDir, "partner-stores.json")
const storeMembersFile = path.join(seedDir, "store-members.json")
const storeSettlementRecordsFile = path.join(seedDir, "store-settlement-records.json")
const salesAgentsFile = path.join(seedDir, "sales-agents.json")
const storeLeadsFile = path.join(seedDir, "store-leads.json")
const salesAgentCommissionsFile = path.join(seedDir, "sales-agent-commissions.json")
const sessions = new Map()
const salesSessions = new Map()
const userSessions = new Map()
const publicUploadHits = new Map()
const authenticatedUploadHits = new Map()
const orderRecommendationEventHits = new Map()
const productImportPreviews = new Map()
const adminLoginFailures = new Map()
const salesLoginFailures = new Map()
const pickupVerificationHits = new Map()
let activeUploadRequests = 0
let reservedUploadBytes = 0
let lastOrphanUploadCleanupAt = 0
let wecomNotificationWorkerRunning = false
let wecomNotificationWorkerTimer = null
let paymentFinanceWorkerRunning = false
let paymentFinanceWorkerTimer = null
let orderPaymentTimeoutWorkerRunning = false
let orderPaymentTimeoutWorkerTimer = null
let wechatFulfillmentWorkerRunning = false
let wechatFulfillmentWorkerTimer = null
let refundSyncWorkerRunning = false
let refundSyncWorkerTimer = null

fs.mkdirSync(uploadsDir, { recursive: true })
fs.mkdirSync(salesLeadUploadsDir, { recursive: true })
fs.mkdirSync(productUploadsDir, { recursive: true })
fs.mkdirSync(certDir, { recursive: true })
fs.mkdirSync(importTempDir, { recursive: true })

function loadEnv(file) {
  if (!fs.existsSync(file)) return
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/)
  for (const line of lines) {
    if (!line || line.trim().startsWith("#")) continue
    const index = line.indexOf("=")
    if (index === -1) continue
    const key = line.slice(0, index).trim()
    const value = line.slice(index + 1).trim()
    if (key && process.env[key] == null) process.env[key] = value
  }
}

const dbConfig = {
  host: process.env.MYSQL_HOST || "127.0.0.1",
  port: Number(process.env.MYSQL_PORT || 3306),
  user: process.env.MYSQL_USER || "root",
  password: process.env.MYSQL_PASSWORD || "",
  database: process.env.MYSQL_DATABASE || "very_simple_custom",
  waitForConnections: true,
  connectionLimit: 10,
  namedPlaceholders: true,
  charset: "utf8mb4",
  dateStrings: true
}

let pool
let accessTokenCache = { token: "", expiresAt: 0 }

function readJsonFile(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"))
  } catch (error) {
    return fallback
  }
}

function publicAssetUrl(value) {
  const text = String(value || "")
  if (!text) return ""
  if (text.startsWith("/cms/uploads/")) return `${PUBLIC_BASE_URL}${text.replace(/^\/cms\/uploads/, "/uploads")}`
  if (text.startsWith("/uploads/")) return `${PUBLIC_BASE_URL}${text}`
  return text.replace(/^https?:\/\/(?:127\.0\.0\.1|localhost):\d+\/uploads\//, `${PUBLIC_BASE_URL}/uploads/`)
}

function uploadPublicUrl(filename) {
  return `${PUBLIC_BASE_URL}/uploads/${filename}`
}

function uploadVariantFilename(filename, suffix, ext = "webp") {
  const base = path.basename(filename || "", path.extname(filename || ""))
  return base ? `${base}${suffix}.${ext}` : ""
}

function uploadVariantUrl(sourceUrl, suffix) {
  const filename = uploadUrlToFilename(sourceUrl)
  if (!filename || /\.svg$/i.test(filename)) return publicAssetUrl(sourceUrl)
  const webpName = uploadVariantFilename(filename, suffix, "webp")
  const jpgName = uploadVariantFilename(filename, suffix, "jpg")
  if (webpName && fs.existsSync(path.join(uploadsDir, webpName))) return uploadPublicUrl(webpName)
  if (jpgName && fs.existsSync(path.join(uploadsDir, jpgName))) return uploadPublicUrl(jpgName)
  return publicAssetUrl(sourceUrl)
}

function uploadImageVariants(sourceUrl) {
  const url = publicAssetUrl(sourceUrl)
  return {
    url,
    optimizedUrl: uploadVariantUrl(url, ".optimized"),
    thumbUrl: uploadVariantUrl(url, ".thumb"),
    listImage: uploadVariantUrl(url, ".thumb"),
    cartThumbUrl: uploadVariantUrl(url, ".cart-thumb"),
    bannerUrl: uploadVariantUrl(url, ".banner"),
    bannerThumbUrl: uploadVariantUrl(url, ".banner-thumb"),
    detailUrl: uploadVariantUrl(url, ".detail"),
    webpUrl: uploadVariantUrl(url, ".optimized")
  }
}

function withVersion(url, version) {
  if (!url) return ""
  if (!version) return url
  return `${url}${String(url).includes("?") ? "&" : "?"}v=${encodeURIComponent(version)}`
}

function normalizeBannerForSave(banner = {}, oldBanner = {}) {
  const version = Date.now()
  const imageUrl = publicAssetUrl(banner.imageUrl || "")
  const oldImageUrl = publicAssetUrl(oldBanner.imageUrl || "")
  const imageChanged = imageUrl !== oldImageUrl
  const imageCleared = !imageUrl
  const imageVariants = uploadImageVariants(imageUrl)
  const next = {
    ...banner,
    imageUrl,
    version,
    updatedAt: version,
    targetType: banner.targetType || "primary",
    targetValue: banner.targetValue || ""
  }
  if (imageCleared) {
    next.optimizedUrl = ""
    next.bannerUrl = ""
    next.thumbUrl = ""
    next.bannerThumbUrl = ""
    next.finalImageUrl = ""
    return next
  }
  if (imageChanged) {
    next.optimizedUrl = imageVariants.optimizedUrl || imageUrl
    next.bannerUrl = imageVariants.bannerUrl || imageVariants.optimizedUrl || imageUrl
    next.thumbUrl = imageVariants.thumbUrl || imageUrl
    next.bannerThumbUrl = imageVariants.bannerThumbUrl || imageVariants.thumbUrl || imageUrl
    next.finalImageUrl = withVersion(next.bannerUrl || next.optimizedUrl || next.imageUrl, version)
    return next
  }
  next.optimizedUrl = banner.optimizedUrl ? publicAssetUrl(banner.optimizedUrl) : (oldBanner.optimizedUrl ? publicAssetUrl(oldBanner.optimizedUrl) : imageVariants.optimizedUrl || imageUrl)
  next.bannerUrl = banner.bannerUrl ? publicAssetUrl(banner.bannerUrl) : (oldBanner.bannerUrl ? publicAssetUrl(oldBanner.bannerUrl) : imageVariants.bannerUrl || next.optimizedUrl || imageUrl)
  next.thumbUrl = banner.thumbUrl ? publicAssetUrl(banner.thumbUrl) : (oldBanner.thumbUrl ? publicAssetUrl(oldBanner.thumbUrl) : imageVariants.thumbUrl || imageUrl)
  next.bannerThumbUrl = banner.bannerThumbUrl ? publicAssetUrl(banner.bannerThumbUrl) : (oldBanner.bannerThumbUrl ? publicAssetUrl(oldBanner.bannerThumbUrl) : imageVariants.bannerThumbUrl || next.thumbUrl || imageUrl)
  next.finalImageUrl = withVersion(next.bannerUrl || next.optimizedUrl || next.imageUrl, version)
  return next
}

function bannerSummaryForLog(banner = {}, index = 0) {
  return {
    index,
    title: banner.title || "",
    imageUrl: banner.imageUrl || "",
    optimizedUrl: banner.optimizedUrl || "",
    bannerUrl: banner.bannerUrl || "",
    thumbUrl: banner.thumbUrl || "",
    version: banner.version || "",
    updatedAt: banner.updatedAt || ""
  }
}

function safeWxacodeScene(value, fallback = "VSCUSTOM") {
  const text = String(value || "").replace(/[^\w=&-]/g, "").slice(0, 32)
  return text || fallback
}

function normalizeAssetUrls(value) {
  if (Array.isArray(value)) return value.map(publicAssetUrl).filter(Boolean)
  return []
}

function writeJsonFile(file, data) {
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`)
}

function currentThemeFromSettings() {
  const colors = {
    primaryColor: "#FF5A00",
    accentColor: "#FFD21A",
    lightBg: "#FFF9F3",
    pageTopColor: "#FFF9F3",
    pageBottomColor: "#FFF9F3",
    cardColor: "rgba(255,255,255,.88)",
    textColor: "#222024",
    mutedTextColor: "#8D7E80",
    priceColor: "#FF4D00",
    buttonGradientStart: "#FF5A00",
    buttonGradientEnd: "#FF7A00",
    shadowColor: "rgba(255,90,0,.16)"
  }
  return {
    skinId: "fixed-orange",
    skin: "fixed-orange",
    name: "非常智造固定橙色主题",
    description: "小程序固定使用非常智造橙色视觉。",
    version: 1,
    enabled: "true",
    colors,
    radius: { cardRadius: 30, buttonRadius: 999 },
    tabbar: {
      activeColor: colors.priceColor,
      inactiveColor: "#999999",
      backgroundColor: "#FFFFFF"
    },
    navigationBar: {
      frontColor: "#000000",
      backgroundColor: colors.pageTopColor
    },
    primaryColor: colors.primaryColor,
    secondaryColor: "#FF7A00",
    accentColor: colors.accentColor,
    background: colors.lightBg,
    softColor: colors.lightBg,
    lightBg: colors.lightBg,
    pageTopColor: colors.pageTopColor,
    pageBottomColor: colors.pageBottomColor,
    cardColor: colors.cardColor,
    textColor: colors.textColor,
    mutedColor: colors.mutedTextColor,
    mutedTextColor: colors.mutedTextColor,
    priceColor: colors.priceColor,
    buttonGradient: [colors.buttonGradientStart, colors.buttonGradientEnd],
    cardRadius: "30rpx",
    buttonRadius: "999rpx",
    shadowColor: colors.shadowColor,
    banner: "",
    thumbnail: ""
  }
}

function readSeed(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(seedDir, file), "utf8"))
  } catch (error) {
    return fallback
  }
}

function parseJsonValue(value, fallback) {
  if (!value) return fallback
  if (typeof value === "string") {
    try {
      return JSON.parse(value)
    } catch (error) {
      return fallback
    }
  }
  return value
}

function parseDateValue(value) {
  if (!value) return null
  const date = new Date(String(value).replace(" ", "T"))
  return Number.isNaN(date.getTime()) ? null : date
}

function formatDateTime(date) {
  return date.toISOString().slice(0, 16).replace("T", " ")
}

function formatChinaDatetime(value) {
  if (!value) return ""
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(value.trim())) {
    return value.trim()
  }
  let date
  if (value instanceof Date) {
    date = value
  } else {
    const text = String(value).trim()
    if (!text) return ""
    if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?$/.test(text) && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(text)) {
      date = new Date(`${text.replace(" ", "T")}Z`)
    } else {
      date = new Date(text)
    }
  }
  if (!date || Number.isNaN(date.getTime())) return ""
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

function toMysqlDatetime(value, fallback = null) {
  if (value == null || value === "") return fallback
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return fallback
    return value.toISOString().slice(0, 19).replace("T", " ")
  }
  const text = String(value).trim()
  const matched = text.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::(\d{2}))?$/)
  if (matched) return `${matched[1]} ${matched[2]}:${matched[3] || "00"}`
  const date = parseDateValue(text)
  if (!date) return fallback
  return date.toISOString().slice(0, 19).replace("T", " ")
}

function nowMysqlDatetime() {
  return toMysqlDatetime(new Date())
}

function addDays(value, days) {
  const date = parseDateValue(value) || new Date()
  date.setDate(date.getDate() + days)
  return formatDateTime(date)
}

function baseSecurityHeaders() {
  return {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    ...(IS_PRODUCTION ? { "Strict-Transport-Security": "max-age=31536000; includeSubDomains" } : {})
  }
}

function sendJson(res, status, data, headers = {}) {
  res.writeHead(status, {
    ...baseSecurityHeaders(),
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization,X-User-Session,X-User-Token,X-Idempotency-Key,X-Request-Key",
    "Cache-Control": "no-store",
    ...headers
  })
  res.end(JSON.stringify(data))
}

function publicErrorMessage(error) {
  const message = String(error?.message || "")
  if (/Incorrect datetime value/i.test(message)) return "保存失败：时间格式异常，请刷新后重试"
  if (error?.code && String(error.code).startsWith("ER_")) return "保存失败，请检查填写内容后重试"
  return message || "服务器错误"
}

function httpError(status, message) {
  const error = new Error(message)
  error.statusCode = status
  return error
}

function wechatApiError(errcode, errmsg, label = "微信接口") {
  const code = errcode === undefined || errcode === null || errcode === "" ? "unknown" : errcode
  const message = errmsg || "微信接口返回异常"
  const error = httpError(400, `${label}失败：${code} ${message}`)
  error.errcode = code
  error.errmsg = message
  return error
}

function uploadInputError(status, message) {
  const error = httpError(status, message)
  error.isUploadInputError = true
  return error
}

function isMultipartFormRequest(req) {
  return /^multipart\/form-data\b/i.test(String(req.headers["content-type"] || ""))
}

function maskSecret(value) {
  const text = String(value || "")
  if (!text) return "(empty)"
  if (text.length <= 8) return `${text.slice(0, 2)}***`
  return `${text.slice(0, 4)}***${text.slice(-4)}`
}

function objectKeys(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value) : []
}

function requestJson(url, options = {}, body = "") {
  return new Promise((resolve, reject) => {
    const target = new URL(url)
    const headers = { "User-Agent": "very-simple-cms/1.0", ...(options.headers || {}) }
    if (body && !headers["Content-Length"] && !headers["content-length"]) {
      headers["Content-Length"] = Buffer.byteLength(body)
    }
    const req = https.request({
      hostname: target.hostname,
      path: `${target.pathname}${target.search}`,
      method: options.method || "GET",
      headers,
      timeout: options.timeout || 8000
    }, response => {
      const chunks = []
      response.on("data", chunk => chunks.push(chunk))
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString()
        try {
          resolve({ statusCode: response.statusCode, data: text ? JSON.parse(text) : {} })
        } catch (error) {
          resolve({ statusCode: response.statusCode, data: text })
        }
      })
    })
    req.on("timeout", () => {
      req.destroy(new Error("请求超时，请稍后重试"))
    })
    req.on("error", reject)
    if (body) req.write(body)
    req.end()
  })
}

function requestBuffer(url, options = {}, body = "") {
  return new Promise((resolve, reject) => {
    const target = new URL(url)
    const headers = { "User-Agent": "very-simple-cms/1.0", ...(options.headers || {}) }
    if (body && !headers["Content-Length"] && !headers["content-length"]) {
      headers["Content-Length"] = Buffer.byteLength(body)
    }
    const req = https.request({
      hostname: target.hostname,
      path: `${target.pathname}${target.search}`,
      method: options.method || "GET",
      headers,
      timeout: options.timeout || 12000
    }, response => {
      const chunks = []
      response.on("data", chunk => chunks.push(chunk))
      response.on("end", () => {
        resolve({
          statusCode: response.statusCode,
          headers: response.headers,
          data: Buffer.concat(chunks)
        })
      })
    })
    req.on("timeout", () => {
      req.destroy(new Error("请求超时，请稍后重试"))
    })
    req.on("error", reject)
    if (body) req.write(body)
    req.end()
  })
}

function sendText(res, status, text, type = "text/plain; charset=utf-8", headers = {}) {
  const htmlHeaders = String(type).toLowerCase().startsWith("text/html")
    ? {
        "Content-Security-Policy": "default-src 'self'; img-src 'self' data: blob: https:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self' https://api.feichangjiandan.xyz; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
        "Permissions-Policy": "camera=(self), geolocation=(self), microphone=()"
      }
    : {}
  res.writeHead(status, {
    ...baseSecurityHeaders(),
    ...htmlHeaders,
    "Content-Type": type,
    "Cache-Control": "no-store",
    ...headers
  })
  res.end(text)
}

function redirect(res, location) {
  res.writeHead(302, { ...baseSecurityHeaders(), Location: location })
  res.end()
}

function isAllowedSameOriginRequest(req) {
  const origin = String(req.headers.origin || "").trim()
  if (!origin) return true
  try {
    const originUrl = new URL(origin)
    const expected = new URL(PUBLIC_BASE_URL)
    const requestHost = String(req.headers.host || "").toLowerCase()
    return originUrl.origin === expected.origin || originUrl.host.toLowerCase() === requestHost
  } catch (error) {
    return false
  }
}

function parseCookies(req) {
  return Object.fromEntries((req.headers.cookie || "").split(";").filter(Boolean).map(item => {
    const index = item.indexOf("=")
    return [item.slice(0, index).trim(), decodeURIComponent(item.slice(index + 1))]
  }))
}

function isAuthed(req) {
  const sid = parseCookies(req).vsc_sid
  const session = sid && sessions.get(sid)
  if (!session) return false
  if (Date.now() - session.createdAt > 1000 * 60 * 60 * 12) {
    sessions.delete(sid)
    return false
  }
  return true
}

function adminSessionCookie(sid) {
  const parts = [`vsc_sid=${sid}`, "Path=/", "HttpOnly", "SameSite=Lax"]
  if (IS_PRODUCTION) parts.push("Secure")
  return parts.join("; ")
}

function salesSessionCookie(sid, maxAge = 60 * 60 * 12) {
  const parts = [`vsc_sales_sid=${sid}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${maxAge}`]
  if (IS_PRODUCTION) parts.push("Secure")
  return parts.join("; ")
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex")
  const digest = crypto.scryptSync(String(password || ""), salt, 64).toString("hex")
  return `scrypt$${salt}$${digest}`
}

function verifyPassword(password, storedHash) {
  const text = String(storedHash || "")
  const parts = text.split("$")
  if (parts.length !== 3 || parts[0] !== "scrypt") return false
  try {
    const digest = crypto.scryptSync(String(password || ""), parts[1], 64)
    const expected = Buffer.from(parts[2], "hex")
    return expected.length === digest.length && crypto.timingSafeEqual(expected, digest)
  } catch (error) {
    return false
  }
}

function getSalesSession(req) {
  const sid = parseCookies(req).vsc_sales_sid
  const session = sid && salesSessions.get(sid)
  if (!session) return null
  if (Date.now() - session.createdAt > 1000 * 60 * 60 * 12) {
    salesSessions.delete(sid)
    return null
  }
  return session
}

async function requireSalesSession(req, res) {
  const session = getSalesSession(req)
  if (!session?.salesAgentId) {
    sendJson(res, 401, { ok: false, message: "请先登录业务员账号" })
    return null
  }
  const agent = await getSalesAgent(session.salesAgentId)
  if (!agent || agent.status !== "active") {
    sendJson(res, 403, { ok: false, message: "业务员账号不可用" })
    return null
  }
  return { ...session, agent }
}

function salesLoginFailureState(req) {
  const ip = clientIp(req) || "unknown"
  const now = Date.now()
  const windowMs = 10 * 60 * 1000
  const state = salesLoginFailures.get(ip) || { failures: [], lockedUntil: 0 }
  state.failures = state.failures.filter(time => now - time < windowMs)
  if (state.lockedUntil && state.lockedUntil <= now) state.lockedUntil = 0
  salesLoginFailures.set(ip, state)
  return { ip, state }
}

function isSalesLoginLocked(req) {
  return salesLoginFailureState(req).state.lockedUntil > Date.now()
}

function recordSalesLoginFailure(req) {
  const { ip, state } = salesLoginFailureState(req)
  const now = Date.now()
  state.failures.push(now)
  if (state.failures.length > 8) state.lockedUntil = now + 10 * 60 * 1000
  salesLoginFailures.set(ip, state)
}

function clearSalesLoginFailures(req) {
  salesLoginFailures.delete(clientIp(req) || "unknown")
}

function adminLoginFailureState(req) {
  const ip = clientIp(req) || "unknown"
  const now = Date.now()
  const windowMs = 10 * 60 * 1000
  const state = adminLoginFailures.get(ip) || { failures: [], lockedUntil: 0 }
  state.failures = state.failures.filter(time => now - time < windowMs)
  if (state.lockedUntil && state.lockedUntil <= now) state.lockedUntil = 0
  adminLoginFailures.set(ip, state)
  return { ip, state }
}

function isAdminLoginLocked(req) {
  return adminLoginFailureState(req).state.lockedUntil > Date.now()
}

function recordAdminLoginFailure(req) {
  const { ip, state } = adminLoginFailureState(req)
  const now = Date.now()
  state.failures.push(now)
  if (state.failures.length > 5) {
    state.lockedUntil = now + 10 * 60 * 1000
  }
  adminLoginFailures.set(ip, state)
  return state.lockedUntil > now
}

function clearAdminLoginFailures(req) {
  adminLoginFailures.delete(clientIp(req) || "unknown")
}

async function createUserSession(openid, phone = "") {
  const token = crypto.randomBytes(24).toString("hex")
  const session = { openid, phone, createdAt: Date.now() }
  userSessions.set(token, session)
  if (pool) {
    await query(
      `INSERT INTO user_sessions (token_hash, openid, phone, created_at, expires_at, updated_at)
       VALUES (:tokenHash, :openid, :phone, NOW(), DATE_ADD(NOW(), INTERVAL 7 DAY), NOW())`,
      { tokenHash: hashUserSessionToken(token), openid, phone: normalizePhone(phone) }
    )
  }
  return token
}

async function createWechatUserSession(openid, phone = "") {
  if (canUseMockWechatLogin() && openid === MOCK_WECHAT_OPENID) {
    userSessions.set(MOCK_WECHAT_USER_SESSION, { openid, phone: phone || MOCK_WECHAT_PHONE, createdAt: Date.now() })
    return MOCK_WECHAT_USER_SESSION
  }
  return await createUserSession(openid, phone)
}

function hashUserSessionToken(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("hex")
}

async function restoreUserSessions() {
  if (!pool) return
  await query("DELETE FROM user_sessions WHERE expires_at <= NOW()")
  const rows = await query(
    "SELECT token_hash, openid, phone, created_at FROM user_sessions WHERE expires_at > NOW() ORDER BY updated_at DESC LIMIT 5000"
  )
  // Raw tokens are intentionally never stored, so existing in-memory tokens cannot be reconstructed.
  // Database lookup in resolveUserSession handles sessions after a process restart.
  console.log("[auth-state]", { persistedSessions: rows.length, restoredToMemory: 0 })
}

function isPlaceholderWechatValue(value) {
  const text = String(value || "").trim().toLowerCase()
  return !text || ["your_miniprogram_appid", "your_miniprogram_secret", "placeholder", "demo", "test"].includes(text)
}

function hasRealWechatConfig() {
  return !isPlaceholderWechatValue(WECHAT_APPID) && !isPlaceholderWechatValue(WECHAT_SECRET)
}

function canUseMockWechatLogin() {
  return !IS_PRODUCTION && PAY_MOCK && !hasRealWechatConfig()
}

function getUserSession(token) {
  const session = token && userSessions.get(token)
  if (!session) return null
  if (Date.now() - session.createdAt > 1000 * 60 * 60 * 24 * 7) {
    userSessions.delete(token)
    return null
  }
  return session
}

async function resolveUserSession(token) {
  const cached = getUserSession(token)
  if (cached || !pool || !token) return cached
  const rows = await query(
    `SELECT openid, phone, created_at
     FROM user_sessions
     WHERE token_hash = :tokenHash AND expires_at > NOW()
     LIMIT 1`,
    { tokenHash: hashUserSessionToken(token) }
  )
  if (!rows[0]) return null
  const session = {
    openid: rows[0].openid || "",
    phone: rows[0].phone || "",
    createdAt: new Date(rows[0].created_at || Date.now()).getTime()
  }
  userSessions.set(token, session)
  await query("UPDATE user_sessions SET updated_at=NOW() WHERE token_hash=:tokenHash", {
    tokenHash: hashUserSessionToken(token)
  }).catch(() => {})
  return session
}

async function revokeUserSession(token) {
  const value = String(token || "").trim()
  if (!value) return false
  userSessions.delete(value)
  if (!pool) return true
  const result = await query(
    "DELETE FROM user_sessions WHERE token_hash=:tokenHash",
    { tokenHash: hashUserSessionToken(value) }
  )
  return Number(result.affectedRows || 0) > 0
}

function normalizeIp(value) {
  return String(value || "").trim().replace(/^::ffff:/, "")
}

function trustedProxyIps() {
  return new Set(
    String(process.env.TRUSTED_PROXY_IPS || "127.0.0.1,::1")
      .split(",")
      .map(normalizeIp)
      .filter(Boolean)
  )
}

function clientIp(req) {
  const remote = normalizeIp(req.socket.remoteAddress)
  if (!trustedProxyIps().has(remote)) return remote
  const realIp = normalizeIp(req.headers["x-real-ip"])
  if (realIp) return realIp
  const forwarded = String(req.headers["x-forwarded-for"] || "")
    .split(",")
    .map(normalizeIp)
    .filter(Boolean)
  return forwarded[0] || remote
}

function isLocalhostIp(ip) {
  return ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(String(ip || "").trim())
}

function isLocalhostRequest(req) {
  return isLocalhostIp(normalizeIp(req.socket.remoteAddress))
}

function checkRateLimit(store, key, windowMs, maxHits) {
  const now = Date.now()
  const current = store.get(key) || []
  const recent = current.filter(time => now - time < windowMs)
  if (recent.length >= maxHits) return false
  recent.push(now)
  store.set(key, recent)
  return true
}

function checkPublicUploadRateLimit(req) {
  return checkRateLimit(publicUploadHits, clientIp(req) || "unknown", 10 * 60 * 1000, 20)
}

function checkAuthenticatedUploadRateLimit(req) {
  const token = String(req.headers["x-user-session"] || req.headers["x-user-token"] || "").trim()
  const ip = clientIp(req) || "unknown"
  const windowMs = 10 * 60 * 1000
  const maxHits = 100
  const sessionOk = token
    ? checkRateLimit(authenticatedUploadHits, `session:${hashUserSessionToken(token)}`, windowMs, maxHits)
    : true
  const ipOk = checkRateLimit(authenticatedUploadHits, `ip:${ip}`, windowMs, maxHits)
  return sessionOk && ipOk
}

function checkOrderRecommendationEventRateLimit(req) {
  return checkRateLimit(orderRecommendationEventHits, clientIp(req) || "unknown", 60 * 1000, 60)
}

function pickupVerificationRateKey(value) {
  return crypto.createHash("sha256").update(String(value || "unknown")).digest("hex").slice(0, 24)
}

function checkPickupVerificationRateLimit(req, storeSession) {
  const windowMs = 60 * 1000
  const storeId = storeSession?.store?.id || "unknown"
  const memberId = storeSession?.member?.id || storeSession?.member?.userId || "unknown"
  const deviceId = String(req.headers["x-device-id"] || req.headers["x-client-id"] || "unknown").slice(0, 160)
  const ip = clientIp(req) || "unknown"
  const checks = [
    [`store:${pickupVerificationRateKey(storeId)}`, 80],
    [`member:${pickupVerificationRateKey(memberId)}`, 30],
    [`device:${pickupVerificationRateKey(deviceId)}`, 30],
    [`ip:${pickupVerificationRateKey(ip)}`, 60]
  ]
  return checks.every(([key, maxHits]) => checkRateLimit(pickupVerificationHits, key, windowMs, maxHits))
}

async function userSessionFromRequest(req) {
  const token = String(req.headers["x-user-session"] || req.headers["x-user-token"] || "").trim()
  return await resolveUserSession(token)
}

function blockedUploadScriptExts() {
  return new Set([".html", ".htm", ".xml", ".svg", ".php", ".js", ".mjs", ".cjs", ".sh", ".bash", ".zsh", ".bat", ".cmd", ".ps1", ".vbs", ".exe", ".dll", ".com", ".scr", ".msi", ".jar", ".py", ".rb", ".pl"])
}

function ensureUploadDirectoryGuards() {
  fs.writeFileSync(path.join(uploadsDir, ".htaccess"), "Options -ExecCGI\nRemoveHandler .php .phtml .php3 .php4 .php5 .phar .cgi .pl .py .sh .js .html .htm\n<FilesMatch \"\\.(php|phtml|phar|cgi|pl|py|sh|js|html|htm)$\">\n  Require all denied\n</FilesMatch>\n")
}

function publicUploadFilename(ext, temporary) {
  const cleanExt = String(ext || "jpg").replace(/[^\w]/g, "") || "jpg"
  const prefix = temporary ? "temp-" : "user-"
  return `${prefix}${Date.now()}-${crypto.randomBytes(12).toString("hex")}.${cleanExt}`
}

function uploadUrlToFilename(value) {
  try {
    const text = String(value || "")
    const pathname = /^https?:\/\//.test(text) ? new URL(text).pathname : text
    if (!pathname.startsWith("/uploads/") && !pathname.startsWith("/cms/uploads/")) return ""
    return path.basename(decodeURIComponent(pathname))
  } catch (error) {
    return ""
  }
}

function uploadBaseName(value) {
  const filename = uploadUrlToFilename(value)
  if (!filename) return ""
  return path.basename(filename, path.extname(filename))
    .replace(/\.(optimized|banner|banner-thumb|thumb|cart-thumb|detail)$/i, "")
}

function uploadVariantMatchesSource(sourceUrl, variantUrl) {
  if (!variantUrl) return false
  const sourceBase = uploadBaseName(sourceUrl)
  const variantBase = uploadBaseName(variantUrl)
  return !!sourceBase && !!variantBase && sourceBase === variantBase
}

function currentBannerAsset(sourceUrl, candidateUrl, fallbackUrl) {
  if (uploadVariantMatchesSource(sourceUrl, candidateUrl)) return publicAssetUrl(candidateUrl)
  return publicAssetUrl(fallbackUrl || sourceUrl || "")
}

async function referencedUploadFilenames() {
  const names = new Set()
  const orders = await getOrders()
  for (const order of orders) {
    const values = [
      order.originalImageUrl,
      ...(Array.isArray(order.originalImageUrls) ? order.originalImageUrls : []),
      order.aiPreviewUrl,
      order.finalDesignUrl,
      order.refundImageUrl
    ]
    for (const value of values) {
      const filename = uploadUrlToFilename(value)
      if (filename) names.add(filename)
    }
  }
  return names
}

async function cleanupOrphanTempUploads(force = false) {
  const now = Date.now()
  if (!force && now - lastOrphanUploadCleanupAt < 60 * 60 * 1000) return
  lastOrphanUploadCleanupAt = now
  const referenced = await referencedUploadFilenames()
  const maxAge = 24 * 60 * 60 * 1000
  for (const name of fs.readdirSync(uploadsDir)) {
    if (!name.startsWith("temp-")) continue
    const file = path.join(uploadsDir, name)
    const stat = fs.statSync(file, { throwIfNoEntry: false })
    if (!stat || !stat.isFile()) continue
    if (now - stat.mtimeMs > maxAge && !referenced.has(name)) {
      fs.rmSync(file, { force: true })
    }
  }
}

function requireAuth(req, res) {
  if (isAuthed(req)) return true
  sendJson(res, 401, { ok: false, message: "请先登录" })
  return false
}

const MAX_IMAGE_SIZE = 10 * 1024 * 1024
const MAX_TEMP_IMAGE_SIZE = 5 * 1024 * 1024
const MAX_VIDEO_SIZE = 50 * 1024 * 1024
const MAX_UPLOAD_CONCURRENT = Math.max(1, Number(process.env.MAX_UPLOAD_CONCURRENT || 3))
const MAX_UPLOAD_MEMORY_BYTES = Math.max(
  MAX_VIDEO_SIZE + 1024 * 1024,
  Number(process.env.MAX_UPLOAD_MEMORY_MB || 160) * 1024 * 1024
)
const MAX_IMPORT_EXCEL_SIZE = 5 * 1024 * 1024
const MAX_IMPORT_ZIP_SIZE = 50 * 1024 * 1024
const IMPORT_PREVIEW_TTL = 30 * 60 * 1000
const ZIP_ALLOWED_IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"])
const ZIP_BLOCKED_EXTS = new Set([".exe", ".dll", ".dmg", ".pkg", ".app", ".com", ".scr", ".msi", ".html", ".htm", ".php", ".js", ".mjs", ".cjs", ".sh", ".bash", ".zsh", ".bat", ".cmd", ".ps1", ".vbs", ".jar", ".py", ".rb", ".pl"])
const CATEGORY_TREE = {
  "激光定制": ["照片雕刻", "刻字礼品", "首饰吊牌", "文具刻字", "手机配件", "自带物品加工", "企业LOGO"],
  "3D打印": ["模型定制", "来图定制", "尺寸定制", "颜色定制", "批量打印", "企业定制", "配件打印"],
  "潮玩手办": ["现货手办", "桌面摆件", "解压玩具", "钥匙挂件", "书签文创", "车载摆件", "生日礼物", "新品上架"],
  "日用好货": ["零食饮料", "家庭纸品", "日化清洁", "个护用品", "厨房用品", "宿舍好物", "特价专区"]
}
const PRODUCT_CATEGORIES = [
  ...Object.keys(CATEGORY_TREE),
  ...Object.entries(CATEGORY_TREE).flatMap(([primary, seconds]) => seconds.map(second => `${primary}/${second}`))
]
let activeCategoryTree = { ...CATEGORY_TREE }
const LEGACY_CATEGORY_MAP = {
  "激光雕刻": "激光定制/刻字礼品",
  "叶雕定制": "激光定制/照片雕刻",
  "名字礼物": "潮玩手办/钥匙挂件",
  "激光定制/亚克力夜灯": "激光定制/照片雕刻",
  "激光定制/木牌雕刻": "激光定制/刻字礼品",
  "激光定制/叶雕纪念": "激光定制/照片雕刻",
  "激光定制/叶雕礼物": "激光定制/照片雕刻",
  "3D打印/零件加工": "3D打印/配件打印",
  "3D打印/工业打样": "3D打印/企业定制",
  "3D打印/手办打印": "3D打印/模型定制",
  "3D打印/宠物摆件": "3D打印/模型定制",
  "潮玩手办/热门手办": "潮玩手办/现货手办",
  "潮玩手办/创意摆件": "潮玩手办/桌面摆件",
  "日用好货/食品饮料": "日用好货/零食饮料",
  "日用好货/日用百货": "日用好货/家庭纸品",
  "日用好货/本地好物": "日用好货/特价专区"
}

function canonicalCategoryCatalog() {
  return Object.entries(CATEGORY_TREE).map(([name, seconds], index) => ({
    id: `CAT${index + 1}`,
    name,
    subtitle: "",
    imageUrl: "",
    sort: index + 1,
    sortOrder: index + 1,
    enabled: "true",
    visible: "true",
    children: seconds.map((second, secondIndex) => ({
      id: `CAT${index + 1}-${secondIndex + 1}`,
      name: second,
      sort: secondIndex + 1,
      sortOrder: secondIndex + 1,
      enabled: "true",
      comingSoon: "false"
    }))
  }))
}

function isCategoryEnabled(value) {
  if (value == null || value === "") return true
  return !["false", "0", "off", "disabled", "hidden", "停用", "隐藏", "否"].includes(String(value).trim().toLowerCase())
}

function normalizeCategoryCatalog(value) {
  const source = Array.isArray(value) && value.length ? value : canonicalCategoryCatalog()
  return source
    .map((item, index) => {
      const enabled = isCategoryEnabled(item.enabled ?? item.visible)
      const childrenSource = Array.isArray(item.children) ? item.children : Array.isArray(item.seconds) ? item.seconds : []
      return {
        id: item.id || `CAT${index + 1}`,
        name: String(item.name || `一级类目${index + 1}`).trim(),
        subtitle: item.subtitle || item.desc || "",
        imageUrl: item.imageUrl ? publicAssetUrl(item.imageUrl) : "",
        icon: item.icon || "",
        sort: Number(item.sortOrder || item.sort || index + 1),
        sortOrder: Number(item.sortOrder || item.sort || index + 1),
        enabled: enabled ? "true" : "false",
        visible: enabled ? "true" : "false",
        children: childrenSource
          .map((child, childIndex) => {
            const childValue = typeof child === "string" ? { name: child } : child || {}
            const childEnabled = isCategoryEnabled(childValue.enabled)
            return {
              id: childValue.id || `CAT${index + 1}-${childIndex + 1}`,
              name: String(childValue.name || `二级类目${childIndex + 1}`).trim(),
              sort: Number(childValue.sortOrder || childValue.sort || childIndex + 1),
              sortOrder: Number(childValue.sortOrder || childValue.sort || childIndex + 1),
              enabled: childEnabled ? "true" : "false",
              comingSoon: String(childValue.comingSoon == null ? "false" : childValue.comingSoon)
            }
          })
          .filter(child => child.name)
          .sort((a, b) => a.sort - b.sort)
      }
    })
    .filter(item => item.name)
    .sort((a, b) => a.sort - b.sort)
}

function updateActiveCategoryTree(catalog) {
  const normalized = normalizeCategoryCatalog(catalog)
  activeCategoryTree = Object.fromEntries(normalized.map(item => [
    item.name,
    (item.children || []).map(child => child.name)
  ]))
  return normalized
}

function publicCategoryCatalog(catalog) {
  return normalizeCategoryCatalog(catalog)
    .filter(item => isCategoryEnabled(item.enabled ?? item.visible))
    .map(item => ({
      ...item,
      children: (item.children || []).filter(child => isCategoryEnabled(child.enabled))
    }))
}

function normalizeCategoryPath(value) {
  const text = String(value || "").trim()
  if (!text) return []
  const mapped = LEGACY_CATEGORY_MAP[text] || text
  const [primary, second] = mapped.split("/")
  const tree = activeCategoryTree && Object.keys(activeCategoryTree).length ? activeCategoryTree : CATEGORY_TREE
  if (!tree[primary]) return []
  if (!second) return [primary]
  if (!tree[primary].includes(second)) return [primary]
  return [primary, `${primary}/${second}`]
}

function readBody(req, maxSize = MAX_IMAGE_SIZE + 1024 * 1024, maxSizeMessage = "请求内容过大") {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let tooLarge = false
    req.on("data", chunk => {
      if (tooLarge) return
      size += chunk.length
      if (size > maxSize) {
        tooLarge = true
        reject(uploadInputError(413, maxSizeMessage))
        return
      }
      chunks.push(chunk)
    })
    req.on("end", () => {
      if (!tooLarge) resolve(Buffer.concat(chunks))
    })
    req.on("error", reject)
  })
}

function reserveUploadRequest(req, maxSize, maxSizeMessage = "上传内容过大") {
  const contentLengthText = String(req.headers["content-length"] || "").trim()
  const contentLength = contentLengthText ? Number(contentLengthText) : 0
  if (contentLengthText && (!Number.isSafeInteger(contentLength) || contentLength < 0)) {
    throw uploadInputError(400, "上传请求长度无效")
  }
  if (contentLength > maxSize) throw uploadInputError(413, maxSizeMessage)
  const reservation = contentLength || maxSize
  if (
    activeUploadRequests >= MAX_UPLOAD_CONCURRENT ||
    reservedUploadBytes + reservation > MAX_UPLOAD_MEMORY_BYTES
  ) {
    throw uploadInputError(429, "当前上传任务较多，请稍后重试")
  }
  activeUploadRequests += 1
  reservedUploadBytes += reservation
  let released = false
  return () => {
    if (released) return
    released = true
    activeUploadRequests = Math.max(0, activeUploadRequests - 1)
    reservedUploadBytes = Math.max(0, reservedUploadBytes - reservation)
  }
}

function safeName(filename) {
  const ext = path.extname(filename || "").toLowerCase()
  const allowed = [".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif", ".gif", ".mp4"]
  return `${Date.now()}-${crypto.randomBytes(6).toString("hex")}${allowed.includes(ext) ? ext : ".jpg"}`
}

function parseMultipart(buffer, contentType) {
  const boundaryMatch = /boundary=(.+)$/.exec(contentType || "")
  if (!boundaryMatch) throw new Error("缺少上传边界")
  const boundaryValue = boundaryMatch[1].replace(/^"|"$/g, "")
  const boundary = Buffer.from(`--${boundaryValue}`)
  const parts = []
  let start = buffer.indexOf(boundary) + boundary.length + 2
  while (start > boundary.length) {
    const end = buffer.indexOf(boundary, start)
    if (end < 0) break
    const part = buffer.subarray(start, end - 2)
    const headerEnd = part.indexOf(Buffer.from("\r\n\r\n"))
    if (headerEnd > -1) {
      const header = part.subarray(0, headerEnd).toString()
      const body = part.subarray(headerEnd + 4)
      const name = /name="([^"]+)"/.exec(header)?.[1]
      const filename = /filename="([^"]*)"/.exec(header)?.[1]
      const mimeType = /Content-Type:\s*([^\r\n]+)/i.exec(header)?.[1] || ""
      if (name && filename) parts.push({ name, filename, mimeType, body })
    }
    start = end + boundary.length + 2
  }
  return parts
}

const IMPORT_TEMPLATE_HEADERS = [
  "商品名称",
  "商品副标题/卖点",
  "商品价格",
  "成本价",
  "库存",
  "商品状态",
  "一级类目",
  "二级类目",
  "商品标签",
  "是否热门推荐",
  "是否推广页热门",
  "主图文件名",
  "轮播图文件名",
  "视频URL",
  "详情图文件名",
  "详情文字说明",
  "是否开启AI预览",
  "AI预览类型",
  "是否参与推广奖励",
  "一级奖励金额",
  "二级奖励金额",
  "排序"
]

const IMPORT_TEMPLATE_ROWS = [
  {
    "商品名称": "宠物照片3D摆件",
    "商品副标题/卖点": "上传照片定制，桌面治愈摆件",
    "商品价格": "129",
    "成本价": "45",
    "库存": "999",
    "商品状态": "上架",
    "一级类目": "3D打印",
    "二级类目": "模型定制",
    "商品标签": "人气",
    "是否热门推荐": "是",
    "是否推广页热门": "是",
    "主图文件名": "pet-main.jpg",
    "轮播图文件名": "pet-1.jpg;pet-2.jpg",
    "视频URL": "",
    "详情图文件名": "pet-detail1.jpg;pet-detail2.jpg",
    "详情文字说明": "支持宠物照片定制，下单后客服确认设计稿。",
    "是否开启AI预览": "是",
    "AI预览类型": "摆件",
    "是否参与推广奖励": "是",
    "一级奖励金额": "18",
    "二级奖励金额": "6",
    "排序": "10"
  },
  {
    "商品名称": "天然叶雕纪念礼",
    "商品副标题/卖点": "把照片刻进天然叶片，送礼高级不撞款",
    "商品价格": "168",
    "成本价": "58",
    "库存": "999",
    "商品状态": "上架",
    "一级类目": "激光定制",
    "二级类目": "照片雕刻",
    "商品标签": "爆品",
    "是否热门推荐": "是",
    "是否推广页热门": "是",
    "主图文件名": "leaf-main.jpg",
    "轮播图文件名": "leaf-1.jpg;leaf-2.jpg",
    "视频URL": "",
    "详情图文件名": "leaf-detail1.jpg;leaf-detail2.jpg",
    "详情文字说明": "支持照片、姓名、日期和祝福语定制，制作前客服确认设计稿。",
    "是否开启AI预览": "是",
    "AI预览类型": "叶雕",
    "是否参与推广奖励": "是",
    "一级奖励金额": "25",
    "二级奖励金额": "8",
    "排序": "20"
  }
]

function xmlEscape(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

function xmlUnescape(value) {
  return String(value == null ? "" : value)
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
}

function columnName(index) {
  let name = ""
  let current = index + 1
  while (current > 0) {
    const mod = (current - 1) % 26
    name = String.fromCharCode(65 + mod) + name
    current = Math.floor((current - mod) / 26)
  }
  return name
}

function columnIndex(ref) {
  const letters = String(ref || "").replace(/\d/g, "")
  return letters.split("").reduce((sum, char) => sum * 26 + char.charCodeAt(0) - 64, 0) - 1
}

function createProductImportTemplateBuffer() {
  const dir = fs.mkdtempSync(path.join(importTempDir, "template-"))
  const xlDir = path.join(dir, "xl")
  const relsDir = path.join(dir, "_rels")
  const xlRelsDir = path.join(xlDir, "_rels")
  const worksheetsDir = path.join(xlDir, "worksheets")
  fs.mkdirSync(relsDir, { recursive: true })
  fs.mkdirSync(xlRelsDir, { recursive: true })
  fs.mkdirSync(worksheetsDir, { recursive: true })
  const rows = [IMPORT_TEMPLATE_HEADERS, ...IMPORT_TEMPLATE_ROWS.map(row => IMPORT_TEMPLATE_HEADERS.map(header => row[header] || ""))]
  const sheetRows = rows.map((row, rowIndex) => {
    const cells = row.map((value, cellIndex) => `<c r="${columnName(cellIndex)}${rowIndex + 1}" t="inlineStr"><is><t>${xmlEscape(value)}</t></is></c>`).join("")
    return `<row r="${rowIndex + 1}">${cells}</row>`
  }).join("")
  fs.writeFileSync(path.join(dir, "[Content_Types].xml"), `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`)
  fs.writeFileSync(path.join(relsDir, ".rels"), `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`)
  fs.writeFileSync(path.join(xlDir, "workbook.xml"), `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="商品导入模板" sheetId="1" r:id="rId1"/></sheets></workbook>`)
  fs.writeFileSync(path.join(xlRelsDir, "workbook.xml.rels"), `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`)
  fs.writeFileSync(path.join(worksheetsDir, "sheet1.xml"), `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`)
  const file = path.join(importTempDir, `product-import-template-${Date.now()}.xlsx`)
  execFileSync("zip", ["-qr", file, "."], { cwd: dir })
  const buffer = fs.readFileSync(file)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.rmSync(file, { force: true })
  return buffer
}

function readZipEntry(zipFile, entryName, maxBuffer = MAX_IMPORT_ZIP_SIZE) {
  return execFileSync("unzip", ["-p", zipFile, entryName], { maxBuffer })
}

function listZipEntries(zipFile) {
  return execFileSync("unzip", ["-Z1", zipFile], { encoding: "utf8", maxBuffer: 5 * 1024 * 1024 })
    .split(/\r?\n/)
    .map(item => item.trim())
    .filter(Boolean)
}

function cleanupProductImportPreviews(force = false) {
  const now = Date.now()
  for (const [token, preview] of productImportPreviews.entries()) {
    if (force || now - preview.createdAt > IMPORT_PREVIEW_TTL) {
      if (Array.isArray(preview.createdFiles)) {
        preview.createdFiles.forEach(file => fs.rmSync(file, { force: true }))
      }
      if (preview.tempDir) fs.rmSync(preview.tempDir, { recursive: true, force: true })
      productImportPreviews.delete(token)
    }
  }
}

function parseSharedStrings(xml) {
  const values = []
  const matches = xml.match(/<si[\s\S]*?<\/si>/g) || []
  for (const item of matches) {
    const texts = [...item.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(match => xmlUnescape(match[1]))
    values.push(texts.join(""))
  }
  return values
}

function parseSheetRows(xml, sharedStrings = []) {
  const rows = []
  const rowMatches = xml.match(/<row\b[\s\S]*?<\/row>/g) || []
  for (const rowXml of rowMatches) {
    const cells = []
    const cellMatches = rowXml.match(/<c\b[\s\S]*?<\/c>/g) || []
    for (const cellXml of cellMatches) {
      const ref = /r="([^"]+)"/.exec(cellXml)?.[1] || ""
      const type = /t="([^"]+)"/.exec(cellXml)?.[1] || ""
      const index = columnIndex(ref)
      let value = ""
      if (type === "s") {
        const raw = /<v[^>]*>([\s\S]*?)<\/v>/.exec(cellXml)?.[1] || ""
        value = sharedStrings[Number(raw)] || ""
      } else if (type === "inlineStr") {
        value = [...cellXml.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(match => xmlUnescape(match[1])).join("")
      } else {
        value = xmlUnescape(/<v[^>]*>([\s\S]*?)<\/v>/.exec(cellXml)?.[1] || "")
      }
      if (index >= 0) cells[index] = String(value).trim()
    }
    rows.push(cells)
  }
  return rows
}

function parseXlsxRows(buffer) {
  const file = path.join(importTempDir, `upload-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.xlsx`)
  fs.writeFileSync(file, buffer)
  try {
    const entries = listZipEntries(file)
    const sheetEntry = entries.find(item => /^xl\/worksheets\/sheet\d+\.xml$/.test(item)) || "xl/worksheets/sheet1.xml"
    const sharedEntry = entries.includes("xl/sharedStrings.xml") ? "xl/sharedStrings.xml" : ""
    const sharedStrings = sharedEntry ? parseSharedStrings(readZipEntry(file, sharedEntry).toString("utf8")) : []
    return parseSheetRows(readZipEntry(file, sheetEntry).toString("utf8"), sharedStrings)
  } finally {
    fs.rmSync(file, { force: true })
  }
}

function splitImportList(value) {
  return String(value || "").split(";").map(item => item.trim()).filter(Boolean)
}

function boolText(value, defaultValue = false) {
  const text = String(value == null ? "" : value).trim().toLowerCase()
  if (!text) return defaultValue
  if (["是", "true", "1", "yes", "y", "on"].includes(text)) return true
  if (["否", "false", "0", "no", "n", "off"].includes(text)) return false
  return defaultValue
}

function numberText(value, field, required, errors) {
  const text = String(value == null ? "" : value).trim()
  if (!text) {
    if (required) errors.push(`${field}必填`)
    return ""
  }
  if (!Number.isFinite(Number(text))) {
    errors.push(`${field}必须为数字`)
    return text
  }
  return String(Number(text))
}

function intText(value, field, defaultValue, errors) {
  const text = String(value == null ? "" : value).trim()
  if (!text) return String(defaultValue)
  if (!/^\d+$/.test(text)) {
    errors.push(`${field}必须为整数`)
    return text
  }
  return String(Number(text))
}

function importStatus(value, errors) {
  const text = String(value || "").trim()
  if (text === "上架") return "on"
  if (text === "下架") return "off"
  errors.push("商品状态只允许：上架/下架")
  return "on"
}

function importBadge(value, errors) {
  const text = String(value || "无标签").trim()
  if (!["无标签", "新品", "人气", "爆品", ""].includes(text)) errors.push("商品标签只允许：无标签/新品/人气/爆品")
  return normalizeBadge(text || "无标签")
}

function importAiPreviewType(value, errors) {
  const text = String(value || "").trim()
  const map = { 叶雕: "leaf", 摆件: "stand", 木牌: "wood", 军牌: "dogtag", 情侣礼物: "couple" }
  if (!text) return ""
  if (!map[text]) errors.push("AI预览类型只允许：叶雕/摆件/木牌/军牌/情侣礼物")
  return map[text] || text
}

function isExternalOrLocalAsset(value) {
  return /^https?:\/\//.test(value) || value.startsWith("/uploads/") || value.startsWith("/cms/uploads/")
}

function normalizeImportedAssetPath(value) {
  const text = String(value || "").trim()
  if (text.startsWith("/cms/uploads/")) return `${PUBLIC_BASE_URL}${text.replace(/^\/cms\/uploads/, "/uploads")}`
  if (text.startsWith("/uploads/")) return `${PUBLIC_BASE_URL}${text}`
  return text
}

function safeZipImageEntries(zipFile) {
  if (!zipFile) return new Map()
  const map = new Map()
  for (const entry of listZipEntries(zipFile)) {
    if (entry.endsWith("/")) continue
    if (entry.includes("../") || entry.includes("..\\") || /^[a-zA-Z]:[\\/]/.test(entry)) {
      throw new Error(`图片包存在非法路径：${entry}`)
    }
    const normalized = path.posix.normalize(entry.replace(/\\/g, "/"))
    if (normalized.startsWith("../") || normalized.includes("/../") || path.posix.isAbsolute(normalized)) {
      throw new Error(`图片包存在非法路径：${entry}`)
    }
    const ext = path.extname(normalized).toLowerCase()
    if (ZIP_BLOCKED_EXTS.has(ext)) throw new Error(`图片包包含禁止文件：${entry}`)
    if (!ZIP_ALLOWED_IMAGE_EXTS.has(ext)) throw new Error(`图片包仅允许 jpg/jpeg/png/webp/gif 图片：${entry}`)
    const base = path.posix.basename(normalized).toLowerCase()
    if (!map.has(base)) map.set(base, normalized)
  }
  return map
}

function uniqueProductUploadName(originalName) {
  const ext = path.extname(originalName).toLowerCase() || ".jpg"
  const base = path.basename(originalName, ext).replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "product"
  let filename = `${base}${ext}`
  if (!fs.existsSync(path.join(productUploadsDir, filename))) return filename
  filename = `${base}-${Date.now()}${ext}`
  while (fs.existsSync(path.join(productUploadsDir, filename))) {
    filename = `${base}-${Date.now()}-${crypto.randomBytes(2).toString("hex")}${ext}`
  }
  return filename
}

function resolveImportedImage(value, imageMap, zipFile, errors, required, label, createdFiles = []) {
  const text = String(value || "").trim()
  if (!text) {
    if (required) errors.push(`${label}必填`)
    return ""
  }
  if (isExternalOrLocalAsset(text)) return normalizeImportedAssetPath(text)
  const entry = imageMap.get(path.posix.basename(text).toLowerCase())
  if (!entry) {
    errors.push(`${label}在图片ZIP中未找到：${text}`)
    return ""
  }
  const filename = uniqueProductUploadName(path.posix.basename(entry))
  const targetFile = path.join(productUploadsDir, filename)
  fs.writeFileSync(targetFile, readZipEntry(zipFile, entry, MAX_IMAGE_SIZE + 1024 * 1024))
  createdFiles.push(targetFile)
  return `${PUBLIC_BASE_URL}/uploads/products/${filename}`
}

function rowObjectFromImport(headers, row) {
  return Object.fromEntries(headers.map((header, index) => [header, row[index] == null ? "" : row[index]]))
}

function buildImportedProduct(row, rowNumber, imageMap, zipFile, existingProducts, createdFiles) {
  const errors = []
  const name = String(row["商品名称"] || "").trim()
  if (!name) errors.push("商品名称必填")
  const price = numberText(row["商品价格"], "商品价格", true, errors)
  const costPrice = numberText(row["成本价"], "成本价", false, errors) || "0"
  const stock = intText(row["库存"], "库存", 999, errors)
  const sortOrder = intText(row["排序"], "排序", 999, errors)
  const primary = String(row["一级类目"] || "").trim()
  if (!primary) errors.push("一级类目必填")
  const seconds = splitImportList(row["二级类目"])
  const categories = primary ? [primary, ...seconds.map(second => `${primary}/${second}`)] : []
  const mainImage = resolveImportedImage(row["主图文件名"], imageMap, zipFile, errors, true, "主图文件名", createdFiles)
  const galleryImages = splitImportList(row["轮播图文件名"]).map(item => resolveImportedImage(item, imageMap, zipFile, errors, false, "轮播图文件名", createdFiles)).filter(Boolean)
  const detailImages = splitImportList(row["详情图文件名"]).map(item => resolveImportedImage(item, imageMap, zipFile, errors, false, "详情图文件名", createdFiles)).filter(Boolean)
  const existing = existingProducts.find(product => product.name === name)
  const product = normalizeProduct({
    id: existing?.id || `P${Date.now()}${crypto.randomBytes(3).toString("hex").toUpperCase()}`,
    name,
    intro: row["商品副标题/卖点"] || "",
    price,
    costPrice,
    badge: importBadge(row["商品标签"], errors),
    cover: "keyring",
    imageUrl: mainImage,
    galleryImages,
    videoUrl: row["视频URL"] || "",
    detailImages,
    detailText: row["详情文字说明"] || "",
    categories,
    status: importStatus(row["商品状态"], errors),
    stock,
    isHot: boolText(row["是否热门推荐"], false) ? "true" : "false",
    promotionHot: boolText(row["是否推广页热门"], false) ? "true" : "false",
    aiPreviewEnabled: boolText(row["是否开启AI预览"], false) ? "true" : "false",
    aiPreviewType: importAiPreviewType(row["AI预览类型"], errors),
    rewardEnabled: boolText(row["是否参与推广奖励"], true) ? "true" : "false",
    firstReward: numberText(row["一级奖励金额"], "一级奖励金额", false, errors) || "0",
    secondReward: numberText(row["二级奖励金额"], "二级奖励金额", false, errors) || "0",
    sortOrder
  }, 0)
  product.sortOrder = sortOrder
  return {
    rowNumber,
    name,
    price,
    primaryCategory: primary,
    badge: product.badge,
    status: product.status,
    mainImage,
    galleryCount: galleryImages.length,
    detailCount: detailImages.length,
    action: existing ? "更新" : "新增",
    ok: errors.length === 0,
    errors,
    product
  }
}

async function createProductImportPreview(parts) {
  cleanupProductImportPreviews()
  const excel = parts.find(part => part.name === "excel" || /\.xlsx$/i.test(part.filename || ""))
  const zip = parts.find(part => part.name === "zip" || /\.zip$/i.test(part.filename || ""))
  if (!excel) throw new Error("请上传商品 Excel（.xlsx）")
  if (!/\.xlsx$/i.test(excel.filename || "")) throw new Error("Excel 只支持 .xlsx")
  if (excel.body.length > MAX_IMPORT_EXCEL_SIZE) throw new Error("Excel 文件超过5MB，请精简后上传")
  if (zip && !/\.zip$/i.test(zip.filename || "")) throw new Error("图片包只支持 .zip")
  if (zip && zip.body.length > MAX_IMPORT_ZIP_SIZE) throw new Error("图片ZIP超过50MB，请压缩后上传")
  const tempDir = fs.mkdtempSync(path.join(importTempDir, "preview-"))
  const zipFile = zip ? path.join(tempDir, `images-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.zip`) : ""
  const createdFiles = []
  if (zipFile) fs.writeFileSync(zipFile, zip.body)
  try {
    const rows = parseXlsxRows(excel.body)
    if (rows.length < 2) throw new Error("Excel 没有可导入的数据行")
    const headers = rows[0].map(item => String(item || "").trim())
    const missing = IMPORT_TEMPLATE_HEADERS.filter(header => !headers.includes(header))
    if (missing.length) throw new Error(`Excel 缺少字段：${missing.join("、")}`)
    const imageMap = safeZipImageEntries(zipFile)
    const existingProducts = await getProducts()
    const items = rows.slice(1)
      .map((row, index) => ({ row, rowNumber: index + 2 }))
      .filter(({ row }) => row.some(value => String(value || "").trim()))
      .map(({ row, rowNumber }) => buildImportedProduct(rowObjectFromImport(headers, row), rowNumber, imageMap, zipFile, existingProducts, createdFiles))
    const token = crypto.randomBytes(18).toString("hex")
    const summary = {
      total: items.length,
      importable: items.filter(item => item.ok).length,
      errors: items.filter(item => !item.ok).length,
      creates: items.filter(item => item.ok && item.action === "新增").length,
      updates: items.filter(item => item.ok && item.action === "更新").length
    }
    productImportPreviews.set(token, { token, items, summary, createdFiles, tempDir, createdAt: Date.now() })
    return { token, summary, rows: items.map(item => ({ ...item, product: undefined })) }
  } catch (error) {
    createdFiles.forEach(file => fs.rmSync(file, { force: true }))
    fs.rmSync(tempDir, { recursive: true, force: true })
    throw error
  } finally {
    if (zipFile) fs.rmSync(zipFile, { force: true })
  }
}

async function confirmProductImport(token) {
  const preview = productImportPreviews.get(token)
  if (!preview) throw new Error("导入预览已过期，请重新解析")
  const current = await getProducts()
  const failures = []
  let created = 0
  let updated = 0
  const next = [...current]
  for (const item of preview.items) {
    if (!item.ok) {
      failures.push({ rowNumber: item.rowNumber, name: item.name, reason: item.errors.join("；") })
      continue
    }
    try {
      const index = next.findIndex(product => product.name === item.product.name)
      if (index >= 0) {
        next[index] = { ...next[index], ...item.product, id: next[index].id }
        updated += 1
      } else {
        next.push(item.product)
        created += 1
      }
    } catch (error) {
      failures.push({ rowNumber: item.rowNumber, name: item.name, reason: error.message || "写入失败" })
    }
  }
  next.sort((a, b) => Number(a.sortOrder || 999) - Number(b.sortOrder || 999))
  await saveProducts(next)
  await syncCategoryCatalogFromProducts(next)
  if (preview.tempDir) fs.rmSync(preview.tempDir, { recursive: true, force: true })
  productImportPreviews.delete(token)
  return { created, updated, failed: failures.length, failures }
}

async function syncCategoryCatalogFromProducts(products = []) {
  const settings = await getSettings()
  await saveSettings({ ...settings, categoryCatalog: settings.categoryCatalog })
}

function defaultAds() {
  return {
    profile_bottom_ad: {
      key: "profile_bottom_ad",
      title: "新人专享福利",
      subtitle: "上传照片，定制专属礼物",
      imageUrl: "",
      linkType: "none",
      linkValue: "",
      enabled: "true",
      sort: "1"
    },
    after_sales_guide_ad: {
      key: "after_sales_guide_ad",
      title: "新手下单指南",
      subtitle: "了解定制流程、发货时效与售后保障",
      imageUrl: "",
      linkType: "none",
      linkValue: "",
      enabled: "true",
      sort: "2"
    },
    promotion_share_ad: {
      key: "promotion_share_ad",
      title: "非常智造 · 朋友推荐给你",
      subtitle: "上传照片，定制专属礼物",
      imageUrl: "/assets/share-promotion.png",
      linkType: "page",
      linkValue: "/pages/index/index",
      enabled: "true",
      sort: "3"
    }
  }
}

function normalizeAdSlot(item, key, fallback) {
  const source = item && typeof item === "object" ? item : {}
  const has = field => Object.prototype.hasOwnProperty.call(source, field)
  const imageValue = has("imageUrl") ? source.imageUrl : fallback.imageUrl
  const imageVariants = uploadImageVariants(imageValue || "")
  return {
    key,
    title: has("title") ? String(source.title || "") : (fallback.title || ""),
    subtitle: has("subtitle") ? String(source.subtitle || "") : (has("desc") ? String(source.desc || "") : (fallback.subtitle || "")),
    imageUrl: imageVariants.url,
    optimizedUrl: source.optimizedUrl ? publicAssetUrl(source.optimizedUrl) : imageVariants.optimizedUrl,
    thumbUrl: source.thumbUrl ? publicAssetUrl(source.thumbUrl) : imageVariants.thumbUrl,
    bannerUrl: source.bannerUrl ? publicAssetUrl(source.bannerUrl) : imageVariants.bannerUrl,
    bannerThumbUrl: source.bannerThumbUrl ? publicAssetUrl(source.bannerThumbUrl) : imageVariants.bannerThumbUrl,
    linkType: has("linkType") ? String(source.linkType || "none") : (source.targetType || fallback.linkType || "none"),
    linkValue: has("linkValue") ? String(source.linkValue || "") : (source.targetValue || fallback.linkValue || ""),
    enabled: String(source.enabled == null ? fallback.enabled || "true" : source.enabled),
    sort: String(source.sort == null ? fallback.sort || "999" : source.sort)
  }
}

function homepageProductSort(a, b) {
  return Number(a.sortOrder || a.sort || 999) - Number(b.sortOrder || b.sort || 999)
}

function isPublicProduct(product = {}) {
  return normalizeProductStatus(product.status) === "on"
}

function publicProductView(product = {}) {
  const {
    costPrice,
    rewardEnabled,
    firstReward,
    secondReward,
    modelCandidateId,
    modelSourceUrl,
    modelAuthorName,
    modelAuthorizationStatus,
    modelAuthorizationNote,
    inventoryVersion,
    ...publicProduct
  } = product
  return publicProduct
}

function homepageRecommendedProducts(products = []) {
  const online = products.filter(isPublicProduct)
  return online
    .filter(product => String(product.isHot) === "true")
    .sort(homepageProductSort)
    .slice(0, 6)
    .map(publicProductView)
}

function homepageBurstProducts(products = []) {
  return products
    .filter(product => isPublicProduct(product) && product.badge === "best" && String(product.isHot) !== "true")
    .sort(homepageProductSort)
    .slice(0, 4)
    .map(publicProductView)
}

function normalizeAds(value) {
  const fallback = defaultAds()
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {}
  return Object.fromEntries(Object.keys(fallback).map(key => [key, normalizeAdSlot(source[key], key, fallback[key])]))
}

function normalizeHome(data) {
  const homeUpdatedAt = data.updatedAt || data.homeUpdatedAt || ""
  const defaultHomeEntries = [
    { name: "激光定制", desc: "上传照片定制礼物", icon: "◆", imageUrl: "", targetType: "primary", targetValue: "激光定制", visible: "true", sort: "1" },
    { name: "3D打印", desc: "模型文件直接生产", icon: "✦", imageUrl: "", targetType: "primary", targetValue: "3D打印", visible: "true", sort: "2" },
    { name: "潮玩手办", desc: "热门现货直接购买", icon: "＋", imageUrl: "", targetType: "primary", targetValue: "潮玩手办", visible: "true", sort: "3" },
    { name: "日用好货", desc: "零食饮料 · 家庭纸品", icon: "货", imageUrl: "", targetType: "primary", targetValue: "日用好货", visible: "true", sort: "4" }
  ]
  return {
    banners: (Array.isArray(data.banners) ? data.banners : []).slice(0, 3).map(item => {
      const imageVariants = uploadImageVariants(item.imageUrl)
      const bannerVersion = item.version || item.updatedAt || homeUpdatedAt || ""
      const optimizedUrl = currentBannerAsset(item.imageUrl, item.optimizedUrl, imageVariants.optimizedUrl)
      const thumbUrl = currentBannerAsset(item.imageUrl, item.thumbUrl, imageVariants.thumbUrl)
      const bannerUrl = currentBannerAsset(item.imageUrl, item.bannerUrl, imageVariants.bannerUrl || optimizedUrl)
      const bannerThumbUrl = currentBannerAsset(item.imageUrl, item.bannerThumbUrl, imageVariants.bannerThumbUrl || thumbUrl)
      const displayUrl = bannerUrl || optimizedUrl || imageVariants.url
      return {
        ...item,
        imageUrl: imageVariants.url,
        optimizedUrl,
        thumbUrl,
        bannerUrl,
        bannerThumbUrl,
        finalImageUrl: withVersion(displayUrl, bannerVersion),
        version: bannerVersion,
        updatedAt: item.updatedAt || bannerVersion,
        targetType: item.targetType || "primary",
        targetValue: item.targetValue || ""
      }
    }),
    categories: [
      { icon: "◆", name: "激光定制", desc: "照片雕刻 / 刻字礼品 / 企业LOGO" },
      { icon: "✦", name: "3D打印", desc: "模型定制 / 来图定制 / 批量打印" },
      { icon: "＋", name: "潮玩手办", desc: "现货手办 / 桌面摆件 / 解压玩具" },
      { icon: "货", name: "日用好货", desc: "零食饮料 / 家庭纸品 / 特价专区" }
    ],
    homeEntries: (Array.isArray(data.homeEntries) && data.homeEntries.length ? data.homeEntries : defaultHomeEntries).slice(0, 4).map((rawItem, index) => {
      const item = rawItem.name === "联系客服" || rawItem.targetType === "service"
        ? { ...rawItem, name: "日用好货", desc: rawItem.desc && rawItem.name !== "联系客服" ? rawItem.desc : "零食饮料 · 家庭纸品", icon: rawItem.icon === "☎" || rawItem.icon === "聊" ? "货" : (rawItem.icon || "货"), targetType: "primary", targetValue: "日用好货" }
        : { ...rawItem }
      if (item.name === "日用好货" && ["食品饮料 · 日用百货", "食品饮料 / 日用百货"].includes(item.desc)) item.desc = "零食饮料 · 家庭纸品"
      const normalizedTarget = normalizeCategoryPath(item.targetValue)
      if (normalizedTarget.length) {
        item.targetValue = normalizedTarget[normalizedTarget.length - 1]
        item.targetType = item.targetValue.includes("/") ? "secondary" : "primary"
      }
      const imageVariants = uploadImageVariants(item.imageUrl)
      return {
      name: item.name || defaultHomeEntries[index]?.name || `入口${index + 1}`,
      desc: item.desc || "",
      icon: item.icon || defaultHomeEntries[index]?.icon || "＋",
      imageUrl: imageVariants.url,
      thumbUrl: item.thumbUrl ? publicAssetUrl(item.thumbUrl) : imageVariants.thumbUrl,
      targetType: item.targetType || "primary",
      targetValue: item.targetValue || "",
      visible: String(item.visible == null ? "true" : item.visible),
      sort: String(item.sort || index + 1)
    }}),
    trustTags: (Array.isArray(data.trustTags) ? data.trustTags : []).map(item => ({ ...item, text: item.text === "48小时发货" ? "急速生产" : item.text })),
    products: (Array.isArray(data.products) ? data.products : []).map(normalizeProduct),
    reviews: Array.isArray(data.reviews) ? data.reviews : [],
    promoText: data.promoText || "",
    sectionTitle: data.sectionTitle || "热门商品",
    sectionSubtitle: data.sectionSubtitle || "",
    contact: {
      phone: data.contact?.phone || "",
      wechat: data.contact?.wechat || "",
      workWechatUrl: data.contact?.workWechatUrl || ""
    },
    ads: normalizeAds(data.ads),
    updatedAt: new Date().toISOString()
  }
}

function normalizeBadge(value) {
  const text = String(value || "").trim()
  if (!text || ["none", "无", "无标签", "null", "undefined"].includes(text)) return ""
  const map = {
    新品: "new",
    新品推荐: "new",
    人气: "hot",
    人气热卖: "hot",
    人气礼物: "hot",
    高复购: "hot",
    爆品: "best",
    爆品推荐: "best",
    试运营爆款: "best",
    入门首选: "new"
  }
  return map[text] || text
}

function normalizeBooleanText(value, defaultValue = false) {
  if (value == null || value === "") return defaultValue ? "true" : "false"
  const text = String(value).trim().toLowerCase()
  if (["true", "1", "yes", "y", "on", "是", "热门", "推荐"].includes(text)) return "true"
  if (["false", "0", "no", "n", "off", "否", "不推荐"].includes(text)) return "false"
  return defaultValue ? "true" : "false"
}

function normalizeProductStatus(value) {
  const text = String(value == null ? "on" : value).trim().toLowerCase()
  if (["draft", "草稿"].includes(text)) return "draft"
  if (["off", "下架", "disabled", "inactive", "false", "0"].includes(text)) return "off"
  return "on"
}

function inferProductCategories(product) {
  const text = `${product.name || ""} ${product.intro || ""}`
  return PRODUCT_CATEGORIES.filter(category => {
    const rules = {
      "激光定制": ["激光", "雕刻", "刻字", "吊牌", "首饰", "文具", "手机壳", "LOGO", "叶雕"],
      "激光定制/照片雕刻": ["照片", "叶雕", "真叶"],
      "激光定制/刻字礼品": ["刻字", "名字", "木牌"],
      "3D打印": ["3D", "建模", "模型", "打印"],
      "3D打印/模型定制": ["模型", "建模", "宠物"],
      "3D打印/配件打印": ["零件", "配件"],
      "潮玩手办": ["手办", "摆件", "解压", "钥匙扣", "书签", "车载", "生日"],
      "潮玩手办/解压玩具": ["解压"],
      "潮玩手办/钥匙挂件": ["钥匙扣", "挂件"],
      "日用好货": ["零食", "饮料", "纸品", "日化", "清洁", "个护", "厨房", "宿舍", "特价"]
    }
    return (rules[category] || []).some(keyword => text.includes(keyword))
  })
}

function normalizeProductCategories(value, product) {
  const list = Array.isArray(value)
    ? value
    : String(value || "").split(/[,，;]/).map(item => item.trim()).filter(Boolean)
  const categories = list.map(item => String(item || "").trim()).filter(Boolean)
  const primary = String(product?.categoryLevel1 || product?.primaryCategory || product?.primary || "").trim()
  const secondSource = product?.categoryLevel2 || product?.secondaryCategories || product?.secondaryCategory || product?.secondary || ""
  const seconds = Array.isArray(secondSource)
    ? secondSource
    : String(secondSource || "").split(/[,，;]/)
  if (primary) {
    categories.push(...normalizeCategoryPath(primary))
    seconds.map(item => String(item || "").trim()).filter(Boolean).forEach(second => {
      categories.push(...normalizeCategoryPath(second.includes("/") ? second : `${primary}/${second}`))
    })
  }
  const normalized = categories.flatMap(normalizeCategoryPath)
  const unique = [...new Set(normalized)]
  return unique.length ? unique : inferProductCategories(product)
}

function productCategoryLevels(categories = [], product = {}) {
  const list = Array.isArray(categories) ? categories.map(item => String(item || "").trim()).filter(Boolean) : []
  const tree = activeCategoryTree && Object.keys(activeCategoryTree).length ? activeCategoryTree : CATEGORY_TREE
  const primaryCandidates = list.filter(item => !item.includes("/") && tree[item])
  const text = `${product.name || ""} ${product.intro || ""}`
  const preferredPrimary =
    (primaryCandidates.includes("潮玩手办") && /钥匙|挂件|手办|摆件|解压|书签|车载|生日|现货|新品/.test(text) && "潮玩手办") ||
    (primaryCandidates.includes("日用好货") && /零食|饮料|纸品|日化|清洁|个护|厨房|宿舍|特价/.test(text) && "日用好货") ||
    (primaryCandidates.includes("3D打印") && /3D|模型|建模|打印|配件|批量/.test(text) && "3D打印") ||
    (primaryCandidates.includes("激光定制") && /激光|雕刻|刻字|叶雕|照片|LOGO|首饰|文具|手机/.test(text) && "激光定制") ||
    ""
  const firstPrimary = preferredPrimary || primaryCandidates[0]
  const firstWithSecond = firstPrimary
    ? list.find(item => item.startsWith(`${firstPrimary}/`))
    : list.find(item => item.includes("/"))
  if (firstWithSecond) {
    const [categoryLevel1, categoryLevel2] = firstWithSecond.split("/")
    return { categoryLevel1, categoryLevel2 }
  }
  const categoryLevel1 = firstPrimary || list[0] || ""
  return { categoryLevel1, categoryLevel2: "" }
}

function detectImageExt(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return ""
  if (buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return "jpg"
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png"
  if (buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") return "webp"
  if (buffer.subarray(4, 8).toString("ascii") === "ftyp") {
    const brand = buffer.subarray(8, 16).toString("ascii").toLowerCase()
    if (/hei[cf]|mif1|msf1/.test(brand)) return "heic"
  }
  return ""
}

function validateImageFile(file, options = {}) {
  const ext = path.extname(file.filename || "").toLowerCase().replace(".", "")
  const allowedExts = options.allowedExts || ["jpg", "jpeg", "png", "webp", "heic", "heif"]
  const allowedMimes = options.allowedMimes || ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"]
  const maxSize = options.maxSize || MAX_IMAGE_SIZE
  const tooLargeMessage = options.tooLargeMessage || "图片超过10MB，请压缩后上传"
  const detectedExt = detectImageExt(file.body)
  if (!allowedExts.includes(ext) && !allowedMimes.includes(file.mimeType) && !detectedExt) {
    throw new Error("图片格式不支持，请选择jpg/png/webp/heic")
  }
  if (file.body.length > maxSize) {
    throw new Error(tooLargeMessage)
  }
  return ext && allowedExts.includes(ext) ? ext : detectedExt || "jpg"
}

function validateUploadFile(file) {
  const ext = path.extname(file.filename || "").toLowerCase().replace(".", "")
  const isVideo = ext === "mp4" || file.mimeType === "video/mp4"
  if (isVideo) {
    if (file.body.length > MAX_VIDEO_SIZE) throw new Error("视频超过50MB，请压缩后上传")
    return { type: "video", ext: "mp4" }
  }
  return { type: "image", ext: validateImageFile(file) }
}

function validatePublicUploadImage(file, loggedIn) {
  const ext = path.extname(file.filename || "").toLowerCase().replace(".", "")
  const mimeType = String(file.mimeType || "").toLowerCase()
  const maxSize = loggedIn ? MAX_IMAGE_SIZE : MAX_TEMP_IMAGE_SIZE
  const detectedExt = detectImageExt(file.body)
  const normalizeExt = value => value === "jpeg" ? "jpg" : value === "heif" ? "heic" : value
  const mimeExtMap = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/heic": "heic",
    "image/heif": "heic"
  }
  const allowedExts = new Set(["jpg", "jpeg", "png", "webp", "heic", "heif"])
  if (file.body.length > maxSize) {
    throw uploadInputError(413, loggedIn ? "图片超过10MB，请压缩后上传" : "临时上传图片超过5MB，请登录后上传或压缩图片")
  }
  if (!detectedExt) {
    throw uploadInputError(400, "图片内容校验失败，请选择真实的jpg/png/webp/heic图片")
  }
  if (ext && (!allowedExts.has(ext) || normalizeExt(ext) !== detectedExt)) {
    throw uploadInputError(400, "图片扩展名与真实格式不一致，请重新选择图片")
  }
  if (mimeType && mimeExtMap[mimeType] && mimeExtMap[mimeType] !== detectedExt) {
    throw uploadInputError(400, "图片MIME类型与真实格式不一致，请重新选择图片")
  }
  if (mimeType && mimeType.startsWith("image/") && !mimeExtMap[mimeType]) {
    throw uploadInputError(400, "图片格式不支持，请选择jpg/png/webp/heic")
  }
  return { type: "image", ext: detectedExt }
}

async function writeOptimizedImage(sourceFile, outputName, options = {}) {
  if (!sharp) return null
  const targetFile = path.join(uploadsDir, outputName)
  const pipeline = sharp(sourceFile, { failOnError: false }).rotate()
  if (options.fit === "cover") {
    pipeline.resize(options.width, options.height, { fit: "cover", position: "centre" })
  } else {
    pipeline.resize({ width: options.width, height: options.height, fit: "inside", withoutEnlargement: true })
  }
  try {
    await pipeline.webp({ quality: options.quality || 78 }).toFile(targetFile)
    return targetFile
  } catch (error) {
    const jpgName = outputName.replace(/\.webp$/i, ".jpg")
    const jpgFile = path.join(uploadsDir, jpgName)
    await sharp(sourceFile, { failOnError: false })
      .rotate()
      .resize(options.fit === "cover"
        ? { width: options.width, height: options.height, fit: "cover", position: "centre" }
        : { width: options.width, height: options.height, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: options.quality || 78, mozjpeg: true })
      .toFile(jpgFile)
    return jpgFile
  }
}

async function optimizeUploadedImage(sourceFile, filename, type = "image") {
  const originalUrl = uploadPublicUrl(filename)
  const variants = uploadImageVariants(originalUrl)
  const result = {
    ...variants,
    width: null,
    height: null,
    size: fs.existsSync(sourceFile) ? fs.statSync(sourceFile).size : 0,
    warning: ""
  }
  if (type !== "image" || /\.svg$/i.test(filename)) return result
  if (!sharp) {
    result.warning = "图片压缩组件不可用，已保存原图"
    return result
  }
  try {
    const meta = await sharp(sourceFile, { failOnError: false }).metadata()
    result.width = meta.width || null
    result.height = meta.height || null
    const tasks = [
      [".optimized", { width: 1200, height: 1200, fit: "inside", quality: 80 }],
      [".banner", { width: 1200, height: 500, fit: "cover", quality: 80 }],
      [".banner-thumb", { width: 600, height: 250, fit: "cover", quality: 74 }],
      [".thumb", { width: 400, height: 400, fit: "cover", quality: 80 }],
      [".cart-thumb", { width: 200, height: 200, fit: "cover", quality: 74 }],
      [".detail", { width: 800, height: 4000, fit: "inside", quality: 80 }]
    ]
    for (const [suffix, options] of tasks) {
      const outputName = uploadVariantFilename(filename, suffix, "webp")
      if (outputName && !fs.existsSync(path.join(uploadsDir, outputName))) {
        await writeOptimizedImage(sourceFile, outputName, options)
      }
    }
    return { ...result, ...uploadImageVariants(originalUrl) }
  } catch (error) {
    result.warning = "图片压缩失败，已保存原图"
    return result
  }
}

function normalizeMediaList(value) {
  const list = Array.isArray(value) ? value : String(value || "").split(/[,，\n]/)
  return list.map(item => String(item || "").trim()).filter(Boolean)
}

function normalizeHelpArticles(value) {
  const defaults = [
    { id: "HELP1", title: "下单流程", summary: "选择商品或上传图片，填写需求后提交订单。", content: "<p>选择喜欢的商品，上传参考图片并填写定制要求。客服会在制作前确认设计稿，确认后再安排生产。</p>", imageUrl: "", status: "on", sort: "1" },
    { id: "HELP2", title: "定制说明", summary: "图片越清晰，成品效果越稳定。", content: "<p>建议上传清晰正面照片，并补充想刻的文字、纪念日期、颜色偏好和使用场景。</p>", imageUrl: "", status: "on", sort: "2" },
    { id: "HELP3", title: "发货时效", summary: "普通订单一般48小时左右发货。", content: "<p>不同工艺的制作时间会有差异，急单可先联系客服确认排期。</p>", imageUrl: "", status: "on", sort: "3" },
    { id: "HELP4", title: "售后说明", summary: "定制前会确认方案，售后问题可联系客服处理。", content: "<p>如收到商品存在运输破损或制作异常，请保留照片并联系客服，我们会尽快协助处理。</p>", imageUrl: "", status: "on", sort: "4" }
  ]
  const source = Array.isArray(value) && value.length ? value : defaults
  return source.map((item, index) => ({
    id: item.id || `HELP${Date.now()}${index}`,
    title: item.title || "帮助文章",
    summary: item.summary || "",
    content: item.content || "",
    imageUrl: publicAssetUrl(item.imageUrl),
    status: item.status === "off" ? "off" : "on",
    sort: String(item.sort || index + 1)
  })).sort((a, b) => Number(a.sort || 0) - Number(b.sort || 0))
}

function normalizeContactSettings(settings = {}) {
  return {
    phone: settings.servicePhone || "",
    wechat: settings.serviceWechat || "",
    workWechatUrl: settings.workWechatUrl || "",
    workWechatId: settings.workWechatId || "",
    showWorkWechat: String(settings.showWorkWechat == null ? "true" : settings.showWorkWechat),
    showPhone: String(settings.showPhone == null ? "true" : settings.showPhone),
    showWechat: String(settings.showWechat == null ? "true" : settings.showWechat)
  }
}

function normalizeOrderRecommendationEvent(event = {}, index = 0) {
  return {
    id: event.id || `ORE${Date.now()}${index}`,
    type: event.type === "conversion" ? "conversion" : "click",
    productId: event.productId || "",
    productName: event.productName || "",
    orderId: event.orderId || "",
    amount: String(event.amount || "0"),
    phone: event.phone || "",
    page: event.page || "orders",
    createdAt: event.createdAt || formatDateTime(new Date())
  }
}

async function validateOrderRecommendationEventInput(event = {}) {
  const allowedTypes = new Set(["click", "conversion"])
  const type = String(event.eventType || event.type || "").trim()
  const productId = String(event.productId || "").trim()
  const orderId = String(event.orderId || "").trim()
  const safeIdPattern = /^[A-Za-z0-9_-]{1,64}$/
  if (!allowedTypes.has(type)) {
    throw httpError(400, "事件类型错误，仅支持 click/conversion")
  }
  if (!productId || !safeIdPattern.test(productId)) {
    throw httpError(400, "productId格式错误")
  }
  if (orderId && !safeIdPattern.test(orderId)) {
    throw httpError(400, "orderId格式错误")
  }
  if (type === "conversion" && orderId) {
    const order = (await getOrders({ keyword: orderId })).find(item => item.id === orderId)
    if (!order) throw httpError(400, "转化事件关联订单不存在")
  }
  return {
    ...event,
    type,
    productId,
    orderId
  }
}

async function getOrderRecommendationEvents() {
  return readJsonFile(orderRecommendationEventsFile, []).map(normalizeOrderRecommendationEvent)
}

async function recordOrderRecommendationEvent(event) {
  const list = await getOrderRecommendationEvents()
  const normalized = normalizeOrderRecommendationEvent(event, list.length)
  list.push(normalized)
  writeJsonFile(orderRecommendationEventsFile, list)
  return normalized
}

function pickBanner(banners, index) {
  const banner = Array.isArray(banners) ? banners[index] : null
  if (!banner || !banner.imageUrl) return null
  return banner
}

function assertProductionRuntimeConfig() {
  if (!["mysql", "json"].includes(STORAGE_MODE)) throw new Error("STORAGE_MODE 仅支持 mysql 或 json")
  if (!IS_PRODUCTION) return
  if (STORAGE_MODE !== "mysql") throw new Error("生产环境必须使用 MySQL，禁止 JSON 存储")
  if (!mysql) throw new Error("生产环境缺少必要依赖 mysql2，服务拒绝启动")
  if (!sharp) throw new Error("生产环境缺少必要依赖 sharp，服务拒绝启动")
  if (!QRCode) throw new Error("生产环境缺少必要依赖 qrcode，服务拒绝启动")
  if (PAY_MOCK_ENV === "true") throw new Error("生产环境禁止 PAY_MOCK=true")
  const adminPasswordHash = String(process.env.ADMIN_PASSWORD_HASH || "")
  const legacyAdminPassword = String(process.env.ADMIN_PASSWORD || "")
  if (!process.env.ADMIN_USER || (!adminPasswordHash && !legacyAdminPassword)) {
    throw new Error("生产环境必须配置 ADMIN_USER 和 ADMIN_PASSWORD_HASH，禁止使用默认后台账号")
  }
  if (adminPasswordHash && !/^scrypt\$[a-f0-9]{32}\$[a-f0-9]{128}$/i.test(adminPasswordHash)) {
    throw new Error("生产环境 ADMIN_PASSWORD_HASH 格式无效")
  }
  if (process.env.ADMIN_USER === "admin" || legacyAdminPassword === "ChangeMe123!" || (legacyAdminPassword && legacyAdminPassword.length < 16)) {
    throw new Error("生产环境后台账号密码不安全，请更换至少16位强密码")
  }
  if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
    throw new Error("生产环境必须配置至少32位 SESSION_SECRET")
  }
  const weakSessionSecrets = new Set([
    "replace_with_a_long_random_secret",
    "replace_with_a_32_plus_char_random_secret",
    "your_session_secret",
    "change_me"
  ])
  if (weakSessionSecrets.has(process.env.SESSION_SECRET)) {
    throw new Error("生产环境 SESSION_SECRET 仍为示例值，请更换至少32位随机字符串")
  }
  if (!process.env.PUBLIC_BASE_URL || !process.env.PUBLIC_BASE_URL.startsWith("https://")) {
    throw new Error("生产环境必须配置 HTTPS 的 PUBLIC_BASE_URL")
  }
  if (/127\.0\.0\.1|localhost|192\.168\./.test(process.env.PUBLIC_BASE_URL)) {
    throw new Error("生产环境 PUBLIC_BASE_URL 不能使用本地地址")
  }
}

function warnRuntimeMode() {
  if (!IS_PRODUCTION) {
    console.warn(`[安全警告] 当前 NODE_ENV=${process.env.NODE_ENV || "(未设置)"}，不是 production。正式部署必须设置 NODE_ENV=production 且 PAY_MOCK=false。`)
  }
}

function assertProductionPaymentConfig() {
  assertProductionRuntimeConfig()
  if (PAY_MOCK) return
  const required = [
    "WECHAT_APPID",
    "WECHAT_SECRET",
    "WECHAT_MCH_ID",
    "WECHAT_MCH_SERIAL_NO",
    "WECHAT_PRIVATE_KEY_PATH",
    "WECHAT_API_V3_KEY",
    "WECHAT_PAY_NOTIFY_URL"
  ]
  const missing = required.filter(key => !process.env[key])
  if (missing.length) {
    throw new Error(`正式微信支付缺少配置：${missing.join(", ")}`)
  }
  if (!process.env.WECHAT_PAY_NOTIFY_URL.startsWith("https://")) {
    throw new Error("正式微信支付回调地址必须使用 HTTPS")
  }
  if (!fs.existsSync(process.env.WECHAT_PRIVATE_KEY_PATH)) {
    throw new Error("微信支付商户私钥文件不存在")
  }
  const hasPlatformCert = process.env.WECHAT_PAY_PLATFORM_CERT_PATH && fs.existsSync(process.env.WECHAT_PAY_PLATFORM_CERT_PATH)
  const hasPublicKey = process.env.WECHAT_PAY_PUBLIC_KEY_ID && process.env.WECHAT_PAY_PUBLIC_KEY_PATH && fs.existsSync(process.env.WECHAT_PAY_PUBLIC_KEY_PATH)
  if (!hasPlatformCert && !hasPublicKey) {
    throw new Error("正式微信支付缺少微信支付平台证书或微信支付公钥")
  }
  if (process.env.WECHAT_API_V3_KEY.length !== 32) {
    throw new Error("WECHAT_API_V3_KEY 必须是 32 位")
  }
}

function normalizeProduct(product, index) {
  const imageUrl = publicAssetUrl(product.mainImage || product.imageUrl || product.image || product.coverImage)
  const imageVariants = uploadImageVariants(imageUrl)
  const categories = normalizeProductCategories(product.categories, product)
  const levels = productCategoryLevels(categories, product)
  const productType = String(product.productType || product.product_type || "").toLowerCase() === "normal" ||
    categories.some(category => ["日用好货", "潮玩手办", "食品饮料", "日用百货"].some(keyword => String(category).includes(keyword))) ? "normal" : "custom"
  const isHot = normalizeBooleanText(product.isHot ?? product.is_hot ?? product.hot ?? product.hotRecommend, false)
  const promotionHot = normalizeBooleanText(product.promotionHot ?? product.isPromotionHot ?? product.promotion_hot, false)
  const sortOrder = product.sortOrder ?? product.sort ?? product.sort_order ?? index ?? 0
  return {
    id: product.id || `P${Date.now()}${index}`,
    name: product.name || "未命名商品",
    intro: product.intro || "",
    price: String(product.price || "0"),
    costPrice: String(product.costPrice || "0"),
    badge: normalizeBadge(product.badge),
    cover: product.cover || "keyring",
    imageUrl,
    mainImage: imageUrl,
    optimizedUrl: product.optimizedUrl ? publicAssetUrl(product.optimizedUrl) : imageVariants.optimizedUrl,
    thumbUrl: product.thumbUrl ? publicAssetUrl(product.thumbUrl) : imageVariants.thumbUrl,
    listImage: product.listImage ? publicAssetUrl(product.listImage) : imageVariants.listImage,
    cartThumbUrl: product.cartThumbUrl ? publicAssetUrl(product.cartThumbUrl) : imageVariants.cartThumbUrl,
    detailUrl: product.detailUrl ? publicAssetUrl(product.detailUrl) : imageVariants.detailUrl,
    webpUrl: product.webpUrl ? publicAssetUrl(product.webpUrl) : imageVariants.webpUrl,
    galleryImages: normalizeAssetUrls(normalizeMediaList(product.galleryImages)).map(url => uploadVariantUrl(url, ".optimized")),
    videoUrl: publicAssetUrl(product.videoUrl),
    detailImages: normalizeAssetUrls(normalizeMediaList(product.detailImages)).map(url => uploadVariantUrl(url, ".detail")),
    detailText: product.detailText || "",
    productType,
    needCustom: productType === "normal" ? "false" : "true",
    categories,
    categoryLevel1: levels.categoryLevel1,
    categoryLevel2: levels.categoryLevel2,
    status: normalizeProductStatus(product.status),
    stock: String(product.stock || "0"),
    stockMode: normalizeInventoryMode(product),
    inventoryVersion: Number(product.inventoryVersion ?? product.inventory_version ?? 0),
    isHot,
    isPromotionHot: promotionHot,
    promotionHot,
    aiPreviewEnabled: normalizeBooleanText(product.aiPreviewEnabled, false),
    aiPreviewType: product.aiPreviewType || inferAiPreviewType(product),
    rewardEnabled: String(product.rewardEnabled == null ? "true" : product.rewardEnabled) === "false" ? "false" : "true",
    firstReward: String(product.firstReward || "0"),
    secondReward: String(product.secondReward || "0"),
    modelCandidateId: product.modelCandidateId || product.model_candidate_id || "",
    modelSourceUrl: product.modelSourceUrl || product.model_source_url || "",
    modelAuthorName: product.modelAuthorName || product.model_author_name || "",
    modelAuthorizationStatus: product.modelAuthorizationStatus || product.model_authorization_status || "",
    modelAuthorizationNote: product.modelAuthorizationNote || product.model_authorization_note || "",
    sort: String(sortOrder),
    sortOrder: String(sortOrder)
  }
}

function compactProductImageFields(product = {}) {
  return {
    cartThumbUrl: publicAssetUrl(product.cartThumbUrl || product.cart_thumb_url || ""),
    cart_thumb_url: publicAssetUrl(product.cartThumbUrl || product.cart_thumb_url || ""),
    thumbUrl: publicAssetUrl(product.thumbUrl || product.thumb_url || ""),
    thumb_url: publicAssetUrl(product.thumbUrl || product.thumb_url || ""),
    listImage: publicAssetUrl(product.listImage || product.list_image || ""),
    list_image: publicAssetUrl(product.listImage || product.list_image || ""),
    optimizedUrl: publicAssetUrl(product.optimizedUrl || product.optimized_url || ""),
    optimized_url: publicAssetUrl(product.optimizedUrl || product.optimized_url || ""),
    imageUrl: publicAssetUrl(product.imageUrl || product.image_url || ""),
    image_url: publicAssetUrl(product.imageUrl || product.image_url || "")
  }
}

function pickProductListImage(fields = {}) {
  return fields.cartThumbUrl ||
    fields.cart_thumb_url ||
    fields.thumbUrl ||
    fields.thumb_url ||
    fields.listImage ||
    fields.list_image ||
    fields.optimizedUrl ||
    fields.optimized_url ||
    fields.imageUrl ||
    fields.image_url ||
    ""
}

function findProductForOrder(order = {}, products = []) {
  const productId = String(order.productId || order.product_id || "").trim()
  const productName = String(order.productName || order.product_name || "").trim()
  const remark = String(order.remark || order.customRequest || order.custom_request || "")
  const cartItemId = (remark.match(/购物车商品ID[:：]\s*([\w-]+)/) || [])[1] || ""
  return products.find(product => productId && product.id === productId) ||
    products.find(product => cartItemId && product.id === cartItemId) ||
    products.find(product => productName && product.name === productName) ||
    products.find(product => productId === "CART_ORDER" && productName && productName.startsWith(product.name)) ||
    products.find(product => productId === "CART_ORDER" && remark.includes(`${product.name}x`)) ||
    {}
}

function orderProductImageFields(order = {}, product = {}) {
  const orderFields = compactProductImageFields(order)
  const productFields = compactProductImageFields(product)
  const merged = {
    cartThumbUrl: orderFields.cartThumbUrl || productFields.cartThumbUrl,
    cart_thumb_url: orderFields.cart_thumb_url || productFields.cart_thumb_url,
    thumbUrl: orderFields.thumbUrl || productFields.thumbUrl,
    thumb_url: orderFields.thumb_url || productFields.thumb_url,
    listImage: orderFields.listImage || productFields.listImage,
    list_image: orderFields.list_image || productFields.list_image,
    optimizedUrl: orderFields.optimizedUrl || productFields.optimizedUrl,
    optimized_url: orderFields.optimized_url || productFields.optimized_url,
    imageUrl: orderFields.imageUrl || productFields.imageUrl,
    image_url: orderFields.image_url || productFields.image_url
  }
  return {
    ...merged,
    productImage: pickProductListImage(merged)
  }
}

function hydrateOrderProductImages(order = {}, products = []) {
  const product = findProductForOrder(order, products)
  return {
    ...order,
    detailProductId: order.detailProductId || order.detail_product_id || (order.productId && order.productId !== "CART_ORDER" ? order.productId : "") || product.id || "",
    firstProductId: order.firstProductId || order.first_product_id || product.id || "",
    ...orderProductImageFields(order, product)
  }
}

const ACTIVE_AFTER_SALES_STATUSES = new Set(["requested", "refund_pending", "remake", "reship"])

function normalizeAfterSalesStatus(value, fallback = "none") {
  const raw = String(value || "").trim()
  const map = {
    none: "none",
    requested: "requested",
    approved: "requested",
    rejected: "rejected",
    refund_pending: "refund_pending",
    refund_failed: "refund_failed",
    partially_refunded: "partially_refunded",
    refunded: "refunded",
    remake: "remake",
    reship: "reship",
    "无售后": "none",
    "待审核": "requested",
    "售后处理中": "requested",
    "退款处理中": "refund_pending",
    "退款失败": "refund_failed",
    "部分退款": "partially_refunded",
    "已拒绝": "rejected",
    "售后已拒绝": "rejected",
    "已退款": "refunded",
    "退款成功": "refunded",
    "重新制作中": "remake",
    "补发处理中": "reship"
  }
  return map[raw] || fallback
}

function afterSalesStatusText(value) {
  return ({
    requested: "售后处理中",
    rejected: "售后已拒绝",
    refund_pending: "退款处理中",
    refund_failed: "退款失败",
    partially_refunded: "部分退款",
    refunded: "已退款",
    remake: "重新制作中",
    reship: "补发处理中",
    none: "无售后"
  })[normalizeAfterSalesStatus(value)] || "无售后"
}

function isActiveAfterSalesStatus(value) {
  return ACTIVE_AFTER_SALES_STATUSES.has(normalizeAfterSalesStatus(value))
}

function normalizeOrder(order, index) {
  const createdAt = order.createdAt || formatDateTime(new Date())
  const paidAt = order.paidAt || null
  const arrivedStoreAt = order.arrivedStoreAt || null
  const pickedUpAt = order.pickedUpAt || null
  const afterSalesStatus = normalizeAfterSalesStatus(order.afterSalesStatus || order.refundStatus)
  const isStoreMemberOrder = boolValue(order.isStoreMemberOrder ?? order.is_store_member_order)
  const storeOrderType = order.storeOrderType || order.store_order_type || (isStoreMemberOrder ? "store_self" : (order.referrerStoreId || order.referrer_store_id ? "store_external" : ""))
  const storeOperatorPhone = normalizePhone(order.storeOperatorPhone || order.store_operator_phone || "")
  const rawStoreOperatorRole = order.storeOperatorRole || order.store_operator_role || ""
  const storeOperatorRole = rawStoreOperatorRole ? normalizeStoreMemberRole(rawStoreOperatorRole) : ""
  const sourceStoreId = order.sourceStoreId || order.source_store_id || order.referrerStoreId || order.referrer_store_id || ""
  return {
    id: order.id || `DD${Date.now()}${index}`,
    productId: order.productId || "",
    customerName: order.customerName || "",
    phone: order.phone || "",
    productName: order.productName || "",
    amount: String(order.amount || "0"),
    status: order.status || "待发货",
    paymentStatus: order.paymentStatus || "待支付",
    paymentExpiresAt: order.paymentExpiresAt || order.payment_expires_at || null,
    stockReservedAt: order.stockReservedAt || order.stock_reserved_at || null,
    stockReleasedAt: order.stockReleasedAt || order.stock_released_at || null,
    transactionId: order.transactionId || "",
    openid: order.openid || "",
    userId: order.userId || "",
    userToken: order.userToken || "",
    address: order.address || "",
    customRequest: order.customRequest || "",
    originalImageUrl: order.originalImageUrl || "",
    originalImageUrls: normalizeMediaList(order.originalImageUrls || order.originalImageUrl || ""),
    aiPreviewUrl: order.aiPreviewUrl || "",
    finalDesignUrl: order.finalDesignUrl || "",
    category: order.category || "",
    isCustomOrder: String(order.isCustomOrder == null ? "false" : order.isCustomOrder) === "true" ? "true" : "false",
    remark: order.remark || "",
    inviterCode: order.inviterCode || "",
    shippingCompany: order.shippingCompany || "",
    trackingNumber: order.trackingNumber || "",
    shippedAt: order.shippedAt || null,
    refundType: order.refundType || "",
    refundStatus: order.refundStatus || "",
    refundReason: order.refundReason || "",
    refundAmount: order.refundAmount === "" || order.refundAmount == null ? null : String(order.refundAmount),
    refundRemark: order.refundRemark || "",
    refundImageUrl: order.refundImageUrl || "",
    refundRejectReason: order.refundRejectReason || order.afterSalesRejectReason || "",
    afterSalesRejectReason: order.afterSalesRejectReason || order.refundRejectReason || "",
    after_sales_reject_reason: order.afterSalesRejectReason || order.refundRejectReason || "",
    refundReviewedAt: order.refundReviewedAt || null,
    afterSalesStatus,
    after_sales_status: afterSalesStatus,
    afterSalesText: afterSalesStatusText(afterSalesStatus),
    afterSalesType: order.afterSalesType || order.refundType || "",
    after_sales_type: order.afterSalesType || order.refundType || "",
    afterSalesReason: order.afterSalesReason || order.refundReason || "",
    after_sales_reason: order.afterSalesReason || order.refundReason || "",
    afterSalesDesc: order.afterSalesDesc || order.refundRemark || "",
    after_sales_desc: order.afterSalesDesc || order.refundRemark || "",
    afterSalesImages: normalizeMediaList(order.afterSalesImages || order.refundImageUrl || ""),
    after_sales_images: normalizeMediaList(order.afterSalesImages || order.refundImageUrl || ""),
    afterSalesRequestedAt: order.afterSalesRequestedAt || null,
    after_sales_requested_at: order.afterSalesRequestedAt || null,
    afterSalesHandledAt: order.afterSalesHandledAt || null,
    after_sales_handled_at: order.afterSalesHandledAt || null,
    afterSalesApplyCount: Number(order.afterSalesApplyCount || order.after_sales_apply_count || 0),
    after_sales_apply_count: Number(order.afterSalesApplyCount || order.after_sales_apply_count || 0),
    canApplyAfterSales: canApplyAfterSales(order),
    canReapplyAfterSales: canReapplyAfterSales(order),
    refund_status: order.refundStatus || "",
    refundNo: order.refundNo || "",
    refundId: order.refundId || "",
    refundSuccessAt: order.refundSuccessAt || null,
    createdAt,
    createdAtText: order.createdAtText || formatChinaDatetime(createdAt),
    paidAt,
    paidAtText: order.paidAtText || formatChinaDatetime(paidAt),
    completedAt: order.completedAt || null,
    refundAt: order.refundAt || null,
    deliveryType: order.deliveryType || "delivery",
    pickupStoreId: order.pickupStoreId || "",
    pickupStore: order.pickupStore || null,
    pickupCode: normalizePickupCode(order.pickupCode || order.pickup_code || ""),
    pickupQrCodeUrl: publicAssetUrl(order.pickupQrCodeUrl || order.pickup_qrcode_url || ""),
    pickupStatus: order.pickupStatus || "none",
    notifyStatus: order.notifyStatus || order.notify_status || "",
    notifiedAt: order.notifiedAt || order.notified_at || null,
    notifiedAtText: order.notifiedAtText || formatChinaDatetime(order.notifiedAt || order.notified_at),
    isPaid: isOrderPaidForPickupCredential(order),
    isPickup: isPickupOrder(order),
    canShowPickupCode: canShowPickupCodeForOrder(order),
    canStoreVerify: canStoreVerifyOrder(order),
    arrivedStoreAt,
    arrivedStoreAtText: order.arrivedStoreAtText || formatChinaDatetime(arrivedStoreAt),
    pickedUpAt,
    pickedUpAtText: order.pickedUpAtText || formatChinaDatetime(pickedUpAt),
    pickupVerifiedAt: order.pickupVerifiedAt || order.pickup_verified_at || null,
    pickupVerifiedAtText: order.pickupVerifiedAtText || formatChinaDatetime(order.pickupVerifiedAt || order.pickup_verified_at),
    pickupVerifiedBy: order.pickupVerifiedBy || order.pickup_verified_by || "",
    forcePickupVerifiedAt: order.forcePickupVerifiedAt || order.force_pickup_verified_at || null,
    forcePickupVerifiedBy: order.forcePickupVerifiedBy || order.force_pickup_verified_by || "",
    forcePickupReason: order.forcePickupReason || order.force_pickup_reason || "",
    persistedFulfillmentStatus: order.persistedFulfillmentStatus || order.fulfillment_status || "",
    wechatFulfillmentStatus: order.wechatFulfillmentStatus || order.wechat_fulfillment_status || "",
    wechatFulfillmentSyncedAt: order.wechatFulfillmentSyncedAt || order.wechat_fulfillment_synced_at || null,
    userLatitude: order.userLatitude == null || order.userLatitude === "" ? "" : String(order.userLatitude),
    userLongitude: order.userLongitude == null || order.userLongitude === "" ? "" : String(order.userLongitude),
    pickupDistance: order.pickupDistance == null || order.pickupDistance === "" ? "" : String(order.pickupDistance),
    referrerStoreId: order.referrerStoreId || order.referrer_store_id || "",
    storeAttributionId: order.storeAttributionId || order.store_attribution_id || "",
    sourceType: order.sourceType || order.source_type || (sourceStoreId ? "store" : ""),
    sourceStoreId,
    sourceStoreCode: order.sourceStoreCode || order.source_store_code || "",
    storeOrderType,
    storeOrderTypeText: storeOrderSourceText(storeOrderType, isStoreMemberOrder),
    isStoreMemberOrder,
    storeOperatorUserId: order.storeOperatorUserId || order.store_operator_user_id || "",
    storeOperatorPhone,
    storeOperatorPhoneTail: isStoreMemberOrder ? (storeOperatorPhone ? storeOperatorPhone.slice(-4) : "未知") : "",
    storeOperatorOpenid: order.storeOperatorOpenid || order.store_operator_openid || "",
    storeOperatorRole,
    storeOperatorRoleText: isStoreMemberOrder && storeOperatorRole ? storeRoleText(storeOperatorRole) : "",
    storeOperatorName: order.storeOperatorName || order.store_operator_name || "",
    referrerUserId: order.referrerUserId || "",
    parentReferrerUserId: order.parentReferrerUserId || "",
    supplierStoreId: order.supplierStoreId || "",
    referralCommission: order.referralCommission == null || order.referralCommission === "" ? "0.00" : String(order.referralCommission),
    pickupServiceFee: order.pickupServiceFee == null || order.pickupServiceFee === "" ? "0.00" : String(order.pickupServiceFee),
    supplierSettlementAmount: order.supplierSettlementAmount == null || order.supplierSettlementAmount === "" ? "0.00" : String(order.supplierSettlementAmount),
    customCommissionAmount: order.customCommissionAmount == null || order.customCommissionAmount === "" ? "0.00" : String(order.customCommissionAmount),
    storeSettlementStatus: order.storeSettlementStatus || "pending_confirm",
    items: Array.isArray(order.items) ? order.items : [],
    refundRecords: Array.isArray(order.refundRecords) ? order.refundRecords : [],
    ...lifecycleView(order),
    ...orderProductImageFields(order, {})
  }
}

function isOrderPaidForPickupCredential(order = {}) {
  const status = String(order.paymentStatus || order.payment_status || order.payStatus || order.pay_status || "").trim().toLowerCase()
  const rawStatus = String(order.status || "").trim().toLowerCase()
  if (["待支付", "未支付", "unpaid", "pending_payment"].includes(status) || ["待支付", "未支付", "unpaid", "pending_payment"].includes(rawStatus)) return false
  return order.isPaid === true ||
    ["已支付", "paid", "success", "支付成功"].includes(status) ||
    ["已支付", "paid", "success", "支付成功"].includes(rawStatus) ||
    !!order.paidAt ||
    !!order.paid_at ||
    !!order.transactionId ||
    !!order.transaction_id
}

function isPickupOrder(order = {}) {
  return order.deliveryType === "pickup" ||
    order.delivery_type === "pickup" ||
    !!order.pickupStoreId ||
    !!order.pickup_store_id
}

function isOrderBlockedForStoreVerify(order = {}) {
  const status = String(order.status || "").trim()
  const paymentStatus = String(order.paymentStatus || order.payment_status || "").trim()
  const afterSalesStatus = normalizeAfterSalesStatus(order.afterSalesStatus || order.after_sales_status || order.refundStatus || order.refund_status)
  return ["已取消", "已退款", "退款中"].includes(status) ||
    ["已退款"].includes(paymentStatus) ||
    ["requested", "refund_pending", "refunded"].includes(afterSalesStatus)
}

function canShowPickupCodeForOrder(order = {}) {
  return isOrderPaidForPickupCredential(order) &&
    isPickupOrder(order) &&
    !!normalizePickupCode(order.pickupCode || order.pickup_code)
}

function canStoreVerifyOrder(order = {}) {
  return canShowPickupCodeForOrder(order) &&
    !isOrderBlockedForStoreVerify(order) &&
    (order.pickupStatus || order.pickup_status) !== "picked_up"
}

function publicOrderView(order = {}) {
  const decorated = { ...order, ...lifecycleView(order) }
  if (canShowPickupCodeForOrder(order)) return decorated
  return {
    ...decorated,
    pickupCode: "",
    pickup_code: "",
    pickupQrCodeUrl: "",
    pickup_qrcode_url: ""
  }
}

function mysqlOrderParams(order) {
  return {
    ...order,
    isStoreMemberOrder: order.isStoreMemberOrder ? "true" : "false",
    shippedAt: toMysqlDatetime(order.shippedAt),
    refundReviewedAt: toMysqlDatetime(order.refundReviewedAt),
    afterSalesRequestedAt: toMysqlDatetime(order.afterSalesRequestedAt),
    afterSalesHandledAt: toMysqlDatetime(order.afterSalesHandledAt),
    refundSuccessAt: toMysqlDatetime(order.refundSuccessAt),
    createdAt: toMysqlDatetime(order.createdAt, nowMysqlDatetime()),
    paymentExpiresAt: toMysqlDatetime(order.paymentExpiresAt),
    stockReservedAt: toMysqlDatetime(order.stockReservedAt),
    stockReleasedAt: toMysqlDatetime(order.stockReleasedAt),
    paidAt: toMysqlDatetime(order.paidAt),
    completedAt: toMysqlDatetime(order.completedAt),
    refundAt: toMysqlDatetime(order.refundAt),
    arrivedStoreAt: toMysqlDatetime(order.arrivedStoreAt),
    pickedUpAt: toMysqlDatetime(order.pickedUpAt),
    pickupVerifiedAt: toMysqlDatetime(order.pickupVerifiedAt),
    forcePickupVerifiedAt: toMysqlDatetime(order.forcePickupVerifiedAt),
    notifiedAt: toMysqlDatetime(order.notifiedAt)
  }
}

function requestIdentity(query = {}) {
  return {
    userId: String(query.userId || "").trim(),
    userToken: String(query.userToken || query.token || "").trim(),
    openid: String(query.openid || "").trim(),
    userSession: String(query.userSession || "").trim(),
    phone: String(query.phone || query.phoneNumber || "").trim()
  }
}

function hasRequestIdentity(identity = {}) {
  return !!(identity.userId || identity.userToken || identity.openid || identity.phone)
}

function orderBelongsToIdentity(order = {}, identity = {}) {
  const current = requestIdentity(identity)
  if (!hasRequestIdentity(current)) return false
  if (current.userId && order.userId === current.userId) return true
  if (order.userId) return false
  if (current.openid && order.openid === current.openid) return true
  if (current.phone && order.phone === current.phone) return true
  return false
}

function money(value) {
  const num = Number(value || 0)
  return Number.isFinite(num) ? num.toFixed(2) : "0.00"
}

function normalizeCommissionType(value) {
  return ["none", "percent", "fixed"].includes(value) ? value : "none"
}

function normalizeStoreLevel(value) {
  return ["display", "pickup", "supplier", "partner"].includes(value) ? value : "display"
}

function normalizePhone(value) {
  return String(value || "").replace(/\D/g, "")
}

function normalizeStatusText(value) {
  return String(value == null ? "" : value).trim().toLowerCase()
}

function isEnabledLike(value, defaultValue = false) {
  const text = normalizeStatusText(value)
  if (!text) return defaultValue
  return ["enabled", "active", "on", "1", "true", "启用", "已启用", "正常"].includes(text)
}

function isDisabledLike(value) {
  return ["disabled", "inactive", "off", "0", "false", "停用", "禁用", "已停用"].includes(normalizeStatusText(value))
}

function isStoreEnabled(store = {}) {
  const statusOk = !isDisabledLike(store.status) && isEnabledLike(store.status, true)
  const storeStatusOk = !isDisabledLike(store.storeStatus || store.store_status) && isEnabledLike(store.storeStatus || store.store_status, true)
  const enabledOk = store.enabled == null ? true : isEnabledLike(store.enabled, true)
  return statusOk && storeStatusOk && enabledOk
}

function defaultStoreRules(level) {
  if (level === "pickup") return { referralType: "percent", referralValue: "3", pickupType: "fixed", pickupValue: "2" }
  if (level === "supplier") return { referralType: "percent", referralValue: "1", pickupType: "fixed", pickupValue: "1" }
  return { referralType: "percent", referralValue: "3", pickupType: "none", pickupValue: "0" }
}

function normalizePartnerStore(store = {}, index = 0) {
  const level = normalizeStoreLevel(store.level)
  const defaults = defaultStoreRules(level)
  return {
    id: String(store.id || `STORE${Date.now()}${index}`),
    name: store.name || "未命名门店",
    level,
    address: store.address || "",
    phone: store.phone || "",
    contactName: store.contactName || store.contact_name || "",
    managerPhone: normalizePhone(store.managerPhone || store.manager_phone || ""),
    managerOpenid: store.managerOpenid || store.manager_openid || "",
    storeRole: store.storeRole || store.store_role || "manager",
    storeStatus: store.storeStatus || store.store_status || "active",
    businessHours: store.businessHours || store.business_hours || "",
    latitude: store.latitude == null || store.latitude === "" ? "" : String(store.latitude),
    longitude: store.longitude == null || store.longitude === "" ? "" : String(store.longitude),
    status: store.status === "disabled" ? "disabled" : "enabled",
    isDisplayEnabled: String(store.isDisplayEnabled ?? store.is_display_enabled ?? (level === "display" || level === "pickup" || level === "partner" ? "true" : "false")) === "true" ? "true" : "false",
    isPickupEnabled: String(store.isPickupEnabled ?? store.is_pickup_enabled ?? (level === "pickup" ? "true" : "false")) === "true" ? "true" : "false",
    isSupplierEnabled: String(store.isSupplierEnabled ?? store.is_supplier_enabled ?? (level === "supplier" ? "true" : "false")) === "true" ? "true" : "false",
    settlementCycle: store.settlementCycle || store.settlement_cycle || "monthly",
    qrcodeScene: store.qrcodeScene || store.qrcode_scene || "",
    sortOrder: String(store.sortOrder ?? store.sort_order ?? index + 1),
    remark: store.remark || "",
    referralCommissionType: normalizeCommissionType(store.referralCommissionType || store.referral_commission_type || defaults.referralType),
    referralCommissionValue: money(store.referralCommissionValue ?? store.referral_commission_value ?? defaults.referralValue),
    pickupFeeType: normalizeCommissionType(store.pickupFeeType || store.pickup_fee_type || defaults.pickupType),
    pickupFeeValue: money(store.pickupFeeValue ?? store.pickup_fee_value ?? defaults.pickupValue),
    supplierSettlementRule: store.supplierSettlementRule || store.supplier_settlement_rule || "",
    customCommissionRule: store.customCommissionRule || store.custom_commission_rule || "",
    salesAgentId: store.salesAgentId || store.sales_agent_id || "",
    salesAgentCommissionRate: store.salesAgentCommissionRate == null || store.sales_agent_commission_rate == null
      ? ""
      : money(store.salesAgentCommissionRate ?? store.sales_agent_commission_rate),
    createdAt: store.createdAt || store.created_at || formatDateTime(new Date()),
    updatedAt: store.updatedAt || store.updated_at || formatDateTime(new Date())
  }
}

function normalizeSettlementRecord(record = {}, index = 0) {
  const createdAt = record.createdAt || record.created_at || formatDateTime(new Date())
  const settledAt = record.settledAt || record.settled_at || ""
  const status = normalizeSettlementStatus(record.status)
  const isStoreMemberOrder = boolValue(record.isStoreMemberOrder ?? record.is_store_member_order)
  const storeOrderType = record.storeOrderType || record.store_order_type || (isStoreMemberOrder ? "store_self" : (isStoreReferralSettlement(record.type || "") ? "store_external" : isPickupServiceSettlement(record.type || "") ? "pickup_service" : "store_external"))
  const storeOperatorPhone = normalizePhone(record.storeOperatorPhone || record.store_operator_phone || "")
  const rawStoreOperatorRole = record.storeOperatorRole || record.store_operator_role || ""
  const storeOperatorRole = rawStoreOperatorRole ? normalizeStoreMemberRole(rawStoreOperatorRole) : ""
  const storeOrderTypeText = storeOrderSourceText(storeOrderType, isStoreMemberOrder) || "外部顾客"
  return {
    id: String(record.id || `SSR${Date.now()}${index}`),
    storeId: record.storeId || record.store_id || "",
    orderId: record.orderId || record.order_id || "",
    type: record.type || "referral",
    amount: money(record.amount),
    commissionType: normalizeCommissionType(record.commissionType || record.commission_type || "none"),
    commissionValue: money(record.commissionValue ?? record.commission_value ?? 0),
    orderPaidAmount: money(record.orderPaidAmount ?? record.order_paid_amount ?? 0),
    status,
    statusText: settlementStatusText(status),
    description: record.description || "",
    settledBy: record.settledBy || record.settled_by || "",
    settleNote: record.settleNote || record.settle_note || "",
    cancelReason: record.cancelReason || record.cancel_reason || "",
    batchId: record.batchId || record.batch_id || "",
    relatedRecordId: record.relatedRecordId || record.related_record_id || "",
    storeOrderType,
    storeOrderTypeText,
    isStoreMemberOrder,
    storeOperatorUserId: record.storeOperatorUserId || record.store_operator_user_id || "",
    storeOperatorPhone,
    storeOperatorPhoneTail: isStoreMemberOrder ? (storeOperatorPhone ? storeOperatorPhone.slice(-4) : "未知") : "",
    storeOperatorOpenid: record.storeOperatorOpenid || record.store_operator_openid || "",
    storeOperatorRole,
    storeOperatorRoleText: isStoreMemberOrder && storeOperatorRole ? storeRoleText(storeOperatorRole) : "",
    storeOperatorName: record.storeOperatorName || record.store_operator_name || "",
    createdAt,
    createdAtText: record.createdAtText || formatChinaDatetime(createdAt),
    settledAt,
    settledAtText: record.settledAtText || formatChinaDatetime(settledAt),
    updatedAt: record.updatedAt || record.updated_at || ""
  }
}

function normalizeSalesAgent(agent = {}, index = 0) {
  const now = formatDateTime(new Date())
  return {
    id: String(agent.id || `SA${Date.now()}${index}`),
    name: agent.name || "",
    phone: normalizePhone(agent.phone || ""),
    passwordHash: agent.passwordHash || agent.password_hash || "",
    commissionRate: money(agent.commissionRate ?? agent.commission_rate ?? 0),
    status: agent.status === "disabled" ? "disabled" : "active",
    remark: agent.remark || "",
    createdAt: agent.createdAt || agent.created_at || now,
    updatedAt: agent.updatedAt || agent.updated_at || now
  }
}

function salesAgentPublicView(agent = {}) {
  const { passwordHash, ...safe } = normalizeSalesAgent(agent)
  return safe
}

function normalizeStoreLead(lead = {}, index = 0) {
  const status = ["pending", "followed", "approved", "rejected"].includes(lead.status) ? lead.status : "pending"
  return {
    id: String(lead.id || `SL${Date.now()}${index}`),
    salesAgentId: lead.salesAgentId || lead.sales_agent_id || "",
    storeName: lead.storeName || lead.store_name || "",
    contactName: lead.contactName || lead.contact_name || "",
    contactPhone: normalizePhone(lead.contactPhone || lead.contact_phone || ""),
    address: lead.address || "",
    latitude: lead.latitude == null || lead.latitude === "" ? "" : String(lead.latitude),
    longitude: lead.longitude == null || lead.longitude === "" ? "" : String(lead.longitude),
    storeType: lead.storeType || lead.store_type || "",
    cooperationType: lead.cooperationType || lead.cooperation_type || "",
    pickupEnabled: String(lead.pickupEnabled ?? lead.pickup_enabled ?? "false") === "true" ? "true" : "false",
    photos: normalizeMediaList(lead.photos || []).slice(0, 3).map(publicAssetUrl),
    remark: lead.remark || "",
    status,
    rejectReason: lead.rejectReason || lead.reject_reason || "",
    storeId: lead.storeId || lead.store_id || "",
    createdAt: lead.createdAt || lead.created_at || formatDateTime(new Date()),
    handledAt: lead.handledAt || lead.handled_at || "",
    handledBy: lead.handledBy || lead.handled_by || ""
  }
}

function leadStatusText(status) {
  return { pending: "待审核", followed: "跟进中", approved: "已通过", rejected: "已拒绝" }[status] || "待审核"
}

function normalizeSalesAgentCommission(record = {}, index = 0) {
  const type = ["sales_agent_commission", "chargeback", "refund_adjustment", "adjustment"].includes(record.type) ? record.type : "sales_agent_commission"
  const status = normalizeSettlementStatus(record.status)
  const amount = record.amount == null || record.amount === "" ? record.commissionAmount : record.amount
  return {
    id: String(record.id || `SAC${Date.now()}${index}`),
    businessKey: record.businessKey || record.business_key || "",
    salesAgentId: record.salesAgentId || record.sales_agent_id || "",
    storeId: record.storeId || record.store_id || "",
    orderId: record.orderId || record.order_id || "",
    orderNo: record.orderNo || record.order_no || record.orderId || record.order_id || "",
    orderAmount: money(record.orderAmount ?? record.order_amount ?? 0),
    commissionRate: money(record.commissionRate ?? record.commission_rate ?? 0),
    commissionAmount: money(record.commissionAmount ?? record.commission_amount ?? amount ?? 0),
    amount: money(amount ?? 0),
    type,
    status,
    createdAt: record.createdAt || record.created_at || formatDateTime(new Date()),
    settledAt: record.settledAt || record.settled_at || "",
    settledBy: record.settledBy || record.settled_by || "",
    settleNote: record.settleNote || record.settle_note || "",
    cancelReason: record.cancelReason || record.cancel_reason || "",
    batchId: record.batchId || record.batch_id || "",
    relatedRecordId: record.relatedRecordId || record.related_record_id || "",
    remark: record.remark || ""
  }
}

function salesCommissionTypeText(type) {
  return {
    sales_agent_commission: "业务员佣金",
    chargeback: "退款冲正",
    refund_adjustment: "退款冲减",
    adjustment: "手动调整"
  }[type] || type
}

function calculateStoreAmount(amount, type, value) {
  const paid = Number(amount || 0)
  const num = Math.max(0, Number(value || 0))
  if (!paid || type === "none") return "0.00"
  if (type === "percent") return money(paid * num / 100)
  if (type === "fixed") return money(Math.min(num, paid * 0.5))
  return "0.00"
}

function calculatePickupServiceFee(amount, type, value) {
  const paidCents = Math.max(0, Math.round(Number(amount || 0) * 100))
  const configuredValue = Math.max(0, Number(value || 0))
  if (!paidCents || type === "none") return "0.00"
  if (type === "percent") return money(Math.round(paidCents * configuredValue / 100) / 100)
  if (type === "fixed") {
    const configuredCents = Math.round(configuredValue * 100)
    return money(Math.min(configuredCents, paidCents) / 100)
  }
  return "0.00"
}

function normalizePickupCode(value) {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6)
}

async function generateUniquePickupCode() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const code = generatePickupCodeCandidate()
    if (!pool) {
      const exists = readJsonFile(ordersFile, []).some(order => normalizePickupCode(order.pickupCode || order.pickup_code) === code)
      if (!exists) return code
    } else {
      const rows = await query("SELECT id FROM orders WHERE pickup_code = :code LIMIT 1", { code })
      if (!rows.length) return code
    }
  }
  throw new Error("暂时无法生成唯一取货码，请稍后重试")
}

async function ensurePickupCodeClaim(order) {
  if (!pool || !isPickupOrder(order) || !normalizePickupCode(order.pickupCode)) return
  const connection = await pool.getConnection()
  const previousCode = normalizePickupCode(order.pickupCode)
  try {
    await connection.beginTransaction()
    const [existing] = await connection.query(
      "SELECT code FROM pickup_code_claims WHERE order_id=:orderId LIMIT 1 FOR UPDATE",
      { orderId: order.id }
    )
    if (existing[0]) {
      order.pickupCode = normalizePickupCode(existing[0].code)
    } else {
      await claimPickupCode(connection, order)
    }
    await connection.commit()
  } catch (error) {
    await connection.rollback().catch(() => {})
    throw error
  } finally {
    connection.release()
  }
  if (normalizePickupCode(order.pickupCode) !== previousCode || !order.pickupQrCodeUrl) {
    order.pickupQrCodeUrl = await generatePickupQrCode(order.pickupCode)
  }
}

async function generatePickupQrCode(pickupCode) {
  const code = normalizePickupCode(pickupCode)
  if (!code || !QRCode) return ""
  const outputFile = path.join(uploadsDir, `pickup-code-${code}.png`)
  if (fs.existsSync(outputFile)) return publicAssetUrl(`/uploads/${path.basename(outputFile)}`)
  try {
    await QRCode.toFile(outputFile, code, {
      margin: 1,
      width: 420,
      errorCorrectionLevel: "M",
      color: {
        dark: "#1F2937",
        light: "#FFFFFF"
      }
    })
    return publicAssetUrl(`/uploads/${path.basename(outputFile)}`)
  } catch (error) {
    console.warn("[pickup] qrcode generate failed", { code, message: error.message })
    return ""
  }
}

function storePublicView(store) {
  return store ? {
    id: store.id,
    name: store.name,
    level: store.level,
    address: store.address,
    phone: store.phone,
    businessHours: store.businessHours,
    latitude: store.latitude,
    longitude: store.longitude,
    status: store.status,
    isPickupEnabled: store.isPickupEnabled,
    sortOrder: store.sortOrder
  } : null
}

function storePrivateView(store) {
  return store ? {
    ...storePublicView(store),
    contactName: store.contactName,
    managerPhone: maskPhone(store.managerPhone),
    storeRole: store.storeRole,
    storeRoleText: storeRoleText(store.storeRole),
    storeStatus: store.storeStatus,
    settlementCycle: store.settlementCycle,
    qrcodeScene: store.qrcodeScene,
    isDisplayEnabled: store.isDisplayEnabled,
    isSupplierEnabled: store.isSupplierEnabled
  } : null
}

function maskPhone(phone) {
  const text = String(phone || "")
  return text.length === 11 ? `${text.slice(0, 3)}****${text.slice(7)}` : text
}

function maskName(name) {
  const text = String(name || "").trim()
  if (!text) return ""
  if (text.length === 1) return `${text}*`
  return `${text[0]}${"*".repeat(Math.min(2, text.length - 1))}`
}

function extractOrderQuantity(order = {}) {
  const remark = String(order.remark || "")
  const quantities = Array.from(remark.matchAll(/x(\d+)/g)).map(match => Number(match[1] || 0)).filter(Boolean)
  if (quantities.length) return quantities.reduce((sum, value) => sum + value, 0)
  return 1
}

function maskNormalizedPhone(phone) {
  const text = normalizePhone(phone)
  return text.length === 11 ? `${text.slice(0, 3)}****${text.slice(7)}` : (text ? `***${text.slice(-4)}` : "")
}

function maskTail(value) {
  const text = String(value || "")
  return text ? `***${text.slice(-4)}` : "empty"
}

function storeRoleText(role) {
  return ({ owner: "店主", manager: "店长", staff: "店员", clerk: "店员" })[role] || "店员"
}

function boolValue(value) {
  if (value === true || value === 1) return true
  const text = String(value || "").trim().toLowerCase()
  return ["true", "1", "yes", "y"].includes(text)
}

function storeOrderSourceText(type, isMemberOrder = false) {
  if (type === "store_self" || isMemberOrder) return "门店自营"
  if (type === "store_external") return "外部顾客"
  if (type === "pickup_service") return "到店自提"
  return type ? String(type) : ""
}

function normalizeStoreMemberRole(role) {
  const text = String(role || "").trim().toLowerCase()
  if (text === "owner") return "owner"
  if (text === "manager") return "manager"
  if (text === "staff" || text === "clerk") return "staff"
  return "staff"
}

function normalizeStoreMember(member = {}, index = 0) {
  const now = formatDateTime(new Date())
  return {
    id: String(member.id || `SM${Date.now()}${index}${crypto.randomBytes(2).toString("hex").toUpperCase()}`),
    storeId: String(member.storeId || member.store_id || ""),
    userId: String(member.userId || member.user_id || ""),
    phone: normalizePhone(member.phone || ""),
    openid: String(member.openid || ""),
    role: normalizeStoreMemberRole(member.role),
    status: isDisabledLike(member.status) ? "disabled" : "active",
    createdAt: member.createdAt || member.created_at || now,
    updatedAt: member.updatedAt || member.updated_at || now
  }
}

function storePermissionsForRole(role) {
  const normalized = normalizeStoreMemberRole(role)
  const permissions = {
    owner: ["store.view", "store.code", "referral.view", "pickup.view", "pickup.notify", "pickup.verify", "earning.view", "settlement.view", "member.manage"],
    manager: ["store.view", "referral.view", "pickup.view", "pickup.notify", "pickup.verify"],
    staff: ["store.view", "pickup.view", "pickup.verify"]
  }
  return permissions[normalized] || permissions.staff
}

function storeMemberPublicView(member = {}, options = {}) {
  const normalized = normalizeStoreMember(member)
  const view = {
    id: normalized.id,
    storeId: normalized.storeId,
    phone: maskPhone(normalized.phone),
    hasOpenid: !!normalized.openid,
    role: normalized.role,
    roleText: storeRoleText(normalized.role),
    status: normalized.status,
    statusText: normalized.status === "active" ? "启用" : "禁用",
    permissions: storePermissionsForRole(normalized.role)
  }
  if (options.includeRawPhone) view.phoneRaw = normalized.phone
  return view
}

function hasStorePermission(storeSession, permission) {
  if (!permission) return true
  return (storeSession?.permissions || []).includes(permission)
}

function identityFromRequest(req, payload = {}) {
  const token = String(
    req.headers["x-user-session"] ||
    req.headers["x-user-token"] ||
    payload.userSession ||
    payload.userToken ||
    payload.token ||
    ""
  ).trim()
  const session = getUserSession(token)
  if (session?.openid) return { openid: session.openid, phone: session.phone || "", userSession: token, userToken: token }
  return {}
}

async function resolveIdentityFromRequest(req, payload = {}) {
  const token = String(
    req.headers["x-user-session"] ||
    req.headers["x-user-token"] ||
    payload.userSession ||
    payload.userToken ||
    payload.token ||
    ""
  ).trim()
  const session = await resolveUserSession(token)
  if (!session?.openid) return {}
  let customer = await findCustomerForIdentity(session)
  if (!customer && session.phone) {
    const ensured = await ensureInternalUserIdentity(session)
    customer = ensured.userId ? { id: ensured.userId, phone: session.phone, openid: session.openid } : null
  }
  return {
    userId: customer?.id || "",
    openid: session.openid,
    phone: session.phone || customer?.phone || "",
    userSession: token,
    userToken: token
  }
}

async function findCustomerForIdentity(identity = {}) {
  const phone = normalizePhone(identity.phone)
  const openid = String(identity.openid || "").trim()
  if (!phone && !openid) return null
  if (!pool) {
    return (await getCustomers()).find(customer =>
      (phone && normalizePhone(customer.phone) === phone) ||
      (openid && String(customer.openid || "") === openid)
    ) || null
  }
  const rows = await query(
    `SELECT id, phone, openid, name, nickname
     FROM customers
     WHERE (:phone <> '' AND phone = :phone)
        OR (:openid <> '' AND openid = :openid)
     ORDER BY CASE WHEN phone = :phone THEN 0 ELSE 1 END
     LIMIT 1`,
    { phone, openid }
  )
  return rows[0] || null
}

async function ensureInternalUserIdentity(identity = {}) {
  const current = requestIdentity(identity)
  if (!current.phone && !current.openid) throw httpError(401, "请先完成微信登录")
  const existing = await findCustomerForIdentity(current)
  if (existing?.id) return { ...current, userId: existing.id }
  const identitySeed = current.openid || current.phone
  const userId = `C${crypto.createHash("sha256").update(identitySeed).digest("hex").slice(0, 24).toUpperCase()}`
  if (!pool) {
    const customers = await getCustomers()
    const found = customers.find(customer =>
      (current.phone && normalizePhone(customer.phone) === normalizePhone(current.phone)) ||
      (current.openid && String(customer.openid || "") === current.openid)
    )
    if (found?.id) return { ...current, userId: found.id }
    customers.push(normalizeCustomer({
      id: userId,
      name: "微信用户",
      phone: current.phone,
      openid: current.openid
    }, customers.length))
    await saveCustomers(customers)
    return { ...current, userId }
  }
  await query(
    `INSERT IGNORE INTO customers
      (id, name, nickname, phone, openid, orders, total_amount, last_contact, invite_code, shopping_money)
     VALUES
      (:id, '微信用户', '微信用户', :phone, :openid, 0, 0, CURDATE(), :inviteCode, 0)`,
    {
      id: userId,
      phone: current.phone || null,
      openid: current.openid || null,
      inviteCode: current.phone ? inviteCodeFor(current.phone) : ""
    }
  )
  const resolved = await findCustomerForIdentity({ ...current, userId })
  return { ...current, userId: resolved?.id || userId }
}

function inferAiPreviewType(product = {}) {
  const text = `${product.name || ""} ${(Array.isArray(product.categories) ? product.categories.join(" ") : "")} ${product.intro || ""}`
  if (/叶雕|天然叶/.test(text)) return "leaf"
  if (/宠物|摆件|3D|手办/.test(text)) return "stand"
  if (/木牌|木|激光|雕刻/.test(text)) return "wood"
  if (/军牌/.test(text)) return "dogtag"
  if (/情侣|纪念|礼物/.test(text)) return "couple"
  return "gift"
}

function aiPreviewTypeText(type) {
  return {
    leaf: "叶雕",
    stand: "摆件",
    wood: "木牌",
    dogtag: "军牌",
    couple: "情侣礼物",
    gift: "纪念礼物"
  }[type] || "纪念礼物"
}

function aiPreviewPrompt(type, productName) {
  const templates = {
    leaf: "将上传照片制作成高端天然叶雕纪念品展示图，暖色高级感，真实电商产品摄影风格，叶片纹理清晰，礼物包装精致",
    stand: "将上传照片主体制作成桌面3D打印摆件展示图，治愈风格，高级家居场景，真实产品摄影，柔和光影",
    wood: "将上传照片制作成激光雕刻木牌预览图，木纹真实，高级礼品摄影，暖色调，成品质感清晰",
    dogtag: "将上传头像或图案制作成军牌挂件定制效果图，金属质感，高级黑白灰产品摄影，边缘刻字精致",
    couple: "将上传双人照制作成高颜值情侣礼物展示图，浪漫但克制，高级礼品摄影，质感真实",
    gift: "将上传照片制作成高级定制纪念礼物展示图，真实电商产品摄影风格，温暖高级，成品质感清晰"
  }
  return `${templates[type] || templates.gift}。商品：${productName || aiPreviewTypeText(type)}。画面不要出现夸张文字，不要改变主体气质。`
}

function makePreviewSvg({ type, productName, sourceImageUrl }) {
  const title = aiPreviewTypeText(type)
  const accent = {
    leaf: ["#9fb36a", "#fff7df"],
    stand: ["#8ec9bd", "#f5fffb"],
    wood: ["#c59a60", "#fff2df"],
    dogtag: ["#7b818a", "#f3f4f6"],
    couple: ["#d9a0a5", "#fff4f5"],
    gift: ["#bfa1d8", "#fbf6ff"]
  }[type] || ["#202020", "#f7efec"]
  const escapedTitle = title.replace(/[<>&]/g, "")
  const escapedProduct = String(productName || "定制礼物").replace(/[<>&]/g, "")
  const escapedSource = String(sourceImageUrl || "").replace(/[<>&"]/g, "")
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop stop-color="${accent[1]}"/><stop offset="1" stop-color="#ffffff"/></linearGradient>
      <filter id="shadow"><feDropShadow dx="0" dy="28" stdDeviation="28" flood-color="#2a211f" flood-opacity=".18"/></filter>
      <clipPath id="photo"><rect x="332" y="222" width="360" height="360" rx="40"/></clipPath>
    </defs>
    <rect width="1024" height="1024" fill="url(#bg)"/>
    <circle cx="188" cy="172" r="92" fill="${accent[0]}" opacity=".16"/>
    <circle cx="864" cy="812" r="142" fill="${accent[0]}" opacity=".12"/>
    <rect x="162" y="742" width="700" height="58" rx="29" fill="#2a211f" opacity=".08"/>
    <g filter="url(#shadow)">
      <rect x="256" y="178" width="512" height="560" rx="54" fill="#ffffff"/>
      <rect x="302" y="206" width="420" height="420" rx="46" fill="${accent[0]}" opacity=".12"/>
      ${escapedSource ? `<image href="${escapedSource}" x="332" y="222" width="360" height="360" preserveAspectRatio="xMidYMid slice" clip-path="url(#photo)" opacity=".92"/>` : `<rect x="332" y="222" width="360" height="360" rx="40" fill="#f2efec"/>`}
      <rect x="322" y="636" width="380" height="46" rx="23" fill="${accent[0]}" opacity=".22"/>
      <text x="512" y="667" font-size="24" font-weight="700" text-anchor="middle" fill="#242120">${escapedTitle}预览</text>
    </g>
    <text x="512" y="856" font-size="38" font-weight="800" text-anchor="middle" fill="#242120">${escapedProduct}</text>
    <text x="512" y="904" font-size="24" font-weight="600" text-anchor="middle" fill="#8d8582">你的专属定制预览 · 下单前可继续微调</text>
  </svg>`
}

async function createOpenAiPreview({ type, productName }) {
  if (!process.env.OPENAI_API_KEY) return ""
  const body = JSON.stringify({
    model: process.env.OPENAI_IMAGE_MODEL || "gpt-image-1",
    prompt: aiPreviewPrompt(type, productName),
    size: "1024x1024"
  })
  const result = await requestJson("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    timeout: 30000
  }, body)
  const b64 = result.data?.data?.[0]?.b64_json
  if (!b64) return ""
  const filename = `ai-preview-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.png`
  fs.writeFileSync(path.join(uploadsDir, filename), Buffer.from(b64, "base64"))
  return `${PUBLIC_BASE_URL}/uploads/${filename}`
}

async function createAiPreview(data = {}) {
  const product = data.productId ? await getProduct(data.productId) : null
  const type = data.templateType || product?.aiPreviewType || inferAiPreviewType(product || { name: data.productName, categories: data.categories })
  const productName = data.productName || product?.name || aiPreviewTypeText(type)
  let url = ""
  try {
    if (String(process.env.AI_PREVIEW_PROVIDER || "mock").toLowerCase() === "openai") {
      url = await createOpenAiPreview({ type, productName })
    }
  } catch (error) {
    url = ""
  }
  const provider = url ? "openai" : "local"
  if (!url) {
    const filename = `ai-preview-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.svg`
    fs.writeFileSync(path.join(uploadsDir, filename), makePreviewSvg({
      type,
      productName,
      sourceImageUrl: data.sourceImageUrl || data.originalImageUrl || ""
    }))
    url = `${PUBLIC_BASE_URL}/uploads/${filename}`
  }
  return {
    ok: true,
    provider,
    templateType: type,
    title: "你的专属定制预览",
    imageUrl: url
  }
}

function normalizeNewcomerBenefits(settings) {
  const defaults = [
    { text: "赠精美礼盒包装", enabled: true, sort: 1 },
    { text: "免费刻字", enabled: true, sort: 2 },
    { text: "赠设计稿修改1次", enabled: true, sort: 3 }
  ]
  const source = Array.isArray(settings.newcomerBenefits) && settings.newcomerBenefits.length ? settings.newcomerBenefits : defaults
  return source
    .map((item, index) => ({
      text: item.text || String(item || ""),
      enabled: String(item.enabled == null ? "true" : item.enabled) !== "false",
      sort: Number(item.sort || index + 1)
    }))
    .filter(item => item.text)
    .sort((a, b) => a.sort - b.sort)
}

function inviteCodeFor(phone) {
  const source = String(phone || "guest")
  return `VS${crypto.createHash("sha1").update(source).digest("hex").slice(0, 6).toUpperCase()}`
}

function normalizeCustomer(customer, index) {
  const phone = customer.phone || ""
  return {
    id: customer.id || `C${Date.now()}${index}`,
    name: customer.name || "",
    nickname: customer.nickname || customer.nickName || customer.name || "",
    phone,
    openid: customer.openid || "",
    avatarUrl: customer.avatarUrl || customer.avatar_url || "",
    wechat: customer.wechat || "",
    orders: Number(customer.orders || 0),
    totalAmount: String(customer.totalAmount || "0"),
    lastContact: customer.lastContact || "",
    inviteCode: customer.inviteCode || inviteCodeFor(phone),
    shoppingMoney: String(customer.shoppingMoney || "0")
  }
}

function normalizePromotionRelation(relation, index) {
  return {
    id: relation.id || `PR${Date.now()}${index}`,
    inviterPhone: normalizePhone(relation.inviterPhone || ""),
    inviterName: relation.inviterName || "",
    inviterCode: relation.inviterCode || inviteCodeFor(relation.inviterPhone),
    inviteePhone: normalizePhone(relation.inviteePhone || ""),
    inviteeName: relation.inviteeName || "",
    level: Number(relation.level || 1),
    createdAt: relation.createdAt || new Date().toISOString().slice(0, 16).replace("T", " ")
  }
}

function normalizeRewardRule(rule, index) {
  return {
    id: rule.id || rule.productId || `RR${Date.now()}${index}`,
    productId: rule.productId || "",
    productName: rule.productName || "未命名商品",
    firstReward: String(rule.firstReward || "0"),
    secondReward: String(rule.secondReward || "0")
  }
}

function normalizeRewardRecord(record, index) {
  const status = normalizeRewardStatus(record.status)
  return {
    id: record.id || `RW${Date.now()}${index}`,
    orderId: record.orderId || "",
    productName: record.productName || "",
    buyerPhone: record.buyerPhone || "",
    promoterPhone: record.promoterPhone || "",
    promoterName: record.promoterName || "",
    level: Number(record.level || 1),
    amount: String(record.amount || "0"),
    type: record.type || record.rewardType || (Number(record.level || 1) === 2 ? "level2" : "level1"),
    status,
    statusText: rewardStatusText(status),
    releaseAt: record.releaseAt || "",
    settledAt: record.settledAt || record.settled_at || "",
    settledAtText: record.settledAtText || formatChinaDatetime(record.settledAt || record.settled_at || ""),
    settledBy: record.settledBy || record.settled_by || "",
    settleNote: record.settleNote || record.settle_note || "",
    cancelReason: record.cancelReason || record.cancel_reason || "",
    batchId: record.batchId || record.batch_id || "",
    relatedRecordId: record.relatedRecordId || record.related_record_id || "",
    createdAt: record.createdAt || new Date().toISOString().slice(0, 16).replace("T", " "),
    updatedAt: record.updatedAt || ""
  }
}

function isChargebackRecord(record = {}) {
  return String(record.type || "").includes("chargeback") || String(record.id || "").includes("CHARGEBACK")
}

function normalizeRewardStatus(status) {
  const text = String(status || "").trim()
  if (["pending_confirm", "pending", "待确认", "预计收益"].includes(text)) return "pending_confirm"
  if (["chargeback", "refunded", "退款扣回"].includes(text)) return "chargeback"
  if (["settled", "已结算", "已发放"].includes(text)) return "settled"
  if (["cancelled", "canceled", "已取消", "已扣回", "扣回"].includes(text)) return "cancelled"
  return "unsettled"
}

function rewardStatusText(status) {
  if (status === "pending_confirm") return "待确认"
  if (status === "settled") return "已结算"
  if (status === "chargeback" || status === "refunded") return "退款扣回"
  if (status === "cancelled") return "已取消"
  return "未结算"
}

function normalizeSettlementStatus(status) {
  const text = String(status || "").trim()
  if (["pending_confirm", "pending", "待确认", "预计收益"].includes(text)) return "pending_confirm"
  if (["chargeback", "refunded", "退款扣回"].includes(text)) return "chargeback"
  if (["settled", "已结算"].includes(text)) return "settled"
  if (["cancelled", "canceled", "已取消", "invalid", "失效"].includes(text)) return "cancelled"
  return "unsettled"
}

function settlementStatusText(status) {
  if (status === "pending_confirm") return "待确认"
  if (status === "settled") return "已结算"
  if (status === "chargeback" || status === "refunded") return "退款扣回"
  if (status === "cancelled") return "已取消"
  return "未结算"
}

function isOrderRewardConfirmed(order = {}) {
  if (!order) return false
  const status = String(order.status || "").trim().toLowerCase()
  const pickupStatus = String(order.pickupStatus || order.pickup_status || "").trim().toLowerCase()
  if (isPickupOrder(order)) {
    return ["picked_up", "pickedup", "已自提"].includes(pickupStatus) &&
      !!(order.pickupVerifiedAt || order.pickup_verified_at || order.forcePickupVerifiedAt || order.force_pickup_verified_at)
  }
  return ["已完成", "completed", "complete", "done"].includes(status) ||
    !!order.completedAt ||
    !!order.completed_at
}

function buildOrderLookup(orders = []) {
  const lookup = new Map()
  ;(Array.isArray(orders) ? orders : []).forEach(order => {
    if (order?.id) lookup.set(order.id, order)
  })
  return lookup
}

function effectiveSettlementStatus(record = {}, orderLookup = new Map()) {
  const status = normalizeSettlementStatus(record.status)
  const amount = Number(record.amount || 0)
  if (status === "settled" || status === "cancelled") return status
  if (status === "chargeback" || amount < 0 || isChargebackRecord(record)) return "chargeback"
  const order = record.orderId ? orderLookup.get(record.orderId) : null
  if (record.orderId && order) return isOrderRewardConfirmed(order) ? "unsettled" : "pending_confirm"
  if (status === "pending_confirm") return "pending_confirm"
  return "unsettled"
}

function buildSettlementSummary(records = [], orders = []) {
  const list = Array.isArray(records) ? records : []
  const orderLookup = orders instanceof Map ? orders : buildOrderLookup(orders)
  const settledTotal = list
    .filter(record => effectiveSettlementStatus(record, orderLookup) === "settled" && Number(record.amount || 0) > 0)
    .reduce((sum, record) => sum + Number(record.amount || 0), 0)
  const estimatedTotal = list
    .filter(record => effectiveSettlementStatus(record, orderLookup) === "pending_confirm" && Number(record.amount || 0) > 0)
    .reduce((sum, record) => sum + Number(record.amount || 0), 0)
  const payableTotal = list
    .filter(record => effectiveSettlementStatus(record, orderLookup) === "unsettled" && Number(record.amount || 0) > 0)
    .reduce((sum, record) => sum + Number(record.amount || 0), 0)
  const chargebackTotal = Math.abs(list
    .filter(record => effectiveSettlementStatus(record, orderLookup) === "chargeback")
    .reduce((sum, record) => sum + Number(record.amount || 0), 0))
  const actualPayable = Math.max(payableTotal - chargebackTotal, 0)
  const remainingChargeback = Math.max(chargebackTotal - payableTotal, 0)
  return {
    estimatedTotal: money(estimatedTotal),
    settledTotal: money(settledTotal),
    payableTotal: money(payableTotal),
    chargebackTotal: money(chargebackTotal),
    actualPayable: money(actualPayable),
    remainingChargeback: money(remainingChargeback),
    settledAmount: money(settledTotal),
    unsettledAmount: money(payableTotal),
    pendingReward: money(payableTotal)
  }
}

function decorateSettlementRecord(record = {}, orders = []) {
  const orderLookup = orders instanceof Map ? orders : buildOrderLookup(orders)
  const status = effectiveSettlementStatus(record, orderLookup)
  return {
    ...record,
    effectiveStatus: status,
    statusText: settlementStatusText(status)
  }
}

function decorateRewardRecord(record = {}, orders = []) {
  const orderLookup = orders instanceof Map ? orders : buildOrderLookup(orders)
  const status = effectiveSettlementStatus(record, orderLookup)
  return {
    ...record,
    effectiveStatus: status,
    statusText: rewardStatusText(status)
  }
}

function isFinancialRecordReadyToSettle(record = {}, orders = []) {
  const effective = effectiveSettlementStatus(record, orders instanceof Map ? orders : buildOrderLookup(orders))
  return effective === "unsettled" || effective === "chargeback"
}

function includeSettlementRecordForStats(record = {}, activeOrderIds = new Set()) {
  if (normalizeSettlementStatus(record.status) === "chargeback" || isChargebackRecord(record)) return true
  return !record.orderId || activeOrderIds.has(record.orderId)
}

async function query(sql, params = {}) {
  const [rows] = await pool.query(sql, params)
  return rows
}

async function getHome() {
  if (!pool) return normalizeHome(readJsonFile(homeFile, {}))
  const rows = await query("SELECT data, updated_at FROM home_config WHERE id = 1")
  if (!rows.length) return normalizeHome({})
  return { ...normalizeHome(parseJsonValue(rows[0].data, {})), updatedAt: rows[0].updated_at }
}

async function saveHome(data) {
  const previousHome = await getHome().catch(() => normalizeHome({}))
  const stampedData = {
    ...data,
    updatedAt: new Date().toISOString(),
    banners: (Array.isArray(data.banners) ? data.banners : []).slice(0, 3).map(item => ({
      ...item
    }))
  }
  stampedData.banners = stampedData.banners.map((banner, index) => normalizeBannerForSave(banner, previousHome.banners?.[index] || {}))
  const home = normalizeHome(stampedData)
  home.banners.forEach((banner, index) => {
    console.log("[admin-banner-save]", bannerSummaryForLog(banner, index))
  })
  if (!pool) {
    writeJsonFile(homeFile, home)
    return home
  }
  await query("UPDATE home_config SET data = :data WHERE id = 1", { data: JSON.stringify(home) })
  return home
}

async function getProducts() {
  await getSettings().catch(() => null)
  if (!pool) {
    const rules = readJsonFile(rewardRulesFile, []).map(normalizeRewardRule)
    return (readJsonFile(homeFile, {}).products || []).map(normalizeProduct).map(product => {
      const rule = rules.find(item => item.productId === product.id || item.productName === product.name)
      return {
        ...product,
        firstReward: product.firstReward !== "0" ? product.firstReward : (rule?.firstReward || product.firstReward),
        secondReward: product.secondReward !== "0" ? product.secondReward : (rule?.secondReward || product.secondReward)
      }
    })
  }
  const rows = await query("SELECT * FROM products ORDER BY sort_order ASC, updated_at DESC")
  const rules = (await query("SELECT * FROM reward_rules ORDER BY product_name ASC")).map(row => normalizeRewardRule({
    id: row.id,
    productId: row.product_id,
    productName: row.product_name,
    firstReward: row.first_reward,
    secondReward: row.second_reward
  }, 0))
  return rows.map((row, index) => {
    const product = {
    id: row.id,
    name: row.name,
    intro: row.intro || "",
    price: String(row.price || "0"),
    costPrice: String(row.cost_price || "0"),
    badge: normalizeBadge(row.badge || ""),
    cover: row.cover || "keyring",
    imageUrl: publicAssetUrl(row.image_url),
    galleryImages: normalizeAssetUrls(normalizeMediaList(parseJsonValue(row.gallery_images, []))),
    videoUrl: publicAssetUrl(row.video_url),
    detailImages: normalizeAssetUrls(normalizeMediaList(parseJsonValue(row.detail_images, []))),
    detailText: row.detail_text || "",
    productType: row.product_type || "",
    categories: normalizeProductCategories(parseJsonValue(row.categories, []), row),
    status: row.status || "on",
    stock: String(row.stock || "0"),
    stockMode: normalizeInventoryMode({ ...row, stockMode: row.stock_mode }),
    inventoryVersion: Number(row.inventory_version || 0),
    isHot: normalizeBooleanText(row.is_hot, false),
    promotionHot: normalizeBooleanText(row.promotion_hot, false),
    aiPreviewEnabled: normalizeBooleanText(row.ai_preview_enabled, false),
    aiPreviewType: row.ai_preview_type || "",
    rewardEnabled: String(row.reward_enabled == null ? "true" : row.reward_enabled) === "false" ? "false" : "true",
    firstReward: String(row.first_reward || "0"),
    secondReward: String(row.second_reward || "0"),
    modelCandidateId: row.model_candidate_id || "",
    modelSourceUrl: row.model_source_url || "",
    modelAuthorName: row.model_author_name || "",
    modelAuthorizationStatus: row.model_authorization_status || "",
    modelAuthorizationNote: row.model_authorization_note || "",
    sortOrder: String(row.sort_order || "0")
    }
    const normalized = normalizeProduct(product, index)
    const rule = rules.find(item => item.productId === product.id || item.productName === product.name)
    return {
      ...normalized,
      firstReward: normalized.firstReward !== "0" ? normalized.firstReward : (rule?.firstReward || normalized.firstReward),
      secondReward: normalized.secondReward !== "0" ? normalized.secondReward : (rule?.secondReward || normalized.secondReward)
    }
  })
}

async function getProduct(id) {
  if (!pool) return (await getProducts()).find(product => product.id === id) || null
  const rows = await query("SELECT * FROM products WHERE id = :id LIMIT 1", { id })
  return rows[0] ? (await getProducts()).find(product => product.id === id) : null
}

async function getPartnerStores(filters = {}) {
  if (!pool) {
    let list = readJsonFile(partnerStoresFile, []).map(normalizePartnerStore)
    if (filters.status === "enabled") list = list.filter(isStoreEnabled)
    else if (filters.status === "disabled") list = list.filter(store => !isStoreEnabled(store))
    else if (filters.status) list = list.filter(store => normalizeStatusText(store.status) === normalizeStatusText(filters.status))
    if (filters.pickupOnly) list = list.filter(store => store.isPickupEnabled === "true")
    if (filters.keyword) {
      const keyword = String(filters.keyword).toLowerCase()
      list = list.filter(store => [store.id, store.name, store.address, store.phone, store.contactName].some(value => String(value || "").toLowerCase().includes(keyword)))
    }
    return list.sort((a, b) => Number(a.sortOrder || 999) - Number(b.sortOrder || 999))
  }
  const where = []
  const params = {}
  if (filters.status) {
    if (filters.status === "enabled") {
      where.push("(status IS NULL OR status = '' OR status IN ('enabled','active','on','1','true','启用','已启用','正常'))")
    } else if (filters.status === "disabled") {
      where.push("status IN ('disabled','inactive','off','0','false','停用','禁用','已停用')")
    } else {
      where.push("status = :status")
      params.status = filters.status
    }
  }
  if (filters.pickupOnly) where.push("is_pickup_enabled = 'true'")
  if (filters.keyword) {
    where.push("(id LIKE :keyword OR name LIKE :keyword OR address LIKE :keyword OR phone LIKE :keyword OR contact_name LIKE :keyword)")
    params.keyword = `%${filters.keyword}%`
  }
  const rows = await query(`SELECT * FROM partner_stores ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY sort_order ASC, id ASC`, params)
  return rows.map((row, index) => normalizePartnerStore(row, index))
}

async function getPartnerStore(id) {
  if (!id) return null
  return (await getPartnerStores()).find(store => store.id === id) || null
}

function isActiveStoreManagerBinding(store) {
  return !!store.managerPhone && isStoreEnabled(store)
}

function managerPhoneDuplicateMap(stores = []) {
  const groups = new Map()
  stores.filter(isActiveStoreManagerBinding).forEach(store => {
    const phone = normalizePhone(store.managerPhone)
    if (!groups.has(phone)) groups.set(phone, [])
    groups.get(phone).push(store)
  })
  return groups
}

function withStoreManagerWarnings(stores = []) {
  const groups = managerPhoneDuplicateMap(stores)
  return stores.map(store => {
    const duplicates = groups.get(normalizePhone(store.managerPhone)) || []
    return duplicates.length > 1
      ? { ...store, managerPhoneDuplicated: true, managerPhoneWarning: "该手机号已绑定多个启用门店，请联系管理员处理" }
      : store
  })
}

function storeManagerDebugView(stores = [], inputPhone = "") {
  const normalizedInput = normalizePhone(inputPhone)
  const allStores = (Array.isArray(stores) ? stores : []).map(normalizePartnerStore)
  const matched = allStores.filter(store => normalizePhone(store.managerPhone) === normalizedInput)
  const activeMatched = matched.filter(isStoreEnabled)
  let reason = "not_found"
  if (!normalizedInput) reason = "empty_phone"
  else if (!matched.length) reason = "manager_phone_not_saved_or_not_matched"
  else if (matched.length && !activeMatched.length) reason = "matched_but_store_disabled"
  else if (activeMatched.length > 1) reason = "multiple_active_stores_matched"
  else reason = "matched_active_store"
  return {
    ok: true,
    inputPhoneMasked: maskNormalizedPhone(normalizedInput),
    normalizedInput: normalizedInput ? `***${normalizedInput.slice(-4)}` : "",
    matchedCount: activeMatched.length,
    rawMatchedCount: matched.length,
    stores: matched.map(store => ({
      name: store.name,
      managerPhoneMasked: maskNormalizedPhone(store.managerPhone),
      status: store.status,
      storeStatus: store.storeStatus,
      enabled: isStoreEnabled(store),
      role: store.storeRole
    })),
    reason
  }
}

function assertUniqueManagerPhone(stores = [], candidate = {}) {
  if (!isActiveStoreManagerBinding(candidate)) return
  const phone = normalizePhone(candidate.managerPhone)
  const conflict = stores.find(store =>
    store.id !== candidate.id &&
    isActiveStoreManagerBinding(store) &&
    normalizePhone(store.managerPhone) === phone
  )
  if (conflict) throw httpError(400, "该手机号已绑定其他门店，请更换负责人手机号或先解绑原门店。")
}

async function savePartnerStores(stores) {
  const list = (Array.isArray(stores) ? stores : []).map(normalizePartnerStore)
  if (!pool) {
    writeJsonFile(partnerStoresFile, list)
    return list
  }
  await query("DELETE FROM partner_stores")
  for (const store of list) {
    const params = {
      ...store,
      latitude: store.latitude === "" ? null : store.latitude,
      longitude: store.longitude === "" ? null : store.longitude,
      salesAgentCommissionRate: store.salesAgentCommissionRate === "" ? null : store.salesAgentCommissionRate,
      createdAt: toMysqlDatetime(store.createdAt, nowMysqlDatetime()),
      updatedAt: toMysqlDatetime(store.updatedAt, nowMysqlDatetime())
    }
    await query(
      `INSERT INTO partner_stores (id, name, level, address, phone, contact_name, manager_phone, manager_openid, store_role, store_status, business_hours, latitude, longitude, status, is_display_enabled, is_pickup_enabled, is_supplier_enabled, settlement_cycle, qrcode_scene, sort_order, remark, referral_commission_type, referral_commission_value, pickup_fee_type, pickup_fee_value, supplier_settlement_rule, custom_commission_rule, sales_agent_id, sales_agent_commission_rate, created_at, updated_at)
       VALUES (:id, :name, :level, :address, :phone, :contactName, :managerPhone, :managerOpenid, :storeRole, :storeStatus, :businessHours, :latitude, :longitude, :status, :isDisplayEnabled, :isPickupEnabled, :isSupplierEnabled, :settlementCycle, :qrcodeScene, :sortOrder, :remark, :referralCommissionType, :referralCommissionValue, :pickupFeeType, :pickupFeeValue, :supplierSettlementRule, :customCommissionRule, :salesAgentId, :salesAgentCommissionRate, :createdAt, :updatedAt)`,
      params
    )
  }
  return list
}

async function upsertPartnerStore(store) {
  const list = await getPartnerStores()
  const requestedId = store.id || ""
  const index = requestedId ? list.findIndex(item => item.id === requestedId) : -1
  const base = index >= 0 ? list[index] : {}
  const normalized = normalizePartnerStore({
    ...base,
    ...store,
    id: requestedId || `STORE${Date.now()}${crypto.randomBytes(2).toString("hex").toUpperCase()}`,
    updatedAt: formatDateTime(new Date())
  }, list.length)
  const candidate = index >= 0 ? { ...list[index], ...normalized } : normalized
  assertUniqueManagerPhone(list, candidate)
  if (index >= 0) list[index] = candidate
  else list.push(normalized)
  await savePartnerStores(list)
  const saved = index >= 0 ? candidate : normalized
  if (Array.isArray(store.members)) await saveStoreMembersForStore(saved.id, store.members)
  else await ensureLegacyStoreMembersForStore(saved)
  return saved
}

async function getSalesAgents(filters = {}) {
  if (!pool) {
    let list = readJsonFile(salesAgentsFile, []).map(normalizeSalesAgent)
    if (filters.status) list = list.filter(agent => agent.status === filters.status)
    if (filters.keyword) {
      const keyword = String(filters.keyword).toLowerCase()
      list = list.filter(agent => [agent.name, agent.phone, agent.remark].some(value => String(value || "").toLowerCase().includes(keyword)))
    }
    return list.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))
  }
  const where = []
  const params = {}
  if (filters.status) {
    where.push("status = :status")
    params.status = filters.status
  }
  if (filters.keyword) {
    where.push("(name LIKE :keyword OR phone LIKE :keyword OR remark LIKE :keyword)")
    params.keyword = `%${filters.keyword}%`
  }
  const rows = await query(`SELECT * FROM sales_agents ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC, id DESC`, params)
  return rows.map((row, index) => normalizeSalesAgent(row, index))
}

async function getSalesAgent(id) {
  if (!id) return null
  return (await getSalesAgents()).find(agent => agent.id === id) || null
}

async function saveSalesAgents(agents = []) {
  const list = (Array.isArray(agents) ? agents : []).map(normalizeSalesAgent)
  if (!pool) {
    writeJsonFile(salesAgentsFile, list)
    return list
  }
  for (const agent of list) {
    await query(
      `INSERT INTO sales_agents (id, name, phone, password_hash, commission_rate, status, remark, created_at, updated_at)
       VALUES (:id, :name, :phone, :passwordHash, :commissionRate, :status, :remark, :createdAt, :updatedAt)
       ON DUPLICATE KEY UPDATE name = VALUES(name), phone = VALUES(phone), password_hash = VALUES(password_hash), commission_rate = VALUES(commission_rate), status = VALUES(status), remark = VALUES(remark), updated_at = VALUES(updated_at)`,
      { ...agent, createdAt: toMysqlDatetime(agent.createdAt, nowMysqlDatetime()), updatedAt: toMysqlDatetime(agent.updatedAt, nowMysqlDatetime()) }
    )
  }
  return list
}

async function upsertSalesAgent(data = {}) {
  const list = await getSalesAgents()
  const id = data.id || ""
  const index = id ? list.findIndex(agent => agent.id === id) : -1
  const phone = normalizePhone(data.phone || "")
  if (!phone) throw httpError(400, "请填写业务员手机号")
  const duplicate = list.find(agent => agent.id !== id && agent.phone === phone)
  if (duplicate) throw httpError(400, "该手机号已存在")
  const previous = index >= 0 ? list[index] : {}
  const password = String(data.password || data.initialPassword || "").trim()
  if (index < 0 && !password) throw httpError(400, "请填写初始密码")
  const now = formatDateTime(new Date())
  const agent = normalizeSalesAgent({
    ...previous,
    ...data,
    id: id || `SA${Date.now()}${crypto.randomBytes(2).toString("hex").toUpperCase()}`,
    phone,
    passwordHash: password ? hashPassword(password) : previous.passwordHash,
    updatedAt: now,
    createdAt: previous.createdAt || now
  }, list.length)
  if (index >= 0) list[index] = agent
  else list.unshift(agent)
  await saveSalesAgents(list)
  return salesAgentPublicView(agent)
}

async function getStoreLeads(filters = {}) {
  if (!pool) {
    let list = readJsonFile(storeLeadsFile, []).map(normalizeStoreLead)
    if (filters.salesAgentId) list = list.filter(lead => lead.salesAgentId === filters.salesAgentId)
    if (filters.status) list = list.filter(lead => lead.status === filters.status)
    return list.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))
  }
  const where = []
  const params = {}
  if (filters.salesAgentId) {
    where.push("sales_agent_id = :salesAgentId")
    params.salesAgentId = filters.salesAgentId
  }
  if (filters.status) {
    where.push("status = :status")
    params.status = filters.status
  }
  const rows = await query(`SELECT * FROM store_leads ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC`, params)
  return rows.map((row, index) => normalizeStoreLead({ ...row, photos: parseJsonValue(row.photos, []) }, index))
}

async function saveStoreLeads(leads = []) {
  const list = (Array.isArray(leads) ? leads : []).map(normalizeStoreLead)
  if (!pool) {
    writeJsonFile(storeLeadsFile, list)
    return list
  }
  for (const lead of list) {
    await query(
      `INSERT INTO store_leads (id, sales_agent_id, store_name, contact_name, contact_phone, address, latitude, longitude, store_type, cooperation_type, pickup_enabled, photos, remark, status, reject_reason, store_id, created_at, handled_at, handled_by)
       VALUES (:id, :salesAgentId, :storeName, :contactName, :contactPhone, :address, :latitude, :longitude, :storeType, :cooperationType, :pickupEnabled, :photosJson, :remark, :status, :rejectReason, :storeId, :createdAt, :handledAt, :handledBy)
       ON DUPLICATE KEY UPDATE store_name = VALUES(store_name), contact_name = VALUES(contact_name), contact_phone = VALUES(contact_phone), address = VALUES(address), latitude = VALUES(latitude), longitude = VALUES(longitude), store_type = VALUES(store_type), cooperation_type = VALUES(cooperation_type), pickup_enabled = VALUES(pickup_enabled), photos = VALUES(photos), remark = VALUES(remark), status = VALUES(status), reject_reason = VALUES(reject_reason), store_id = VALUES(store_id), handled_at = VALUES(handled_at), handled_by = VALUES(handled_by)`,
      {
        ...lead,
        latitude: lead.latitude === "" ? null : lead.latitude,
        longitude: lead.longitude === "" ? null : lead.longitude,
        photosJson: JSON.stringify(lead.photos || []),
        createdAt: toMysqlDatetime(lead.createdAt, nowMysqlDatetime()),
        handledAt: toMysqlDatetime(lead.handledAt),
        handledBy: lead.handledBy || ""
      }
    )
  }
  return list
}

function textSimilarity(a, b) {
  const left = String(a || "").replace(/\s+/g, "").toLowerCase()
  const right = String(b || "").replace(/\s+/g, "").toLowerCase()
  if (!left || !right) return 0
  if (left.includes(right) || right.includes(left)) return Math.min(left.length, right.length) / Math.max(left.length, right.length)
  const chars = new Set(left)
  let hit = 0
  for (const char of new Set(right)) if (chars.has(char)) hit += 1
  return hit / Math.max(new Set([...left, ...right]).size, 1)
}

function distanceMeters(lat1, lng1, lat2, lng2) {
  const a = Number(lat1)
  const b = Number(lng1)
  const c = Number(lat2)
  const d = Number(lng2)
  if (![a, b, c, d].every(Number.isFinite)) return Infinity
  const rad = value => value * Math.PI / 180
  const earth = 6371000
  const deltaLat = rad(c - a)
  const deltaLng = rad(d - b)
  const x = Math.sin(deltaLat / 2) ** 2 + Math.cos(rad(a)) * Math.cos(rad(c)) * Math.sin(deltaLng / 2) ** 2
  return 2 * earth * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x))
}

async function duplicateStoreCandidatesForLead(lead) {
  const stores = await getPartnerStores()
  return stores.map(store => {
    const reasons = []
    if (lead.contactPhone && store.phone && normalizePhone(store.phone) === normalizePhone(lead.contactPhone)) reasons.push("联系电话相同")
    if (textSimilarity(lead.storeName, store.name) >= 0.65) reasons.push("门店名称相似")
    if (textSimilarity(lead.address, store.address) >= 0.65) reasons.push("地址相似")
    const distance = distanceMeters(lead.latitude, lead.longitude, store.latitude, store.longitude)
    if (Number.isFinite(distance) && distance <= 300) reasons.push(`经纬度附近 ${Math.round(distance)}m`)
    return { store, reasons }
  }).filter(item => item.reasons.length).map(item => ({ ...item.store, duplicateReasons: item.reasons }))
}

async function createStoreLead(agentId, data = {}) {
  const required = ["storeName", "contactName", "contactPhone", "address"]
  for (const key of required) {
    if (!String(data[key] || "").trim()) throw httpError(400, "请填写完整门店信息")
  }
  const leads = await getStoreLeads()
  const now = formatDateTime(new Date())
  const lead = normalizeStoreLead({
    ...data,
    id: `SL${Date.now()}${crypto.randomBytes(2).toString("hex").toUpperCase()}`,
    salesAgentId: agentId,
    status: "pending",
    photos: normalizeMediaList(data.photos || []).slice(0, 3),
    createdAt: now
  }, leads.length)
  leads.unshift(lead)
  await saveStoreLeads(leads)
  return lead
}

async function handleStoreLead(leadId, action, data = {}) {
  const leads = await getStoreLeads()
  const index = leads.findIndex(lead => lead.id === leadId)
  if (index < 0) throw httpError(404, "门店线索不存在")
  const lead = leads[index]
  const now = formatDateTime(new Date())
  if (action === "follow") {
    leads[index] = { ...lead, status: "followed", handledAt: now, handledBy: "admin" }
  } else if (action === "reject") {
    leads[index] = { ...lead, status: "rejected", rejectReason: data.rejectReason || data.reason || "后台拒绝", handledAt: now, handledBy: "admin" }
  } else if (action === "bind") {
    const store = await getPartnerStore(data.storeId || "")
    if (!store) throw httpError(404, "合作门店不存在")
    await upsertPartnerStore({ ...store, salesAgentId: lead.salesAgentId, salesAgentCommissionRate: data.salesAgentCommissionRate ?? store.salesAgentCommissionRate ?? "" })
    leads[index] = { ...lead, status: "approved", storeId: store.id, handledAt: now, handledBy: "admin" }
  } else if (action === "create") {
    const agent = await getSalesAgent(lead.salesAgentId)
    const store = await upsertPartnerStore({
      name: lead.storeName,
      contactName: lead.contactName,
      phone: lead.contactPhone,
      address: lead.address,
      latitude: lead.latitude,
      longitude: lead.longitude,
      level: lead.pickupEnabled === "true" ? "pickup" : "display",
      isDisplayEnabled: "true",
      isPickupEnabled: lead.pickupEnabled,
      storeStatus: "active",
      status: "enabled",
      remark: [
        lead.storeType ? `门店类型：${lead.storeType}` : "",
        lead.cooperationType ? `合作类型：${lead.cooperationType}` : "",
        lead.photos?.length ? `门店照片：${lead.photos.join("，")}` : "",
        lead.remark || ""
      ].filter(Boolean).join("\n"),
      salesAgentId: lead.salesAgentId,
      salesAgentCommissionRate: data.salesAgentCommissionRate ?? agent?.commissionRate ?? ""
    })
    leads[index] = { ...lead, status: "approved", storeId: store.id, handledAt: now, handledBy: "admin" }
  } else {
    throw httpError(400, "不支持的线索操作")
  }
  await saveStoreLeads(leads)
  return leads[index]
}

async function getStoreMembers(filters = {}) {
  if (!pool) {
    let list = readJsonFile(storeMembersFile, []).map(normalizeStoreMember)
    if (filters.storeId) list = list.filter(member => member.storeId === filters.storeId)
    if (filters.phone) list = list.filter(member => normalizePhone(member.phone) === normalizePhone(filters.phone))
    if (filters.status) list = list.filter(member => member.status === filters.status)
    return list
  }
  const where = []
  const params = {}
  if (filters.storeId) {
    where.push("store_id = :storeId")
    params.storeId = filters.storeId
  }
  if (filters.phone) {
    where.push("phone = :phone")
    params.phone = normalizePhone(filters.phone)
  }
  if (filters.status) {
    where.push("status = :status")
    params.status = filters.status
  }
  const rows = await query(`SELECT * FROM store_members ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY FIELD(role, 'owner', 'manager', 'staff'), created_at ASC, id ASC`, params)
  return rows.map(normalizeStoreMember)
}

async function saveStoreMembers(list = []) {
  const members = (Array.isArray(list) ? list : []).map(normalizeStoreMember).filter(member => member.storeId && member.phone)
  const seen = new Set()
  const deduped = []
  for (const member of members) {
    const key = `${member.storeId}:${member.phone}`
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(member)
  }
  if (!pool) {
    writeJsonFile(storeMembersFile, deduped)
    return deduped
  }
  for (const member of deduped) {
    await upsertStoreMember(member)
  }
  return deduped
}

async function upsertStoreMember(member, connection = null) {
  const normalized = normalizeStoreMember(member)
  const params = {
    ...normalized,
    createdAt: toMysqlDatetime(normalized.createdAt, nowMysqlDatetime()),
    updatedAt: toMysqlDatetime(normalized.updatedAt, nowMysqlDatetime())
  }
  const sql =
    `INSERT INTO store_members
      (id, store_id, user_id, phone, openid, role, status, created_at, updated_at)
     VALUES
      (:id, :storeId, :userId, :phone, :openid, :role, :status, :createdAt, :updatedAt)
     ON DUPLICATE KEY UPDATE
       user_id=VALUES(user_id),
       openid=VALUES(openid),
       role=VALUES(role),
       status=VALUES(status),
       updated_at=VALUES(updated_at)`
  if (connection) return (await connection.query(sql, params))[0]
  return await query(sql, params)
}

async function saveStoreMembersForStore(storeId, members = []) {
  const now = formatDateTime(new Date())
  const next = (Array.isArray(members) ? members : [])
    .map((member, index) => normalizeStoreMember({
      ...member,
      storeId,
      id: member.id || `SM${Date.now()}${index}${crypto.randomBytes(2).toString("hex").toUpperCase()}`,
      updatedAt: now
    }, index))
    .filter(member => member.phone)
  const phones = new Set()
  for (const member of next) {
    if (phones.has(member.phone)) throw httpError(400, "同一门店不能重复添加相同手机号成员")
    phones.add(member.phone)
  }
  if (!pool) {
    const all = await getStoreMembers()
    return saveStoreMembers([
      ...all.filter(member => member.storeId !== storeId),
      ...next
    ])
  }
  const connection = await pool.getConnection()
  try {
    await connection.beginTransaction()
    await connection.query(
      "SELECT id FROM store_members WHERE store_id=:storeId FOR UPDATE",
      { storeId }
    )
    if (next.length) {
      const params = { storeId }
      const placeholders = next.map((member, index) => {
        params[`id${index}`] = member.id
        return `:id${index}`
      }).join(",")
      await connection.query(
        `DELETE FROM store_members
         WHERE store_id=:storeId AND id NOT IN (${placeholders})`,
        params
      )
    } else {
      await connection.query(
        "DELETE FROM store_members WHERE store_id=:storeId",
        { storeId }
      )
    }
    for (const member of next) await upsertStoreMember(member, connection)
    await connection.commit()
  } catch (error) {
    await connection.rollback().catch(() => {})
    throw error
  } finally {
    connection.release()
  }
  return await getStoreMembers({ storeId })
}

async function ensureLegacyStoreMembersForStore(store) {
  if (!store?.id || !store.managerPhone) return
  const members = await getStoreMembers({ storeId: store.id })
  const phone = normalizePhone(store.managerPhone)
  if (!phone) return
  const existing = members.find(member => member.phone === phone)
  if (existing) return
  await saveStoreMembers([
    normalizeStoreMember({
      id: `SM${store.id}${phone.slice(-4)}`,
      storeId: store.id,
      phone,
      openid: store.managerOpenid || "",
      role: normalizeStoreMemberRole(store.storeRole === "clerk" ? "staff" : store.storeRole || "owner") === "staff" ? "staff" : "owner",
      status: isStoreEnabled(store) ? "active" : "disabled"
    })
  ])
}

async function ensureLegacyStoreMembers() {
  const stores = await getPartnerStores()
  for (const store of stores) {
    await ensureLegacyStoreMembersForStore(store)
  }
}

async function getStoreSettlementRecords(filters = {}) {
  if (!pool) {
    let records = readJsonFile(storeSettlementRecordsFile, []).map(normalizeSettlementRecord)
    if (filters.storeId) records = records.filter(record => record.storeId === filters.storeId)
    if (filters.status) records = records.filter(record => record.status === filters.status)
    if (filters.type) records = records.filter(record => settlementTypeAliases(filters.type).includes(record.type))
    if (filters.startAt) records = records.filter(record => String(record.createdAt || "") >= filters.startAt)
    if (filters.endAt) records = records.filter(record => String(record.createdAt || "") <= filters.endAt)
    return records.reverse()
  }
  const where = []
  const params = {}
  if (filters.storeId) {
    where.push("store_id = :storeId")
    params.storeId = filters.storeId
  }
  if (filters.status) {
    if (filters.status === "chargeback") {
      where.push("status = 'unsettled' AND amount < 0")
    } else {
      where.push("status = :status")
      params.status = filters.status
    }
  }
  if (filters.type) {
    const aliases = settlementTypeAliases(filters.type)
    where.push(`type IN (${aliases.map((_, index) => `:type${index}`).join(",")})`)
    aliases.forEach((type, index) => { params[`type${index}`] = type })
  }
  if (filters.startAt) {
    where.push("created_at >= :startAt")
    params.startAt = filters.startAt
  }
  if (filters.endAt) {
    where.push("created_at <= :endAt")
    params.endAt = filters.endAt
  }
  const rows = await query(`SELECT * FROM store_settlement_records ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC`, params)
  return rows.map((row, index) => normalizeSettlementRecord(row, index))
}

function settlementTypeAliases(type) {
  if (type === "referral" || type === "store_referral_commission" || type === "referral_commission") return ["referral", "store_referral_commission", "referral_commission"]
  if (type === "pickup" || type === "pickup_service_fee") return ["pickup", "pickup_service_fee"]
  return [type]
}

function isStoreReferralSettlement(type) {
  return settlementTypeAliases("referral").includes(type)
}

function isPickupServiceSettlement(type) {
  return settlementTypeAliases("pickup").includes(type)
}

async function saveStoreSettlementRecords(records) {
  const list = (Array.isArray(records) ? records : []).map(normalizeSettlementRecord)
  if (!pool) {
    writeJsonFile(storeSettlementRecordsFile, list)
    return list
  }
  for (const record of list) {
    const params = {
      ...record,
      isStoreMemberOrder: record.isStoreMemberOrder ? "true" : "false",
      createdAt: toMysqlDatetime(record.createdAt, nowMysqlDatetime()),
      settledAt: toMysqlDatetime(record.settledAt),
      updatedAt: toMysqlDatetime(record.updatedAt, nowMysqlDatetime())
    }
    await query(
      `INSERT INTO store_settlement_records (id, store_id, order_id, type, amount, commission_type, commission_value, order_paid_amount, status, description, created_at, settled_at, settled_by, settle_note, cancel_reason, batch_id, store_order_type, is_store_member_order, store_operator_user_id, store_operator_phone, store_operator_openid, store_operator_role, store_operator_name, updated_at)
       VALUES (:id, :storeId, :orderId, :type, :amount, :commissionType, :commissionValue, :orderPaidAmount, :status, :description, :createdAt, :settledAt, :settledBy, :settleNote, :cancelReason, :batchId, :storeOrderType, :isStoreMemberOrder, :storeOperatorUserId, :storeOperatorPhone, :storeOperatorOpenid, :storeOperatorRole, :storeOperatorName, :updatedAt)
       ON DUPLICATE KEY UPDATE status = VALUES(status), settled_at = VALUES(settled_at), settled_by = VALUES(settled_by), settle_note = VALUES(settle_note), cancel_reason = VALUES(cancel_reason), batch_id = VALUES(batch_id), store_order_type = VALUES(store_order_type), is_store_member_order = VALUES(is_store_member_order), store_operator_user_id = VALUES(store_operator_user_id), store_operator_phone = VALUES(store_operator_phone), store_operator_openid = VALUES(store_operator_openid), store_operator_role = VALUES(store_operator_role), store_operator_name = VALUES(store_operator_name), updated_at = VALUES(updated_at), amount = VALUES(amount), description = VALUES(description)`,
      params
    )
  }
  return list
}

function storeSettlementBusinessKey(record = {}) {
  if (record.relatedRecordId && isChargebackRecord(record)) {
    return `chargeback:${record.relatedRecordId}:${record.batchId || record.id}`
  }
  const canonicalType = isStoreReferralSettlement(record.type)
    ? "store_referral_commission"
    : isPickupServiceSettlement(record.type)
      ? "pickup_service_fee"
      : String(record.type || "")
  return record.orderId && record.storeId && canonicalType
    ? `${record.orderId}:${record.storeId}:${canonicalType}`
    : `manual:${record.id}`
}

async function insertStoreSettlementRecord(record, connection = null) {
  const normalized = normalizeSettlementRecord(record)
  const params = {
    ...normalized,
    businessKey: storeSettlementBusinessKey(normalized),
    relatedRecordId: normalized.relatedRecordId || "",
    isStoreMemberOrder: normalized.isStoreMemberOrder ? "true" : "false",
    createdAt: toMysqlDatetime(normalized.createdAt, nowMysqlDatetime()),
    settledAt: toMysqlDatetime(normalized.settledAt),
    updatedAt: toMysqlDatetime(normalized.updatedAt, nowMysqlDatetime())
  }
  const sql = `INSERT IGNORE INTO store_settlement_records
    (id, business_key, related_record_id, store_id, order_id, type, amount,
     commission_type, commission_value, order_paid_amount, status, description,
     created_at, settled_at, settled_by, settle_note, cancel_reason, batch_id,
     store_order_type, is_store_member_order, store_operator_user_id,
     store_operator_phone, store_operator_openid, store_operator_role,
     store_operator_name, updated_at)
   VALUES
    (:id, :businessKey, :relatedRecordId, :storeId, :orderId, :type, :amount,
     :commissionType, :commissionValue, :orderPaidAmount, :status, :description,
     :createdAt, :settledAt, :settledBy, :settleNote, :cancelReason, :batchId,
     :storeOrderType, :isStoreMemberOrder, :storeOperatorUserId,
     :storeOperatorPhone, :storeOperatorOpenid, :storeOperatorRole,
     :storeOperatorName, :updatedAt)`
  if (connection) {
    const [result] = await connection.query(sql, params)
    return Number(result.affectedRows || 0) === 1
  }
  const result = await query(sql, params)
  return Number(result.affectedRows || 0) === 1
}

async function ensureFinancialItemAllocations({
  ledgerType,
  recordId,
  orderId,
  amountCents
}, connection = null) {
  if (!pool || !recordId || !orderId || !Number.isSafeInteger(amountCents) || amountCents <= 0) return []
  const execute = async (sql, params) => {
    if (connection) {
      const [rows] = await connection.query(sql, params)
      return rows
    }
    return await query(sql, params)
  }
  const items = await execute(
    `SELECT id, sku_id, quantity, paid_amount_cents
     FROM order_items WHERE order_id=:orderId ORDER BY created_at ASC, id ASC`,
    { orderId }
  )
  if (!items.length) return []
  const totalPaid = items.reduce((sum, item) => sum + Number(item.paid_amount_cents || 0), 0)
  let allocated = 0
  const allocations = items.map((item, index) => {
    const isLast = index === items.length - 1
    const amount = isLast
      ? amountCents - allocated
      : totalPaid > 0
        ? Math.floor(amountCents * Number(item.paid_amount_cents || 0) / totalPaid)
        : Math.floor(amountCents / items.length)
    allocated += amount
    return {
      id: `FIA${crypto.createHash("sha256").update(`${ledgerType}:${recordId}:${item.id}`).digest("hex").slice(0, 48)}`,
      ledgerType,
      recordId,
      orderId,
      orderItemId: item.id,
      skuId: item.sku_id || "",
      quantity: Number(item.quantity || 0),
      amount
    }
  })
  for (const allocation of allocations) {
    await execute(
      `INSERT IGNORE INTO financial_record_item_allocations
        (id, ledger_type, record_id, order_id, order_item_id, sku_id, quantity, allocated_amount_cents)
       VALUES
        (:id, :ledgerType, :recordId, :orderId, :orderItemId, :skuId, :quantity, :amount)`,
      allocation
    )
  }
  return allocations
}

async function getSalesAgentCommissions(filters = {}) {
  if (!pool) {
    let records = readJsonFile(salesAgentCommissionsFile, []).map(normalizeSalesAgentCommission)
    if (filters.salesAgentId) records = records.filter(record => record.salesAgentId === filters.salesAgentId)
    if (filters.storeId) records = records.filter(record => record.storeId === filters.storeId)
    if (filters.orderId) records = records.filter(record => record.orderId === filters.orderId)
    if (filters.status) records = records.filter(record => filters.status === "chargeback" ? record.type === "chargeback" || Number(record.amount || 0) < 0 : record.status === filters.status)
    if (filters.type) records = records.filter(record => record.type === filters.type)
    if (filters.startAt) records = records.filter(record => String(record.createdAt || "") >= filters.startAt)
    if (filters.endAt) records = records.filter(record => String(record.createdAt || "") <= filters.endAt)
    return records.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))
  }
  const where = []
  const params = {}
  if (filters.salesAgentId) {
    where.push("sales_agent_id = :salesAgentId")
    params.salesAgentId = filters.salesAgentId
  }
  if (filters.storeId) {
    where.push("store_id = :storeId")
    params.storeId = filters.storeId
  }
  if (filters.orderId) {
    where.push("order_id = :orderId")
    params.orderId = filters.orderId
  }
  if (filters.status) {
    if (filters.status === "chargeback") where.push("(type = 'chargeback' OR amount < 0)")
    else {
      where.push("status = :status")
      params.status = filters.status
    }
  }
  if (filters.type) {
    where.push("type = :type")
    params.type = filters.type
  }
  if (filters.startAt) {
    where.push("created_at >= :startAt")
    params.startAt = filters.startAt
  }
  if (filters.endAt) {
    where.push("created_at <= :endAt")
    params.endAt = filters.endAt
  }
  const rows = await query(`SELECT * FROM sales_agent_commissions ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC`, params)
  return rows.map((row, index) => normalizeSalesAgentCommission(row, index))
}

async function saveSalesAgentCommissions(records = []) {
  const list = (Array.isArray(records) ? records : []).map(normalizeSalesAgentCommission)
  if (!pool) {
    writeJsonFile(salesAgentCommissionsFile, list)
    return list
  }
  for (const record of list) {
    await query(
      `INSERT INTO sales_agent_commissions (id, business_key, sales_agent_id, store_id, order_id, order_no, order_amount, commission_rate, commission_amount, amount, type, status, created_at, settled_at, settled_by, settle_note, cancel_reason, batch_id, related_record_id, remark)
       VALUES (:id, :businessKey, :salesAgentId, :storeId, :orderId, :orderNo, :orderAmount, :commissionRate, :commissionAmount, :amount, :type, :status, :createdAt, :settledAt, :settledBy, :settleNote, :cancelReason, :batchId, :relatedRecordId, :remark)
       ON DUPLICATE KEY UPDATE status = VALUES(status), settled_at = VALUES(settled_at), settled_by = VALUES(settled_by), settle_note = VALUES(settle_note), cancel_reason = VALUES(cancel_reason), batch_id = VALUES(batch_id), related_record_id = VALUES(related_record_id), remark = VALUES(remark), amount = VALUES(amount), commission_amount = VALUES(commission_amount)`,
      {
        ...record,
        businessKey: salesAgentCommissionBusinessKey(record),
        createdAt: toMysqlDatetime(record.createdAt, nowMysqlDatetime()),
        settledAt: toMysqlDatetime(record.settledAt)
      }
    )
  }
  return list
}

function isSalesAgentChargebackRecord(record = {}) {
  return record.type === "chargeback" || Number(record.amount || 0) < 0 || String(record.id || "").includes("CHARGEBACK")
}

function salesAgentCommissionRate(store = {}, agent = {}) {
  const storeRate = store.salesAgentCommissionRate
  if (storeRate !== "" && storeRate != null && Number(storeRate) > 0) return Number(storeRate)
  return Math.max(0, Number(agent.commissionRate || 0))
}

async function createSalesAgentCommissionForOrder(order, connection = null) {
  if (!isOrderPaidForPickupCredential(order) || isOrderRefunded(order)) return null
  const storeId = order.pickupStoreId || order.referrerStoreId || ""
  if (!storeId) return null
  const store = await getPartnerStore(storeId)
  if (!store?.salesAgentId) return null
  const agent = await getSalesAgent(store.salesAgentId)
  if (!agent || agent.status !== "active") return null
  const rate = salesAgentCommissionRate(store, agent)
  if (!(rate > 0)) return null
  const now = formatDateTime(new Date())
  const amount = money(Number(order.amount || 0) * rate / 100)
  if (!(Number(amount) > 0)) return null
  const record = normalizeSalesAgentCommission({
    id: `SAC${order.id}${agent.id}`.replace(/[^\w-]/g, "").slice(0, 60),
    salesAgentId: agent.id,
    storeId: store.id,
    orderId: order.id,
    orderNo: order.id,
    orderAmount: order.amount,
    commissionRate: rate,
    commissionAmount: amount,
    amount,
    type: "sales_agent_commission",
    status: order.storeSettlementStatus || "pending_confirm",
    remark: `业务员佣金：${store.name || store.id}`,
    createdAt: now
  }, 0)
  if (pool) {
    await insertSalesAgentCommission(record, connection)
    if (connection) return record
    const rows = await query(
      `SELECT * FROM sales_agent_commissions
       WHERE sales_agent_id=:salesAgentId AND store_id=:storeId
         AND order_id=:orderId AND type='sales_agent_commission'
       LIMIT 1`,
      { salesAgentId: agent.id, storeId: store.id, orderId: order.id }
    )
    return rows[0] ? normalizeSalesAgentCommission({
      ...rows[0],
      salesAgentId: rows[0].sales_agent_id,
      storeId: rows[0].store_id,
      orderId: rows[0].order_id,
      orderNo: rows[0].order_no,
      orderAmount: rows[0].order_amount,
      commissionRate: rows[0].commission_rate,
      commissionAmount: rows[0].commission_amount,
      createdAt: rows[0].created_at
    }, 0) : record
  }
  const records = await getSalesAgentCommissions()
  const exists = records.find(item =>
    item.orderId === order.id &&
    item.salesAgentId === agent.id &&
    item.storeId === store.id &&
    item.type === "sales_agent_commission"
  )
  if (exists) return exists
  records.unshift(record)
  await saveSalesAgentCommissions(records)
  return record
}

async function rollbackSalesAgentCommissionsForOrder(orderId) {
  if (pool) {
    const connection = await pool.getConnection()
    try {
      await connection.beginTransaction()
      const [records] = await connection.query(
        `SELECT * FROM sales_agent_commissions
         WHERE order_id=:orderId AND type='sales_agent_commission'
         FOR UPDATE`,
        { orderId }
      )
      for (const record of records) {
        if (record.status === "settled") {
          const [reversedRows] = await connection.query(
            `SELECT COALESCE(SUM(ABS(amount)),0) AS reversed_amount
             FROM sales_agent_commissions
             WHERE related_record_id=:recordId AND amount<0`,
            { recordId: record.id }
          )
          const originalCents = Math.round(Math.abs(Number(record.amount || 0)) * 100)
          const reversedCents = Math.round(Number(reversedRows[0]?.reversed_amount || 0) * 100)
          const deltaCents = Math.max(0, originalCents - reversedCents)
          if (deltaCents) {
            await insertSalesAgentCommission({
              id: `SAC${orderId}CHARGEBACK${crypto.createHash("md5").update(record.id).digest("hex").slice(0, 10)}`,
              businessKey: `sales-reversal:${record.id}:full-refund`,
              salesAgentId: record.sales_agent_id,
              storeId: record.store_id,
              orderId,
              orderNo: record.order_no || orderId,
              orderAmount: record.order_amount,
              commissionRate: record.commission_rate,
              commissionAmount: centsToYuan(-deltaCents),
              amount: centsToYuan(-deltaCents),
              type: "chargeback",
              status: "unsettled",
              batchId: `refund-chargeback:${record.id}`,
              relatedRecordId: record.id,
              remark: `订单退款冲正，关联原订单号：${record.order_no || orderId}`
            }, connection)
          }
        } else {
          const [settledReversals] = await connection.query(
            `SELECT COALESCE(SUM(ABS(amount)),0) AS settled_reversal_amount
             FROM sales_agent_commissions
             WHERE related_record_id=:recordId
               AND amount<0
               AND status='settled'`,
            { recordId: record.id }
          )
          await connection.query(
            `UPDATE sales_agent_commissions
             SET status='cancelled',
                 cancel_reason=COALESCE(NULLIF(cancel_reason,''),'整单退款，原部分退款冲减不再单独生效')
             WHERE related_record_id=:recordId
               AND amount<0
               AND status IN ('pending_confirm','unsettled')`,
            { recordId: record.id }
          )
          const settledReversalCents = Math.round(Number(settledReversals[0]?.settled_reversal_amount || 0) * 100)
          if (settledReversalCents) {
            await insertSalesAgentCommission({
              id: `SAC${orderId}OFFSET${crypto.createHash("md5").update(record.id).digest("hex").slice(0, 10)}`,
              businessKey: `sales-refund-offset:${record.id}:full-refund`,
              salesAgentId: record.sales_agent_id,
              storeId: record.store_id,
              orderId,
              orderNo: record.order_no || orderId,
              orderAmount: record.order_amount,
              commissionRate: record.commission_rate,
              commissionAmount: centsToYuan(settledReversalCents),
              amount: centsToYuan(settledReversalCents),
              type: "adjustment",
              status: "unsettled",
              batchId: `refund-offset:${record.id}`,
              relatedRecordId: record.id,
              remark: "整单退款取消未结算佣金，返还此前已结算的部分退款冲减"
            }, connection)
          }
          await connection.query(
            `UPDATE sales_agent_commissions
             SET status='cancelled',
                 cancel_reason=COALESCE(NULLIF(cancel_reason,''),'订单退款成功，业务员佣金失效'),
                 remark=CONCAT(COALESCE(remark,''),'；订单退款成功，佣金失效')
             WHERE id=:id AND status IN ('pending_confirm','unsettled')`,
            { id: record.id }
          )
        }
      }
      await connection.commit()
      return await getSalesAgentCommissions({ orderId })
    } catch (error) {
      await connection.rollback().catch(() => {})
      throw error
    } finally {
      connection.release()
    }
  }
  const records = await getSalesAgentCommissions()
  let changed = false
  const now = formatDateTime(new Date())
  const hasChargebackFor = record => records.some(item =>
    isSalesAgentChargebackRecord(item) &&
    item.relatedRecordId === record.id
  )
  for (const record of records) {
    if (record.orderId !== orderId || isSalesAgentChargebackRecord(record)) continue
    if (record.status === "settled") {
      if (!hasChargebackFor(record)) {
        records.unshift(normalizeSalesAgentCommission({
          id: `SAC${orderId}CHARGEBACK${crypto.createHash("md5").update(record.id).digest("hex").slice(0, 10)}`,
          salesAgentId: record.salesAgentId,
          storeId: record.storeId,
          orderId,
          orderNo: record.orderNo || orderId,
          orderAmount: record.orderAmount,
          commissionRate: record.commissionRate,
          commissionAmount: money(-Math.abs(Number(record.amount || 0))),
          amount: money(-Math.abs(Number(record.amount || 0))),
          type: "chargeback",
          status: "unsettled",
          relatedRecordId: record.id,
          remark: `订单退款冲正，关联原订单号：${record.orderNo || orderId}`,
          batchId: `refund-chargeback:${record.id}`,
          createdAt: now
        }, records.length))
        changed = true
      }
      continue
    }
    if (record.status !== "cancelled") {
      record.status = "cancelled"
      record.cancelReason = record.cancelReason || "订单退款成功，业务员佣金失效"
      record.remark = `${record.remark || ""}；订单退款成功，佣金失效`.trim()
      changed = true
    }
  }
  if (changed) await saveSalesAgentCommissions(records)
  return records
}

async function confirmSalesAgentCommissions(orderId) {
  const order = (await getOrders()).find(item => item.id === orderId)
  if (!order || !isOrderRewardConfirmed(order) || isOrderRefunded(order)) return { changed: false }
  if (pool) {
    const result = await query(
      `UPDATE sales_agent_commissions
       SET status='unsettled',
           remark=COALESCE(NULLIF(remark,''),'订单已完成，业务员佣金可结算')
       WHERE order_id=:orderId AND type='sales_agent_commission' AND status='pending_confirm'`,
      { orderId }
    )
    return { changed: Number(result.affectedRows || 0) > 0 }
  }
  const records = await getSalesAgentCommissions()
  let changed = false
  const now = formatDateTime(new Date())
  for (const record of records) {
    if (record.orderId !== orderId || isSalesAgentChargebackRecord(record)) continue
    if (record.status === "pending_confirm") {
      record.status = "unsettled"
      record.remark = record.remark || "订单已完成，业务员佣金可结算"
      record.createdAt = record.createdAt || now
      changed = true
    }
  }
  if (changed) await saveSalesAgentCommissions(records)
  return { changed }
}

async function settleSalesAgentCommissionRecords(ids, options = {}) {
  const recordIds = [...new Set((ids || []).map(String).filter(Boolean))]
  if (!recordIds.length) return { count: 0 }
  const connection = await pool.getConnection()
  try {
    await connection.beginTransaction()
    const placeholders = recordIds.map((_, index) => `:id${index}`).join(",")
    const params = Object.fromEntries(recordIds.map((id, index) => [`id${index}`, id]))
    const [locked] = await connection.query(
      `SELECT id FROM sales_agent_commissions
       WHERE id IN (${placeholders})
         AND status IN ('unsettled','chargeback')
       FOR UPDATE`,
      params
    )
    const claimIds = locked.map(row => row.id)
    if (!claimIds.length) {
      await connection.commit()
      return { count: 0 }
    }
    const claimPlaceholders = claimIds.map((_, index) => `:claim${index}`).join(",")
    const updateParams = {
      ...Object.fromEntries(claimIds.map((id, index) => [`claim${index}`, id])),
      note: String(options.note || "").slice(0, 500),
      batchId: String(options.batchId || "").slice(0, 80)
    }
    const [result] = await connection.query(
      `UPDATE sales_agent_commissions
       SET status='settled', settled_at=NOW(), settled_by='admin',
           settle_note=:note, batch_id=:batchId
       WHERE id IN (${claimPlaceholders})
         AND status IN ('unsettled','chargeback')`,
      updateParams
    )
    await connection.commit()
    return { count: Number(result.affectedRows || 0) }
  } catch (error) {
    await connection.rollback().catch(() => {})
    throw error
  } finally {
    connection.release()
  }
}

function salesAgentCommissionBusinessKey(record = {}) {
  if (record.businessKey || record.business_key) return String(record.businessKey || record.business_key)
  if (record.relatedRecordId || record.related_record_id) {
    return `sales-reversal:${record.relatedRecordId || record.related_record_id}:${record.batchId || record.batch_id || record.id}`
  }
  if (record.orderId && record.salesAgentId && record.storeId && record.type === "sales_agent_commission") {
    return `sales:${record.orderId}:${record.storeId}:${record.salesAgentId}`
  }
  return `sales-manual:${record.id}`
}

async function insertSalesAgentCommission(record, connection = null) {
  const normalized = normalizeSalesAgentCommission(record, 0)
  const params = {
    ...normalized,
    businessKey: salesAgentCommissionBusinessKey(normalized),
    createdAt: toMysqlDatetime(normalized.createdAt, nowMysqlDatetime()),
    settledAt: toMysqlDatetime(normalized.settledAt)
  }
  const sql =
    `INSERT IGNORE INTO sales_agent_commissions
      (id, business_key, sales_agent_id, store_id, order_id, order_no, order_amount, commission_rate,
       commission_amount, amount, type, status, created_at, settled_at, settled_by,
       settle_note, cancel_reason, batch_id, related_record_id, remark)
     VALUES
      (:id, :businessKey, :salesAgentId, :storeId, :orderId, :orderNo, :orderAmount, :commissionRate,
       :commissionAmount, :amount, :type, :status, :createdAt, :settledAt, :settledBy,
       :settleNote, :cancelReason, :batchId, :relatedRecordId, :remark)`
  const result = connection
    ? (await connection.query(sql, params))[0]
    : await query(sql, params)
  return Number(result.affectedRows || 0) === 1
}

async function getSalesAgentSummary(filters = {}) {
  const [agents, stores, orders, records] = await Promise.all([
    getSalesAgents(),
    getPartnerStores(),
    getOrders(),
    getSalesAgentCommissions(filters)
  ])
  const orderLookup = buildOrderLookup(orders)
  const decoratedRecords = records.map(record => decorateSettlementRecord(record, orderLookup))
  const summary = buildSettlementSummary(decoratedRecords.filter(record => record.status !== "cancelled"), orderLookup)
  return {
    agents,
    stores,
    orders,
    records: decoratedRecords.map(record => ({
      ...record,
      typeText: salesCommissionTypeText(record.type),
      statusText: settlementStatusText(record.effectiveStatus || record.status),
      createdAtText: formatChinaDatetime(record.createdAt),
      settledAtText: formatChinaDatetime(record.settledAt)
    })),
    summary
  }
}

async function saveProducts(products) {
  const list = products.map(normalizeProduct).sort((a, b) => Number(a.sortOrder || 999) - Number(b.sortOrder || 999))
  const rewardList = list.map(product => ({
    id: product.id,
    productId: product.id,
    productName: product.name,
    firstReward: product.rewardEnabled === "false" ? "0" : product.firstReward,
    secondReward: product.rewardEnabled === "false" ? "0" : product.secondReward
  }))
  if (!pool) {
    const home = await getHome()
    home.products = list
    writeJsonFile(homeFile, home)
    writeJsonFile(rewardRulesFile, rewardList.map(normalizeRewardRule))
    return list
  }
  const connection = await pool.getConnection()
  try {
    await connection.beginTransaction()
    const [currentRows] = await connection.query(
      "SELECT id, stock, stock_mode, inventory_version FROM products FOR UPDATE"
    )
    const currentById = new Map(currentRows.map(row => [String(row.id), row]))
    for (let index = 0; index < list.length; index += 1) {
      const product = list[index]
      const current = currentById.get(String(product.id))
      if (current) {
        const stockChanged = Number(product.stock || 0) !== Number(current.stock || 0) ||
          normalizeInventoryMode(product) !== normalizeInventoryMode({ stockMode: current.stock_mode })
        if (stockChanged && Number(product.inventoryVersion) !== Number(current.inventory_version || 0)) {
          const conflict = new Error(`商品“${product.name}”库存已发生变化，请刷新后重试`)
          conflict.statusCode = 409
          throw conflict
        }
        product.inventoryVersion = Number(current.inventory_version || 0) + (stockChanged ? 1 : 0)
      } else {
        product.inventoryVersion = 0
      }
      await connection.query(
        `INSERT INTO products
          (id, name, intro, price, cost_price, badge, cover, image_url, gallery_images, video_url,
           detail_images, detail_text, product_type, categories, status, stock, stock_mode, is_hot,
           promotion_hot, ai_preview_enabled, ai_preview_type, reward_enabled, first_reward,
           second_reward, sort_order, model_candidate_id, model_source_url, model_author_name,
           model_authorization_status, model_authorization_note, inventory_version)
         VALUES
          (:id, :name, :intro, :price, :costPrice, :badge, :cover, :imageUrl, :galleryImagesJson,
           :videoUrl, :detailImagesJson, :detailText, :productType, :categoriesJson, :status, :stock,
           :stockMode, :isHot, :promotionHot, :aiPreviewEnabled, :aiPreviewType, :rewardEnabled,
           :firstReward, :secondReward, :sortOrder, :modelCandidateId, :modelSourceUrl,
           :modelAuthorName, :modelAuthorizationStatus, :modelAuthorizationNote, :inventoryVersion)
         ON DUPLICATE KEY UPDATE
           name=VALUES(name), intro=VALUES(intro), price=VALUES(price), cost_price=VALUES(cost_price),
           badge=VALUES(badge), cover=VALUES(cover), image_url=VALUES(image_url),
           gallery_images=VALUES(gallery_images), video_url=VALUES(video_url),
           detail_images=VALUES(detail_images), detail_text=VALUES(detail_text),
           product_type=VALUES(product_type), categories=VALUES(categories), status=VALUES(status),
           stock=VALUES(stock), stock_mode=VALUES(stock_mode), is_hot=VALUES(is_hot),
           promotion_hot=VALUES(promotion_hot), ai_preview_enabled=VALUES(ai_preview_enabled),
           ai_preview_type=VALUES(ai_preview_type), reward_enabled=VALUES(reward_enabled),
           first_reward=VALUES(first_reward), second_reward=VALUES(second_reward),
           sort_order=VALUES(sort_order), model_candidate_id=VALUES(model_candidate_id),
           model_source_url=VALUES(model_source_url), model_author_name=VALUES(model_author_name),
           model_authorization_status=VALUES(model_authorization_status),
           model_authorization_note=VALUES(model_authorization_note),
           inventory_version=VALUES(inventory_version)`,
        {
          ...product,
          galleryImagesJson: JSON.stringify(product.galleryImages || []),
          detailImagesJson: JSON.stringify(product.detailImages || []),
          categoriesJson: JSON.stringify(product.categories || []),
          sortOrder: Number(product.sortOrder || index)
        }
      )
    }
    const retainedIds = list.map(product => product.id)
    if (retainedIds.length) {
      await connection.query("DELETE FROM products WHERE id NOT IN (?)", [retainedIds])
    } else {
      await connection.query("DELETE FROM products")
    }
    await connection.commit()
  } catch (error) {
    await connection.rollback().catch(() => {})
    throw error
  } finally {
    connection.release()
  }
  const home = await getHome()
  home.products = list
  await saveHome(home)
  await saveRewardRules(rewardList)
  return list
}

async function migrateProductCategoriesToCanonical() {
  const products = await getProducts()
  const settings = await getSettings()
  updateActiveCategoryTree(settings.categoryCatalog)
  let changed = false
  const next = products.map(product => {
    const categories = normalizeProductCategories(product.categories, product)
    if (JSON.stringify(categories) !== JSON.stringify(product.categories || [])) changed = true
    return { ...product, categories }
  })
  if (changed) await saveProducts(next)
  await saveSettings({ ...settings, categoryCatalog: settings.categoryCatalog })
  return { changed, count: next.length }
}

async function getOrders(filters = {}) {
  const identity = requestIdentity(filters)
  const hasIdentity = hasRequestIdentity(identity)
  if (!pool) {
    const stores = readJsonFile(partnerStoresFile, []).map(normalizePartnerStore)
    const products = await getProducts()
    let orders = readJsonFile(ordersFile, []).map((order, index) => {
      const normalized = normalizeOrder(order, index)
      return hydrateOrderProductImages({
        ...normalized,
        pickupStore: storePublicView(stores.find(store => store.id === normalized.pickupStoreId))
      }, products)
    })
    if (filters.publicOnly && !hasIdentity) return []
    if (filters.publicOnly) {
      orders = orders.filter(order => {
        if (identity.userId && order.userId === identity.userId) return true
        if (order.userId) return false
        if (identity.openid && order.openid === identity.openid) return true
        if (identity.phone && order.phone === identity.phone) return true
        return false
      })
    }
    if (filters.status) {
      orders = filters.status === "售后中"
        ? orders.filter(order => isActiveAfterSalesStatus(order.afterSalesStatus || order.refundStatus))
        : orders.filter(order => order.status === filters.status)
    }
    if (filters.keyword) {
      const keyword = String(filters.keyword).toLowerCase()
      orders = orders.filter(order => [order.id, order.customerName, order.phone, order.productName].some(value => String(value || "").toLowerCase().includes(keyword)))
    }
    const result = orders.reverse()
    return filters.publicOnly ? result.map(publicOrderView) : result
  }
  const where = []
  const params = {}
  if (filters.publicOnly && !hasIdentity) return []
  if (filters.publicOnly && identity.userId && identity.phone) {
    await query(
      `UPDATE orders
       SET
         openid = CASE WHEN (openid IS NULL OR openid = '') THEN :openid ELSE openid END,
         user_id = CASE WHEN (user_id IS NULL OR user_id = '') THEN :userId ELSE user_id END
       WHERE phone = :phone
         AND (user_id IS NULL OR user_id = '' OR user_id = :userId)
         AND (:openid = '' OR openid IS NULL OR openid = '' OR openid = :openid)
      `,
      {
        phone: identity.phone,
        openid: identity.openid || "",
        userId: identity.userId
      }
    )
  }
  if (filters.publicOnly) {
    if (!identity.userId) return []
    params.userId = identity.userId
    params.legacyPhone = identity.phone || ""
    params.legacyOpenid = identity.openid || ""
    where.push(`(
      user_id=:userId
      OR (
        (user_id IS NULL OR user_id='')
        AND (
          (:legacyPhone<>'' AND phone=:legacyPhone)
          OR (:legacyOpenid<>'' AND openid=:legacyOpenid)
        )
      )
    )`)
  }
  if (filters.status) {
    if (filters.status === "售后中") {
      where.push("after_sales_status IN ('requested','refund_pending','remake','reship')")
    } else {
      where.push("status = :status")
      params.status = filters.status
    }
  }
  if (filters.keyword) {
    where.push("(id LIKE :keyword OR customer_name LIKE :keyword OR phone LIKE :keyword OR product_name LIKE :keyword)")
    params.keyword = `%${filters.keyword}%`
  }
  const rows = await query(`SELECT * FROM orders ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC`, params)
  const [stores, products, itemRows, refundRows] = await Promise.all([
    getPartnerStores(),
    getProducts(),
    rows.length
      ? query(
        `SELECT oi.*,
                COALESCE(SUM(CASE WHEN rr.status='SUCCESS' AND ri.status='SUCCESS'
                                  THEN ri.refund_quantity ELSE 0 END),0) AS refunded_quantity,
                COALESCE(SUM(CASE WHEN rr.status='SUCCESS' AND ri.status='SUCCESS'
                                  THEN ri.product_refund_cents + ri.discount_refund_cents ELSE 0 END),0) AS refunded_amount_cents
         FROM order_items oi
         LEFT JOIN refund_items ri ON ri.order_item_id=oi.id
         LEFT JOIN refund_records rr ON rr.id=ri.refund_record_id
         WHERE oi.order_id IN (${rows.map((_, index) => `:orderItemOrder${index}`).join(",")})
         GROUP BY oi.id
         ORDER BY oi.created_at ASC, oi.id ASC`,
        Object.fromEntries(rows.map((row, index) => [`orderItemOrder${index}`, row.id]))
      )
      : [],
    rows.length
      ? query(
        `SELECT * FROM refund_records
         WHERE order_id IN (${rows.map((_, index) => `:refundOrder${index}`).join(",")})
         ORDER BY requested_at DESC, id DESC`,
        Object.fromEntries(rows.map((row, index) => [`refundOrder${index}`, row.id]))
      )
      : []
  ])
  const itemsByOrder = new Map()
  for (const row of itemRows) {
    const item = {
      id: row.id,
      orderItemId: row.id,
      productId: row.product_id,
      skuId: row.sku_id || "",
      productName: row.product_name,
      skuName: row.sku_name || "",
      imageUrl: publicAssetUrl(row.image_url),
      unitPriceCents: Number(row.unit_price_cents || 0),
      quantity: Number(row.quantity || 0),
      productDiscountCents: Number(row.product_discount_cents || 0),
      orderDiscountCents: Number(row.order_discount_cents || 0),
      paidAmountCents: Number(row.paid_amount_cents || 0),
      refundedQuantity: Number(row.refunded_quantity || 0),
      refundedAmountCents: Number(row.refunded_amount_cents || 0),
      remainingRefundQuantity: Math.max(0, Number(row.quantity || 0) - Number(row.refunded_quantity || 0)),
      remainingRefundAmountCents: Math.max(0, Number(row.paid_amount_cents || 0) - Number(row.refunded_amount_cents || 0)),
      inventoryMode: row.inventory_mode || "",
      customization: parseJsonValue(row.customization_json, {})
    }
    if (!itemsByOrder.has(row.order_id)) itemsByOrder.set(row.order_id, [])
    itemsByOrder.get(row.order_id).push(item)
  }
  const refundsByOrder = new Map()
  for (const row of refundRows) {
    const refund = {
      id: row.id,
      refundNo: row.refund_no,
      requestedAmountCents: Number(row.requested_amount_cents || 0),
      successAmountCents: Number(row.success_amount_cents || 0),
      status: row.status,
      requestedAt: formatChinaDatetime(row.requested_at),
      successAt: formatChinaDatetime(row.success_at)
    }
    if (!refundsByOrder.has(row.order_id)) refundsByOrder.set(row.order_id, [])
    refundsByOrder.get(row.order_id).push(refund)
  }
  const orders = rows.map(row => hydrateOrderProductImages(normalizeOrder({
    id: row.id,
    productId: row.product_id || "",
    customerName: row.customer_name,
    phone: row.phone || "",
    productName: row.product_name || "",
    amount: String(row.amount || "0"),
    status: row.status || "待发货",
    paymentStatus: row.payment_status || "待支付",
    paymentExpiresAt: formatChinaDatetime(row.payment_expires_at),
    stockReservedAt: formatChinaDatetime(row.stock_reserved_at),
    stockReleasedAt: formatChinaDatetime(row.stock_released_at),
    transactionId: row.transaction_id || "",
    openid: row.openid || "",
    userId: row.user_id || "",
    userToken: row.user_token || "",
    address: row.address || "",
    customRequest: row.custom_request || "",
    originalImageUrl: row.original_image_url || "",
    originalImageUrls: normalizeMediaList(parseJsonValue(row.original_image_urls, row.original_image_url || [])),
    aiPreviewUrl: row.ai_preview_url || "",
    finalDesignUrl: row.final_design_url || "",
    category: row.category || "",
    isCustomOrder: String(row.is_custom_order || "false") === "true" ? "true" : "false",
    remark: row.remark || "",
    inviterCode: row.inviter_code || "",
    shippingCompany: row.shipping_company || "",
    trackingNumber: row.tracking_number || "",
    shippedAt: formatChinaDatetime(row.shipped_at),
    refundType: row.refund_type || "",
    refundStatus: row.refund_status || "",
    refundReason: row.refund_reason || "",
    refundAmount: row.refund_amount == null ? "" : String(row.refund_amount || ""),
    refundRemark: row.refund_remark || "",
    refundImageUrl: row.refund_image_url || "",
    refundRejectReason: row.refund_reject_reason || row.after_sales_reject_reason || "",
    afterSalesRejectReason: row.after_sales_reject_reason || row.refund_reject_reason || "",
    after_sales_reject_reason: row.after_sales_reject_reason || row.refund_reject_reason || "",
    refundReviewedAt: formatChinaDatetime(row.refund_reviewed_at),
    afterSalesStatus: normalizeAfterSalesStatus(row.after_sales_status || row.refund_status),
    after_sales_status: normalizeAfterSalesStatus(row.after_sales_status || row.refund_status),
    afterSalesText: afterSalesStatusText(row.after_sales_status || row.refund_status),
    afterSalesType: row.after_sales_type || row.refund_type || "",
    after_sales_type: row.after_sales_type || row.refund_type || "",
    afterSalesReason: row.after_sales_reason || row.refund_reason || "",
    after_sales_reason: row.after_sales_reason || row.refund_reason || "",
    afterSalesDesc: row.after_sales_desc || row.refund_remark || "",
    after_sales_desc: row.after_sales_desc || row.refund_remark || "",
    afterSalesImages: normalizeMediaList(parseJsonValue(row.after_sales_images, row.refund_image_url || [])),
    after_sales_images: normalizeMediaList(parseJsonValue(row.after_sales_images, row.refund_image_url || [])),
    afterSalesRequestedAt: formatChinaDatetime(row.after_sales_requested_at),
    after_sales_requested_at: formatChinaDatetime(row.after_sales_requested_at),
    afterSalesHandledAt: formatChinaDatetime(row.after_sales_handled_at),
    after_sales_handled_at: formatChinaDatetime(row.after_sales_handled_at),
    afterSalesApplyCount: Number(row.after_sales_apply_count || 0),
    after_sales_apply_count: Number(row.after_sales_apply_count || 0),
    refund_status: row.refund_status || "",
    refundNo: row.refund_no || "",
    refundId: row.refund_id || "",
    refundSuccessAt: formatChinaDatetime(row.refund_success_at),
    createdAt: formatChinaDatetime(row.created_at),
    createdAtText: formatChinaDatetime(row.created_at),
    paidAt: formatChinaDatetime(row.paid_at),
    paidAtText: formatChinaDatetime(row.paid_at),
    completedAt: formatChinaDatetime(row.completed_at),
    refundAt: formatChinaDatetime(row.refund_at),
    deliveryType: row.delivery_type || "delivery",
    pickupStoreId: row.pickup_store_id || "",
    pickupStore: storePublicView(stores.find(store => store.id === row.pickup_store_id)),
    pickupCode: row.pickup_code || "",
    pickupQrCodeUrl: row.pickup_qrcode_url || "",
    pickupStatus: row.pickup_status || "none",
    notifyStatus: row.notify_status || "",
    notifiedAt: formatChinaDatetime(row.notified_at),
    notifiedAtText: formatChinaDatetime(row.notified_at),
    arrivedStoreAt: formatChinaDatetime(row.arrived_store_at),
    arrivedStoreAtText: formatChinaDatetime(row.arrived_store_at),
    pickedUpAt: formatChinaDatetime(row.picked_up_at),
    pickedUpAtText: formatChinaDatetime(row.picked_up_at),
    pickupVerifiedAt: formatChinaDatetime(row.pickup_verified_at),
    pickupVerifiedAtText: formatChinaDatetime(row.pickup_verified_at),
    pickupVerifiedBy: row.pickup_verified_by || "",
    forcePickupVerifiedAt: formatChinaDatetime(row.force_pickup_verified_at),
    forcePickupVerifiedBy: row.force_pickup_verified_by || "",
    forcePickupReason: row.force_pickup_reason || "",
    persistedFulfillmentStatus: row.fulfillment_status || "",
    wechatFulfillmentStatus: row.wechat_fulfillment_status || "",
    wechatFulfillmentSyncedAt: formatChinaDatetime(row.wechat_fulfillment_synced_at),
    userLatitude: row.user_latitude,
    userLongitude: row.user_longitude,
    pickupDistance: row.pickup_distance,
    referrerStoreId: row.referrer_store_id || "",
    storeAttributionId: row.store_attribution_id || "",
    sourceType: row.source_type || "",
    sourceStoreId: row.source_store_id || "",
    sourceStoreCode: row.source_store_code || "",
    storeOrderType: row.store_order_type || "",
    isStoreMemberOrder: row.is_store_member_order,
    storeOperatorUserId: row.store_operator_user_id || "",
    storeOperatorPhone: row.store_operator_phone || "",
    storeOperatorOpenid: row.store_operator_openid || "",
    storeOperatorRole: row.store_operator_role || "",
    storeOperatorName: row.store_operator_name || "",
    referrerUserId: row.referrer_user_id || "",
    parentReferrerUserId: row.parent_referrer_user_id || "",
    supplierStoreId: row.supplier_store_id || "",
    referralCommission: row.referral_commission,
    pickupServiceFee: row.pickup_service_fee,
    supplierSettlementAmount: row.supplier_settlement_amount,
    customCommissionAmount: row.custom_commission_amount,
    storeSettlementStatus: row.store_settlement_status || "pending_confirm",
    items: itemsByOrder.get(row.id) || [],
    refundRecords: refundsByOrder.get(row.id) || []
  }, 0), products))
  return filters.publicOnly ? orders.map(publicOrderView) : orders
}

async function saveOrders(orders) {
  const list = orders.map(normalizeOrder)
  if (!pool) {
    const existing = readJsonFile(ordersFile, []).map(normalizeOrder)
    const merged = [...existing]
    const invalidateOrderIds = []
    const confirmOrderIds = []
    for (const order of list) {
      const index = merged.findIndex(item => item.id === order.id)
      if (index >= 0) {
        const previous = merged[index]
        const next = { ...previous, ...order, userToken: previous.userToken || "" }
        if (next.status === "已完成" && previous.status !== "已完成") next.completedAt = formatDateTime(new Date())
        if (next.status === "已退款" && previous.status !== "已退款") next.refundAt = formatDateTime(new Date())
        if (shouldInvalidateStoreSettlementForOrderChange(previous, next)) invalidateOrderIds.push(next.id)
        if (isOrderRewardConfirmed(next)) confirmOrderIds.push(next.id)
        merged[index] = next
      }
      else {
        if (isOrderRewardConfirmed(order)) confirmOrderIds.push(order.id)
        merged.push({ ...order, userToken: "" })
      }
    }
    writeJsonFile(ordersFile, merged)
    await processRewardState()
    for (const orderId of [...new Set(invalidateOrderIds)]) {
      await invalidateStoreSettlementRecordsForOrder(orderId)
    }
    for (const orderId of [...new Set(confirmOrderIds)]) {
      await confirmOrderRewards(orderId)
    }
    return list
  }
  const previousOrders = await getOrders()
  const invalidateOrderIds = []
  const confirmOrderIds = []
  const releaseInventoryOrders = []
  for (const order of list) {
    if (isPickupOrder(order) && order.pickupCode) await ensurePickupCodeClaim(order)
    const previousOrder = previousOrders.find(item => item.id === order.id)
    if (previousOrder && shouldInvalidateStoreSettlementForOrderChange(previousOrder, order)) invalidateOrderIds.push(order.id)
    if (previousOrder && !canReleaseOrderInventory(previousOrder) && canReleaseOrderInventory(order)) {
      releaseInventoryOrders.push({ id: order.id, status: order.status })
    }
    if (isOrderRewardConfirmed(order)) confirmOrderIds.push(order.id)
    const orderParams = {
      ...mysqlOrderParams(order),
      originalImageUrlsJson: JSON.stringify(order.originalImageUrls || []),
      afterSalesImagesJson: JSON.stringify(order.afterSalesImages || []),
      userLatitude: order.userLatitude === "" ? null : order.userLatitude,
      userLongitude: order.userLongitude === "" ? null : order.userLongitude,
      pickupDistance: order.pickupDistance === "" ? null : order.pickupDistance
    }
    await query(
      `INSERT INTO orders (id, product_id, customer_name, phone, product_name, amount, status, payment_status, transaction_id, openid, user_id, address, custom_request, original_image_url, original_image_urls, ai_preview_url, final_design_url, category, is_custom_order, remark, inviter_code, shipping_company, tracking_number, shipped_at, refund_type, refund_status, refund_reason, refund_amount, refund_remark, refund_image_url, refund_reject_reason, refund_reviewed_at, after_sales_status, after_sales_type, after_sales_reason, after_sales_desc, after_sales_images, after_sales_requested_at, after_sales_handled_at, after_sales_reject_reason, after_sales_apply_count, refund_no, refund_id, refund_success_at, created_at, paid_at, completed_at, refund_at, delivery_type, pickup_store_id, pickup_code, pickup_qrcode_url, pickup_status, notify_status, notified_at, arrived_store_at, picked_up_at, pickup_verified_at, pickup_verified_by, force_pickup_verified_at, force_pickup_verified_by, force_pickup_reason, user_latitude, user_longitude, pickup_distance, referrer_store_id, source_type, source_store_id, source_store_code, store_order_type, is_store_member_order, store_operator_user_id, store_operator_phone, store_operator_openid, store_operator_role, store_operator_name, referrer_user_id, parent_referrer_user_id, supplier_store_id, referral_commission, pickup_service_fee, supplier_settlement_amount, custom_commission_amount, store_settlement_status)
       VALUES (:id, :productId, :customerName, :phone, :productName, :amount, :status, :paymentStatus, :transactionId, :openid, :userId, :address, :customRequest, :originalImageUrl, :originalImageUrlsJson, :aiPreviewUrl, :finalDesignUrl, :category, :isCustomOrder, :remark, :inviterCode, :shippingCompany, :trackingNumber, :shippedAt, :refundType, :refundStatus, :refundReason, :refundAmount, :refundRemark, :refundImageUrl, :refundRejectReason, :refundReviewedAt, :afterSalesStatus, :afterSalesType, :afterSalesReason, :afterSalesDesc, :afterSalesImagesJson, :afterSalesRequestedAt, :afterSalesHandledAt, :afterSalesRejectReason, :afterSalesApplyCount, :refundNo, :refundId, :refundSuccessAt, :createdAt, :paidAt, :completedAt, :refundAt, :deliveryType, :pickupStoreId, :pickupCode, :pickupQrCodeUrl, :pickupStatus, :notifyStatus, :notifiedAt, :arrivedStoreAt, :pickedUpAt, :pickupVerifiedAt, :pickupVerifiedBy, :forcePickupVerifiedAt, :forcePickupVerifiedBy, :forcePickupReason, :userLatitude, :userLongitude, :pickupDistance, :referrerStoreId, :sourceType, :sourceStoreId, :sourceStoreCode, :storeOrderType, :isStoreMemberOrder, :storeOperatorUserId, :storeOperatorPhone, :storeOperatorOpenid, :storeOperatorRole, :storeOperatorName, :referrerUserId, :parentReferrerUserId, :supplierStoreId, :referralCommission, :pickupServiceFee, :supplierSettlementAmount, :customCommissionAmount, :storeSettlementStatus)
       ON DUPLICATE KEY UPDATE
       status = VALUES(status),
       payment_status = VALUES(payment_status),
       transaction_id = VALUES(transaction_id),
       openid = VALUES(openid),
       user_id = VALUES(user_id),
       address = VALUES(address),
       custom_request = VALUES(custom_request),
       original_image_url = VALUES(original_image_url),
       original_image_urls = VALUES(original_image_urls),
       ai_preview_url = VALUES(ai_preview_url),
       final_design_url = VALUES(final_design_url),
       category = VALUES(category),
       is_custom_order = VALUES(is_custom_order),
       remark = VALUES(remark),
       inviter_code = VALUES(inviter_code),
       shipping_company = VALUES(shipping_company),
       tracking_number = VALUES(tracking_number),
       shipped_at = VALUES(shipped_at),
       refund_type = VALUES(refund_type),
       refund_status = VALUES(refund_status),
       refund_reason = VALUES(refund_reason),
       refund_amount = VALUES(refund_amount),
       refund_remark = VALUES(refund_remark),
       refund_image_url = VALUES(refund_image_url),
       refund_reject_reason = VALUES(refund_reject_reason),
       refund_reviewed_at = VALUES(refund_reviewed_at),
       after_sales_status = VALUES(after_sales_status),
       after_sales_type = VALUES(after_sales_type),
       after_sales_reason = VALUES(after_sales_reason),
       after_sales_desc = VALUES(after_sales_desc),
       after_sales_images = VALUES(after_sales_images),
       after_sales_requested_at = VALUES(after_sales_requested_at),
       after_sales_handled_at = VALUES(after_sales_handled_at),
       after_sales_reject_reason = VALUES(after_sales_reject_reason),
       after_sales_apply_count = VALUES(after_sales_apply_count),
       refund_no = VALUES(refund_no),
       refund_id = VALUES(refund_id),
       refund_success_at = VALUES(refund_success_at),
       paid_at = VALUES(paid_at),
       completed_at = IF(VALUES(status) = '已完成' AND completed_at IS NULL, NOW(), completed_at),
       refund_at = IF(VALUES(status) = '已退款' AND refund_at IS NULL, NOW(), refund_at),
       delivery_type = VALUES(delivery_type),
       pickup_store_id = VALUES(pickup_store_id),
       pickup_code = VALUES(pickup_code),
       pickup_qrcode_url = VALUES(pickup_qrcode_url),
       pickup_status = VALUES(pickup_status),
       notify_status = VALUES(notify_status),
       notified_at = VALUES(notified_at),
       arrived_store_at = VALUES(arrived_store_at),
       picked_up_at = VALUES(picked_up_at),
       pickup_verified_at = VALUES(pickup_verified_at),
       pickup_verified_by = VALUES(pickup_verified_by),
       force_pickup_verified_at = VALUES(force_pickup_verified_at),
       force_pickup_verified_by = VALUES(force_pickup_verified_by),
       force_pickup_reason = VALUES(force_pickup_reason),
       user_latitude = VALUES(user_latitude),
       user_longitude = VALUES(user_longitude),
       pickup_distance = VALUES(pickup_distance),
       referrer_store_id = VALUES(referrer_store_id),
       source_type = VALUES(source_type),
       source_store_id = VALUES(source_store_id),
       source_store_code = VALUES(source_store_code),
       store_order_type = VALUES(store_order_type),
       is_store_member_order = VALUES(is_store_member_order),
       store_operator_user_id = VALUES(store_operator_user_id),
       store_operator_phone = VALUES(store_operator_phone),
       store_operator_openid = VALUES(store_operator_openid),
       store_operator_role = VALUES(store_operator_role),
       store_operator_name = VALUES(store_operator_name),
       referrer_user_id = VALUES(referrer_user_id),
       parent_referrer_user_id = VALUES(parent_referrer_user_id),
       supplier_store_id = VALUES(supplier_store_id),
       referral_commission = VALUES(referral_commission),
       pickup_service_fee = VALUES(pickup_service_fee),
       supplier_settlement_amount = VALUES(supplier_settlement_amount),
       custom_commission_amount = VALUES(custom_commission_amount),
       store_settlement_status = VALUES(store_settlement_status)`,
      orderParams
    )
  }
  await processRewardState()
  for (const orderId of [...new Set(invalidateOrderIds)]) {
    await invalidateStoreSettlementRecordsForOrder(orderId)
  }
  for (const orderId of [...new Set(confirmOrderIds)]) {
    await confirmOrderRewards(orderId)
  }
  for (const order of [...new Map(releaseInventoryOrders.map(item => [item.id, item])).values()]) {
    const sourceType = ["已取消", "取消", "cancelled", "canceled"].includes(String(order.status || "").trim().toLowerCase())
      ? "user_cancel"
      : ["已关闭", "关闭", "closed", "void", "作废"].includes(String(order.status || "").trim().toLowerCase())
        ? "admin_close"
        : "order_terminal"
    const connection = await pool.getConnection()
    try {
      await connection.beginTransaction()
      await releaseOrderInventory(connection, order.id, {
        reason: "订单取消、关闭或退款",
        sourceType,
        sourceId: order.id,
        releaseRemaining: true
      })
      await connection.commit()
    } catch (error) {
      await connection.rollback().catch(() => {})
      throw error
    } finally {
      connection.release()
    }
  }
  return list
}

async function calculateOrderStoreIncome(data, amount) {
  const referrerStore = await getPartnerStore(data.referrerStoreId || data.referrer_store_id || "")
  const pickupStore = data.deliveryType === "pickup" ? await getPartnerStore(data.pickupStoreId || data.pickup_store_id || "") : null
  const referralCommission = referrerStore
    ? calculateStoreAmount(amount, referrerStore.referralCommissionType, referrerStore.referralCommissionValue)
    : "0.00"
  const pickupServiceFee = pickupStore
    ? calculatePickupServiceFee(amount, pickupStore.pickupFeeType, pickupStore.pickupFeeValue)
    : "0.00"
  return { referrerStore, pickupStore, referralCommission, pickupServiceFee }
}

function isValidReferrerStore(store) {
  return !!store && isStoreEnabled(store) && store.isDisplayEnabled === "true" && store.referralCommissionType !== "none"
}

function parseMsTime(value) {
  if (value == null || value === "") return null
  if (value instanceof Date) {
    const time = value.getTime()
    return Number.isFinite(time) ? time : null
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : null
  const text = String(value || "").trim()
  if (!text) return null
  if (/^\d+$/.test(text)) {
    const time = Number(text)
    return Number.isFinite(time) ? time : null
  }
  const parsed = Date.parse(text)
  return Number.isFinite(parsed) ? parsed : null
}

function isStoreReferrerWindowValid(data = {}) {
  const boundAt = parseMsTime(data.referrerStoreBoundAt || data.storeReferrerBoundAt || data.referrer_store_bound_at)
  const expireAt = parseMsTime(data.referrerStoreExpireAt || data.storeReferrerExpireAt || data.referrer_store_expire_at)
  const now = Date.now()
  if (!boundAt || !expireAt) return false
  if (boundAt > now + 5 * 60 * 1000) return false
  if (expireAt <= now) return false
  if (expireAt - boundAt > STORE_REFERRER_TTL_MS + 5 * 60 * 1000) return false
  if (now - boundAt > STORE_REFERRER_TTL_MS) return false
  return true
}

async function resolveValidReferrerStoreId(storeId, data = {}) {
  if (!storeId) return ""
  const store = await getPartnerStore(storeId || "")
  return isValidReferrerStore(store) ? store.id : ""
}

async function issueStoreAttribution(data = {}, identity = {}) {
  const storeId = String(data.storeId || data.store_id || "").trim()
  const store = await getPartnerStore(storeId)
  if (!isValidReferrerStore(store)) throw httpError(400, "门店推广来源无效")
  const token = issueAttributionToken()
  const tokenHash = hashAttributionToken(token)
  const visitorHash = hashAnonymousVisitor(data.visitorId || data.localUserId || "")
  const userId = String(identity.userId || "").trim()
  if (!userId && !visitorHash) throw httpError(400, "缺少推广访问标识")
  const attributionId = `SRA${Date.now()}${crypto.randomBytes(4).toString("hex").toUpperCase()}`
  const source = safeAttributionSource(data.source || "mini_program_store_code")
  const shareCode = String(data.storeCode || data.shareCode || "").trim().slice(0, 80)
  if (!pool) {
    throw httpError(503, "门店推广归因仅在数据库模式下可用")
  }
  await query(
    `INSERT INTO store_referral_attributions
      (id, token_hash, store_id, user_id, visitor_hash, source, share_code,
       attribution_type, status, created_at, expires_at, updated_at)
     VALUES
      (:id, :tokenHash, :storeId, :userId, :visitorHash, :source, :shareCode,
       'store_external', 'active', NOW(), DATE_ADD(NOW(), INTERVAL 30 DAY), NOW())`,
    {
      id: attributionId,
      tokenHash,
      storeId: store.id,
      userId,
      visitorHash,
      source,
      shareCode
    }
  )
  console.log("[store-attribution-issued]", {
    storeId: store.id,
    authenticated: !!userId,
    hasVisitor: !!visitorHash,
    source
  })
  return {
    attributionToken: token,
    storeId: store.id,
    storeCode: shareCode,
    boundAt: Date.now(),
    expiresAt: Date.now() + ATTRIBUTION_TTL_MS
  }
}

async function resolveTrustedStoreAttribution(data = {}, identity = {}) {
  const requestedStoreId = String(
    data.referrerStoreId || data.sourceStoreId || data.storeId || data.referrer_store_id || ""
  ).trim()
  if (!requestedStoreId) return { storeId: "", attributionId: "", attributionType: "" }
  const store = await getPartnerStore(requestedStoreId)
  if (!isValidReferrerStore(store)) return { storeId: "", attributionId: "", attributionType: "" }

  const members = (await getStoreMembers({ storeId: requestedStoreId }))
    .filter(member => member.status === "active")
  const member = members.find(item =>
    (identity.userId && item.userId && item.userId === identity.userId) ||
    (identity.phone && normalizePhone(item.phone) === normalizePhone(identity.phone)) ||
    (identity.openid && item.openid && item.openid === identity.openid)
  )
  if (member) {
    return {
      storeId: requestedStoreId,
      attributionId: "",
      attributionType: "store_self",
      member
    }
  }

  const token = String(data.storeAttributionToken || data.attributionToken || "").trim()
  if (!pool || !token) {
    console.warn("[store-attribution-rejected]", {
      requestedStore: !!requestedStoreId,
      reason: token ? "database_unavailable" : "missing_server_credential"
    })
    return { storeId: "", attributionId: "", attributionType: "" }
  }
  const tokenHash = hashAttributionToken(token)
  const visitorHash = hashAnonymousVisitor(data.storeAttributionVisitorId || data.visitorId || data.localUserId || "")
  const connection = await pool.getConnection()
  try {
    await connection.beginTransaction()
    const [rows] = await connection.query(
      `SELECT id, store_id, user_id, visitor_hash, status, expires_at
       FROM store_referral_attributions
       WHERE token_hash = :tokenHash
       LIMIT 1
       FOR UPDATE`,
      { tokenHash }
    )
    const attribution = rows[0]
    const valid = attribution &&
      attribution.status === "active" &&
      attribution.store_id === requestedStoreId &&
      new Date(attribution.expires_at).getTime() > Date.now() &&
      (!attribution.user_id || attribution.user_id === identity.userId) &&
      (attribution.user_id || (visitorHash && attribution.visitor_hash === visitorHash))
    if (!valid) {
      await connection.rollback()
      console.warn("[store-attribution-rejected]", {
        requestedStore: !!requestedStoreId,
        reason: !attribution ? "not_found" : "invalid_or_replayed"
      })
      return { storeId: "", attributionId: "", attributionType: "" }
    }
    if (!attribution.user_id && identity.userId) {
      await connection.query(
        `UPDATE store_referral_attributions
         SET user_id = :userId, updated_at = NOW()
         WHERE id = :id AND (user_id IS NULL OR user_id = '')`,
        { id: attribution.id, userId: identity.userId }
      )
    }
    await connection.commit()
    return {
      storeId: requestedStoreId,
      attributionId: attribution.id,
      attributionType: "store_external"
    }
  } catch (error) {
    await connection.rollback().catch(() => {})
    throw error
  } finally {
    connection.release()
  }
}

async function resolveStoreOrderSource(referrerStoreId, data = {}) {
  if (!referrerStoreId) return {
    sourceType: "",
    sourceStoreId: "",
    sourceStoreCode: "",
    storeOrderType: "",
    isStoreMemberOrder: false,
    storeOperatorUserId: "",
    storeOperatorPhone: "",
    storeOperatorOpenid: "",
    storeOperatorRole: "",
    storeOperatorName: ""
  }
  const phone = normalizePhone(data.phone || data.storeOperatorPhone || "")
  const openid = String(data.openid || data.storeOperatorOpenid || "").trim()
  const userId = String(data.userId || data.storeOperatorUserId || "").trim()
  const members = (await getStoreMembers({ storeId: referrerStoreId })).filter(member => member.status === "active")
  let member = members.find(item => phone && normalizePhone(item.phone) === phone)
  if (!member) member = members.find(item => openid && item.openid && item.openid === openid)
  if (!member) member = members.find(item => userId && item.userId && item.userId === userId)
  if (member) {
    console.log("[store-order-source] member order", { storeId: referrerStoreId, role: member.role, phoneTail: member.phone ? member.phone.slice(-4) : "" })
    return {
      sourceType: "store",
      sourceStoreId: referrerStoreId,
      sourceStoreCode: data.sourceStoreCode || data.storeCode || "",
      storeOrderType: "store_self",
      isStoreMemberOrder: true,
      storeOperatorUserId: member.userId || userId || "",
      storeOperatorPhone: member.phone || phone || "",
      storeOperatorOpenid: member.openid || openid || "",
      storeOperatorRole: member.role || "staff",
      storeOperatorName: data.storeOperatorName || ""
    }
  }
  console.log("[store-order-source] external order", { storeId: referrerStoreId, hasPhone: !!phone })
  return {
    sourceType: "store",
    sourceStoreId: referrerStoreId,
    sourceStoreCode: data.sourceStoreCode || data.storeCode || "",
    storeOrderType: "store_external",
    isStoreMemberOrder: false,
    storeOperatorUserId: "",
    storeOperatorPhone: "",
    storeOperatorOpenid: "",
    storeOperatorRole: "",
    storeOperatorName: ""
  }
}

async function resolvePersonalOrderAttribution(phone) {
  const buyerPhone = normalizePhone(phone)
  if (!buyerPhone) return { referrerUserId: "", parentReferrerUserId: "" }
  const relations = await getPromotionRelations()
  const chain = getPersonalReferralChain(buyerPhone, relations)
  if (chain.circular) {
    console.warn("[promotion-cycle-detected]", { phone: buyerPhone, circularAt: chain.circularAt })
  }
  return {
    referrerUserId: chain.directPhone,
    parentReferrerUserId: chain.parentPhone
  }
}

function normalizeStoreSettlementCreationOptions(options = {}) {
  if (options && typeof options.query === "function") {
    return { connection: options, includeReferral: true, includePickup: false }
  }
  return {
    connection: options.connection || null,
    includeReferral: options.includeReferral !== false,
    includePickup: options.includePickup === true
  }
}

async function createStoreSettlementRecordsForOrderMysql(order, options = {}) {
  const { connection, includeReferral, includePickup } = normalizeStoreSettlementCreationOptions(options)
  if (!isOrderPaidForPickupCredential(order) || isOrderRefunded(order)) return []
  const referrerStore = includeReferral ? await getPartnerStore(order.referrerStoreId) : null
  const pickupStore = includePickup && isPickupServiceFeeEligible(order) ? await getPartnerStore(order.pickupStoreId) : null
  const referralAmount = referrerStore && Number(order.referralCommission || 0) <= 0
    ? calculateStoreAmount(order.amount, referrerStore.referralCommissionType, referrerStore.referralCommissionValue)
    : money(order.referralCommission || 0)
  const pickupAmount = pickupStore
    ? calculatePickupServiceFee(
      order.amount,
      Number(order.pickupServiceFee || 0) > 0 ? "fixed" : pickupStore.pickupFeeType,
      Number(order.pickupServiceFee || 0) > 0 ? order.pickupServiceFee : pickupStore.pickupFeeValue
    )
    : "0.00"
  const sourceMeta = {
    storeOrderType: order.storeOrderType || "",
    isStoreMemberOrder: order.isStoreMemberOrder || false,
    storeOperatorUserId: order.storeOperatorUserId || "",
    storeOperatorPhone: order.storeOperatorPhone || "",
    storeOperatorOpenid: order.storeOperatorOpenid || "",
    storeOperatorRole: order.storeOperatorRole || "",
    storeOperatorName: order.storeOperatorName || ""
  }
  const candidates = []
  if (referrerStore && Number(referralAmount) > 0) {
    candidates.push({
      id: `SSR${order.id}REF`,
      storeId: referrerStore.id,
      orderId: order.id,
      type: "store_referral_commission",
      amount: referralAmount,
      commissionType: referrerStore.referralCommissionType,
      commissionValue: referrerStore.referralCommissionValue,
      orderPaidAmount: order.amount,
      status: order.storeSettlementStatus || "pending_confirm",
      description: `推广佣金：${order.productName}`,
      ...sourceMeta
    })
  }
  if (pickupStore && Number(pickupAmount) > 0) {
    candidates.push({
      id: `SSR${order.id}PIC`,
      storeId: pickupStore.id,
      orderId: order.id,
      type: "pickup_service_fee",
      amount: pickupAmount,
      commissionType: pickupStore.pickupFeeType,
      commissionValue: pickupStore.pickupFeeValue,
      orderPaidAmount: order.amount,
      status: order.storeSettlementStatus || "pending_confirm",
      description: `自提服务费：${order.productName}`,
      ...sourceMeta
    })
  }
  for (const record of candidates) {
    await insertStoreSettlementRecord(record, connection)
    if (isStoreReferralSettlement(record.type)) {
      await ensureFinancialItemAllocations({
        ledgerType: "store",
        recordId: record.id,
        orderId: order.id,
        amountCents: yuanToCents(record.amount, "门店推广佣金")
      }, connection)
    }
  }
  if (connection) return candidates
  return await getStoreSettlementRecordsForOrder(order.id)
}

async function getStoreSettlementRecordsForOrder(orderId) {
  if (!pool) return (await getStoreSettlementRecords()).filter(record => record.orderId === orderId)
  const rows = await query(
    "SELECT * FROM store_settlement_records WHERE order_id = :orderId ORDER BY created_at DESC",
    { orderId }
  )
  return rows.map((row, index) => normalizeSettlementRecord(row, index))
}

async function settleStoreSettlementRecords(ids = [], options = {}) {
  const uniqueIds = [...new Set(ids.map(String).filter(Boolean))].slice(0, 500)
  if (!uniqueIds.length) return { count: 0, batchId: options.batchId || "" }
  const connection = await pool.getConnection()
  const params = {
    note: String(options.note || "后台标记已结算").slice(0, 500),
    batchId: String(options.batchId || "").slice(0, 80)
  }
  const placeholders = uniqueIds.map((id, index) => {
    params[`id${index}`] = id
    return `:id${index}`
  }).join(",")
  try {
    await connection.beginTransaction()
    const [rows] = await connection.query(
      `SELECT r.id
       FROM store_settlement_records r
       LEFT JOIN orders o ON o.id=r.order_id
       WHERE r.id IN (${placeholders})
         AND r.status IN ('pending_confirm','unsettled','chargeback')
         AND (
           r.amount < 0
           OR r.order_id IS NULL OR r.order_id=''
           OR o.status IN ('已完成','completed')
           OR (
             o.pickup_status IN ('picked_up','pickedup','已自提')
             AND (o.pickup_verified_at IS NOT NULL OR o.force_pickup_verified_at IS NOT NULL)
           )
         )
       FOR UPDATE`,
      params
    )
    const eligible = rows.map(row => row.id)
    let count = 0
    for (const id of eligible) {
      const [result] = await connection.query(
        `UPDATE store_settlement_records
         SET status='settled', settled_at=NOW(), settled_by='admin',
             settle_note=:note, batch_id=:batchId, updated_at=NOW()
         WHERE id=:id AND status IN ('pending_confirm','unsettled','chargeback')`,
        { id, note: params.note, batchId: params.batchId }
      )
      count += Number(result.affectedRows || 0)
    }
    await connection.commit()
    return { count, batchId: params.batchId }
  } catch (error) {
    await connection.rollback().catch(() => {})
    throw error
  } finally {
    connection.release()
  }
}

async function createStoreSettlementRecordsForOrder(order, options = {}) {
  const { includeReferral, includePickup } = normalizeStoreSettlementCreationOptions(options)
  if (pool) return await createStoreSettlementRecordsForOrderMysql(order, options)
  const existing = await getStoreSettlementRecords()
  if (!isOrderPaidForPickupCredential(order) || isOrderRefunded(order)) return existing.filter(record => record.orderId === order.id)
  const next = [...existing]
  const referrerStore = includeReferral ? await getPartnerStore(order.referrerStoreId) : null
  const pickupStore = includePickup && isPickupServiceFeeEligible(order) ? await getPartnerStore(order.pickupStoreId) : null
  const createdAt = formatDateTime(new Date())
  const upsertSettlementRecord = incoming => {
    const normalized = normalizeSettlementRecord(incoming)
    const index = next.findIndex(record => record.id === normalized.id || (record.orderId === normalized.orderId && record.storeId === normalized.storeId && settlementTypeAliases(normalized.type).includes(record.type)))
    if (index >= 0) {
      next[index] = normalizeSettlementRecord({
        ...next[index],
        ...normalized,
        id: next[index].id || normalized.id,
        status: next[index].status || normalized.status,
        settledAt: next[index].settledAt || normalized.settledAt,
        settledBy: next[index].settledBy || normalized.settledBy,
        settleNote: next[index].settleNote || normalized.settleNote,
        cancelReason: next[index].cancelReason || normalized.cancelReason,
        batchId: next[index].batchId || normalized.batchId,
        createdAt: next[index].createdAt || normalized.createdAt,
        updatedAt: formatDateTime(new Date())
      }, index)
      return
    }
    next.push(normalized)
  }
  const referralAmount = referrerStore && Number(order.referralCommission || 0) <= 0
    ? calculateStoreAmount(order.amount, referrerStore.referralCommissionType, referrerStore.referralCommissionValue)
    : money(order.referralCommission || 0)
  const pickupAmount = pickupStore
    ? calculatePickupServiceFee(
      order.amount,
      Number(order.pickupServiceFee || 0) > 0 ? "fixed" : pickupStore.pickupFeeType,
      Number(order.pickupServiceFee || 0) > 0 ? order.pickupServiceFee : pickupStore.pickupFeeValue
    )
    : "0.00"
  const sourceMeta = {
    storeOrderType: order.storeOrderType || "",
    isStoreMemberOrder: order.isStoreMemberOrder || false,
    storeOperatorUserId: order.storeOperatorUserId || "",
    storeOperatorPhone: order.storeOperatorPhone || "",
    storeOperatorOpenid: order.storeOperatorOpenid || "",
    storeOperatorRole: order.storeOperatorRole || "",
    storeOperatorName: order.storeOperatorName || ""
  }
  if (referrerStore && Number(referralAmount || 0) > 0) {
    console.log("[store-settlement] create referral commission", { orderId: order.id, storeId: referrerStore.id, source: sourceMeta.storeOrderType || "unknown", memberOrder: !!sourceMeta.isStoreMemberOrder })
    upsertSettlementRecord({
      id: `SSR${order.id}REF`,
      storeId: referrerStore.id,
      orderId: order.id,
      type: "store_referral_commission",
      amount: referralAmount,
      commissionType: referrerStore.referralCommissionType,
      commissionValue: referrerStore.referralCommissionValue,
      orderPaidAmount: order.amount,
      status: order.storeSettlementStatus || "pending_confirm",
      description: `推广佣金：${order.productName}`,
      ...sourceMeta,
      createdAt
    })
  }
  if (pickupStore && Number(pickupAmount || 0) > 0) {
    console.log("[store-settlement] create pickup service fee", { orderId: order.id, storeId: pickupStore.id, source: sourceMeta.storeOrderType || "pickup", memberOrder: !!sourceMeta.isStoreMemberOrder })
    upsertSettlementRecord({
      id: `SSR${order.id}PIC`,
      storeId: pickupStore.id,
      orderId: order.id,
      type: "pickup_service_fee",
      amount: pickupAmount,
      commissionType: pickupStore.pickupFeeType,
      commissionValue: pickupStore.pickupFeeValue,
      orderPaidAmount: order.amount,
      status: order.storeSettlementStatus || "pending_confirm",
      description: `自提服务费：${order.productName}`,
      ...sourceMeta,
      createdAt
    })
  }
  const deduped = []
  const seenOrderTypes = new Set()
  for (const record of next) {
    const canonicalType = isStoreReferralSettlement(record.type) ? "store_referral_commission" : isPickupServiceSettlement(record.type) ? "pickup_service_fee" : record.type
    const key = record.orderId ? `${record.orderId}:${record.storeId}:${canonicalType}` : ""
    if (record.orderId === order.id && key) {
      if (seenOrderTypes.has(key)) continue
      seenOrderTypes.add(key)
    }
    deduped.push(record)
  }
  await saveStoreSettlementRecords(deduped)
  return deduped.filter(record => record.orderId === order.id)
}

async function createStoreReferralCommissionForOrder(order, connection = null) {
  return createStoreSettlementRecordsForOrder(order, {
    connection,
    includeReferral: true,
    includePickup: false
  })
}

async function createPickupServiceFeeForVerifiedOrder(order, connection = null) {
  if (!isPickupServiceFeeEligible(order)) return []
  return createStoreSettlementRecordsForOrder(order, {
    connection,
    includeReferral: false,
    includePickup: true
  })
}

async function sendPickupArrivedNotice(orderId) {
  const templateId = process.env.WECHAT_PICKUP_TEMPLATE_ID || WECHAT_PICKUP_TEMPLATE_ID || ""
  const order = (await getOrders({ keyword: orderId })).find(item => item.id === orderId)
  if (!order) return { ok: false, message: "订单不存在" }
  if (!templateId) {
    console.log(`[pickup] subscription template not configured order=${orderId}`)
    return { ok: false, skipped: true, message: "未配置订阅消息模板，已标记到店但通知未发送" }
  }
  if (!order.openid) {
    console.warn("[pickup-subscribe] missing openid", { orderId })
    return { ok: false, message: "客户未完成订阅授权或缺少 openid，通知未发送" }
  }
  const trimSubscribeValue = (value, max = 20) => {
    const text = String(value || "").replace(/\s+/g, " ").trim()
    const chars = Array.from(text)
    return chars.length > max ? chars.slice(0, max).join("") : text
  }
  const pickupCode = trimSubscribeValue(order.pickupCode || order.pickup_code || "-", 32)
  const storeName = trimSubscribeValue(order.pickupStore?.name || order.pickupStoreName || "自提门店")
  const storeAddress = trimSubscribeValue(order.pickupStore?.address || order.pickupStoreAddress || "请联系门店确认地址")
  const productName = trimSubscribeValue(order.productName || (Array.isArray(order.items) && order.items[0]?.name) || "定制商品")
  const body = JSON.stringify({
    touser: order.openid,
    template_id: templateId,
    page: "pages/orders/orders",
    data: {
      character_string1: { value: pickupCode },
      thing2: { value: storeName },
      thing3: { value: storeAddress },
      thing5: { value: "请凭取货码到店领取" },
      thing6: { value: productName }
    }
  })
  try {
    const accessToken = await getAccessToken()
    const result = await requestJson(`https://api.weixin.qq.com/cgi-bin/message/subscribe/send?access_token=${accessToken}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      timeout: 12000
    }, body)
    const data = result.data || {}
    if (data.errcode === 0) {
      console.log("[pickup-subscribe] sent", { orderId, hasTemplate: !!templateId })
      return { ok: true, message: "订阅消息已发送" }
    }
    console.warn("[pickup-subscribe] send failed", {
      orderId,
      errcode: data.errcode,
      errmsg: data.errmsg
    })
    return { ok: false, message: data.errmsg || "订阅消息发送失败" }
  } catch (error) {
    console.warn("[pickup-subscribe] send error", { orderId, message: error.message })
    return { ok: false, message: error.message || "订阅消息发送失败" }
  }
}

function pickupArrivedBlockedReason(order = {}, storeId = "") {
  if (!order) return "订单不存在"
  if (storeId && order.pickupStoreId !== storeId) return "非本门店订单"
  if (!isOrderPaidForPickupCredential(order)) return "订单未支付"
  if (!isPickupOrder(order)) return "非自提订单"
  if (isOrderRefunded(order) || ["已取消", "已退款", "退款中"].includes(order.status || "")) return "已退款/已取消"
  if (order.pickupStatus === "picked_up" || order.status === "已完成") return "已自提"
  if (["arrived_store", "ready_for_pickup", "arrived"].includes(String(order.pickupStatus || "")) || order.notifyStatus === "sent") return "已通知"
  return ""
}

async function markPickupOrderArrivedForStore(store, orderId) {
  const orders = await getOrders()
  const index = orders.findIndex(order => order.id === orderId)
  const order = orders[index]
  const blockedReason = pickupArrivedBlockedReason(order, store.id)
  if (blockedReason) {
    return {
      ok: false,
      skipped: true,
      orderId,
      reason: blockedReason,
      order: order ? storeOrderView(order, "pickup") : null
    }
  }
  if (!order.pickupCode) {
    order.pickupCode = await generateUniquePickupCode()
    order.pickupQrCodeUrl = await generatePickupQrCode(order.pickupCode)
  }
  const now = formatDateTime(new Date())
  orders[index] = {
    ...order,
    status: "已发货",
    pickupStatus: "arrived_store",
    arrivedStoreAt: order.arrivedStoreAt || now,
    notifiedAt: now,
    notifyStatus: "failed"
  }
  await saveOrders([orders[index]])
  const notice = await sendPickupArrivedNotice(orderId)
  orders[index].notifyStatus = notice.ok && !notice.skipped ? "sent" : "failed"
  orders[index].notifiedAt = now
  await saveOrders([orders[index]])
  return {
    ok: true,
    orderId,
    notifyOk: notice.ok && !notice.skipped,
    notifyMessage: notice.message || "",
    order: storeOrderView(orders[index], "pickup")
  }
}

async function markPickupOrdersArrivedForStore(store, orderIds = []) {
  const uniqueIds = Array.from(new Set((orderIds || []).map(id => String(id || "").trim()).filter(Boolean)))
  const details = []
  for (const orderId of uniqueIds) {
    try {
      details.push(await markPickupOrderArrivedForStore(store, orderId))
    } catch (error) {
      details.push({ ok: false, orderId, reason: error.message || "处理失败" })
    }
  }
  const successCount = details.filter(item => item.ok).length
  const skippedCount = details.filter(item => item.skipped).length
  const failedCount = details.length - successCount - skippedCount
  const notifySuccessCount = details.filter(item => item.ok && item.notifyOk).length
  const notifyFailedCount = details.filter(item => item.ok && !item.notifyOk).length
  return {
    success: true,
    total: uniqueIds.length,
    successCount,
    failedCount,
    skippedCount,
    notifySuccessCount,
    notifyFailedCount,
    details
  }
}

async function getStoreSettlementSummary(filters = {}) {
  const { status: statusFilter = "", ...recordFilters } = filters
  const [stores, orders, records] = await Promise.all([
    getPartnerStores(),
    getOrders(),
    getStoreSettlementRecords(recordFilters)
  ])
  const orderLookup = buildOrderLookup(orders)
  const effectiveRecords = records
    .map(record => decorateSettlementRecord(record, orderLookup))
    .filter(record => {
      if (!statusFilter) return true
      if (statusFilter === "chargeback") return record.effectiveStatus === "chargeback"
      return record.effectiveStatus === statusFilter
    })
  const targetStores = filters.storeId ? stores.filter(store => store.id === filters.storeId) : stores
  const summary = targetStores.map(store => {
    const storeRecords = effectiveRecords.filter(record => record.storeId === store.id)
    const activeStoreRecords = storeRecords.filter(record => record.status !== "cancelled")
    const settlementSummary = buildSettlementSummary(activeStoreRecords, orderLookup)
    const referralRecords = activeStoreRecords.filter(record => isStoreReferralSettlement(record.type))
    const pickupRecords = activeStoreRecords.filter(record => isPickupServiceSettlement(record.type))
    const supplierRecords = activeStoreRecords.filter(record => record.type === "supplier")
    const customRecords = activeStoreRecords.filter(record => record.type === "custom")
    const total = activeStoreRecords.reduce((sum, record) => sum + Number(record.amount || 0), 0)
    return {
      storeId: store.id,
      storeName: store.name,
      referralOrders: new Set(referralRecords.map(record => record.orderId)).size,
      pickupOrders: orders.filter(order => order.pickupStoreId === store.id && order.deliveryType === "pickup" && isOrderPaidForPickupCredential(order) && !isOrderRefunded(order)).length,
      referralAmount: money(referralRecords.reduce((sum, record) => sum + Number(record.amount || 0), 0)),
      pickupAmount: money(pickupRecords.reduce((sum, record) => sum + Number(record.amount || 0), 0)),
      supplierAmount: money(supplierRecords.reduce((sum, record) => sum + Number(record.amount || 0), 0)),
      customAmount: money(customRecords.reduce((sum, record) => sum + Number(record.amount || 0), 0)),
      totalAmount: money(total),
      ...settlementSummary
    }
  })
  return { summary, totals: buildSettlementSummary(effectiveRecords.filter(record => record.status !== "cancelled"), orderLookup), records: effectiveRecords }
}

async function getStoreSession(req) {
  const token = String(req.headers["x-user-session"] || req.headers["x-user-token"] || "").trim()
  const session = await resolveUserSession(token)
  if (!session?.phone) {
    console.log("[store-me]", {
      hasSession: !!session,
      sessionPhoneTail: "empty",
      hasOpenid: !!session?.openid,
      bound: false,
      reason: "no_session_phone"
    })
    return null
  }
  const stores = await getPartnerStores()
  await ensureLegacyStoreMembers().catch(error => console.warn("[store-members] legacy sync failed", { message: error.message }))
  const activeStores = stores.filter(isStoreEnabled)
  const sessionPhone = normalizePhone(session.phone)
  const members = (await getStoreMembers({ phone: sessionPhone, status: "active" }))
    .map(member => ({ member, store: activeStores.find(store => store.id === member.storeId) }))
    .filter(item => item.store)
  const managerPhones = stores
    .filter(item => item.managerPhone)
    .map(item => ({
      id: item.id,
      managerPhoneTail: maskTail(normalizePhone(item.managerPhone)),
      status: item.status,
      storeStatus: item.storeStatus,
      enabled: isStoreEnabled(item),
      phoneMatched: normalizePhone(item.managerPhone) === sessionPhone
    }))
  const legacyMatches = activeStores.filter(item => item.managerPhone && normalizePhone(item.managerPhone) === sessionPhone)
  const matches = members.length ? members : legacyMatches.map(store => ({
    store,
    member: normalizeStoreMember({
      id: `SM${store.id}${sessionPhone.slice(-4)}`,
      storeId: store.id,
      phone: sessionPhone,
      openid: store.managerOpenid || "",
      role: "owner",
      status: "active"
    })
  }))
  console.log("[store-me]", {
    hasSession: true,
    sessionPhoneTail: maskTail(sessionPhone),
    hasOpenid: !!session.openid,
    storeCount: stores.length,
    activeStoreCount: activeStores.length,
    managerPhones: managerPhones.slice(0, 8),
    matchCount: matches.length,
    bound: matches.length === 1,
    matchedStore: matches[0] ? { id: matches[0].store.id, name: matches[0].store.name, role: matches[0].member.role, status: matches[0].store.status, storeStatus: matches[0].store.storeStatus } : null
  })
  if (matches.length > 1) {
    return { token, session, store: null, duplicated: true, error: "该手机号绑定多个门店，请联系管理员处理" }
  }
  const matched = matches[0]
  if (!matched) return null
  const { store, member } = matched
  if (session.openid && !member.openid) {
    await saveStoreMembers([{
      ...member,
      openid: session.openid,
      updatedAt: formatDateTime(new Date())
    }])
  }
  if (session.openid && !store.managerOpenid && normalizePhone(store.managerPhone) === sessionPhone) {
    await upsertPartnerStore({ ...store, managerOpenid: session.openid })
    store.managerOpenid = session.openid
  }
  return { token, session, store, member: { ...member, openid: member.openid || session.openid || "" }, role: member.role, permissions: storePermissionsForRole(member.role) }
}

async function requireStoreSession(req, res) {
  const storeSession = await getStoreSession(req)
  if (storeSession?.duplicated) {
    sendJson(res, 403, { ok: false, message: storeSession.error || "该手机号绑定多个门店，请联系管理员处理" })
    return null
  }
  if (!storeSession) {
    sendJson(res, 403, { ok: false, message: "当前手机号未绑定门店" })
    return null
  }
  return storeSession
}

async function requireStorePermission(req, res, permission) {
  const storeSession = await requireStoreSession(req, res)
  if (!storeSession) return null
  if (!hasStorePermission(storeSession, permission)) {
    sendJson(res, 403, { ok: false, message: "当前门店角色无权操作该功能" })
    return null
  }
  return storeSession
}

function storeOrderView(order, mode = "referral", settlementRecord = null) {
  const showPickupCode = canShowPickupCodeForOrder(order)
  const notifyBlockedReason = pickupArrivedBlockedReason(order, order.pickupStoreId)
  return {
    ...lifecycleView(order, settlementRecord),
    id: order.id,
    createdAt: order.createdAt,
    createdAtText: order.createdAtText || formatChinaDatetime(order.createdAt),
    productName: order.productName,
    productImage: order.productImage || pickProductListImage(order),
    cartThumbUrl: order.cartThumbUrl || "",
    cart_thumb_url: order.cart_thumb_url || "",
    thumbUrl: order.thumbUrl || "",
    thumb_url: order.thumb_url || "",
    listImage: order.listImage || "",
    list_image: order.list_image || "",
    optimizedUrl: order.optimizedUrl || "",
    optimized_url: order.optimized_url || "",
    imageUrl: order.imageUrl || "",
    image_url: order.image_url || "",
    amount: order.amount,
    status: order.status,
    paymentStatus: order.paymentStatus,
    isPaid: isOrderPaidForPickupCredential(order),
    isPickup: isPickupOrder(order),
    canShowPickupCode: showPickupCode,
    canStoreVerify: canStoreVerifyOrder(order),
    phone: maskPhone(order.phone),
    pickupCode: showPickupCode ? order.pickupCode : "",
    pickupQrCodeUrl: showPickupCode ? (order.pickupQrCodeUrl || "") : "",
    pickupStatus: order.pickupStatus,
    notifyStatus: order.notifyStatus || "",
    notifiedAt: order.notifiedAt || "",
    notifiedAtText: order.notifiedAtText || formatChinaDatetime(order.notifiedAt),
    canNotifyPickup: !notifyBlockedReason,
    notifyBlockedReason,
    arrivedStoreAt: order.arrivedStoreAt,
    arrivedStoreAtText: order.arrivedStoreAtText || formatChinaDatetime(order.arrivedStoreAt),
    pickedUpAt: order.pickedUpAt,
    pickedUpAtText: order.pickedUpAtText || formatChinaDatetime(order.pickedUpAt),
    pickupVerifiedAt: order.pickupVerifiedAt || "",
    pickupVerifiedAtText: order.pickupVerifiedAtText || formatChinaDatetime(order.pickupVerifiedAt),
    pickupVerifiedBy: order.pickupVerifiedBy || "",
    storeOrderType: order.storeOrderType || "",
    storeOrderTypeText: order.storeOrderTypeText || storeOrderSourceText(order.storeOrderType, order.isStoreMemberOrder),
    isStoreMemberOrder: !!order.isStoreMemberOrder,
    storeOperatorRoleText: order.storeOperatorRoleText || (order.isStoreMemberOrder && order.storeOperatorRole ? storeRoleText(order.storeOperatorRole) : ""),
    storeOperatorPhoneTail: order.storeOperatorPhoneTail || (order.isStoreMemberOrder ? (order.storeOperatorPhone ? String(order.storeOperatorPhone).slice(-4) : "未知") : ""),
    storeOperatorName: order.storeOperatorName || "",
    referralCommission: mode === "pickup" ? "" : order.referralCommission,
    pickupServiceFee: mode === "referral" ? "" : order.pickupServiceFee,
    storeSettlementStatus: order.storeSettlementStatus
  }
}

function storeCenterStats(store, orders, records) {
  const today = new Date().toISOString().slice(0, 10)
  const month = new Date().toISOString().slice(0, 7)
  const paidOrders = orders.filter(order => isOrderPaidForPickupCredential(order) && !isOrderRefunded(order))
  const paidOrderIds = new Set(paidOrders.map(order => order.id))
  const referralOrders = paidOrders.filter(order => order.referrerStoreId === store.id)
  const pickupOrders = paidOrders.filter(order => order.pickupStoreId === store.id && isPickupOrder(order))
  const validRecords = records.filter(record => includeSettlementRecordForStats(record, paidOrderIds))
  const settlementSummary = buildSettlementSummary(validRecords.filter(record => record.status !== "cancelled"), paidOrders)
  return {
    todayReferralOrders: referralOrders.filter(order => String(order.createdAt || "").startsWith(today)).length,
    monthReferralOrders: referralOrders.filter(order => String(order.createdAt || "").startsWith(month)).length,
    todayPickupOrders: pickupOrders.filter(order => String(order.createdAt || "").startsWith(today)).length,
    pendingPickupOrders: pickupOrders.filter(order => order.pickupStatus !== "picked_up").length,
    ...settlementSummary
  }
}

async function verifyStorePickupMysql(store, selector = {}) {
  const code = normalizePickupCode(selector.pickupCode)
  const connection = await pool.getConnection()
  let row
  try {
    await connection.beginTransaction()
    const params = selector.orderId ? { orderId: selector.orderId } : { pickupCode: code }
    const where = selector.orderId ? "id=:orderId" : "UPPER(pickup_code)=:pickupCode"
    const [rows] = await connection.query(
      `SELECT * FROM orders WHERE ${where} LIMIT 1 FOR UPDATE`,
      params
    )
    row = rows[0]
    if (!row) throw httpError(400, "not_found")
    if (String(row.pickup_store_id || "") !== String(store.id)) throw httpError(400, "wrong_store")
    if (!isOrderPaidForPickupCredential(row)) throw httpError(400, "unpaid")
    if (!isPickupOrder(row)) throw httpError(400, "not_pickup")
    if (isOrderBlockedForStoreVerify(row)) throw httpError(400, "blocked")
    if (selector.orderId && (!code || normalizePickupCode(row.pickup_code) !== code)) {
      throw httpError(400, "code_mismatch")
    }
    if (row.pickup_status === "picked_up") {
      await connection.commit()
      return { alreadyVerified: true, orderId: row.id }
    }
    const [result] = await connection.query(
      `UPDATE orders
       SET pickup_status='picked_up',
           status='已完成',
           picked_up_at=NOW(),
           pickup_verified_at=NOW(),
           pickup_verified_by=:storeId,
           completed_at=COALESCE(completed_at, NOW())
       WHERE id=:orderId
         AND pickup_store_id=:storeId
         AND (pickup_status IS NULL OR pickup_status<>'picked_up')`,
      { orderId: row.id, storeId: store.id }
    )
    if (Number(result.affectedRows || 0) !== 1) throw httpError(409, "concurrent_verify")
    await connection.commit()
  } catch (error) {
    await connection.rollback().catch(() => {})
    throw error
  } finally {
    connection.release()
  }
  const order = (await getOrders()).find(item => item.id === row.id)
  if (!order) throw new Error("verified_order_missing")
  await createPickupServiceFeeForVerifiedOrder(order)
  await recordOrderStateAudit(
    {
      ...order,
      status: row.status,
      pickupStatus: row.pickup_status,
      pickedUpAt: row.picked_up_at,
      pickupVerifiedAt: row.pickup_verified_at
    },
    order,
    {
      source: "store_pickup_code",
      operatorId: store.id,
      reason: "取货码核销",
      serviceFeeImpact: "自提服务费由预计转为待结算"
    }
  )
  await enqueueWechatFulfillment(order, "PICKUP_READY")
  return { alreadyVerified: false, order }
}

async function verifyStorePickupOrder(store, orderId, pickupCode) {
  if (pool) {
    const result = await verifyStorePickupMysql(store, { orderId, pickupCode })
    if (result.alreadyVerified) throw httpError(400, "already_verified")
    return storeOrderView(result.order, "pickup")
  }
  const orders = await getOrders()
  const order = orders.find(item => item.id === orderId)
  if (!order) throw httpError(404, "订单不存在")
  if (order.pickupStoreId !== store.id) throw httpError(403, "不能核销其他门店订单")
  if (!isOrderPaidForPickupCredential(order)) throw httpError(400, "订单未支付，暂不能核销")
  if (!isPickupOrder(order)) throw httpError(400, "该订单不是到店自提订单")
  if (isOrderBlockedForStoreVerify(order)) throw httpError(400, "订单售后或退款处理中，暂不能核销")
  if (order.pickupStatus === "picked_up") throw httpError(400, "该订单已核销")
  if (!pickupCode || normalizePickupCode(order.pickupCode) !== normalizePickupCode(pickupCode)) throw httpError(400, "取货码不正确")
  const previous = { ...order }
  const verifiedAt = formatDateTime(new Date())
  order.pickupStatus = "picked_up"
  order.status = "已完成"
  order.pickedUpAt = verifiedAt
  order.pickupVerifiedAt = verifiedAt
  order.pickupVerifiedBy = store.id
  order.completedAt = order.completedAt || order.pickedUpAt
  await saveOrders([order])
  await createPickupServiceFeeForVerifiedOrder(order)
  await recordOrderStateAudit(previous, order, {
    source: "store_pickup_code",
    operatorId: store.id,
    reason: "取货码核销",
    serviceFeeImpact: "自提服务费由预计转为待结算"
  })
  await enqueueWechatFulfillment(order, "PICKUP_READY")
  return storeOrderView(order, "pickup")
}

async function verifyStorePickupByCode(store, pickupCode) {
  const code = normalizePickupCode(pickupCode)
  if (!code || code.length !== 6) throw httpError(400, "请输入6位取货码")
  if (pool) {
    const result = await verifyStorePickupMysql(store, { pickupCode: code })
    if (result.alreadyVerified) {
      const order = (await getOrders()).find(item => item.id === result.orderId)
      return {
        ok: false,
        alreadyVerified: true,
        message: "订单已核销",
        order: storeOrderView(order, "pickup"),
        verifiedAt: order?.pickupVerifiedAtText || order?.pickedUpAtText || order?.pickedUpAt || "",
        verifiedStore: order?.pickupStore?.name || store.name,
        verifiedBy: order?.pickupVerifiedBy || store.id
      }
    }
    const order = result.order
    return {
      ok: true,
      alreadyVerified: false,
      message: "核销成功",
      order: storeOrderView(order, "pickup"),
      product: order.productName,
      customer: maskName(order.customerName) || maskPhone(order.phone),
      quantity: extractOrderQuantity(order),
      verifiedAt: formatChinaDatetime(order.pickupVerifiedAt || order.pickedUpAt),
      verifiedStore: store.name,
      verifiedBy: store.id
    }
  }
  const orders = await getOrders()
  const order = orders.find(item => normalizePickupCode(item.pickupCode) === code)
  if (!order) throw httpError(404, "取货码不存在")
  if (order.pickupStoreId !== store.id) throw httpError(403, "不能核销其他门店订单")
  if (!isOrderPaidForPickupCredential(order)) throw httpError(400, "订单未支付，暂不能核销")
  if (!isPickupOrder(order)) throw httpError(400, "该订单不是到店自提订单")
  if (isOrderBlockedForStoreVerify(order)) throw httpError(400, "订单售后或退款处理中，暂不能核销")
  if (order.pickupStatus === "picked_up") {
    return {
      ok: false,
      alreadyVerified: true,
      message: "订单已核销",
      order: storeOrderView(order, "pickup"),
      verifiedAt: order.pickupVerifiedAtText || order.pickedUpAtText || order.pickedUpAt || "",
      verifiedStore: order.pickupStore?.name || store.name,
      verifiedBy: order.pickupVerifiedBy || store.id
    }
  }
  const previous = { ...order }
  const verifiedAt = formatDateTime(new Date())
  order.pickupStatus = "picked_up"
  order.status = "已完成"
  order.pickedUpAt = verifiedAt
  order.pickupVerifiedAt = verifiedAt
  order.pickupVerifiedBy = store.id
  order.completedAt = order.completedAt || verifiedAt
  await saveOrders([order])
  await createPickupServiceFeeForVerifiedOrder(order)
  await recordOrderStateAudit(previous, order, {
    source: "store_pickup_code",
    operatorId: store.id,
    reason: "取货码核销",
    serviceFeeImpact: "自提服务费由预计转为待结算"
  })
  await enqueueWechatFulfillment(order, "PICKUP_READY")
  return {
    ok: true,
    alreadyVerified: false,
    message: "核销成功",
    order: storeOrderView(order, "pickup"),
    product: order.productName,
    customer: maskName(order.customerName) || maskPhone(order.phone),
    quantity: extractOrderQuantity(order),
    verifiedAt: formatChinaDatetime(verifiedAt),
    verifiedStore: store.name,
    verifiedBy: store.id
  }
}

async function createOrder(data) {
  let product = await getProduct(data.productId)
  let cartItems = []
  if (!product && data.productId === "CART_ORDER" && Array.isArray(data.cartItems) && data.cartItems.length) {
    const products = await getProducts()
    cartItems = data.cartItems.map(item => {
      const found = products.find(productItem => productItem.id === item.id)
      if (!found) throw new Error(`购物车商品不存在：${item.name || item.id}`)
      if (!isPublicProduct(found)) throw httpError(409, `商品已下架：${found.name || item.name || item.id}`)
      return {
        product: found,
        quantity: strictPositiveInteger(item.quantity == null ? 1 : item.quantity),
        skuId: item.skuId || item.sku_id || "",
        skuName: item.skuName || item.sku_name || ""
      }
    })
    const amount = cartItems.reduce((sum, item) => sum + Number(item.product.price || 0) * item.quantity, 0)
    const totalQuantity = cartItems.reduce((sum, item) => sum + item.quantity, 0)
    product = {
      id: "CART_ORDER",
      name: cartItems.length > 1 ? `${cartItems[0].product.name}等${totalQuantity}件` : cartItems[0].product.name,
      price: amount.toFixed(2),
      productType: "normal",
      categories: ["日用好货"]
    }
  }
  if (!product && data.productId === "CUSTOM_UPLOAD") {
    product = {
      id: "CUSTOM_UPLOAD",
      name: "上传照片定制",
      price: "0",
      priceMode: "quote",
      needQuote: "true"
    }
  }
  if (!product) throw new Error("商品不存在")
  if (!["CART_ORDER", "CUSTOM_UPLOAD"].includes(product.id) && !isPublicProduct(product)) {
    throw httpError(409, "商品已下架，请返回商品页重新选择")
  }
  const productType = String(data.productType || data.orderType || product.productType || "").toLowerCase() === "normal" ? "normal" : "custom"
  const quantity = strictPositiveInteger(data.quantity == null ? 1 : data.quantity)
  const isQuoteOrder = String(data.needQuote || product.needQuote || product.need_quote || "").toLowerCase() === "true" ||
    String(data.priceMode || product.priceMode || product.price_mode || "").toLowerCase() === "quote" ||
    (String(data.isCustomOrder || "false") === "true" && Number(product.price || 0) <= 0)
  const orderItemSnapshots = validateOrderItems(
    cartItems.length
      ? cartItems.map(item => orderItemSnapshot(item.product, item.quantity, {
        skuId: item.skuId || "",
        skuName: item.skuName || ""
      }))
      : [orderItemSnapshot(product, quantity, {
        skuId: data.skuId || "",
        skuName: data.skuName || "",
        customization: {
          customRequest: data.customRequest || "",
          originalImageUrls: normalizeMediaList(data.originalImageUrls || data.originalImageUrl || "")
        }
      })]
  )
  const orderAmountCents = isQuoteOrder
    ? 0
    : orderItemSnapshots.reduce((sum, item) => sum + item.paidAmountCents, 0)
  const orderAmount = centsToYuan(orderAmountCents)
  const deliveryType = data.deliveryType === "pickup" ? "pickup" : "delivery"
  let pickupStore = null
  if (deliveryType === "pickup") {
    pickupStore = await getPartnerStore(data.pickupStoreId)
    if (!pickupStore || !isStoreEnabled(pickupStore) || pickupStore.isPickupEnabled !== "true") throw new Error("请选择有效的自提门店")
  }
  const trustedAttribution = await resolveTrustedStoreAttribution(data, {
    userId: data.userId,
    phone: data.phone,
    openid: data.openid
  })
  const referrerStoreId = trustedAttribution.storeId
  const storeOrderSource = await resolveStoreOrderSource(referrerStoreId, data)
  if (trustedAttribution.attributionType) {
    storeOrderSource.storeOrderType = trustedAttribution.attributionType
    storeOrderSource.isStoreMemberOrder = trustedAttribution.attributionType === "store_self"
  }
  const personalAttribution = referrerStoreId
    ? { referrerUserId: "", parentReferrerUserId: "" }
    : await resolvePersonalOrderAttribution(data.phone)
  if (referrerStoreId) console.log("[promotion-reward] skipped for store source order", { storeId: referrerStoreId, orderSource: storeOrderSource.storeOrderType })
  const income = await calculateOrderStoreIncome({ ...data, deliveryType, referrerStoreId, pickupStoreId: pickupStore?.id || "" }, orderAmount)
  const pickupCode = deliveryType === "pickup" ? await generateUniquePickupCode() : ""
  const pickupQrCodeUrl = ""
  const requestKey = String(data.requestKey || data.idempotencyKey || "").trim().slice(0, 100)
  const requestHash = canonicalRequestHash({
    ...data,
    phone: data.phone,
    userId: data.userId,
    orderItems: orderItemSnapshots.map(item => ({
      productId: item.productId,
      skuId: item.skuId,
      quantity: item.quantity,
      paidAmountCents: item.paidAmountCents
    }))
  })
  const reservedOrderId = `DD${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}${crypto.randomBytes(2).toString("hex").toUpperCase()}`
  const order = normalizeOrder({
    id: reservedOrderId,
    productId: product.id,
    customerName: data.customerName,
    phone: data.phone,
    productName: product.name,
    amount: orderAmount,
    status: isQuoteOrder ? "待客服确认" : "待支付",
    paymentStatus: isQuoteOrder ? "待报价" : "待支付",
    paymentExpiresAt: isQuoteOrder ? null : paymentExpiresAt(),
    stockReservedAt: null,
    stockReleasedAt: null,
    address: data.address,
    customRequest: productType === "normal" ? (data.customRequest || "") : data.customRequest,
    originalImageUrl: data.originalImageUrl || "",
    originalImageUrls: normalizeMediaList(data.originalImageUrls || data.originalImageUrl || ""),
    aiPreviewUrl: data.aiPreviewUrl || "",
    finalDesignUrl: data.finalDesignUrl || data.aiPreviewUrl || "",
    category: data.category || (Array.isArray(product.categories) ? product.categories[0] : "") || "",
    isCustomOrder: productType === "normal" ? "false" : (String(data.isCustomOrder || "false") === "true" ? "true" : "false"),
    openid: data.openid || "",
    userId: data.userId || "",
    userToken: "",
    remark: [
      data.remark || "",
      cartItems.length ? `购物车：${cartItems.map(item => `${item.product.name}x${item.quantity}`).join("，")}` : "",
      cartItems.length ? `购物车商品ID：${cartItems.map(item => `${item.product.id}x${item.quantity}`).join("，")}` : "",
      !cartItems.length && productType === "normal" ? `普通商品：${product.name}x${quantity}` : "",
      data.newcomerBenefitText ? `新人福利：${data.newcomerBenefitText}` : ""
    ].filter(Boolean).join("\n"),
    inviterCode: data.inviterCode || "",
    deliveryType,
    pickupStoreId: pickupStore?.id || "",
    pickupStore: storePublicView(pickupStore),
    pickupCode,
    pickupQrCodeUrl,
    pickupStatus: deliveryType === "pickup" ? "preparing" : "none",
    userLatitude: data.userLatitude || "",
    userLongitude: data.userLongitude || "",
    pickupDistance: data.pickupDistance || "",
    referrerStoreId,
    storeAttributionId: trustedAttribution.attributionId || "",
    ...storeOrderSource,
    referrerUserId: personalAttribution.referrerUserId,
    parentReferrerUserId: personalAttribution.parentReferrerUserId,
    supplierStoreId: data.supplierStoreId || "",
    referralCommission: income.referralCommission,
    pickupServiceFee: income.pickupServiceFee,
    supplierSettlementAmount: "0.00",
    customCommissionAmount: "0.00",
    storeSettlementStatus: "pending_confirm"
  }, 0)
  if (!pool) {
    const orders = readJsonFile(ordersFile, [])
    if (order.pickupCode) order.pickupQrCodeUrl = await generatePickupQrCode(order.pickupCode)
    order.items = orderItemSnapshots
    orders.push(order)
    writeJsonFile(ordersFile, orders)
    await ensureCustomerFromOrder(order)
    if (!order.referrerStoreId) await bindPromotionFromOrder(order)
    if (data.source === "order-recommendation") {
      await recordOrderRecommendationEvent({ type: "conversion", productId: order.productId, productName: order.productName, orderId: order.id, amount: order.amount, phone: order.phone })
    }
    return order
  }
  const connection = await pool.getConnection()
  let existingOrderId = ""
  let finiteOrderInventory = false
  try {
    await connection.beginTransaction()
    if (requestKey) {
      try {
        await connection.query(
          `INSERT INTO order_idempotency_keys
            (user_id, operation, request_key, request_hash, order_id, created_at, expires_at)
           VALUES
            (:userId, 'CREATE_ORDER', :requestKey, :requestHash, :orderId, NOW(), DATE_ADD(NOW(), INTERVAL 24 HOUR))`,
          { userId: order.userId, requestKey, requestHash, orderId: order.id }
        )
      } catch (error) {
        if (error?.code !== "ER_DUP_ENTRY") throw error
        const [rows] = await connection.query(
          `SELECT request_hash, order_id
           FROM order_idempotency_keys
           WHERE user_id=:userId AND operation='CREATE_ORDER' AND request_key=:requestKey
           LIMIT 1 FOR UPDATE`,
          { userId: order.userId, requestKey }
        )
        const reservation = rows[0]
        if (!reservation || reservation.request_hash !== requestHash) {
          throw httpError(409, "该请求标识已用于其他订单，请刷新后重试")
        }
        existingOrderId = reservation.order_id
      }
    }
    if (!existingOrderId) {
      if (isPickupOrder(order)) await claimPickupCode(connection, order)
      for (const item of orderItemSnapshots) {
        if (["CART_ORDER", "CUSTOM_UPLOAD"].includes(item.productId)) continue
        const [rows] = await connection.query(
          `SELECT id, name, status, stock, stock_mode, product_type
           FROM products WHERE id=:productId LIMIT 1 FOR UPDATE`,
          { productId: item.productId }
        )
        const currentProduct = rows[0]
        if (!currentProduct || String(currentProduct.status || "on") !== "on") {
          throw httpError(409, `商品已下架：${item.productName}`)
        }
        const inventoryMode = normalizeInventoryMode({
          stockMode: currentProduct.stock_mode,
          productType: currentProduct.product_type,
          stock: Number(currentProduct.stock || 0)
        })
        item.inventoryMode = inventoryMode
        if (inventoryMode === "FINITE") {
          finiteOrderInventory = true
          const [stockResult] = await connection.query(
            `UPDATE products
             SET stock_mode='FINITE',
                 stock=stock-:quantity,
                 inventory_version=inventory_version+1
             WHERE id=:productId AND stock>=:quantity`,
            { productId: item.productId, quantity: item.quantity }
          )
          if (Number(stockResult.affectedRows || 0) !== 1) {
            throw httpError(409, `库存不足：${item.productName}`)
          }
        }
      }
      if (finiteOrderInventory) order.stockReservedAt = new Date()
      await connection.query(
        "INSERT INTO orders (id, product_id, customer_name, phone, product_name, amount, status, payment_status, transaction_id, openid, user_id, address, custom_request, original_image_url, original_image_urls, ai_preview_url, final_design_url, category, is_custom_order, remark, inviter_code, created_at, payment_expires_at, stock_reserved_at, stock_released_at, delivery_type, pickup_store_id, pickup_code, pickup_qrcode_url, pickup_status, user_latitude, user_longitude, pickup_distance, referrer_store_id, store_attribution_id, source_type, source_store_id, source_store_code, store_order_type, is_store_member_order, store_operator_user_id, store_operator_phone, store_operator_openid, store_operator_role, store_operator_name, referrer_user_id, parent_referrer_user_id, supplier_store_id, referral_commission, pickup_service_fee, supplier_settlement_amount, custom_commission_amount, store_settlement_status) VALUES (:id, :productId, :customerName, :phone, :productName, :amount, :status, :paymentStatus, :transactionId, :openid, :userId, :address, :customRequest, :originalImageUrl, :originalImageUrlsJson, :aiPreviewUrl, :finalDesignUrl, :category, :isCustomOrder, :remark, :inviterCode, :createdAt, :paymentExpiresAt, :stockReservedAt, :stockReleasedAt, :deliveryType, :pickupStoreId, :pickupCode, :pickupQrCodeUrl, :pickupStatus, :userLatitude, :userLongitude, :pickupDistance, :referrerStoreId, :storeAttributionId, :sourceType, :sourceStoreId, :sourceStoreCode, :storeOrderType, :isStoreMemberOrder, :storeOperatorUserId, :storeOperatorPhone, :storeOperatorOpenid, :storeOperatorRole, :storeOperatorName, :referrerUserId, :parentReferrerUserId, :supplierStoreId, :referralCommission, :pickupServiceFee, :supplierSettlementAmount, :customCommissionAmount, :storeSettlementStatus)",
        {
          ...mysqlOrderParams(order),
          originalImageUrlsJson: JSON.stringify(order.originalImageUrls || []),
          userLatitude: order.userLatitude === "" ? null : order.userLatitude,
          userLongitude: order.userLongitude === "" ? null : order.userLongitude,
          pickupDistance: order.pickupDistance === "" ? null : order.pickupDistance
        }
      )
      for (const item of orderItemSnapshots) {
        await connection.query(
          `INSERT INTO order_items
            (id, order_id, product_id, sku_id, product_name, sku_name, image_url,
             unit_price_cents, quantity, product_discount_cents, order_discount_cents,
             paid_amount_cents, inventory_mode, customization_json)
           VALUES
            (:id, :orderId, :productId, :skuId, :productName, :skuName, :imageUrl,
             :unitPriceCents, :quantity, :productDiscountCents, :orderDiscountCents,
             :paidAmountCents, :inventoryMode, :customizationJson)`,
          { ...item, orderId: order.id }
        )
        if (item.inventoryMode === "FINITE") {
          await connection.query(
            `INSERT INTO order_inventory_reservations
              (order_item_id, order_id, product_id, quantity, created_at)
             VALUES (:orderItemId, :orderId, :productId, :quantity, NOW())`,
            {
              orderItemId: item.id,
              orderId: order.id,
              productId: item.productId,
              quantity: item.quantity
            }
          )
        }
      }
      if (finiteOrderInventory && order.paymentExpiresAt) {
        await enqueueOrderPaymentTimeout(connection, {
          orderId: order.id,
          expiresAt: order.paymentExpiresAt
        })
      }
      if (order.storeAttributionId) {
        await connection.query(
          `UPDATE store_referral_attributions
           SET last_order_id=:orderId, updated_at=NOW()
           WHERE id=:attributionId AND store_id=:storeId AND status='active'`,
          {
            orderId: order.id,
            attributionId: order.storeAttributionId,
            storeId: order.referrerStoreId
          }
        )
      }
    }
    await connection.commit()
  } catch (error) {
    await connection.rollback().catch(() => {})
    throw error
  } finally {
    connection.release()
  }
  if (existingOrderId) {
    const existing = (await getOrders()).find(item => item.id === existingOrderId)
    if (!existing) throw httpError(409, "原订单正在处理中，请稍后查询订单")
    return existing
  }
  if (order.pickupCode) {
    order.pickupQrCodeUrl = await generatePickupQrCode(order.pickupCode)
    await query(
      "UPDATE orders SET pickup_qrcode_url=:pickupQrCodeUrl WHERE id=:orderId AND pickup_code=:pickupCode",
      { pickupQrCodeUrl: order.pickupQrCodeUrl, orderId: order.id, pickupCode: order.pickupCode }
    )
  }
  await ensureCustomerFromOrder(order)
  if (!order.referrerStoreId) await bindPromotionFromOrder(order)
  if (data.source === "order-recommendation") {
    await recordOrderRecommendationEvent({ type: "conversion", productId: order.productId, productName: order.productName, orderId: order.id, amount: order.amount, phone: order.phone })
  }
  return order
}

async function setOrderOpenid(orderId, openid) {
  if (!orderId || !openid) return
  if (!pool) {
    const orders = readJsonFile(ordersFile, []).map(normalizeOrder)
    const index = orders.findIndex(order => order.id === orderId)
    if (index >= 0 && !orders[index].openid) {
      orders[index].openid = openid
      writeJsonFile(ordersFile, orders)
    }
    return
  }
  await query("UPDATE orders SET openid = COALESCE(NULLIF(openid, ''), :openid) WHERE id = :orderId", { orderId, openid })
}

async function backfillOrderIdentity(orderId, identity = {}) {
  if (!orderId) return
  const openid = String(identity.openid || "").trim()
  const userId = String(identity.userId || "").trim()
  if (!openid && !userId) return
  if (!pool) {
    const orders = readJsonFile(ordersFile, []).map(normalizeOrder)
    const index = orders.findIndex(order => order.id === orderId)
    if (index >= 0) {
      if (!orders[index].openid && openid) orders[index].openid = openid
      if (!orders[index].userId && userId) orders[index].userId = userId
      writeJsonFile(ordersFile, orders)
    }
    return
  }
  await query(
    `UPDATE orders
     SET
       openid = CASE WHEN (openid IS NULL OR openid = '') THEN :openid ELSE openid END,
       user_id = CASE WHEN (user_id IS NULL OR user_id = '') THEN :userId ELSE user_id END
     WHERE id = :orderId`,
    { orderId, openid, userId }
  )
}

async function markOrderPaid(orderId, transactionId = "", options = {}) {
  if (!pool) {
    const orders = readJsonFile(ordersFile, []).map(normalizeOrder)
    const index = orders.findIndex(order => order.id === orderId)
    if (index >= 0) {
      if (orders[index].paymentStatus === "已支付") {
        console.log("[pay] markOrderPaid skipped already paid", { orderId })
        return false
      }
      const blocked = ["已退款", "退款中", "退款处理中"].includes(orders[index].status) ||
        ["已退款", "退款处理中"].includes(orders[index].paymentStatus) ||
        ["refunded", "refund_pending"].includes(orders[index].afterSalesStatus)
      if (blocked) {
        console.warn("[pay-state-guard]", { orderId, outcome: "PAYMENT_FACT_ONLY" })
        return false
      }
      if (["已取消", "cancelled", "canceled", "已关闭", "closed", "已作废", "void"].includes(orders[index].status)) {
        orders[index].paymentStatus = "异常已支付"
        orders[index].status = "PAID_AFTER_CANCEL"
        orders[index].transactionId = orders[index].transactionId || transactionId
        orders[index].paidAt = orders[index].paidAt || new Date().toISOString().slice(0, 16).replace("T", " ")
        writeJsonFile(ordersFile, orders)
        console.warn("[pay-state-guard]", { orderId, outcome: "PAID_AFTER_CANCEL" })
        return true
      }
      orders[index].paymentStatus = "已支付"
      orders[index].status = "待发货"
      orders[index].transactionId = transactionId
      orders[index].paidAt = new Date().toISOString().slice(0, 16).replace("T", " ")
      if (orders[index].deliveryType === "pickup" && !orders[index].pickupCode) {
        orders[index].pickupCode = await generateUniquePickupCode()
        orders[index].pickupQrCodeUrl = await generatePickupQrCode(orders[index].pickupCode)
      }
      writeJsonFile(ordersFile, orders)
      await createRewardsForOrder(orders[index])
      await createStoreReferralCommissionForOrder(orders[index])
      await createSalesAgentCommissionForOrder(orders[index])
      console.log("[pay] markOrderPaid updated json order", { orderId, hasTransactionId: !!transactionId })
      return true
    }
    console.warn("[pay] markOrderPaid order missing", { orderId })
    return false
  }
  let affectedRows = 0
  let notificationQueued = false
  let financeQueued = false
  let paymentOutcome = ""
  const result = await markOrderPaidAndEnqueue({
    pool,
    orderId,
    transactionId,
    notificationType: options.queueWecomNotification ? WECOM_ORDER_PAID_NOTIFICATION : ""
  })
  affectedRows = result.updated ? 1 : 0
  notificationQueued = result.queued
  financeQueued = result.financeQueued
  paymentOutcome = result.outcome || ""
  setImmediate(() => runPaymentFinanceWorkerSafe())
  if (options.queueWecomNotification) setImmediate(() => runWecomOrderNotificationWorkerSafe())
  console.log("[pay] markOrderPaid mysql update", {
    orderId,
    affectedRows,
    notificationQueued,
    financeQueued,
    hasTransactionId: !!transactionId,
    paymentOutcome
  })
  if (!affectedRows) return false
  if (paymentOutcome === "PAID_AFTER_CANCEL" || paymentOutcome === "PAYMENT_FACT_ONLY") return true
  const order = (await getOrders({ keyword: orderId })).find(item => item.id === orderId)
  if (order) {
    if (order.deliveryType === "pickup" && (!order.pickupCode || !order.pickupQrCodeUrl)) {
      order.pickupCode = order.pickupCode || await generateUniquePickupCode()
      order.pickupQrCodeUrl = order.pickupQrCodeUrl || await generatePickupQrCode(order.pickupCode)
      await saveOrders([order])
    }
  }
  return true
}

function isPaymentFinanceEligibleOrder(order = {}) {
  const status = String(order.status || "").trim().toLowerCase()
  const paymentStatus = String(order.paymentStatus || order.payment_status || "").trim().toLowerCase()
  const refundStatus = String(order.refundStatus || order.refund_status || "").trim().toLowerCase()
  const afterSalesStatus = String(order.afterSalesStatus || order.after_sales_status || "").trim().toLowerCase()
  if (!isOrderPaidForPickupCredential(order)) return false
  if (["已取消", "cancelled", "canceled", "已关闭", "closed", "已作废", "void", "paid_after_cancel", "已退款", "退款中", "退款处理中", "refunded", "refund_processing"].includes(status)) return false
  if (["已退款", "退款处理中", "refunded", "refund_pending"].includes(paymentStatus)) return false
  if (["退款成功", "退款处理中", "refunded", "processing", "refund_pending"].includes(refundStatus)) return false
  return !["refunded", "refund_pending"].includes(afterSalesStatus)
}

async function processPaymentFinanceEvent(record) {
  const orderId = String(record.aggregate_id || "").trim()
  if (!orderId) throw new Error("支付财务事件缺少订单号")
  const order = (await getOrders({ keyword: orderId })).find(item => item.id === orderId)
  if (!order) throw new Error("支付财务事件关联订单不存在")
  const connection = await pool.getConnection()
  try {
    await connection.beginTransaction()
    const [events] = await connection.query(
      `SELECT id, status, locked_by
       FROM payment_finance_outbox
       WHERE id=:id FOR UPDATE`,
      { id: record.id }
    )
    const event = events[0]
    if (!event || event.status !== "PROCESSING" || event.locked_by !== record.locked_by) {
      throw new Error("支付财务事件认领已失效")
    }
    const [orders] = await connection.query(
      `SELECT status, payment_status, refund_status, after_sales_status
       FROM orders WHERE id=:orderId FOR UPDATE`,
      { orderId }
    )
    if (!orders[0]) throw new Error("支付财务事件关联订单不存在")
    const lockedOrder = {
      ...order,
      status: orders[0].status || order.status,
      paymentStatus: orders[0].payment_status || order.paymentStatus,
      refundStatus: orders[0].refund_status || order.refundStatus,
      afterSalesStatus: orders[0].after_sales_status || order.afterSalesStatus
    }
    if (!isPaymentFinanceEligibleOrder(lockedOrder)) {
      await completePaymentFinanceEvent(connection, record, "SKIPPED")
      await connection.commit()
      console.log("[payment-finance-outbox] skipped", { orderId, reason: "order_not_eligible" })
      return { skipped: true }
    }

    await createRewardsForOrder(lockedOrder, connection)
    await createStoreReferralCommissionForOrder(lockedOrder, connection)
    await createSalesAgentCommissionForOrder(lockedOrder, connection)
    await completePaymentFinanceEvent(connection, record)
    await connection.commit()
    console.log("[payment-finance-outbox] completed", { orderId, eventId: record.id })
    return { completed: true }
  } catch (error) {
    await connection.rollback().catch(() => {})
    throw error
  } finally {
    connection.release()
  }
}

async function runPaymentFinanceWorker() {
  if (!pool || paymentFinanceWorkerRunning) return
  paymentFinanceWorkerRunning = true
  try {
    const records = await claimDuePaymentFinanceEvents({
      pool,
      limit: 10,
      lockMinutes: 5,
      maxAttempts: PAYMENT_FINANCE_MAX_ATTEMPTS
    })
    for (const record of records) {
      try {
        await processPaymentFinanceEvent(record)
      } catch (error) {
        const updated = await failPaymentFinanceEvent({
          pool,
          record,
          maxAttempts: PAYMENT_FINANCE_MAX_ATTEMPTS,
          retryMinutes: 1,
          error
        })
        console.error("[payment-finance-outbox] failed", {
          orderId: record.aggregate_id,
          eventId: record.id,
          attemptCount: Number(record.attempt_count || 0),
          updated,
          message: String(error.message || "支付财务事件处理失败").slice(0, 300)
        })
      }
    }
  } finally {
    paymentFinanceWorkerRunning = false
  }
}

async function runPaymentFinanceWorkerSafe() {
  try {
    await runPaymentFinanceWorker()
  } catch (error) {
    console.error("[payment-finance-outbox] worker error", { message: String(error.message || "worker error").slice(0, 300) })
  }
}

function startPaymentFinanceWorker() {
  if (paymentFinanceWorkerTimer) return
  setTimeout(() => runPaymentFinanceWorkerSafe(), 1000).unref()
  paymentFinanceWorkerTimer = setInterval(() => runPaymentFinanceWorkerSafe(), 30000)
  paymentFinanceWorkerTimer.unref()
  console.log("[payment-finance-outbox] worker ready", { maxAttempts: PAYMENT_FINANCE_MAX_ATTEMPTS })
}

async function runOrderPaymentTimeoutWorker() {
  if (!pool || orderPaymentTimeoutWorkerRunning) return
  orderPaymentTimeoutWorkerRunning = true
  try {
    const records = await claimDueOrderPaymentTimeoutJobs({
      pool,
      limit: 20,
      lockMinutes: 5,
      maxAttempts: ORDER_PAYMENT_TIMEOUT_MAX_ATTEMPTS
    })
    for (const record of records) {
      try {
        const result = await closeOrderForPaymentTimeout({ pool, record })
        console.log("[order-payment-timeout] processed", {
          orderId: record.order_id,
          outcome: result.outcome,
          releasedQuantity: Number(result.release?.releasedQuantity || 0)
        })
      } catch (error) {
        const updated = await failOrderPaymentTimeoutJob({
          pool,
          record,
          maxAttempts: ORDER_PAYMENT_TIMEOUT_MAX_ATTEMPTS,
          retryMinutes: 1,
          error
        })
        console.error("[order-payment-timeout] failed", {
          orderId: record.order_id,
          attemptCount: Number(record.attempt_count || 0),
          updated,
          message: String(error.message || "支付超时任务失败").slice(0, 300)
        })
      }
    }
  } finally {
    orderPaymentTimeoutWorkerRunning = false
  }
}

async function runOrderPaymentTimeoutWorkerSafe() {
  try {
    await runOrderPaymentTimeoutWorker()
  } catch (error) {
    console.error("[order-payment-timeout] worker error", {
      message: String(error.message || "worker error").slice(0, 300)
    })
  }
}

function startOrderPaymentTimeoutWorker() {
  if (orderPaymentTimeoutWorkerTimer) return
  setTimeout(() => runOrderPaymentTimeoutWorkerSafe(), 1000).unref()
  orderPaymentTimeoutWorkerTimer = setInterval(() => runOrderPaymentTimeoutWorkerSafe(), 30000)
  orderPaymentTimeoutWorkerTimer.unref()
  console.log("[order-payment-timeout] worker ready", {
    paymentTimeoutMinutes: ORDER_PAYMENT_TIMEOUT_MINUTES,
    maxAttempts: ORDER_PAYMENT_TIMEOUT_MAX_ATTEMPTS
  })
}

function isWecomOrderNotificationEnabled() {
  return !!String(process.env.WECOM_ORDER_WEBHOOK_URL || "").trim()
}

async function claimDueWecomOrderNotifications(limit = 10) {
  return claimDueNotifications({
    pool,
    notificationType: WECOM_ORDER_PAID_NOTIFICATION,
    maxAttempts: WECOM_NOTIFICATION_MAX_ATTEMPTS,
    limit,
    lockMinutes: 2
  })
}

async function completeWecomOrderNotification(record) {
  await query(
    `UPDATE order_notification_records
     SET status = 'SENT',
         last_error = NULL,
         sent_at = NOW(),
         next_retry_at = NULL,
         updated_at = NOW(),
         claim_token = NULL,
         processing_started_at = NULL
     WHERE id = :id AND status = 'PROCESSING' AND claim_token = :claimToken`,
    { id: record.id, claimToken: record.claim_token }
  )
}

async function failWecomOrderNotification(record, error) {
  const attemptCount = Number(record.attempt_count || 0)
  const exhausted = attemptCount >= WECOM_NOTIFICATION_MAX_ATTEMPTS
  const delayMinutes = exhausted ? 0 : wecomRetryDelayMinutes(attemptCount)
  const lastError = safeWecomError(error)
  await query(
    `UPDATE order_notification_records
     SET status = :status,
         last_error = :lastError,
         next_retry_at = ${exhausted ? "NULL" : `DATE_ADD(NOW(), INTERVAL ${delayMinutes} MINUTE)`},
         claim_token = NULL,
         processing_started_at = NULL,
         updated_at = NOW()
     WHERE id = :id AND status = 'PROCESSING' AND claim_token = :claimToken`,
    {
      id: record.id,
      claimToken: record.claim_token,
      status: exhausted ? "FAILED" : "RETRY",
      lastError
    }
  )
  console.error("[wecom-order-notification] send failed", {
    orderId: record.order_id,
    attemptCount,
    status: exhausted ? "FAILED" : "RETRY",
    error: lastError
  })
}

async function runWecomOrderNotificationWorker() {
  if (!pool || !isWecomOrderNotificationEnabled() || wecomNotificationWorkerRunning) return
  wecomNotificationWorkerRunning = true
  try {
    const records = await claimDueWecomOrderNotifications()
    for (const record of records) {
      try {
        const order = (await getOrders({ keyword: record.order_id })).find(item => item.id === record.order_id)
        if (!order || order.paymentStatus !== "已支付") {
          throw new Error("订单不存在或支付状态无效")
        }
        await sendWecomMarkdown({
          webhookUrl: process.env.WECOM_ORDER_WEBHOOK_URL,
          content: buildOrderPaidMarkdown(order),
          timeoutMs: 5000
        })
        await completeWecomOrderNotification(record)
        console.log("[wecom-order-notification] sent", {
          orderId: record.order_id,
          attemptCount: Number(record.attempt_count || 0)
        })
      } catch (error) {
        await failWecomOrderNotification(record, error)
      }
    }
  } finally {
    wecomNotificationWorkerRunning = false
  }
}

async function runWecomOrderNotificationWorkerSafe() {
  try {
    await runWecomOrderNotificationWorker()
  } catch (error) {
    console.error("[wecom-order-notification] worker error", { error: safeWecomError(error) })
  }
}

function startWecomOrderNotificationWorker() {
  if (wecomNotificationWorkerTimer) return
  setTimeout(() => runWecomOrderNotificationWorkerSafe(), 3000).unref()
  wecomNotificationWorkerTimer = setInterval(() => runWecomOrderNotificationWorkerSafe(), 30000)
  wecomNotificationWorkerTimer.unref()
  console.log("[wecom-order-notification] worker ready", {
    configured: isWecomOrderNotificationEnabled(),
    maxAttempts: WECOM_NOTIFICATION_MAX_ATTEMPTS
  })
}

async function compensateMissingWecomOrderNotifications() {
  if (!pool) return
  const result = await compensateMissingPaidNotifications({
    pool,
    notificationType: WECOM_ORDER_PAID_NOTIFICATION,
    recentHours: 48,
    scanDays: 90,
    limit: 200
  })
  console.log("[wecom-order-notification] compensation", result)
}

function wechatExpressCompanyCode(value) {
  const text = String(value || "").trim().toLowerCase()
  const map = {
    "顺丰": "SF", "顺丰速运": "SF", sf: "SF",
    "中通": "ZTO", "中通快递": "ZTO", zto: "ZTO",
    "圆通": "YTO", "圆通速递": "YTO", yto: "YTO",
    "申通": "STO", "申通快递": "STO", sto: "STO",
    "韵达": "YD", "韵达快递": "YD", yd: "YD",
    "京东": "JD", "京东物流": "JD", jd: "JD",
    "邮政": "EMS", "中国邮政": "EMS", ems: "EMS"
  }
  return map[text] || (/^[A-Z0-9_-]{2,20}$/.test(String(value || "")) ? String(value) : "")
}

function chinaIsoTime(value = new Date()) {
  const date = value instanceof Date ? value : new Date(String(value || "").replace(" ", "T"))
  const safe = Number.isNaN(date.getTime()) ? new Date() : date
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false
  }).formatToParts(safe).reduce((result, item) => ({ ...result, [item.type]: item.value }), {})
  const milliseconds = String(safe.getMilliseconds()).padStart(3, "0")
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}.${milliseconds}+08:00`
}

function maskedShippingContact(value) {
  const digits = normalizePhone(value)
  if (digits.length < 7) return ""
  return `${digits.slice(0, 3)}****${digits.slice(-4)}`
}

function buildWechatFulfillmentPayload(order, node) {
  if (!order.transactionId) throw new Error("订单缺少微信支付交易号，暂不能同步履约")
  if (!order.openid) throw new Error("订单缺少付款人 OpenID，暂不能同步履约")
  const pickup = isPickupOrder(order)
  if (!pickup && node !== "SHIPPED") throw new Error("普通配送订单仅在真实发货后同步")
  const item = {
    item_desc: String(order.productName || "定制商品").replace(/\s+/g, " ").slice(0, 120)
  }
  const contact = maskedShippingContact(order.phone)
  if (contact) item.contact = { receiver_contact: contact }
  if (!pickup) {
    const expressCompany = wechatExpressCompanyCode(order.shippingCompany)
    if (!order.trackingNumber || !expressCompany) throw new Error("真实快递单号或微信支持的快递公司编码不完整")
    item.tracking_no = String(order.trackingNumber).trim()
    item.express_company = expressCompany
  }
  return {
    order_key: { order_number_type: 2, transaction_id: order.transactionId },
    logistics_type: pickup ? 4 : 1,
    delivery_mode: 1,
    is_all_delivered: true,
    shipping_list: [item],
    // WeChat defines this as the API upload time, not the historical
    // fulfillment event time. Generate it at each attempt so delayed retries
    // and safe historical backfills remain valid RFC 3339 timestamps.
    upload_time: chinaIsoTime(new Date()),
    payer: { openid: order.openid }
  }
}

async function enqueueWechatFulfillment(order, node) {
  if (!pool || !order?.id || !node || isOrderRefunded(order)) return false
  const queued = await enqueueFulfillment(pool, order.id, node)
  if (queued) setImmediate(() => runWechatFulfillmentWorkerSafe())
  return queued
}

async function sendWechatFulfillmentRecord(record) {
  const order = (await getOrders({ keyword: record.order_id })).find(item => item.id === record.order_id)
  if (!order) throw new Error("本地订单不存在")
  if (isOrderRefunded(order)) throw new Error("订单已退款，停止同步履约")
  const accessToken = await getAccessToken()
  const payload = buildWechatFulfillmentPayload(order, record.business_node)
  const result = await requestJson(
    `https://api.weixin.qq.com/wxa/sec/order/upload_shipping_info?access_token=${accessToken}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, timeout: 8000 },
    JSON.stringify(payload)
  )
  const errcode = Number(result.data?.errcode || 0)
  if (Number(result.statusCode) < 200 || Number(result.statusCode) >= 300 || errcode !== 0) {
    const error = new Error(`微信履约同步失败：${errcode || result.statusCode} ${String(result.data?.errmsg || "").slice(0, 160)}`)
    error.wechatErrcode = String(errcode || result.statusCode || "")
    throw error
  }
  await query(
    `UPDATE wechat_fulfillment_records
     SET status='SENT', last_error=NULL, wechat_error_code=NULL, sent_at=NOW(),
         next_retry_at=NULL, claim_token=NULL, processing_started_at=NULL, updated_at=NOW()
     WHERE id=:id AND claim_token=:claimToken`,
    { id: record.id, claimToken: record.claim_token }
  )
  await query(
    "UPDATE orders SET wechat_fulfillment_status='SENT', wechat_fulfillment_synced_at=NOW() WHERE id=:orderId",
    { orderId: order.id }
  )
}

async function failWechatFulfillmentRecord(record, error) {
  const attempts = Number(record.attempt_count || 0)
  const terminal = attempts >= 4
  const delays = [1, 5, 15]
  const delay = delays[Math.max(0, attempts - 1)] || 15
  await query(
    `UPDATE wechat_fulfillment_records
     SET status=:status, last_error=:lastError, wechat_error_code=:errorCode,
         next_retry_at=${terminal ? "NULL" : `DATE_ADD(NOW(), INTERVAL ${delay} MINUTE)`},
         claim_token=NULL, processing_started_at=NULL, updated_at=NOW()
     WHERE id=:id AND claim_token=:claimToken`,
    {
      id: record.id,
      claimToken: record.claim_token,
      status: terminal ? "FAILED" : "RETRY",
      lastError: String(error.message || "微信履约同步失败").replace(/access_token=[^&\s]+/g, "access_token=***").slice(0, 500),
      errorCode: String(error.wechatErrcode || "").slice(0, 40)
    }
  )
}

async function runWechatFulfillmentWorker() {
  if (!pool || wechatFulfillmentWorkerRunning) return
  wechatFulfillmentWorkerRunning = true
  try {
    const records = await claimDueFulfillment(pool, { limit: 5, maxAttempts: 4, lockMinutes: 3 })
    for (const record of records) {
      try {
        await sendWechatFulfillmentRecord(record)
      } catch (error) {
        await failWechatFulfillmentRecord(record, error)
        console.error("[wechat-fulfillment]", {
          orderId: record.order_id,
          node: record.business_node,
          error: String(error.message || "").replace(/access_token=[^&\s]+/g, "access_token=***").slice(0, 180)
        })
      }
    }
  } finally {
    wechatFulfillmentWorkerRunning = false
  }
}

function runWechatFulfillmentWorkerSafe() {
  return runWechatFulfillmentWorker().catch(error => {
    console.error("[wechat-fulfillment] worker error", { error: String(error.message || "").slice(0, 180) })
  })
}

function startWechatFulfillmentWorker() {
  if (wechatFulfillmentWorkerTimer) return
  runWechatFulfillmentWorkerSafe()
  wechatFulfillmentWorkerTimer = setInterval(runWechatFulfillmentWorkerSafe, 30000)
  wechatFulfillmentWorkerTimer.unref?.()
}

async function applyShipment(data) {
  const orders = await getOrders()
  const index = orders.findIndex(order => order.id === data.orderId)
  if (index < 0) throw new Error("订单不存在")
  const order = orders[index]
  if (!(order.paymentStatus === "已支付" || order.paidAt || order.transactionId)) throw httpError(400, "订单未支付，不能发货")
  if (order.status === "已发货" || order.shippedAt || order.trackingNumber) throw httpError(400, "订单已发货，请勿重复发货")
  if (["已退款", "已取消", "退款中"].includes(order.status) || ["已退款", "退款中", "退款处理中"].includes(order.paymentStatus) || ["refund_pending", "refunded"].includes(normalizeAfterSalesStatus(order.afterSalesStatus || order.after_sales_status || order.refundStatus))) {
    throw httpError(400, "退款/取消订单不能发货")
  }
  orders[index] = {
    ...order,
    shippingCompany: data.shippingCompany || order.shippingCompany,
    trackingNumber: data.trackingNumber || order.trackingNumber,
    status: "已发货",
    shippedAt: formatDateTime(new Date())
  }
  await saveOrders([orders[index]])
  await recordOrderStateAudit(order, orders[index], {
    source: "admin_ship",
    operatorId: "admin",
    reason: data.reason || "后台发货",
    requestKey: data.requestKey || ""
  })
  await enqueueWechatFulfillment(orders[index], "SHIPPED")
  return orders[index]
}

async function recordOrderStateAudit(previous = {}, next = {}, context = {}) {
  if (!pool || !next.id) return
  const oldLifecycle = lifecycleView(previous)
  const nextLifecycle = lifecycleView(next)
  await query(
    "UPDATE orders SET fulfillment_status=:fulfillmentStatus WHERE id=:orderId",
    { orderId: next.id, fulfillmentStatus: nextLifecycle.fulfillmentStatus || "" }
  )
  await query(
    `INSERT INTO order_state_audit
      (order_id, old_order_status, new_order_status, old_fulfillment_status, new_fulfillment_status,
       old_refund_status, new_refund_status, action_source, operator_id, reason, request_key,
       wechat_sync_result, service_fee_impact, created_at)
     VALUES
      (:orderId, :oldOrderStatus, :newOrderStatus, :oldFulfillmentStatus, :newFulfillmentStatus,
       :oldRefundStatus, :newRefundStatus, :actionSource, :operatorId, :reason, :requestKey,
       :wechatSyncResult, :serviceFeeImpact, NOW())`,
    {
      orderId: next.id,
      oldOrderStatus: previous.status || "",
      newOrderStatus: next.status || "",
      oldFulfillmentStatus: oldLifecycle.fulfillmentStatus || "",
      newFulfillmentStatus: nextLifecycle.fulfillmentStatus || "",
      oldRefundStatus: previous.refundStatus || previous.afterSalesStatus || "",
      newRefundStatus: next.refundStatus || next.afterSalesStatus || "",
      actionSource: context.source || "system",
      operatorId: context.operatorId || "",
      reason: String(context.reason || "").slice(0, 255),
      requestKey: String(context.requestKey || "").slice(0, 100),
      wechatSyncResult: String(context.wechatSyncResult || "").slice(0, 100),
      serviceFeeImpact: String(context.serviceFeeImpact || "").slice(0, 100)
    }
  )
}

async function markOrderArrivedStore(orderId) {
  const orders = await getOrders()
  const index = orders.findIndex(order => order.id === orderId)
  if (index < 0) throw new Error("订单不存在")
  const order = orders[index]
  const blockedReason = pickupArrivedBlockedReason(order)
  if (blockedReason) throw httpError(400, blockedReason === "已通知" ? "该订单已通知客户自提，请勿重复操作" : blockedReason)
  if (!order.pickupCode) {
    order.pickupCode = await generateUniquePickupCode()
    order.pickupQrCodeUrl = await generatePickupQrCode(order.pickupCode)
  }
  const now = formatDateTime(new Date())
  orders[index] = {
    ...order,
    status: "已发货",
    pickupStatus: "arrived_store",
    arrivedStoreAt: order.arrivedStoreAt || now,
    notifiedAt: now,
    notifyStatus: "failed"
  }
  await saveOrders([orders[index]])
  await recordOrderStateAudit(order, orders[index], {
    source: "admin_arrived_store",
    operatorId: "admin",
    reason: "货已到店"
  })
  await enqueueWechatFulfillment(orders[index], "PICKUP_READY")
  const notice = await sendPickupArrivedNotice(orderId)
  orders[index].notifyStatus = notice.ok && !notice.skipped ? "sent" : "failed"
  await saveOrders([orders[index]])
  return orders[index]
}

async function markOrderPickedUp(orderId, options = {}) {
  const orders = await getOrders()
  const index = orders.findIndex(order => order.id === orderId)
  if (index < 0) throw new Error("订单不存在")
  if (orders[index].deliveryType !== "pickup") throw new Error("该订单不是到店自提订单")
  if (!isOrderPaidForPickupCredential(orders[index])) throw new Error("订单未支付，暂不能标记已自提")
  if (!options.force) throw httpError(400, "该订单尚未完成自提核销，不能直接设为已完成。")
  const reason = String(options.reason || "").trim()
  if (!reason) throw httpError(400, "管理员强制核销必须填写原因")
  const previous = { ...orders[index] }
  const now = formatDateTime(new Date())
  orders[index] = {
    ...orders[index],
    status: "已完成",
    pickupStatus: "picked_up",
    pickedUpAt: now,
    pickupVerifiedAt: now,
    pickupVerifiedBy: options.operatorId || "admin",
    forcePickupVerifiedAt: now,
    forcePickupVerifiedBy: options.operatorId || "admin",
    forcePickupReason: reason,
    completedAt: orders[index].completedAt || now
  }
  await saveOrders([orders[index]])
  await createPickupServiceFeeForVerifiedOrder(orders[index])
  await recordOrderStateAudit(previous, orders[index], {
    source: "admin_force_pickup",
    operatorId: options.operatorId || "admin",
    reason,
    requestKey: options.requestKey || "",
    serviceFeeImpact: "自提服务费由预计转为待结算"
  })
  await enqueueWechatFulfillment(orders[index], "PICKUP_READY")
  return orders[index]
}

function isOrderPaidForAfterSales(order = {}) {
  return order.paymentStatus === "已支付" || !!order.transactionId || !!order.paidAt
}

function isOrderRefunded(order = {}) {
  return order.paymentStatus === "已退款" || order.status === "已退款" || order.afterSalesStatus === "refunded" || order.refundStatus === "退款成功"
}

function isOrderCancelledClosedOrRefunded(order = {}) {
  const values = [
    order.status,
    order.paymentStatus,
    order.payment_status,
    order.refundStatus,
    order.refund_status,
    order.afterSalesStatus,
    order.after_sales_status
  ].map(value => String(value || "").trim().toLowerCase()).filter(Boolean)
  const terminalValues = new Set([
    "已取消",
    "已关闭",
    "已退款",
    "cancelled",
    "canceled",
    "closed",
    "refunded",
    "void",
    "voided",
    "退款成功"
  ])
  if (values.some(value => terminalValues.has(value))) return true
  return normalizeAfterSalesStatus(order.afterSalesStatus || order.after_sales_status || order.refundStatus || order.refund_status) === "refunded"
}

function shouldInvalidateStoreSettlementForOrderChange(previous = {}, next = {}) {
  return isOrderPaidForPickupCredential(previous) &&
    !isOrderCancelledClosedOrRefunded(previous) &&
    isOrderCancelledClosedOrRefunded(next)
}

function canApplyAfterSales(order = {}) {
  if (!isOrderPaidForAfterSales(order)) return false
  if (isOrderRefunded(order)) return false
  if (order.paymentStatus === "待报价" || order.status === "待客服确认" || order.status === "待支付") return false
  if (normalizeAfterSalesStatus(order.afterSalesStatus || order.after_sales_status || order.refundStatus) === "rejected") {
    return canReapplyAfterSales(order)
  }
  const status = String(order.status || "")
  const pickupStatus = String(order.pickupStatus || "")
  if (["已发货", "退款中", "制作中", "待发货"].includes(status)) return true
  if (["arrived_store", "picked_up"].includes(pickupStatus)) return true
  if (status === "已完成") {
    const source = order.completedAt || order.pickedUpAt || order.paidAt || order.createdAt
    const completedAt = parseDateValue(source)
    return !!completedAt && Date.now() - completedAt.getTime() <= 7 * 24 * 60 * 60 * 1000
  }
  return false
}

function canReapplyAfterSales(order = {}) {
  const afterSalesStatus = normalizeAfterSalesStatus(order.afterSalesStatus || order.after_sales_status || order.refundStatus)
  const applyCount = Number(order.afterSalesApplyCount || order.after_sales_apply_count || 0)
  if (afterSalesStatus !== "rejected") return false
  if (applyCount >= 2) return false
  if (!isOrderPaidForAfterSales(order) || isOrderRefunded(order)) return false
  return true
}

function normalizeAfterSalesType(value) {
  const text = String(value || "").trim()
  return ["退款", "退货退款", "补发", "重新制作", "仅退款"].includes(text) ? (text === "仅退款" ? "退款" : text) : "退款"
}

function shouldRefundForAfterSales(type) {
  return ["退款", "退货退款"].includes(normalizeAfterSalesType(type))
}

function normalizeAfterSalesImagesInput(value) {
  return normalizeMediaList(value).slice(0, 6)
}

function afterSalesRefundAmount(order, type) {
  if (!shouldRefundForAfterSales(type)) return "0.00"
  return money(order.amount)
}

async function applyAfterSalesRequest(data) {
  const orders = await getOrders()
  const orderId = data.orderId || data.id
  const index = orders.findIndex(order => order.id === orderId)
  if (index < 0) throw new Error("订单不存在")
  if (!orderBelongsToIdentity(orders[index], data)) throw httpError(403, "无权操作该订单")
  if (!canApplyAfterSales(orders[index])) throw httpError(400, "当前订单暂不支持申请售后")
  const currentAfterSalesStatus = normalizeAfterSalesStatus(orders[index].afterSalesStatus || orders[index].refundStatus)
  if (["requested", "approved", "refund_pending"].includes(currentAfterSalesStatus) || ["待审核", "退款处理中", "售后处理中"].includes(orders[index].refundStatus)) {
    throw httpError(400, "该订单已有售后申请，请勿重复提交")
  }
  const type = normalizeAfterSalesType(data.afterSalesType || data.refundType)
  const images = normalizeAfterSalesImagesInput(data.afterSalesImages || data.images || data.refundImageUrl)
  const now = formatDateTime(new Date())
  const refundAmount = afterSalesRefundAmount(orders[index], type)
  const nextApplyCount = Number(orders[index].afterSalesApplyCount || orders[index].after_sales_apply_count || 0) + 1
  orders[index] = {
    ...orders[index],
    status: orders[index].status,
    refundType: type,
    refundStatus: shouldRefundForAfterSales(type) ? "待审核" : "售后处理中",
    refundReason: data.afterSalesReason || data.refundReason || "",
    refundAmount,
    refundRemark: data.afterSalesDesc || data.refundRemark || "",
    refundImageUrl: images[0] || "",
    refundRejectReason: "",
    afterSalesRejectReason: "",
    refundReviewedAt: null,
    afterSalesStatus: "requested",
    afterSalesType: type,
    afterSalesReason: data.afterSalesReason || data.refundReason || "",
    afterSalesDesc: data.afterSalesDesc || data.refundRemark || "",
    afterSalesImages: images,
    afterSalesRequestedAt: now,
    afterSalesHandledAt: null,
    afterSalesApplyCount: nextApplyCount
  }
  await saveOrders([orders[index]])
  return orders[index]
}

async function applyRefundRequest(data) {
  return applyAfterSalesRequest(data)
}

function generateRefundNo(orderId, refundRecordId = "") {
  const clean = String(orderId || "").replace(/[^\w]/g, "")
  const digest = crypto.createHash("sha256").update(`${orderId}:${refundRecordId || crypto.randomUUID()}`).digest("hex").slice(0, 24).toUpperCase()
  return `RF${clean.slice(0, 18)}${digest}`.slice(0, 64)
}

async function applyRefundFinancialReversals(connection, order, refundRecord, refundItems) {
  for (const refundItem of refundItems) {
    const [allocations] = await connection.query(
      `SELECT *
       FROM financial_record_item_allocations
       WHERE order_id=:orderId AND order_item_id=:orderItemId
       FOR UPDATE`,
      { orderId: order.id, orderItemId: refundItem.order_item_id }
    )
    for (const allocation of allocations) {
      const totalQuantity = Math.max(1, Number(allocation.quantity || 1))
      const [quantityRows] = await connection.query(
        `SELECT COALESCE(SUM(ri.refund_quantity),0) AS refunded_quantity,
                COALESCE(SUM(ri.product_refund_cents + ri.discount_refund_cents),0) AS refunded_amount_cents,
                MAX(oi.paid_amount_cents) AS item_paid_amount_cents
         FROM refund_items ri
         JOIN refund_records rr ON rr.id=ri.refund_record_id
         LEFT JOIN order_items oi ON oi.id=ri.order_item_id
         WHERE ri.order_item_id=:orderItemId
           AND ri.status='SUCCESS'
           AND rr.status='SUCCESS'`,
        { orderItemId: refundItem.order_item_id }
      )
      const cumulativeQuantity = Math.min(totalQuantity, Number(quantityRows[0]?.refunded_quantity || 0))
      const cumulativeAmountCents = Number(quantityRows[0]?.refunded_amount_cents || 0)
      const itemPaidAmountCents = Math.max(1, Number(quantityRows[0]?.item_paid_amount_cents || 1))
      if (allocation.ledger_type === "store") {
        const [originalRows] = await connection.query(
          `SELECT * FROM store_settlement_records WHERE id=:id LIMIT 1 FOR UPDATE`,
          { id: allocation.record_id }
        )
        const original = originalRows[0]
        if (!original || !isStoreReferralSettlement(original.type)) continue
        const fixedCommission = String(original.commission_type || "").toLowerCase() === "fixed"
        const targetReversalCents = Math.floor(
          Number(allocation.allocated_amount_cents || 0) *
          (fixedCommission ? cumulativeQuantity / totalQuantity : cumulativeAmountCents / itemPaidAmountCents)
        )
        if (targetReversalCents <= 0) continue
        const [reversedRows] = await connection.query(
          `SELECT COALESCE(SUM(ABS(amount)),0) AS reversed_amount
           FROM store_settlement_records
           WHERE related_record_id=:recordId AND amount<0`,
          { recordId: original.id }
        )
        const alreadyReversedCents = Math.round(Number(reversedRows[0]?.reversed_amount || 0) * 100)
        const deltaCents = Math.max(0, targetReversalCents - alreadyReversedCents)
        if (!deltaCents) continue
        await insertStoreSettlementRecord({
          id: `SSRPR${crypto.createHash("sha256").update(`${refundRecord.id}:${original.id}`).digest("hex").slice(0, 44)}`,
          relatedRecordId: original.id,
          storeId: original.store_id,
          orderId: order.id,
          type: normalizeSettlementStatus(original.status) === "settled" ? "chargeback" : "refund_adjustment",
          amount: centsToYuan(-deltaCents),
          commissionType: original.commission_type || "none",
          commissionValue: original.commission_value || "0.00",
          orderPaidAmount: order.amount,
          status: "unsettled",
          description: `部分退款冲减，退款单：${refundRecord.refund_no}`,
          settleNote: `关联原收益记录：${original.id}`,
          batchId: `partial-refund:${refundRecord.id}`,
          storeOrderType: original.store_order_type || "",
          isStoreMemberOrder: boolValue(original.is_store_member_order),
          storeOperatorUserId: original.store_operator_user_id || "",
          storeOperatorPhone: original.store_operator_phone || "",
          storeOperatorOpenid: original.store_operator_openid || "",
          storeOperatorRole: original.store_operator_role || "",
          storeOperatorName: original.store_operator_name || ""
        }, connection)
      } else if (allocation.ledger_type === "reward") {
        const [originalRows] = await connection.query(
          `SELECT * FROM reward_records WHERE id=:id LIMIT 1 FOR UPDATE`,
          { id: allocation.record_id }
        )
        const original = originalRows[0]
        if (!original || isChargebackRecord(original)) continue
        const targetReversalCents = Math.floor(
          Number(allocation.allocated_amount_cents || 0) * cumulativeAmountCents / itemPaidAmountCents
        )
        if (targetReversalCents <= 0) continue
        const [reversedRows] = await connection.query(
          `SELECT COALESCE(SUM(ABS(amount)),0) AS reversed_amount
           FROM reward_records
           WHERE related_record_id=:recordId AND amount<0`,
          { recordId: original.id }
        )
        const alreadyReversedCents = Math.round(Number(reversedRows[0]?.reversed_amount || 0) * 100)
        const deltaCents = Math.max(0, targetReversalCents - alreadyReversedCents)
        if (!deltaCents) continue
        await insertRewardRecord({
          id: `RWPR${crypto.createHash("sha256").update(`${refundRecord.id}:${original.id}`).digest("hex").slice(0, 46)}`,
          relatedRecordId: original.id,
          orderId: order.id,
          productName: `部分退款冲减：${original.product_name || order.productName}`,
          buyerPhone: original.buyer_phone || order.phone,
          promoterPhone: original.promoter_phone,
          promoterName: original.promoter_name,
          level: original.level,
          type: normalizeRewardStatus(original.status) === "settled" ? "chargeback" : "refund_adjustment",
          amount: centsToYuan(-deltaCents),
          status: "unsettled",
          settleNote: `退款单：${refundRecord.refund_no}，关联原奖励：${original.id}`,
          batchId: `partial-refund:${refundRecord.id}`
        }, connection)
      }
    }
  }

  const [salesRecords] = await connection.query(
    `SELECT * FROM sales_agent_commissions
     WHERE order_id=:orderId AND type='sales_agent_commission'
     FOR UPDATE`,
    { orderId: order.id }
  )
  if (salesRecords.length) {
    const [refundTotals] = await connection.query(
      `SELECT COALESCE(SUM(ri.product_refund_cents + ri.discount_refund_cents),0) AS refunded_amount_cents
       FROM refund_items ri
       JOIN refund_records rr ON rr.id=ri.refund_record_id
       JOIN order_items oi ON oi.id=ri.order_item_id
       WHERE oi.order_id=:orderId
         AND ri.status='SUCCESS'
         AND rr.status='SUCCESS'`,
      { orderId: order.id }
    )
    const cumulativeRefundCents = Math.max(0, Number(refundTotals[0]?.refunded_amount_cents || 0))
    const orderPaidCents = Math.max(1, yuanToCents(order.amount, "订单实付金额"))
    for (const original of salesRecords) {
      const originalCents = Math.round(Math.abs(Number(original.amount || 0)) * 100)
      const targetReversalCents = Math.min(
        originalCents,
        Math.floor(originalCents * cumulativeRefundCents / orderPaidCents)
      )
      if (!targetReversalCents) continue
      const [reversedRows] = await connection.query(
        `SELECT COALESCE(SUM(ABS(amount)),0) AS reversed_amount
         FROM sales_agent_commissions
         WHERE related_record_id=:recordId AND amount<0`,
        { recordId: original.id }
      )
      const alreadyReversedCents = Math.round(Number(reversedRows[0]?.reversed_amount || 0) * 100)
      const deltaCents = Math.max(0, targetReversalCents - alreadyReversedCents)
      if (!deltaCents) continue
      await insertSalesAgentCommission({
        id: `SACPR${crypto.createHash("sha256").update(`${refundRecord.id}:${original.id}`).digest("hex").slice(0, 42)}`,
        businessKey: `sales-reversal:${original.id}:${refundRecord.id}`,
        relatedRecordId: original.id,
        salesAgentId: original.sales_agent_id,
        storeId: original.store_id,
        orderId: order.id,
        orderNo: original.order_no || order.id,
        orderAmount: original.order_amount,
        commissionRate: original.commission_rate,
        commissionAmount: centsToYuan(-deltaCents),
        amount: centsToYuan(-deltaCents),
        type: normalizeSettlementStatus(original.status) === "settled" ? "chargeback" : "refund_adjustment",
        status: "unsettled",
        batchId: `partial-refund:${refundRecord.id}`,
        remark: `部分退款冲减，退款单：${refundRecord.refund_no}，关联原佣金：${original.id}`
      }, connection)
    }
  }
}

async function applyFullRefundPickupFeeImpact(connection, order, refundRecord) {
  const verified = isPickupVerified(order)
  const [rows] = await connection.query(
    `SELECT * FROM store_settlement_records
     WHERE order_id=:orderId AND type='pickup_service_fee'
     FOR UPDATE`,
    { orderId: order.id }
  )
  for (const row of rows) {
    if (verified) {
      await connection.query(
        `UPDATE store_settlement_records
         SET description=CONCAT(COALESCE(description,''),'；退款后保留（已完成真实自提服务）'),
             updated_at=NOW()
         WHERE id=:id`,
        { id: row.id }
      )
      continue
    }
    const [reversedRows] = await connection.query(
      `SELECT COALESCE(SUM(ABS(amount)),0) AS reversed_amount
       FROM store_settlement_records
       WHERE related_record_id=:recordId AND amount<0`,
      { recordId: row.id }
    )
    const originalCents = Math.round(Math.abs(Number(row.amount || 0)) * 100)
    const reversedCents = Math.round(Number(reversedRows[0]?.reversed_amount || 0) * 100)
    const deltaCents = Math.max(0, originalCents - reversedCents)
    if (!deltaCents) continue
    await insertStoreSettlementRecord({
      id: `SSRPF${crypto.createHash("sha256").update(`${refundRecord.id}:${row.id}`).digest("hex").slice(0, 44)}`,
      relatedRecordId: row.id,
      storeId: row.store_id,
      orderId: order.id,
      type: normalizeSettlementStatus(row.status) === "settled" ? "chargeback" : "refund_adjustment",
      amount: centsToYuan(-deltaCents),
      commissionType: row.commission_type || "none",
      commissionValue: row.commission_value || "0.00",
      orderPaidAmount: order.amount,
      status: "unsettled",
      description: `整单退款取消自提服务费，退款单：${refundRecord.refund_no}`,
      settleNote: `关联原自提服务费：${row.id}`,
      batchId: `full-refund:${refundRecord.id}`,
      storeOrderType: row.store_order_type || "",
      isStoreMemberOrder: boolValue(row.is_store_member_order),
      storeOperatorUserId: row.store_operator_user_id || "",
      storeOperatorPhone: row.store_operator_phone || "",
      storeOperatorOpenid: row.store_operator_openid || "",
      storeOperatorRole: row.store_operator_role || "",
      storeOperatorName: row.store_operator_name || ""
    }, connection)
  }
}

async function markRefundSuccess(order, refundData = {}) {
  if (pool && (refundData.out_refund_no || refundData.refundNo)) {
    const refundNo = String(refundData.out_refund_no || refundData.refundNo)
    const connection = await pool.getConnection()
    let resultOrder = null
    let fullRefund = false
    try {
      await connection.beginTransaction()
      const [orderRows] = await connection.query(
        "SELECT * FROM orders WHERE id=:orderId LIMIT 1 FOR UPDATE",
        { orderId: order.id }
      )
      const currentRow = orderRows[0]
      if (!currentRow) throw httpError(404, "订单不存在")
      const [refundRows] = await connection.query(
        "SELECT * FROM refund_records WHERE refund_no=:refundNo LIMIT 1 FOR UPDATE",
        { refundNo }
      )
      const refundRecord = refundRows[0]
      if (!refundRecord) throw httpError(404, "退款记录不存在")
      if (refundRecord.status === "SUCCESS") {
        await connection.commit()
        return (await getOrders({ keyword: order.id })).find(item => item.id === order.id)
      }
      const successAmountCents = Math.min(
        Number(refundRecord.requested_amount_cents || 0),
        Number(refundData.success_amount_cents || refundData.amount?.refund || refundRecord.requested_amount_cents || 0)
      )
      await connection.query(
        `UPDATE refund_records
         SET status='SUCCESS', success_amount_cents=:successAmountCents,
             wechat_refund_id=COALESCE(NULLIF(:wechatRefundId,''),wechat_refund_id),
             success_at=NOW(), updated_at=NOW()
         WHERE id=:id AND status<>'SUCCESS'`,
        {
          id: refundRecord.id,
          successAmountCents,
          wechatRefundId: refundData.refund_id || refundData.refundId || ""
        }
      )
      await connection.query(
        `UPDATE refund_items SET status='SUCCESS', updated_at=NOW()
         WHERE refund_record_id=:refundRecordId AND status<>'SUCCESS'`,
        { refundRecordId: refundRecord.id }
      )
      const [refundItems] = await connection.query(
        "SELECT * FROM refund_items WHERE refund_record_id=:refundRecordId FOR UPDATE",
        { refundRecordId: refundRecord.id }
      )
      await applyRefundFinancialReversals(connection, normalizeOrder({
        ...currentRow,
        productId: currentRow.product_id,
        productName: currentRow.product_name,
        paymentStatus: currentRow.payment_status,
        pickupStatus: currentRow.pickup_status,
        pickupVerifiedAt: currentRow.pickup_verified_at,
        forcePickupVerifiedAt: currentRow.force_pickup_verified_at
      }, 0), refundRecord, refundItems)
      const [sumRows] = await connection.query(
        `SELECT COALESCE(SUM(success_amount_cents),0) AS refunded_cents
         FROM refund_records WHERE order_id=:orderId AND status='SUCCESS'`,
        { orderId: order.id }
      )
      const paidCents = Math.round(Number(currentRow.amount || 0) * 100)
      const refundedCents = Number(sumRows[0]?.refunded_cents || 0)
      fullRefund = paidCents > 0 && refundedCents >= paidCents
      if (fullRefund) {
        await applyFullRefundPickupFeeImpact(connection, normalizeOrder({
          ...currentRow,
          pickupStatus: currentRow.pickup_status,
          pickupVerifiedAt: currentRow.pickup_verified_at,
          forcePickupVerifiedAt: currentRow.force_pickup_verified_at
        }, 0), refundRecord)
      }
      const nextStatus = fullRefund ? "已退款" : currentRow.status
      const nextPaymentStatus = fullRefund ? "已退款" : "部分退款"
      const nextRefundStatus = fullRefund ? "退款成功" : "部分退款"
      const nextAfterSalesStatus = fullRefund ? "refunded" : "partially_refunded"
      await connection.query(
        `UPDATE orders
         SET status=:status, payment_status=:paymentStatus,
             refund_status=:refundStatus, after_sales_status=:afterSalesStatus,
             pickup_status=CASE
               WHEN :fullRefund=1 AND delivery_type='pickup'
                    AND pickup_verified_at IS NULL AND force_pickup_verified_at IS NULL
               THEN 'cancelled' ELSE pickup_status END,
             refund_no=:refundNo,
             refund_id=COALESCE(NULLIF(:refundId,''),refund_id),
             refund_amount=:refundAmount,
             refund_success_at=NOW(), refund_at=NOW(), after_sales_handled_at=NOW()
         WHERE id=:orderId`,
        {
          orderId: order.id,
          status: nextStatus,
          paymentStatus: nextPaymentStatus,
          refundStatus: nextRefundStatus,
          afterSalesStatus: nextAfterSalesStatus,
          fullRefund: fullRefund ? 1 : 0,
          refundNo,
          refundId: refundData.refund_id || refundData.refundId || "",
          refundAmount: centsToYuan(refundedCents)
        }
      )
      const inventoryRefundOrder = {
        ...currentRow,
        status: nextStatus,
        paymentStatus: nextPaymentStatus,
        refundStatus: nextRefundStatus,
        afterSalesStatus: nextAfterSalesStatus
      }
      if (canRestockRefundedInventory(inventoryRefundOrder)) {
        if (fullRefund) {
          await releaseOrderInventory(connection, order.id, {
            reason: "订单全额退款",
            sourceType: "full_refund",
            sourceId: refundRecord.id,
            releaseRemaining: true
          })
        } else {
          for (const refundItem of refundItems) {
            const refundQuantity = Number(refundItem.refund_quantity || 0)
            await releaseOrderItemInventory(connection, {
              orderItemId: refundItem.order_item_id,
              requestedQuantity: refundQuantity,
              businessKey: `refund:${refundRecord.id}:${refundItem.id}:${refundItem.order_item_id}`,
              reason: "订单部分退款",
              sourceType: "partial_refund",
              sourceId: refundRecord.id
            })
          }
        }
      }
      await connection.commit()
      resultOrder = (await getOrders({ keyword: order.id })).find(item => item.id === order.id)
    } catch (error) {
      await connection.rollback().catch(() => {})
      throw error
    } finally {
      connection.release()
    }
    if (fullRefund) await rollbackSalesAgentCommissionsForOrder(order.id)
    return resultOrder
  }
  const orders = await getOrders()
  const index = orders.findIndex(item => item.id === order.id)
  if (index < 0) throw new Error("订单不存在")
  const previous = { ...orders[index] }
  const verifiedPickup = isPickupVerified(previous)
  const now = formatDateTime(new Date())
  orders[index] = {
    ...orders[index],
    status: "已退款",
    paymentStatus: "已退款",
    refundStatus: "退款成功",
    afterSalesStatus: "refunded",
    pickupStatus: isPickupOrder(previous) && !verifiedPickup ? "cancelled" : previous.pickupStatus,
    refundNo: refundData.out_refund_no || refundData.refundNo || orders[index].refundNo || "",
    refundId: refundData.refund_id || refundData.refundId || orders[index].refundId || "",
    refundSuccessAt: now,
    refundAt: now,
    afterSalesHandledAt: orders[index].afterSalesHandledAt || now
  }
  await saveOrders([orders[index]])
  await rollbackRewardsForOrder(order.id)
  await invalidateStoreSettlementRecordsForOrder(order.id)
  await rollbackSalesAgentCommissionsForOrder(order.id)
  await recordOrderStateAudit(previous, orders[index], {
    source: "wechat_refund_confirmed",
    operatorId: "system",
    reason: "微信退款最终状态确认成功",
    serviceFeeImpact: verifiedPickup ? "已核销服务费默认保留" : "未核销预计服务费取消"
  })
  return orders[index]
}

async function requestWechatRefund(order, amountYuan, outRefundNo) {
  if (PAY_MOCK || !IS_PRODUCTION) {
    return {
      refund_id: `MOCKRF${Date.now()}`,
      out_refund_no: outRefundNo,
      status: "PROCESSING",
      mock: true
    }
  }
  if (!order.transactionId && !order.id) throw new Error("订单缺少微信交易号或订单号")
  const total = Math.max(1, Math.round(Number(order.amount || 0) * 100))
  const refund = Math.max(1, Math.round(Number(amountYuan || 0) * 100))
  if (refund > total) throw httpError(400, "退款金额不能超过实付金额")
  const notifyUrl = process.env.WECHAT_REFUND_NOTIFY_URL || `${PUBLIC_BASE_URL}/api/pay/refund/notify`
  const bodyObj = {
    out_refund_no: outRefundNo,
    reason: "售后退款",
    notify_url: notifyUrl,
    amount: { refund, total, currency: "CNY" }
  }
  if (order.transactionId) bodyObj.transaction_id = order.transactionId
  else bodyObj.out_trade_no = order.id
  const body = JSON.stringify(bodyObj)
  const urlPath = "/v3/refund/domestic/refunds"
  const result = await requestJson(`https://api.mch.weixin.qq.com${urlPath}`, {
    method: "POST",
    headers: {
      Authorization: wechatAuthorization("POST", urlPath, body),
      "Content-Type": "application/json",
      Accept: "application/json"
    }
  }, body)
  console.log("[refund] create result", {
    orderId: order.id,
    statusCode: result.statusCode,
    hasRefundId: !!(result.data && result.data.refund_id),
    status: result.data && result.data.status,
    code: result.data && result.data.code,
    message: result.data && result.data.message
  })
  if (result.statusCode < 200 || result.statusCode >= 300) throw httpError(400, result.data.message || "微信退款申请失败")
  return result.data
}

async function approveAfterSalesRefund(orderId, data = {}) {
  const orders = await getOrders()
  const index = orders.findIndex(order => order.id === orderId)
  if (index < 0) throw new Error("订单不存在")
  const order = orders[index]
  if (!isOrderPaidForAfterSales(order)) throw httpError(400, "订单未支付，不能退款")
  if (isOrderRefunded(order)) throw httpError(400, "订单已退款，不能重复退款")
  if (["退款处理中", "processing"].includes(order.refundStatus) || order.afterSalesStatus === "refund_pending") throw httpError(400, "退款正在处理中，请勿重复提交")
  if (!pool) {
    const amount = Math.min(Number(data.refundAmount || order.refundAmount || order.amount || 0), Number(order.amount || 0))
    if (amount !== Number(order.amount || 0)) throw httpError(400, "开发JSON模式仅支持安全整单退款")
    const refundNo = order.refundNo || generateRefundNo(order.id)
    const refund = await requestWechatRefund(order, amount, refundNo)
    const now = formatDateTime(new Date())
    orders[index] = {
      ...order,
      refundStatus: "退款处理中",
      afterSalesStatus: "refund_pending",
      refundAmount: amount.toFixed(2),
      refundNo,
      refundId: refund.refund_id || order.refundId || "",
      refundReviewedAt: now,
      afterSalesHandledAt: now
    }
    await saveOrders([orders[index]])
    return orders[index]
  }
  const activeRows = await query(
    `SELECT id FROM refund_records
     WHERE order_id=:orderId AND status IN ('CREATED','PROCESSING')
     ORDER BY requested_at DESC LIMIT 1`,
    { orderId }
  )
  if (activeRows.length) throw httpError(409, "退款正在处理中，请勿重复提交")
  const itemRows = await query(
    `SELECT id, order_id, product_id, sku_id, product_name, sku_name,
            quantity, paid_amount_cents
     FROM order_items WHERE order_id=:orderId ORDER BY created_at ASC, id ASC`,
    { orderId }
  )
  let validatedItems = []
  if (itemRows.length) {
    const previousRefundItems = await query(
      `SELECT ri.order_item_id, ri.refund_quantity, ri.status
       FROM refund_items ri
       JOIN refund_records rr ON rr.id=ri.refund_record_id
       WHERE rr.order_id=:orderId`,
      { orderId }
    )
    validatedItems = validateRefundItems(itemRows.map(row => ({
      id: row.id,
      productName: row.product_name,
      skuId: row.sku_id,
      quantity: Number(row.quantity || 0),
      paidAmountCents: Number(row.paid_amount_cents || 0)
    })), previousRefundItems, data.refundItems)
  } else {
    const legacyAmountCents = yuanToCents(data.refundAmount || order.refundAmount || order.amount, "退款金额")
    const orderAmountCents = yuanToCents(order.amount, "订单实付金额")
    if (legacyAmountCents !== orderAmountCents) {
      throw httpError(400, "历史订单缺少可靠商品明细，仅支持安全整单退款")
    }
    validatedItems = [{
      orderItemId: `LEGACY:${order.id}`,
      skuId: "",
      refundQuantity: 1,
      productRefundCents: orderAmountCents,
      discountRefundCents: 0,
      shippingRefundCents: 0
    }]
  }
  const shippingRefundCents = data.shippingRefundCents == null
    ? 0
    : Number(data.shippingRefundCents)
  if (!Number.isSafeInteger(shippingRefundCents) || shippingRefundCents < 0) {
    throw httpError(400, "运费退款金额必须使用整数分")
  }
  const refundAmountCents = validatedItems.reduce((sum, item) => sum + item.productRefundCents + item.discountRefundCents, 0) + shippingRefundCents
  const orderAmountCents = yuanToCents(order.amount, "订单实付金额")
  const successfulRows = await query(
    `SELECT COALESCE(SUM(success_amount_cents),0) AS refunded_cents
     FROM refund_records WHERE order_id=:orderId AND status='SUCCESS'`,
    { orderId }
  )
  if (Number(successfulRows[0]?.refunded_cents || 0) + refundAmountCents > orderAmountCents) {
    throw httpError(409, "累计退款金额不能超过订单实付金额")
  }
  const refundRecordId = `RR${crypto.randomUUID().replace(/-/g, "")}`.slice(0, 60)
  const refundNo = generateRefundNo(order.id, refundRecordId)
  const connection = await pool.getConnection()
  try {
    await connection.beginTransaction()
    await connection.query(
      `INSERT INTO refund_records
        (id, order_id, refund_no, requested_amount_cents, shipping_refund_cents,
         status, reason, operator_id, requested_at, updated_at)
       VALUES
        (:id, :orderId, :refundNo, :amount, :shipping, 'CREATED', :reason, :operatorId, NOW(), NOW())`,
      {
        id: refundRecordId,
        orderId,
        refundNo,
        amount: refundAmountCents,
        shipping: shippingRefundCents,
        reason: String(data.refundReason || order.refundReason || "售后退款").slice(0, 255),
        operatorId: String(data.operatorId || "admin").slice(0, 80)
      }
    )
    for (const item of validatedItems) {
      await connection.query(
        `INSERT INTO refund_items
          (id, refund_record_id, order_item_id, sku_id, refund_quantity,
           product_refund_cents, discount_refund_cents, shipping_refund_cents, status)
         VALUES
          (:id, :refundRecordId, :orderItemId, :skuId, :refundQuantity,
           :productRefundCents, :discountRefundCents, :shippingRefundCents, 'PROCESSING')`,
        {
          id: `RI${crypto.randomUUID().replace(/-/g, "")}`.slice(0, 60),
          refundRecordId,
          ...item,
          shippingRefundCents: 0
        }
      )
    }
    const [orderUpdate] = await connection.query(
      `UPDATE orders
       SET refund_status='退款处理中', after_sales_status='refund_pending',
           refund_amount=:refundAmount, refund_no=:refundNo,
           refund_reviewed_at=NOW(), after_sales_handled_at=NOW()
       WHERE id=:orderId
         AND COALESCE(refund_status,'') NOT IN ('退款处理中','退款成功')`,
      { orderId, refundAmount: centsToYuan(refundAmountCents), refundNo }
    )
    if (Number(orderUpdate.affectedRows || 0) !== 1) {
      throw httpError(409, "订单退款状态已变化，请刷新后重试")
    }
    await connection.commit()
  } catch (error) {
    await connection.rollback().catch(() => {})
    throw error
  } finally {
    connection.release()
  }
  let refund
  try {
    refund = await requestWechatRefund(order, centsToYuan(refundAmountCents), refundNo)
  } catch (error) {
    await query(
      `UPDATE refund_records
       SET status='FAILED', updated_at=NOW()
       WHERE id=:id AND status='CREATED'`,
      { id: refundRecordId }
    )
    await query(
      `UPDATE refund_items SET status='FAILED', updated_at=NOW()
       WHERE refund_record_id=:id AND status='PROCESSING'`,
      { id: refundRecordId }
    )
    await query(
      `UPDATE orders
       SET refund_status='退款失败', after_sales_status='requested'
       WHERE id=:orderId AND refund_no=:refundNo`,
      { orderId, refundNo }
    )
    throw error
  }
  await query(
    `UPDATE refund_records
     SET status='PROCESSING', wechat_refund_id=:refundId, updated_at=NOW()
     WHERE id=:id AND status='CREATED'`,
    { id: refundRecordId, refundId: refund.refund_id || "" }
  )
  const now = formatDateTime(new Date())
  await query(
    `UPDATE orders
     SET refund_id=:refundId, refund_reviewed_at=:now, after_sales_handled_at=:now
     WHERE id=:orderId AND refund_no=:refundNo`,
    {
      orderId,
      refundNo,
      refundId: refund.refund_id || "",
      now: toMysqlDatetime(now)
    }
  )
  return (await getOrders({ keyword: orderId })).find(item => item.id === orderId)
}

function restoreOrderStatusAfterSalesReject(order = {}) {
  if (order.pickupStatus === "picked_up" || order.status === "已完成") return "已完成"
  if (order.status === "已发货" || order.pickupStatus === "arrived_store") return "已发货"
  if (order.status === "制作中") return "制作中"
  if (order.paymentStatus === "已支付" || order.paidAt || order.transactionId) return "待发货"
  return order.status && !["退款中", "售后处理中"].includes(order.status) ? order.status : "待发货"
}

async function rejectAfterSales(orderId, rejectReason = "") {
  const orders = await getOrders()
  const index = orders.findIndex(order => order.id === orderId)
  if (index < 0) throw new Error("订单不存在")
  const order = orders[index]
  const restoredStatus = restoreOrderStatusAfterSalesReject(order)
  const now = formatDateTime(new Date())
  orders[index] = {
    ...order,
    status: restoredStatus,
    refundStatus: "none",
    refundRejectReason: rejectReason || "售后申请未通过",
    afterSalesRejectReason: rejectReason || "售后申请未通过",
    refundReviewedAt: now,
    afterSalesStatus: "rejected",
    afterSalesHandledAt: now
  }
  await saveOrders([orders[index]])
  return orders[index]
}

async function convertAfterSales(orderId, type) {
  const orders = await getOrders()
  const index = orders.findIndex(order => order.id === orderId)
  if (index < 0) throw new Error("订单不存在")
  const nextType = normalizeAfterSalesType(type)
  orders[index] = {
    ...orders[index],
    status: orders[index].status === "退款中" ? "制作中" : orders[index].status,
    refundStatus: nextType === "补发" ? "补发处理中" : "重新制作中",
    afterSalesStatus: nextType === "补发" ? "reship" : "remake",
    afterSalesType: nextType,
    afterSalesHandledAt: formatDateTime(new Date())
  }
  await saveOrders([orders[index]])
  return orders[index]
}

async function reviewRefund(data) {
  const action = data.action || "approve"
  if (action === "reject") return rejectAfterSales(data.orderId, data.rejectReason)
  if (action === "resend") return convertAfterSales(data.orderId, "补发")
  if (action === "remake") return convertAfterSales(data.orderId, "重新制作")
  return approveAfterSalesRefund(data.orderId, data)
}

async function rollbackRewardsForOrderMysql(orderId) {
  const connection = await pool.getConnection()
  try {
    await connection.beginTransaction()
    const [rows] = await connection.query(
      `SELECT * FROM reward_records
       WHERE order_id=:orderId AND type NOT LIKE '%chargeback%'
       FOR UPDATE`,
      { orderId }
    )
    for (const row of rows) {
      if (normalizeRewardStatus(row.status) === "settled") {
        await insertRewardRecord({
          id: `RW${orderId}CHARGEBACK${row.level || 0}${crypto.createHash("md5").update(row.id).digest("hex").slice(0, 8)}`,
          relatedRecordId: row.id,
          orderId,
          productName: `订单退款冲正：${row.product_name || orderId}`,
          buyerPhone: row.buyer_phone,
          promoterPhone: row.promoter_phone,
          promoterName: row.promoter_name,
          level: row.level,
          type: "chargeback",
          amount: money(-Math.abs(Number(row.amount || 0))),
          status: "unsettled",
          settleNote: `订单退款冲正，关联原订单号：${orderId}，原奖励记录：${row.id}`,
          batchId: `refund-chargeback:${row.id}`
        }, connection)
      } else {
        await connection.query(
          `UPDATE reward_records
           SET status='cancelled',
               cancel_reason=COALESCE(NULLIF(cancel_reason,''),'订单退款成功，推广奖励失效'),
               updated_at=NOW()
           WHERE id=:id AND status IN ('pending_confirm','unsettled','pending')`,
          { id: row.id }
        )
      }
    }
    await connection.commit()
    return rows.length
  } catch (error) {
    await connection.rollback().catch(() => {})
    throw error
  } finally {
    connection.release()
  }
}

async function rollbackRewardsForOrder(orderId) {
  if (pool) return await rollbackRewardsForOrderMysql(orderId)
  const records = await getRewardRecords()
  let changed = false
  const now = formatDateTime(new Date())
  const hasChargebackFor = record => records.some(item =>
    isChargebackRecord(item) &&
    item.orderId === record.orderId &&
    normalizePhone(item.promoterPhone) === normalizePhone(record.promoterPhone) &&
    Number(item.level || 0) === Number(record.level || 0) &&
    (item.batchId === `refund-chargeback:${record.id}` || item.settleNote?.includes(record.id))
  )
  for (const record of records) {
    if (record.orderId !== orderId || isChargebackRecord(record)) continue
    if (record.status === "settled") {
      if (!hasChargebackFor(record)) {
        records.unshift(normalizeRewardRecord({
          id: `RW${orderId}CHARGEBACK${record.level || 0}${crypto.createHash("md5").update(record.id).digest("hex").slice(0, 8)}`,
          orderId,
          productName: `订单退款冲正：${record.productName || orderId}`,
          buyerPhone: record.buyerPhone,
          promoterPhone: record.promoterPhone,
          promoterName: record.promoterName,
          level: record.level,
          type: "chargeback",
          amount: money(-Math.abs(Number(record.amount || 0))),
          status: "unsettled",
          settleNote: `订单退款冲正，关联原订单号：${orderId}，原奖励记录：${record.id}`,
          batchId: `refund-chargeback:${record.id}`,
          createdAt: now,
          updatedAt: now
        }, records.length))
        changed = true
      }
      continue
    }
    if (record.status !== "cancelled") {
      record.status = "cancelled"
      record.cancelReason = record.cancelReason || "订单退款成功，推广奖励失效"
      record.updatedAt = now
      changed = true
    }
  }
  if (changed) await saveRewardRecords(records)
  return records
}

async function invalidateStoreSettlementRecordsForOrderMysql(orderId, options = {}) {
  const connection = await pool.getConnection()
  try {
    await connection.beginTransaction()
    const [orders] = await connection.query(
      `SELECT id, delivery_type, pickup_status, pickup_verified_at, force_pickup_verified_at
       FROM orders WHERE id=:orderId FOR UPDATE`,
      { orderId }
    )
    const retainVerifiedPickupFee = !!orders[0] &&
      isPickupVerified(orders[0]) &&
      !options.chargebackVerifiedPickupFee
    const [rows] = await connection.query(
      `SELECT * FROM store_settlement_records
       WHERE order_id=:orderId AND type <> 'chargeback'
       FOR UPDATE`,
      { orderId }
    )
    for (const row of rows) {
      if (retainVerifiedPickupFee && isPickupServiceSettlement(row.type)) {
        await connection.query(
          `UPDATE store_settlement_records
           SET description=CONCAT(
             REPLACE(COALESCE(description,''),'；退款后保留',''),
             '；退款后保留（已完成真实自提服务）'
           ), updated_at=NOW()
           WHERE id=:id`,
          { id: row.id }
        )
        continue
      }
      if (normalizeSettlementStatus(row.status) === "settled") {
        await insertStoreSettlementRecord({
          id: `SSR${orderId}CHARGEBACK${crypto.createHash("md5").update(row.id).digest("hex").slice(0, 10)}`,
          relatedRecordId: row.id,
          storeId: row.store_id,
          orderId,
          type: "chargeback",
          amount: money(-Math.abs(Number(row.amount || 0))),
          commissionType: "none",
          commissionValue: "0.00",
          orderPaidAmount: row.order_paid_amount || "0.00",
          status: "unsettled",
          description: `订单退款冲正，关联原订单号：${orderId}`,
          settleNote: `订单退款冲正，关联原订单号：${orderId}，原收益记录：${row.id}`,
          batchId: `refund-chargeback:${row.id}`,
          storeOrderType: row.store_order_type || "",
          isStoreMemberOrder: boolValue(row.is_store_member_order),
          storeOperatorUserId: row.store_operator_user_id || "",
          storeOperatorPhone: row.store_operator_phone || "",
          storeOperatorOpenid: row.store_operator_openid || "",
          storeOperatorRole: row.store_operator_role || "",
          storeOperatorName: row.store_operator_name || ""
        }, connection)
      } else {
        await connection.query(
          `UPDATE store_settlement_records
           SET status='cancelled',
               cancel_reason=COALESCE(NULLIF(cancel_reason,''),'订单退款成功，结算失效'),
               description=CONCAT(COALESCE(description,''),'；订单退款成功，结算失效'),
               updated_at=NOW()
           WHERE id=:id AND status IN ('pending_confirm','unsettled','pending')`,
          { id: row.id }
        )
      }
    }
    await connection.commit()
    return rows.length
  } catch (error) {
    await connection.rollback().catch(() => {})
    throw error
  } finally {
    connection.release()
  }
}

async function invalidateStoreSettlementRecordsForOrder(orderId, options = {}) {
  if (pool) return await invalidateStoreSettlementRecordsForOrderMysql(orderId, options)
  const records = await getStoreSettlementRecords()
  const order = (await getOrders({ keyword: orderId })).find(item => item.id === orderId)
  const retainVerifiedPickupFee = !!order && isPickupVerified(order) && !options.chargebackVerifiedPickupFee
  let changed = false
  const now = formatDateTime(new Date())
  const hasChargebackFor = record => records.some(item =>
    isChargebackRecord(item) &&
    item.orderId === record.orderId &&
    item.storeId === record.storeId &&
    (item.batchId === `refund-chargeback:${record.id}` || item.settleNote?.includes(record.id))
  )
  for (const record of records) {
    if (record.orderId !== orderId || isChargebackRecord(record)) continue
    if (retainVerifiedPickupFee && isPickupServiceSettlement(record.type)) {
      record.description = `${String(record.description || "").replace(/；退款后保留/g, "")}；退款后保留（已完成真实自提服务）`
      record.updatedAt = now
      changed = true
      continue
    }
    if (record.status === "settled") {
      if (!hasChargebackFor(record)) {
        records.unshift(normalizeSettlementRecord({
          id: `SSR${orderId}CHARGEBACK${crypto.createHash("md5").update(record.id).digest("hex").slice(0, 10)}`,
          storeId: record.storeId,
          orderId,
          type: "chargeback",
          amount: money(-Math.abs(Number(record.amount || 0))),
          commissionType: "none",
          commissionValue: "0.00",
          orderPaidAmount: record.orderPaidAmount || "0.00",
          status: "unsettled",
          description: `订单退款冲正，关联原订单号：${orderId}，原收益类型：${isStoreReferralSettlement(record.type) ? "推广佣金" : isPickupServiceSettlement(record.type) ? "自提服务费" : record.type}`,
          settleNote: `订单退款冲正，关联原订单号：${orderId}，原收益记录：${record.id}`,
          batchId: `refund-chargeback:${record.id}`,
          storeOrderType: record.storeOrderType || "",
          isStoreMemberOrder: record.isStoreMemberOrder || false,
          storeOperatorUserId: record.storeOperatorUserId || "",
          storeOperatorPhone: record.storeOperatorPhone || "",
          storeOperatorOpenid: record.storeOperatorOpenid || "",
          storeOperatorRole: record.storeOperatorRole || "",
          storeOperatorName: record.storeOperatorName || "",
          createdAt: now,
          updatedAt: now
        }, records.length))
        changed = true
      }
      continue
    }
    if (record.status !== "cancelled") {
      record.status = "cancelled"
      record.cancelReason = record.cancelReason || "订单退款成功，结算失效"
      record.description = `${record.description || ""}；订单退款成功，结算失效`.trim()
      record.settledAt = now
      changed = true
    }
  }
  if (changed) await saveStoreSettlementRecords(records)
  return records
}

async function confirmOrderRewards(orderId) {
  const order = (await getOrders()).find(item => item.id === orderId)
  if (!order || !isOrderRewardConfirmed(order) || isOrderRefunded(order)) return { changed: false }
  if (pool) {
    const connection = await pool.getConnection()
    try {
      await connection.beginTransaction()
      const [rewardResult] = await connection.query(
        `UPDATE reward_records
         SET status='unsettled', release_at=COALESCE(release_at,NOW()), updated_at=NOW()
         WHERE order_id=:orderId AND status='pending_confirm'`,
        { orderId }
      )
      const [settlementResult] = await connection.query(
        `UPDATE store_settlement_records
         SET status='unsettled', updated_at=NOW()
         WHERE order_id=:orderId AND status='pending_confirm'`,
        { orderId }
      )
      const [salesResult] = await connection.query(
        `UPDATE sales_agent_commissions
         SET status='unsettled'
         WHERE order_id=:orderId AND status='pending_confirm'`,
        { orderId }
      )
      await connection.commit()
      return {
        changed: [rewardResult, settlementResult, salesResult]
          .some(result => Number(result.affectedRows || 0) > 0)
      }
    } catch (error) {
      await connection.rollback().catch(() => {})
      throw error
    } finally {
      connection.release()
    }
  }
  const now = formatDateTime(new Date())
  let changed = false
  const rewardRecords = await getRewardRecords()
  for (const record of rewardRecords) {
    if (record.orderId !== orderId || isChargebackRecord(record)) continue
    if (record.status === "pending_confirm") {
      record.status = "unsettled"
      record.releaseAt = record.releaseAt || now
      record.updatedAt = now
      changed = true
    }
  }
  if (changed) await saveRewardRecords(rewardRecords)

  let settlementChanged = false
  const settlementRecords = await getStoreSettlementRecords()
  for (const record of settlementRecords) {
    if (record.orderId !== orderId || isChargebackRecord(record)) continue
    if (record.status === "pending_confirm") {
      record.status = "unsettled"
      record.updatedAt = now
      settlementChanged = true
    }
  }
  if (settlementChanged) await saveStoreSettlementRecords(settlementRecords)
  const salesCommissionResult = await confirmSalesAgentCommissions(orderId)
  if (changed || settlementChanged) {
    console.log("[settlement-confirm] order rewards confirmed", { orderId, rewardChanged: changed, settlementChanged, salesCommissionChanged: !!salesCommissionResult.changed })
  }
  return { changed: changed || settlementChanged || salesCommissionResult.changed }
}

async function getCustomers() {
  if (!pool) return readJsonFile(customersFile, []).map(normalizeCustomer)
  const rows = await query("SELECT * FROM customers ORDER BY last_contact DESC, id ASC")
  return rows.map(row => ({
    id: row.id,
    name: row.name,
    nickname: row.nickname || row.name || "",
    phone: row.phone || "",
    openid: row.openid || "",
    avatarUrl: row.avatar_url || "",
    wechat: row.wechat || "",
    orders: Number(row.orders || 0),
    totalAmount: String(row.total_amount || "0"),
    lastContact: row.last_contact ? new Date(row.last_contact).toISOString().slice(0, 10) : "",
    inviteCode: row.invite_code || inviteCodeFor(row.phone),
    shoppingMoney: String(row.shopping_money || "0")
  }))
}

async function saveCustomers(customers) {
  const list = customers.map(normalizeCustomer)
  if (!pool) {
    writeJsonFile(customersFile, list)
    return list
  }
  for (const customer of list) {
    await query(
      `INSERT INTO customers (id, name, nickname, phone, openid, avatar_url, wechat, orders, total_amount, last_contact, invite_code, shopping_money)
       VALUES (:id, :name, :nickname, :phone, :openid, :avatarUrl, :wechat, :orders, :totalAmount, :lastContact, :inviteCode, :shoppingMoney)
       ON DUPLICATE KEY UPDATE name = VALUES(name), nickname = VALUES(nickname), openid = VALUES(openid), avatar_url = VALUES(avatar_url), wechat = VALUES(wechat), orders = VALUES(orders), total_amount = VALUES(total_amount), last_contact = VALUES(last_contact), invite_code = VALUES(invite_code), shopping_money = VALUES(shopping_money)`,
      { ...customer, lastContact: customer.lastContact || null }
    )
  }
  return list
}

async function getUserProfile(identity = {}) {
  const current = requestIdentity(identity)
  if (!current.phone && !current.openid) throw httpError(401, "请先完成微信登录")
  const customers = await getCustomers()
  const customer = customers.find(item => (current.phone && item.phone === current.phone) || (current.openid && item.openid === current.openid))
  return {
    phone: current.phone || customer?.phone || "",
    openid: current.openid || customer?.openid || "",
    avatarUrl: customer?.avatarUrl || "",
    nickname: customer?.nickname || customer?.name || ""
  }
}

async function saveUserProfile(identity = {}, data = {}) {
  const current = requestIdentity(identity)
  if (!current.phone && !current.openid) throw httpError(401, "请先完成微信登录")
  const customers = await getCustomers()
  const index = customers.findIndex(item => (current.phone && item.phone === current.phone) || (current.openid && item.openid === current.openid))
  const existing = index >= 0 ? customers[index] : normalizeCustomer({
    id: `C${Date.now()}${crypto.randomBytes(2).toString("hex").toUpperCase()}`,
    phone: current.phone,
    openid: current.openid,
    name: data.nickname || "微信用户"
  }, customers.length)
  const next = normalizeCustomer({
    ...existing,
    phone: existing.phone || current.phone,
    openid: existing.openid || current.openid,
    name: data.nickname || existing.name || existing.nickname || "微信用户",
    nickname: data.nickname || existing.nickname || existing.name || "微信用户",
    avatarUrl: data.avatarUrl || existing.avatarUrl || ""
  }, index >= 0 ? index : customers.length)
  if (index >= 0) customers[index] = next
  else customers.push(next)
  await saveCustomers(customers)
  return {
    phone: next.phone,
    openid: next.openid,
    avatarUrl: next.avatarUrl,
    nickname: next.nickname || next.name
  }
}

async function ensureCustomerFromOrder(order) {
  if (!order.phone) return null
  const customers = await getCustomers()
  const index = customers.findIndex(customer => customer.phone === order.phone)
  if (index >= 0) {
    customers[index] = {
      ...customers[index],
      name: customers[index].name || order.customerName,
      orders: Number(customers[index].orders || 0) + 1,
      totalAmount: String((Number(customers[index].totalAmount || 0) + Number(order.amount || 0)).toFixed(2)),
      lastContact: new Date().toISOString().slice(0, 10)
    }
  } else {
    customers.push(normalizeCustomer({
      id: `C${Date.now()}${crypto.randomBytes(2).toString("hex").toUpperCase()}`,
      name: order.customerName,
      phone: order.phone,
      orders: 1,
      totalAmount: order.amount,
      lastContact: new Date().toISOString().slice(0, 10)
    }, customers.length))
  }
  await saveCustomers(customers)
  return customers.find(customer => customer.phone === order.phone)
}

async function getPromotionRelations() {
  if (!pool) return readJsonFile(promotionRelationsFile, []).map(normalizePromotionRelation)
  const rows = await query("SELECT * FROM promotion_relations ORDER BY created_at DESC")
  return rows.map(row => normalizePromotionRelation({
    id: row.id,
    inviterPhone: row.inviter_phone,
    inviterName: row.inviter_name,
    inviterCode: row.inviter_code,
    inviteePhone: row.invitee_phone,
    inviteeName: row.invitee_name,
    level: row.level,
    createdAt: row.created_at ? formatDateTime(new Date(row.created_at)) : ""
  }, 0))
}

async function savePromotionRelations(relations) {
  const list = relations.map(normalizePromotionRelation)
  if (!pool) {
    writeJsonFile(promotionRelationsFile, list)
    return list
  }
  const seenInvitees = new Set()
  for (const relation of list) {
    const invitee = normalizePhone(relation.inviteePhone)
    if (!invitee || seenInvitees.has(invitee)) throw httpError(409, "同一用户不能存在多条推荐关系")
    seenInvitees.add(invitee)
  }
  if (findCircularPromotionRelations(list).length) throw httpError(409, "推广关系存在循环，禁止保存")
  const connection = await pool.getConnection()
  try {
    await connection.beginTransaction()
    const [lockRows] = await connection.query("SELECT GET_LOCK('promotion_relations_admin_write', 5) AS acquired")
    if (Number(lockRows[0]?.acquired || 0) !== 1) throw httpError(409, "推广关系正在被其他管理员修改，请稍后重试")
    for (const relation of list) {
      const inviteePhone = normalizePhone(relation.inviteePhone)
      const [claimRows] = await connection.query(
        "SELECT relation_id FROM promotion_relation_claims WHERE invitee_phone=:inviteePhone FOR UPDATE",
        { inviteePhone }
      )
      if (claimRows[0] && claimRows[0].relation_id !== relation.id) {
        throw httpError(409, "该用户已绑定推荐关系，不能通过批量编辑覆盖")
      }
      await connection.query(
        `INSERT IGNORE INTO promotion_relation_claims (invitee_phone, relation_id, created_at)
         VALUES (:inviteePhone, :id, NOW())`,
        { id: relation.id, inviteePhone }
      )
      await connection.query(
        `INSERT INTO promotion_relations
          (id, inviter_phone, inviter_name, inviter_code, invitee_phone, invitee_name, level, created_at)
         VALUES
          (:id, :inviterPhone, :inviterName, :inviterCode, :inviteePhone, :inviteeName, :level, :createdAt)
         ON DUPLICATE KEY UPDATE
          inviter_phone=VALUES(inviter_phone), inviter_name=VALUES(inviter_name),
          inviter_code=VALUES(inviter_code), invitee_phone=VALUES(invitee_phone),
          invitee_name=VALUES(invitee_name), level=VALUES(level)`,
        { ...relation, createdAt: toMysqlDatetime(relation.createdAt, nowMysqlDatetime()) }
      )
    }
    await connection.commit()
  } catch (error) {
    await connection.rollback().catch(() => {})
    throw error
  } finally {
    await connection.query("SELECT RELEASE_LOCK('promotion_relations_admin_write')").catch(() => {})
    connection.release()
  }
  return list
}

async function recordPromotionVisit(data = {}) {
  const invite = String(data.invite || data.inviterCode || "").trim()
  const visitorId = String(data.visitorId || data.localUserId || "").trim()
  if (!invite || !visitorId) return null
  if (!pool) {
    const visits = readJsonFile(promotionVisitsFile, [])
    const exists = visits.some(item => item.invite === invite && item.visitorId === visitorId)
    if (!exists) {
      visits.push({ id: `PV${Date.now()}${crypto.randomBytes(2).toString("hex").toUpperCase()}`, invite, visitorId, createdAt: formatDateTime(new Date()) })
      writeJsonFile(promotionVisitsFile, visits)
    }
    return visits
  }
  await query(
    "INSERT IGNORE INTO promotion_visits (id, invite, visitor_id, created_at) VALUES (:id, :invite, :visitorId, :createdAt)",
    { id: `PV${Date.now()}${crypto.randomBytes(2).toString("hex").toUpperCase()}`, invite, visitorId, createdAt: nowMysqlDatetime() }
  )
  return { invite, visitorId }
}

async function getPromotionVisits() {
  if (!pool) return readJsonFile(promotionVisitsFile, [])
  return await query("SELECT * FROM promotion_visits ORDER BY created_at DESC")
}

const CIRCULAR_PROMOTION_MESSAGE = "该推广关系已存在或会形成循环，不能绑定"

function relationParentMap(relations = []) {
  const map = new Map()
  for (const relation of relations) {
    const invitee = normalizePhone(relation.inviteePhone)
    const inviter = normalizePhone(relation.inviterPhone)
    if (invitee && inviter && !map.has(invitee)) map.set(invitee, relation)
  }
  return map
}

function promotionAncestorChain(phone, relations = [], options = {}) {
  const startPhone = normalizePhone(phone)
  const parentMap = relationParentMap(relations)
  const seen = new Set()
  const chain = []
  let current = startPhone
  let circularAt = ""
  const maxDepth = Number(options.maxDepth || 50)
  for (let depth = 0; current && depth < maxDepth; depth += 1) {
    if (seen.has(current)) {
      circularAt = current
      break
    }
    seen.add(current)
    const relation = parentMap.get(current)
    if (!relation) break
    const parentPhone = normalizePhone(relation.inviterPhone)
    if (!parentPhone) break
    chain.push({ phone: parentPhone, relation })
    current = parentPhone
  }
  return { chain, circular: !!circularAt, circularAt }
}

function getPersonalReferralChain(phone, relations = []) {
  const buyerPhone = normalizePhone(phone)
  const ancestors = promotionAncestorChain(buyerPhone, relations)
  const directPhone = normalizePhone(ancestors.chain[0]?.phone)
  const parentPhone = normalizePhone(ancestors.chain[1]?.phone)
  return {
    directPhone: directPhone && directPhone !== buyerPhone ? directPhone : "",
    parentPhone: parentPhone && parentPhone !== buyerPhone && parentPhone !== directPhone ? parentPhone : "",
    circular: ancestors.circular,
    circularAt: ancestors.circularAt,
    chain: ancestors.chain
  }
}

function promotionBindError(strict) {
  if (strict) throw httpError(400, CIRCULAR_PROMOTION_MESSAGE)
  return null
}

function validatePromotionBind({ inviterPhone, inviteePhone, relations = [], strict = true }) {
  const parentPhone = normalizePhone(inviterPhone)
  const childPhone = normalizePhone(inviteePhone)
  if (!parentPhone || !childPhone) return promotionBindError(strict)
  if (parentPhone === childPhone) return promotionBindError(strict)
  const existing = relations.find(relation => normalizePhone(relation.inviteePhone) === childPhone)
  if (existing) return promotionBindError(strict)
  const inviterAncestors = promotionAncestorChain(parentPhone, relations)
  if (inviterAncestors.circular || inviterAncestors.chain.some(item => normalizePhone(item.phone) === childPhone)) {
    return promotionBindError(strict)
  }
  return true
}

function findCircularPromotionRelations(relations = []) {
  const cycles = []
  const seenKeys = new Set()
  for (const relation of relations) {
    const inviteePhone = normalizePhone(relation.inviteePhone)
    if (!inviteePhone) continue
    const ancestors = promotionAncestorChain(inviteePhone, relations)
    if (!ancestors.circular) continue
    const involvedPhones = ancestors.chain.map(item => normalizePhone(item.phone)).filter(Boolean)
    involvedPhones.unshift(inviteePhone)
    const uniquePhones = [...new Set(involvedPhones)]
    const key = uniquePhones.slice().sort().join(">")
    if (seenKeys.has(key)) continue
    seenKeys.add(key)
    const involvedSet = new Set(uniquePhones)
    const involvedRelations = relations.filter(item => involvedSet.has(normalizePhone(item.inviterPhone)) && involvedSet.has(normalizePhone(item.inviteePhone)))
    cycles.push({ phones: uniquePhones, relations: involvedRelations })
  }
  return cycles
}

function promotionCyclePublicView(cycle = {}) {
  return {
    phones: cycle.phones || [],
    relations: (cycle.relations || []).map(relation => ({
      id: relation.id,
      inviter: relation.inviterPhone,
      invitee: relation.inviteePhone,
      level: relation.level,
      createdAt: relation.createdAt,
      inviterName: relation.inviterName,
      inviteeName: relation.inviteeName
    }))
  }
}

async function bindPromotionFromOrder(order) {
  return bindPromotionRelation(order.inviterCode, order.phone, order.customerName, false)
}

async function bindPromotionRelation(inviterCode, inviteePhone, inviteeName = "微信用户", strict = true) {
  inviteePhone = normalizePhone(inviteePhone)
  if (!inviterCode || !inviteePhone) {
    if (strict) throw httpError(400, "缺少邀请关系参数")
    return null
  }
  const customers = await getCustomers()
  const inviter = customers.find(customer => customer.inviteCode === inviterCode)
  if (!inviter) {
    if (strict) throw httpError(400, "邀请码不存在")
    return null
  }
  if (normalizePhone(inviter.phone) === inviteePhone) {
    return promotionBindError(strict)
  }
  if (!pool) {
    const relations = await getPromotionRelations()
    const validation = validatePromotionBind({ inviterPhone: inviter.phone, inviteePhone, relations, strict })
    if (!validation) return null
    const existing = relations.find(relation => normalizePhone(relation.inviteePhone) === inviteePhone)
    if (existing) return promotionBindError(strict)
    const relation = normalizePromotionRelation({
      inviterPhone: inviter.phone,
      inviterName: inviter.name,
      inviterCode: inviter.inviteCode,
      inviteePhone,
      inviteeName,
      level: 1
    }, relations.length)
    relations.unshift(relation)
    await savePromotionRelations(relations)
    return relation
  }
  const relation = normalizePromotionRelation({
    inviterPhone: inviter.phone,
    inviterName: inviter.name,
    inviterCode: inviter.inviteCode,
    inviteePhone,
    inviteeName,
    level: 1
  }, 0)
  const connection = await pool.getConnection()
  try {
    await connection.beginTransaction()
    const [existingRows] = await connection.query(
      "SELECT * FROM promotion_relations WHERE invitee_phone=:inviteePhone LIMIT 1 FOR UPDATE",
      { inviteePhone }
    )
    if (existingRows.length) {
      await connection.rollback()
      return promotionBindError(strict)
    }
    let cursor = normalizePhone(inviter.phone)
    const visited = new Set()
    for (let depth = 0; cursor && depth < 50; depth += 1) {
      if (cursor === inviteePhone || visited.has(cursor)) {
        await connection.rollback()
        return promotionBindError(strict)
      }
      visited.add(cursor)
      const [parentRows] = await connection.query(
        `SELECT inviter_phone FROM promotion_relations
         WHERE invitee_phone=:phone LIMIT 1 FOR UPDATE`,
        { phone: cursor }
      )
      cursor = normalizePhone(parentRows[0]?.inviter_phone || "")
    }
    await connection.query(
      `INSERT INTO promotion_relation_claims (invitee_phone, relation_id, created_at)
       VALUES (:inviteePhone, :id, NOW())`,
      { inviteePhone, id: relation.id }
    )
    await connection.query(
      `INSERT INTO promotion_relations
        (id, inviter_phone, inviter_name, inviter_code, invitee_phone, invitee_name, level, created_at)
       VALUES
        (:id, :inviterPhone, :inviterName, :inviterCode, :inviteePhone, :inviteeName, :level, :createdAt)`,
      { ...relation, createdAt: toMysqlDatetime(relation.createdAt, nowMysqlDatetime()) }
    )
    await connection.commit()
    return relation
  } catch (error) {
    await connection.rollback().catch(() => {})
    if (error?.code === "ER_DUP_ENTRY") return promotionBindError(strict)
    throw error
  } finally {
    connection.release()
  }
}

async function getRewardRules() {
  const products = await getProducts()
  const existing = pool
    ? (await query("SELECT * FROM reward_rules ORDER BY product_name ASC")).map(row => normalizeRewardRule({
      id: row.id,
      productId: row.product_id,
      productName: row.product_name,
      firstReward: row.first_reward,
      secondReward: row.second_reward
    }, 0))
    : readJsonFile(rewardRulesFile, []).map(normalizeRewardRule)
  const merged = products.map(product => {
    const rule = existing.find(item => item.productId === product.id || item.productName === product.name)
    return normalizeRewardRule({
      id: rule?.id || product.id,
      productId: product.id,
      productName: product.name,
      firstReward: product.rewardEnabled === "false" ? "0" : (product.firstReward || rule?.firstReward || "0"),
      secondReward: product.rewardEnabled === "false" ? "0" : (product.secondReward || rule?.secondReward || "0")
    }, 0)
  })
  return merged
}

async function saveRewardRules(rules) {
  const list = rules.map(normalizeRewardRule)
  if (!pool) {
    writeJsonFile(rewardRulesFile, list)
    return list
  }
  await query("DELETE FROM reward_rules")
  for (const rule of list) {
    await query(
      "INSERT INTO reward_rules (id, product_id, product_name, first_reward, second_reward) VALUES (:id, :productId, :productName, :firstReward, :secondReward)",
      rule
    )
  }
  return list
}

async function getRewardRecords() {
  if (!pool) return readJsonFile(rewardRecordsFile, []).map(normalizeRewardRecord)
  const rows = await query("SELECT * FROM reward_records ORDER BY created_at DESC")
  return rows.map(row => normalizeRewardRecord({
    id: row.id,
    orderId: row.order_id,
    productName: row.product_name,
    buyerPhone: row.buyer_phone,
    promoterPhone: row.promoter_phone,
    promoterName: row.promoter_name,
    level: row.level,
    amount: row.amount,
    type: row.type,
    status: row.status,
    releaseAt: row.release_at ? formatDateTime(new Date(row.release_at)) : "",
    settledAt: row.settled_at ? formatDateTime(new Date(row.settled_at)) : "",
    settledBy: row.settled_by || "",
    settleNote: row.settle_note || "",
    cancelReason: row.cancel_reason || "",
    batchId: row.batch_id || "",
    createdAt: row.created_at ? formatDateTime(new Date(row.created_at)) : "",
    updatedAt: row.updated_at ? formatDateTime(new Date(row.updated_at)) : ""
  }, 0))
}

async function saveRewardRecords(records) {
  const list = records.map(normalizeRewardRecord)
  if (!pool) {
    writeJsonFile(rewardRecordsFile, list)
    return list
  }
  for (const record of list) {
    await query(
      `INSERT INTO reward_records
        (id, business_key, related_record_id, order_id, product_name, buyer_phone,
         promoter_phone, promoter_name, level, amount, type, status, release_at,
         settled_at, settled_by, settle_note, cancel_reason, batch_id, created_at, updated_at)
       VALUES
        (:id, :businessKey, :relatedRecordId, :orderId, :productName, :buyerPhone,
         :promoterPhone, :promoterName, :level, :amount, :type, :status, :releaseAt,
         :settledAt, :settledBy, :settleNote, :cancelReason, :batchId, :createdAt, :updatedAt)
       ON DUPLICATE KEY UPDATE
         status=VALUES(status),
         release_at=VALUES(release_at),
         settled_at=VALUES(settled_at),
         settled_by=VALUES(settled_by),
         settle_note=VALUES(settle_note),
         cancel_reason=VALUES(cancel_reason),
         batch_id=VALUES(batch_id),
         updated_at=VALUES(updated_at)`,
      {
        ...record,
        businessKey: rewardBusinessKey(record),
        relatedRecordId: record.relatedRecordId || "",
        releaseAt: toMysqlDatetime(record.releaseAt),
        settledAt: toMysqlDatetime(record.settledAt),
        createdAt: toMysqlDatetime(record.createdAt, nowMysqlDatetime()),
        updatedAt: toMysqlDatetime(record.updatedAt, nowMysqlDatetime())
      }
    )
  }
  return list
}

function rewardBusinessKey(record = {}) {
  if (record.relatedRecordId && isChargebackRecord(record)) {
    return `chargeback:${record.relatedRecordId}:${record.batchId || record.id}`
  }
  return `${record.orderId}:${normalizePhone(record.promoterPhone)}:${Number(record.level || 1)}:${record.type || "level1"}`
}

async function insertRewardRecord(record, connection = null) {
  const normalized = normalizeRewardRecord(record, 0)
  const params = {
    ...normalized,
    businessKey: rewardBusinessKey(normalized),
    relatedRecordId: normalized.relatedRecordId || "",
    releaseAt: toMysqlDatetime(normalized.releaseAt),
    settledAt: toMysqlDatetime(normalized.settledAt),
    createdAt: toMysqlDatetime(normalized.createdAt, nowMysqlDatetime()),
    updatedAt: toMysqlDatetime(normalized.updatedAt, nowMysqlDatetime())
  }
  const sql = `INSERT IGNORE INTO reward_records
    (id, business_key, related_record_id, order_id, product_name, buyer_phone,
     promoter_phone, promoter_name, level, amount, type, status, release_at,
     settled_at, settled_by, settle_note, cancel_reason, batch_id, created_at, updated_at)
   VALUES
    (:id, :businessKey, :relatedRecordId, :orderId, :productName, :buyerPhone,
     :promoterPhone, :promoterName, :level, :amount, :type, :status, :releaseAt,
     :settledAt, :settledBy, :settleNote, :cancelReason, :batchId, :createdAt, :updatedAt)`
  if (connection) {
    const [result] = await connection.query(sql, params)
    return Number(result.affectedRows || 0) === 1
  }
  const result = await query(sql, params)
  return Number(result.affectedRows || 0) === 1
}

async function createRewardsForOrder(order, connection = null) {
  const normalized = normalizeOrder(order, 0)
  if (!isOrderPaidForPickupCredential(normalized) || isOrderRefunded(normalized)) return []
  if (normalized.referrerStoreId) return []
  const existing = pool ? [] : await getRewardRecords()
  const relations = await getPromotionRelations()
  const customers = await getCustomers()
  const buyerPhone = normalizePhone(normalized.phone)
  const relationChain = getPersonalReferralChain(buyerPhone, relations)
  if (relationChain.circular) {
    console.warn("[promotion-cycle-reward-skip-parent]", { orderId: normalized.id, buyerPhone, circularAt: relationChain.circularAt })
  }
  const directPhone = normalizePhone(normalized.referrerUserId) || relationChain.directPhone
  if (!directPhone) return existing
  const rawParentPhone = normalizePhone(normalized.parentReferrerUserId) || relationChain.parentPhone
  const parentPhone = rawParentPhone && rawParentPhone !== buyerPhone && rawParentPhone !== directPhone ? rawParentPhone : ""
  const rules = await getRewardRules()
  const rule = rules.find(item => item.productId === normalized.productId || item.productName === normalized.productName) || normalizeRewardRule({ productName: normalized.productName, firstReward: "0", secondReward: "0" }, 0)
  const firstRewardAmount = Number(rule.firstReward) > 0 ? money(rule.firstReward) : money(Number(normalized.amount || 0) * 0.05)
  const secondRewardAmount = Number(rule.secondReward) > 0 ? money(rule.secondReward) : "0.00"
  const makeRecord = (promoterPhone, level, amount) => {
    const promoter = customers.find(customer => normalizePhone(customer.phone) === normalizePhone(promoterPhone)) || {}
    return normalizeRewardRecord({
      id: `RW${normalized.id}${level}`,
      orderId: normalized.id,
      productName: normalized.productName,
      buyerPhone: normalized.phone,
      promoterPhone,
      promoterName: promoter.name || "",
      level,
      type: level === 2 ? "level2" : "level1",
      amount,
      status: "pending_confirm",
      releaseAt: "",
      createdAt: formatDateTime(new Date())
    }, existing.length)
  }
  const next = [...existing]
  const hasReward = (promoterPhone, level) => next.some(record =>
    record.orderId === normalized.id &&
    normalizePhone(record.promoterPhone) === normalizePhone(promoterPhone) &&
    Number(record.level || 1) === Number(level) &&
    record.type !== "adjustment"
  )
  const candidates = []
  if (Number(firstRewardAmount) > 0 && !hasReward(directPhone, 1)) candidates.push(makeRecord(directPhone, 1, firstRewardAmount))
  if (parentPhone && Number(secondRewardAmount) > 0 && !hasReward(parentPhone, 2)) candidates.push(makeRecord(parentPhone, 2, secondRewardAmount))
  if (pool) {
    for (const record of candidates) {
      await insertRewardRecord(record, connection)
      await ensureFinancialItemAllocations({
        ledgerType: "reward",
        recordId: record.id,
        orderId: normalized.id,
        amountCents: yuanToCents(record.amount, "推广奖励")
      }, connection)
    }
    if (connection) return candidates
    const rows = await query("SELECT * FROM reward_records WHERE order_id=:orderId ORDER BY created_at DESC", {
      orderId: normalized.id
    })
    return rows.map((row, index) => normalizeRewardRecord({
      ...row,
      orderId: row.order_id,
      productName: row.product_name,
      buyerPhone: row.buyer_phone,
      promoterPhone: row.promoter_phone,
      promoterName: row.promoter_name,
      releaseAt: row.release_at,
      settledAt: row.settled_at,
      settledBy: row.settled_by,
      settleNote: row.settle_note,
      cancelReason: row.cancel_reason,
      batchId: row.batch_id,
      relatedRecordId: row.related_record_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }, index))
  }
  next.unshift(...candidates)
  await saveRewardRecords(next)
  return next
}

async function ensureReferralRewardRecords() {
  const orders = await getOrders()
  let storeOrdersChecked = 0
  let personalOrdersChecked = 0
  let invalidatedOrders = 0
  for (const order of orders) {
    if (isOrderRefunded(order)) {
      await rollbackRewardsForOrder(order.id)
      await invalidateStoreSettlementRecordsForOrder(order.id)
      invalidatedOrders += 1
      continue
    }
    if (!isOrderPaidForPickupCredential(order)) continue
    if (order.referrerStoreId) {
      if (!pool) await createStoreReferralCommissionForOrder(order)
      storeOrdersChecked += 1
    }
    if (!order.referrerStoreId && (order.referrerUserId || order.parentReferrerUserId || order.inviterCode)) {
      if (!pool) await createRewardsForOrder(order)
      personalOrdersChecked += 1
    }
    if (isOrderRewardConfirmed(order)) await confirmOrderRewards(order.id)
  }
  console.log("[referral-settlement-backfill]", {
    paidStoreReferralOrdersChecked: storeOrdersChecked,
    paidPersonalReferralOrdersChecked: personalOrdersChecked,
    refundedOrdersInvalidated: invalidatedOrders
  })
}

async function processRewardState() {
  if (pool) {
    await query(
      `UPDATE reward_records r
       INNER JOIN orders o ON o.id=r.order_id
       SET r.status='unsettled',
           r.release_at=COALESCE(r.release_at,DATE_ADD(COALESCE(o.completed_at,NOW()),INTERVAL 7 DAY)),
           r.updated_at=NOW()
       WHERE r.status='pending_confirm'
         AND (
           o.status IN ('已完成','completed')
           OR (
             o.pickup_status IN ('picked_up','pickedup','已自提')
             AND (o.pickup_verified_at IS NOT NULL OR o.force_pickup_verified_at IS NOT NULL)
           )
         )`
    )
    return await getRewardRecords()
  }
  const orders = await getOrders()
  const records = await getRewardRecords()
  let changed = false
  const now = new Date()
  for (const record of records) {
    const order = orders.find(item => item.id === record.orderId)
    if (!order) continue
    const refunded = order.status === "已退款" || order.paymentStatus === "已退款" || order.afterSalesStatus === "refunded"
    if (refunded && record.status !== "cancelled") {
      if (record.status === "settled") continue
      record.status = "cancelled"
      record.cancelReason = record.cancelReason || "订单已退款，推广奖励失效"
      record.updatedAt = formatDateTime(now)
      changed = true
      continue
    }
    if (record.status === "pending_confirm" && isOrderRewardConfirmed(order)) {
      record.status = "unsettled"
      record.releaseAt = record.releaseAt || addDays(order.completedAt || now, 7)
      record.updatedAt = formatDateTime(now)
      changed = true
    } else if (record.status === "unsettled" && isOrderRewardConfirmed(order) && !record.releaseAt) {
      record.releaseAt = addDays(order.completedAt || now, 7)
      record.updatedAt = formatDateTime(now)
      changed = true
    }
  }
  if (changed) await saveRewardRecords(records)
  return records
}

async function getPromotionSummary(phone) {
  phone = normalizePhone(phone)
  const customers = await getCustomers()
  const customer = customers.find(item => normalizePhone(item.phone) === phone) || normalizeCustomer({ phone, name: "微信用户" }, 0)
  const relations = await getPromotionRelations()
  const records = await processRewardState()
  const invited = relations.filter(item => normalizePhone(item.inviterPhone) === phone)
  const orders = await getOrders()
  const inviteCode = customer.inviteCode || inviteCodeFor(phone)
  const myRewards = records
    .filter(item => normalizePhone(item.promoterPhone) === phone)
    .map(item => decorateRewardRecord(item, orders))
  const rewardSummary = buildSettlementSummary(myRewards.filter(item => item.status !== "cancelled"), orders)
  const rewardOrderIds = new Set(myRewards.filter(item => item.orderId).map(item => item.orderId))
  const rewardOrders = orders.filter(order => rewardOrderIds.has(order.id) && !order.referrerStoreId)
  const inviteAmount = rewardOrders.reduce((sum, order) => sum + Number(order.amount || 0), 0)
  return {
    profile: {
      name: customer.name,
      phone,
      inviteCode,
      shoppingMoney: rewardSummary.settledTotal,
      pendingReward: rewardSummary.payableTotal,
      ...rewardSummary,
      inviteCount: invited.length,
      inviteOrderCount: rewardOrderIds.size,
      inviteAmount: inviteAmount.toFixed(2),
      inviteQrUrl: "",
      inviteQrText: `非常智造 邀请码：${inviteCode}`
    },
    invited,
    rewards: myRewards,
    orders: rewardOrders
  }
}

async function getSettings() {
  const normalize = settings => {
    const categoryCatalog = updateActiveCategoryTree(settings.categoryCatalog)
    return {
      ...settings,
      categoryCatalog,
      newcomerBenefitsEnabled: String(settings.newcomerBenefitsEnabled == null ? "true" : settings.newcomerBenefitsEnabled) === "false" ? "false" : "true",
      newcomerBenefits: normalizeNewcomerBenefits(settings),
      helpArticles: normalizeHelpArticles(settings.helpArticles),
      ...normalizeContactSettings(settings)
    }
  }
  if (!pool) return normalize(readJsonFile(settingsFile, {}))
  const rows = await query("SELECT data FROM system_settings WHERE id = 1")
  return normalize(parseJsonValue(rows[0]?.data, {}))
}

async function saveSettings(settings) {
  const categoryCatalog = updateActiveCategoryTree(settings.categoryCatalog)
  settings = {
    ...settings,
    categoryCatalog,
    newcomerBenefitsEnabled: String(settings.newcomerBenefitsEnabled == null ? "true" : settings.newcomerBenefitsEnabled) === "false" ? "false" : "true",
    newcomerBenefits: normalizeNewcomerBenefits(settings),
    helpArticles: normalizeHelpArticles(settings.helpArticles),
    ...normalizeContactSettings(settings)
  }
  if (!pool) {
    writeJsonFile(settingsFile, settings)
    const home = await getHome()
    home.contact = {
      ...home.contact,
      phone: settings.servicePhone || home.contact.phone,
      wechat: settings.serviceWechat || home.contact.wechat,
      workWechatUrl: settings.workWechatUrl || home.contact.workWechatUrl
    }
    writeJsonFile(homeFile, home)
    return settings
  }
  await query("UPDATE system_settings SET data = :data WHERE id = 1", { data: JSON.stringify(settings) })
  const home = await getHome()
  home.contact = {
    ...home.contact,
    phone: settings.servicePhone || home.contact.phone,
    wechat: settings.serviceWechat || home.contact.wechat,
    workWechatUrl: settings.workWechatUrl || home.contact.workWechatUrl
  }
  await saveHome(home)
  return settings
}

async function getNewcomerBenefits(query = {}) {
  const settings = await getSettings()
  const benefits = String(settings.newcomerBenefitsEnabled) === "false" ? [] : normalizeNewcomerBenefits(settings).filter(item => item.enabled)
  const orders = await getOrders()
  const phone = String(query.phone || "").trim()
  const openid = String(query.openid || "").trim()
  const phoneHasOrder = !!phone && orders.some(order => order.phone === phone && (order.paidAt || order.paymentStatus === "已支付" || order.paymentStatus === "已退款"))
  const openidHasOrder = !!openid && orders.some(order => order.openid === openid && (order.paidAt || order.paymentStatus === "已支付" || order.paymentStatus === "已退款"))
  const eligible = benefits.length > 0 && !phoneHasOrder && !openidHasOrder
  return { eligible, benefits: eligible ? benefits : [], reason: eligible ? "" : "仅限新人首单" }
}

async function initDb() {
  assertProductionPaymentConfig()
  if (STORAGE_MODE === "json") {
    if (IS_PRODUCTION) throw new Error("生产环境禁止 JSON 数据存储")
    console.log("本地开发模式：已显式启用 JSON 数据存储。")
    return
  }
  if (!mysql) throw new Error("缺少 mysql2；如需本地 JSON 模式，请显式设置 STORAGE_MODE=json")
  if (process.env.MYSQL_TEST_DATABASE_READY !== "true") {
    const rootPool = mysql.createPool({ ...dbConfig, database: undefined })
    await rootPool.query(`CREATE DATABASE IF NOT EXISTS \`${dbConfig.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`)
    await rootPool.end()
  }
  pool = mysql.createPool(dbConfig)
  await query(`CREATE TABLE IF NOT EXISTS home_config (
    id INT PRIMARY KEY,
    data JSON NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  )`)
  await query(`CREATE TABLE IF NOT EXISTS products (
    id VARCHAR(32) PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    intro VARCHAR(255),
    price DECIMAL(10,2) NOT NULL DEFAULT 0,
    cost_price DECIMAL(10,2) DEFAULT 0,
    badge VARCHAR(30),
    cover VARCHAR(30),
    image_url VARCHAR(500),
    gallery_images JSON,
    video_url VARCHAR(500),
    detail_images JSON,
    detail_text TEXT,
    product_type VARCHAR(20) DEFAULT 'custom',
    categories JSON,
    status VARCHAR(20) DEFAULT 'on',
    stock INT DEFAULT 0,
    is_hot VARCHAR(10) DEFAULT 'false',
    promotion_hot VARCHAR(10) DEFAULT 'false',
    ai_preview_enabled VARCHAR(10) DEFAULT 'false',
    ai_preview_type VARCHAR(30),
    reward_enabled VARCHAR(10) DEFAULT 'true',
    first_reward DECIMAL(10,2) DEFAULT 0,
    second_reward DECIMAL(10,2) DEFAULT 0,
    sort_order INT DEFAULT 0,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  )`)
  await ensureColumn("products", "categories", "JSON")
  await ensureColumn("products", "status", "VARCHAR(20) DEFAULT 'on'")
  await ensureColumn("products", "stock", "INT DEFAULT 0")
  await ensureColumn("products", "stock_mode", "VARCHAR(30)")
  await ensureColumn("products", "inventory_version", "INT NOT NULL DEFAULT 0")
  await ensureColumn("products", "cost_price", "DECIMAL(10,2) DEFAULT 0")
  await ensureColumn("products", "is_hot", "VARCHAR(10) DEFAULT 'false'")
  await ensureColumn("products", "promotion_hot", "VARCHAR(10) DEFAULT 'false'")
  await ensureColumn("products", "ai_preview_enabled", "VARCHAR(10) DEFAULT 'false'")
  await ensureColumn("products", "ai_preview_type", "VARCHAR(30)")
  await ensureColumn("products", "reward_enabled", "VARCHAR(10) DEFAULT 'true'")
  await ensureColumn("products", "first_reward", "DECIMAL(10,2) DEFAULT 0")
  await ensureColumn("products", "second_reward", "DECIMAL(10,2) DEFAULT 0")
  await ensureColumn("products", "gallery_images", "JSON")
  await ensureColumn("products", "video_url", "VARCHAR(500)")
  await ensureColumn("products", "detail_images", "JSON")
  await ensureColumn("products", "detail_text", "TEXT")
  await ensureColumn("products", "product_type", "VARCHAR(20) DEFAULT 'custom'")
  await ensureColumn("products", "model_candidate_id", "VARCHAR(60)")
  await ensureColumn("products", "model_source_url", "VARCHAR(500)")
  await ensureColumn("products", "model_author_name", "VARCHAR(100)")
  await ensureColumn("products", "model_authorization_status", "VARCHAR(40)")
  await ensureColumn("products", "model_authorization_note", "TEXT")
  await query(`CREATE TABLE IF NOT EXISTS orders (
    id VARCHAR(32) PRIMARY KEY,
    customer_name VARCHAR(50) NOT NULL,
    phone VARCHAR(30),
    product_name VARCHAR(100),
    amount DECIMAL(10,2),
    status VARCHAR(30),
    payment_status VARCHAR(30) DEFAULT '待支付',
    transaction_id VARCHAR(80),
    openid VARCHAR(80),
    user_id VARCHAR(80),
    user_token VARCHAR(120),
    address VARCHAR(255),
    custom_request TEXT,
    original_image_url VARCHAR(500),
    original_image_urls JSON,
    ai_preview_url VARCHAR(500),
    final_design_url VARCHAR(500),
    category VARCHAR(80),
    is_custom_order VARCHAR(10) DEFAULT 'false',
    remark TEXT,
    product_id VARCHAR(32),
    inviter_code VARCHAR(32),
    shipping_company VARCHAR(80),
    tracking_number VARCHAR(80),
    shipped_at DATETIME,
    refund_type VARCHAR(30),
    refund_status VARCHAR(30),
    refund_reason VARCHAR(255),
    refund_amount DECIMAL(10,2),
    refund_remark TEXT,
    refund_image_url VARCHAR(500),
    refund_reject_reason VARCHAR(255),
    refund_reviewed_at DATETIME,
    after_sales_status VARCHAR(30),
    after_sales_type VARCHAR(30),
    after_sales_reason VARCHAR(255),
    after_sales_desc TEXT,
    after_sales_images JSON,
    after_sales_requested_at DATETIME,
    after_sales_handled_at DATETIME,
    refund_no VARCHAR(80),
    refund_id VARCHAR(120),
    refund_success_at DATETIME,
    created_at DATETIME,
    payment_expires_at DATETIME,
    stock_reserved_at DATETIME,
    stock_released_at DATETIME,
    paid_at DATETIME,
    completed_at DATETIME,
    refund_at DATETIME
  )`)
  await ensureColumn("orders", "payment_status", "VARCHAR(30) DEFAULT '待支付'")
  await ensureColumn("orders", "transaction_id", "VARCHAR(80)")
  await ensureColumn("orders", "openid", "VARCHAR(80)")
  await ensureColumn("orders", "user_id", "VARCHAR(80)")
  await ensureColumn("orders", "user_token", "VARCHAR(120)")
  await ensureColumn("orders", "custom_request", "TEXT")
  await ensureColumn("orders", "original_image_url", "VARCHAR(500)")
  await ensureColumn("orders", "original_image_urls", "JSON")
  await ensureColumn("orders", "ai_preview_url", "VARCHAR(500)")
  await ensureColumn("orders", "final_design_url", "VARCHAR(500)")
  await ensureColumn("orders", "category", "VARCHAR(80)")
  await ensureColumn("orders", "is_custom_order", "VARCHAR(10) DEFAULT 'false'")
  await ensureColumn("orders", "product_id", "VARCHAR(32)")
  await ensureColumn("orders", "inviter_code", "VARCHAR(32)")
  await ensureColumn("orders", "shipping_company", "VARCHAR(80)")
  await ensureColumn("orders", "tracking_number", "VARCHAR(80)")
  await ensureColumn("orders", "shipped_at", "DATETIME")
  await ensureColumn("orders", "refund_type", "VARCHAR(30)")
  await ensureColumn("orders", "refund_status", "VARCHAR(30)")
  await ensureColumn("orders", "refund_reason", "VARCHAR(255)")
  await ensureColumn("orders", "refund_amount", "DECIMAL(10,2)")
  await ensureColumn("orders", "refund_remark", "TEXT")
  await ensureColumn("orders", "refund_image_url", "VARCHAR(500)")
  await ensureColumn("orders", "refund_reject_reason", "VARCHAR(255)")
  await ensureColumn("orders", "refund_reviewed_at", "DATETIME")
  await ensureColumn("orders", "after_sales_status", "VARCHAR(30)")
  await ensureColumn("orders", "after_sales_type", "VARCHAR(30)")
  await ensureColumn("orders", "after_sales_reason", "VARCHAR(255)")
  await ensureColumn("orders", "after_sales_desc", "TEXT")
  await ensureColumn("orders", "after_sales_images", "JSON")
  await ensureColumn("orders", "after_sales_requested_at", "DATETIME")
  await ensureColumn("orders", "after_sales_handled_at", "DATETIME")
  await ensureColumn("orders", "after_sales_reject_reason", "VARCHAR(255)")
  await ensureColumn("orders", "after_sales_apply_count", "INT DEFAULT 0")
  await ensureColumn("orders", "refund_no", "VARCHAR(80)")
  await ensureColumn("orders", "refund_id", "VARCHAR(120)")
  await ensureColumn("orders", "refund_success_at", "DATETIME")
  await ensureColumn("orders", "paid_at", "DATETIME")
  await ensureColumn("orders", "payment_expires_at", "DATETIME")
  await ensureColumn("orders", "stock_reserved_at", "DATETIME")
  await ensureColumn("orders", "stock_released_at", "DATETIME")
  await ensureIndex("orders", "idx_orders_payment_timeout", "INDEX", ["payment_status", "payment_expires_at"])
  await ensureColumn("orders", "completed_at", "DATETIME")
  await ensureColumn("orders", "refund_at", "DATETIME")
  await ensureColumn("orders", "delivery_type", "VARCHAR(20) DEFAULT 'delivery'")
  await ensureColumn("orders", "pickup_store_id", "VARCHAR(40)")
  await ensureColumn("orders", "pickup_code", "VARCHAR(20)")
  await ensureColumn("orders", "pickup_qrcode_url", "VARCHAR(500)")
  await ensureColumn("orders", "pickup_status", "VARCHAR(30) DEFAULT 'none'")
  await ensureColumn("orders", "notify_status", "VARCHAR(30)")
  await ensureColumn("orders", "notified_at", "DATETIME")
  await ensureColumn("orders", "arrived_store_at", "DATETIME")
  await ensureColumn("orders", "picked_up_at", "DATETIME")
  await ensureColumn("orders", "pickup_verified_at", "DATETIME")
  await ensureColumn("orders", "pickup_verified_by", "VARCHAR(80)")
  await ensureColumn("orders", "user_latitude", "DECIMAL(10,6)")
  await ensureColumn("orders", "user_longitude", "DECIMAL(10,6)")
  await ensureColumn("orders", "pickup_distance", "DECIMAL(10,2)")
  await ensureColumn("orders", "referrer_store_id", "VARCHAR(40)")
  await query(`CREATE TABLE IF NOT EXISTS pickup_code_claims (
    code VARCHAR(20) PRIMARY KEY,
    order_id VARCHAR(40) NOT NULL,
    created_at DATETIME NOT NULL,
    UNIQUE KEY uniq_pickup_code_order (order_id)
  )`)
  await query(
    `INSERT IGNORE INTO pickup_code_claims (code, order_id, created_at)
     SELECT UPPER(pickup_code), id, COALESCE(created_at, NOW())
     FROM orders
     WHERE pickup_code IS NOT NULL
       AND pickup_code <> ''
       AND CHAR_LENGTH(pickup_code) = 6`
  )
  await ensureColumn("orders", "source_type", "VARCHAR(30)")
  await ensureColumn("orders", "source_store_id", "VARCHAR(40)")
  await ensureColumn("orders", "source_store_code", "VARCHAR(80)")
  await ensureColumn("orders", "store_order_type", "VARCHAR(30)")
  await ensureColumn("orders", "is_store_member_order", "VARCHAR(10) DEFAULT 'false'")
  await ensureColumn("orders", "store_operator_user_id", "VARCHAR(80)")
  await ensureColumn("orders", "store_operator_phone", "VARCHAR(30)")
  await ensureColumn("orders", "store_operator_openid", "VARCHAR(80)")
  await ensureColumn("orders", "store_operator_role", "VARCHAR(20)")
  await ensureColumn("orders", "store_operator_name", "VARCHAR(80)")
  await ensureColumn("orders", "referrer_user_id", "VARCHAR(40)")
  await ensureColumn("orders", "parent_referrer_user_id", "VARCHAR(40)")
  await ensureColumn("orders", "supplier_store_id", "VARCHAR(40)")
  await ensureColumn("orders", "referral_commission", "DECIMAL(10,2) DEFAULT 0")
  await ensureColumn("orders", "pickup_service_fee", "DECIMAL(10,2) DEFAULT 0")
  await ensureColumn("orders", "supplier_settlement_amount", "DECIMAL(10,2) DEFAULT 0")
  await ensureColumn("orders", "custom_commission_amount", "DECIMAL(10,2) DEFAULT 0")
  await ensureColumn("orders", "store_settlement_status", "VARCHAR(30) DEFAULT 'pending_confirm'")
  await ensureColumn("orders", "store_attribution_id", "VARCHAR(60)")
  await ensureColumn("orders", "fulfillment_status", "VARCHAR(40)")
  await ensureColumn("orders", "wechat_fulfillment_status", "VARCHAR(30)")
  await ensureColumn("orders", "wechat_fulfillment_synced_at", "DATETIME")
  await ensureColumn("orders", "force_pickup_verified_at", "DATETIME")
  await ensureColumn("orders", "force_pickup_verified_by", "VARCHAR(80)")
  await ensureColumn("orders", "force_pickup_reason", "VARCHAR(255)")
  await query(`CREATE TABLE IF NOT EXISTS user_sessions (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    token_hash CHAR(64) NOT NULL,
    openid VARCHAR(80) NOT NULL,
    phone VARCHAR(30),
    created_at DATETIME NOT NULL,
    expires_at DATETIME NOT NULL,
    updated_at DATETIME NOT NULL,
    UNIQUE KEY uniq_user_session_token (token_hash),
    INDEX idx_user_session_openid (openid),
    INDEX idx_user_session_expiry (expires_at)
  )`)
  await query(`CREATE TABLE IF NOT EXISTS order_request_keys (
    request_key VARCHAR(100) PRIMARY KEY,
    order_id VARCHAR(32) NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_order_request_order (order_id)
  )`)
  await query(`CREATE TABLE IF NOT EXISTS order_idempotency_keys (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id VARCHAR(80) NOT NULL,
    operation VARCHAR(40) NOT NULL,
    request_key VARCHAR(100) NOT NULL,
    request_hash CHAR(64) NOT NULL,
    order_id VARCHAR(32) NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME NOT NULL,
    UNIQUE KEY uniq_order_idempotency_scope (user_id, operation, request_key),
    INDEX idx_order_idempotency_order (order_id),
    INDEX idx_order_idempotency_expiry (expires_at)
  )`)
  await query(`CREATE TABLE IF NOT EXISTS order_state_audit (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    order_id VARCHAR(32) NOT NULL,
    old_order_status VARCHAR(40),
    new_order_status VARCHAR(40),
    old_fulfillment_status VARCHAR(40),
    new_fulfillment_status VARCHAR(40),
    old_refund_status VARCHAR(40),
    new_refund_status VARCHAR(40),
    action_source VARCHAR(40),
    operator_id VARCHAR(80),
    reason VARCHAR(255),
    request_key VARCHAR(100),
    wechat_sync_result VARCHAR(100),
    service_fee_impact VARCHAR(100),
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_order_state_audit_order (order_id, created_at)
  )`)
  await query(`CREATE TABLE IF NOT EXISTS order_payment_facts (
    id VARCHAR(64) PRIMARY KEY,
    order_id VARCHAR(32) NOT NULL,
    transaction_id VARCHAR(80),
    payment_state VARCHAR(30) NOT NULL,
    amount_verified TINYINT(1) NOT NULL DEFAULT 0,
    verified_at DATETIME,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_payment_fact_transaction (transaction_id),
    INDEX idx_payment_fact_order (order_id, created_at)
  )`)
  await query(`CREATE TABLE IF NOT EXISTS order_items (
    id VARCHAR(60) PRIMARY KEY,
    order_id VARCHAR(32) NOT NULL,
    product_id VARCHAR(32) NOT NULL,
    sku_id VARCHAR(60),
    product_name VARCHAR(160) NOT NULL,
    sku_name VARCHAR(160),
    image_url VARCHAR(500),
    unit_price_cents INT UNSIGNED NOT NULL,
    quantity INT UNSIGNED NOT NULL,
    product_discount_cents INT UNSIGNED NOT NULL DEFAULT 0,
    order_discount_cents INT UNSIGNED NOT NULL DEFAULT 0,
    paid_amount_cents INT UNSIGNED NOT NULL,
    inventory_mode VARCHAR(30) NOT NULL,
    customization_json JSON,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_order_item_order (order_id),
    INDEX idx_order_item_product (product_id, sku_id)
  )`)
  await query(`CREATE TABLE IF NOT EXISTS order_inventory_releases (
    order_item_id VARCHAR(60) PRIMARY KEY,
    order_id VARCHAR(32) NOT NULL,
    product_id VARCHAR(32) NOT NULL,
    quantity INT UNSIGNED NOT NULL COMMENT '累计已释放数量',
    reason VARCHAR(120),
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_inventory_release_order (order_id),
    INDEX idx_inventory_release_product (product_id)
  )`)
  await ensureColumn("order_inventory_releases", "updated_at", "DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP")
  await query(`CREATE TABLE IF NOT EXISTS order_inventory_release_events (
    id VARCHAR(80) PRIMARY KEY,
    business_key VARCHAR(180) NOT NULL,
    order_item_id VARCHAR(60) NOT NULL,
    order_id VARCHAR(32) NOT NULL,
    product_id VARCHAR(32) NOT NULL,
    quantity INT UNSIGNED NOT NULL,
    reason VARCHAR(120),
    source_type VARCHAR(40) NOT NULL,
    source_id VARCHAR(80) NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_inventory_release_event_business (business_key),
    INDEX idx_inventory_release_event_item (order_item_id),
    INDEX idx_inventory_release_event_order (order_id),
    INDEX idx_inventory_release_event_source (source_type, source_id)
  )`)
  await query(`CREATE TABLE IF NOT EXISTS order_inventory_reservations (
    order_item_id VARCHAR(60) PRIMARY KEY,
    order_id VARCHAR(32) NOT NULL,
    product_id VARCHAR(32) NOT NULL,
    quantity INT UNSIGNED NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_inventory_reservation_order (order_id),
    INDEX idx_inventory_reservation_product (product_id)
  )`)
  await query(`CREATE TABLE IF NOT EXISTS order_payment_timeout_jobs (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    order_id VARCHAR(32) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    attempt_count INT NOT NULL DEFAULT 0,
    available_at DATETIME NOT NULL,
    locked_at DATETIME,
    locked_by VARCHAR(64),
    processed_at DATETIME,
    last_error VARCHAR(500),
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_payment_timeout_order (order_id),
    INDEX idx_payment_timeout_due (status, available_at),
    INDEX idx_payment_timeout_lock (status, locked_at)
  )`)
  await query(`CREATE TABLE IF NOT EXISTS refund_records (
    id VARCHAR(60) PRIMARY KEY,
    order_id VARCHAR(32) NOT NULL,
    refund_no VARCHAR(64) NOT NULL,
    wechat_refund_id VARCHAR(80),
    requested_amount_cents INT UNSIGNED NOT NULL,
    success_amount_cents INT UNSIGNED NOT NULL DEFAULT 0,
    shipping_refund_cents INT UNSIGNED NOT NULL DEFAULT 0,
    status VARCHAR(30) NOT NULL,
    reason VARCHAR(255),
    operator_id VARCHAR(80),
    requested_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    success_at DATETIME,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_refund_no (refund_no),
    INDEX idx_refund_order (order_id, status)
  )`)
  await query(`CREATE TABLE IF NOT EXISTS refund_items (
    id VARCHAR(60) PRIMARY KEY,
    refund_record_id VARCHAR(60) NOT NULL,
    order_item_id VARCHAR(60) NOT NULL,
    sku_id VARCHAR(60),
    refund_quantity INT UNSIGNED NOT NULL,
    product_refund_cents INT UNSIGNED NOT NULL,
    discount_refund_cents INT UNSIGNED NOT NULL DEFAULT 0,
    shipping_refund_cents INT UNSIGNED NOT NULL DEFAULT 0,
    store_commission_reversal_cents INT UNSIGNED NOT NULL DEFAULT 0,
    personal_reward_reversal_cents INT UNSIGNED NOT NULL DEFAULT 0,
    pickup_service_fee_impact VARCHAR(30) NOT NULL DEFAULT 'NONE',
    status VARCHAR(30) NOT NULL DEFAULT 'PROCESSING',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_refund_item_record (refund_record_id, order_item_id),
    INDEX idx_refund_item_order_item (order_item_id, status)
  )`)
  await query(`CREATE TABLE IF NOT EXISTS financial_record_item_allocations (
    id VARCHAR(80) PRIMARY KEY,
    ledger_type VARCHAR(30) NOT NULL,
    record_id VARCHAR(60) NOT NULL,
    order_id VARCHAR(32) NOT NULL,
    order_item_id VARCHAR(60) NOT NULL,
    sku_id VARCHAR(60),
    quantity INT UNSIGNED NOT NULL,
    allocated_amount_cents INT UNSIGNED NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_financial_item_allocation (ledger_type, record_id, order_item_id),
    INDEX idx_financial_allocation_order (order_id, order_item_id)
  )`)
  await query(`CREATE TABLE IF NOT EXISTS store_referral_attributions (
    id VARCHAR(60) PRIMARY KEY,
    token_hash CHAR(64) NOT NULL,
    store_id VARCHAR(40) NOT NULL,
    user_id VARCHAR(32),
    visitor_hash CHAR(64),
    source VARCHAR(80),
    share_code VARCHAR(80),
    attribution_type VARCHAR(30) NOT NULL DEFAULT 'store_external',
    status VARCHAR(20) NOT NULL DEFAULT 'active',
    last_order_id VARCHAR(32),
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME NOT NULL,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_store_attribution_token (token_hash),
    INDEX idx_store_attribution_user (user_id, status, expires_at),
    INDEX idx_store_attribution_visitor (visitor_hash, status, expires_at),
    INDEX idx_store_attribution_store (store_id, status, expires_at)
  )`)
  await query(`CREATE TABLE IF NOT EXISTS wechat_fulfillment_records (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    order_id VARCHAR(32) NOT NULL,
    business_node VARCHAR(40) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    attempt_count INT NOT NULL DEFAULT 0,
    last_error VARCHAR(500),
    wechat_error_code VARCHAR(40),
    claim_token VARCHAR(64),
    processing_started_at DATETIME,
    sent_at DATETIME,
    next_retry_at DATETIME,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_wechat_fulfillment_node (order_id, business_node),
    INDEX idx_wechat_fulfillment_due (status, next_retry_at)
  )`)
  await query(`CREATE TABLE IF NOT EXISTS order_notification_records (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    order_id VARCHAR(32) NOT NULL,
    notification_type VARCHAR(50) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    attempt_count INT NOT NULL DEFAULT 0,
    last_error VARCHAR(500),
    claim_token VARCHAR(64),
    processing_started_at DATETIME,
    sent_at DATETIME,
    next_retry_at DATETIME,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_order_notification (order_id, notification_type),
    INDEX idx_order_notification_due (notification_type, status, next_retry_at)
  )`)
  await ensureColumn("order_notification_records", "claim_token", "VARCHAR(64)")
  await ensureColumn("order_notification_records", "processing_started_at", "DATETIME")
  await query(`CREATE TABLE IF NOT EXISTS payment_finance_outbox (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    event_type VARCHAR(60) NOT NULL,
    business_key VARCHAR(180) NOT NULL,
    aggregate_type VARCHAR(40) NOT NULL,
    aggregate_id VARCHAR(40) NOT NULL,
    payload_json JSON,
    status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    attempt_count INT NOT NULL DEFAULT 0,
    available_at DATETIME,
    locked_at DATETIME,
    locked_by VARCHAR(64),
    processed_at DATETIME,
    last_error VARCHAR(500),
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_payment_finance_business (business_key),
    INDEX idx_payment_finance_due (event_type, status, available_at),
    INDEX idx_payment_finance_order (aggregate_id, event_type)
  )`)
  await ensureColumn("payment_finance_outbox", "payload_json", "JSON")
  await ensureColumn("payment_finance_outbox", "available_at", "DATETIME")
  await ensureColumn("payment_finance_outbox", "locked_at", "DATETIME")
  await ensureColumn("payment_finance_outbox", "locked_by", "VARCHAR(64)")
  await ensureColumn("payment_finance_outbox", "processed_at", "DATETIME")
  await ensureColumn("payment_finance_outbox", "last_error", "VARCHAR(500)")
  await ensureIndex("payment_finance_outbox", "uniq_payment_finance_business", "UNIQUE KEY", ["business_key"])
  await ensureIndex("payment_finance_outbox", "idx_payment_finance_due", "INDEX", ["event_type", "status", "available_at"])
  await ensureIndex("payment_finance_outbox", "idx_payment_finance_order", "INDEX", ["aggregate_id", "event_type"])
  await query(`CREATE TABLE IF NOT EXISTS partner_stores (
    id VARCHAR(40) PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    level VARCHAR(20) DEFAULT 'display',
    address VARCHAR(255),
    phone VARCHAR(30),
    contact_name VARCHAR(50),
    business_hours VARCHAR(120),
    latitude DECIMAL(10,6),
    longitude DECIMAL(10,6),
    status VARCHAR(20) DEFAULT 'enabled',
    is_display_enabled VARCHAR(10) DEFAULT 'true',
    is_pickup_enabled VARCHAR(10) DEFAULT 'false',
    is_supplier_enabled VARCHAR(10) DEFAULT 'false',
    settlement_cycle VARCHAR(20) DEFAULT 'monthly',
    qrcode_scene VARCHAR(80),
    sort_order INT DEFAULT 0,
    remark TEXT,
    referral_commission_type VARCHAR(20) DEFAULT 'percent',
    referral_commission_value DECIMAL(10,2) DEFAULT 3,
    pickup_fee_type VARCHAR(20) DEFAULT 'fixed',
    pickup_fee_value DECIMAL(10,2) DEFAULT 2,
    supplier_settlement_rule TEXT,
    custom_commission_rule TEXT,
    created_at DATETIME,
    updated_at DATETIME
  )`)
  await ensureColumn("partner_stores", "manager_phone", "VARCHAR(30)")
  await ensureColumn("partner_stores", "manager_openid", "VARCHAR(80)")
  await ensureColumn("partner_stores", "store_role", "VARCHAR(30) DEFAULT 'manager'")
  await ensureColumn("partner_stores", "store_status", "VARCHAR(30) DEFAULT 'active'")
  await ensureColumn("partner_stores", "sales_agent_id", "VARCHAR(60)")
  await ensureColumn("partner_stores", "sales_agent_commission_rate", "DECIMAL(10,2)")
  await query(`CREATE TABLE IF NOT EXISTS store_members (
    id VARCHAR(60) PRIMARY KEY,
    store_id VARCHAR(40),
    user_id VARCHAR(80),
    phone VARCHAR(30),
    openid VARCHAR(80),
    role VARCHAR(20) DEFAULT 'staff',
    status VARCHAR(20) DEFAULT 'active',
    created_at DATETIME,
    updated_at DATETIME,
    UNIQUE KEY uniq_store_member_phone (store_id, phone),
    INDEX idx_store_member_phone (phone),
    INDEX idx_store_member_store (store_id)
  )`)
  await query(`CREATE TABLE IF NOT EXISTS store_settlement_records (
    id VARCHAR(60) PRIMARY KEY,
    store_id VARCHAR(40),
    order_id VARCHAR(32),
    type VARCHAR(20),
    amount DECIMAL(10,2) DEFAULT 0,
    commission_type VARCHAR(20),
    commission_value DECIMAL(10,2) DEFAULT 0,
    order_paid_amount DECIMAL(10,2) DEFAULT 0,
    status VARCHAR(20) DEFAULT 'pending_confirm',
    description VARCHAR(255),
    created_at DATETIME,
    settled_at DATETIME,
    INDEX idx_store_status (store_id, status),
    INDEX idx_order_id (order_id)
  )`)
  await query("ALTER TABLE store_settlement_records MODIFY COLUMN type VARCHAR(40)")
  await ensureColumn("store_settlement_records", "settled_by", "VARCHAR(80)")
  await ensureColumn("store_settlement_records", "settle_note", "TEXT")
  await ensureColumn("store_settlement_records", "cancel_reason", "TEXT")
  await ensureColumn("store_settlement_records", "batch_id", "VARCHAR(80)")
  await ensureColumn("store_settlement_records", "store_order_type", "VARCHAR(30)")
  await ensureColumn("store_settlement_records", "is_store_member_order", "VARCHAR(10) DEFAULT 'false'")
  await ensureColumn("store_settlement_records", "store_operator_user_id", "VARCHAR(80)")
  await ensureColumn("store_settlement_records", "store_operator_phone", "VARCHAR(30)")
  await ensureColumn("store_settlement_records", "store_operator_openid", "VARCHAR(80)")
  await ensureColumn("store_settlement_records", "store_operator_role", "VARCHAR(20)")
  await ensureColumn("store_settlement_records", "store_operator_name", "VARCHAR(80)")
  await ensureColumn("store_settlement_records", "updated_at", "DATETIME")
  await ensureColumn("store_settlement_records", "business_key", "VARCHAR(180)")
  await ensureColumn("store_settlement_records", "related_record_id", "VARCHAR(60)")
  await ensureIndex("store_settlement_records", "uniq_store_settlement_business", "UNIQUE KEY", ["business_key"])
  await query(`CREATE TABLE IF NOT EXISTS customers (
    id VARCHAR(32) PRIMARY KEY,
    name VARCHAR(50) NOT NULL,
    nickname VARCHAR(80),
    phone VARCHAR(30),
    openid VARCHAR(80),
    avatar_url VARCHAR(500),
    wechat VARCHAR(80),
    orders INT DEFAULT 0,
    total_amount DECIMAL(10,2) DEFAULT 0,
    last_contact DATE,
    invite_code VARCHAR(32),
    shopping_money DECIMAL(10,2) DEFAULT 0
  )`)
  await ensureColumn("customers", "nickname", "VARCHAR(80)")
  await ensureColumn("customers", "openid", "VARCHAR(80)")
  await ensureColumn("customers", "avatar_url", "VARCHAR(500)")
  await ensureColumn("customers", "invite_code", "VARCHAR(32)")
  await ensureColumn("customers", "shopping_money", "DECIMAL(10,2) DEFAULT 0")
  await query(`CREATE TABLE IF NOT EXISTS promotion_relations (
    id VARCHAR(32) PRIMARY KEY,
    inviter_phone VARCHAR(30),
    inviter_name VARCHAR(50),
    inviter_code VARCHAR(32),
    invitee_phone VARCHAR(30),
    invitee_name VARCHAR(50),
    level INT DEFAULT 1,
    created_at DATETIME
  )`)
  await query(`CREATE TABLE IF NOT EXISTS promotion_relation_claims (
    invitee_phone VARCHAR(30) PRIMARY KEY,
    relation_id VARCHAR(32) NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_promotion_relation_claim (relation_id)
  )`)
  if (STARTUP_HISTORY_COMPENSATION_ENABLED) {
    await query(
      `INSERT IGNORE INTO promotion_relation_claims (invitee_phone, relation_id, created_at)
       SELECT invitee_phone, MIN(id), MIN(COALESCE(created_at,NOW()))
       FROM promotion_relations
       WHERE invitee_phone IS NOT NULL AND invitee_phone<>''
       GROUP BY invitee_phone`
    )
  }
  await query(`CREATE TABLE IF NOT EXISTS promotion_relation_claims (
    invitee_phone VARCHAR(30) PRIMARY KEY,
    relation_id VARCHAR(32) NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_promotion_relation_claim (relation_id)
  )`)
  if (STARTUP_HISTORY_COMPENSATION_ENABLED) {
    await query(
      `INSERT IGNORE INTO promotion_relation_claims (invitee_phone, relation_id, created_at)
       SELECT invitee_phone, MIN(id), MIN(COALESCE(created_at,NOW()))
       FROM promotion_relations
       WHERE invitee_phone IS NOT NULL AND invitee_phone<>''
       GROUP BY invitee_phone`
    )
  }
  await query(`CREATE TABLE IF NOT EXISTS promotion_visits (
    id VARCHAR(32) PRIMARY KEY,
    invite VARCHAR(64),
    visitor_id VARCHAR(64),
    created_at DATETIME,
    UNIQUE KEY uniq_invite_visitor (invite, visitor_id)
  )`)
  await query(`CREATE TABLE IF NOT EXISTS reward_rules (
    id VARCHAR(32) PRIMARY KEY,
    product_id VARCHAR(32),
    product_name VARCHAR(100),
    first_reward DECIMAL(10,2) DEFAULT 0,
    second_reward DECIMAL(10,2) DEFAULT 0
  )`)
  await query(`CREATE TABLE IF NOT EXISTS reward_records (
    id VARCHAR(40) PRIMARY KEY,
    order_id VARCHAR(32),
    product_name VARCHAR(100),
    buyer_phone VARCHAR(30),
    promoter_phone VARCHAR(30),
    promoter_name VARCHAR(50),
    level INT DEFAULT 1,
    amount DECIMAL(10,2) DEFAULT 0,
    status VARCHAR(30),
    release_at DATETIME,
    created_at DATETIME,
    updated_at DATETIME
  )`)
  await ensureColumn("reward_records", "type", "VARCHAR(40) DEFAULT 'level1'")
  await ensureColumn("reward_records", "settled_at", "DATETIME")
  await ensureColumn("reward_records", "settled_by", "VARCHAR(80)")
  await ensureColumn("reward_records", "settle_note", "TEXT")
  await ensureColumn("reward_records", "cancel_reason", "TEXT")
  await ensureColumn("reward_records", "batch_id", "VARCHAR(80)")
  await ensureColumn("reward_records", "business_key", "VARCHAR(180)")
  await ensureColumn("reward_records", "related_record_id", "VARCHAR(60)")
  await ensureIndex("reward_records", "uniq_reward_business", "UNIQUE KEY", ["business_key"])
  await query(`CREATE TABLE IF NOT EXISTS sales_agents (
    id VARCHAR(60) PRIMARY KEY,
    name VARCHAR(80),
    phone VARCHAR(30),
    password_hash VARCHAR(180),
    commission_rate DECIMAL(10,2) DEFAULT 0,
    status VARCHAR(20) DEFAULT 'active',
    remark TEXT,
    created_at DATETIME,
    updated_at DATETIME,
    UNIQUE KEY uniq_sales_agent_phone (phone)
  )`)
  await query(`CREATE TABLE IF NOT EXISTS store_leads (
    id VARCHAR(60) PRIMARY KEY,
    sales_agent_id VARCHAR(60),
    store_name VARCHAR(120),
    contact_name VARCHAR(80),
    contact_phone VARCHAR(30),
    address VARCHAR(255),
    latitude DECIMAL(10,6),
    longitude DECIMAL(10,6),
    store_type VARCHAR(60),
    cooperation_type VARCHAR(60),
    pickup_enabled VARCHAR(10) DEFAULT 'false',
    photos JSON,
    remark TEXT,
    status VARCHAR(20) DEFAULT 'pending',
    reject_reason TEXT,
    store_id VARCHAR(60),
    created_at DATETIME,
    handled_at DATETIME,
    handled_by VARCHAR(80),
    INDEX idx_store_lead_agent (sales_agent_id),
    INDEX idx_store_lead_status (status)
  )`)
  await ensureColumn("store_leads", "cooperation_type", "VARCHAR(60)")
  await query(`CREATE TABLE IF NOT EXISTS sales_agent_commissions (
    id VARCHAR(80) PRIMARY KEY,
    business_key VARCHAR(180),
    sales_agent_id VARCHAR(60),
    store_id VARCHAR(60),
    order_id VARCHAR(40),
    order_no VARCHAR(80),
    order_amount DECIMAL(10,2) DEFAULT 0,
    commission_rate DECIMAL(10,2) DEFAULT 0,
    commission_amount DECIMAL(10,2) DEFAULT 0,
    amount DECIMAL(10,2) DEFAULT 0,
    type VARCHAR(40),
    status VARCHAR(20) DEFAULT 'unsettled',
    created_at DATETIME,
    settled_at DATETIME,
    settled_by VARCHAR(80),
    settle_note TEXT,
    cancel_reason TEXT,
    batch_id VARCHAR(80),
    related_record_id VARCHAR(80),
    remark TEXT,
    UNIQUE KEY uniq_sales_agent_business (business_key),
    INDEX idx_sales_agent_commission_agent (sales_agent_id, status),
    INDEX idx_sales_agent_commission_store (store_id),
    INDEX idx_sales_agent_commission_order (order_id)
  )`)
  await ensureColumn("sales_agent_commissions", "business_key", "VARCHAR(180)")
  if (STARTUP_HISTORY_COMPENSATION_ENABLED) {
    await query(
      `UPDATE sales_agent_commissions
       SET business_key=CONCAT('legacy:',id)
       WHERE business_key IS NULL OR business_key=''`
    )
  }
  await ensureIndex("sales_agent_commissions", "uniq_sales_agent_business", "UNIQUE KEY", ["business_key"])
  await removeIndexIfExists("sales_agent_commissions", "uniq_sales_agent_order_type")
  await query(`CREATE TABLE IF NOT EXISTS system_settings (
    id INT PRIMARY KEY,
    data JSON NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  )`)

  if (process.env.MYSQL_TEST_SKIP_SEED_DATA !== "true") {
    const homeRows = await query("SELECT id FROM home_config WHERE id = 1")
    if (!homeRows.length) {
      const home = normalizeHome(readSeed("home.json", {}))
      await query("INSERT INTO home_config (id, data) VALUES (1, :data)", { data: JSON.stringify(home) })
      await saveProducts(home.products)
    }
    const orderRows = await query("SELECT id FROM orders LIMIT 1")
    if (!orderRows.length) await saveOrders(readSeed("orders.json", []))
    const customerRows = await query("SELECT id FROM customers LIMIT 1")
    if (!customerRows.length) {
      for (const customer of readSeed("customers.json", []).map(normalizeCustomer)) {
        await query(
          "INSERT INTO customers (id, name, nickname, phone, openid, avatar_url, wechat, orders, total_amount, last_contact, invite_code, shopping_money) VALUES (:id, :name, :nickname, :phone, :openid, :avatarUrl, :wechat, :orders, :totalAmount, :lastContact, :inviteCode, :shoppingMoney)",
          customer
        )
      }
    }
    const settingRows = await query("SELECT id FROM system_settings WHERE id = 1")
    if (!settingRows.length) {
      await query("INSERT INTO system_settings (id, data) VALUES (1, :data)", { data: JSON.stringify(readSeed("settings.json", {})) })
    }
    await migrateProductCategoriesToCanonical()
  }
}

async function ensureColumn(table, column, definition) {
  const rows = await query(
    "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = :schema AND TABLE_NAME = :table AND COLUMN_NAME = :column",
    { schema: dbConfig.database, table, column }
  )
  if (!rows.length) await query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`)
}

async function ensureIndex(table, indexName, kind, columns) {
  if (![table, indexName, ...columns].every(value => /^[A-Za-z0-9_]+$/.test(String(value || "")))) {
    throw new Error("数据库索引名称不安全")
  }
  const rows = await query(
    `SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS
     WHERE TABLE_SCHEMA=:schema AND TABLE_NAME=:table AND INDEX_NAME=:indexName
     LIMIT 1`,
    { schema: dbConfig.database, table, indexName }
  )
  if (rows.length) return
  const indexKind = kind === "UNIQUE KEY" ? "UNIQUE KEY" : "INDEX"
  await query(
    `ALTER TABLE \`${table}\` ADD ${indexKind} \`${indexName}\` (${columns.map(column => `\`${column}\``).join(",")})`
  )
}

async function removeIndexIfExists(table, indexName) {
  if (![table, indexName].every(value => /^[A-Za-z0-9_]+$/.test(String(value || "")))) {
    throw new Error("数据库索引名称不安全")
  }
  const rows = await query(
    `SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS
     WHERE TABLE_SCHEMA=:schema AND TABLE_NAME=:table AND INDEX_NAME=:indexName
     LIMIT 1`,
    { schema: dbConfig.database, table, indexName }
  )
  if (rows.length) await query(`ALTER TABLE \`${table}\` DROP INDEX \`${indexName}\``)
}

function ensureDevCertificate() {
  if (!ENABLE_HTTPS) return null
  const certFile = process.env.SSL_CERT_FILE || path.join(certDir, "localhost-cert.pem")
  const keyFile = process.env.SSL_KEY_FILE || path.join(certDir, "localhost-key.pem")
  if (fs.existsSync(certFile) && fs.existsSync(keyFile)) {
    return { cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) }
  }
  try {
    execFileSync("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyFile,
      "-out",
      certFile,
      "-days",
      "3650",
      "-subj",
      "/CN=127.0.0.1",
      "-addext",
      "subjectAltName=IP:127.0.0.1,DNS:localhost"
    ], { stdio: "ignore" })
    return { cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) }
  } catch (error) {
    console.warn("HTTPS 证书生成失败，已继续使用 HTTP。本机可安装 openssl 后重启服务。")
    return null
  }
}

function signWithPrivateKey(message) {
  const keyPath = process.env.WECHAT_PRIVATE_KEY_PATH
  if (!keyPath || !fs.existsSync(keyPath)) throw new Error("缺少微信支付商户私钥 WECHAT_PRIVATE_KEY_PATH")
  return crypto.createSign("RSA-SHA256").update(message).sign(fs.readFileSync(keyPath), "base64")
}

function wechatAuthorization(method, urlPath, body) {
  const mchid = process.env.WECHAT_MCH_ID
  const serialNo = process.env.WECHAT_MCH_SERIAL_NO
  if (!mchid || !serialNo) throw new Error("缺少微信支付商户配置")
  const nonce = crypto.randomBytes(16).toString("hex")
  const timestamp = Math.floor(Date.now() / 1000).toString()
  const message = `${method}\n${urlPath}\n${timestamp}\n${nonce}\n${body}\n`
  const signature = signWithPrivateKey(message)
  return `WECHATPAY2-SHA256-RSA2048 mchid="${mchid}",nonce_str="${nonce}",signature="${signature}",timestamp="${timestamp}",serial_no="${serialNo}"`
}

function buildClientPayParams(prepayId) {
  const timeStamp = Math.floor(Date.now() / 1000).toString()
  const nonceStr = crypto.randomBytes(16).toString("hex")
  const packageValue = `prepay_id=${prepayId}`
  const paySign = signWithPrivateKey(`${WECHAT_APPID}\n${timeStamp}\n${nonceStr}\n${packageValue}\n`)
  return {
    timeStamp,
    nonceStr,
    package: packageValue,
    signType: "RSA",
    paySign
  }
}

async function getOpenid(code) {
  if (canUseMockWechatLogin()) return MOCK_WECHAT_OPENID
  if (!hasRealWechatConfig()) throw new Error("缺少真实 WECHAT_APPID 或 WECHAT_SECRET")
  const url = `https://api.weixin.qq.com/sns/jscode2session?appid=${WECHAT_APPID}&secret=${WECHAT_SECRET}&js_code=${code}&grant_type=authorization_code`
  const result = await requestJson(url)
  if (result.data.errcode) throw wechatApiError(result.data.errcode, result.data.errmsg, "微信登录接口")
  if (!result.data.openid) throw wechatApiError("openid_missing", result.data.errmsg || "微信未返回 openid", "微信登录接口")
  return result.data.openid
}

async function getAccessToken() {
  if (accessTokenCache.token && Date.now() < accessTokenCache.expiresAt) {
    return accessTokenCache.token
  }
  if (!hasRealWechatConfig()) throw new Error("缺少真实 WECHAT_APPID 或 WECHAT_SECRET")
  const url = `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${WECHAT_APPID}&secret=${WECHAT_SECRET}`
  const result = await requestJson(url)
  if (result.data.errcode) throw wechatApiError(result.data.errcode, result.data.errmsg, "微信 access_token 接口")
  if (!result.data.access_token) throw wechatApiError("access_token_missing", result.data.errmsg || "微信未返回 access_token", "微信 access_token 接口")
  accessTokenCache = {
    token: result.data.access_token,
    expiresAt: Date.now() + Math.max(0, Number(result.data.expires_in || 7200) - 300) * 1000
  }
  return accessTokenCache.token
}

async function applyBrandLogoToQrBuffer(buffer) {
  if (!sharp || !fs.existsSync(brandQrLogoFile)) return buffer
  try {
    const meta = await sharp(buffer).metadata()
    const qrSize = Math.min(meta.width || 430, meta.height || 430)
    const logoSize = Math.round(qrSize * 0.20)
    const circleMaskSvg = Buffer.from(`<svg width="${logoSize}" height="${logoSize}" xmlns="http://www.w3.org/2000/svg"><circle cx="${logoSize / 2}" cy="${logoSize / 2}" r="${logoSize / 2}" fill="#fff"/></svg>`)
    const logo = await sharp(brandQrLogoFile)
      .resize(logoSize, logoSize, { fit: "cover" })
      .composite([{ input: circleMaskSvg, blend: "dest-in" }])
      .png()
      .toBuffer()
    return await sharp(buffer)
      .composite([{ input: logo, left: Math.round(((meta.width || logoSize) - logoSize) / 2), top: Math.round(((meta.height || logoSize) - logoSize) / 2) }])
      .png()
      .toBuffer()
  } catch (error) {
    console.warn("[qr-logo] overlay skipped", { message: error.message })
    return buffer
  }
}

function wxacodeEnvVersion() {
  const value = String(process.env.WECHAT_WXACODE_ENV_VERSION || "release").trim()
  return ["release", "trial", "develop"].includes(value) ? value : "release"
}

async function generatePromotionWxacode(inviteCode) {
  const safeInvite = String(inviteCode || "").replace(/[^\w-]/g, "").slice(0, 24) || "VSCUSTOM"
  const envVersion = wxacodeEnvVersion()
  const outputFile = path.join(uploadsDir, `promotion-code-${safeInvite}-${envVersion}-${BRAND_QR_LOGO_VERSION}.png`)
  if (fs.existsSync(outputFile)) {
    return { url: publicAssetUrl(`/uploads/${path.basename(outputFile)}`), cached: true, envVersion, logoVersion: BRAND_QR_LOGO_VERSION }
  }
  const accessToken = await getAccessToken()
  const body = JSON.stringify({
    scene: `invite=${safeInvite}`,
    page: "pages/index/index",
    check_path: false,
    env_version: envVersion
  })
  const result = await requestBuffer(`https://api.weixin.qq.com/wxa/getwxacodeunlimit?access_token=${accessToken}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "image/png,application/json" },
    timeout: 15000
  }, body)
  const contentType = String(result.headers["content-type"] || "")
  if (contentType.includes("application/json")) {
    let data = {}
    try {
      data = JSON.parse(result.data.toString() || "{}")
    } catch (error) {
      data = { errcode: "wxacode_parse_error", errmsg: "微信小程序码接口返回异常" }
    }
    throw wechatApiError(data.errcode || "wxacode_error", data.errmsg || "微信小程序码生成失败", "微信小程序码接口")
  }
  if (!contentType.includes("image") || !result.data.length) {
    throw wechatApiError("wxacode_empty", "微信未返回小程序码图片", "微信小程序码接口")
  }
  fs.mkdirSync(uploadsDir, { recursive: true })
  fs.writeFileSync(outputFile, await applyBrandLogoToQrBuffer(result.data))
  return { url: publicAssetUrl(`/uploads/${path.basename(outputFile)}`), cached: false, envVersion, logoVersion: BRAND_QR_LOGO_VERSION }
}

async function generateProductWxacode(productId, refCode = "") {
  const safeProductId = String(productId || "").replace(/[^\w-]/g, "").slice(0, 20)
  if (!safeProductId) throw httpError(400, "缺少商品ID")
  const safeRef = String(refCode || "").replace(/[^\w-]/g, "").slice(0, 10)
  const scene = safeWxacodeScene(`p=${safeProductId}${safeRef ? `&ref=${safeRef}` : ""}`, `p=${safeProductId}`)
  const cacheKey = `${safeProductId}${safeRef ? `-${safeRef}` : ""}`.replace(/[^\w-]/g, "").slice(0, 48)
  const envVersion = wxacodeEnvVersion()
  const outputFile = path.join(uploadsDir, `product-code-${cacheKey}-${envVersion}-${BRAND_QR_LOGO_VERSION}.png`)
  if (fs.existsSync(outputFile)) {
    return {
      url: publicAssetUrl(`/uploads/${path.basename(outputFile)}`),
      cached: true,
      envVersion,
      scene,
      path: `/pages/product/detail?id=${encodeURIComponent(safeProductId)}${safeRef ? `&ref=${encodeURIComponent(safeRef)}` : ""}`,
      logoVersion: BRAND_QR_LOGO_VERSION
    }
  }
  const accessToken = await getAccessToken()
  const body = JSON.stringify({
    scene,
    page: "pages/product/detail",
    check_path: false,
    env_version: envVersion
  })
  const result = await requestBuffer(`https://api.weixin.qq.com/wxa/getwxacodeunlimit?access_token=${accessToken}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "image/png,application/json" },
    timeout: 15000
  }, body)
  const contentType = String(result.headers["content-type"] || "")
  if (contentType.includes("application/json")) {
    let data = {}
    try {
      data = JSON.parse(result.data.toString() || "{}")
    } catch (error) {
      data = { errcode: "wxacode_parse_error", errmsg: "微信小程序码接口返回异常" }
    }
    throw wechatApiError(data.errcode || "wxacode_error", data.errmsg || "微信小程序码生成失败", "微信小程序码接口")
  }
  if (!contentType.includes("image") || !result.data.length) {
    throw wechatApiError("wxacode_empty", "微信未返回小程序码图片", "微信小程序码接口")
  }
  fs.mkdirSync(uploadsDir, { recursive: true })
  fs.writeFileSync(outputFile, await applyBrandLogoToQrBuffer(result.data))
  return {
    url: publicAssetUrl(`/uploads/${path.basename(outputFile)}`),
    cached: false,
    envVersion,
    scene,
    path: `/pages/product/detail?id=${encodeURIComponent(safeProductId)}${safeRef ? `&ref=${encodeURIComponent(safeRef)}` : ""}`,
    logoVersion: BRAND_QR_LOGO_VERSION
  }
}

async function generateStoreWxacode(store) {
  if (!store?.id) throw httpError(404, "门店不存在")
  if (!isStoreEnabled(store)) throw httpError(400, "门店已停用，暂不能生成二维码")
  const safeStoreId = String(store.id || "").replace(/[^\w-]/g, "").slice(0, 24)
  const envVersion = wxacodeEnvVersion()
  const outputFile = path.join(uploadsDir, `store-code-${safeStoreId}-${envVersion}-${BRAND_QR_LOGO_VERSION}.png`)
  if (fs.existsSync(outputFile)) {
    return { url: publicAssetUrl(`/uploads/${path.basename(outputFile)}`), cached: true, envVersion, scene: `store_id=${safeStoreId}`, logoVersion: BRAND_QR_LOGO_VERSION }
  }
  const accessToken = await getAccessToken()
  const body = JSON.stringify({
    scene: safeWxacodeScene(`store_id=${safeStoreId}`, `store_id=${safeStoreId}`),
    page: "pages/index/index",
    check_path: false,
    env_version: envVersion
  })
  const result = await requestBuffer(`https://api.weixin.qq.com/wxa/getwxacodeunlimit?access_token=${accessToken}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "image/png,application/json" },
    timeout: 15000
  }, body)
  const contentType = String(result.headers["content-type"] || "")
  if (contentType.includes("application/json")) {
    let data = {}
    try {
      data = JSON.parse(result.data.toString() || "{}")
    } catch (error) {
      data = { errcode: "wxacode_parse_error", errmsg: "微信小程序码接口返回异常" }
    }
    throw wechatApiError(data.errcode || "wxacode_error", data.errmsg || "微信小程序码生成失败", "微信小程序码接口")
  }
  if (!contentType.includes("image") || !result.data.length) {
    throw wechatApiError("wxacode_empty", "微信未返回小程序码图片", "微信小程序码接口")
  }
  fs.mkdirSync(uploadsDir, { recursive: true })
  fs.writeFileSync(outputFile, await applyBrandLogoToQrBuffer(result.data))
  return { url: publicAssetUrl(`/uploads/${path.basename(outputFile)}`), cached: false, envVersion, scene: `store_id=${safeStoreId}`, logoVersion: BRAND_QR_LOGO_VERSION }
}

async function getWechatPhoneNumber(code) {
  if (canUseMockWechatLogin()) return MOCK_WECHAT_PHONE
  if (!code) throw httpError(400, "缺少手机号授权 code")
  const accessToken = await getAccessToken()
  const body = JSON.stringify({ code })
  const result = await requestJson(`https://api.weixin.qq.com/wxa/business/getuserphonenumber?access_token=${accessToken}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" }
  }, body)
  const data = result.data && typeof result.data === "object" ? result.data : {}
  const phoneInfo = data.phone_info && typeof data.phone_info === "object" ? data.phone_info : null
  console.warn("[wechat-phone] safe response summary", {
    errcode: data.errcode,
    errmsg: data.errmsg,
    keys: objectKeys(data),
    hasPhoneInfo: !!phoneInfo,
    phoneInfoKeys: objectKeys(phoneInfo),
    hasPhoneNumber: !!(phoneInfo && phoneInfo.phoneNumber),
    hasPurePhoneNumber: !!(phoneInfo && phoneInfo.purePhoneNumber),
    hasCountryCode: !!(phoneInfo && phoneInfo.countryCode)
  })
  if (data.errcode) throw wechatApiError(data.errcode, data.errmsg, "微信手机号接口")
  if (!phoneInfo) {
    throw wechatApiError("phone_info_missing", data.errmsg || "缺少 phone_info", "微信手机号接口返回异常")
  }
  const phoneNumber = phoneInfo.phoneNumber || phoneInfo.purePhoneNumber || ""
  if (!phoneNumber) {
    throw wechatApiError("phone_number_missing", data.errmsg || "缺少手机号字段", "微信手机号接口返回异常")
  }
  return phoneNumber
}

async function createWechatPay(orderId, openid, identity = {}) {
  console.log("[pay] createWechatPay start", { orderId })
  const orders = await getOrders({ keyword: orderId })
  const order = orders.find(item => item.id === orderId)
  console.log("[pay] createWechatPay order lookup", {
    orderId,
    found: !!order,
    paymentStatus: order?.paymentStatus || "",
    status: order?.status || ""
  })
  if (!order) throw httpError(404, "订单不存在")
  if (order.paymentStatus === "待报价" || order.status === "待客服确认" || Number(order.amount || 0) <= 0) {
    throw httpError(400, "该订单正在等待客服报价，暂不能支付")
  }
  if (["已支付", "部分退款"].includes(order.paymentStatus)) {
    throw httpError(400, "订单已支付，无需重复付款")
  }
  const blockedStatus = String(order.status || "").trim().toLowerCase()
  const blockedPaymentStatus = String(order.paymentStatus || "").trim().toLowerCase()
  const blockedAfterSalesStatus = normalizeAfterSalesStatus(order.afterSalesStatus || order.after_sales_status || order.refundStatus || order.refund_status)
  if (
    isOrderRefunded(order) ||
    ["已取消", "已关闭", "已退款", "退款中", "cancelled", "canceled", "closed", "void", "refunded"].includes(blockedStatus) ||
    ["已退款", "退款中", "退款处理中", "cancelled", "canceled", "closed", "void", "refunded"].includes(blockedPaymentStatus) ||
    ["refund_pending", "refunded"].includes(blockedAfterSalesStatus)
  ) {
    throw httpError(409, "该订单已取消、关闭或进入退款流程，不能再次支付")
  }
  const sessionOpenid = String(openid || identity.openid || "").trim()
  const sessionUserId = String(identity.userId || "").trim()
  const sessionPhone = String(identity.phone || "").trim()
  const orderUserId = String(order.userId || "").trim()
  const orderOpenid = String(order.openid || "").trim()
  const orderPhone = String(order.phone || "").trim()
  const userIdMatched = !!(sessionUserId && orderUserId && sessionUserId === orderUserId)
  const phoneMatched = !!(sessionPhone && orderPhone && sessionPhone === orderPhone)
  const openidMatched = !!(orderOpenid && sessionOpenid && orderOpenid === sessionOpenid)
  if (!orderUserId && !orderOpenid && !orderPhone) {
    console.warn("[pay] reject empty owner", { orderId: order.id, hasSessionUserId: !!sessionUserId })
    throw httpError(403, "订单缺少用户身份，请联系商家处理")
  }
  const legacyMatched = !orderUserId && (openidMatched || phoneMatched)
  if (!userIdMatched && !legacyMatched) {
    console.warn("[pay] reject owner mismatch", {
      orderId: order.id,
      hasOrderUserId: !!orderUserId,
      hasSessionUserId: !!sessionUserId,
      legacyMatched: false
    })
    throw httpError(403, "无权支付该订单")
  }
  if (legacyMatched) {
    await backfillOrderIdentity(order.id, identity)
    order.userId = sessionUserId
    if (!order.openid && sessionOpenid) order.openid = sessionOpenid
    console.log("[pay] backfilled legacy identity", { orderId: order.id, hasUserId: !!sessionUserId })
  }
  if (PAY_MOCK) {
    console.log("[pay] createWechatPay mock enabled", { orderId })
    return { mock: true, orderId, message: "当前为支付模拟模式，调用 /api/pay/mock-success 可完成测试" }
  }
  const notifyUrl = process.env.WECHAT_PAY_NOTIFY_URL || `${PUBLIC_BASE_URL}/api/pay/notify`
  const body = JSON.stringify({
    appid: WECHAT_APPID,
    mchid: process.env.WECHAT_MCH_ID,
    description: order.productName,
    out_trade_no: order.id,
    notify_url: notifyUrl,
    amount: { total: Math.max(1, Math.round(Number(order.amount) * 100)), currency: "CNY" },
    payer: { openid: sessionOpenid }
  })
  const urlPath = "/v3/pay/transactions/jsapi"
  const result = await requestJson(`https://api.mch.weixin.qq.com${urlPath}`, {
    method: "POST",
    headers: {
      Authorization: wechatAuthorization("POST", urlPath, body),
      "Content-Type": "application/json",
      Accept: "application/json"
    }
  }, body)
  console.log("[pay] createWechatPay prepay result", {
    orderId,
    statusCode: result.statusCode,
    hasPrepayId: !!(result.data && result.data.prepay_id),
    code: result.data && result.data.code,
    message: result.data && result.data.message
  })
  if (!result.data.prepay_id) throw new Error(result.data.message || "微信支付预下单失败")
  return buildClientPayParams(result.data.prepay_id)
}

function verifyWechatPayNotify(req, rawBody) {
  if (PAY_MOCK) return
  const timestamp = req.headers["wechatpay-timestamp"]
  const nonce = req.headers["wechatpay-nonce"]
  const signature = req.headers["wechatpay-signature"]
  const serial = req.headers["wechatpay-serial"]
  if (!timestamp || !nonce || !signature || !serial) throw new Error("微信支付回调缺少签名头")
  let verifyKeyPath = process.env.WECHAT_PAY_PLATFORM_CERT_PATH
  if (process.env.WECHAT_PAY_PUBLIC_KEY_ID) {
    if (serial !== process.env.WECHAT_PAY_PUBLIC_KEY_ID) throw new Error("微信支付公钥 ID 不匹配")
    verifyKeyPath = process.env.WECHAT_PAY_PUBLIC_KEY_PATH
  } else if (process.env.WECHAT_PAY_PLATFORM_SERIAL_NO && serial !== process.env.WECHAT_PAY_PLATFORM_SERIAL_NO) {
    throw new Error("微信支付平台证书序列号不匹配")
  }
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) throw new Error("微信支付回调时间戳已过期")
  if (!verifyKeyPath || !fs.existsSync(verifyKeyPath)) throw new Error("缺少微信支付验签公钥或平台证书")
  const message = `${timestamp}\n${nonce}\n${rawBody}\n`
  const ok = crypto.createVerify("RSA-SHA256").update(message).verify(fs.readFileSync(verifyKeyPath), signature, "base64")
  if (!ok) throw new Error("微信支付回调签名验证失败")
}

async function queryWechatPayOrder(orderId) {
  const mchid = process.env.WECHAT_MCH_ID
  if (!mchid) throw new Error("缺少微信支付商户号")
  const urlPath = `/v3/pay/transactions/out-trade-no/${encodeURIComponent(orderId)}?mchid=${encodeURIComponent(mchid)}`
  const result = await requestJson(`https://api.mch.weixin.qq.com${urlPath}`, {
    method: "GET",
    headers: {
      Authorization: wechatAuthorization("GET", urlPath, ""),
      Accept: "application/json"
    }
  })
  if (result.statusCode < 200 || result.statusCode >= 300) {
    throw new Error(result.data.message || "微信支付订单二次确认失败")
  }
  return result.data
}

async function queryWechatRefundByNo(refundNo) {
  if (!refundNo) throw httpError(400, "缺少退款单号")
  if (PAY_MOCK || !IS_PRODUCTION) {
    return { out_refund_no: refundNo, status: "SUCCESS", refund_id: `MOCKRF${Date.now()}` }
  }
  const urlPath = `/v3/refund/domestic/refunds/${encodeURIComponent(refundNo)}`
  const result = await requestJson(`https://api.mch.weixin.qq.com${urlPath}`, {
    method: "GET",
    headers: {
      Authorization: wechatAuthorization("GET", urlPath, ""),
      Accept: "application/json"
    }
  })
  if (result.statusCode < 200 || result.statusCode >= 300) {
    throw httpError(400, result.data.message || "微信退款查询失败")
  }
  return result.data
}

async function syncRefundStatus(orderId) {
  const order = (await getOrders({ keyword: orderId })).find(item => item.id === orderId)
  if (!order) throw httpError(404, "订单不存在")
  if (!order.refundNo && !order.refundId) return { order, refund: null }
  // Older records may have kept only refund_id. This service generated
  // out_refund_no deterministically, so recover that exact identifier and query;
  // this endpoint never submits a new refund.
  const queryRefundNo = order.refundNo || generateRefundNo(order.id)
  const refund = await queryWechatRefundByNo(queryRefundNo)
  const status = refund.status || refund.refund_status || ""
  if (status === "SUCCESS") {
    return { order: await markRefundSuccess(order, refund), refund }
  }
  if (status === "ABNORMAL" || status === "CLOSED") {
    const orders = await getOrders()
    const index = orders.findIndex(item => item.id === order.id)
    if (index >= 0) {
      const previous = { ...orders[index] }
      orders[index] = {
        ...orders[index],
        refundStatus: "退款失败",
        afterSalesStatus: "refund_failed",
        afterSalesHandledAt: formatDateTime(new Date())
      }
      await saveOrders([orders[index]])
      await recordOrderStateAudit(previous, orders[index], {
        source: "wechat_refund_query",
        operatorId: "system",
        reason: `微信退款查询终态：${status}`
      })
      return { order: orders[index], refund }
    }
  }
  return { order, refund }
}

async function runRefundSyncWorker() {
  if (!pool || refundSyncWorkerRunning || PAY_MOCK) return
  refundSyncWorkerRunning = true
  try {
    const rows = await query(
      `SELECT id FROM orders
       WHERE (after_sales_status='refund_pending' OR refund_status IN ('退款处理中','PROCESSING','processing'))
         AND (refund_no IS NOT NULL AND refund_no<>'' OR refund_id IS NOT NULL AND refund_id<>'')
         AND COALESCE(refund_reviewed_at, after_sales_handled_at, created_at) <= DATE_SUB(NOW(), INTERVAL 5 MINUTE)
       ORDER BY COALESCE(refund_reviewed_at, after_sales_handled_at, created_at)
       LIMIT 20`
    )
    for (const row of rows) {
      try {
        await syncRefundStatus(row.id)
      } catch (error) {
        console.error("[refund-sync]", { orderId: row.id, error: String(error.message || "").slice(0, 180) })
      }
    }
  } finally {
    refundSyncWorkerRunning = false
  }
}

function startRefundSyncWorker() {
  if (refundSyncWorkerTimer) return
  runRefundSyncWorker().catch(error => console.error("[refund-sync] worker error", { error: String(error.message || "").slice(0, 180) }))
  refundSyncWorkerTimer = setInterval(() => {
    runRefundSyncWorker().catch(error => console.error("[refund-sync] worker error", { error: String(error.message || "").slice(0, 180) }))
  }, 60 * 1000)
  refundSyncWorkerTimer.unref?.()
}

async function assertConfirmedPaymentMatchesOrder(confirmed) {
  const orderId = confirmed.out_trade_no || ""
  if (!orderId) throw new Error("微信支付订单缺少商户订单号")
  if (String(confirmed.mchid || "") !== String(process.env.WECHAT_MCH_ID || "")) {
    throw new Error("微信支付商户号与本地配置不一致")
  }
  if (String(confirmed.appid || "") !== String(WECHAT_APPID || "")) {
    throw new Error("微信支付 AppID 与本地配置不一致")
  }
  if (String(confirmed.amount?.currency || "CNY").toUpperCase() !== "CNY") {
    throw new Error("微信支付币种与本地订单不一致")
  }
  const order = (await getOrders({ keyword: orderId })).find(item => item.id === orderId)
  if (!order) throw new Error("本地订单不存在，拒绝确认支付")
  const paidTotal = Number(confirmed.amount && confirmed.amount.total)
  const expectedTotal = Math.max(1, Math.round(Number(order.amount || 0) * 100))
  if (paidTotal !== expectedTotal) throw new Error("微信支付金额与本地订单金额不一致")
  return order
}

function decryptWechatResource(resource) {
  const apiV3Key = process.env.WECHAT_API_V3_KEY
  if (!apiV3Key) throw new Error("缺少 WECHAT_API_V3_KEY")
  if (!resource || typeof resource !== "object") throw new Error("微信支付回调缺少 resource")
  if (!resource.nonce || !resource.ciphertext) {
    console.warn("[pay] notify resource invalid", {
      resourceKeys: objectKeys(resource),
      hasNonce: !!resource.nonce,
      hasCiphertext: !!resource.ciphertext,
      hasTag: !!resource.tag
    })
    throw new Error("微信支付回调 resource 字段不完整")
  }
  const encrypted = Buffer.from(resource.ciphertext, "base64")
  if (encrypted.length <= 16 && !resource.tag) throw new Error("微信支付回调密文长度异常")
  const authTag = resource.tag ? Buffer.from(resource.tag, "base64") : encrypted.subarray(encrypted.length - 16)
  const ciphertext = resource.tag ? encrypted : encrypted.subarray(0, encrypted.length - 16)
  const decipher = crypto.createDecipheriv("aes-256-gcm", Buffer.from(apiV3Key), Buffer.from(resource.nonce))
  decipher.setAuthTag(authTag)
  decipher.setAAD(Buffer.from(resource.associated_data || ""))
  const decoded = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final()
  ])
  return JSON.parse(decoded.toString())
}

function renderSalesPage() {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>业务员工作台</title><style>
  :root{--brand:#ff6a00;--brand-dark:#ef4b00;--ink:#1f2933;--muted:#687385;--line:#f0d8c6;--paper:#fff;--soft:#fff4ea;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--ink);background:linear-gradient(180deg,#fff8f0 0%,#f7f8fb 46%,#f7f8fb 100%)}*{box-sizing:border-box}body{margin:0;background:transparent}.shell{width:min(100%,720px);margin:0 auto;padding:18px 16px 28px}.top{position:sticky;top:0;z-index:5;margin:0 -16px 16px;padding:12px 16px 10px;background:rgba(255,248,240,.94);backdrop-filter:blur(12px);border-bottom:1px solid rgba(255,106,0,.12)}.head{display:flex;align-items:center;justify-content:space-between;gap:12px}.brand-wrap{display:flex;align-items:center;gap:10px;min-width:0}.logo{width:48px;height:48px;border-radius:50%;object-fit:cover;box-shadow:0 8px 22px rgba(255,106,0,.2);flex:none}.brand{font-size:20px;font-weight:900;line-height:1.1}.subtitle{font-size:13px;color:var(--muted);margin-top:3px}.nav{display:flex;gap:8px;margin-top:12px;overflow:auto;padding-bottom:2px}.nav a,.btn{min-height:42px;border:1px solid #ffd2ad;background:#fff;color:var(--ink);padding:10px 13px;border-radius:12px;text-decoration:none;cursor:pointer;font:inherit;display:inline-flex;align-items:center;justify-content:center;gap:6px;white-space:nowrap}.nav a.active{background:var(--brand);border-color:var(--brand);color:#fff;box-shadow:0 8px 18px rgba(255,106,0,.22)}.btn.primary{background:linear-gradient(135deg,var(--brand),var(--brand-dark));color:#fff;border-color:var(--brand);font-weight:800;box-shadow:0 10px 20px rgba(255,106,0,.22)}.btn.secondary{background:#fff;color:var(--brand);border-color:#ffc69a}.btn.danger{color:#b42318}.btn.full{width:100%;min-height:52px;border-radius:14px}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.card,.panel{background:#fff;border:1px solid #f0dfd3;border-radius:16px;padding:15px;box-shadow:0 10px 26px rgba(31,41,51,.05)}.metric{font-size:12px;color:var(--muted)}.value{font-size:22px;font-weight:900;margin-top:6px;line-height:1.12}.panel{margin-top:14px}.panel h3{margin:0 0 12px;font-size:18px}.form{display:grid;gap:14px}.field{display:grid;gap:7px;font-size:14px;color:#445065;font-weight:700}.field input,.field select,.field textarea{width:100%;border:1px solid #ead8ca;border-radius:13px;padding:13px 12px;font:inherit;color:var(--ink);background:#fff;min-height:50px}.field textarea{min-height:96px;resize:vertical}.hint{font-size:12px;color:var(--muted);font-weight:500}.choice-row{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}.choice-row label{border:1px solid #ead8ca;background:#fffaf6;border-radius:13px;min-height:48px;display:flex;align-items:center;justify-content:center;text-align:center;font-size:13px;font-weight:800;color:#445065}.choice-row input{position:absolute;opacity:0;pointer-events:none}.choice-row label:has(input:checked){background:#fff0e4;border-color:var(--brand);color:var(--brand);box-shadow:inset 0 0 0 1px rgba(255,106,0,.16)}.upload-box{border:1px dashed #ffb476;background:#fff8f0;border-radius:16px;padding:14px;display:grid;gap:12px}.photo-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}.photo-tile{position:relative;aspect-ratio:1;border-radius:14px;overflow:hidden;background:#f7f2ee;border:1px solid #ead8ca}.photo-tile img{width:100%;height:100%;object-fit:cover;display:block}.photo-tile button{position:absolute;top:5px;right:5px;width:26px;height:26px;border:0;border-radius:50%;background:rgba(17,24,39,.72);color:#fff;font-size:18px;line-height:1;cursor:pointer}.empty{color:var(--muted);text-align:center;padding:24px 12px;border:1px dashed #e2d7cf;border-radius:14px;background:#fffaf6}.lead-list{display:grid;gap:10px}.lead-card{border:1px solid #eeddd0;border-radius:16px;background:#fff;padding:14px;display:grid;gap:10px}.lead-card-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}.lead-title{font-weight:900;font-size:17px}.badge{border-radius:999px;padding:5px 9px;font-size:12px;font-weight:800;background:#fff0e4;color:#d94b00;white-space:nowrap}.kv{display:grid;gap:6px;color:#4b5563;font-size:13px}.kv div{display:flex;gap:8px}.kv b{color:#7a8696;min-width:64px;font-weight:700}.table-wrap{overflow:auto}table{width:100%;border-collapse:collapse;min-width:720px}th,td{padding:10px;border-bottom:1px solid #edf0f3;text-align:left;font-size:14px}th{color:#6b7280;background:#fafafa}.muted{color:var(--muted)}.login{width:min(92vw,410px);margin:9vh auto;background:#fff;border:1px solid #f0dfd3;border-radius:22px;padding:24px;box-shadow:0 18px 42px rgba(31,41,51,.08)}.login-brand{text-align:center;margin-bottom:18px}.login-brand img{width:82px;height:82px;border-radius:50%;object-fit:cover;box-shadow:0 10px 24px rgba(255,106,0,.22)}.login-brand h2{margin:12px 0 4px}.status{position:fixed;left:50%;bottom:18px;z-index:20;transform:translateX(-50%);background:#111827;color:#fff;padding:11px 15px;border-radius:999px;display:none;max-width:90vw;text-align:center}.details{border:1px solid #ead8ca;border-radius:14px;padding:0;background:#fff}.details summary{padding:13px 14px;cursor:pointer;font-weight:800;color:#445065}.details-body{padding:0 14px 14px;display:grid;gap:12px}.submit-bar{margin:16px 0 0;padding:0 0 4px}@media(max-width:520px){.shell{padding:14px 12px 24px}.top{margin:0 -12px 14px;padding:10px 12px}.brand{font-size:18px}.logo{width:42px;height:42px}.grid{grid-template-columns:1fr 1fr}.choice-row{grid-template-columns:1fr}.submit-bar{position:sticky;bottom:0;margin:16px -12px -24px;padding:12px 12px 18px;background:linear-gradient(180deg,rgba(247,248,251,0),#f7f8fb 24%)}.card,.panel{border-radius:14px;padding:13px}}</style></head><body><div id="app"></div><div id="status" class="status"></div><script>
  const path=location.pathname;const $=s=>document.querySelector(s);const money=v=>Number(v||0).toFixed(2);const text=v=>String(v??"").replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[m]));function toast(m){const el=$("#status");el.textContent=m;el.style.display="block";setTimeout(()=>el.style.display="none",2400)}async function api(url,method="GET",body){const res=await fetch(url,{method,headers:{"Content-Type":"application/json"},body:body?JSON.stringify(body):undefined,cache:"no-store"});const data=await res.json().catch(()=>({}));if(res.status===401&&path!=="/sales/login"){location.href="/sales/login";return{}}if(!res.ok||data.ok===false)throw new Error(data.message||"请求失败");return data}
  function activeNav(href){return path===href?' class="active"':""}
  function layout(title,body){return '<div class="shell"><div class="top"><div class="head"><div class="brand-wrap"><img class="logo" src="/assets/logo.png" alt="非常智造"><div><div class="brand">非常智造业务员工作台</div><div class="subtitle">'+text(title)+'</div></div></div></div><div class="nav"><a'+activeNav("/sales/dashboard")+' href="/sales/dashboard">看板</a><a'+activeNav("/sales/store-leads")+' href="/sales/store-leads">门店线索</a><a'+activeNav("/sales/store-leads/new")+' href="/sales/store-leads/new">提交门店</a><button class="btn" onclick="logout()">退出</button></div></div>'+body+'</div><div id="status" class="status"></div>'}
  async function logout(){await api("/api/sales/logout","POST",{});location.href="/sales/login"}
  async function renderLogin(){document.body.innerHTML='<div class="login"><div class="login-brand"><img src="/assets/logo.png" alt="非常智造"><h2>业务员登录</h2><div class="muted">非常智造业务员工作台</div></div><div class="form"><label class="field">手机号<input id="phone" autocomplete="username" inputmode="numeric" placeholder="请输入手机号"></label><label class="field">密码<input id="password" type="password" autocomplete="current-password" placeholder="请输入密码"></label></div><p><button class="btn primary full" id="loginBtn">登录</button></p><p class="muted" id="err"></p></div><div id="status" class="status"></div>';$("#loginBtn").onclick=async()=>{try{await api("/api/sales/login","POST",{phone:$("#phone").value,password:$("#password").value});location.href="/sales/dashboard"}catch(e){$("#err").textContent=e.message||"手机号或密码错误"}}}
  function summaryCards(s){return '<div class="grid">'+[['累计已结算',s.settledTotal],['当前待结算',s.payableTotal],['当前退款扣回',s.chargebackTotal],['本次预计到账',s.actualPayable]].map(i=>'<div class="card"><div class="metric">'+i[0]+'</div><div class="value">¥'+money(i[1])+'</div></div>').join('')+'</div>'}
  async function renderDashboard(){const d=await api("/api/sales/dashboard");const stores=d.stores||[],records=d.records||[],overview=d.overview||{};document.body.innerHTML=layout("业绩、佣金与结算状态",summaryCards(d.summary||{})+'<div class="grid" style="margin-top:10px">'+[['已开发门店数',overview.storeCount],['待审核线索',overview.pendingLeadCount],['累计订单数',overview.orderCount],['累计销售额',"¥"+money(overview.salesAmount)],['累计佣金',"¥"+money(overview.totalCommission)]].map(i=>'<div class="card"><div class="metric">'+i[0]+'</div><div class="value">'+(i[1]||0)+'</div></div>').join('')+'</div><div class="panel"><h3>我开发的门店</h3><div class="table-wrap"><table><thead><tr><th>门店</th><th>电话</th><th>地址</th><th>销售额</th><th>订单数</th><th>待结算</th><th>预计到账</th></tr></thead><tbody>'+stores.map(s=>'<tr><td>'+text(s.name)+'</td><td>'+text(s.phone)+'</td><td>'+text(s.address)+'</td><td>¥'+money(s.salesAmount)+'</td><td>'+s.orderCount+'</td><td>¥'+money(s.payableTotal)+'</td><td>¥'+money(s.actualPayable)+'</td></tr>').join('')+'</tbody></table></div></div><div class="panel"><h3>佣金明细</h3><div class="table-wrap"><table><thead><tr><th>时间</th><th>门店</th><th>订单号</th><th>订单金额</th><th>比例</th><th>金额</th><th>类型</th><th>状态</th><th>备注</th></tr></thead><tbody>'+records.map(r=>'<tr><td>'+text(r.createdAtText||r.createdAt)+'</td><td>'+text(r.storeName||r.storeId)+'</td><td>'+text(r.orderNo||r.orderId)+'</td><td>¥'+money(r.orderAmount)+'</td><td>'+money(r.commissionRate)+'%</td><td>¥'+money(r.amount)+'</td><td>'+text(r.typeText)+'</td><td>'+text(r.statusText)+'</td><td>'+text(r.remark)+'</td></tr>').join('')+'</tbody></table></div></div>')}
  async function renderLeads(){const d=await api("/api/sales/store-leads");const leads=d.data||[];document.body.innerHTML=layout("我提交的门店线索",'<div class="panel"><div class="lead-list">'+(leads.length?leads.map(l=>'<div class="lead-card"><div class="lead-card-head"><div class="lead-title">'+text(l.storeName)+'</div><div class="badge">'+text(l.statusText)+'</div></div><div class="kv"><div><b>联系人</b><span>'+text(l.contactName)+' / '+text(l.contactPhone)+'</span></div><div><b>门店类型</b><span>'+text(l.storeType||"-")+'</span></div><div><b>合作类型</b><span>'+text(l.cooperationType||"-")+'</span></div><div><b>地址</b><span>'+text(l.address)+'</span></div><div><b>提交时间</b><span>'+text(l.createdAt)+'</span></div>'+(l.rejectReason?'<div><b>拒绝原因</b><span>'+text(l.rejectReason)+'</span></div>':'')+'</div></div>').join(''):'<div class="empty">还没有提交门店线索</div>')+'</div></div>')}
  var uploadedPhotos=[];
  function optionList(items){return items.map(v=>'<option value="'+text(v)+'">'+text(v)+'</option>').join('')}
  function renderPhotoPreview(){const box=$("#photoPreview");if(!box)return;box.innerHTML=uploadedPhotos.length?uploadedPhotos.map((url,index)=>'<div class="photo-tile"><img src="'+text(url)+'" alt="门店照片"><button type="button" onclick="removePhoto('+index+')">×</button></div>').join(''):'<div class="empty" style="grid-column:1/-1;padding:16px 8px">尚未上传照片</div>'}
  function removePhoto(index){uploadedPhotos.splice(index,1);renderPhotoPreview()}
  async function uploadPhotos(files){const list=Array.from(files||[]).slice(0,3-uploadedPhotos.length);console.log("[sales-photo-upload]",{selected:Array.from(files||[]).length,uploading:list.length});if(!list.length){toast("最多上传3张照片");return}for(const file of list){if(file.size>5*1024*1024){toast("单张图片不能超过5MB");return}if(!/^image\\/(jpeg|png|webp)$/.test(file.type)){toast("只支持 jpg、png、webp 图片");return}}const form=new FormData();list.forEach(file=>form.append("photos",file));const res=await fetch("/api/sales/upload",{method:"POST",body:form,cache:"no-store"});const data=await res.json().catch(()=>({}));if(res.status===401){location.href="/sales/login";return}if(!res.ok||data.ok===false)throw new Error(data.message||"上传失败");uploadedPhotos=uploadedPhotos.concat(data.urls||[]).slice(0,3);renderPhotoPreview();toast("照片已上传")}
  function useLocation(){if(!navigator.geolocation){toast("当前浏览器不支持定位，可手动填写");return}toast("正在获取当前位置");navigator.geolocation.getCurrentPosition(pos=>{const c=pos.coords||{};$("#latitude").value=c.latitude?Number(c.latitude).toFixed(6):"";$("#longitude").value=c.longitude?Number(c.longitude).toFixed(6):"";toast("定位已填入")},()=>toast("定位失败，可手动填写"),{enableHighAccuracy:true,timeout:9000,maximumAge:30000})}
  async function renderLeadForm(){const storeTypes=["展示点","自提点","合作门店","便利店","文具店","玩具店","礼品店","校园店","社区店","其他"];const cooperationTypes=["仅展示","支持自提","展示 + 自提","推广合作","待沟通"];document.body.innerHTML=layout("提交门店信息",'<div class="panel"><div class="form"><label class="field">门店名称<input id="storeName" placeholder="请输入门店名称"></label><label class="field">联系人<input id="contactName" placeholder="请输入联系人"></label><label class="field">联系电话<input id="contactPhone" inputmode="tel" placeholder="请输入11位手机号"></label><label class="field">门店类型<select id="storeType">'+optionList(storeTypes)+'</select></label><label class="field">合作类型<select id="cooperationType">'+optionList(cooperationTypes)+'</select></label><div class="field"><span>是否支持到店自提</span><div class="choice-row"><label><input type="radio" name="pickupChoice" value="false" checked>暂不支持</label><label><input type="radio" name="pickupChoice" value="true">支持自提</label><label><input type="radio" name="pickupChoice" value="pending">待确认</label></div></div><label class="field">门店地址<textarea id="address" placeholder="请输入详细地址"></textarea></label><div class="field"><span>门店照片</span><div class="upload-box"><div class="hint">上传门店照片，最多3张，支持拍照或从相册选择</div><input id="photoInput" type="file" accept="image/*" multiple hidden><button class="btn secondary" type="button" id="pickPhoto">选择/拍照上传</button><div class="photo-grid" id="photoPreview"></div></div></div><label class="field">备注<textarea id="remark" placeholder="补充合作情况、老板反馈等"></textarea></label><details class="details"><summary>更多信息（经纬度）</summary><div class="details-body"><button class="btn secondary" type="button" id="locateBtn">使用当前位置</button><label class="field">纬度<input id="latitude" inputmode="decimal" placeholder="可选"></label><label class="field">经度<input id="longitude" inputmode="decimal" placeholder="可选"></label></div></details></div></div><div class="submit-bar"><button class="btn primary full" id="submit">提交门店信息</button></div>');uploadedPhotos=[];renderPhotoPreview();$("#pickPhoto").onclick=()=>$("#photoInput").click();$("#photoInput").onchange=async e=>{try{await uploadPhotos(e.target.files);e.target.value=""}catch(err){toast(err.message||"上传失败")}};$("#locateBtn").onclick=useLocation;$("#submit").onclick=async()=>{const pickupChoice=(document.querySelector("input[name=pickupChoice]:checked")||{}).value||"false";const remarkParts=[];if(pickupChoice==="pending")remarkParts.push("自提状态：待确认");if($("#remark").value.trim())remarkParts.push($("#remark").value.trim());const body={storeName:$("#storeName").value.trim(),contactName:$("#contactName").value.trim(),contactPhone:$("#contactPhone").value.trim(),address:$("#address").value.trim(),storeType:$("#storeType").value,cooperationType:$("#cooperationType").value,pickupEnabled:pickupChoice==="true"?"true":"false",latitude:$("#latitude").value.trim(),longitude:$("#longitude").value.trim(),photos:uploadedPhotos,remark:remarkParts.join("\\n")};if(!body.storeName){toast("请填写门店名称");return}if(!body.contactName){toast("请填写联系人");return}if(!/^1\\d{10}$/.test(body.contactPhone)){toast("请填写正确的11位手机号");return}if(!body.address){toast("请填写门店地址");return}try{await api("/api/sales/store-leads","POST",body);toast("门店信息已提交，等待后台审核。");setTimeout(()=>location.href="/sales/store-leads",700)}catch(err){toast(err.message||"提交失败")}}}
  if(path==="/sales/login")renderLogin();else if(path==="/sales/store-leads/new")renderLeadForm();else if(path==="/sales/store-leads")renderLeads();else renderDashboard();
  </script></body></html>`
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`)

  if (req.method === "OPTIONS") {
    sendText(res, 204, "")
    return
  }

  if (
    !["GET", "HEAD"].includes(req.method) &&
    (url.pathname.startsWith("/api/admin") || url.pathname === "/api/auth/logout") &&
    !isAllowedSameOriginRequest(req)
  ) {
    sendJson(res, 403, { ok: false, message: "请求来源无效" })
    return
  }

  if (req.method === "GET" && url.pathname === "/api/health") {
    if (pool) await query("SELECT 1 AS ok")
    sendJson(res, 200, { ok: true, service: "very-simple-admin", storage: pool ? "mysql" : "json" })
    return
  }

  if ((req.method === "GET" || req.method === "HEAD") && (url.pathname.startsWith("/uploads/") || url.pathname.startsWith("/cms/uploads/"))) {
    const assetPath = url.pathname.startsWith("/cms/uploads/")
      ? url.pathname.replace("/cms/uploads/", "")
      : url.pathname.replace("/uploads/", "")
    const file = path.normalize(path.join(uploadsDir, assetPath))
    if (!file.startsWith(uploadsDir) || !fs.existsSync(file)) {
      sendJson(res, 404, { ok: false, message: "图片不存在" })
      return
    }
    const ext = path.extname(file).toLowerCase()
    if (blockedUploadScriptExts().has(ext)) {
      sendJson(res, 403, { ok: false, message: "禁止访问该文件类型" })
      return
    }
    const type = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : ext === ".gif" ? "image/gif" : ext === ".svg" ? "image/svg+xml" : "image/jpeg"
    sendText(res, 200, fs.readFileSync(file), type, { "Cache-Control": "public, max-age=31536000" })
    return
  }

  if ((req.method === "GET" || req.method === "HEAD") && url.pathname === "/assets/logo.png") {
    if (!fs.existsSync(publicLogoFile)) {
      sendJson(res, 404, { ok: false, message: "logo不存在" })
      return
    }
    sendText(res, 200, fs.readFileSync(publicLogoFile), "image/png", { "Cache-Control": "public, max-age=31536000" })
    return
  }

  if (req.method === "GET" && url.pathname === "/login") {
    sendText(res, 200, fs.readFileSync(loginFile, "utf8"), "text/html; charset=utf-8")
    return
  }

  if (req.method === "GET" && (url.pathname === "/sales/login" || url.pathname === "/sales/dashboard" || url.pathname === "/sales/store-leads" || url.pathname === "/sales/store-leads/new")) {
    sendText(res, 200, renderSalesPage(), "text/html; charset=utf-8")
    return
  }

  if (req.method === "GET" && url.pathname === "/test") {
    if (IS_PRODUCTION) {
      sendJson(res, 404, { ok: false, message: "Not found" })
      return
    }
    sendText(res, 200, fs.readFileSync(testFile, "utf8"), "text/html; charset=utf-8")
    return
  }

  if (req.method === "POST" && url.pathname === "/api/auth/login") {
    if (isAdminLoginLocked(req)) {
      sendJson(res, 429, { ok: false, message: "尝试次数过多，请稍后再试" })
      return
    }
    const body = JSON.parse((await readBody(req)).toString() || "{}")
    const user = process.env.ADMIN_USER || "admin"
    const passwordHash = process.env.ADMIN_PASSWORD_HASH || ""
    const legacyPassword = process.env.ADMIN_PASSWORD || "ChangeMe123!"
    const passwordMatches = passwordHash
      ? verifyPassword(body.password || "", passwordHash)
      : body.password === legacyPassword
    if (body.username !== user || !passwordMatches) {
      if (recordAdminLoginFailure(req)) {
        sendJson(res, 429, { ok: false, message: "尝试次数过多，请稍后再试" })
        return
      }
      sendJson(res, 401, { ok: false, message: "账号或密码错误" })
      return
    }
    clearAdminLoginFailures(req)
    const sid = crypto.randomBytes(24).toString("hex")
    sessions.set(sid, { user, createdAt: Date.now() })
    sendJson(res, 200, { ok: true }, { "Set-Cookie": adminSessionCookie(sid) })
    return
  }

  if (req.method === "POST" && url.pathname === "/api/auth/logout") {
    const sid = parseCookies(req).vsc_sid
    if (sid) sessions.delete(sid)
    const authorization = String(req.headers.authorization || "")
    const userToken = String(
      req.headers["x-user-session"] ||
      req.headers["x-user-token"] ||
      (authorization.toLowerCase().startsWith("bearer ") ? authorization.slice(7) : "")
    ).trim()
    if (userToken) await revokeUserSession(userToken)
    sendJson(res, 200, { ok: true })
    return
  }

  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/admin")) {
    if (!isAuthed(req)) {
      redirect(res, "/login")
      return
    }
    sendText(res, 200, fs.readFileSync(adminFile, "utf8"), "text/html; charset=utf-8")
    return
  }

  if (url.pathname === "/api/home" && req.method === "GET") {
    const [home, settings, products] = await Promise.all([getHome(), getSettings(), getProducts()])
    const categoryCatalog = publicCategoryCatalog(settings.categoryCatalog)
    const enabledPrimaryNames = new Set(categoryCatalog.map(item => item.name))
    const publicHomeEntries = (Array.isArray(home.homeEntries) ? home.homeEntries : []).filter(entry => {
      if (entry.targetType === "primary" || enabledPrimaryNames.has(entry.name)) {
        return enabledPrimaryNames.has(entry.targetValue || entry.name)
      }
      return true
    })
    console.log("[api-home-banner]", bannerSummaryForLog(home.banners?.[0] || {}, 0))
    sendJson(res, 200, {
      ...home,
      homeEntries: publicHomeEntries,
      products: homepageRecommendedProducts(products),
      hotProducts: homepageBurstProducts(products),
      homepageProductRules: {
        recommendedLimit: 6,
        burstLimit: 4,
        recommendedSource: "仅显示 isHot=true 的首页推荐商品，按 sortOrder 排序",
        burstSource: "badge=best 且未勾选首页推荐，双列网格，每行2个"
      },
      theme: currentThemeFromSettings(settings),
      categoryCatalog,
      activities: Array.isArray(settings.activities) ? settings.activities : []
    })
    return
  }

  if (url.pathname === "/api/theme/current" && req.method === "GET") {
    const settings = await getSettings()
    sendJson(res, 200, { ok: true, data: currentThemeFromSettings(settings) })
    return
  }

  if (url.pathname === "/api/help-center" && req.method === "GET") {
    const [home, settings] = await Promise.all([getHome(), getSettings()])
    sendJson(res, 200, {
      pageTitle: settings.helpPageTitle || "售后保障",
      pageSubtitle: settings.helpPageSubtitle || "下单流程、定制说明、发货时效与售后政策",
      articles: normalizeHelpArticles(settings.helpArticles).filter(item => item.status !== "off"),
      ads: home.ads || normalizeAds({}),
      profileBottomAd: home.ads?.profile_bottom_ad || normalizeAds({}).profile_bottom_ad,
      afterSalesGuideAd: home.ads?.after_sales_guide_ad || normalizeAds({}).after_sales_guide_ad,
      contact: normalizeContactSettings(settings),
      updatedAt: new Date().toISOString()
    })
    return
  }

  if (url.pathname === "/api/products" && req.method === "GET") {
    sendJson(res, 200, (await getProducts()).filter(isPublicProduct).map(publicProductView))
    return
  }

  if (url.pathname === "/api/pickup/stores" && req.method === "GET") {
    const stores = (await getPartnerStores({ status: "enabled", pickupOnly: true })).map(storePublicView)
    sendJson(res, 200, stores)
    return
  }

  if (url.pathname === "/api/store/source/validate" && req.method === "GET") {
    const storeId = url.searchParams.get("storeId") || url.searchParams.get("store_id") || ""
    const store = await getPartnerStore(storeId)
    if (!isValidReferrerStore(store)) {
      sendJson(res, 200, { ok: true, valid: false })
      return
    }
    sendJson(res, 200, { ok: true, valid: true, store: storePublicView(store) })
    return
  }

  if (url.pathname === "/api/store/source/attribution" && req.method === "POST") {
    const body = JSON.parse((await readBody(req, 32 * 1024)).toString() || "{}")
    const identity = await resolveIdentityFromRequest(req, body)
    const result = await issueStoreAttribution(body, identity)
    sendJson(res, 200, { ok: true, data: result })
    return
  }

  if (url.pathname === "/api/store/me" && req.method === "GET") {
    const storeSession = await getStoreSession(req)
    if (storeSession?.duplicated) {
      sendJson(res, 200, { ok: true, bound: false, error: storeSession.error || "该手机号绑定多个门店，请联系管理员处理" })
      return
    }
    if (!storeSession) {
      sendJson(res, 200, { ok: true, bound: false })
      return
    }
    const [orders, records] = await Promise.all([getOrders(), getStoreSettlementRecords({ storeId: storeSession.store.id })])
    const fullStats = storeCenterStats(storeSession.store, orders, records)
    const stats = hasStorePermission(storeSession, "earning.view") || hasStorePermission(storeSession, "settlement.view")
      ? fullStats
      : {
          todayReferralOrders: fullStats.todayReferralOrders,
          monthReferralOrders: fullStats.monthReferralOrders,
          todayPickupOrders: fullStats.todayPickupOrders,
          pendingPickupOrders: fullStats.pendingPickupOrders
        }
    sendJson(res, 200, {
      ok: true,
      bound: true,
      storeBound: true,
      storeId: storeSession.store.id,
      storeInfo: {
        ...storePrivateView(storeSession.store),
        storeRole: storeSession.role,
        storeRoleText: storeRoleText(storeSession.role)
      },
      role: storeSession.role,
      permissions: storeSession.permissions,
      member: storeMemberPublicView(storeSession.member || {}),
      stats
    })
    return
  }

  if (url.pathname === "/api/store/qrcode" && req.method === "GET") {
    const storeSession = await requireStorePermission(req, res, "store.code")
    if (!storeSession) return
    const result = await generateStoreWxacode(storeSession.store)
    sendJson(res, 200, {
      ok: true,
      url: result.url,
      scene: result.scene,
      link: `/pages/index/index?store_id=${encodeURIComponent(storeSession.store.id)}`,
      cached: result.cached,
      storeInfo: storePrivateView(storeSession.store)
    })
    return
  }

  if (url.pathname === "/api/store/referral-orders" && req.method === "GET") {
    const storeSession = await requireStorePermission(req, res, "referral.view")
    if (!storeSession) return
    const orders = (await getOrders()).filter(order => order.referrerStoreId === storeSession.store.id && isOrderPaidForPickupCredential(order) && !isOrderRefunded(order))
    const paidOrderIds = new Set(orders.map(order => order.id))
    const orderLookup = buildOrderLookup(orders)
    const records = (await getStoreSettlementRecords({ storeId: storeSession.store.id, type: "store_referral_commission" }))
      .filter(record => includeSettlementRecordForStats(record, paidOrderIds))
      .map(record => decorateSettlementRecord(record, orderLookup))
    const commissionSummary = buildSettlementSummary(records.filter(record => record.status !== "cancelled"), orderLookup)
    const today = new Date().toISOString().slice(0, 10)
    const month = new Date().toISOString().slice(0, 7)
    sendJson(res, 200, {
      storeInfo: storePrivateView(storeSession.store),
      summary: {
        todayOrders: orders.filter(order => String(order.createdAt || "").startsWith(today)).length,
        monthOrders: orders.filter(order => String(order.createdAt || "").startsWith(month)).length,
        unsettledCommission: commissionSummary.payableTotal,
        settledCommission: commissionSummary.settledTotal,
        ...commissionSummary
      },
      orders: orders.map(order => {
        const record = records.find(item => item.orderId === order.id && isStoreReferralSettlement(item.type))
        return { ...storeOrderView(order, "referral"), storeSettlementStatus: record?.effectiveStatus || order.storeSettlementStatus, storeSettlementStatusText: record?.statusText || settlementStatusText(order.storeSettlementStatus) }
      })
    })
    return
  }

  if (url.pathname === "/api/store/pickup-orders" && req.method === "GET") {
    const storeSession = await requireStorePermission(req, res, "pickup.view")
    if (!storeSession) return
    const orders = (await getOrders()).filter(order => order.pickupStoreId === storeSession.store.id && isPickupOrder(order) && isOrderPaidForPickupCredential(order))
    const records = await getStoreSettlementRecords({ storeId: storeSession.store.id, type: "pickup_service_fee" })
    sendJson(res, 200, {
      storeInfo: storePrivateView(storeSession.store),
      orders: orders.map(order => storeOrderView(
        order,
        "pickup",
        records.find(record => record.orderId === order.id && isPickupServiceSettlement(record.type)) || null
      ))
    })
    return
  }

  if (url.pathname === "/api/store/pickup-orders/batch-arrived" && req.method === "POST") {
    const storeSession = await requireStorePermission(req, res, "pickup.notify")
    if (!storeSession) return
    const body = JSON.parse((await readBody(req)).toString() || "{}")
    const result = await markPickupOrdersArrivedForStore(storeSession.store, Array.isArray(body.orderIds) ? body.orderIds : [])
    sendJson(res, 200, result)
    return
  }

  const pickupArrivedMatch = url.pathname.match(/^\/api\/store\/pickup-orders\/([^/]+)\/arrived$/)
  if (pickupArrivedMatch && req.method === "POST") {
    const storeSession = await requireStorePermission(req, res, "pickup.notify")
    if (!storeSession) return
    const orderId = decodeURIComponent(pickupArrivedMatch[1])
    const detail = await markPickupOrderArrivedForStore(storeSession.store, orderId)
    sendJson(res, 200, {
      success: !!detail.ok,
      total: 1,
      successCount: detail.ok ? 1 : 0,
      failedCount: detail.ok || detail.skipped ? 0 : 1,
      skippedCount: detail.skipped ? 1 : 0,
      notifySuccessCount: detail.ok && detail.notifyOk ? 1 : 0,
      notifyFailedCount: detail.ok && !detail.notifyOk ? 1 : 0,
      details: [detail],
      order: detail.order,
      message: detail.notifyMessage || detail.reason || ""
    })
    return
  }

  if (url.pathname === "/api/store/settlements" && req.method === "GET") {
    const storeSession = await requireStorePermission(req, res, "settlement.view")
    if (!storeSession) return
    const orders = (await getOrders()).filter(order => isOrderPaidForPickupCredential(order) && !isOrderRefunded(order))
    const orderLookup = buildOrderLookup(orders)
    const paidOrderIds = new Set(orders.map(order => order.id))
    const records = (await getStoreSettlementRecords({ storeId: storeSession.store.id }))
      .filter(record => includeSettlementRecordForStats(record, paidOrderIds))
      .map(record => decorateSettlementRecord(record, orderLookup))
    const activeRecords = records.filter(record => record.status !== "cancelled")
    const settlementSummary = buildSettlementSummary(activeRecords, orderLookup)
    const referral = activeRecords.filter(record => isStoreReferralSettlement(record.type)).reduce((sum, record) => sum + Number(record.amount || 0), 0)
    const pickup = activeRecords.filter(record => isPickupServiceSettlement(record.type)).reduce((sum, record) => sum + Number(record.amount || 0), 0)
    sendJson(res, 200, {
      storeInfo: storePrivateView(storeSession.store),
      summary: { ...settlementSummary, referralAmount: money(referral), pickupAmount: money(pickup) },
      records: records.map(record => ({ ...record, typeText: isStoreReferralSettlement(record.type) ? "门店推广佣金" : isPickupServiceSettlement(record.type) ? "自提服务费" : record.type === "adjustment" ? "手动调整" : record.type === "chargeback" ? "退款冲正" : record.type }))
    })
    return
  }

  if (url.pathname.match(/^\/api\/store\/orders\/[^/]+\/verify-pickup$/) && req.method === "POST") {
    const storeSession = await requireStorePermission(req, res, "pickup.verify")
    if (!storeSession) return
    if (!checkPickupVerificationRateLimit(req, storeSession)) {
      sendJson(res, 429, { ok: false, message: "操作频繁，请稍后再试" })
      return
    }
    const orderId = decodeURIComponent(url.pathname.split("/")[4])
    const body = JSON.parse((await readBody(req)).toString() || "{}")
    try {
      sendJson(res, 200, { ok: true, data: await verifyStorePickupOrder(storeSession.store, orderId, body.pickupCode) })
    } catch (error) {
      console.warn("[pickup-verify]", {
        storeId: storeSession.store.id,
        memberId: storeSession.member?.id || "",
        reason: String(error?.message || "unknown").slice(0, 80)
      })
      sendJson(res, 400, { ok: false, message: "取货码无效或当前不可核销" })
    }
    return
  }

  if (url.pathname === "/api/store/verify" && req.method === "POST") {
    const storeSession = await requireStorePermission(req, res, "pickup.verify")
    if (!storeSession) return
    if (!checkPickupVerificationRateLimit(req, storeSession)) {
      sendJson(res, 429, { ok: false, message: "操作频繁，请稍后再试" })
      return
    }
    const body = JSON.parse((await readBody(req)).toString() || "{}")
    try {
      sendJson(res, 200, await verifyStorePickupByCode(storeSession.store, body.pickupCode || body.code))
    } catch (error) {
      console.warn("[pickup-verify]", {
        storeId: storeSession.store.id,
        memberId: storeSession.member?.id || "",
        reason: String(error?.message || "unknown").slice(0, 80)
      })
      sendJson(res, 400, { ok: false, message: "取货码无效或当前不可核销" })
    }
    return
  }

  if (url.pathname === "/api/product/detail" && req.method === "GET") {
    const id = url.searchParams.get("id") || url.searchParams.get("productId")
    const product = id ? await getProduct(decodeURIComponent(id)) : null
    if (!product || !isPublicProduct(product)) {
      sendJson(res, 404, { ok: false, message: "商品不存在" })
      return
    }
    sendJson(res, 200, publicProductView(product))
    return
  }

  if (url.pathname.startsWith("/api/products/") && req.method === "GET") {
    const product = await getProduct(decodeURIComponent(url.pathname.replace("/api/products/", "")))
    if (!product || !isPublicProduct(product)) {
      sendJson(res, 404, { ok: false, message: "商品不存在" })
      return
    }
    sendJson(res, 200, publicProductView(product))
    return
  }

  if (url.pathname === "/api/orders" && req.method === "POST") {
    const body = JSON.parse((await readBody(req)).toString() || "{}")
    let identity = await resolveIdentityFromRequest(req, body)
    if (!hasRequestIdentity(identity)) {
      sendJson(res, 401, { ok: false, message: "请先完成微信登录" })
      return
    }
    identity = await ensureInternalUserIdentity(identity)
    const order = await createOrder({
      ...body,
      phone: identity.phone || "",
      openid: identity.openid,
      userId: identity.userId || "",
      userToken: "",
      userSession: ""
    })
    sendJson(res, 200, { ok: true, data: order })
    return
  }

  if (url.pathname === "/api/orders" && req.method === "GET") {
    const identity = await resolveIdentityFromRequest(req, Object.fromEntries(url.searchParams.entries()))
    if (!hasRequestIdentity(identity)) {
      sendJson(res, 401, { ok: false, message: "请先完成微信登录" })
      return
    }
    sendJson(res, 200, await getOrders({
      keyword: url.searchParams.get("keyword"),
      status: url.searchParams.get("status"),
      openid: identity.openid,
      userId: identity.userId,
      userToken: identity.userToken,
      phone: identity.phone,
      publicOnly: true
    }))
    return
  }

  if (url.pathname.match(/^\/api\/orders\/[^/]+$/) && req.method === "GET") {
    const identity = await resolveIdentityFromRequest(req, Object.fromEntries(url.searchParams.entries()))
    if (!hasRequestIdentity(identity)) {
      sendJson(res, 401, { ok: false, message: "请先完成微信登录" })
      return
    }
    const orderId = decodeURIComponent(url.pathname.split("/").pop())
    const order = (await getOrders({ keyword: orderId, ...identity, publicOnly: true })).find(item => item.id === orderId)
    if (!order) {
      sendJson(res, 404, { ok: false, message: "订单不存在" })
      return
    }
    sendJson(res, 200, order)
    return
  }

  if (url.pathname === "/api/orders/refund" && req.method === "POST") {
    const body = JSON.parse((await readBody(req)).toString() || "{}")
    const identity = await resolveIdentityFromRequest(req, body)
    if (!hasRequestIdentity(identity)) {
      sendJson(res, 401, { ok: false, message: "请先完成微信登录" })
      return
    }
    sendJson(res, 200, { ok: true, data: await applyRefundRequest({ ...body, ...identity }) })
    return
  }

  if (url.pathname.match(/^\/api\/orders\/[^/]+\/after-sales\/apply$/) && req.method === "POST") {
    const body = JSON.parse((await readBody(req)).toString() || "{}")
    const identity = await resolveIdentityFromRequest(req, body)
    if (!hasRequestIdentity(identity)) {
      sendJson(res, 401, { ok: false, message: "请先完成微信登录" })
      return
    }
    const orderId = decodeURIComponent(url.pathname.split("/")[3])
    sendJson(res, 200, { ok: true, data: await applyAfterSalesRequest({ ...body, ...identity, orderId }) })
    return
  }

  if (url.pathname === "/api/order-recommendation/event" && req.method === "POST") {
    if (!checkOrderRecommendationEventRateLimit(req)) {
      sendJson(res, 429, { ok: false, message: "操作过于频繁，请稍后再试" })
      return
    }
    const body = JSON.parse((await readBody(req)).toString() || "{}")
    sendJson(res, 200, { ok: true, data: await recordOrderRecommendationEvent(await validateOrderRecommendationEventInput(body)) })
    return
  }

  if (url.pathname === "/api/ai/preview") {
    const decision = aiPreviewRouteDecision({
      enabled: AI_PREVIEW_ENABLED,
      isAdmin: isAuthed(req),
      method: req.method
    })
    if (decision.status !== 200) {
      sendJson(res, decision.status, { ok: false, message: decision.message })
      return
    }
    sendJson(res, 200, { ok: true, data: await createAiPreview(JSON.parse((await readBody(req)).toString() || "{}")) })
    return
  }

  if (url.pathname === "/api/wechat/openid" && req.method === "POST") {
    const body = JSON.parse((await readBody(req)).toString() || "{}")
    const openid = await getOpenid(body.code)
    const existingCustomer = (await getCustomers()).find(item => item.openid === openid && normalizePhone(item.phone))
    const userSession = await createWechatUserSession(openid, existingCustomer?.phone || "")
    sendJson(res, 200, { ok: true, openid, userSession, userToken: userSession, token: userSession })
    return
  }

  if (url.pathname === "/api/wechat/phone" && req.method === "POST") {
    const body = JSON.parse((await readBody(req)).toString() || "{}")
    if (!body.code) {
      sendJson(res, 400, { ok: false, message: "缺少手机号授权 code" })
      return
    }
    if (!body.loginCode) {
      sendJson(res, 400, { ok: false, message: "缺少 wx.login code" })
      return
    }
    const openid = await getOpenid(body.loginCode)
    const phoneNumber = await getWechatPhoneNumber(body.code)
    const userSession = openid ? await createWechatUserSession(openid, phoneNumber) : ""
    sendJson(res, 200, {
      ok: true,
      phoneNumber,
      openid,
      userSession,
      userToken: userSession,
      token: userSession
    })
    return
  }

  if (url.pathname === "/api/auth/session" && req.method === "GET") {
    const identity = await resolveIdentityFromRequest(req, Object.fromEntries(url.searchParams.entries()))
    if (!identity.openid || !identity.phone) {
      sendJson(res, 401, { ok: false, message: "登录状态已过期，请重新登录" })
      return
    }
    const customer = (await getCustomers()).find(item =>
      (identity.openid && item.openid === identity.openid) ||
      (identity.phone && normalizePhone(item.phone) === normalizePhone(identity.phone))
    )
    sendJson(res, 200, {
      ok: true,
      data: {
        authenticated: true,
        hasPhone: true,
        phone: identity.phone,
        userInfo: customer ? {
          name: customer.name || customer.nickname || "",
          avatarUrl: customer.avatarUrl || ""
        } : {}
      }
    })
    return
  }

  if (url.pathname === "/api/user/profile" && req.method === "GET") {
    const identity = await resolveIdentityFromRequest(req, Object.fromEntries(url.searchParams.entries()))
    if (!hasRequestIdentity(identity)) {
      sendJson(res, 401, { ok: false, message: "请先完成微信登录" })
      return
    }
    sendJson(res, 200, { ok: true, data: await getUserProfile(identity) })
    return
  }

  if (url.pathname === "/api/user/profile" && req.method === "POST") {
    const body = JSON.parse((await readBody(req)).toString() || "{}")
    const identity = await resolveIdentityFromRequest(req, body)
    if (!hasRequestIdentity(identity)) {
      sendJson(res, 401, { ok: false, message: "请先完成微信登录" })
      return
    }
    sendJson(res, 200, { ok: true, data: await saveUserProfile(identity, body) })
    return
  }

  if (url.pathname === "/api/pay/wechat" && req.method === "POST") {
    const body = JSON.parse((await readBody(req)).toString() || "{}")
    const identity = await resolveIdentityFromRequest(req, body)
    if (!hasRequestIdentity(identity)) {
      sendJson(res, 401, { ok: false, message: "请先完成微信登录" })
      return
    }
    sendJson(res, 200, { ok: true, data: await createWechatPay(body.orderId, identity.openid, identity) })
    return
  }

  if (url.pathname === "/api/pay/mock-success" && req.method === "POST") {
    if (IS_PRODUCTION) {
      sendJson(res, 403, { ok: false, message: "mock payment disabled in production" })
      return
    }
    if (!PAY_MOCK) {
      sendJson(res, 403, { ok: false, message: "mock payment disabled" })
      return
    }
    if (!isLocalhostRequest(req) && !isAuthed(req)) {
      sendJson(res, 403, { ok: false, message: "mock payment requires localhost or admin session" })
      return
    }
    const body = JSON.parse((await readBody(req)).toString() || "{}")
    await markOrderPaid(body.orderId, `MOCK${Date.now()}`)
    sendJson(res, 200, { ok: true })
    return
  }

  if (url.pathname === "/api/pay/notify" && req.method === "POST") {
    const rawBody = (await readBody(req, 1024 * 1024)).toString()
    console.log("[pay] notify received", { hasBody: !!rawBody })
    verifyWechatPayNotify(req, rawBody)
    console.log("[pay] notify signature verified")
    const body = JSON.parse(rawBody || "{}")
    const resource = decryptWechatResource(body.resource)
    console.log("[pay] notify decrypted", {
      orderId: resource.out_trade_no || "",
      tradeState: resource.trade_state || "",
      hasTransactionId: !!resource.transaction_id
    })
    if (resource.trade_state === "SUCCESS") {
      const confirmed = await queryWechatPayOrder(resource.out_trade_no)
      console.log("[pay] notify query confirmed", {
        orderId: resource.out_trade_no || "",
        tradeState: confirmed.trade_state || "",
        hasTransactionId: !!confirmed.transaction_id
      })
      if (confirmed.trade_state !== "SUCCESS") throw new Error("微信支付订单未确认成功")
      await assertConfirmedPaymentMatchesOrder(confirmed)
      const transactionId = confirmed.transaction_id || resource.transaction_id || ""
      const updated = await markOrderPaid(resource.out_trade_no, transactionId, {
        queueWecomNotification: true
      })
      console.log("[pay] notify mark paid result", { orderId: resource.out_trade_no || "", updated })
    }
    sendJson(res, 200, { code: "SUCCESS", message: "成功" })
    return
  }

  if (url.pathname === "/api/pay/refund/notify" && req.method === "POST") {
    const rawBody = (await readBody(req, 1024 * 1024)).toString()
    console.log("[refund-notify] received", { hasBody: !!rawBody })
    verifyWechatPayNotify(req, rawBody)
    const body = JSON.parse(rawBody || "{}")
    const resource = decryptWechatResource(body.resource)
    console.log("[refund-notify] decrypted", {
      outRefundNo: resource.out_refund_no || "",
      refundStatus: resource.refund_status || resource.status || "",
      hasRefundId: !!resource.refund_id
    })
    const refundNo = resource.out_refund_no || ""
    const refundId = resource.refund_id || ""
    const order = (await getOrders()).find(item =>
      (refundNo && item.refundNo === refundNo) ||
      (refundId && item.refundId === refundId)
    )
    if (order && (resource.refund_status === "SUCCESS" || resource.status === "SUCCESS")) {
      await markRefundSuccess(order, resource)
    }
    sendJson(res, 200, { code: "SUCCESS", message: "成功" })
    return
  }

  if (url.pathname === "/api/promotion/summary" && req.method === "GET") {
    const identity = await resolveIdentityFromRequest(req, Object.fromEntries(url.searchParams.entries()))
    if (!identity.phone) throw httpError(401, "请先完成手机号快捷登录")
    sendJson(res, 200, await getPromotionSummary(identity.phone))
    return
  }

  if (url.pathname === "/api/promotion/stats" && req.method === "GET") {
    const identity = await resolveIdentityFromRequest(req, Object.fromEntries(url.searchParams.entries()))
    if (!identity.phone) throw httpError(401, "请先完成手机号快捷登录")
    const summary = await getPromotionSummary(identity.phone)
    sendJson(res, 200, { ok: true, data: summary.profile, profile: summary.profile })
    return
  }

  if (url.pathname === "/api/promotion/orders" && req.method === "GET") {
    const identity = await resolveIdentityFromRequest(req, Object.fromEntries(url.searchParams.entries()))
    if (!identity.phone) throw httpError(401, "请先完成手机号快捷登录")
    const summary = await getPromotionSummary(identity.phone)
    sendJson(res, 200, { ok: true, data: summary.orders || [], orders: summary.orders || [] })
    return
  }

  if (url.pathname === "/api/promotion/poster-code" && req.method === "GET") {
    const invite = url.searchParams.get("invite") || url.searchParams.get("code") || "VSCUSTOM"
    const result = await generatePromotionWxacode(invite)
    sendJson(res, 200, { ok: true, data: result })
    return
  }

  if (url.pathname === "/api/product/poster-code" && req.method === "GET") {
    const productId = url.searchParams.get("productId") || url.searchParams.get("id") || ""
    const ref = url.searchParams.get("ref") || ""
    const result = await generateProductWxacode(productId, ref)
    sendJson(res, 200, { ok: true, data: result, url: result.url, path: result.path })
    return
  }

  if (url.pathname === "/api/newcomer/benefits" && req.method === "GET") {
    const identity = await resolveIdentityFromRequest(req, {})
    sendJson(res, 200, await getNewcomerBenefits({
      phone: identity.phone || "",
      openid: identity.openid || ""
    }))
    return
  }

  if (url.pathname === "/api/promotion/qr" && (req.method === "GET" || req.method === "HEAD")) {
    const code = (url.searchParams.get("code") || "VSCUSTOM").replace(/[^\w-]/g, "")
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="360" viewBox="0 0 360 360"><rect width="360" height="360" rx="34" fill="#fffaf7"/><rect x="38" y="38" width="284" height="284" rx="22" fill="#202020"/><rect x="64" y="64" width="232" height="232" rx="16" fill="#fff"/><g fill="#202020">${Array.from({ length: 64 }).map((_, index) => {
      const x = 78 + (index % 8) * 26
      const y = 78 + Math.floor(index / 8) * 26
      const show = (code.charCodeAt(index % code.length) + index) % 3 !== 0
      return show ? `<rect x="${x}" y="${y}" width="16" height="16" rx="3"/>` : ""
    }).join("")}</g><rect x="96" y="150" width="168" height="60" rx="18" fill="#fffaf7"/><text x="180" y="186" font-size="22" font-weight="700" text-anchor="middle" fill="#202020">${code}</text></svg>`
    sendText(res, 200, svg, "image/svg+xml")
    return
  }

  if (url.pathname === "/api/promotion/bind" && req.method === "POST") {
    const body = JSON.parse((await readBody(req)).toString() || "{}")
    const identity = await resolveIdentityFromRequest(req, body)
    if (!identity.phone) {
      sendJson(res, 401, { ok: false, message: "请先完成微信手机号登录" })
      return
    }
    const relation = await bindPromotionRelation(body.inviterCode || body.invite, identity.phone, body.name || "微信用户", true)
    sendJson(res, 200, { ok: true, data: relation })
    return
  }

  if (url.pathname === "/api/promotion/visit" && req.method === "POST") {
    const body = JSON.parse((await readBody(req)).toString() || "{}")
    sendJson(res, 200, { ok: true, data: await recordPromotionVisit(body) })
    return
  }

  if (url.pathname === "/api/sales/login" && req.method === "POST") {
    if (isSalesLoginLocked(req)) {
      sendJson(res, 429, { ok: false, message: "手机号或密码错误" })
      return
    }
    const body = JSON.parse((await readBody(req)).toString() || "{}")
    const phone = normalizePhone(body.phone || "")
    const agent = (await getSalesAgents()).find(item => item.phone === phone && item.status === "active")
    if (!agent || !verifyPassword(body.password || "", agent.passwordHash)) {
      recordSalesLoginFailure(req)
      sendJson(res, 401, { ok: false, message: "手机号或密码错误" })
      return
    }
    clearSalesLoginFailures(req)
    const sid = crypto.randomBytes(24).toString("hex")
    salesSessions.set(sid, { salesAgentId: agent.id, createdAt: Date.now() })
    sendJson(res, 200, { ok: true, data: salesAgentPublicView(agent) }, { "Set-Cookie": salesSessionCookie(sid) })
    return
  }

  if (url.pathname === "/api/sales/logout" && req.method === "POST") {
    const sid = parseCookies(req).vsc_sales_sid
    if (sid) salesSessions.delete(sid)
    sendJson(res, 200, { ok: true }, { "Set-Cookie": salesSessionCookie("", 0) })
    return
  }

  if (url.pathname.startsWith("/api/sales/")) {
    const salesSession = await requireSalesSession(req, res)
    if (!salesSession) return
    if (url.pathname === "/api/sales/upload" && req.method === "POST") {
      console.log("[sales-photo-upload]", { agentId: salesSession.agent.id, hasSession: true })
      if (!isMultipartFormRequest(req)) {
        sendJson(res, 400, { ok: false, message: "请使用 multipart/form-data 上传图片" })
        return
      }
      const maxBodySize = MAX_TEMP_IMAGE_SIZE * 3 + 1024 * 1024
      const releaseUpload = reserveUploadRequest(req, maxBodySize, "图片超过5MB，请压缩后上传")
      try {
        const body = await readBody(req, maxBodySize, "图片超过5MB，请压缩后上传")
        const files = parseMultipart(body, req.headers["content-type"])
        if (!files.length) {
          sendJson(res, 400, { ok: false, message: "请选择图片" })
          return
        }
        if (files.length > 3) {
          sendJson(res, 400, { ok: false, message: "门店照片最多上传3张" })
          return
        }
        fs.mkdirSync(salesLeadUploadsDir, { recursive: true })
        const uploaded = []
        for (const file of files) {
          const ext = validateImageFile(file, {
            allowedExts: ["jpg", "jpeg", "png", "webp"],
            allowedMimes: ["image/jpeg", "image/png", "image/webp"],
            maxSize: MAX_TEMP_IMAGE_SIZE,
            tooLargeMessage: "单张图片不能超过5MB"
          })
          const cleanExt = ext === "jpeg" ? "jpg" : ext
          const filename = `sales-lead-${salesSession.agent.id}-${Date.now()}-${crypto.randomBytes(8).toString("hex")}.${cleanExt}`
          const relativeName = `sales-leads/${filename}`
          const targetFile = path.join(salesLeadUploadsDir, filename)
          fs.writeFileSync(targetFile, file.body)
          const optimized = await optimizeUploadedImage(targetFile, relativeName, "image")
          uploaded.push({ ...optimized, url: optimized.url || uploadPublicUrl(relativeName), type: "image" })
        }
        sendJson(res, 200, {
          ok: true,
          urls: uploaded.map(item => item.url),
          thumbUrls: uploaded.map(item => item.thumbUrl || item.url),
          data: uploaded
        })
      } finally {
        releaseUpload()
      }
      return
    }
    if (url.pathname === "/api/sales/store-leads" && req.method === "GET") {
      const leads = (await getStoreLeads({ salesAgentId: salesSession.agent.id })).map(lead => ({ ...lead, statusText: leadStatusText(lead.status) }))
      sendJson(res, 200, { ok: true, data: leads })
      return
    }
    if (url.pathname === "/api/sales/store-leads" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)).toString() || "{}")
      const lead = await createStoreLead(salesSession.agent.id, body)
      sendJson(res, 200, { ok: true, message: "门店信息已提交，等待后台审核。", data: lead })
      return
    }
    if (url.pathname === "/api/sales/dashboard" && req.method === "GET") {
      const agentId = salesSession.agent.id
      const [stores, leads, orders, commissions] = await Promise.all([
        getPartnerStores(),
        getStoreLeads({ salesAgentId: agentId }),
        getOrders(),
        getSalesAgentCommissions({ salesAgentId: agentId })
      ])
      const agentStores = stores.filter(store => store.salesAgentId === agentId)
      const storeIds = new Set(agentStores.map(store => store.id))
      const relevantOrders = orders.filter(order => storeIds.has(order.pickupStoreId || order.referrerStoreId || "") && isOrderPaidForPickupCredential(order) && !isOrderRefunded(order))
      const orderLookup = buildOrderLookup(orders)
      const decorated = commissions.map(record => decorateSettlementRecord(record, orderLookup))
      const storeRows = agentStores.map(store => {
        const storeRecords = decorated.filter(record => record.storeId === store.id && record.status !== "cancelled")
        const storeOrders = relevantOrders.filter(order => (order.pickupStoreId || order.referrerStoreId || "") === store.id)
        return {
          ...store,
          orderCount: storeOrders.length,
          salesAmount: money(storeOrders.reduce((sum, order) => sum + Number(order.amount || 0), 0)),
          ...buildSettlementSummary(storeRecords, orderLookup)
        }
      })
      sendJson(res, 200, {
        ok: true,
        agent: salesAgentPublicView(salesSession.agent),
        summary: buildSettlementSummary(decorated.filter(record => record.status !== "cancelled"), orderLookup),
        overview: {
          storeCount: agentStores.length,
          pendingLeadCount: leads.filter(lead => lead.status === "pending").length,
          orderCount: relevantOrders.length,
          salesAmount: money(relevantOrders.reduce((sum, order) => sum + Number(order.amount || 0), 0)),
          totalCommission: money(commissions.filter(record => record.status !== "cancelled").reduce((sum, record) => sum + Number(record.amount || 0), 0))
        },
        stores: storeRows,
        records: decorated.map(record => ({
          ...record,
          storeName: agentStores.find(store => store.id === record.storeId)?.name || record.storeId,
          typeText: salesCommissionTypeText(record.type),
          statusText: settlementStatusText(record.effectiveStatus || record.status),
          createdAtText: formatChinaDatetime(record.createdAt),
          settledAtText: formatChinaDatetime(record.settledAt)
        }))
      })
      return
    }
    sendJson(res, 404, { ok: false, message: "Not found" })
    return
  }

  if (!url.pathname.startsWith("/api/admin") && url.pathname !== "/api/home" && url.pathname !== "/api/theme/current" && url.pathname !== "/api/upload" && url.pathname !== "/api/upload/public") {
    sendJson(res, 404, { ok: false, message: "Not found" })
    return
  }

  if (url.pathname === "/api/home" && req.method === "PUT") {
    if (!requireAuth(req, res)) return
    sendJson(res, 200, { ok: true, data: await saveHome(JSON.parse((await readBody(req)).toString())) })
    return
  }

  if ((url.pathname === "/api/upload" || url.pathname === "/api/upload/public") && req.method === "POST") {
    if (url.pathname === "/api/upload" && !requireAuth(req, res)) return
    if (!isMultipartFormRequest(req)) {
      sendJson(res, 400, { ok: false, message: "请使用 multipart/form-data 上传图片" })
      return
    }
    const isPublicUpload = url.pathname === "/api/upload/public"
    const isProductImageUpload = url.pathname === "/api/upload" && url.searchParams.get("purpose") === "product-image"
    const userSession = isPublicUpload ? await userSessionFromRequest(req) : null
    const loggedInPublicUpload = !!userSession?.openid
    if (isPublicUpload && !loggedInPublicUpload && !checkPublicUploadRateLimit(req)) {
      sendJson(res, 429, { ok: false, message: "临时上传过于频繁，请登录后继续上传或稍后再试" })
      return
    }
    if (isPublicUpload && loggedInPublicUpload && !checkAuthenticatedUploadRateLimit(req)) {
      sendJson(res, 429, { ok: false, message: "上传过于频繁，请稍后再试" })
      return
    }
    await cleanupOrphanTempUploads()
    const publicLimit = loggedInPublicUpload ? MAX_IMAGE_SIZE : MAX_TEMP_IMAGE_SIZE
    const maxBodySize = isPublicUpload ? publicLimit * 9 + 1024 * 1024 : MAX_VIDEO_SIZE + 1024 * 1024
    const releaseUpload = reserveUploadRequest(
      req,
      maxBodySize,
      loggedInPublicUpload ? "图片超过10MB，请压缩后上传" : "上传内容超过限制"
    )
    res.once("finish", releaseUpload)
    res.once("close", releaseUpload)
    const body = await readBody(req, maxBodySize, loggedInPublicUpload ? "图片超过10MB，请压缩后上传" : "临时上传图片超过5MB，请登录后上传或压缩图片")
    const files = parseMultipart(body, req.headers["content-type"])
    if (!files.length) {
      sendJson(res, 400, { ok: false, message: "请选择图片" })
      return
    }
    if (isPublicUpload && files.length > 9) {
      sendJson(res, 400, { ok: false, message: "每次最多上传9张图片" })
      return
    }
    if (isProductImageUpload) {
      const uploaded = []
      for (const file of files) {
        if (file.body.length > MAX_PRODUCT_IMAGE_SIZE) {
          throw uploadInputError(413, "商品图片超过10MB")
        }
        let optimized
        try {
          optimized = await optimizeProductImageUpload({
            buffer: file.body,
            outputDir: productUploadsDir,
            sourceName: file.filename || "product-image"
          })
        } catch (error) {
          throw uploadInputError(400, error.message || "商品图片压缩失败")
        }
        uploaded.push({
          url: `${PUBLIC_BASE_URL}/uploads/products/${optimized.filename}`,
          type: "image",
          width: optimized.width,
          height: optimized.height,
          originalSizeBytes: optimized.originalSizeBytes,
          sizeBytes: optimized.sizeBytes
        })
      }
      const first = uploaded[0]
      sendJson(res, 200, {
        ok: true,
        ...first,
        urls: uploaded.map(item => item.url),
        type: "image"
      })
      return
    }
    const uploaded = []
    for (const file of files) {
      const uploadType = isPublicUpload ? validatePublicUploadImage(file, loggedInPublicUpload) : validateUploadFile(file)
      if (isPublicUpload && uploadType.type !== "image") throw new Error("仅支持上传jpg/jpeg/png/webp/heic图片")
      const filename = isPublicUpload ? publicUploadFilename(uploadType.ext, !loggedInPublicUpload) : safeName(file.filename || `upload.${uploadType.ext}`)
      const targetFile = path.join(uploadsDir, filename)
      fs.writeFileSync(targetFile, file.body)
      const optimized = uploadType.type === "image" ? await optimizeUploadedImage(targetFile, filename, uploadType.type) : { url: uploadPublicUrl(filename), size: file.body.length, warning: "" }
      if (uploadType.type === "image" && file.body.length > 2 * 1024 * 1024) {
        optimized.warning = optimized.warning || "图片较大，已尝试压缩；建议上传前先压缩，提升小程序加载速度"
      }
      uploaded.push({ ...optimized, type: uploadType.type })
    }
    const first = uploaded[0]
    sendJson(res, 200, {
      ok: true,
      ...first,
      urls: uploaded.map(item => item.url),
      optimizedUrls: uploaded.map(item => item.optimizedUrl || item.url),
      thumbUrls: uploaded.map(item => item.thumbUrl || item.url),
      type: first.type,
      temporary: isPublicUpload && !loggedInPublicUpload
    })
    return
  }

  if (!requireAuth(req, res)) return

  if (url.pathname === "/api/admin/products/import-template" && req.method === "GET") {
    sendText(
      res,
      200,
      createProductImportTemplateBuffer(),
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      { "Content-Disposition": "attachment; filename=\"product-import-template.xlsx\"" }
    )
    return
  }

  if (url.pathname === "/api/admin/products/import-preview" && req.method === "POST") {
    const body = await readBody(req, MAX_IMPORT_EXCEL_SIZE + MAX_IMPORT_ZIP_SIZE + 2 * 1024 * 1024, "导入文件超过限制：Excel最大5MB，ZIP最大50MB")
    const parts = parseMultipart(body, req.headers["content-type"])
    sendJson(res, 200, { ok: true, data: await createProductImportPreview(parts) })
    return
  }

  if (url.pathname === "/api/admin/products/import-confirm" && req.method === "POST") {
    const body = JSON.parse((await readBody(req)).toString() || "{}")
    sendJson(res, 200, { ok: true, data: await confirmProductImport(body.token) })
    return
  }

  if (url.pathname === "/api/admin/overview" && req.method === "GET") {
    const [home, orders, customers, products, rewards, relations, visits, orderRecommendEvents] = await Promise.all([getHome(), getOrders(), getCustomers(), getProducts(), processRewardState(), getPromotionRelations(), getPromotionVisits(), getOrderRecommendationEvents()])
    const orderAmount = orders.reduce((sum, order) => sum + Number(order.amount || 0), 0)
    const paidOrders = orders.filter(order => order.paymentStatus === "已支付" || order.paidAt || ["待发货", "制作中", "已发货", "已完成", "退款中", "已退款"].includes(order.status))
    const salesAmount = paidOrders.reduce((sum, order) => sum + Number(order.amount || 0), 0)
    const productCost = paidOrders.reduce((sum, order) => {
      const product = products.find(item => item.id === order.productId || item.name === order.productName) || {}
      return sum + Number(product.costPrice || 0)
    }, 0)
    const refundAmount = orders.reduce((sum, order) => {
      const refunded = order.status === "已退款" || order.paymentStatus === "已退款" || order.afterSalesStatus === "refunded" || order.refundStatus === "退款成功"
      if (!refunded) return sum
      if (order.refundAmount) return sum + Number(order.refundAmount || 0)
      return sum + Number(order.amount || 0)
    }, 0)
    const rewardPaid = rewards.filter(record => record.status === "settled").reduce((sum, record) => sum + Number(record.amount || 0), 0)
    const estimatedProfit = salesAmount - productCost - refundAmount - rewardPaid
    const inviteOrders = paidOrders.filter(order => order.inviterCode).length
    const inviteAmount = paidOrders.filter(order => order.inviterCode).reduce((sum, order) => sum + Number(order.amount || 0), 0)
    const newcomerUsed = paidOrders.filter(order => String(order.remark || "").includes("新人福利")).length
    const inviteVisits = visits.length
    const newcomerConversionRate = inviteVisits ? ((newcomerUsed / inviteVisits) * 100).toFixed(1) : "0"
    const orderRecommendClicks = orderRecommendEvents.filter(event => event.type === "click").length
    const orderRecommendConversions = orderRecommendEvents.filter(event => event.type === "conversion").length
    const orderRecommendRate = orderRecommendClicks ? ((orderRecommendConversions / orderRecommendClicks) * 100).toFixed(1) : "0"
    sendJson(res, 200, {
      products: products.length,
      orders: orders.length,
      customers: customers.length,
      rewards: rewards.length,
      orderAmount: orderAmount.toFixed(2),
      salesAmount: salesAmount.toFixed(2),
      productCost: productCost.toFixed(2),
      refundAmount: refundAmount.toFixed(2),
      rewardPaid: rewardPaid.toFixed(2),
      estimatedProfit: estimatedProfit.toFixed(2),
      inviteVisits,
      inviteRegisters: relations.length,
      inviteOrders,
      inviteAmount: inviteAmount.toFixed(2),
      newcomerUsed,
      newcomerConversionRate,
      orderRecommendClicks,
      orderRecommendConversions,
      orderRecommendRate,
      pendingOrders: orders.filter(order => !["已发货", "已完成"].includes(order.status)).length,
      updatedAt: home.updatedAt || ""
    })
    return
  }

  if (url.pathname === "/api/admin/debug/home-banners" && req.method === "GET") {
    const home = await getHome()
    sendJson(res, 200, {
      ok: true,
      banners: (home.banners || []).slice(0, 3).map((banner, index) => ({
        ...bannerSummaryForLog(banner, index),
        finalImageUrl: banner.finalImageUrl || withVersion(banner.bannerUrl || banner.optimizedUrl || banner.imageUrl || "", banner.version || banner.updatedAt)
      }))
    })
    return
  }

  if (url.pathname === "/api/admin/products" && req.method === "GET") {
    sendJson(res, 200, await getProducts())
    return
  }

  if (url.pathname === "/api/admin/products" && req.method === "PUT") {
    sendJson(res, 200, { ok: true, data: await saveProducts(JSON.parse((await readBody(req)).toString())) })
    return
  }

  if (url.pathname === "/api/admin/orders" && req.method === "GET") {
    sendJson(res, 200, await getOrders({ keyword: url.searchParams.get("keyword"), status: url.searchParams.get("status") }))
    return
  }

  if (url.pathname === "/api/admin/orders" && req.method === "PUT") {
    const incoming = JSON.parse((await readBody(req)).toString() || "[]")
    if (!Array.isArray(incoming)) throw httpError(400, "订单数据格式不正确")
    const previousOrders = await getOrders()
    for (const next of incoming) {
      const previous = previousOrders.find(item => item.id === next.id)
      if (!previous) throw httpError(400, "后台订单接口仅允许编辑已有订单，不能创建或导入新订单")
      assertAdminTransition(previous, next)
    }
    const saved = await saveOrders(incoming)
    for (const next of incoming) {
      const previous = previousOrders.find(item => item.id === next.id)
      if (!previous) continue
      if (previous.status !== next.status || previous.pickupStatus !== next.pickupStatus || previous.refundStatus !== next.refundStatus) {
        await recordOrderStateAudit(previous, next, {
          source: "admin_order_edit",
          operatorId: "admin",
          reason: "后台编辑订单"
        })
      }
    }
    sendJson(res, 200, { ok: true, data: saved })
    return
  }

  if (url.pathname === "/api/admin/orders/ship" && req.method === "POST") {
    sendJson(res, 200, { ok: true, data: await applyShipment(JSON.parse((await readBody(req)).toString() || "{}")) })
    return
  }

  if (url.pathname.match(/^\/api\/admin\/orders\/[^/]+\/arrived-store$/) && req.method === "POST") {
    const orderId = decodeURIComponent(url.pathname.split("/")[4])
    sendJson(res, 200, { ok: true, data: await markOrderArrivedStore(orderId) })
    return
  }

  if (url.pathname.match(/^\/api\/admin\/orders\/[^/]+\/picked-up$/) && req.method === "POST") {
    const orderId = decodeURIComponent(url.pathname.split("/")[4])
    throw httpError(400, "该订单尚未完成自提核销，不能直接设为已完成。请使用取货码核销或管理员强制核销。")
  }

  if (url.pathname.match(/^\/api\/admin\/orders\/[^/]+\/force-pickup$/) && req.method === "POST") {
    const orderId = decodeURIComponent(url.pathname.split("/")[4])
    const body = JSON.parse((await readBody(req)).toString() || "{}")
    sendJson(res, 200, {
      ok: true,
      data: await markOrderPickedUp(orderId, {
        force: true,
        reason: body.reason,
        operatorId: "admin",
        requestKey: body.requestKey || ""
      })
    })
    return
  }

  if (url.pathname.match(/^\/api\/admin\/orders\/[^/]+\/wechat-fulfillment\/retry$/) && req.method === "POST") {
    const orderId = decodeURIComponent(url.pathname.split("/")[4])
    const order = (await getOrders({ keyword: orderId })).find(item => item.id === orderId)
    if (!order) throw httpError(404, "订单不存在")
    const node = isPickupOrder(order)
      ? (["PICKED_UP", "READY_FOR_PICKUP"].includes(lifecycleView(order).fulfillmentStatus) ? "PICKUP_READY" : "")
      : (order.status === "已发货" ? "SHIPPED" : "")
    if (!node) throw httpError(400, "订单尚未到达可同步的真实履约节点")
    await query(
      `INSERT INTO wechat_fulfillment_records
        (order_id, business_node, status, attempt_count, next_retry_at, created_at, updated_at)
       VALUES (:orderId, :node, 'PENDING', 0, NOW(), NOW(), NOW())
       ON DUPLICATE KEY UPDATE
         status=IF(status='SENT','SENT','PENDING'),
         attempt_count=IF(status='SENT',attempt_count,0),
         next_retry_at=IF(status='SENT',next_retry_at,NOW()),
         last_error=IF(status='SENT',last_error,NULL),
         updated_at=NOW()`,
      { orderId, node }
    )
    setImmediate(runWechatFulfillmentWorkerSafe)
    await recordOrderStateAudit(order, order, {
      source: "admin_wechat_fulfillment_retry",
      operatorId: "admin",
      reason: "后台重新同步微信履约状态",
      wechatSyncResult: "已进入重试队列"
    })
    sendJson(res, 200, { ok: true, message: "已进入微信履约同步队列" })
    return
  }

  if (url.pathname === "/api/admin/orders/refund-review" && req.method === "POST") {
    sendJson(res, 200, { ok: true, data: await reviewRefund(JSON.parse((await readBody(req)).toString() || "{}")) })
    return
  }

  if (url.pathname.match(/^\/api\/admin\/orders\/[^/]+\/after-sales\/approve-refund$/) && req.method === "POST") {
    const orderId = decodeURIComponent(url.pathname.split("/")[4])
    const body = JSON.parse((await readBody(req)).toString() || "{}")
    sendJson(res, 200, { ok: true, data: await approveAfterSalesRefund(orderId, body) })
    return
  }

  if (url.pathname.match(/^\/api\/admin\/orders\/[^/]+\/after-sales\/reject$/) && req.method === "POST") {
    const orderId = decodeURIComponent(url.pathname.split("/")[4])
    const body = JSON.parse((await readBody(req)).toString() || "{}")
    sendJson(res, 200, { ok: true, data: await rejectAfterSales(orderId, body.rejectReason || body.reason || "") })
    return
  }

  if (url.pathname.match(/^\/api\/admin\/orders\/[^/]+\/after-sales\/convert$/) && req.method === "POST") {
    const orderId = decodeURIComponent(url.pathname.split("/")[4])
    const body = JSON.parse((await readBody(req)).toString() || "{}")
    sendJson(res, 200, { ok: true, data: await convertAfterSales(orderId, body.type || "补发") })
    return
  }

  if (url.pathname.match(/^\/api\/admin\/orders\/[^/]+\/refund-status$/) && req.method === "GET") {
    const orderId = decodeURIComponent(url.pathname.split("/")[4])
    sendJson(res, 200, { ok: true, data: await syncRefundStatus(orderId) })
    return
  }

  if (url.pathname === "/api/admin/sales-agents" && req.method === "GET") {
    const [agents, stores, records, orders] = await Promise.all([getSalesAgents(), getPartnerStores(), getSalesAgentCommissions(), getOrders()])
    const orderLookup = buildOrderLookup(orders)
    sendJson(res, 200, agents.map(agent => {
      const agentRecords = records.filter(record => record.salesAgentId === agent.id && record.status !== "cancelled").map(record => decorateSettlementRecord(record, orderLookup))
      return {
        ...salesAgentPublicView(agent),
        storeCount: stores.filter(store => store.salesAgentId === agent.id).length,
        ...buildSettlementSummary(agentRecords, orderLookup)
      }
    }))
    return
  }

  if (url.pathname === "/api/admin/sales-agents" && req.method === "POST") {
    const body = JSON.parse((await readBody(req)).toString() || "{}")
    sendJson(res, 200, { ok: true, data: await upsertSalesAgent(body) })
    return
  }

  if (url.pathname.match(/^\/api\/admin\/sales-agents\/[^/]+$/) && req.method === "PUT") {
    const id = decodeURIComponent(url.pathname.split("/").pop())
    const body = JSON.parse((await readBody(req)).toString() || "{}")
    sendJson(res, 200, { ok: true, data: await upsertSalesAgent({ ...body, id }) })
    return
  }

  if (url.pathname === "/api/admin/store-leads" && req.method === "GET") {
    const [leads, agents] = await Promise.all([getStoreLeads({ status: url.searchParams.get("status") || "" }), getSalesAgents()])
    const data = []
    for (const lead of leads) {
      const agent = agents.find(item => item.id === lead.salesAgentId) || {}
      data.push({
        ...lead,
        statusText: leadStatusText(lead.status),
        salesAgentName: agent.name || "",
        salesAgentPhone: agent.phone || "",
        duplicateStores: await duplicateStoreCandidatesForLead(lead)
      })
    }
    sendJson(res, 200, data)
    return
  }

  const leadActionMatch = url.pathname.match(/^\/api\/admin\/store-leads\/([^/]+)\/(create|bind|follow|reject)$/)
  if (leadActionMatch && req.method === "POST") {
    const [, id, action] = leadActionMatch
    const body = JSON.parse((await readBody(req)).toString() || "{}")
    sendJson(res, 200, { ok: true, data: await handleStoreLead(decodeURIComponent(id), action, body) })
    return
  }

  if (url.pathname === "/api/admin/sales-agent-commissions" && req.method === "GET") {
    const result = await getSalesAgentSummary({
      salesAgentId: url.searchParams.get("salesAgentId") || "",
      storeId: url.searchParams.get("storeId") || "",
      status: url.searchParams.get("status") || "",
      type: url.searchParams.get("type") || "",
      startAt: url.searchParams.get("startAt") || "",
      endAt: url.searchParams.get("endAt") || ""
    })
    const agents = new Map(result.agents.map(agent => [agent.id, agent]))
    const stores = new Map(result.stores.map(store => [store.id, store]))
    sendJson(res, 200, {
      summary: result.summary,
      records: result.records.map(record => ({
        ...record,
        salesAgentName: agents.get(record.salesAgentId)?.name || "",
        salesAgentPhone: agents.get(record.salesAgentId)?.phone || "",
        storeName: stores.get(record.storeId)?.name || record.storeId
      }))
    })
    return
  }

  const salesCommissionActionMatch = url.pathname.match(/^\/api\/admin\/sales-agent-commissions\/([^/]+)\/(settle|cancel)$/)
  if (salesCommissionActionMatch && req.method === "POST") {
    const [, id, action] = salesCommissionActionMatch
    const body = JSON.parse((await readBody(req)).toString() || "{}")
    const recordId = decodeURIComponent(id)
    const records = pool
      ? await query("SELECT * FROM sales_agent_commissions WHERE id=:id LIMIT 1", { id: recordId })
      : await getSalesAgentCommissions()
    const record = pool
      ? (records[0] ? normalizeSalesAgentCommission(records[0], 0) : null)
      : records.find(item => item.id === recordId)
    if (!record) throw httpError(404, "业务员佣金记录不存在")
    if (action === "settle") {
      if (record.status === "settled") throw httpError(400, "该记录已结算，请勿重复操作。")
      if (record.status === "cancelled") throw httpError(400, "该记录已取消，不能结算。")
      const orderLookup = buildOrderLookup(await getOrders())
      if (!isFinancialRecordReadyToSettle(record, orderLookup)) throw httpError(400, "该记录仍为待确认，订单完成后才能结算。")
      if (pool) {
        const result = await settleSalesAgentCommissionRecords([record.id], {
          note: body.note || body.settleNote || "",
          batchId: `SAS${Date.now()}`
        })
        if (result.count !== 1) throw httpError(409, "该记录已被处理或尚不可结算")
      } else {
        record.status = "settled"
        record.settledAt = formatDateTime(new Date())
        record.settledBy = "admin"
        record.settleNote = body.note || body.settleNote || ""
      }
    } else {
      if (record.status === "cancelled") throw httpError(400, "该记录已取消。")
      if (record.status === "settled") throw httpError(409, "已结算历史记录不可取消")
      if (pool) {
        const result = await query(
          `UPDATE sales_agent_commissions
           SET status='cancelled', cancel_reason=:reason
           WHERE id=:id AND status IN ('pending_confirm','unsettled')`,
          {
            id: record.id,
            reason: body.reason || body.cancelReason || "后台取消业务员佣金"
          }
        )
        if (Number(result.affectedRows || 0) !== 1) throw httpError(409, "该记录已被其他操作处理")
      } else {
        record.status = "cancelled"
        record.cancelReason = body.reason || body.cancelReason || "后台取消业务员佣金"
      }
    }
    if (!pool) await saveSalesAgentCommissions(records)
    const refreshed = (await getSalesAgentCommissions()).find(item => item.id === record.id)
    sendJson(res, 200, { ok: true, data: refreshed || record })
    return
  }

  if (url.pathname === "/api/admin/sales-agent-commissions/adjustment" && req.method === "POST") {
    const body = JSON.parse((await readBody(req)).toString() || "{}")
    const amount = money(body.amount)
    if (!body.salesAgentId) throw httpError(400, "请选择业务员")
    if (Number(amount) === 0) throw httpError(400, "调整金额不能为 0")
    const now = formatDateTime(new Date())
    const adjustment = normalizeSalesAgentCommission({
      id: `SAA${Date.now()}${crypto.randomBytes(2).toString("hex").toUpperCase()}`,
      salesAgentId: body.salesAgentId,
      storeId: body.storeId || "",
      amount,
      commissionAmount: amount,
      type: "adjustment",
      status: body.status === "settled" ? "settled" : "unsettled",
      settledAt: body.status === "settled" ? now : "",
      settledBy: body.status === "settled" ? "admin" : "",
      settleNote: body.note || "",
      remark: body.note || "后台手动调整",
      createdAt: now
    }, 0)
    if (pool) {
      await insertSalesAgentCommission(adjustment)
    } else {
      const records = await getSalesAgentCommissions()
      records.unshift(adjustment)
      await saveSalesAgentCommissions(records)
    }
    sendJson(res, 200, { ok: true })
    return
  }

  if (url.pathname === "/api/admin/sales-agent-commissions/batch-settle" && req.method === "POST") {
    const body = JSON.parse((await readBody(req)).toString() || "{}")
    const target = await getSalesAgentCommissions({
      salesAgentId: body.salesAgentId || "",
      storeId: body.storeId || "",
      type: body.type || "",
      startAt: body.startAt || "",
      endAt: body.endAt || ""
    })
    const orderLookup = buildOrderLookup(await getOrders())
    const ids = new Set(target.filter(record => isFinancialRecordReadyToSettle(record, orderLookup)).map(record => record.id))
    const batchId = `SAB${Date.now()}${crypto.randomBytes(2).toString("hex").toUpperCase()}`
    let count = 0
    if (pool) {
      count = (await settleSalesAgentCommissionRecords([...ids], {
        note: body.note || "后台批量结算",
        batchId
      })).count
    } else {
      const records = await getSalesAgentCommissions()
      const now = formatDateTime(new Date())
      records.forEach(record => {
        if (!ids.has(record.id) || !isFinancialRecordReadyToSettle(record, orderLookup)) return
        record.status = "settled"
        record.settledAt = now
        record.settledBy = "admin"
        record.settleNote = body.note || "后台批量结算"
        record.batchId = batchId
        count += 1
      })
      await saveSalesAgentCommissions(records)
    }
    sendJson(res, 200, { ok: true, batchId, recordCount: count })
    return
  }

  if (url.pathname === "/api/admin/stores" && req.method === "GET") {
    await ensureLegacyStoreMembers().catch(error => console.warn("[store-members] legacy sync failed", { message: error.message }))
    const [stores, members] = await Promise.all([
      getPartnerStores({ keyword: url.searchParams.get("keyword") || "" }),
      getStoreMembers()
    ])
    sendJson(res, 200, withStoreManagerWarnings(stores).map(store => ({
      ...store,
      members: members.filter(member => member.storeId === store.id).map(member => storeMemberPublicView(member, { includeRawPhone: true }))
    })))
    return
  }

  if (url.pathname === "/api/admin/debug/store-manager" && req.method === "GET") {
    const phone = url.searchParams.get("phone") || ""
    sendJson(res, 200, storeManagerDebugView(await getPartnerStores(), phone))
    return
  }

  if (url.pathname.match(/^\/api\/admin\/stores\/[^/]+\/qrcode$/) && req.method === "GET") {
    const id = decodeURIComponent(url.pathname.split("/")[4])
    const store = await getPartnerStore(id)
    if (!store) throw httpError(404, "门店不存在")
    if (!isStoreEnabled(store)) throw httpError(400, "门店已停用，暂不能生成二维码")
    const result = await generateStoreWxacode(store)
    sendJson(res, 200, {
      ok: true,
      url: result.url,
      scene: result.scene,
      link: `/pages/index/index?store_id=${encodeURIComponent(store.id)}`,
      cached: result.cached
    })
    return
  }

  if (url.pathname === "/api/admin/stores" && req.method === "POST") {
    sendJson(res, 200, { ok: true, data: await upsertPartnerStore(JSON.parse((await readBody(req)).toString() || "{}")) })
    return
  }

  if (url.pathname.match(/^\/api\/admin\/stores\/[^/]+$/) && req.method === "PUT") {
    const id = decodeURIComponent(url.pathname.split("/").pop())
    sendJson(res, 200, { ok: true, data: await upsertPartnerStore({ ...JSON.parse((await readBody(req)).toString() || "{}"), id }) })
    return
  }

  if (url.pathname.match(/^\/api\/admin\/stores\/[^/]+\/status$/) && req.method === "PATCH") {
    const id = decodeURIComponent(url.pathname.split("/")[4])
    const body = JSON.parse((await readBody(req)).toString() || "{}")
    const store = await getPartnerStore(id)
    if (!store) throw new Error("门店不存在")
    sendJson(res, 200, { ok: true, data: await upsertPartnerStore({ ...store, status: body.status === "disabled" ? "disabled" : "enabled" }) })
    return
  }

  if (url.pathname === "/api/admin/store-settlements" && req.method === "GET") {
    sendJson(res, 200, await getStoreSettlementSummary({
      storeId: url.searchParams.get("storeId") || "",
      status: url.searchParams.get("status") || "",
      type: url.searchParams.get("type") || "",
      startAt: url.searchParams.get("startAt") || "",
      endAt: url.searchParams.get("endAt") || ""
    }))
    return
  }

  if (url.pathname === "/api/admin/store-settlements/mark-settled" && req.method === "POST") {
    const body = JSON.parse((await readBody(req)).toString() || "{}")
    const ids = Array.isArray(body.ids) ? body.ids.map(String) : []
    if (pool) {
      await settleStoreSettlementRecords(ids, {
        note: body.note || "后台批量标记已结算",
        batchId: body.batchId || `BATCH${Date.now()}${crypto.randomBytes(2).toString("hex").toUpperCase()}`
      })
    } else {
      const records = await getStoreSettlementRecords()
      const orderLookup = buildOrderLookup(await getOrders())
      const now = formatDateTime(new Date())
      records.forEach(record => {
        if (ids.includes(record.id) && isFinancialRecordReadyToSettle(record, orderLookup)) {
          record.status = "settled"
          record.settledAt = now
          record.settledBy = "admin"
          record.settleNote = body.note || record.settleNote || "后台批量标记已结算"
          record.updatedAt = now
        }
      })
      await saveStoreSettlementRecords(records)
    }
    sendJson(res, 200, { ok: true, data: await getStoreSettlementSummary({}) })
    return
  }

  if ((url.pathname === "/api/admin/store-earnings" || url.pathname === "/api/admin/store-settlements/records") && req.method === "GET") {
    sendJson(res, 200, await getStoreSettlementSummary({
      storeId: url.searchParams.get("storeId") || "",
      status: url.searchParams.get("status") || "",
      type: url.searchParams.get("type") || "",
      startAt: url.searchParams.get("startAt") || "",
      endAt: url.searchParams.get("endAt") || ""
    }))
    return
  }

  const storeEarningMatch = url.pathname.match(/^\/api\/admin\/store-earnings\/([^/]+)\/(settle|cancel)$/)
  if (storeEarningMatch && req.method === "POST") {
    const [, id, action] = storeEarningMatch
    const body = JSON.parse((await readBody(req)).toString() || "{}")
    const recordId = decodeURIComponent(id)
    const records = await getStoreSettlementRecords()
    const record = records.find(item => item.id === recordId)
    if (!record) throw httpError(404, "收益记录不存在")
    if (action === "settle") {
      if (record.status === "settled") throw httpError(400, "该记录已结算，请勿重复操作。")
      if (record.status === "cancelled") throw httpError(400, "该记录已取消，不能结算。")
      const orderLookup = buildOrderLookup(await getOrders())
      if (!isFinancialRecordReadyToSettle(record, orderLookup)) throw httpError(400, "该记录仍为待确认，订单完成后才能结算。")
      if (pool) {
        const result = await settleStoreSettlementRecords([recordId], {
          note: body.note || body.settleNote || "",
          batchId: `SINGLE${Date.now()}`
        })
        if (result.count !== 1) throw httpError(409, "该记录已被处理或尚不可结算")
      } else {
        record.status = "settled"
        record.settledAt = formatDateTime(new Date())
        record.settledBy = "admin"
        record.settleNote = body.note || body.settleNote || ""
      }
    } else {
      if (record.status === "cancelled") throw httpError(400, "该记录已取消。")
      if (record.status === "settled") throw httpError(409, "已结算历史记录不可取消")
      if (pool) {
        const result = await query(
          `UPDATE store_settlement_records
           SET status='cancelled', cancel_reason=:reason, updated_at=NOW()
           WHERE id=:id AND status IN ('pending_confirm','unsettled')`,
          {
            id: recordId,
            reason: body.reason || body.cancelReason || "后台取消收益"
          }
        )
        if (Number(result.affectedRows || 0) !== 1) throw httpError(409, "该记录已被其他操作处理")
      } else {
        record.status = "cancelled"
        record.cancelReason = body.reason || body.cancelReason || "后台取消收益"
      }
    }
    if (!pool) {
      record.updatedAt = formatDateTime(new Date())
      await saveStoreSettlementRecords(records)
    }
    sendJson(res, 200, { ok: true, data: (await getStoreSettlementRecords()).find(item => item.id === recordId) })
    return
  }

  if (url.pathname === "/api/admin/store-earnings/adjustment" && req.method === "POST") {
    const body = JSON.parse((await readBody(req)).toString() || "{}")
    const amount = money(body.amount)
    if (!body.storeId) throw httpError(400, "请选择门店")
    if (Number(amount) === 0) throw httpError(400, "调整金额不能为 0")
    const now = formatDateTime(new Date())
    const adjustment = normalizeSettlementRecord({
      id: `SSA${Date.now()}${crypto.randomBytes(2).toString("hex").toUpperCase()}`,
      storeId: body.storeId,
      orderId: "",
      type: "adjustment",
      amount,
      commissionType: "none",
      commissionValue: "0.00",
      orderPaidAmount: "0.00",
      status: body.status === "settled" ? "settled" : "unsettled",
      description: body.note || body.description || "后台手动调整",
      settledAt: body.status === "settled" ? now : "",
      settledBy: body.status === "settled" ? "admin" : "",
      settleNote: body.note || "",
      createdAt: now,
      updatedAt: now
    })
    if (pool) await insertStoreSettlementRecord(adjustment)
    else {
      const records = await getStoreSettlementRecords()
      records.unshift(adjustment)
      await saveStoreSettlementRecords(records)
    }
    sendJson(res, 200, { ok: true })
    return
  }

  if (url.pathname === "/api/admin/store-earnings/batch-settle" && req.method === "POST") {
    const body = JSON.parse((await readBody(req)).toString() || "{}")
    const batchId = `BATCH${Date.now()}${crypto.randomBytes(2).toString("hex").toUpperCase()}`
    const records = await getStoreSettlementRecords({
      storeId: body.storeId || "",
      type: body.type || "",
      startAt: body.startAt || "",
      endAt: body.endAt || ""
    })
    const orderLookup = buildOrderLookup(await getOrders())
    const ids = new Set(records.filter(item => isFinancialRecordReadyToSettle(item, orderLookup)).map(item => item.id))
    let count = 0
    if (pool) {
      count = (await settleStoreSettlementRecords([...ids], {
        note: body.note || "后台批量结算",
        batchId
      })).count
    } else {
      const allRecords = await getStoreSettlementRecords()
      const now = formatDateTime(new Date())
      allRecords.forEach(record => {
        if (!ids.has(record.id) || !isFinancialRecordReadyToSettle(record, orderLookup)) return
        record.status = "settled"
        record.settledAt = now
        record.settledBy = "admin"
        record.settleNote = body.note || "后台批量结算"
        record.batchId = batchId
        record.updatedAt = now
        count += 1
      })
      await saveStoreSettlementRecords(allRecords)
    }
    sendJson(res, 200, { ok: true, batchId, recordCount: count })
    return
  }

  if (url.pathname === "/api/admin/customers" && req.method === "GET") {
    sendJson(res, 200, await getCustomers())
    return
  }

  if (url.pathname === "/api/admin/promotion-relations/cycles" && req.method === "GET") {
    const cycles = findCircularPromotionRelations(await getPromotionRelations())
    sendJson(res, 200, { ok: true, count: cycles.length, cycles: cycles.map(promotionCyclePublicView) })
    return
  }

  if (url.pathname === "/api/admin/promotion-relations" && req.method === "GET") {
    sendJson(res, 200, await getPromotionRelations())
    return
  }

  if (url.pathname === "/api/admin/promotion-relations" && req.method === "PUT") {
    sendJson(res, 200, { ok: true, data: await savePromotionRelations(JSON.parse((await readBody(req)).toString())) })
    return
  }

  if (url.pathname === "/api/admin/reward-rules" && req.method === "GET") {
    sendJson(res, 200, await getRewardRules())
    return
  }

  if (url.pathname === "/api/admin/reward-rules" && req.method === "PUT") {
    sendJson(res, 200, { ok: true, data: await saveRewardRules(JSON.parse((await readBody(req)).toString())) })
    return
  }

  if (url.pathname === "/api/admin/reward-records" && req.method === "GET") {
    const [records, orders] = await Promise.all([processRewardState(), getOrders()])
    sendJson(res, 200, records.map(record => decorateRewardRecord(record, orders)))
    return
  }

  if (url.pathname === "/api/admin/rewards" && req.method === "GET") {
    const orders = await getOrders()
    let records = (await processRewardState()).map(record => decorateRewardRecord(record, orders))
    const status = url.searchParams.get("status") || ""
    const keyword = String(url.searchParams.get("keyword") || "").toLowerCase()
    if (status === "chargeback") records = records.filter(record => record.effectiveStatus === "chargeback")
    else if (status) records = records.filter(record => record.effectiveStatus === status)
    if (keyword) {
      records = records.filter(record => [record.id, record.orderId, record.productName, record.buyerPhone, record.promoterPhone, record.promoterName].some(value => String(value || "").toLowerCase().includes(keyword)))
    }
    sendJson(res, 200, {
      ok: true,
      summary: {
        ...buildSettlementSummary(records.filter(record => record.status !== "cancelled"), orders),
        cancelledAmount: money(records.filter(record => record.status === "cancelled").reduce((sum, record) => sum + Number(record.amount || 0), 0))
      },
      records
    })
    return
  }

  const rewardActionMatch = url.pathname.match(/^\/api\/admin\/rewards\/([^/]+)\/(settle|cancel)$/)
  if (rewardActionMatch && req.method === "POST") {
    const [, id, action] = rewardActionMatch
    const body = JSON.parse((await readBody(req)).toString() || "{}")
    const records = await getRewardRecords()
    const record = records.find(item => item.id === decodeURIComponent(id))
    if (!record) throw httpError(404, "推广奖励记录不存在")
    if (action === "settle") {
      if (record.status === "settled") throw httpError(400, "该记录已结算，请勿重复操作。")
      if (record.status === "cancelled") throw httpError(400, "该记录已取消，不能结算。")
      const orderLookup = buildOrderLookup(await getOrders())
      if (!isFinancialRecordReadyToSettle(record, orderLookup)) throw httpError(400, "该奖励仍为待确认，订单完成后才能结算。")
      if (pool) {
        const result = await query(
          `UPDATE reward_records
           SET status='settled', settled_at=NOW(), settled_by='admin',
               settle_note=:note, updated_at=NOW()
           WHERE id=:id AND status IN ('unsettled','chargeback')`,
          {
            id: record.id,
            note: body.note || body.settleNote || ""
          }
        )
        if (Number(result.affectedRows || 0) !== 1) throw httpError(409, "该记录已被处理或尚不可结算")
      } else {
        record.status = "settled"
        record.settledAt = formatDateTime(new Date())
        record.settledBy = "admin"
        record.settleNote = body.note || body.settleNote || ""
      }
    } else {
      if (record.status === "cancelled") throw httpError(400, "该记录已取消。")
      if (record.status === "settled") throw httpError(409, "已结算历史记录不可取消")
      if (pool) {
        const result = await query(
          `UPDATE reward_records
           SET status='cancelled', cancel_reason=:reason, updated_at=NOW()
           WHERE id=:id AND status IN ('pending_confirm','unsettled')`,
          {
            id: record.id,
            reason: body.reason || body.cancelReason || "后台取消奖励"
          }
        )
        if (Number(result.affectedRows || 0) !== 1) throw httpError(409, "该记录已被其他操作处理")
      } else {
        record.status = "cancelled"
        record.cancelReason = body.reason || body.cancelReason || "后台取消奖励"
      }
    }
    if (!pool) {
      record.updatedAt = formatDateTime(new Date())
      await saveRewardRecords(records)
    }
    const refreshed = (await getRewardRecords()).find(item => item.id === record.id)
    sendJson(res, 200, { ok: true, data: normalizeRewardRecord(refreshed || record, 0) })
    return
  }

  if (url.pathname === "/api/admin/rewards/adjustment" && req.method === "POST") {
    const body = JSON.parse((await readBody(req)).toString() || "{}")
    const amount = money(body.amount)
    const promoterPhone = normalizePhone(body.promoterPhone || body.phone || "")
    if (!promoterPhone) throw httpError(400, "请填写用户手机号")
    if (Number(amount) === 0) throw httpError(400, "调整金额不能为 0")
    const customers = await getCustomers()
    const customer = customers.find(item => normalizePhone(item.phone) === promoterPhone) || {}
    const now = formatDateTime(new Date())
    const adjustment = normalizeRewardRecord({
      id: `RWA${Date.now()}${crypto.randomBytes(2).toString("hex").toUpperCase()}`,
      orderId: "",
      productName: body.note || "后台手动调整",
      buyerPhone: "",
      promoterPhone,
      promoterName: customer.name || body.promoterName || "",
      level: 0,
      type: "adjustment",
      amount,
      status: body.status === "settled" ? "settled" : "unsettled",
      settledAt: body.status === "settled" ? now : "",
      settledBy: body.status === "settled" ? "admin" : "",
      settleNote: body.note || "",
      createdAt: now,
      updatedAt: now
    }, 0)
    if (pool) await insertRewardRecord(adjustment)
    else {
      const records = await getRewardRecords()
      records.unshift(adjustment)
      await saveRewardRecords(records)
    }
    sendJson(res, 200, { ok: true })
    return
  }

  if (url.pathname === "/api/admin/settings" && req.method === "GET") {
    sendJson(res, 200, await getSettings())
    return
  }

  if (url.pathname === "/api/admin/settings" && req.method === "PUT") {
    sendJson(res, 200, { ok: true, data: await saveSettings(JSON.parse((await readBody(req)).toString())) })
    return
  }

  sendJson(res, 404, { ok: false, message: "Not found" })
}

warnRuntimeMode()
assertProductionRuntimeConfig()
ensureUploadDirectoryGuards()

initDb().then(async () => {
  await restoreUserSessions().catch(error => console.warn("[auth-state] session restore check failed", { message: error.message }))
  if (STARTUP_HISTORY_COMPENSATION_ENABLED) {
    await ensureLegacyStoreMembers().catch(error => console.warn("门店成员兼容迁移失败：", error.message))
    await ensureReferralRewardRecords().catch(error => console.warn("推广收益补偿检查失败：", error.message))
  } else {
    console.log("[startup-history-compensation] disabled; use reviewed backfill commands explicitly")
  }
  if (process.env.MYSQL_TEST_ISOLATED !== "true") {
    cleanupOrphanTempUploads(true).catch(error => console.warn("临时图片清理失败：", error.message))
    if (STARTUP_HISTORY_COMPENSATION_ENABLED) {
      await compensateMissingWecomOrderNotifications().catch(error => {
        console.error("[wecom-order-notification] compensation error", { error: safeWecomError(error) })
      })
    }
  }
  if (process.env.MYSQL_TEST_DISABLE_WORKERS !== "true") {
    startOrderPaymentTimeoutWorker()
    startPaymentFinanceWorker()
    startWecomOrderNotificationWorker()
    startWechatFulfillmentWorker()
    startRefundSyncWorker()
  } else {
    console.log("[isolated-mysql] background workers disabled for deterministic acceptance")
  }
  const serverHandler = (req, res) => {
    handle(req, res).catch(error => {
      console.error(error)
      const status = Number(error.statusCode || error.status || 500)
      const body = { ok: false, message: publicErrorMessage(error) }
      if (error.errcode !== undefined) body.errcode = error.errcode
      if (error.errmsg !== undefined) body.errmsg = error.errmsg
      sendJson(res, status >= 400 && status < 600 ? status : 500, body)
    })
  }
  http.createServer(serverHandler).listen(PORT, () => {
    console.log(`非常智造管理后台：http://127.0.0.1:${PORT}/admin`)
  })
  const cert = ensureDevCertificate()
  if (cert) {
    https.createServer(cert, serverHandler).listen(HTTPS_PORT, () => {
      console.log(`小程序 HTTPS 接口：${PUBLIC_BASE_URL}/api/home`)
      console.log(`HTTPS 资源地址：${PUBLIC_BASE_URL}/uploads/`)
    })
  } else {
    console.log(`小程序接口：http://127.0.0.1:${PORT}/api/home`)
  }
}).catch(error => {
  console.error("MySQL 初始化失败：", error.message)
  process.exit(1)
})
