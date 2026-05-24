"use strict"

const now = () => new Date().toISOString()
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const DEFAULT_TIMEOUT_MS = 15000

const discoveryKeywords = ["桌面", "收纳", "钥匙扣", "摆件", "支架", "灯饰", "家居"]

const mockModels = [
  {
    source: "makerworld_mock",
    sourceModelId: "MW-DESK-KEYRING-001",
    sourceUrl: "https://makerworld.com/model/mock-desk-keyring-001",
    title: "桌面治愈按键挂件",
    authorName: "合作作者 A",
    authorUrl: "https://makerworld.com/@partner-a",
    category: "潮玩手办",
    tags: ["钥匙扣", "桌面", "礼物", "快速打印"],
    coverImage: "https://api.feichangjiandan.xyz/uploads/product-code-1-release-orange-v5-release.png",
    images: ["https://api.feichangjiandan.xyz/uploads/product-code-1-release-orange-v5-release.png"],
    downloadCount: 12800,
    likeCount: 920,
    collectCount: 1680,
    printCount: 560,
    printTimeMinutes: 95,
    filamentWeightG: 42,
    licenseType: "offline_cooperation",
    commercialStatus: "offline_authorized",
    authorizationType: "offline",
    authorizationParty: "非常智造线下合作渠道",
    authorizationNote: "合作渠道授权模型，用于后台选品与商品草稿生成。",
    syncedAt: now()
  },
  {
    source: "makerworld_mock",
    sourceModelId: "MW-STORAGE-BOX-002",
    sourceUrl: "https://makerworld.com/model/mock-storage-box-002",
    title: "模块化桌面收纳盒",
    authorName: "合作作者 B",
    authorUrl: "https://makerworld.com/@partner-b",
    category: "3D打印",
    tags: ["收纳", "桌面", "实用", "礼品"],
    coverImage: "https://api.feichangjiandan.xyz/uploads/product-code-1-release-orange-v5-release.png",
    images: ["https://api.feichangjiandan.xyz/uploads/product-code-1-release-orange-v5-release.png"],
    downloadCount: 8600,
    likeCount: 740,
    collectCount: 1310,
    printCount: 430,
    printTimeMinutes: 210,
    filamentWeightG: 128,
    licenseType: "offline_cooperation",
    commercialStatus: "offline_authorized",
    authorizationType: "offline",
    authorizationParty: "非常智造线下合作渠道",
    authorizationNote: "合作渠道授权模型，用于后台选品与商品草稿生成。",
    syncedAt: now()
  },
  {
    source: "makerworld_mock",
    sourceModelId: "MW-LAMP-003",
    sourceUrl: "https://makerworld.com/model/mock-lamp-003",
    title: "电影角色风格氛围灯",
    authorName: "合作作者 C",
    authorUrl: "https://makerworld.com/@partner-c",
    category: "3D打印",
    tags: ["灯饰", "角色", "氛围", "复杂"],
    coverImage: "https://api.feichangjiandan.xyz/uploads/product-code-1-release-orange-v5-release.png",
    images: ["https://api.feichangjiandan.xyz/uploads/product-code-1-release-orange-v5-release.png"],
    downloadCount: 15600,
    likeCount: 1880,
    collectCount: 2400,
    printCount: 690,
    printTimeMinutes: 420,
    filamentWeightG: 260,
    licenseType: "offline_cooperation",
    commercialStatus: "offline_authorized",
    authorizationType: "offline",
    authorizationParty: "非常智造线下合作渠道",
    authorizationNote: "含角色/影视等风险词，仅提示确认授权范围，不阻止生成草稿。",
    syncedAt: now()
  }
]

function mockDiscoveryModels(keywords = discoveryKeywords) {
  const seed = [
    ["桌面", "桌面数据线支架", "支架", 138, 64, 3200, 420, 180],
    ["收纳", "磁吸模块收纳托盘", "收纳", 225, 132, 5800, 760, 260],
    ["钥匙扣", "名字钥匙扣小挂件", "钥匙扣", 72, 28, 9100, 1180, 520],
    ["摆件", "桌面小恐龙摆件", "摆件", 185, 86, 7400, 880, 410],
    ["支架", "手机平板折叠支架", "支架", 158, 94, 6200, 690, 300],
    ["灯饰", "月球纹理小夜灯外壳", "灯饰", 260, 155, 4600, 540, 190],
    ["家居", "墙面挂钩组合件", "家居", 118, 58, 5100, 610, 230],
    ["桌面", "桌面耳机挂架", "支架", 0, 0, 2900, 360, 120],
    ["收纳", "抽屉分隔收纳格", "收纳", 198, 142, 3900, 510, 160]
  ]
  const wanted = new Set((Array.isArray(keywords) && keywords.length ? keywords : discoveryKeywords).map(item => String(item || "").trim()).filter(Boolean))
  return seed
    .filter(([keyword]) => !wanted.size || wanted.has(keyword) || [...wanted].some(item => keyword.includes(item) || item.includes(keyword)))
    .map(([keyword, title, tag, printTimeMinutes, filamentWeightG, downloadCount, collectCount, printCount], index) => ({
      source: "makerworld_discovery_mock",
      sourceModelId: `MW-DISC-${keyword}-${index + 1}`,
      sourceUrl: `https://makerworld.com/zh/models/mock-discovery-${encodeURIComponent(keyword)}-${index + 1}`,
      title,
      authorName: `合作发现作者 ${index + 1}`,
      authorUrl: `https://makerworld.com/@discover-${index + 1}`,
      category: ["收纳", "支架", "家居", "灯饰"].includes(tag) ? "3D打印" : "潮玩手办",
      tags: [keyword, tag, "自动发现", "授权渠道"],
      coverImage: "https://api.feichangjiandan.xyz/uploads/product-code-1-release-orange-v5-release.png",
      images: ["https://api.feichangjiandan.xyz/uploads/product-code-1-release-orange-v5-release.png"],
      downloadCount,
      likeCount: Math.round(collectCount * 0.7),
      collectCount,
      printCount,
      printTimeMinutes,
      filamentWeightG,
      licenseType: "offline_cooperation",
      commercialStatus: "offline_authorized",
      authorizationType: "offline",
      authorizationParty: "非常智造线下合作渠道",
      authorizationNote: "线下授权渠道导入，自动发现后需人工确认生产参数与售价。",
      productionStatus: printTimeMinutes && filamentWeightG ? "ready" : "needs_review",
      syncedAt: now()
    }))
}

async function fetchText(url, options = {}) {
  if (!url) return ""
  if (typeof fetch !== "function") return ""
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), Number(options.timeoutMs || DEFAULT_TIMEOUT_MS))
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "user-agent": "VerySmartModelPicker/1.0 (+authorized-channel-sync)",
        "accept": "text/html,application/json"
      }
    })
    if (!res.ok) throw new Error(`抓取失败 ${res.status}`)
    return await res.text()
  } finally {
    clearTimeout(timeout)
  }
}

function isPlaceholderUrl(value) {
  const text = String(value || "").trim()
  if (!text) return true
  if (text.includes("...") || text.includes("授权渠道页面") || text.includes("xxxx")) return true
  try {
    const parsed = new URL(text)
    if (!["http:", "https:"].includes(parsed.protocol)) return true
    if (!parsed.hostname || !parsed.hostname.includes(".")) return true
    return false
  } catch {
    return true
  }
}

function normalizeSourceUrls(urls = []) {
  return Array.from(new Set((Array.isArray(urls) ? urls : String(urls || "").split(/[,，\n]/))
    .map(item => String(item || "").trim())
    .filter(item => item && !isPlaceholderUrl(item))))
}

function textBetween(source, pattern) {
  const matched = String(source || "").match(pattern)
  return matched ? matched[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim() : ""
}

function absoluteUrl(url, baseUrl = "") {
  try { return new URL(url, baseUrl).toString() } catch { return String(url || "") }
}

function hashId(value) {
  return Buffer.from(String(value || `${Date.now()}`)).toString("hex").slice(0, 24).toUpperCase()
}

function numberFromText(value) {
  const text = String(value || "").replace(/,/g, "")
  const matched = text.match(/(\d+(?:\.\d+)?)(\s*[万kK])?/)
  if (!matched) return 0
  const raw = Number(matched[1] || 0)
  if (matched[2] && matched[2].includes("万")) return Math.round(raw * 10000)
  if (matched[2] && /k/i.test(matched[2])) return Math.round(raw * 1000)
  return Math.round(raw)
}

function inferCategory(title = "", tags = []) {
  const text = `${title} ${(tags || []).join(" ")}`
  if (/钥匙|挂件|摆件|手办|玩具|礼物/.test(text)) return "潮玩手办"
  return "3D打印"
}

function scoreModel(model = {}) {
  let score = 50
  const downloads = Number(model.downloadCount || 0)
  const collects = Number(model.collectCount || 0)
  const prints = Number(model.printCount || 0)
  const time = Number(model.printTimeMinutes || 0)
  const weight = Number(model.filamentWeightG || 0)
  const images = Array.isArray(model.images) ? model.images : Array.isArray(model.imagesJson) ? model.imagesJson : []
  const title = String(model.title || "")
  const tags = Array.isArray(model.tags) ? model.tags : []
  const goodKeywords = ["礼品", "桌面", "收纳", "钥匙扣", "摆件", "支架", "灯饰", "家居"]
  score += Math.min(20, Math.floor(downloads / 500))
  score += Math.min(10, Math.floor(collects / 150))
  score += Math.min(10, Math.floor(prints / 100))
  if (time > 0 && time <= 240) score += 10
  if (weight > 0 && weight <= 150) score += 10
  if (images.length > 1) score += 5
  if (goodKeywords.some(keyword => title.includes(keyword) || tags.some(tag => String(tag).includes(keyword)))) score += 10
  if (time > 240) score -= 20
  if (weight > 150) score -= 20
  if (!model.coverImage) score -= 30
  if (!time || !weight) score -= 10
  if (title.length < 3) score -= 10
  return Math.max(0, Math.min(100, Math.round(score)))
}

function normalizeModel(raw = {}) {
  const tags = Array.isArray(raw.tags) ? raw.tags.filter(Boolean) : []
  const images = Array.isArray(raw.images) ? raw.images.filter(Boolean) : []
  const sourceUrl = raw.sourceUrl || raw.source_url || ""
  const model = {
    source: raw.source || "makerworld_discovery",
    sourceModelId: String(raw.sourceModelId || raw.source_model_id || `URL-${hashId(sourceUrl)}`),
    sourceUrl,
    title: String(raw.title || "").trim(),
    authorName: raw.authorName || raw.author_name || "",
    authorUrl: raw.authorUrl || raw.author_url || "",
    category: raw.category || inferCategory(raw.title, tags),
    tags,
    coverImage: raw.coverImage || raw.cover_image || images[0] || "",
    images: images.length ? images : [raw.coverImage || raw.cover_image].filter(Boolean),
    downloadCount: Number(raw.downloadCount || raw.download_count || 0),
    likeCount: Number(raw.likeCount || raw.like_count || 0),
    collectCount: Number(raw.collectCount || raw.collect_count || 0),
    printCount: Number(raw.printCount || raw.print_count || 0),
    printTimeMinutes: Number(raw.printTimeMinutes || raw.print_time_minutes || 0),
    filamentWeightG: Number(raw.filamentWeightG || raw.filament_weight_g || 0),
    licenseType: raw.licenseType || raw.license_type || "offline_cooperation",
    commercialStatus: raw.commercialStatus || raw.commercial_status || "offline_authorized",
    authorizationType: raw.authorizationType || raw.authorization_type || "offline",
    authorizationParty: raw.authorizationParty || raw.authorization_party || "非常智造线下合作渠道",
    authorizationNote: raw.authorizationNote || raw.authorization_note || "线下授权渠道导入",
    productionStatus: raw.productionStatus || raw.production_status || (raw.printTimeMinutes && raw.filamentWeightG ? "ready" : "needs_review"),
    rawJson: raw.rawJson || raw,
    syncedAt: now()
  }
  model.score = raw.score == null ? scoreModel(model) : Number(raw.score || 0)
  return model
}

function parseModelsFromHtml(html, sourceUrl) {
  const text = String(html || "")
  const title = textBetween(text, /<title[^>]*>([\s\S]*?)<\/title>/i) || "授权渠道模型"
  const image = textBetween(text, /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ||
    textBetween(text, /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i)
  const description = textBetween(text, /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i)
  return [normalizeModel({
    source: "makerworld_web",
    sourceModelId: `WEB-${hashId(sourceUrl)}`,
    sourceUrl,
    title: title.replace(/\s*[-|].*$/, "") || "授权渠道模型",
    authorName: "",
    authorUrl: "",
    category: description.includes("收纳") ? "3D打印" : "潮玩手办",
    tags: ["网页抓取", "授权渠道", ...(description ? description.split(/[，, ]/).slice(0, 4) : [])],
    coverImage: image,
    images: image ? [image] : [],
    printTimeMinutes: 0,
    filamentWeightG: 0,
    authorizationNote: `从授权渠道页面抓取：${sourceUrl}`,
    rawHtmlTitle: title
  })]
}

function parseSearchCardsFromHtml(html, searchUrl, keyword = "") {
  const text = String(html || "")
  const cards = []
  const linkPattern = /<a[^>]+href=["']([^"']*(?:\/models\/|\/model\/)[^"']+)["'][^>]*>([\s\S]{0,1200}?)<\/a>/gi
  let matched
  while ((matched = linkPattern.exec(text)) && cards.length < 20) {
    const href = absoluteUrl(matched[1], searchUrl)
    const block = matched[2] || ""
    const title = textBetween(block, /(?:alt|title)=["']([^"']+)["']/i) || textBetween(block, /<h\d[^>]*>([\s\S]*?)<\/h\d>/i) || keyword || "MakerWorld 模型"
    const image = absoluteUrl(textBetween(block, /<img[^>]+src=["']([^"']+)["']/i), searchUrl)
    if (!href || cards.some(card => card.sourceUrl === href)) continue
    cards.push(normalizeModel({
      source: "makerworld_discovery_web",
      sourceModelId: `MW-WEB-${hashId(href)}`,
      sourceUrl: href,
      title,
      authorName: textBetween(block, /(?:author|designer)[^>]*>([\s\S]*?)<\//i),
      category: inferCategory(title, [keyword]),
      tags: [keyword, "自动发现"].filter(Boolean),
      coverImage: image,
      images: image ? [image] : [],
      downloadCount: numberFromText(block.match(/下载[^\d]*([\d,.万kK]+)/)?.[0] || ""),
      collectCount: numberFromText(block.match(/收藏[^\d]*([\d,.万kK]+)/)?.[0] || ""),
      printCount: numberFromText(block.match(/打印[^\d]*([\d,.万kK]+)/)?.[0] || ""),
      printTimeMinutes: 0,
      filamentWeightG: 0,
      authorizationNote: "公开搜索页低频发现，线下授权渠道导入，需人工复核生产参数。"
    }))
  }
  return cards
}

function makerworldSearchUrl(keyword, page = 1) {
  const q = encodeURIComponent(keyword)
  return `https://makerworld.com/zh/search/models?keyword=${q}&page=${page}`
}

async function fetchModelsFromUrls(urls = []) {
  const results = []
  const validUrls = normalizeSourceUrls(urls)
  if (!validUrls.length) return mockModels
  for (const url of validUrls) {
    try {
      const html = await fetchText(url)
      results.push(...parseModelsFromHtml(html, url))
    } catch (error) {
      results.push(normalizeModel({
        source: "makerworld_web",
        sourceModelId: `WEB-FAILED-${hashId(url)}`,
        sourceUrl: url,
        title: "授权渠道网页抓取失败",
        authorName: "",
        category: "潮玩手办",
        tags: ["抓取失败"],
        coverImage: "",
        images: [],
        authorizationNote: `网页抓取失败，请人工补充：${error.message}`,
        riskLevel: "high",
        riskReasons: ["网页抓取失败，需人工补充模型信息"]
      }))
    }
  }
  return results.length ? results : mockModels
}

async function searchModels(keyword, options = {}) {
  const useWeb = options.useWeb === true || String(process.env.MAKERWORLD_DISCOVERY_MODE || "").toLowerCase() === "web"
  if (!useWeb) return mockDiscoveryModels([keyword])
  const maxPages = Math.max(1, Math.min(Number(options.maxPages || 1), 3))
  const results = []
  for (let page = 1; page <= maxPages; page += 1) {
    const url = makerworldSearchUrl(keyword, page)
    try {
      const html = await fetchText(url, { timeoutMs: DEFAULT_TIMEOUT_MS })
      results.push(...parseSearchCardsFromHtml(html, url, keyword))
    } catch (error) {
      if (page === 1 && !results.length) return mockDiscoveryModels([keyword])
    }
    if (page < maxPages) await sleep(Number(options.delayMs || 1200))
  }
  return results.length ? results : mockDiscoveryModels([keyword])
}

async function fetchModelDetail(modelUrl) {
  if (!modelUrl || isPlaceholderUrl(modelUrl)) return null
  try {
    const html = await fetchText(modelUrl)
    return parseModelsFromHtml(html, modelUrl)[0] || null
  } catch {
    return null
  }
}

async function discoverModels(options = {}) {
  const keywords = (Array.isArray(options.keywords) ? options.keywords : String(options.keywords || "").split(/[\s,，\n]+/))
    .map(item => String(item || "").trim())
    .filter(Boolean)
  const selectedKeywords = (keywords.length ? keywords : discoveryKeywords).slice(0, 8)
  const limit = Math.max(1, Math.min(Number(options.limit || 30), 30))
  const maxPages = Math.max(1, Math.min(Number(options.maxPages || 3), 3))
  const byUrl = new Map()
  const mode = options.useWeb === true || String(process.env.MAKERWORLD_DISCOVERY_MODE || "").toLowerCase() === "web" ? "web_discovery" : "mock_discovery"
  for (const keyword of selectedKeywords) {
    const found = await searchModels(keyword, { ...options, maxPages })
    found.forEach(model => {
      const normalized = normalizeModel(model)
      if (normalized.sourceUrl && !byUrl.has(normalized.sourceUrl)) byUrl.set(normalized.sourceUrl, normalized)
    })
    if (byUrl.size >= limit) break
    await sleep(Number(options.delayMs || 1000))
  }
  return { ok: true, mode, found: byUrl.size, models: Array.from(byUrl.values()).slice(0, limit) }
}

async function fetchLatestModels() {
  return fetchPopularModels()
}

async function fetchPopularModels() {
  const urls = normalizeSourceUrls(process.env.MAKERWORLD_POPULAR_URLS || process.env.AUTHORIZED_MODEL_SOURCE_URLS || "")
  if (urls.length) {
    const webModels = await fetchModelsFromUrls(urls)
    if (webModels.length) return webModels
  }
  return mockModels
}

module.exports = {
  fetchLatestModels,
  fetchPopularModels,
  fetchModelDetail,
  fetchModelsFromUrls,
  discoverModels,
  searchModels,
  normalizeModel,
  scoreModel,
  normalizeSourceUrls
}
