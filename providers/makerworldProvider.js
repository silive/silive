"use strict"

const now = () => new Date().toISOString()

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

async function fetchText(url) {
  if (!url) return ""
  if (typeof fetch !== "function") return ""
  const res = await fetch(url, {
    headers: {
      "user-agent": "VerySmartModelPicker/1.0 (+authorized-channel-sync)",
      "accept": "text/html,application/json"
    }
  })
  if (!res.ok) throw new Error(`抓取失败 ${res.status}`)
  return res.text()
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

function parseModelsFromHtml(html, sourceUrl) {
  const text = String(html || "")
  const title = textBetween(text, /<title[^>]*>([\s\S]*?)<\/title>/i) || "授权渠道模型"
  const image = textBetween(text, /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ||
    textBetween(text, /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i)
  const description = textBetween(text, /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i)
  const id = Buffer.from(sourceUrl).toString("hex").slice(0, 24).toUpperCase()
  return [{
    source: "makerworld_web",
    sourceModelId: `WEB-${id}`,
    sourceUrl,
    title: title.replace(/\s*[-|].*$/, "") || "授权渠道模型",
    authorName: "",
    authorUrl: "",
    category: description.includes("收纳") ? "3D打印" : "潮玩手办",
    tags: ["网页抓取", "授权渠道", ...(description ? description.split(/[，, ]/).slice(0, 4) : [])],
    coverImage: image,
    images: image ? [image] : [],
    downloadCount: 0,
    likeCount: 0,
    collectCount: 0,
    printCount: 0,
    printTimeMinutes: 180,
    filamentWeightG: 100,
    licenseType: "offline_cooperation",
    commercialStatus: "offline_authorized",
    authorizationType: "offline",
    authorizationParty: "非常智造线下合作渠道",
    authorizationNote: `从授权渠道页面抓取：${sourceUrl}`,
    rawHtmlTitle: title,
    syncedAt: now()
  }]
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
      results.push({
        source: "makerworld_web",
        sourceModelId: `WEB-FAILED-${Buffer.from(url).toString("hex").slice(0, 16).toUpperCase()}`,
        sourceUrl: url,
        title: "授权渠道网页抓取失败",
        authorName: "",
        category: "潮玩手办",
        tags: ["抓取失败"],
        coverImage: "",
        images: [],
        commercialStatus: "offline_authorized",
        authorizationType: "offline",
        authorizationParty: "非常智造线下合作渠道",
        authorizationNote: `网页抓取失败，请人工补充：${error.message}`,
        riskLevel: "high",
        riskReasons: ["网页抓取失败，需人工补充模型信息"],
        syncedAt: now()
      })
    }
  }
  return results.length ? results : mockModels
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

async function fetchModelDetail(modelId) {
  return mockModels.find(model => model.sourceModelId === modelId || model.source_model_id === modelId) || null
}

module.exports = {
  fetchLatestModels,
  fetchPopularModels,
  fetchModelDetail,
  fetchModelsFromUrls,
  normalizeSourceUrls
}
