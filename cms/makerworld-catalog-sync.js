"use strict"

const crypto = require("crypto")

const SAFE_LICENSES = new Set([
  "PUBLIC_DOMAIN",
  "CC0",
  "CC_BY_4_0",
  "CC_BY_3_0"
])

function text(value) {
  return String(value == null ? "" : value).trim()
}

function bool(value) {
  return value === true || ["true", "1", "yes", "是"].includes(text(value).toLowerCase())
}

function normalizeLicense(value) {
  const raw = text(value).toUpperCase()
    .replace(/CREATIVE COMMONS/g, "CC")
    .replace(/ATTRIBUTION/g, "BY")
    .replace(/PUBLIC[ _-]*DOMAIN/g, "PUBLIC_DOMAIN")
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
  if (["CC_0", "CC0_1_0", "CC_ZERO"].includes(raw)) return "CC0"
  if (["CC_BY", "CC_BY_4", "BY_4_0"].includes(raw)) return "CC_BY_4_0"
  if (["CC_BY_3", "BY_3_0"].includes(raw)) return "CC_BY_3_0"
  if (/STANDARD.*DIGITAL.*FILE/.test(raw)) return "STANDARD_DIGITAL_FILE"
  return raw
}

function makerworldModelId(candidate = {}) {
  const direct = text(candidate.modelId || candidate.id || candidate.model_id)
  if (direct && /^[A-Za-z0-9_-]{1,80}$/.test(direct)) return direct
  const match = text(candidate.sourceUrl || candidate.url).match(/\/models\/(\d+)/i)
  return match ? match[1] : ""
}

function isMakerWorldUrl(value) {
  try {
    const url = new URL(value)
    return url.protocol === "https:" && (url.hostname === "makerworld.com.cn" || url.hostname.endsWith(".makerworld.com.cn")) && /\/models\/\d+/i.test(url.pathname)
  } catch (error) {
    return false
  }
}

function candidateScore(candidate = {}) {
  const metrics = candidate.metrics && typeof candidate.metrics === "object" ? candidate.metrics : candidate
  const downloads = Math.max(0, Number(metrics.downloads || metrics.downloadCount || 0))
  const likes = Math.max(0, Number(metrics.likes || metrics.likeCount || 0))
  const boosts = Math.max(0, Number(metrics.boosts || metrics.boostCount || 0))
  const makes = Math.max(0, Number(metrics.makes || metrics.makeCount || 0))
  const rating = Math.max(0, Math.min(5, Number(metrics.rating || 0)))
  return Math.round((Math.log10(downloads + 1) * 32 + Math.log10(likes + 1) * 22 + Math.log10(boosts + 1) * 18 + Math.log10(makes + 1) * 18 + rating * 10) * 100) / 100
}

function normalizeCandidate(candidate = {}) {
  const sourceUrl = text(candidate.sourceUrl || candidate.url)
  const modelId = makerworldModelId(candidate)
  const licenseCode = normalizeLicense(candidate.licenseCode || candidate.license || candidate.licenseName)
  const title = text(candidate.title || candidate.name)
  const author = text(candidate.author || candidate.authorName || candidate.creator)
  const rights = candidate.rights && typeof candidate.rights === "object" ? candidate.rights : candidate
  const imageUrl = text(candidate.imageUrl || candidate.coverImage || candidate.thumbnailUrl)
  return {
    modelId,
    sourceUrl,
    title,
    summary: text(candidate.summary || candidate.description || candidate.intro),
    author,
    licenseCode,
    licenseUrl: text(candidate.licenseUrl),
    attribution: text(candidate.attribution) || [title, author, sourceUrl, licenseCode].filter(Boolean).join(" · "),
    imageUrl,
    galleryImages: (Array.isArray(candidate.galleryImages) ? candidate.galleryImages : []).map(text).filter(Boolean).slice(0, 9),
    commercialUseAllowed: bool(rights.commercialUseAllowed),
    listingMediaReuseAllowed: bool(rights.listingMediaReuseAllowed),
    sourceVerified: bool(rights.sourceVerified),
    score: candidateScore(candidate),
    rawMetrics: candidate.metrics && typeof candidate.metrics === "object" ? candidate.metrics : {}
  }
}

function autoPublishDecision(candidate, options = {}) {
  const item = normalizeCandidate(candidate)
  const allowedLicenses = new Set((options.allowedLicenses || Array.from(SAFE_LICENSES)).map(normalizeLicense))
  const blockers = []
  if (!item.modelId || !isMakerWorldUrl(item.sourceUrl)) blockers.push("来源链接不是有效的 MakerWorld 模型页")
  if (!item.title || !item.author) blockers.push("缺少标题或作者")
  if (!allowedLicenses.has(item.licenseCode)) blockers.push(`许可证 ${item.licenseCode || "未知"} 不在自动发布白名单`)
  if (!item.commercialUseAllowed) blockers.push("上游未明确声明允许商用")
  if (!item.listingMediaReuseAllowed || !item.imageUrl) blockers.push("上游未明确声明允许复用商品图片")
  const allowedMediaHosts = (options.allowedMediaHosts || []).map(text).filter(Boolean)
  if (item.imageUrl && allowedMediaHosts.length) {
    try {
      const imageHost = new URL(item.imageUrl).hostname.toLowerCase()
      if (!allowedMediaHosts.some(host => imageHost === host.toLowerCase() || imageHost.endsWith(`.${host.toLowerCase()}`))) {
        blockers.push("商品图片域名不在已授权媒体白名单")
      }
    } catch (error) {
      blockers.push("商品图片地址无效")
    }
  }
  if (!item.sourceVerified) blockers.push("上游未完成来源与权利核验")
  return { eligible: blockers.length === 0, blockers, candidate: item }
}

function stableProductId(modelId) {
  const safe = text(modelId).replace(/[^A-Za-z0-9]/g, "").slice(0, 20)
  if (safe) return `MW${safe}`.slice(0, 32)
  return `MW${crypto.createHash("sha256").update(text(modelId)).digest("hex").slice(0, 24)}`
}

function buildProduct(candidate, options = {}) {
  const decision = autoPublishDecision(candidate, options)
  const item = decision.candidate
  const autoPublish = bool(options.autoPublish)
  const canPublish = autoPublish && decision.eligible
  return {
    id: stableProductId(item.modelId || item.sourceUrl),
    name: item.title || "MakerWorld 待审核模型",
    intro: item.summary.slice(0, 255),
    detailText: item.summary,
    price: String(options.defaultPrice || "0"),
    costPrice: String(options.defaultCostPrice || "0"),
    badge: "new",
    cover: "keyring",
    imageUrl: item.imageUrl,
    galleryImages: item.galleryImages,
    detailImages: [],
    videoUrl: "",
    productType: "normal",
    categories: options.categories || ["潮玩手办", "潮玩手办/新品上架"],
    status: canPublish ? "on" : "off",
    stock: String(options.defaultStock || "0"),
    stockMode: "unlimited",
    isHot: "false",
    promotionHot: "false",
    rewardEnabled: "false",
    firstReward: "0",
    secondReward: "0",
    modelCandidateId: item.modelId,
    modelSourcePlatform: "MakerWorld",
    modelSourceUrl: item.sourceUrl,
    modelAuthorName: item.author,
    modelLicenseCode: item.licenseCode,
    modelLicenseUrl: item.licenseUrl,
    modelAttribution: item.attribution,
    modelAuthorizationStatus: decision.eligible ? "feed_verified" : "pending_review",
    modelAuthorizationNote: decision.blockers.join("；"),
    modelSyncScore: String(item.score),
    modelSyncedAt: new Date().toISOString(),
    sortOrder: String(options.sortOrder || 999)
  }
}

function feedCandidates(payload) {
  if (Array.isArray(payload)) return payload
  if (!payload || typeof payload !== "object") return []
  for (const key of ["models", "items", "data", "results"]) {
    if (Array.isArray(payload[key])) return payload[key]
    if (payload[key] && Array.isArray(payload[key].items)) return payload[key].items
  }
  return []
}

function planSync(payload, existingProducts = [], options = {}) {
  const limit = Math.max(1, Math.min(Number(options.limit || 20), 100))
  const candidates = feedCandidates(payload).map(normalizeCandidate)
    .filter(item => item.modelId && isMakerWorldUrl(item.sourceUrl))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
  const existingByCandidate = new Map(existingProducts.filter(item => item.modelCandidateId).map(item => [String(item.modelCandidateId), item]))
  const products = []
  const report = { received: feedCandidates(payload).length, selected: candidates.length, created: 0, updated: 0, autoPublished: 0, drafts: 0, rejected: 0 }
  for (const candidate of candidates) {
    const generated = buildProduct(candidate, options)
    const existing = existingByCandidate.get(candidate.modelId)
    if (existing) {
      products.push({
        ...existing,
        modelSourcePlatform: generated.modelSourcePlatform,
        modelSourceUrl: generated.modelSourceUrl,
        modelAuthorName: generated.modelAuthorName,
        modelLicenseCode: generated.modelLicenseCode,
        modelLicenseUrl: generated.modelLicenseUrl,
        modelAttribution: generated.modelAttribution,
        modelAuthorizationStatus: generated.modelAuthorizationStatus,
        modelAuthorizationNote: generated.modelAuthorizationNote,
        modelSyncScore: generated.modelSyncScore,
        modelSyncedAt: generated.modelSyncedAt,
        status: generated.modelAuthorizationStatus === "feed_verified"
          ? (bool(options.autoPublish) ? "on" : existing.status)
          : "off"
      })
      report.updated += 1
    } else {
      products.push(generated)
      report.created += 1
    }
    if (generated.status === "on") report.autoPublished += 1
    else report.drafts += 1
    if (generated.modelAuthorizationStatus !== "feed_verified") report.rejected += 1
  }
  return { products, report }
}

module.exports = {
  SAFE_LICENSES,
  autoPublishDecision,
  buildProduct,
  candidateScore,
  feedCandidates,
  isMakerWorldUrl,
  normalizeCandidate,
  normalizeLicense,
  planSync,
  stableProductId
}
