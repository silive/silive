"use strict"

const path = require("path")

function safeToken(value, fallback = "unknown") {
  const token = String(value || "")
    .trim()
    .replace(/[^A-Za-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
  return token || fallback
}

function replacementStem(product = {}) {
  return `MW-${safeToken(product.modelCandidateId)}__PID-${safeToken(product.id)}`
}

function replacementFilename(product, extension = "jpg") {
  const ext = String(extension || "jpg").toLowerCase().replace(/[^a-z0-9]/g, "") || "jpg"
  return `${replacementStem(product)}.${ext}`
}

function normalizedStem(filename) {
  return path.basename(String(filename || ""), path.extname(String(filename || ""))).toLowerCase()
}

function stemMatchesKey(stem, key) {
  return stem === key || stem.startsWith(`${key}_`) || stem.startsWith(`${key}-`)
}

function matchReplacementFilename(filename, products = []) {
  const stem = normalizedStem(filename)
  const imported = products.filter(product => product && product.id && product.modelCandidateId)
  const fullMatches = imported.filter(product => stemMatchesKey(stem, replacementStem(product).toLowerCase()))
  if (fullMatches.length === 1) return { product: fullMatches[0], matchedBy: "product_and_model_id" }
  if (fullMatches.length > 1) return { product: null, matchedBy: "ambiguous" }

  const productMatches = imported.filter(product => stemMatchesKey(stem, `pid-${safeToken(product.id)}`.toLowerCase()))
  if (productMatches.length === 1) return { product: productMatches[0], matchedBy: "product_id" }
  if (productMatches.length > 1) return { product: null, matchedBy: "ambiguous" }

  const modelMatches = imported.filter(product => stemMatchesKey(stem, `mw-${safeToken(product.modelCandidateId)}`.toLowerCase()))
  if (modelMatches.length === 1) return { product: modelMatches[0], matchedBy: "model_id" }
  if (modelMatches.length > 1) return { product: null, matchedBy: "ambiguous" }
  return { product: null, matchedBy: "none" }
}

function csvCell(value) {
  const text = String(value == null ? "" : value)
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

function manifestCsv(rows = []) {
  const headers = ["商品ID", "MakerWorld模型ID", "商品标题", "原主图地址", "原图文件名", "GPT成图建议文件名"]
  const lines = [headers, ...rows.map(row => [
    row.productId,
    row.modelId,
    row.title,
    row.originalImageUrl,
    row.originalFilename,
    row.suggestedFilename
  ])]
  return `\uFEFF${lines.map(line => line.map(csvCell).join(",")).join("\r\n")}\r\n`
}

module.exports = {
  manifestCsv,
  matchReplacementFilename,
  replacementFilename,
  replacementStem,
  safeToken
}
