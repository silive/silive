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
loadEnv(path.join(ROOT, ".env"))

const IS_PRODUCTION = process.env.NODE_ENV === "production"
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
const productUploadsDir = path.join(uploadsDir, "products")
const brandQrLogoFile = path.join(ROOT, "assets", "logo-orange.png")
const BRAND_QR_LOGO_VERSION = "orange-v4"
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
const storeMembersFile = path.join(seedDir, "store-members.json")
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

function homepageRecommendedProducts(products = []) {
  const online = products.filter(product => product.status !== "off")
  return online.filter(product => String(product.isHot) === "true").sort(homepageProductSort).slice(0, 6)
}

function homepageBurstProducts(products = []) {
  return products
    .filter(product => product.status !== "off" && product.badge === "best" && String(product.isHot) !== "true")
    .sort(homepageProductSort)
    .slice(0, 4)
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
    refunded: "refunded",
    remake: "remake",
    reship: "reship",
    "无售后": "none",
    "待审核": "requested",
    "售后处理中": "requested",
    "退款处理中": "refund_pending",
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
    userLatitude: order.userLatitude == null || order.userLatitude === "" ? "" : String(order.userLatitude),
    userLongitude: order.userLongitude == null || order.userLongitude === "" ? "" : String(order.userLongitude),
    pickupDistance: order.pickupDistance == null || order.pickupDistance === "" ? "" : String(order.pickupDistance),
    referrerStoreId: order.referrerStoreId || order.referrer_store_id || "",
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
    storeSettlementStatus: order.storeSettlementStatus || "unsettled",
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
  if (canShowPickupCodeForOrder(order)) return order
  return {
    ...order,
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
    paidAt: toMysqlDatetime(order.paidAt),
    completedAt: toMysqlDatetime(order.completedAt),
    refundAt: toMysqlDatetime(order.refundAt),
    arrivedStoreAt: toMysqlDatetime(order.arrivedStoreAt),
    pickedUpAt: toMysqlDatetime(order.pickedUpAt),
    pickupVerifiedAt: toMysqlDatetime(order.pickupVerifiedAt),
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
    createdAt: store.createdAt || store.created_at || formatDateTime(new Date()),
    updatedAt: store.updatedAt || store.updated_at || formatDateTime(new Date())
  }
}

function normalizeSettlementRecord(record = {}, index = 0) {
  const createdAt = record.createdAt || record.created_at || formatDateTime(new Date())
  const settledAt = record.settledAt || record.settled_at || ""
  const status = normalizeSettlementStatus(record.status)
  const isStoreMemberOrder = boolValue(record.isStoreMemberOrder ?? record.is_store_member_order)
  const storeOrderType = record.storeOrderType || record.store_order_type || (isStoreMemberOrder ? "store_self" : (isStoreReferralSettlement(record.type || "") ? "store_external" : ""))
  const storeOperatorPhone = normalizePhone(record.storeOperatorPhone || record.store_operator_phone || "")
  const rawStoreOperatorRole = record.storeOperatorRole || record.store_operator_role || ""
  const storeOperatorRole = rawStoreOperatorRole ? normalizeStoreMemberRole(rawStoreOperatorRole) : ""
  const storeOrderTypeText = storeOrderSourceText(storeOrderType, isStoreMemberOrder) || "未知"
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

function calculateStoreAmount(amount, type, value) {
  const paid = Number(amount || 0)
  const num = Math.max(0, Number(value || 0))
  if (!paid || type === "none") return "0.00"
  if (type === "percent") return money(paid * num / 100)
  if (type === "fixed") return money(Math.min(num, paid * 0.5))
  return "0.00"
}

function calculatePickupServiceFee(amount, type, value) {
  const paid = Number(amount || 0)
  const num = Math.max(0, Number(value || 0))
  if (!paid || type === "none") return "0.00"
  if (type === "percent") return money(paid * num / 100)
  if (type === "fixed") return money(num)
  return "0.00"
}

function normalizePickupCode(value) {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6)
}

function generatePickupCodeCandidate() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
  let code = ""
  for (let index = 0; index < 6; index += 1) {
    code += alphabet[Math.floor(Math.random() * alphabet.length)]
  }
  return code
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
  return `${Date.now().toString(36).toUpperCase().slice(-6)}`
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
    createdAt: record.createdAt || new Date().toISOString().slice(0, 16).replace("T", " "),
    updatedAt: record.updatedAt || ""
  }
}

function isChargebackRecord(record = {}) {
  return String(record.type || "").includes("chargeback") || String(record.id || "").includes("CHARGEBACK")
}

function normalizeRewardStatus(status) {
  const text = String(status || "").trim()
  if (["settled", "已结算", "已发放"].includes(text)) return "settled"
  if (["cancelled", "canceled", "已取消", "已扣回", "扣回"].includes(text)) return "cancelled"
  return "unsettled"
}

function rewardStatusText(status) {
  if (status === "settled") return "已结算"
  if (status === "cancelled") return "已取消"
  return "未结算"
}

function normalizeSettlementStatus(status) {
  const text = String(status || "").trim()
  if (["settled", "已结算"].includes(text)) return "settled"
  if (["cancelled", "canceled", "已取消", "invalid", "失效"].includes(text)) return "cancelled"
  return "unsettled"
}

function settlementStatusText(status) {
  if (status === "settled") return "已结算"
  if (status === "cancelled") return "已取消"
  return "未结算"
}

function buildSettlementSummary(records = []) {
  const list = Array.isArray(records) ? records : []
  const settledTotal = list
    .filter(record => record.status === "settled" && Number(record.amount || 0) > 0)
    .reduce((sum, record) => sum + Number(record.amount || 0), 0)
  const payableTotal = list
    .filter(record => record.status === "unsettled" && Number(record.amount || 0) > 0)
    .reduce((sum, record) => sum + Number(record.amount || 0), 0)
  const chargebackTotal = Math.abs(list
    .filter(record => record.status === "unsettled" && Number(record.amount || 0) < 0)
    .reduce((sum, record) => sum + Number(record.amount || 0), 0))
  const actualPayable = Math.max(payableTotal - chargebackTotal, 0)
  const remainingChargeback = Math.max(chargebackTotal - payableTotal, 0)
  return {
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
  await query("DELETE FROM store_members")
  for (const member of deduped) {
    await query(
      `INSERT INTO store_members (id, store_id, user_id, phone, openid, role, status, created_at, updated_at)
       VALUES (:id, :storeId, :userId, :phone, :openid, :role, :status, :createdAt, :updatedAt)`,
      {
        ...member,
        createdAt: toMysqlDatetime(member.createdAt, nowMysqlDatetime()),
        updatedAt: toMysqlDatetime(member.updatedAt, nowMysqlDatetime())
      }
    )
  }
  return deduped
}

async function saveStoreMembersForStore(storeId, members = []) {
  const all = await getStoreMembers()
  const other = all.filter(member => member.storeId !== storeId)
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
  return saveStoreMembers([...other, ...next])
}

async function ensureLegacyStoreMembersForStore(store) {
  if (!store?.id || !store.managerPhone) return
  const members = await getStoreMembers({ storeId: store.id })
  const phone = normalizePhone(store.managerPhone)
  if (!phone) return
  const existing = members.find(member => member.phone === phone)
  if (existing) return
  await saveStoreMembers([
    ...(await getStoreMembers()),
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
      "INSERT INTO products (id, name, intro, price, cost_price, badge, cover, image_url, gallery_images, video_url, detail_images, detail_text, product_type, categories, status, stock, is_hot, promotion_hot, ai_preview_enabled, ai_preview_type, reward_enabled, first_reward, second_reward, sort_order) VALUES (:id, :name, :intro, :price, :costPrice, :badge, :cover, :imageUrl, :galleryImagesJson, :videoUrl, :detailImagesJson, :detailText, :productType, :categoriesJson, :status, :stock, :isHot, :promotionHot, :aiPreviewEnabled, :aiPreviewType, :rewardEnabled, :firstReward, :secondReward, :sortOrder)",
      { ...product, galleryImagesJson: JSON.stringify(product.galleryImages || []), detailImagesJson: JSON.stringify(product.detailImages || []), categoriesJson: JSON.stringify(product.categories || []), sortOrder: Number(product.sortOrder || index) }
    )
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
        if (identity.userToken && order.userToken === identity.userToken) return true
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
  const [stores, products] = await Promise.all([getPartnerStores(), getProducts()])
  const orders = rows.map(row => hydrateOrderProductImages(normalizeOrder({
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
    userLatitude: row.user_latitude,
    userLongitude: row.user_longitude,
    pickupDistance: row.pickup_distance,
    referrerStoreId: row.referrer_store_id || "",
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
    storeSettlementStatus: row.store_settlement_status || "unsettled"
  }, 0), products))
  return filters.publicOnly ? orders.map(publicOrderView) : orders
}

async function saveOrders(orders) {
  const list = orders.map(normalizeOrder)
  if (!pool) {
    const existing = readJsonFile(ordersFile, []).map(normalizeOrder)
    const merged = [...existing]
    const invalidateOrderIds = []
    for (const order of list) {
      const index = merged.findIndex(item => item.id === order.id)
      if (index >= 0) {
        const previous = merged[index]
        const next = { ...previous, ...order }
        if (next.status === "已完成" && previous.status !== "已完成") next.completedAt = formatDateTime(new Date())
        if (next.status === "已退款" && previous.status !== "已退款") next.refundAt = formatDateTime(new Date())
        if (shouldInvalidateStoreSettlementForOrderChange(previous, next)) invalidateOrderIds.push(next.id)
        merged[index] = next
      }
      else merged.push(order)
    }
    writeJsonFile(ordersFile, merged)
    await processRewardState()
    for (const orderId of [...new Set(invalidateOrderIds)]) {
      await invalidateStoreSettlementRecordsForOrder(orderId)
    }
    return list
  }
  const previousOrders = await getOrders()
  const invalidateOrderIds = []
  for (const order of list) {
    const previousOrder = previousOrders.find(item => item.id === order.id)
    if (previousOrder && shouldInvalidateStoreSettlementForOrderChange(previousOrder, order)) invalidateOrderIds.push(order.id)
    const orderParams = {
      ...mysqlOrderParams(order),
      originalImageUrlsJson: JSON.stringify(order.originalImageUrls || []),
      afterSalesImagesJson: JSON.stringify(order.afterSalesImages || []),
      userLatitude: order.userLatitude === "" ? null : order.userLatitude,
      userLongitude: order.userLongitude === "" ? null : order.userLongitude,
      pickupDistance: order.pickupDistance === "" ? null : order.pickupDistance
    }
    await query(
      `INSERT INTO orders (id, product_id, customer_name, phone, product_name, amount, status, payment_status, transaction_id, openid, user_id, user_token, address, custom_request, original_image_url, original_image_urls, ai_preview_url, final_design_url, category, is_custom_order, remark, inviter_code, shipping_company, tracking_number, shipped_at, refund_type, refund_status, refund_reason, refund_amount, refund_remark, refund_image_url, refund_reject_reason, refund_reviewed_at, after_sales_status, after_sales_type, after_sales_reason, after_sales_desc, after_sales_images, after_sales_requested_at, after_sales_handled_at, after_sales_reject_reason, after_sales_apply_count, refund_no, refund_id, refund_success_at, created_at, paid_at, completed_at, refund_at, delivery_type, pickup_store_id, pickup_code, pickup_qrcode_url, pickup_status, notify_status, notified_at, arrived_store_at, picked_up_at, pickup_verified_at, pickup_verified_by, user_latitude, user_longitude, pickup_distance, referrer_store_id, source_type, source_store_id, source_store_code, store_order_type, is_store_member_order, store_operator_user_id, store_operator_phone, store_operator_openid, store_operator_role, store_operator_name, referrer_user_id, parent_referrer_user_id, supplier_store_id, referral_commission, pickup_service_fee, supplier_settlement_amount, custom_commission_amount, store_settlement_status)
       VALUES (:id, :productId, :customerName, :phone, :productName, :amount, :status, :paymentStatus, :transactionId, :openid, :userId, :userToken, :address, :customRequest, :originalImageUrl, :originalImageUrlsJson, :aiPreviewUrl, :finalDesignUrl, :category, :isCustomOrder, :remark, :inviterCode, :shippingCompany, :trackingNumber, :shippedAt, :refundType, :refundStatus, :refundReason, :refundAmount, :refundRemark, :refundImageUrl, :refundRejectReason, :refundReviewedAt, :afterSalesStatus, :afterSalesType, :afterSalesReason, :afterSalesDesc, :afterSalesImagesJson, :afterSalesRequestedAt, :afterSalesHandledAt, :afterSalesRejectReason, :afterSalesApplyCount, :refundNo, :refundId, :refundSuccessAt, :createdAt, :paidAt, :completedAt, :refundAt, :deliveryType, :pickupStoreId, :pickupCode, :pickupQrCodeUrl, :pickupStatus, :notifyStatus, :notifiedAt, :arrivedStoreAt, :pickedUpAt, :pickupVerifiedAt, :pickupVerifiedBy, :userLatitude, :userLongitude, :pickupDistance, :referrerStoreId, :sourceType, :sourceStoreId, :sourceStoreCode, :storeOrderType, :isStoreMemberOrder, :storeOperatorUserId, :storeOperatorPhone, :storeOperatorOpenid, :storeOperatorRole, :storeOperatorName, :referrerUserId, :parentReferrerUserId, :supplierStoreId, :referralCommission, :pickupServiceFee, :supplierSettlementAmount, :customCommissionAmount, :storeSettlementStatus)
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
  if (!storeId || !isStoreReferrerWindowValid(data)) return ""
  const store = await getPartnerStore(storeId || "")
  return isValidReferrerStore(store) ? store.id : ""
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
  const direct = relations.find(relation => normalizePhone(relation.inviteePhone) === buyerPhone)
  if (!direct) return { referrerUserId: "", parentReferrerUserId: "" }
  const parent = relations.find(relation => normalizePhone(relation.inviteePhone) === normalizePhone(direct.inviterPhone))
  return {
    referrerUserId: normalizePhone(direct.inviterPhone),
    parentReferrerUserId: parent ? normalizePhone(parent.inviterPhone) : ""
  }
}

async function createStoreSettlementRecordsForOrder(order) {
  const existing = await getStoreSettlementRecords()
  if (!isOrderPaidForPickupCredential(order) || isOrderRefunded(order)) return existing.filter(record => record.orderId === order.id)
  const next = [...existing]
  const referrerStore = await getPartnerStore(order.referrerStoreId)
  const pickupStore = await getPartnerStore(order.pickupStoreId)
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
  const pickupAmount = pickupStore && Number(order.pickupServiceFee || 0) <= 0
    ? calculatePickupServiceFee(order.amount, pickupStore.pickupFeeType, pickupStore.pickupFeeValue)
    : money(order.pickupServiceFee || 0)
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
      status: order.storeSettlementStatus || "unsettled",
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
      status: order.storeSettlementStatus || "unsettled",
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
  const [stores, orders, records] = await Promise.all([
    getPartnerStores(),
    getOrders(),
    getStoreSettlementRecords(filters)
  ])
  const targetStores = filters.storeId ? stores.filter(store => store.id === filters.storeId) : stores
  const summary = targetStores.map(store => {
    const storeRecords = records.filter(record => record.storeId === store.id)
    const activeStoreRecords = storeRecords.filter(record => record.status !== "cancelled")
    const settlementSummary = buildSettlementSummary(activeStoreRecords)
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
  return { summary, totals: buildSettlementSummary(records.filter(record => record.status !== "cancelled")), records }
}

async function getStoreSession(req) {
  const token = String(req.headers["x-user-session"] || req.headers["x-user-token"] || "").trim()
  const session = getUserSession(token)
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
    const allMembers = await getStoreMembers()
    const index = allMembers.findIndex(item => item.id === member.id)
    if (index >= 0) {
      allMembers[index] = { ...allMembers[index], openid: session.openid, updatedAt: formatDateTime(new Date()) }
      await saveStoreMembers(allMembers)
    }
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

function storeOrderView(order, mode = "referral") {
  const showPickupCode = canShowPickupCodeForOrder(order)
  const notifyBlockedReason = pickupArrivedBlockedReason(order, order.pickupStoreId)
  return {
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
  const validRecords = records.filter(record => !record.orderId || paidOrderIds.has(record.orderId))
  const settlementSummary = buildSettlementSummary(validRecords.filter(record => record.status !== "cancelled"))
  return {
    todayReferralOrders: referralOrders.filter(order => String(order.createdAt || "").startsWith(today)).length,
    monthReferralOrders: referralOrders.filter(order => String(order.createdAt || "").startsWith(month)).length,
    todayPickupOrders: pickupOrders.filter(order => String(order.createdAt || "").startsWith(today)).length,
    pendingPickupOrders: pickupOrders.filter(order => order.pickupStatus !== "picked_up").length,
    ...settlementSummary
  }
}

async function verifyStorePickupOrder(store, orderId, pickupCode) {
  const orders = await getOrders()
  const order = orders.find(item => item.id === orderId)
  if (!order) throw httpError(404, "订单不存在")
  if (order.pickupStoreId !== store.id) throw httpError(403, "不能核销其他门店订单")
  if (!isOrderPaidForPickupCredential(order)) throw httpError(400, "订单未支付，暂不能核销")
  if (!isPickupOrder(order)) throw httpError(400, "该订单不是到店自提订单")
  if (isOrderBlockedForStoreVerify(order)) throw httpError(400, "订单售后或退款处理中，暂不能核销")
  if (order.pickupStatus === "picked_up") throw httpError(400, "该订单已核销")
  if (!pickupCode || normalizePickupCode(order.pickupCode) !== normalizePickupCode(pickupCode)) throw httpError(400, "取货码不正确")
  const verifiedAt = formatDateTime(new Date())
  order.pickupStatus = "picked_up"
  order.status = "已完成"
  order.pickedUpAt = verifiedAt
  order.pickupVerifiedAt = verifiedAt
  order.pickupVerifiedBy = store.id
  order.completedAt = order.completedAt || order.pickedUpAt
  await saveOrders([order])
  await createStoreSettlementRecordsForOrder(order)
  return storeOrderView(order, "pickup")
}

async function verifyStorePickupByCode(store, pickupCode) {
  const code = normalizePickupCode(pickupCode)
  if (!code || code.length !== 6) throw httpError(400, "请输入6位取货码")
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
  const verifiedAt = formatDateTime(new Date())
  order.pickupStatus = "picked_up"
  order.status = "已完成"
  order.pickedUpAt = verifiedAt
  order.pickupVerifiedAt = verifiedAt
  order.pickupVerifiedBy = store.id
  order.completedAt = order.completedAt || verifiedAt
  await saveOrders([order])
  await createStoreSettlementRecordsForOrder(order)
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
      return { product: found, quantity: Math.max(1, Number(item.quantity || 1)) }
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
  const productType = String(data.productType || data.orderType || product.productType || "").toLowerCase() === "normal" ? "normal" : "custom"
  const quantity = Math.max(1, Math.floor(Number(data.quantity || 1)))
  const isQuoteOrder = String(data.needQuote || product.needQuote || product.need_quote || "").toLowerCase() === "true" ||
    String(data.priceMode || product.priceMode || product.price_mode || "").toLowerCase() === "quote" ||
    (String(data.isCustomOrder || "false") === "true" && Number(product.price || 0) <= 0)
  const orderAmount = isQuoteOrder ? "0.00" : money(Number(product.price || 0) * (cartItems.length ? 1 : quantity))
  const deliveryType = data.deliveryType === "pickup" ? "pickup" : "delivery"
  let pickupStore = null
  if (deliveryType === "pickup") {
    pickupStore = await getPartnerStore(data.pickupStoreId)
    if (!pickupStore || !isStoreEnabled(pickupStore) || pickupStore.isPickupEnabled !== "true") throw new Error("请选择有效的自提门店")
  }
  const referrerStoreId = await resolveValidReferrerStoreId(data.referrerStoreId || data.sourceStoreId || data.storeId || data.referrer_store_id || "", data)
  const storeOrderSource = await resolveStoreOrderSource(referrerStoreId, data)
  const personalAttribution = referrerStoreId
    ? { referrerUserId: "", parentReferrerUserId: "" }
    : await resolvePersonalOrderAttribution(data.phone)
  if (referrerStoreId) console.log("[promotion-reward] skipped for store source order", { storeId: referrerStoreId, orderSource: storeOrderSource.storeOrderType })
  const income = await calculateOrderStoreIncome({ ...data, deliveryType, referrerStoreId, pickupStoreId: pickupStore?.id || "" }, orderAmount)
  const pickupCode = deliveryType === "pickup" ? await generateUniquePickupCode() : ""
  const pickupQrCodeUrl = pickupCode ? await generatePickupQrCode(pickupCode) : ""
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
    customRequest: productType === "normal" ? (data.customRequest || "") : data.customRequest,
    originalImageUrl: data.originalImageUrl || "",
    originalImageUrls: normalizeMediaList(data.originalImageUrls || data.originalImageUrl || ""),
    aiPreviewUrl: data.aiPreviewUrl || "",
    finalDesignUrl: data.finalDesignUrl || data.aiPreviewUrl || "",
    category: data.category || (Array.isArray(product.categories) ? product.categories[0] : "") || "",
    isCustomOrder: productType === "normal" ? "false" : (String(data.isCustomOrder || "false") === "true" ? "true" : "false"),
    openid: data.openid || "",
    userId: data.userId || "",
    userToken: data.userToken || "",
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
    ...storeOrderSource,
    referrerUserId: personalAttribution.referrerUserId,
    parentReferrerUserId: personalAttribution.parentReferrerUserId,
    supplierStoreId: data.supplierStoreId || "",
    referralCommission: income.referralCommission,
    pickupServiceFee: income.pickupServiceFee,
    supplierSettlementAmount: "0.00",
    customCommissionAmount: "0.00",
    storeSettlementStatus: "unsettled"
  }, 0)
  await ensureCustomerFromOrder(order)
  if (!order.referrerStoreId) await bindPromotionFromOrder(order)
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
    "INSERT INTO orders (id, product_id, customer_name, phone, product_name, amount, status, payment_status, transaction_id, openid, user_id, user_token, address, custom_request, original_image_url, original_image_urls, ai_preview_url, final_design_url, category, is_custom_order, remark, inviter_code, created_at, delivery_type, pickup_store_id, pickup_code, pickup_qrcode_url, pickup_status, user_latitude, user_longitude, pickup_distance, referrer_store_id, source_type, source_store_id, source_store_code, store_order_type, is_store_member_order, store_operator_user_id, store_operator_phone, store_operator_openid, store_operator_role, store_operator_name, referrer_user_id, parent_referrer_user_id, supplier_store_id, referral_commission, pickup_service_fee, supplier_settlement_amount, custom_commission_amount, store_settlement_status) VALUES (:id, :productId, :customerName, :phone, :productName, :amount, :status, :paymentStatus, :transactionId, :openid, :userId, :userToken, :address, :customRequest, :originalImageUrl, :originalImageUrlsJson, :aiPreviewUrl, :finalDesignUrl, :category, :isCustomOrder, :remark, :inviterCode, :createdAt, :deliveryType, :pickupStoreId, :pickupCode, :pickupQrCodeUrl, :pickupStatus, :userLatitude, :userLongitude, :pickupDistance, :referrerStoreId, :sourceType, :sourceStoreId, :sourceStoreCode, :storeOrderType, :isStoreMemberOrder, :storeOperatorUserId, :storeOperatorPhone, :storeOperatorOpenid, :storeOperatorRole, :storeOperatorName, :referrerUserId, :parentReferrerUserId, :supplierStoreId, :referralCommission, :pickupServiceFee, :supplierSettlementAmount, :customCommissionAmount, :storeSettlementStatus)",
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

async function backfillOrderIdentity(orderId, identity = {}) {
  if (!orderId) return
  const openid = String(identity.openid || "").trim()
  const userToken = String(identity.userToken || identity.userSession || "").trim()
  if (!openid && !userToken) return
  if (!pool) {
    const orders = readJsonFile(ordersFile, []).map(normalizeOrder)
    const index = orders.findIndex(order => order.id === orderId)
    if (index >= 0) {
      if (!orders[index].openid && openid) orders[index].openid = openid
      if (!orders[index].userToken && userToken) orders[index].userToken = userToken
      writeJsonFile(ordersFile, orders)
    }
    return
  }
  await query(
    `UPDATE orders
     SET
       openid = CASE WHEN (openid IS NULL OR openid = '') THEN :openid ELSE openid END,
       user_token = CASE WHEN (user_token IS NULL OR user_token = '') THEN :userToken ELSE user_token END
     WHERE id = :orderId`,
    { orderId, openid, userToken }
  )
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
      if (orders[index].deliveryType === "pickup" && !orders[index].pickupCode) {
        orders[index].pickupCode = await generateUniquePickupCode()
        orders[index].pickupQrCodeUrl = await generatePickupQrCode(orders[index].pickupCode)
      }
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
    if (order.deliveryType === "pickup" && (!order.pickupCode || !order.pickupQrCodeUrl)) {
      order.pickupCode = order.pickupCode || await generateUniquePickupCode()
      order.pickupQrCodeUrl = order.pickupQrCodeUrl || await generatePickupQrCode(order.pickupCode)
      await saveOrders([order])
    }
    await createRewardsForOrder(order)
    await createStoreSettlementRecordsForOrder(order)
  }
  return true
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
  return orders[index]
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
  const notice = await sendPickupArrivedNotice(orderId)
  orders[index].notifyStatus = notice.ok && !notice.skipped ? "sent" : "failed"
  await saveOrders([orders[index]])
  return orders[index]
}

async function markOrderPickedUp(orderId) {
  const orders = await getOrders()
  const index = orders.findIndex(order => order.id === orderId)
  if (index < 0) throw new Error("订单不存在")
  if (orders[index].deliveryType !== "pickup") throw new Error("该订单不是到店自提订单")
  if (!isOrderPaidForPickupCredential(orders[index])) throw new Error("订单未支付，暂不能标记已自提")
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
  if (!orderBelongsToIdentity(orders[index], data)) throw new Error("无权操作该订单")
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

function generateRefundNo(orderId) {
  const clean = String(orderId || "").replace(/[^\w]/g, "")
  const digest = crypto.createHash("sha256").update(String(orderId || "")).digest("hex").slice(0, 24).toUpperCase()
  return `RF${clean.slice(0, 18)}${digest}`.slice(0, 64)
}

async function markRefundSuccess(order, refundData = {}) {
  const orders = await getOrders()
  const index = orders.findIndex(item => item.id === order.id)
  if (index < 0) throw new Error("订单不存在")
  const now = formatDateTime(new Date())
  orders[index] = {
    ...orders[index],
    status: "已退款",
    paymentStatus: "已退款",
    refundStatus: "退款成功",
    afterSalesStatus: "refunded",
    refundId: refundData.refund_id || refundData.refundId || orders[index].refundId || "",
    refundSuccessAt: now,
    refundAt: now,
    afterSalesHandledAt: orders[index].afterSalesHandledAt || now
  }
  await saveOrders([orders[index]])
  await rollbackRewardsForOrder(order.id)
  await invalidateStoreSettlementRecordsForOrder(order.id)
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
  const amount = Math.min(Number(data.refundAmount || order.refundAmount || order.amount || 0), Number(order.amount || 0))
  if (!amount || amount <= 0) throw new Error("退款金额不正确")
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

async function rollbackRewardsForOrder(orderId) {
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

async function invalidateStoreSettlementRecordsForOrder(orderId) {
  const records = await getStoreSettlementRecords()
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
    if (strict) throw httpError(400, "不能绑定自己的邀请码")
    return null
  }
  const relations = await getPromotionRelations()
  const existing = relations.find(relation => normalizePhone(relation.inviteePhone) === inviteePhone)
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
  await query("DELETE FROM reward_records")
  for (const record of list) {
    await query(
      "INSERT INTO reward_records (id, order_id, product_name, buyer_phone, promoter_phone, promoter_name, level, amount, type, status, release_at, settled_at, settled_by, settle_note, cancel_reason, batch_id, created_at, updated_at) VALUES (:id, :orderId, :productName, :buyerPhone, :promoterPhone, :promoterName, :level, :amount, :type, :status, :releaseAt, :settledAt, :settledBy, :settleNote, :cancelReason, :batchId, :createdAt, :updatedAt)",
      {
        ...record,
        releaseAt: toMysqlDatetime(record.releaseAt),
        settledAt: toMysqlDatetime(record.settledAt),
        createdAt: toMysqlDatetime(record.createdAt, nowMysqlDatetime()),
        updatedAt: toMysqlDatetime(record.updatedAt, nowMysqlDatetime())
      }
    )
  }
  return list
}

async function createRewardsForOrder(order) {
  const normalized = normalizeOrder(order, 0)
  if (!isOrderPaidForPickupCredential(normalized) || isOrderRefunded(normalized)) return []
  if (normalized.referrerStoreId) return await getRewardRecords()
  const existing = await getRewardRecords()
  const relations = await getPromotionRelations()
  const customers = await getCustomers()
  const buyerPhone = normalizePhone(normalized.phone)
  const directPhone = normalizePhone(normalized.referrerUserId) ||
    normalizePhone((relations.find(relation => normalizePhone(relation.inviteePhone) === buyerPhone) || {}).inviterPhone)
  if (!directPhone) return existing
  const parentPhone = normalizePhone(normalized.parentReferrerUserId) ||
    normalizePhone((relations.find(relation => normalizePhone(relation.inviteePhone) === directPhone) || {}).inviterPhone)
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
      status: "unsettled",
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
  if (Number(firstRewardAmount) > 0 && !hasReward(directPhone, 1)) next.unshift(makeRecord(directPhone, 1, firstRewardAmount))
  if (parentPhone && Number(secondRewardAmount) > 0 && !hasReward(parentPhone, 2)) next.unshift(makeRecord(parentPhone, 2, secondRewardAmount))
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
      await createStoreSettlementRecordsForOrder(order)
      storeOrdersChecked += 1
    }
    if (!order.referrerStoreId && (order.referrerUserId || order.parentReferrerUserId || order.inviterCode)) {
      await createRewardsForOrder(order)
      personalOrdersChecked += 1
    }
  }
  console.log("[referral-settlement-backfill]", {
    paidStoreReferralOrdersChecked: storeOrdersChecked,
    paidPersonalReferralOrdersChecked: personalOrdersChecked,
    refundedOrdersInvalidated: invalidatedOrders
  })
}

async function processRewardState() {
  const orders = await getOrders()
  const records = await getRewardRecords()
  let changed = false
  const now = new Date()
  for (const record of records) {
    const order = orders.find(item => item.id === record.orderId)
    if (!order) continue
    const refunded = order.status === "已退款" || order.paymentStatus === "已退款" || order.afterSalesStatus === "refunded"
    if (refunded && record.status !== "cancelled") {
      record.status = "cancelled"
      record.cancelReason = record.cancelReason || "订单已退款，推广奖励失效"
      record.updatedAt = formatDateTime(now)
      changed = true
      continue
    }
    if (record.status === "unsettled" && order.status === "已完成") {
      if (!record.releaseAt) {
        record.releaseAt = addDays(order.completedAt || now, 7)
        record.updatedAt = formatDateTime(now)
        changed = true
      }
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
  const myRewards = records.filter(item => normalizePhone(item.promoterPhone) === phone)
  const rewardSummary = buildSettlementSummary(myRewards.filter(item => item.status !== "cancelled"))
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
    rewards: myRewards.map(item => ({ ...item, statusText: rewardStatusText(item.status) })),
    orders: rewardOrders
  }
}

async function getSettings() {
  const normalize = settings => {
    const categoryCatalog = updateActiveCategoryTree(settings.categoryCatalog)
    return {
      ...settings,
      categoryCatalog,
      ...normalizeThemeSettings(settings),
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
    status VARCHAR(20) DEFAULT 'unsettled',
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
  await ensureColumn("reward_records", "type", "VARCHAR(40) DEFAULT 'level1'")
  await ensureColumn("reward_records", "settled_at", "DATETIME")
  await ensureColumn("reward_records", "settled_by", "VARCHAR(80)")
  await ensureColumn("reward_records", "settle_note", "TEXT")
  await ensureColumn("reward_records", "cancel_reason", "TEXT")
  await ensureColumn("reward_records", "batch_id", "VARCHAR(80)")
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
  await migrateProductCategoriesToCanonical()
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

async function generatePromotionWxacode(inviteCode) {
  const safeInvite = String(inviteCode || "").replace(/[^\w-]/g, "").slice(0, 24) || "VSCUSTOM"
  const outputFile = path.join(uploadsDir, `promotion-code-${safeInvite}-${BRAND_QR_LOGO_VERSION}.png`)
  if (fs.existsSync(outputFile)) {
    return { url: publicAssetUrl(`/uploads/${path.basename(outputFile)}`), cached: true, logoVersion: BRAND_QR_LOGO_VERSION }
  }
  const accessToken = await getAccessToken()
  const body = JSON.stringify({
    scene: `invite=${safeInvite}`,
    page: "pages/index/index",
    check_path: false,
    env_version: process.env.WECHAT_WXACODE_ENV_VERSION || "trial"
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
  return { url: publicAssetUrl(`/uploads/${path.basename(outputFile)}`), cached: false, logoVersion: BRAND_QR_LOGO_VERSION }
}

async function generateProductWxacode(productId, refCode = "") {
  const safeProductId = String(productId || "").replace(/[^\w-]/g, "").slice(0, 20)
  if (!safeProductId) throw httpError(400, "缺少商品ID")
  const safeRef = String(refCode || "").replace(/[^\w-]/g, "").slice(0, 10)
  const scene = safeWxacodeScene(`p=${safeProductId}${safeRef ? `&ref=${safeRef}` : ""}`, `p=${safeProductId}`)
  const cacheKey = `${safeProductId}${safeRef ? `-${safeRef}` : ""}`.replace(/[^\w-]/g, "").slice(0, 48)
  const outputFile = path.join(uploadsDir, `product-code-${cacheKey}-${BRAND_QR_LOGO_VERSION}.png`)
  if (fs.existsSync(outputFile)) {
    return {
      url: publicAssetUrl(`/uploads/${path.basename(outputFile)}`),
      cached: true,
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
    env_version: process.env.WECHAT_WXACODE_ENV_VERSION || "trial"
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
    scene,
    path: `/pages/product/detail?id=${encodeURIComponent(safeProductId)}${safeRef ? `&ref=${encodeURIComponent(safeRef)}` : ""}`,
    logoVersion: BRAND_QR_LOGO_VERSION
  }
}

async function generateStoreWxacode(store) {
  if (!store?.id) throw httpError(404, "门店不存在")
  if (!isStoreEnabled(store)) throw httpError(400, "门店已停用，暂不能生成二维码")
  const safeStoreId = String(store.id || "").replace(/[^\w-]/g, "").slice(0, 24)
  const outputFile = path.join(uploadsDir, `store-code-${safeStoreId}-${BRAND_QR_LOGO_VERSION}.png`)
  if (fs.existsSync(outputFile)) {
    return { url: publicAssetUrl(`/uploads/${path.basename(outputFile)}`), cached: true, scene: `store_id=${safeStoreId}`, logoVersion: BRAND_QR_LOGO_VERSION }
  }
  const accessToken = await getAccessToken()
  const body = JSON.stringify({
    scene: safeWxacodeScene(`store_id=${safeStoreId}`, `store_id=${safeStoreId}`),
    page: "pages/index/index",
    check_path: false,
    env_version: process.env.WECHAT_WXACODE_ENV_VERSION || "trial"
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
  return { url: publicAssetUrl(`/uploads/${path.basename(outputFile)}`), cached: false, scene: `store_id=${safeStoreId}`, logoVersion: BRAND_QR_LOGO_VERSION }
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
  const sessionPhone = String(identity.phone || "").trim()
  const orderOpenid = String(order.openid || "").trim()
  const orderUserToken = String(order.userToken || "").trim()
  const orderPhone = String(order.phone || "").trim()
  const phoneMatched = !!(sessionPhone && orderPhone && sessionPhone === orderPhone)
  const openidMatched = !!(orderOpenid && sessionOpenid && orderOpenid === sessionOpenid)
  const tokenMatched = !!(orderUserToken && sessionUserToken && orderUserToken === sessionUserToken)
  if (!orderOpenid && !orderUserToken && !orderPhone) {
    console.warn(`[pay] reject empty owner order=${order.id} sessionOpenid=${maskSecret(sessionOpenid)} sessionToken=${maskSecret(sessionUserToken)} sessionPhone=${maskPhone(sessionPhone)}`)
    throw httpError(403, "订单缺少用户身份，请联系商家处理")
  }
  if (!openidMatched && !tokenMatched && !phoneMatched) {
    console.warn(`[pay] reject owner mismatch order=${order.id} orderOpenid=${maskSecret(orderOpenid)} sessionOpenid=${maskSecret(sessionOpenid)} orderToken=${maskSecret(orderUserToken)} sessionToken=${maskSecret(sessionUserToken)} orderPhone=${maskPhone(orderPhone)} sessionPhone=${maskPhone(sessionPhone)}`)
    throw httpError(403, "无权支付该订单")
  }
  if (phoneMatched && (orderOpenid && sessionOpenid && orderOpenid !== sessionOpenid || orderUserToken && sessionUserToken && orderUserToken !== sessionUserToken)) {
    console.warn(`[pay] allow phone matched historical order=${order.id} orderPhone=${maskPhone(orderPhone)} openidChanged=${!!(orderOpenid && sessionOpenid && orderOpenid !== sessionOpenid)} tokenChanged=${!!(orderUserToken && sessionUserToken && orderUserToken !== sessionUserToken)}`)
  }
  if ((!orderOpenid || !orderUserToken) && (phoneMatched || tokenMatched || openidMatched)) {
    await backfillOrderIdentity(order.id, identity)
    if (!order.openid && sessionOpenid) order.openid = sessionOpenid
    if (!order.userToken && sessionUserToken) order.userToken = sessionUserToken
    console.log(`[pay] backfilled missing identity order=${order.id} openid=${maskSecret(order.openid)} token=${maskSecret(order.userToken)} phone=${maskPhone(orderPhone)}`)
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
  if (!order.refundNo) return { order, refund: null }
  const refund = await queryWechatRefundByNo(order.refundNo)
  const status = refund.status || refund.refund_status || ""
  if (status === "SUCCESS") {
    return { order: await markRefundSuccess(order, refund), refund }
  }
  if (status === "ABNORMAL" || status === "CLOSED") {
    const orders = await getOrders()
    const index = orders.findIndex(item => item.id === order.id)
    if (index >= 0) {
      orders[index] = { ...orders[index], refundStatus: "退款失败", afterSalesStatus: "approved" }
      await saveOrders([orders[index]])
      return { order: orders[index], refund }
    }
  }
  return { order, refund }
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
    const records = (await getStoreSettlementRecords({ storeId: storeSession.store.id, type: "store_referral_commission" }))
      .filter(record => !record.orderId || paidOrderIds.has(record.orderId))
    const commissionSummary = buildSettlementSummary(records.filter(record => record.status !== "cancelled"))
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
      orders: orders.map(order => storeOrderView(order, "referral"))
    })
    return
  }

  if (url.pathname === "/api/store/pickup-orders" && req.method === "GET") {
    const storeSession = await requireStorePermission(req, res, "pickup.view")
    if (!storeSession) return
    const orders = (await getOrders()).filter(order => order.pickupStoreId === storeSession.store.id && isPickupOrder(order) && isOrderPaidForPickupCredential(order))
    sendJson(res, 200, { storeInfo: storePrivateView(storeSession.store), orders: orders.map(order => storeOrderView(order, "pickup")) })
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
    const paidOrderIds = new Set((await getOrders()).filter(order => isOrderPaidForPickupCredential(order) && !isOrderRefunded(order)).map(order => order.id))
    const records = (await getStoreSettlementRecords({ storeId: storeSession.store.id }))
      .filter(record => !record.orderId || paidOrderIds.has(record.orderId))
    const activeRecords = records.filter(record => record.status !== "cancelled")
    const settlementSummary = buildSettlementSummary(activeRecords)
    const referral = activeRecords.filter(record => isStoreReferralSettlement(record.type)).reduce((sum, record) => sum + Number(record.amount || 0), 0)
    const pickup = activeRecords.filter(record => isPickupServiceSettlement(record.type)).reduce((sum, record) => sum + Number(record.amount || 0), 0)
    sendJson(res, 200, {
      storeInfo: storePrivateView(storeSession.store),
      summary: { ...settlementSummary, referralAmount: money(referral), pickupAmount: money(pickup) },
      records: records.map(record => ({ ...record, statusText: settlementStatusText(record.status), typeText: isStoreReferralSettlement(record.type) ? "门店推广佣金" : isPickupServiceSettlement(record.type) ? "自提服务费" : record.type === "adjustment" ? "手动调整" : record.type === "chargeback" ? "退款冲正" : record.type }))
    })
    return
  }

  if (url.pathname.match(/^\/api\/store\/orders\/[^/]+\/verify-pickup$/) && req.method === "POST") {
    const storeSession = await requireStorePermission(req, res, "pickup.verify")
    if (!storeSession) return
    const orderId = decodeURIComponent(url.pathname.split("/")[4])
    const body = JSON.parse((await readBody(req)).toString() || "{}")
    sendJson(res, 200, { ok: true, data: await verifyStorePickupOrder(storeSession.store, orderId, body.pickupCode) })
    return
  }

  if (url.pathname === "/api/store/verify" && req.method === "POST") {
    const storeSession = await requireStorePermission(req, res, "pickup.verify")
    if (!storeSession) return
    const body = JSON.parse((await readBody(req)).toString() || "{}")
    sendJson(res, 200, await verifyStorePickupByCode(storeSession.store, body.pickupCode || body.code))
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

  if (url.pathname.match(/^\/api\/orders\/[^/]+\/after-sales\/apply$/) && req.method === "POST") {
    const body = JSON.parse((await readBody(req)).toString() || "{}")
    const identity = identityFromRequest(req, body)
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
    const order = (await getOrders()).find(item => item.refundNo === refundNo)
    if (order && (resource.refund_status === "SUCCESS" || resource.status === "SUCCESS")) {
      await markRefundSuccess(order, resource)
    }
    sendJson(res, 200, { code: "SUCCESS", message: "成功" })
    return
  }

  if (url.pathname === "/api/promotion/summary" && req.method === "GET") {
    const identity = identityFromRequest(req, Object.fromEntries(url.searchParams.entries()))
    if (!identity.phone) throw httpError(401, "请先完成手机号快捷登录")
    sendJson(res, 200, await getPromotionSummary(identity.phone))
    return
  }

  if (url.pathname === "/api/promotion/stats" && req.method === "GET") {
    const identity = identityFromRequest(req, Object.fromEntries(url.searchParams.entries()))
    if (!identity.phone) throw httpError(401, "请先完成手机号快捷登录")
    const summary = await getPromotionSummary(identity.phone)
    sendJson(res, 200, { ok: true, data: summary.profile, profile: summary.profile })
    return
  }

  if (url.pathname === "/api/promotion/orders" && req.method === "GET") {
    const identity = identityFromRequest(req, Object.fromEntries(url.searchParams.entries()))
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
    const records = await getStoreSettlementRecords()
    const now = formatDateTime(new Date())
    records.forEach(record => {
      if (ids.includes(record.id) && record.status === "unsettled") {
        record.status = "settled"
        record.settledAt = now
        record.settledBy = "admin"
        record.settleNote = body.note || record.settleNote || "后台批量标记已结算"
        record.updatedAt = now
      }
    })
    await saveStoreSettlementRecords(records)
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
    const records = await getStoreSettlementRecords()
    const record = records.find(item => item.id === decodeURIComponent(id))
    if (!record) throw httpError(404, "收益记录不存在")
    if (action === "settle") {
      if (record.status === "settled") throw httpError(400, "该记录已结算，请勿重复操作。")
      if (record.status === "cancelled") throw httpError(400, "该记录已取消，不能结算。")
      record.status = "settled"
      record.settledAt = formatDateTime(new Date())
      record.settledBy = "admin"
      record.settleNote = body.note || body.settleNote || ""
    } else {
      if (record.status === "cancelled") throw httpError(400, "该记录已取消。")
      record.status = "cancelled"
      record.cancelReason = body.reason || body.cancelReason || "后台取消收益"
    }
    record.updatedAt = formatDateTime(new Date())
    await saveStoreSettlementRecords(records)
    sendJson(res, 200, { ok: true, data: record })
    return
  }

  if (url.pathname === "/api/admin/store-earnings/adjustment" && req.method === "POST") {
    const body = JSON.parse((await readBody(req)).toString() || "{}")
    const amount = money(body.amount)
    if (!body.storeId) throw httpError(400, "请选择门店")
    if (Number(amount) === 0) throw httpError(400, "调整金额不能为 0")
    const records = await getStoreSettlementRecords()
    const now = formatDateTime(new Date())
    records.unshift(normalizeSettlementRecord({
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
    }))
    await saveStoreSettlementRecords(records)
    sendJson(res, 200, { ok: true })
    return
  }

  if (url.pathname === "/api/admin/store-earnings/batch-settle" && req.method === "POST") {
    const body = JSON.parse((await readBody(req)).toString() || "{}")
    const batchId = `BATCH${Date.now()}${crypto.randomBytes(2).toString("hex").toUpperCase()}`
    const records = await getStoreSettlementRecords({
      storeId: body.storeId || "",
      status: "unsettled",
      type: body.type || "",
      startAt: body.startAt || "",
      endAt: body.endAt || ""
    })
    const allRecords = await getStoreSettlementRecords()
    const ids = new Set(records.map(item => item.id))
    const now = formatDateTime(new Date())
    let count = 0
    allRecords.forEach(record => {
      if (!ids.has(record.id) || record.status !== "unsettled") return
      record.status = "settled"
      record.settledAt = now
      record.settledBy = "admin"
      record.settleNote = body.note || "后台批量结算"
      record.batchId = batchId
      record.updatedAt = now
      count += 1
    })
    await saveStoreSettlementRecords(allRecords)
    sendJson(res, 200, { ok: true, batchId, recordCount: count })
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

  if (url.pathname === "/api/admin/rewards" && req.method === "GET") {
    let records = await processRewardState()
    const status = url.searchParams.get("status") || ""
    const keyword = String(url.searchParams.get("keyword") || "").toLowerCase()
    if (status === "chargeback") records = records.filter(record => record.status === "unsettled" && Number(record.amount || 0) < 0)
    else if (status) records = records.filter(record => record.status === status)
    if (keyword) {
      records = records.filter(record => [record.id, record.orderId, record.productName, record.buyerPhone, record.promoterPhone, record.promoterName].some(value => String(value || "").toLowerCase().includes(keyword)))
    }
    sendJson(res, 200, {
      ok: true,
      summary: {
        ...buildSettlementSummary(records.filter(record => record.status !== "cancelled")),
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
      record.status = "settled"
      record.settledAt = formatDateTime(new Date())
      record.settledBy = "admin"
      record.settleNote = body.note || body.settleNote || ""
    } else {
      if (record.status === "cancelled") throw httpError(400, "该记录已取消。")
      record.status = "cancelled"
      record.cancelReason = body.reason || body.cancelReason || "后台取消奖励"
    }
    record.updatedAt = formatDateTime(new Date())
    await saveRewardRecords(records)
    sendJson(res, 200, { ok: true, data: normalizeRewardRecord(record, 0) })
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
    const records = await getRewardRecords()
    const now = formatDateTime(new Date())
    records.unshift(normalizeRewardRecord({
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
    }, records.length))
    await saveRewardRecords(records)
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

initDb().then(async () => {
  await ensureLegacyStoreMembers().catch(error => console.warn("门店成员兼容迁移失败：", error.message))
  await ensureReferralRewardRecords().catch(error => console.warn("推广收益补偿检查失败：", error.message))
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
