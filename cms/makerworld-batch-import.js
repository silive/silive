"use strict"

const {
  canonicalizeMakerWorldUrl,
  extractMakerWorldUrls
} = require("./makerworld-catalog-sync")

function decodeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&quot;|&#34;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .trim()
}

function htmlAttributes(tag) {
  const result = {}
  String(tag).replace(/([:\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g, (_, key, doubleValue, singleValue, bareValue) => {
    result[String(key).toLowerCase()] = decodeHtml(doubleValue ?? singleValue ?? bareValue ?? "")
    return ""
  })
  return result
}

function metaValues(html) {
  const values = new Map()
  for (const match of String(html).matchAll(/<meta\b[^>]*>/gi)) {
    const attributes = htmlAttributes(match[0])
    const key = String(attributes.property || attributes.name || "").toLowerCase()
    if (key && attributes.content && !values.has(key)) values.set(key, attributes.content)
  }
  return values
}

function jsonLdObjects(html) {
  const objects = []
  for (const match of String(html).matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const parsed = JSON.parse(decodeHtml(match[1]))
      if (Array.isArray(parsed)) objects.push(...parsed)
      else if (parsed && typeof parsed === "object") objects.push(parsed)
    } catch (error) {}
  }
  return objects
}

function flattenJsonLd(objects) {
  const output = []
  const visit = value => {
    if (!value || typeof value !== "object") return
    if (Array.isArray(value)) return value.forEach(visit)
    output.push(value)
    if (value["@graph"]) visit(value["@graph"])
  }
  objects.forEach(visit)
  return output
}

function firstText(...values) {
  for (const value of values.flat(Infinity)) {
    const normalized = decodeHtml(value)
    if (normalized) return normalized
  }
  return ""
}

function imageList(value) {
  const list = Array.isArray(value) ? value : [value]
  return list.map(item => typeof item === "object" ? (item.url || item.contentUrl) : item)
    .map(firstText).filter(item => /^https:\/\//i.test(item))
}

function parseMakerWorldHtml(html, sourceUrl) {
  const body = String(html || "")
  const meta = metaValues(body)
  const jsonLd = flattenJsonLd(jsonLdObjects(body))
  const main = jsonLd.find(item => /Product|CreativeWork|3DModel/i.test(String(item["@type"] || ""))) || jsonLd[0] || {}
  const authorObject = typeof main.author === "object" ? main.author : {}
  const authorUrl = firstText(authorObject.url, authorObject["@id"])
  const authorIdMatch = authorUrl.match(/\/(?:u|user|profile)\/([^/?#]+)/i)
  const images = [
    ...imageList(main.image),
    ...imageList(meta.get("og:image")),
    ...imageList(meta.get("twitter:image"))
  ].filter((item, index, list) => list.indexOf(item) === index)
  const title = firstText(main.name, meta.get("og:title"), meta.get("twitter:title"))
    .replace(/\s*[-|]\s*MakerWorld.*$/i, "").trim()
  const description = firstText(main.description, meta.get("description"), meta.get("og:description"))
  const licenseRaw = firstText(main.license, meta.get("license"), meta.get("copyright"))
  const cloudflareBlocked = /cf-mitigated|challenge-platform|challenges\.cloudflare|<title>\s*(?:Just a moment|\u8bf7\u7a0d候)/i.test(body)
  return {
    sourceUrl,
    title,
    summary: description,
    author: firstText(authorObject.name, typeof main.author === "string" ? main.author : "", meta.get("author")),
    authorId: authorIdMatch ? authorIdMatch[1] : "",
    authorUrl,
    imageUrl: images[0] || "",
    galleryImages: images.slice(1, 10),
    licenseRaw,
    cloudflareBlocked
  }
}

function prepareBatchInput(value, maximum = 100) {
  const extracted = extractMakerWorldUrls(value)
  if (extracted.length > maximum) {
    const error = new Error(`每次最多导入 ${maximum} 个 MakerWorld 链接，请分批提交`)
    error.statusCode = 400
    throw error
  }
  return extracted.map((submittedUrl, index) => ({
    index: index + 1,
    submittedUrl,
    normalized: canonicalizeMakerWorldUrl(submittedUrl)
  }))
}

module.exports = {
  decodeHtml,
  parseMakerWorldHtml,
  prepareBatchInput
}
