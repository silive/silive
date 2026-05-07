const http = require("http")
const https = require("https")
const fs = require("fs")
const path = require("path")
const crypto = require("crypto")
const { execFileSync } = require("child_process")

let mysql
try {
  mysql = require("mysql2/promise")
} catch (error) {
  mysql = null
}

const ROOT = path.join(__dirname, "..")
loadEnv(path.join(ROOT, ".env"))

const IS_PRODUCTION = process.env.NODE_ENV === "production"
const PORT = Number(process.env.PORT || 3000)
const HTTPS_PORT = Number(process.env.HTTPS_PORT || 3443)
const ENABLE_HTTPS = process.env.ENABLE_HTTPS !== "false"
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || (ENABLE_HTTPS ? `https://127.0.0.1:${HTTPS_PORT}` : `http://127.0.0.1:${PORT}`)
const WECHAT_APPID = process.env.WECHAT_APPID || ""
const WECHAT_SECRET = process.env.WECHAT_SECRET || ""
const PAY_MOCK_ENV = String(process.env.PAY_MOCK || "").toLowerCase()
const PAY_MOCK = IS_PRODUCTION ? false : process.env.PAY_MOCK !== "false"
const MOCK_WECHAT_OPENID = "mock-openid-local"
const MOCK_WECHAT_PHONE = "13812345678"
const MOCK_WECHAT_USER_SESSION = "mock-user-session-local"
const adminFile = path.join(__dirname, "admin.html")
const loginFile = path.join(__dirname, "login.html")
const testFile = path.join(__dirname, "test.html")
const uploadsDir = path.join(__dirname, "uploads")
const productUploadsDir = path.join(uploadsDir, "products")
const themesDir = path.join(ROOT, "themes")
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
const storeSettlementRecordsFile = path.join(seedDir, "store-settlement-records.json")
const sessions = new Map()
const userSessions = new Map()
const publicUploadHits = new Map()
const authenticatedUploadHits = new Map()
const orderRecommendationEventHits = new Map()
const productImportPreviews = new Map()
const adminLoginFailures = new Map()
let lastOrphanUploadCleanupAt = 0

fs.mkdirSync(uploadsDir, { recursive: true })
fs.mkdirSync(productUploadsDir, { recursive: true })
fs.mkdirSync(certDir, { recursive: true })
fs.mkdirSync(themesDir, { recursive: true })
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

function normalizeAssetUrls(value) {
  if (Array.isArray(value)) return value.map(publicAssetUrl).filter(Boolean)
  return []
}

function writeJsonFile(file, data) {
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`)
}

function readThemeFile(skin) {
  const safeSkin = String(skin || "").replace(/[^\w-]/g, "")
  if (!safeSkin) return null
  const file = path.join(themesDir, safeSkin, "colors.json")
  if (!file.startsWith(themesDir) || !fs.existsSync(file)) return null
  return readJsonFile(file, null)
}

function defaultThemes() {
  return ["skin01", "skin02", "skin03", "skin04"].map(skin => readThemeFile(skin)).filter(Boolean)
}

function radiusNumber(value, fallback) {
  const text = String(value == null ? "" : value).trim()
  const matched = text.match(/\d+/)
  return matched ? Number(matched[0]) : fallback
}

function rpxValue(value, fallback) {
  const num = radiusNumber(value, fallback)
  return `${num}rpx`
}

function themeSkinId(theme = {}, index = 0) {
  return String(theme.skinId || theme.skin || `skin${String(index + 1).padStart(2, "0")}`).replace(/[^\w-]/g, "")
}

function normalizeTheme(theme = {}, index = 0) {
  const skinId = themeSkinId(theme, index)
  const sourceColors = theme.colors || {}
  const sourceRadius = theme.radius || {}
  const gradient = Array.isArray(theme.buttonGradient) && theme.buttonGradient.length >= 2
    ? theme.buttonGradient
    : [sourceColors.buttonGradientStart || theme.primaryColor || "#FF7A00", sourceColors.buttonGradientEnd || theme.accentColor || "#FF4D8D"]
  const colors = {
    primaryColor: sourceColors.primaryColor || theme.primaryColor || "#FF7A00",
    accentColor: sourceColors.accentColor || theme.accentColor || "#FF4D8D",
    lightBg: sourceColors.lightBg || theme.lightBg || theme.softColor || "#FFF0F3",
    pageTopColor: sourceColors.pageTopColor || theme.pageTopColor || "#FFF8F5",
    pageBottomColor: sourceColors.pageBottomColor || theme.pageBottomColor || "#FFF2F5",
    cardColor: sourceColors.cardColor || theme.cardColor || "rgba(255,255,255,.88)",
    textColor: sourceColors.textColor || theme.textColor || "#222024",
    mutedTextColor: sourceColors.mutedTextColor || theme.mutedTextColor || theme.mutedColor || "#8D7E80",
    priceColor: sourceColors.priceColor || theme.priceColor || "#FF5A3C",
    buttonGradientStart: sourceColors.buttonGradientStart || gradient[0],
    buttonGradientEnd: sourceColors.buttonGradientEnd || gradient[1],
    shadowColor: sourceColors.shadowColor || theme.shadowColor || "rgba(255,122,0,.16)"
  }
  const radius = {
    cardRadius: radiusNumber(sourceRadius.cardRadius ?? theme.cardRadius, 30),
    buttonRadius: radiusNumber(sourceRadius.buttonRadius ?? theme.buttonRadius, 999)
  }
  const tabbar = {
    activeColor: theme.tabbar?.activeColor || colors.priceColor,
    inactiveColor: theme.tabbar?.inactiveColor || "#999999",
    backgroundColor: theme.tabbar?.backgroundColor || "#FFFFFF"
  }
  const navigationBar = {
    frontColor: theme.navigationBar?.frontColor === "#ffffff" ? "#ffffff" : "#000000",
    backgroundColor: theme.navigationBar?.backgroundColor || colors.pageTopColor
  }
  return {
    ...theme,
    skinId,
    skin: skinId,
    name: theme.name || `Skin${String(index + 1).padStart(2, "0")} 未命名皮肤`,
    description: theme.description || "",
    version: Number(theme.version || 1),
    createdAt: theme.createdAt || formatDateTime(new Date()),
    updatedAt: theme.updatedAt || theme.createdAt || formatDateTime(new Date()),
    activatedAt: theme.activatedAt || "",
    colors,
    radius,
    tabbar,
    navigationBar,
    banners: theme.banners || {},
    icons: theme.icons || {},
    primaryColor: colors.primaryColor,
    accentColor: colors.accentColor,
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
    cardRadius: rpxValue(radius.cardRadius, 30),
    buttonRadius: rpxValue(radius.buttonRadius, 999),
    shadowColor: colors.shadowColor,
    banner: publicAssetUrl(theme.banner || ""),
    thumbnail: publicAssetUrl(theme.thumbnail || theme.banner || ""),
    themeWxssText: theme.themeWxssText || "",
    enabled: String(theme.enabled || "false")
  }
}

function normalizeThemeSettings(settings = {}) {
  const deleted = Array.isArray(settings.deletedThemeSkins) ? settings.deletedThemeSkins : []
  const base = defaultThemes().filter(theme => !deleted.includes(themeSkinId(theme)))
  const custom = Array.isArray(settings.themes) ? settings.themes.filter(theme => !deleted.includes(themeSkinId(theme))) : []
  const merged = [...base, ...custom].reduce((list, theme) => {
    const normalized = normalizeTheme(theme, list.length)
    const existing = list.findIndex(item => item.skinId === normalized.skinId)
    if (existing >= 0) list[existing] = { ...list[existing], ...normalized }
    else list.push(normalized)
    return list
  }, [])
  const requestedActive = settings.currentSkinId || settings.activeThemeSkin || settings.theme?.skinId || settings.theme?.skin || "skin01"
  const activeSkin = merged.some(item => item.skinId === requestedActive) ? requestedActive : "skin01"
  return {
    currentSkinId: activeSkin,
    activeThemeSkin: activeSkin,
    currentThemeVersion: Number(settings.currentThemeVersion || 1),
    deletedThemeSkins: deleted,
    themes: merged.map(item => ({ ...item, enabled: item.skinId === activeSkin ? "true" : "false" }))
  }
}

function currentThemeFromSettings(settings = {}) {
  const themeSettings = normalizeThemeSettings(settings)
  return themeSettings.themes.find(item => item.skinId === themeSettings.currentSkinId) || themeSettings.themes[0] || normalizeTheme(readThemeFile("skin01") || {})
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

function sendJson(res, status, data, headers = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,X-User-Session,X-User-Token",
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

function sendText(res, status, text, type = "text/plain; charset=utf-8", headers = {}) {
  res.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store",
    ...headers
  })
  res.end(text)
}

function redirect(res, location) {
  res.writeHead(302, { Location: location })
  res.end()
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

function createUserSession(openid, phone = "") {
  const token = crypto.randomBytes(24).toString("hex")
  userSessions.set(token, { openid, phone, createdAt: Date.now() })
  return token
}

function createWechatUserSession(openid, phone = "") {
  if (canUseMockWechatLogin() && openid === MOCK_WECHAT_OPENID) {
    userSessions.set(MOCK_WECHAT_USER_SESSION, { openid, phone: phone || MOCK_WECHAT_PHONE, createdAt: Date.now() })
    return MOCK_WECHAT_USER_SESSION
  }
  return createUserSession(openid, phone)
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

function clientIp(req) {
  return String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim()
}

function isLocalhostIp(ip) {
  return ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(String(ip || "").trim())
}

function isLocalhostRequest(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim()
  if (forwarded) return isLocalhostIp(forwarded)
  return isLocalhostIp(req.socket.remoteAddress)
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
  const sessionOk = token ? checkRateLimit(authenticatedUploadHits, `session:${token}`, windowMs, maxHits) : true
  const ipOk = checkRateLimit(authenticatedUploadHits, `ip:${ip}`, windowMs, maxHits)
  return sessionOk && ipOk
}

function checkOrderRecommendationEventRateLimit(req) {
  return checkRateLimit(orderRecommendationEventHits, clientIp(req) || "unknown", 60 * 1000, 60)
}

function userSessionFromRequest(req) {
  const token = String(req.headers["x-user-session"] || req.headers["x-user-token"] || "").trim()
  return getUserSession(token)
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
const MAX_IMPORT_EXCEL_SIZE = 5 * 1024 * 1024
const MAX_IMPORT_ZIP_SIZE = 50 * 1024 * 1024
const IMPORT_PREVIEW_TTL = 30 * 60 * 1000
const ZIP_ALLOWED_IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"])
const ZIP_BLOCKED_EXTS = new Set([".exe", ".dll", ".dmg", ".pkg", ".app", ".com", ".scr", ".msi", ".html", ".htm", ".php", ".js", ".mjs", ".cjs", ".sh", ".bash", ".zsh", ".bat", ".cmd", ".ps1", ".vbs", ".jar", ".py", ".rb", ".pl"])
const PRODUCT_CATEGORIES = [
  "3D打印", "激光雕刻", "叶雕定制", "名字礼物",
  "激光定制", "激光定制/亚克力夜灯", "激光定制/木牌雕刻", "激光定制/叶雕纪念",
  "3D打印/零件加工", "3D打印/工业打样", "3D打印/手办打印",
  "潮玩手办", "潮玩手办/解压玩具", "潮玩手办/热门手办", "潮玩手办/创意摆件"
]

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
    "二级类目": "宠物摆件",
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
    "二级类目": "叶雕礼物",
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
  const catalog = Array.isArray(settings.categoryCatalog) ? settings.categoryCatalog : []
  const byName = new Map(catalog.map(item => [item.name, item]))
  let changed = false
  for (const product of products) {
    for (const category of normalizeProductCategories(product.categories, product)) {
      const [primary, second] = String(category).split("/")
      if (!primary) continue
      if (!byName.has(primary)) {
        const item = { id: `CAT${Date.now()}${crypto.randomBytes(2).toString("hex")}`, name: primary, sort: catalog.length + 1, children: [] }
        catalog.push(item)
        byName.set(primary, item)
        changed = true
      }
      if (second) {
        const parent = byName.get(primary)
        parent.children = Array.isArray(parent.children) ? parent.children : []
        if (!parent.children.some(child => child.name === second)) {
          parent.children.push({ id: `CAT${Date.now()}${crypto.randomBytes(2).toString("hex")}`, name: second, sort: parent.children.length + 1, comingSoon: "false" })
          changed = true
        }
      }
    }
  }
  if (changed) await saveSettings({ ...settings, categoryCatalog: catalog })
}

function normalizeHome(data) {
  const defaultHomeEntries = [
    { name: "激光定制", desc: "上传照片定制礼物", icon: "◆", imageUrl: "", targetType: "primary", targetValue: "激光定制", visible: "true", sort: "1" },
    { name: "3D打印", desc: "模型文件直接生产", icon: "✦", imageUrl: "", targetType: "primary", targetValue: "3D打印", visible: "true", sort: "2" },
    { name: "潮玩手办", desc: "热门现货直接购买", icon: "＋", imageUrl: "", targetType: "primary", targetValue: "潮玩手办", visible: "true", sort: "3" },
    { name: "联系客服", desc: "先沟通再下单", icon: "☎", imageUrl: "", targetType: "service", targetValue: "", visible: "true", sort: "4" }
  ]
  return {
    banners: (Array.isArray(data.banners) ? data.banners : []).map(item => ({
      ...item,
      imageUrl: publicAssetUrl(item.imageUrl),
      targetType: item.targetType || "primary",
      targetValue: item.targetValue || ""
    })),
    categories: Array.isArray(data.categories) ? data.categories : [],
    homeEntries: (Array.isArray(data.homeEntries) && data.homeEntries.length ? data.homeEntries : defaultHomeEntries).slice(0, 4).map((item, index) => ({
      name: item.name || defaultHomeEntries[index]?.name || `入口${index + 1}`,
      desc: item.desc || "",
      icon: item.icon || defaultHomeEntries[index]?.icon || "＋",
      imageUrl: publicAssetUrl(item.imageUrl),
      targetType: item.targetType || "primary",
      targetValue: item.targetValue || "",
      visible: String(item.visible == null ? "true" : item.visible),
      sort: String(item.sort || index + 1)
    })),
    trustTags: Array.isArray(data.trustTags) ? data.trustTags : [],
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
    updatedAt: new Date().toISOString()
  }
}

function normalizeBadge(value) {
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
    入门首选: "new",
    无标签: "none"
  }
  return map[value] || value || "none"
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
  if (["off", "下架", "disabled", "inactive", "false", "0"].includes(text)) return "off"
  return "on"
}

function inferProductCategories(product) {
  const text = `${product.name || ""} ${product.intro || ""}`
  return PRODUCT_CATEGORIES.filter(category => {
    const rules = {
      "3D打印": ["3D", "摆件", "建模", "宠物"],
      "激光雕刻": ["激光", "雕刻", "木", "金属"],
      "叶雕定制": ["叶雕", "真叶", "天然"],
      "名字礼物": ["名字", "钥匙扣", "刻字"]
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
    categories.push(primary)
    seconds.map(item => String(item || "").trim()).filter(Boolean).forEach(second => {
      categories.push(second.includes("/") ? second : `${primary}/${second}`)
    })
  }
  return categories.length ? [...new Set(categories)] : inferProductCategories(product)
}

function productCategoryLevels(categories = []) {
  const list = Array.isArray(categories) ? categories.map(item => String(item || "").trim()).filter(Boolean) : []
  const firstWithSecond = list.find(item => item.includes("/"))
  if (firstWithSecond) {
    const [categoryLevel1, categoryLevel2] = firstWithSecond.split("/")
    return { categoryLevel1, categoryLevel2 }
  }
  const categoryLevel1 = list[0] || ""
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
  if (!IS_PRODUCTION) return
  if (PAY_MOCK_ENV === "true") throw new Error("生产环境禁止 PAY_MOCK=true")
  if (!process.env.ADMIN_USER || !process.env.ADMIN_PASSWORD) {
    throw new Error("生产环境必须配置 ADMIN_USER 和 ADMIN_PASSWORD，禁止使用默认后台账号")
  }
  if (process.env.ADMIN_USER === "admin" || process.env.ADMIN_PASSWORD === "ChangeMe123!" || process.env.ADMIN_PASSWORD.length < 16) {
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
  const categories = normalizeProductCategories(product.categories, product)
  const levels = productCategoryLevels(categories)
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
    galleryImages: normalizeAssetUrls(normalizeMediaList(product.galleryImages)),
    videoUrl: publicAssetUrl(product.videoUrl),
    detailImages: normalizeAssetUrls(normalizeMediaList(product.detailImages)),
    detailText: product.detailText || "",
    categories,
    categoryLevel1: product.categoryLevel1 || levels.categoryLevel1,
    categoryLevel2: product.categoryLevel2 || levels.categoryLevel2,
    status: normalizeProductStatus(product.status),
    stock: String(product.stock || "0"),
    isHot,
    isPromotionHot: promotionHot,
    promotionHot,
    aiPreviewEnabled: normalizeBooleanText(product.aiPreviewEnabled, false),
    aiPreviewType: product.aiPreviewType || inferAiPreviewType(product),
    rewardEnabled: String(product.rewardEnabled == null ? "true" : product.rewardEnabled) === "false" ? "false" : "true",
    firstReward: String(product.firstReward || "0"),
    secondReward: String(product.secondReward || "0"),
    sort: String(sortOrder),
    sortOrder: String(sortOrder)
  }
}

function normalizeOrder(order, index) {
  const createdAt = order.createdAt || formatDateTime(new Date())
  const paidAt = order.paidAt || null
  const arrivedStoreAt = order.arrivedStoreAt || null
  const pickedUpAt = order.pickedUpAt || null
  return {
    id: order.id || `DD${Date.now()}${index}`,
    productId: order.productId || "",
    customerName: order.customerName || "",
    phone: order.phone || "",
    productName: order.productName || "",
    amount: String(order.amount || "0"),
    status: order.status || "待发货",
    paymentStatus: order.paymentStatus || "待支付",
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
    refundRejectReason: order.refundRejectReason || "",
    refundReviewedAt: order.refundReviewedAt || null,
    createdAt,
    createdAtText: order.createdAtText || formatChinaDatetime(createdAt),
    paidAt,
    paidAtText: order.paidAtText || formatChinaDatetime(paidAt),
    completedAt: order.completedAt || null,
    refundAt: order.refundAt || null,
    deliveryType: order.deliveryType || "delivery",
    pickupStoreId: order.pickupStoreId || "",
    pickupStore: order.pickupStore || null,
    pickupCode: order.pickupCode || "",
    pickupStatus: order.pickupStatus || "none",
    arrivedStoreAt,
    arrivedStoreAtText: order.arrivedStoreAtText || formatChinaDatetime(arrivedStoreAt),
    pickedUpAt,
    pickedUpAtText: order.pickedUpAtText || formatChinaDatetime(pickedUpAt),
    userLatitude: order.userLatitude == null || order.userLatitude === "" ? "" : String(order.userLatitude),
    userLongitude: order.userLongitude == null || order.userLongitude === "" ? "" : String(order.userLongitude),
    pickupDistance: order.pickupDistance == null || order.pickupDistance === "" ? "" : String(order.pickupDistance),
    referrerStoreId: order.referrerStoreId || "",
    supplierStoreId: order.supplierStoreId || "",
    referralCommission: order.referralCommission == null || order.referralCommission === "" ? "0.00" : String(order.referralCommission),
    pickupServiceFee: order.pickupServiceFee == null || order.pickupServiceFee === "" ? "0.00" : String(order.pickupServiceFee),
    supplierSettlementAmount: order.supplierSettlementAmount == null || order.supplierSettlementAmount === "" ? "0.00" : String(order.supplierSettlementAmount),
    customCommissionAmount: order.customCommissionAmount == null || order.customCommissionAmount === "" ? "0.00" : String(order.customCommissionAmount),
    storeSettlementStatus: order.storeSettlementStatus || "unsettled"
  }
}

function mysqlOrderParams(order) {
  return {
    ...order,
    shippedAt: toMysqlDatetime(order.shippedAt),
    refundReviewedAt: toMysqlDatetime(order.refundReviewedAt),
    createdAt: toMysqlDatetime(order.createdAt, nowMysqlDatetime()),
    paidAt: toMysqlDatetime(order.paidAt),
    completedAt: toMysqlDatetime(order.completedAt),
    refundAt: toMysqlDatetime(order.refundAt),
    arrivedStoreAt: toMysqlDatetime(order.arrivedStoreAt),
    pickedUpAt: toMysqlDatetime(order.pickedUpAt)
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
  if (current.userToken && order.userToken === current.userToken) return true
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
    managerPhone: store.managerPhone || store.manager_phone || "",
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
    createdAt: store.createdAt || store.created_at || formatDateTime(new Date()),
    updatedAt: store.updatedAt || store.updated_at || formatDateTime(new Date())
  }
}

function normalizeSettlementRecord(record = {}, index = 0) {
  const createdAt = record.createdAt || record.created_at || formatDateTime(new Date())
  const settledAt = record.settledAt || record.settled_at || ""
  return {
    id: String(record.id || `SSR${Date.now()}${index}`),
    storeId: record.storeId || record.store_id || "",
    orderId: record.orderId || record.order_id || "",
    type: record.type || "referral",
    amount: money(record.amount),
    commissionType: normalizeCommissionType(record.commissionType || record.commission_type || "none"),
    commissionValue: money(record.commissionValue ?? record.commission_value ?? 0),
    orderPaidAmount: money(record.orderPaidAmount ?? record.order_paid_amount ?? 0),
    status: record.status === "settled" ? "settled" : "unsettled",
    description: record.description || "",
    createdAt,
    createdAtText: record.createdAtText || formatChinaDatetime(createdAt),
    settledAt,
    settledAtText: record.settledAtText || formatChinaDatetime(settledAt)
  }
}

function calculateStoreAmount(amount, type, value) {
  const paid = Number(amount || 0)
  const num = Math.max(0, Number(value || 0))
  if (!paid || type === "none") return "0.00"
  if (type === "percent") return money(paid * num / 100)
  if (type === "fixed") return money(Math.min(num, paid * 0.5))
  return "0.00"
}

function generatePickupCode() {
  return String(Math.floor(100000 + Math.random() * 900000))
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

function storeRoleText(role) {
  return ({ manager: "负责人", clerk: "店员", owner: "老板" })[role] || "负责人"
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
    inviterPhone: relation.inviterPhone || "",
    inviterName: relation.inviterName || "",
    inviterCode: relation.inviterCode || inviteCodeFor(relation.inviterPhone),
    inviteePhone: relation.inviteePhone || "",
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
  return {
    id: record.id || `RW${Date.now()}${index}`,
    orderId: record.orderId || "",
    productName: record.productName || "",
    buyerPhone: record.buyerPhone || "",
    promoterPhone: record.promoterPhone || "",
    promoterName: record.promoterName || "",
    level: Number(record.level || 1),
    amount: String(record.amount || "0"),
    status: record.status || "待发放",
    releaseAt: record.releaseAt || "",
    createdAt: record.createdAt || new Date().toISOString().slice(0, 16).replace("T", " "),
    updatedAt: record.updatedAt || ""
  }
}

async function query(sql, params) {
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
  const home = normalizeHome(data)
  if (!pool) {
    writeJsonFile(homeFile, home)
    return home
  }
  await query("UPDATE home_config SET data = :data WHERE id = 1", { data: JSON.stringify(home) })
  return home
}

async function getProducts() {
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
    categories: normalizeProductCategories(parseJsonValue(row.categories, []), row),
    status: row.status || "on",
    stock: String(row.stock || "0"),
    isHot: normalizeBooleanText(row.is_hot, false),
    promotionHot: normalizeBooleanText(row.promotion_hot, false),
    aiPreviewEnabled: normalizeBooleanText(row.ai_preview_enabled, false),
    aiPreviewType: row.ai_preview_type || "",
    rewardEnabled: String(row.reward_enabled == null ? "true" : row.reward_enabled) === "false" ? "false" : "true",
    firstReward: String(row.first_reward || "0"),
    secondReward: String(row.second_reward || "0"),
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
    if (filters.status) list = list.filter(store => store.status === filters.status)
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
    where.push("status = :status")
    params.status = filters.status
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
  return !!store.managerPhone && store.status === "enabled" && store.storeStatus !== "disabled"
}

function managerPhoneDuplicateMap(stores = []) {
  const groups = new Map()
  stores.filter(isActiveStoreManagerBinding).forEach(store => {
    const phone = String(store.managerPhone || "").trim()
    if (!groups.has(phone)) groups.set(phone, [])
    groups.get(phone).push(store)
  })
  return groups
}

function withStoreManagerWarnings(stores = []) {
  const groups = managerPhoneDuplicateMap(stores)
  return stores.map(store => {
    const duplicates = groups.get(String(store.managerPhone || "").trim()) || []
    return duplicates.length > 1
      ? { ...store, managerPhoneDuplicated: true, managerPhoneWarning: "该手机号已绑定多个启用门店，请联系管理员处理" }
      : store
  })
}

function assertUniqueManagerPhone(stores = [], candidate = {}) {
  if (!isActiveStoreManagerBinding(candidate)) return
  const phone = String(candidate.managerPhone || "").trim()
  const conflict = stores.find(store =>
    store.id !== candidate.id &&
    isActiveStoreManagerBinding(store) &&
    String(store.managerPhone || "").trim() === phone
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
      createdAt: toMysqlDatetime(store.createdAt, nowMysqlDatetime()),
      updatedAt: toMysqlDatetime(store.updatedAt, nowMysqlDatetime())
    }
    await query(
      `INSERT INTO partner_stores (id, name, level, address, phone, contact_name, manager_phone, manager_openid, store_role, store_status, business_hours, latitude, longitude, status, is_display_enabled, is_pickup_enabled, is_supplier_enabled, settlement_cycle, qrcode_scene, sort_order, remark, referral_commission_type, referral_commission_value, pickup_fee_type, pickup_fee_value, supplier_settlement_rule, custom_commission_rule, created_at, updated_at)
       VALUES (:id, :name, :level, :address, :phone, :contactName, :managerPhone, :managerOpenid, :storeRole, :storeStatus, :businessHours, :latitude, :longitude, :status, :isDisplayEnabled, :isPickupEnabled, :isSupplierEnabled, :settlementCycle, :qrcodeScene, :sortOrder, :remark, :referralCommissionType, :referralCommissionValue, :pickupFeeType, :pickupFeeValue, :supplierSettlementRule, :customCommissionRule, :createdAt, :updatedAt)`,
      params
    )
  }
  return list
}

async function upsertPartnerStore(store) {
  const list = await getPartnerStores()
  const normalized = normalizePartnerStore({
    ...store,
    id: store.id || `STORE${Date.now()}${crypto.randomBytes(2).toString("hex").toUpperCase()}`,
    updatedAt: formatDateTime(new Date())
  }, list.length)
  const index = list.findIndex(item => item.id === normalized.id)
  const candidate = index >= 0 ? { ...list[index], ...normalized } : normalized
  assertUniqueManagerPhone(list, candidate)
  if (index >= 0) list[index] = candidate
  else list.push(normalized)
  await savePartnerStores(list)
  return normalized
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
    where.push("status = :status")
    params.status = filters.status
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
  if (type === "referral" || type === "store_referral_commission") return ["referral", "store_referral_commission"]
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
      createdAt: toMysqlDatetime(record.createdAt, nowMysqlDatetime()),
      settledAt: toMysqlDatetime(record.settledAt)
    }
    await query(
      `INSERT INTO store_settlement_records (id, store_id, order_id, type, amount, commission_type, commission_value, order_paid_amount, status, description, created_at, settled_at)
       VALUES (:id, :storeId, :orderId, :type, :amount, :commissionType, :commissionValue, :orderPaidAmount, :status, :description, :createdAt, :settledAt)
       ON DUPLICATE KEY UPDATE status = VALUES(status), settled_at = VALUES(settled_at), amount = VALUES(amount), description = VALUES(description)`,
      params
    )
  }
  return list
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
  await query("DELETE FROM products")
  for (let index = 0; index < list.length; index += 1) {
    const product = list[index]
    await query(
      "INSERT INTO products (id, name, intro, price, cost_price, badge, cover, image_url, gallery_images, video_url, detail_images, detail_text, categories, status, stock, is_hot, promotion_hot, ai_preview_enabled, ai_preview_type, reward_enabled, first_reward, second_reward, sort_order) VALUES (:id, :name, :intro, :price, :costPrice, :badge, :cover, :imageUrl, :galleryImagesJson, :videoUrl, :detailImagesJson, :detailText, :categoriesJson, :status, :stock, :isHot, :promotionHot, :aiPreviewEnabled, :aiPreviewType, :rewardEnabled, :firstReward, :secondReward, :sortOrder)",
      { ...product, galleryImagesJson: JSON.stringify(product.galleryImages || []), detailImagesJson: JSON.stringify(product.detailImages || []), categoriesJson: JSON.stringify(product.categories || []), sortOrder: Number(product.sortOrder || index) }
    )
  }
  const home = await getHome()
  home.products = list
  await saveHome(home)
  await saveRewardRules(rewardList)
  return list
}

async function getOrders(filters = {}) {
  const identity = requestIdentity(filters)
  const hasIdentity = hasRequestIdentity(identity)
  if (!pool) {
    const stores = readJsonFile(partnerStoresFile, []).map(normalizePartnerStore)
    let orders = readJsonFile(ordersFile, []).map((order, index) => {
      const normalized = normalizeOrder(order, index)
      return { ...normalized, pickupStore: storePublicView(stores.find(store => store.id === normalized.pickupStoreId)) }
    })
    if (filters.publicOnly && !hasIdentity) return []
    if (filters.publicOnly) {
      orders = orders.filter(order => {
        if (identity.userId && order.userId === identity.userId) return true
        if (identity.userToken && order.userToken === identity.userToken) return true
        if (identity.openid && order.openid === identity.openid) return true
        if (identity.phone && order.phone === identity.phone) return true
        return false
      })
    }
    if (filters.status) orders = orders.filter(order => order.status === filters.status)
    if (filters.keyword) {
      const keyword = String(filters.keyword).toLowerCase()
      orders = orders.filter(order => [order.id, order.customerName, order.phone, order.productName].some(value => String(value || "").toLowerCase().includes(keyword)))
    }
    return orders.reverse()
  }
  const where = []
  const params = {}
  if (filters.publicOnly && !hasIdentity) return []
  if (filters.publicOnly && identity.phone && (identity.openid || identity.userToken)) {
    await query(
      `UPDATE orders
       SET
         openid = CASE WHEN (openid IS NULL OR openid = '') THEN :openid ELSE openid END,
         user_token = CASE WHEN (user_token IS NULL OR user_token = '') THEN :userToken ELSE user_token END
       WHERE phone = :phone
         AND (:openid = '' OR openid IS NULL OR openid = '' OR openid = :openid)
         AND (:userToken = '' OR user_token IS NULL OR user_token = '' OR user_token = :userToken)`,
      {
        phone: identity.phone,
        openid: identity.openid || "",
        userToken: identity.userToken || ""
      }
    )
  }
  if (filters.publicOnly) {
    const identityWhere = []
    if (identity.userId) {
      identityWhere.push("user_id = :userId")
      params.userId = identity.userId
    }
    if (identity.userToken) {
      identityWhere.push("user_token = :userToken")
      params.userToken = identity.userToken
    }
    if (identity.openid) {
      identityWhere.push("openid = :openid")
      params.openid = identity.openid
    }
    if (identity.phone) {
      identityWhere.push("phone = :phone")
      params.phone = identity.phone
    }
    where.push(`(${identityWhere.join(" OR ")})`)
  }
  if (filters.status) {
    where.push("status = :status")
    params.status = filters.status
  }
  if (filters.keyword) {
    where.push("(id LIKE :keyword OR customer_name LIKE :keyword OR phone LIKE :keyword OR product_name LIKE :keyword)")
    params.keyword = `%${filters.keyword}%`
  }
  const rows = await query(`SELECT * FROM orders ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC`, params)
  const stores = await getPartnerStores()
  return rows.map(row => normalizeOrder({
    id: row.id,
    productId: row.product_id || "",
    customerName: row.customer_name,
    phone: row.phone || "",
    productName: row.product_name || "",
    amount: String(row.amount || "0"),
    status: row.status || "待发货",
    paymentStatus: row.payment_status || "待支付",
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
    refundRejectReason: row.refund_reject_reason || "",
    refundReviewedAt: formatChinaDatetime(row.refund_reviewed_at),
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
    pickupStatus: row.pickup_status || "none",
    arrivedStoreAt: formatChinaDatetime(row.arrived_store_at),
    arrivedStoreAtText: formatChinaDatetime(row.arrived_store_at),
    pickedUpAt: formatChinaDatetime(row.picked_up_at),
    pickedUpAtText: formatChinaDatetime(row.picked_up_at),
    userLatitude: row.user_latitude,
    userLongitude: row.user_longitude,
    pickupDistance: row.pickup_distance,
    referrerStoreId: row.referrer_store_id || "",
    supplierStoreId: row.supplier_store_id || "",
    referralCommission: row.referral_commission,
    pickupServiceFee: row.pickup_service_fee,
    supplierSettlementAmount: row.supplier_settlement_amount,
    customCommissionAmount: row.custom_commission_amount,
    storeSettlementStatus: row.store_settlement_status || "unsettled"
  }, 0))
}

async function saveOrders(orders) {
  const list = orders.map(normalizeOrder)
  if (!pool) {
    const existing = readJsonFile(ordersFile, []).map(normalizeOrder)
    const merged = [...existing]
    for (const order of list) {
      const index = merged.findIndex(item => item.id === order.id)
      if (index >= 0) {
        const previous = merged[index]
        const next = { ...previous, ...order }
        if (next.status === "已完成" && previous.status !== "已完成") next.completedAt = formatDateTime(new Date())
        if (next.status === "已退款" && previous.status !== "已退款") next.refundAt = formatDateTime(new Date())
        merged[index] = next
      }
      else merged.push(order)
    }
    writeJsonFile(ordersFile, merged)
    await processRewardState()
    return list
  }
  for (const order of list) {
    const orderParams = {
      ...mysqlOrderParams(order),
      originalImageUrlsJson: JSON.stringify(order.originalImageUrls || []),
      userLatitude: order.userLatitude === "" ? null : order.userLatitude,
      userLongitude: order.userLongitude === "" ? null : order.userLongitude,
      pickupDistance: order.pickupDistance === "" ? null : order.pickupDistance
    }
    await query(
      `INSERT INTO orders (id, product_id, customer_name, phone, product_name, amount, status, payment_status, transaction_id, openid, user_id, user_token, address, custom_request, original_image_url, original_image_urls, ai_preview_url, final_design_url, category, is_custom_order, remark, inviter_code, shipping_company, tracking_number, shipped_at, refund_type, refund_status, refund_reason, refund_amount, refund_remark, refund_image_url, refund_reject_reason, refund_reviewed_at, created_at, paid_at, completed_at, refund_at, delivery_type, pickup_store_id, pickup_code, pickup_status, arrived_store_at, picked_up_at, user_latitude, user_longitude, pickup_distance, referrer_store_id, supplier_store_id, referral_commission, pickup_service_fee, supplier_settlement_amount, custom_commission_amount, store_settlement_status)
       VALUES (:id, :productId, :customerName, :phone, :productName, :amount, :status, :paymentStatus, :transactionId, :openid, :userId, :userToken, :address, :customRequest, :originalImageUrl, :originalImageUrlsJson, :aiPreviewUrl, :finalDesignUrl, :category, :isCustomOrder, :remark, :inviterCode, :shippingCompany, :trackingNumber, :shippedAt, :refundType, :refundStatus, :refundReason, :refundAmount, :refundRemark, :refundImageUrl, :refundRejectReason, :refundReviewedAt, :createdAt, :paidAt, :completedAt, :refundAt, :deliveryType, :pickupStoreId, :pickupCode, :pickupStatus, :arrivedStoreAt, :pickedUpAt, :userLatitude, :userLongitude, :pickupDistance, :referrerStoreId, :supplierStoreId, :referralCommission, :pickupServiceFee, :supplierSettlementAmount, :customCommissionAmount, :storeSettlementStatus)
       ON DUPLICATE KEY UPDATE
       status = VALUES(status),
       payment_status = VALUES(payment_status),
       transaction_id = VALUES(transaction_id),
       openid = VALUES(openid),
       user_id = VALUES(user_id),
       user_token = VALUES(user_token),
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
       paid_at = VALUES(paid_at),
       completed_at = IF(VALUES(status) = '已完成' AND completed_at IS NULL, NOW(), completed_at),
       refund_at = IF(VALUES(status) = '已退款' AND refund_at IS NULL, NOW(), refund_at),
       delivery_type = VALUES(delivery_type),
       pickup_store_id = VALUES(pickup_store_id),
       pickup_code = VALUES(pickup_code),
       pickup_status = VALUES(pickup_status),
       arrived_store_at = VALUES(arrived_store_at),
       picked_up_at = VALUES(picked_up_at),
       user_latitude = VALUES(user_latitude),
       user_longitude = VALUES(user_longitude),
       pickup_distance = VALUES(pickup_distance),
       referrer_store_id = VALUES(referrer_store_id),
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
  return list
}

async function calculateOrderStoreIncome(data, amount) {
  const referrerStore = await getPartnerStore(data.referrerStoreId || data.referrer_store_id || "")
  const pickupStore = data.deliveryType === "pickup" ? await getPartnerStore(data.pickupStoreId || data.pickup_store_id || "") : null
  const referralCommission = referrerStore
    ? calculateStoreAmount(amount, referrerStore.referralCommissionType, referrerStore.referralCommissionValue)
    : "0.00"
  const pickupServiceFee = pickupStore
    ? calculateStoreAmount(amount, pickupStore.pickupFeeType, pickupStore.pickupFeeValue)
    : "0.00"
  return { referrerStore, pickupStore, referralCommission, pickupServiceFee }
}

function isValidReferrerStore(store) {
  return !!store && store.status === "enabled" && store.isDisplayEnabled === "true" && store.referralCommissionType !== "none"
}

async function resolveValidReferrerStoreId(storeId) {
  const store = await getPartnerStore(storeId || "")
  return isValidReferrerStore(store) ? store.id : ""
}

async function createStoreSettlementRecordsForOrder(order) {
  const existing = await getStoreSettlementRecords()
  const next = existing.filter(record => order.id !== record.orderId)
  const referrerStore = await getPartnerStore(order.referrerStoreId)
  const pickupStore = await getPartnerStore(order.pickupStoreId)
  const createdAt = formatDateTime(new Date())
  if (referrerStore && Number(order.referralCommission || 0) > 0) {
    next.push(normalizeSettlementRecord({
      id: `SSR${order.id}REF`,
      storeId: referrerStore.id,
      orderId: order.id,
      type: "store_referral_commission",
      amount: order.referralCommission,
      commissionType: referrerStore.referralCommissionType,
      commissionValue: referrerStore.referralCommissionValue,
      orderPaidAmount: order.amount,
      status: order.storeSettlementStatus || "unsettled",
      description: `推广佣金：${order.productName}`,
      createdAt
    }))
  }
  if (pickupStore && Number(order.pickupServiceFee || 0) > 0) {
    next.push(normalizeSettlementRecord({
      id: `SSR${order.id}PIC`,
      storeId: pickupStore.id,
      orderId: order.id,
      type: "pickup_service_fee",
      amount: order.pickupServiceFee,
      commissionType: pickupStore.pickupFeeType,
      commissionValue: pickupStore.pickupFeeValue,
      orderPaidAmount: order.amount,
      status: order.storeSettlementStatus || "unsettled",
      description: `自提服务费：${order.productName}`,
      createdAt
    }))
  }
  await saveStoreSettlementRecords(next)
  return next.filter(record => record.orderId === order.id)
}

async function sendPickupArrivedNotice(orderId) {
  const templateId = process.env.WECHAT_PICKUP_TEMPLATE_ID || ""
  const order = (await getOrders({ keyword: orderId })).find(item => item.id === orderId)
  if (!order) return { ok: false, message: "订单不存在" }
  if (!templateId) {
    console.log(`[pickup] subscription template not configured order=${orderId}`)
    return { ok: true, skipped: true, message: "未配置订阅消息模板，已跳过真实发送" }
  }
  console.log(`[pickup] ready to send arrived notice order=${orderId} store=${order.pickupStore?.name || ""}`)
  return { ok: true, skipped: true, message: "订阅消息发送方法已预留" }
}

async function getStoreSettlementSummary(filters = {}) {
  const [stores, orders, records] = await Promise.all([
    getPartnerStores(),
    getOrders(),
    getStoreSettlementRecords(filters)
  ])
  const targetStores = filters.storeId ? stores.filter(store => store.id === filters.storeId) : stores
  const summary = targetStores.map(store => {
    const storeRecords = records.filter(record => record.storeId === store.id)
    const referralRecords = storeRecords.filter(record => isStoreReferralSettlement(record.type))
    const pickupRecords = storeRecords.filter(record => isPickupServiceSettlement(record.type))
    const supplierRecords = storeRecords.filter(record => record.type === "supplier")
    const customRecords = storeRecords.filter(record => record.type === "custom")
    const settled = storeRecords.filter(record => record.status === "settled").reduce((sum, record) => sum + Number(record.amount || 0), 0)
    const total = storeRecords.reduce((sum, record) => sum + Number(record.amount || 0), 0)
    return {
      storeId: store.id,
      storeName: store.name,
      referralOrders: new Set(referralRecords.map(record => record.orderId)).size,
      pickupOrders: orders.filter(order => order.pickupStoreId === store.id && order.deliveryType === "pickup").length,
      referralAmount: money(referralRecords.reduce((sum, record) => sum + Number(record.amount || 0), 0)),
      pickupAmount: money(pickupRecords.reduce((sum, record) => sum + Number(record.amount || 0), 0)),
      supplierAmount: money(supplierRecords.reduce((sum, record) => sum + Number(record.amount || 0), 0)),
      customAmount: money(customRecords.reduce((sum, record) => sum + Number(record.amount || 0), 0)),
      totalAmount: money(total),
      settledAmount: money(settled),
      unsettledAmount: money(total - settled)
    }
  })
  return { summary, records }
}

async function getStoreSession(req) {
  const token = String(req.headers["x-user-session"] || req.headers["x-user-token"] || "").trim()
  const session = getUserSession(token)
  if (!session?.phone) return null
  const stores = await getPartnerStores({ status: "enabled" })
  const matches = stores.filter(item => item.managerPhone && item.managerPhone === session.phone && item.storeStatus !== "disabled")
  if (matches.length > 1) {
    return { token, session, store: null, duplicated: true, error: "该手机号绑定多个门店，请联系管理员处理" }
  }
  const store = matches[0]
  if (!store) return null
  if (session.openid && !store.managerOpenid) {
    await upsertPartnerStore({ ...store, managerOpenid: session.openid })
    store.managerOpenid = session.openid
  }
  return { token, session, store }
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

function storeOrderView(order, mode = "referral") {
  return {
    id: order.id,
    createdAt: order.createdAt,
    createdAtText: order.createdAtText || formatChinaDatetime(order.createdAt),
    productName: order.productName,
    amount: order.amount,
    status: order.status,
    paymentStatus: order.paymentStatus,
    phone: maskPhone(order.phone),
    pickupCode: order.pickupCode,
    pickupStatus: order.pickupStatus,
    arrivedStoreAt: order.arrivedStoreAt,
    arrivedStoreAtText: order.arrivedStoreAtText || formatChinaDatetime(order.arrivedStoreAt),
    pickedUpAt: order.pickedUpAt,
    pickedUpAtText: order.pickedUpAtText || formatChinaDatetime(order.pickedUpAt),
    referralCommission: mode === "pickup" ? "" : order.referralCommission,
    pickupServiceFee: mode === "referral" ? "" : order.pickupServiceFee,
    storeSettlementStatus: order.storeSettlementStatus
  }
}

function storeCenterStats(store, orders, records) {
  const today = new Date().toISOString().slice(0, 10)
  const month = new Date().toISOString().slice(0, 7)
  const referralOrders = orders.filter(order => order.referrerStoreId === store.id)
  const pickupOrders = orders.filter(order => order.pickupStoreId === store.id)
  const sumByStatus = status => records.filter(record => record.status === status).reduce((sum, record) => sum + Number(record.amount || 0), 0).toFixed(2)
  return {
    todayReferralOrders: referralOrders.filter(order => String(order.createdAt || "").startsWith(today)).length,
    monthReferralOrders: referralOrders.filter(order => String(order.createdAt || "").startsWith(month)).length,
    todayPickupOrders: pickupOrders.filter(order => String(order.createdAt || "").startsWith(today)).length,
    pendingPickupOrders: pickupOrders.filter(order => order.pickupStatus === "arrived_store").length,
    unsettledAmount: sumByStatus("unsettled"),
    settledAmount: sumByStatus("settled")
  }
}

async function verifyStorePickupOrder(store, orderId, pickupCode) {
  const orders = await getOrders()
  const order = orders.find(item => item.id === orderId)
  if (!order) throw httpError(404, "订单不存在")
  if (order.pickupStoreId !== store.id) throw httpError(403, "不能核销其他门店订单")
  if (order.paymentStatus !== "已支付") throw httpError(400, "订单未支付，暂不能核销")
  if (order.pickupStatus === "picked_up") throw httpError(400, "该订单已核销")
  if (!pickupCode || String(order.pickupCode) !== String(pickupCode)) throw httpError(400, "取货码不正确")
  order.pickupStatus = "picked_up"
  order.status = "已完成"
  order.pickedUpAt = formatDateTime(new Date())
  order.completedAt = order.completedAt || order.pickedUpAt
  await saveOrders([order])
  await createStoreSettlementRecordsForOrder(order)
  return storeOrderView(order, "pickup")
}

async function createOrder(data) {
  let product = await getProduct(data.productId)
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
  const isQuoteOrder = String(data.needQuote || product.needQuote || product.need_quote || "").toLowerCase() === "true" ||
    String(data.priceMode || product.priceMode || product.price_mode || "").toLowerCase() === "quote" ||
    (String(data.isCustomOrder || "false") === "true" && Number(product.price || 0) <= 0)
  const orderAmount = isQuoteOrder ? "0.00" : money(product.price)
  const deliveryType = data.deliveryType === "pickup" ? "pickup" : "delivery"
  let pickupStore = null
  if (deliveryType === "pickup") {
    pickupStore = await getPartnerStore(data.pickupStoreId)
    if (!pickupStore || pickupStore.status !== "enabled" || pickupStore.isPickupEnabled !== "true") throw new Error("请选择有效的自提门店")
  }
  const referrerStoreId = await resolveValidReferrerStoreId(data.referrerStoreId || data.storeId || data.referrer_store_id || "")
  const income = await calculateOrderStoreIncome({ ...data, deliveryType, referrerStoreId, pickupStoreId: pickupStore?.id || "" }, orderAmount)
  const order = normalizeOrder({
    id: `DD${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}${crypto.randomBytes(2).toString("hex").toUpperCase()}`,
    productId: product.id,
    customerName: data.customerName,
    phone: data.phone,
    productName: product.name,
    amount: orderAmount,
    status: isQuoteOrder ? "待客服确认" : "待支付",
    paymentStatus: isQuoteOrder ? "待报价" : "待支付",
    address: data.address,
    customRequest: data.customRequest,
    originalImageUrl: data.originalImageUrl || "",
    originalImageUrls: normalizeMediaList(data.originalImageUrls || data.originalImageUrl || ""),
    aiPreviewUrl: data.aiPreviewUrl || "",
    finalDesignUrl: data.finalDesignUrl || data.aiPreviewUrl || "",
    category: data.category || (Array.isArray(product.categories) ? product.categories[0] : "") || "",
    isCustomOrder: String(data.isCustomOrder || "false") === "true" ? "true" : "false",
    openid: data.openid || "",
    userId: data.userId || "",
    userToken: data.userToken || "",
    remark: [data.remark || "", data.newcomerBenefitText ? `新人福利：${data.newcomerBenefitText}` : ""].filter(Boolean).join("\n"),
    inviterCode: data.inviterCode || "",
    deliveryType,
    pickupStoreId: pickupStore?.id || "",
    pickupStore: storePublicView(pickupStore),
    pickupCode: deliveryType === "pickup" ? generatePickupCode() : "",
    pickupStatus: deliveryType === "pickup" ? "preparing" : "none",
    userLatitude: data.userLatitude || "",
    userLongitude: data.userLongitude || "",
    pickupDistance: data.pickupDistance || "",
    referrerStoreId,
    supplierStoreId: data.supplierStoreId || "",
    referralCommission: income.referralCommission,
    pickupServiceFee: income.pickupServiceFee,
    supplierSettlementAmount: "0.00",
    customCommissionAmount: "0.00",
    storeSettlementStatus: "unsettled"
  }, 0)
  await ensureCustomerFromOrder(order)
  await bindPromotionFromOrder(order)
  if (!pool) {
    const orders = readJsonFile(ordersFile, [])
    orders.push(order)
    writeJsonFile(ordersFile, orders)
    if (data.source === "order-recommendation") {
      await recordOrderRecommendationEvent({ type: "conversion", productId: order.productId, productName: order.productName, orderId: order.id, amount: order.amount, phone: order.phone })
    }
    return order
  }
  await query(
    "INSERT INTO orders (id, product_id, customer_name, phone, product_name, amount, status, payment_status, transaction_id, openid, user_id, user_token, address, custom_request, original_image_url, original_image_urls, ai_preview_url, final_design_url, category, is_custom_order, remark, inviter_code, created_at, delivery_type, pickup_store_id, pickup_code, pickup_status, user_latitude, user_longitude, pickup_distance, referrer_store_id, supplier_store_id, referral_commission, pickup_service_fee, supplier_settlement_amount, custom_commission_amount, store_settlement_status) VALUES (:id, :productId, :customerName, :phone, :productName, :amount, :status, :paymentStatus, :transactionId, :openid, :userId, :userToken, :address, :customRequest, :originalImageUrl, :originalImageUrlsJson, :aiPreviewUrl, :finalDesignUrl, :category, :isCustomOrder, :remark, :inviterCode, :createdAt, :deliveryType, :pickupStoreId, :pickupCode, :pickupStatus, :userLatitude, :userLongitude, :pickupDistance, :referrerStoreId, :supplierStoreId, :referralCommission, :pickupServiceFee, :supplierSettlementAmount, :customCommissionAmount, :storeSettlementStatus)",
    {
      ...mysqlOrderParams(order),
      originalImageUrlsJson: JSON.stringify(order.originalImageUrls || []),
      userLatitude: order.userLatitude === "" ? null : order.userLatitude,
      userLongitude: order.userLongitude === "" ? null : order.userLongitude,
      pickupDistance: order.pickupDistance === "" ? null : order.pickupDistance
    }
  )
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

async function markOrderPaid(orderId, transactionId = "") {
  if (!pool) {
    const orders = readJsonFile(ordersFile, []).map(normalizeOrder)
    const index = orders.findIndex(order => order.id === orderId)
    if (index >= 0) {
      if (orders[index].paymentStatus === "已支付") {
        console.log("[pay] markOrderPaid skipped already paid", { orderId })
        return false
      }
      orders[index].paymentStatus = "已支付"
      orders[index].status = "待发货"
      orders[index].transactionId = transactionId
      orders[index].paidAt = new Date().toISOString().slice(0, 16).replace("T", " ")
      writeJsonFile(ordersFile, orders)
      await createRewardsForOrder(orders[index])
      await createStoreSettlementRecordsForOrder(orders[index])
      console.log("[pay] markOrderPaid updated json order", { orderId, hasTransactionId: !!transactionId })
      return true
    }
    console.warn("[pay] markOrderPaid order missing", { orderId })
    return false
  }
  const result = await query(
    "UPDATE orders SET payment_status = '已支付', status = '待发货', transaction_id = :transactionId, paid_at = NOW() WHERE id = :orderId AND payment_status <> '已支付'",
    { orderId, transactionId }
  )
  const affectedRows = Number(result.affectedRows || 0)
  console.log("[pay] markOrderPaid mysql update", { orderId, affectedRows, hasTransactionId: !!transactionId })
  if (!affectedRows) return false
  const order = (await getOrders({ keyword: orderId })).find(item => item.id === orderId)
  if (order) {
    await createRewardsForOrder(order)
    await createStoreSettlementRecordsForOrder(order)
  }
  return true
}

async function applyShipment(data) {
  const orders = await getOrders()
  const index = orders.findIndex(order => order.id === data.orderId)
  if (index < 0) throw new Error("订单不存在")
  orders[index] = {
    ...orders[index],
    shippingCompany: data.shippingCompany || orders[index].shippingCompany,
    trackingNumber: data.trackingNumber || orders[index].trackingNumber,
    status: "已发货",
    shippedAt: formatDateTime(new Date())
  }
  await saveOrders([orders[index]])
  return orders[index]
}

async function markOrderArrivedStore(orderId) {
  const orders = await getOrders()
  const index = orders.findIndex(order => order.id === orderId)
  if (index < 0) throw new Error("订单不存在")
  if (orders[index].deliveryType !== "pickup") throw new Error("该订单不是到店自提订单")
  orders[index] = {
    ...orders[index],
    status: "已到店",
    pickupStatus: "arrived_store",
    arrivedStoreAt: formatDateTime(new Date())
  }
  await saveOrders([orders[index]])
  await sendPickupArrivedNotice(orderId)
  return orders[index]
}

async function markOrderPickedUp(orderId) {
  const orders = await getOrders()
  const index = orders.findIndex(order => order.id === orderId)
  if (index < 0) throw new Error("订单不存在")
  if (orders[index].deliveryType !== "pickup") throw new Error("该订单不是到店自提订单")
  orders[index] = {
    ...orders[index],
    status: "已完成",
    pickupStatus: "picked_up",
    pickedUpAt: formatDateTime(new Date()),
    completedAt: orders[index].completedAt || formatDateTime(new Date())
  }
  await saveOrders([orders[index]])
  await createStoreSettlementRecordsForOrder(orders[index])
  return orders[index]
}

async function applyRefundRequest(data) {
  const orders = await getOrders()
  const index = orders.findIndex(order => order.id === data.orderId)
  if (index < 0) throw new Error("订单不存在")
  if (!orderBelongsToIdentity(orders[index], data)) throw new Error("无权操作该订单")
  const amount = Math.min(Number(data.refundAmount || orders[index].amount), Number(orders[index].amount || 0))
  if (!amount || amount <= 0) throw new Error("退款金额不正确")
  orders[index] = {
    ...orders[index],
    status: "退款中",
    refundType: data.refundType || "仅退款",
    refundStatus: "待审核",
    refundReason: data.refundReason || "",
    refundAmount: amount.toFixed(2),
    refundRemark: data.refundRemark || "",
    refundImageUrl: data.refundImageUrl || "",
    refundRejectReason: "",
    refundReviewedAt: null
  }
  await saveOrders([orders[index]])
  return orders[index]
}

async function reviewRefund(data) {
  const orders = await getOrders()
  const index = orders.findIndex(order => order.id === data.orderId)
  if (index < 0) throw new Error("订单不存在")
  const order = orders[index]
  const action = data.action || "approve"
  if (action === "reject") {
    orders[index] = {
      ...order,
      status: order.paymentStatus === "已支付" ? "待发货" : "待支付",
      refundStatus: "已拒绝",
      refundRejectReason: data.rejectReason || "退款申请未通过",
      refundReviewedAt: formatDateTime(new Date())
    }
    await saveOrders([orders[index]])
    return orders[index]
  }
  const amount = action === "partial"
    ? Math.min(Number(data.refundAmount || order.refundAmount || 0), Number(order.amount || 0))
    : Number(order.refundAmount || order.amount || 0)
  if (!amount || amount <= 0) throw new Error("退款金额不正确")
  orders[index] = {
    ...order,
    status: "已退款",
    paymentStatus: amount >= Number(order.amount || 0) ? "已退款" : "部分退款",
    refundStatus: action === "partial" ? "部分退款成功" : "退款成功",
    refundAmount: amount.toFixed(2),
    refundReviewedAt: formatDateTime(new Date()),
    refundAt: formatDateTime(new Date())
  }
  await saveOrders([orders[index]])
  await rollbackRewardsForOrder(order.id)
  return orders[index]
}

async function rollbackRewardsForOrder(orderId) {
  const records = await getRewardRecords()
  let changed = false
  for (const record of records) {
    if (record.orderId === orderId && record.status !== "已扣回") {
      record.status = "已扣回"
      record.updatedAt = formatDateTime(new Date())
      changed = true
    }
  }
  if (changed) await saveRewardRecords(records)
  return records
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
      customer
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
  await query("DELETE FROM promotion_relations")
  for (const relation of list) {
    await query(
      "INSERT INTO promotion_relations (id, inviter_phone, inviter_name, inviter_code, invitee_phone, invitee_name, level, created_at) VALUES (:id, :inviterPhone, :inviterName, :inviterCode, :inviteePhone, :inviteeName, :level, :createdAt)",
      { ...relation, createdAt: toMysqlDatetime(relation.createdAt, nowMysqlDatetime()) }
    )
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

async function bindPromotionFromOrder(order) {
  return bindPromotionRelation(order.inviterCode, order.phone, order.customerName, false)
}

async function bindPromotionRelation(inviterCode, inviteePhone, inviteeName = "微信用户", strict = true) {
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
  if (inviter.phone === inviteePhone) {
    if (strict) throw httpError(400, "不能绑定自己的邀请码")
    return null
  }
  const relations = await getPromotionRelations()
  const existing = relations.find(relation => relation.inviteePhone === inviteePhone)
  if (existing) return { ...existing, alreadyBound: true }
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
      firstReward: product.rewardEnabled === "false" ? "0" : (product.firstReward || rule?.firstReward || "8"),
      secondReward: product.rewardEnabled === "false" ? "0" : (product.secondReward || rule?.secondReward || "3")
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
    status: row.status,
    releaseAt: row.release_at ? formatDateTime(new Date(row.release_at)) : "",
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
  await query("DELETE FROM reward_records")
  for (const record of list) {
    await query(
      "INSERT INTO reward_records (id, order_id, product_name, buyer_phone, promoter_phone, promoter_name, level, amount, status, release_at, created_at, updated_at) VALUES (:id, :orderId, :productName, :buyerPhone, :promoterPhone, :promoterName, :level, :amount, :status, :releaseAt, :createdAt, :updatedAt)",
      {
        ...record,
        releaseAt: toMysqlDatetime(record.releaseAt),
        createdAt: toMysqlDatetime(record.createdAt, nowMysqlDatetime()),
        updatedAt: toMysqlDatetime(record.updatedAt, nowMysqlDatetime())
      }
    )
  }
  return list
}

async function createRewardsForOrder(order) {
  const normalized = normalizeOrder(order, 0)
  if (normalized.paymentStatus !== "已支付") return []
  if (normalized.referrerStoreId) return await getRewardRecords()
  const existing = await getRewardRecords()
  if (existing.some(record => record.orderId === normalized.id)) return existing
  const relations = await getPromotionRelations()
  const customers = await getCustomers()
  const direct = relations.find(relation => relation.inviteePhone === normalized.phone)
  if (!direct) return existing
  const parent = relations.find(relation => relation.inviteePhone === direct.inviterPhone)
  const rules = await getRewardRules()
  const rule = rules.find(item => item.productId === normalized.productId || item.productName === normalized.productName) || normalizeRewardRule({ productName: normalized.productName, firstReward: "8", secondReward: "3" }, 0)
  const makeRecord = (promoterPhone, level, amount) => {
    const promoter = customers.find(customer => customer.phone === promoterPhone) || {}
    return normalizeRewardRecord({
      id: `RW${Date.now()}${crypto.randomBytes(2).toString("hex").toUpperCase()}${level}`,
      orderId: normalized.id,
      productName: normalized.productName,
      buyerPhone: normalized.phone,
      promoterPhone,
      promoterName: promoter.name || "",
      level,
      amount,
      status: "待发放",
      releaseAt: "",
      createdAt: formatDateTime(new Date())
    }, existing.length)
  }
  const next = [...existing]
  if (Number(rule.firstReward) > 0) next.unshift(makeRecord(direct.inviterPhone, 1, rule.firstReward))
  if (parent && Number(rule.secondReward) > 0) next.unshift(makeRecord(parent.inviterPhone, 2, rule.secondReward))
  await saveRewardRecords(next)
  return next
}

async function processRewardState() {
  const orders = await getOrders()
  const records = await getRewardRecords()
  let changed = false
  const now = new Date()
  for (const record of records) {
    const order = orders.find(item => item.id === record.orderId)
    if (!order) continue
    const refunded = order.status === "已退款" || order.paymentStatus === "已退款"
    if (refunded && record.status !== "已扣回") {
      record.status = "已扣回"
      record.updatedAt = formatDateTime(now)
      changed = true
      continue
    }
    if (record.status === "待发放" && order.status === "已完成") {
      if (!record.releaseAt) {
        record.releaseAt = addDays(order.completedAt || now, 7)
        record.updatedAt = formatDateTime(now)
        changed = true
      }
      const releaseDate = parseDateValue(record.releaseAt)
      if (releaseDate && releaseDate <= now) {
        record.status = "已发放"
        record.updatedAt = formatDateTime(now)
        changed = true
      }
    }
  }
  if (changed) await saveRewardRecords(records)
  return records
}

async function getPromotionSummary(phone) {
  const customers = await getCustomers()
  const customer = customers.find(item => item.phone === phone) || normalizeCustomer({ phone, name: "微信用户" }, 0)
  const relations = await getPromotionRelations()
  const records = await processRewardState()
  const invited = relations.filter(item => item.inviterPhone === phone)
  const orders = await getOrders()
  const inviteCode = customer.inviteCode || inviteCodeFor(phone)
  const inviteOrders = orders.filter(order => order.inviterCode === inviteCode && (order.paidAt || order.paymentStatus === "已支付"))
  const inviteAmount = inviteOrders.reduce((sum, order) => sum + Number(order.amount || 0), 0)
  const myRewards = records.filter(item => item.promoterPhone === phone)
  const available = myRewards.filter(item => item.status === "已发放").reduce((sum, item) => sum + Number(item.amount || 0), 0)
  const pending = myRewards.filter(item => item.status === "待发放").reduce((sum, item) => sum + Number(item.amount || 0), 0)
  return {
    profile: {
      name: customer.name,
      phone,
      inviteCode,
      shoppingMoney: available.toFixed(2),
      pendingReward: pending.toFixed(2),
      inviteCount: invited.length,
      inviteOrderCount: inviteOrders.length,
      inviteAmount: inviteAmount.toFixed(2),
      inviteQrUrl: `${PUBLIC_BASE_URL}/api/promotion/qr?code=${encodeURIComponent(inviteCode)}`,
      inviteQrText: `非常智造 邀请码：${inviteCode}`
    },
    invited,
    rewards: myRewards
  }
}

async function getSettings() {
  const normalize = settings => ({
    ...settings,
    ...normalizeThemeSettings(settings),
    newcomerBenefitsEnabled: String(settings.newcomerBenefitsEnabled == null ? "true" : settings.newcomerBenefitsEnabled) === "false" ? "false" : "true",
    newcomerBenefits: normalizeNewcomerBenefits(settings),
    helpArticles: normalizeHelpArticles(settings.helpArticles),
    ...normalizeContactSettings(settings)
  })
  if (!pool) return normalize(readJsonFile(settingsFile, {}))
  const rows = await query("SELECT data FROM system_settings WHERE id = 1")
  return normalize(parseJsonValue(rows[0]?.data, {}))
}

async function saveSettings(settings) {
  settings = {
    ...settings,
    ...normalizeThemeSettings(settings),
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
  if (!mysql) {
    console.log("本地开发模式：未安装 mysql2，已启用 JSON 数据存储。")
    return
  }
  const rootPool = mysql.createPool({ ...dbConfig, database: undefined })
  await rootPool.query(`CREATE DATABASE IF NOT EXISTS \`${dbConfig.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`)
  await rootPool.end()
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
    created_at DATETIME,
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
  await ensureColumn("orders", "paid_at", "DATETIME")
  await ensureColumn("orders", "completed_at", "DATETIME")
  await ensureColumn("orders", "refund_at", "DATETIME")
  await ensureColumn("orders", "delivery_type", "VARCHAR(20) DEFAULT 'delivery'")
  await ensureColumn("orders", "pickup_store_id", "VARCHAR(40)")
  await ensureColumn("orders", "pickup_code", "VARCHAR(20)")
  await ensureColumn("orders", "pickup_status", "VARCHAR(30) DEFAULT 'none'")
  await ensureColumn("orders", "arrived_store_at", "DATETIME")
  await ensureColumn("orders", "picked_up_at", "DATETIME")
  await ensureColumn("orders", "user_latitude", "DECIMAL(10,6)")
  await ensureColumn("orders", "user_longitude", "DECIMAL(10,6)")
  await ensureColumn("orders", "pickup_distance", "DECIMAL(10,2)")
  await ensureColumn("orders", "referrer_store_id", "VARCHAR(40)")
  await ensureColumn("orders", "supplier_store_id", "VARCHAR(40)")
  await ensureColumn("orders", "referral_commission", "DECIMAL(10,2) DEFAULT 0")
  await ensureColumn("orders", "pickup_service_fee", "DECIMAL(10,2) DEFAULT 0")
  await ensureColumn("orders", "supplier_settlement_amount", "DECIMAL(10,2) DEFAULT 0")
  await ensureColumn("orders", "custom_commission_amount", "DECIMAL(10,2) DEFAULT 0")
  await ensureColumn("orders", "store_settlement_status", "VARCHAR(30) DEFAULT 'unsettled'")
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
  await query(`CREATE TABLE IF NOT EXISTS store_settlement_records (
    id VARCHAR(60) PRIMARY KEY,
    store_id VARCHAR(40),
    order_id VARCHAR(32),
    type VARCHAR(20),
    amount DECIMAL(10,2) DEFAULT 0,
    commission_type VARCHAR(20),
    commission_value DECIMAL(10,2) DEFAULT 0,
    order_paid_amount DECIMAL(10,2) DEFAULT 0,
    status VARCHAR(20) DEFAULT 'unsettled',
    description VARCHAR(255),
    created_at DATETIME,
    settled_at DATETIME,
    INDEX idx_store_status (store_id, status),
    INDEX idx_order_id (order_id)
  )`)
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
  await query(`CREATE TABLE IF NOT EXISTS system_settings (
    id INT PRIMARY KEY,
    data JSON NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  )`)

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
}

async function ensureColumn(table, column, definition) {
  const rows = await query(
    "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = :schema AND TABLE_NAME = :table AND COLUMN_NAME = :column",
    { schema: dbConfig.database, table, column }
  )
  if (!rows.length) await query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`)
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
  if (order.paymentStatus === "已支付") {
    throw httpError(400, "订单已支付，无需重复付款")
  }
  const sessionOpenid = String(openid || identity.openid || "").trim()
  const sessionUserToken = String(identity.userToken || identity.userSession || "").trim()
  const orderOpenid = String(order.openid || "").trim()
  const orderUserToken = String(order.userToken || "").trim()
  if (!orderOpenid && !orderUserToken) {
    console.warn(`[pay] reject empty owner order=${order.id} sessionOpenid=${maskSecret(sessionOpenid)} sessionToken=${maskSecret(sessionUserToken)}`)
    throw httpError(403, "订单缺少用户身份，请联系商家处理")
  }
  if (orderOpenid && orderOpenid !== sessionOpenid) {
    console.warn(`[pay] reject openid mismatch order=${order.id} orderOpenid=${maskSecret(orderOpenid)} sessionOpenid=${maskSecret(sessionOpenid)}`)
    throw httpError(403, "无权支付该订单")
  }
  if (orderUserToken && orderUserToken !== sessionUserToken) {
    console.warn(`[pay] reject token mismatch order=${order.id} orderToken=${maskSecret(orderUserToken)} sessionToken=${maskSecret(sessionUserToken)}`)
    throw httpError(403, "无权支付该订单")
  }
  if (!orderOpenid && orderUserToken && orderUserToken === sessionUserToken && sessionOpenid) {
    await setOrderOpenid(order.id, sessionOpenid)
    order.openid = sessionOpenid
    console.log(`[pay] backfilled openid after token match order=${order.id} openid=${maskSecret(sessionOpenid)}`)
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

async function assertConfirmedPaymentMatchesOrder(confirmed) {
  const orderId = confirmed.out_trade_no || ""
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

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`)

  if (req.method === "OPTIONS") {
    sendText(res, 204, "")
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

  if (req.method === "GET" && url.pathname === "/login") {
    sendText(res, 200, fs.readFileSync(loginFile, "utf8"), "text/html; charset=utf-8")
    return
  }

  if (req.method === "GET" && url.pathname === "/test") {
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
    const pass = process.env.ADMIN_PASSWORD || "ChangeMe123!"
    if (body.username !== user || body.password !== pass) {
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
    const [home, settings] = await Promise.all([getHome(), getSettings()])
    sendJson(res, 200, {
      ...home,
      theme: currentThemeFromSettings(settings),
      categoryCatalog: Array.isArray(settings.categoryCatalog) ? settings.categoryCatalog : [],
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
      articles: normalizeHelpArticles(settings.helpArticles).filter(item => item.status !== "off"),
      banner: pickBanner(home.banners, 4),
      profileBanner: pickBanner(home.banners, 3),
      helpBanner: pickBanner(home.banners, 4),
      contact: normalizeContactSettings(settings),
      updatedAt: new Date().toISOString()
    })
    return
  }

  if (url.pathname === "/api/products" && req.method === "GET") {
    sendJson(res, 200, await getProducts())
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
    sendJson(res, 200, { ok: true, bound: true, storeInfo: storePrivateView(storeSession.store), stats: storeCenterStats(storeSession.store, orders, records) })
    return
  }

  if (url.pathname === "/api/store/referral-orders" && req.method === "GET") {
    const storeSession = await requireStoreSession(req, res)
    if (!storeSession) return
    const orders = (await getOrders()).filter(order => order.referrerStoreId === storeSession.store.id)
    const records = await getStoreSettlementRecords({ storeId: storeSession.store.id, type: "store_referral_commission" })
    const unsettled = records.filter(record => record.status === "unsettled").reduce((sum, record) => sum + Number(record.amount || 0), 0)
    const settled = records.filter(record => record.status === "settled").reduce((sum, record) => sum + Number(record.amount || 0), 0)
    const today = new Date().toISOString().slice(0, 10)
    const month = new Date().toISOString().slice(0, 7)
    sendJson(res, 200, {
      storeInfo: storePrivateView(storeSession.store),
      summary: {
        todayOrders: orders.filter(order => String(order.createdAt || "").startsWith(today)).length,
        monthOrders: orders.filter(order => String(order.createdAt || "").startsWith(month)).length,
        unsettledCommission: money(unsettled),
        settledCommission: money(settled)
      },
      orders: orders.map(order => storeOrderView(order, "referral"))
    })
    return
  }

  if (url.pathname === "/api/store/pickup-orders" && req.method === "GET") {
    const storeSession = await requireStoreSession(req, res)
    if (!storeSession) return
    const orders = (await getOrders()).filter(order => order.pickupStoreId === storeSession.store.id)
    sendJson(res, 200, { storeInfo: storePrivateView(storeSession.store), orders: orders.map(order => storeOrderView(order, "pickup")) })
    return
  }

  if (url.pathname === "/api/store/settlements" && req.method === "GET") {
    const storeSession = await requireStoreSession(req, res)
    if (!storeSession) return
    const records = await getStoreSettlementRecords({ storeId: storeSession.store.id })
    const unsettled = records.filter(record => record.status === "unsettled").reduce((sum, record) => sum + Number(record.amount || 0), 0)
    const settled = records.filter(record => record.status === "settled").reduce((sum, record) => sum + Number(record.amount || 0), 0)
    const referral = records.filter(record => isStoreReferralSettlement(record.type)).reduce((sum, record) => sum + Number(record.amount || 0), 0)
    const pickup = records.filter(record => isPickupServiceSettlement(record.type)).reduce((sum, record) => sum + Number(record.amount || 0), 0)
    sendJson(res, 200, {
      storeInfo: storePrivateView(storeSession.store),
      summary: { unsettledAmount: money(unsettled), settledAmount: money(settled), referralAmount: money(referral), pickupAmount: money(pickup) },
      records: records.map(record => ({ ...record, typeText: isStoreReferralSettlement(record.type) ? "门店推广佣金" : isPickupServiceSettlement(record.type) ? "自提服务费" : record.type }))
    })
    return
  }

  if (url.pathname.match(/^\/api\/store\/orders\/[^/]+\/verify-pickup$/) && req.method === "POST") {
    const storeSession = await requireStoreSession(req, res)
    if (!storeSession) return
    const orderId = decodeURIComponent(url.pathname.split("/")[4])
    const body = JSON.parse((await readBody(req)).toString() || "{}")
    sendJson(res, 200, { ok: true, data: await verifyStorePickupOrder(storeSession.store, orderId, body.pickupCode) })
    return
  }

  if (url.pathname === "/api/product/detail" && req.method === "GET") {
    const id = url.searchParams.get("id") || url.searchParams.get("productId")
    const product = id ? await getProduct(decodeURIComponent(id)) : null
    if (!product) {
      sendJson(res, 404, { ok: false, message: "商品不存在" })
      return
    }
    sendJson(res, 200, product)
    return
  }

  if (url.pathname.startsWith("/api/products/") && req.method === "GET") {
    const product = await getProduct(decodeURIComponent(url.pathname.replace("/api/products/", "")))
    if (!product) {
      sendJson(res, 404, { ok: false, message: "商品不存在" })
      return
    }
    sendJson(res, 200, product)
    return
  }

  if (url.pathname === "/api/orders" && req.method === "POST") {
    const body = JSON.parse((await readBody(req)).toString() || "{}")
    const identity = identityFromRequest(req, body)
    if (!hasRequestIdentity(identity)) {
      sendJson(res, 401, { ok: false, message: "请先完成微信登录" })
      return
    }
    const order = await createOrder({
      ...body,
      phone: body.phone || identity.phone || "",
      openid: identity.openid,
      userId: "",
      userToken: identity.userToken,
      userSession: identity.userSession
    })
    sendJson(res, 200, { ok: true, data: order })
    return
  }

  if (url.pathname === "/api/orders" && req.method === "GET") {
    const identity = identityFromRequest(req, Object.fromEntries(url.searchParams.entries()))
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
    const identity = identityFromRequest(req, Object.fromEntries(url.searchParams.entries()))
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
    const identity = identityFromRequest(req, body)
    if (!hasRequestIdentity(identity)) {
      sendJson(res, 401, { ok: false, message: "请先完成微信登录" })
      return
    }
    sendJson(res, 200, { ok: true, data: await applyRefundRequest({ ...body, ...identity }) })
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

  if (url.pathname === "/api/ai/preview" && req.method === "POST") {
    sendJson(res, 200, { ok: true, data: await createAiPreview(JSON.parse((await readBody(req)).toString() || "{}")) })
    return
  }

  if (url.pathname === "/api/wechat/openid" && req.method === "POST") {
    const body = JSON.parse((await readBody(req)).toString() || "{}")
    const openid = await getOpenid(body.code)
    const userSession = createWechatUserSession(openid)
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
    const userSession = openid ? createWechatUserSession(openid, phoneNumber) : ""
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

  if (url.pathname === "/api/user/profile" && req.method === "GET") {
    const identity = identityFromRequest(req, Object.fromEntries(url.searchParams.entries()))
    if (!hasRequestIdentity(identity)) {
      sendJson(res, 401, { ok: false, message: "请先完成微信登录" })
      return
    }
    sendJson(res, 200, { ok: true, data: await getUserProfile(identity) })
    return
  }

  if (url.pathname === "/api/user/profile" && req.method === "POST") {
    const body = JSON.parse((await readBody(req)).toString() || "{}")
    const identity = identityFromRequest(req, body)
    if (!hasRequestIdentity(identity)) {
      sendJson(res, 401, { ok: false, message: "请先完成微信登录" })
      return
    }
    sendJson(res, 200, { ok: true, data: await saveUserProfile(identity, body) })
    return
  }

  if (url.pathname === "/api/pay/wechat" && req.method === "POST") {
    const body = JSON.parse((await readBody(req)).toString() || "{}")
    const identity = identityFromRequest(req, body)
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
      const updated = await markOrderPaid(resource.out_trade_no, transactionId)
      console.log("[pay] notify mark paid result", { orderId: resource.out_trade_no || "", updated })
    }
    sendJson(res, 200, { code: "SUCCESS", message: "成功" })
    return
  }

  if (url.pathname === "/api/promotion/summary" && req.method === "GET") {
    sendJson(res, 200, await getPromotionSummary(url.searchParams.get("phone") || ""))
    return
  }

  if (url.pathname === "/api/newcomer/benefits" && req.method === "GET") {
    sendJson(res, 200, await getNewcomerBenefits({
      phone: url.searchParams.get("phone") || "",
      openid: url.searchParams.get("openid") || ""
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
    const identity = identityFromRequest(req, body)
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

  if (!url.pathname.startsWith("/api/admin") && url.pathname !== "/api/home" && url.pathname !== "/api/theme/current" && url.pathname !== "/api/upload" && url.pathname !== "/api/upload/public" && url.pathname !== "/api/ai/preview") {
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
    const userSession = isPublicUpload ? userSessionFromRequest(req) : null
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
    const uploaded = files.map(file => {
      const uploadType = isPublicUpload ? validatePublicUploadImage(file, loggedInPublicUpload) : validateUploadFile(file)
      if (isPublicUpload && uploadType.type !== "image") throw new Error("仅支持上传jpg/jpeg/png/webp/heic图片")
      const filename = isPublicUpload ? publicUploadFilename(uploadType.ext, !loggedInPublicUpload) : safeName(file.filename || `upload.${uploadType.ext}`)
      fs.writeFileSync(path.join(uploadsDir, filename), file.body)
      return { url: `${PUBLIC_BASE_URL}/uploads/${filename}`, type: uploadType.type }
    })
    const first = uploaded[0]
    sendJson(res, 200, { ok: true, url: first.url, urls: uploaded.map(item => item.url), type: first.type, temporary: isPublicUpload && !loggedInPublicUpload })
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
      if (order.refundAmount) return sum + Number(order.refundAmount || 0)
      return sum + (order.status === "已退款" || order.paymentStatus === "已退款" ? Number(order.amount || 0) : 0)
    }, 0)
    const rewardPaid = rewards.filter(record => record.status === "已发放").reduce((sum, record) => sum + Number(record.amount || 0), 0)
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
    sendJson(res, 200, { ok: true, data: await saveOrders(JSON.parse((await readBody(req)).toString())) })
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
    sendJson(res, 200, { ok: true, data: await markOrderPickedUp(orderId) })
    return
  }

  if (url.pathname === "/api/admin/orders/refund-review" && req.method === "POST") {
    sendJson(res, 200, { ok: true, data: await reviewRefund(JSON.parse((await readBody(req)).toString() || "{}")) })
    return
  }

  if (url.pathname === "/api/admin/stores" && req.method === "GET") {
    sendJson(res, 200, withStoreManagerWarnings(await getPartnerStores({ keyword: url.searchParams.get("keyword") || "" })))
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
    const records = await getStoreSettlementRecords()
    const now = formatDateTime(new Date())
    records.forEach(record => {
      if (ids.includes(record.id)) {
        record.status = "settled"
        record.settledAt = now
      }
    })
    await saveStoreSettlementRecords(records)
    sendJson(res, 200, { ok: true, data: await getStoreSettlementSummary({}) })
    return
  }

  if (url.pathname === "/api/admin/customers" && req.method === "GET") {
    sendJson(res, 200, await getCustomers())
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
    sendJson(res, 200, await processRewardState())
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

  if (url.pathname === "/api/admin/themes" && req.method === "GET") {
    const settings = await getSettings()
    sendJson(res, 200, { ok: true, data: normalizeThemeSettings(settings) })
    return
  }

  const themeApiMatch = url.pathname.match(/^\/api\/admin\/themes\/([^/]+)(?:\/(activate))?$/)
  if (themeApiMatch && req.method === "PUT" && !themeApiMatch[2]) {
    const skinId = themeApiMatch[1].replace(/[^\w-]/g, "")
    const body = JSON.parse((await readBody(req)).toString() || "{}")
    const current = await getSettings()
    const themeSettings = normalizeThemeSettings(current)
    let existingIndex = themeSettings.themes.findIndex(theme => theme.skinId === skinId)
    if (existingIndex < 0) existingIndex = themeSettings.themes.length
    const previous = themeSettings.themes[existingIndex] || {}
    const savedTheme = normalizeTheme({
      ...previous,
      ...body,
      skinId,
      skin: skinId,
      version: Number(previous.version || body.version || 1) + 1,
      updatedAt: formatDateTime(new Date())
    }, existingIndex)
    const themes = [...themeSettings.themes]
    themes[existingIndex] = savedTheme
    const nextSettings = await saveSettings({ ...current, ...themeSettings, themes })
    sendJson(res, 200, { ok: true, data: normalizeThemeSettings(nextSettings), message: "皮肤已保存，启用后小程序将读取最新皮肤。" })
    return
  }

  if (themeApiMatch && req.method === "POST" && themeApiMatch[2] === "activate") {
    const skinId = themeApiMatch[1].replace(/[^\w-]/g, "")
    const current = await getSettings()
    const themeSettings = normalizeThemeSettings(current)
    const targetIndex = themeSettings.themes.findIndex(theme => theme.skinId === skinId)
    if (targetIndex < 0) {
      sendJson(res, 404, { ok: false, message: "皮肤不存在" })
      return
    }
    const activatedAt = formatDateTime(new Date())
    const themes = themeSettings.themes.map((theme, index) => normalizeTheme({
      ...theme,
      activatedAt: index === targetIndex ? activatedAt : theme.activatedAt,
      updatedAt: index === targetIndex ? activatedAt : theme.updatedAt,
      enabled: theme.skinId === skinId ? "true" : "false"
    }, index))
    const nextSettings = await saveSettings({
      ...current,
      ...themeSettings,
      themes,
      currentSkinId: skinId,
      activeThemeSkin: skinId,
      currentThemeVersion: Number(themeSettings.currentThemeVersion || 1) + 1
    })
    sendJson(res, 200, { ok: true, data: normalizeThemeSettings(nextSettings), message: "皮肤已启用，小程序重新进入页面或切换 tab 后自动生效。" })
    return
  }

  if (themeApiMatch && req.method === "DELETE" && !themeApiMatch[2]) {
    const skinId = themeApiMatch[1].replace(/[^\w-]/g, "")
    const current = await getSettings()
    const themeSettings = normalizeThemeSettings(current)
    if (skinId === "skin01") {
      sendJson(res, 400, { ok: false, message: "默认皮肤 skin01 不允许删除" })
      return
    }
    if (skinId === themeSettings.currentSkinId) {
      sendJson(res, 400, { ok: false, message: "当前启用皮肤不允许删除" })
      return
    }
    if (!themeSettings.themes.some(theme => theme.skinId === skinId)) {
      sendJson(res, 404, { ok: false, message: "皮肤不存在" })
      return
    }
    const deletedThemeSkins = Array.from(new Set([...(themeSettings.deletedThemeSkins || []), skinId]))
    const themes = themeSettings.themes.filter(theme => theme.skinId !== skinId)
    const themePath = path.join(themesDir, skinId)
    if (themePath.startsWith(themesDir)) fs.rmSync(themePath, { recursive: true, force: true })
    const nextSettings = await saveSettings({ ...current, ...themeSettings, deletedThemeSkins, themes })
    sendJson(res, 200, { ok: true, data: normalizeThemeSettings(nextSettings), message: "皮肤已删除" })
    return
  }

  if (url.pathname === "/api/admin/themes" && req.method === "PUT") {
    const body = JSON.parse((await readBody(req)).toString() || "{}")
    const current = await getSettings()
    const themeSettings = normalizeThemeSettings({
      ...current,
      themes: Array.isArray(body.themes) ? body.themes.map(normalizeTheme) : current.themes,
      currentSkinId: body.currentSkinId || body.activeThemeSkin || current.currentSkinId || current.activeThemeSkin,
      activeThemeSkin: body.activeThemeSkin || body.currentSkinId || current.activeThemeSkin
    })
    sendJson(res, 200, { ok: true, data: await saveSettings({ ...current, ...themeSettings }) })
    return
  }

  sendJson(res, 404, { ok: false, message: "Not found" })
}

warnRuntimeMode()
assertProductionRuntimeConfig()
ensureUploadDirectoryGuards()

initDb().then(() => {
  cleanupOrphanTempUploads(true).catch(error => console.warn("临时图片清理失败：", error.message))
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
