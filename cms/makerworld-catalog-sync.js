"use strict"

const crypto = require("crypto")

function text(value) {
  return String(value == null ? "" : value).trim()
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
  const licenseRaw = text(candidate.licenseRaw || candidate.licenseText || candidate.license || candidate.licenseName || candidate.licenseCode)
  const licenseCode = normalizeLicense(candidate.licenseCode || licenseRaw)
  const title = text(candidate.title || candidate.name)
  const author = text(candidate.author || candidate.authorName || candidate.creator)
  const imageUrl = text(candidate.imageUrl || candidate.coverImage || candidate.thumbnailUrl)
  return {
    modelId,
    sourceUrl,
    title,
    summary: text(candidate.summary || candidate.description || candidate.intro),
    author,
    licenseCode,
    licenseRaw,
    licenseUrl: text(candidate.licenseUrl),
    attribution: text(candidate.attribution) || [title, author, sourceUrl, licenseCode].filter(Boolean).join(" · "),
    imageUrl,
    galleryImages: (Array.isArray(candidate.galleryImages) ? candidate.galleryImages : []).map(text).filter(Boolean).slice(0, 9),
    score: candidateScore(candidate),
    rawMetrics: candidate.metrics && typeof candidate.metrics === "object" ? candidate.metrics : {}
  }
}

function importDecision(candidate) {
  const item = normalizeCandidate(candidate)
  const errors = []
  if (!item.modelId || !isMakerWorldUrl(item.sourceUrl)) errors.push("来源链接不是有效的 MakerWorld 模型页")
  if (!item.title) errors.push("缺少模型标题")
  return { importable: errors.length === 0, errors, candidate: item }
}

function stableProductId(modelId) {
  const safe = text(modelId).replace(/[^A-Za-z0-9]/g, "").slice(0, 20)
  if (safe) return `MW${safe}`.slice(0, 32)
  return `MW${crypto.createHash("sha256").update(text(modelId)).digest("hex").slice(0, 24)}`
}

function buildProduct(candidate, options = {}) {
  const decision = importDecision(candidate)
  const item = decision.candidate
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
    status: "off",
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
    modelLicenseRaw: item.licenseRaw,
    modelLicenseUrl: item.licenseUrl,
    modelAttribution: item.attribution,
    modelAuthorizationStatus: "pending_review",
    modelAuthorizationNote: "",
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
  const receivedCandidates = feedCandidates(payload)
  const validCandidates = receivedCandidates.map(normalizeCandidate)
    .filter(item => importDecision(item).importable)
    .sort((a, b) => b.score - a.score)
  const candidates = validCandidates.slice(0, limit)
  const existingByCandidate = new Map(existingProducts.filter(item => item.modelCandidateId).map(item => [String(item.modelCandidateId), item]))
  const products = []
  const report = { received: receivedCandidates.length, selected: candidates.length, created: 0, updated: 0, pendingReview: 0, skippedForMissingBasics: receivedCandidates.length - validCandidates.length }
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
        modelLicenseRaw: generated.modelLicenseRaw,
        modelLicenseUrl: generated.modelLicenseUrl,
        modelAttribution: generated.modelAttribution,
        modelSyncScore: generated.modelSyncScore,
        modelSyncedAt: generated.modelSyncedAt,
        modelAuthorizationStatus: existing.modelAuthorizationStatus || "pending_review",
        modelAuthorizationNote: existing.modelAuthorizationNote || "",
        status: existing.modelAuthorizationStatus === "approved" ? existing.status : "off"
      })
      report.updated += 1
    } else {
      products.push(generated)
      report.created += 1
    }
    if (!existing || !existing.modelAuthorizationStatus || existing.modelAuthorizationStatus === "pending_review") report.pendingReview += 1
  }
  return { products, report }
}

module.exports = {
  buildProduct,
  candidateScore,
  feedCandidates,
  importDecision,
  isMakerWorldUrl,
  normalizeCandidate,
  normalizeLicense,
  planSync,
  stableProductId
}
