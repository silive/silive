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

function plainText(value) {
  return decodeHtml(String(value == null ? "" : value)
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/p\s*>/gi, "\n")
    .replace(/<[^>]+>/g, " "))
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s+/g, "\n")
    .trim()
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

function parseMakerWorldApiDesign(payload, sourceUrl) {
  const design = payload && typeof payload === "object" && payload.data && typeof payload.data === "object"
    ? payload.data
    : payload
  if (!design || typeof design !== "object") throw new Error("MakerWorld API 返回格式无效")
  const creator = design.designCreator && typeof design.designCreator === "object" ? design.designCreator : {}
  const pictures = []
  const addPicture = value => {
    const url = firstText(typeof value === "object" ? (value.url || value.coverUrl) : value)
    if (/^https:\/\//i.test(url) && !pictures.includes(url)) pictures.push(url)
  }
  addPicture(design.coverUrl)
  const extension = design.designExtension && typeof design.designExtension === "object" ? design.designExtension : {}
  ;(Array.isArray(extension.design_pictures) ? extension.design_pictures : []).forEach(addPicture)
  for (const instance of (Array.isArray(design.instances) ? design.instances : []).slice(0, 5)) {
    addPicture(instance?.cover)
    ;(Array.isArray(instance?.pictures) ? instance.pictures : []).slice(0, 3).forEach(addPicture)
  }
  const handle = firstText(creator.handle)
  const authorUrl = handle ? `https://makerworld.com.cn/zh/@${encodeURIComponent(handle)}` : ""
  const licenseInfo = design.licenseDescriptionInfo && typeof design.licenseDescriptionInfo === "object" ? design.licenseDescriptionInfo : {}
  return {
    sourceUrl,
    title: firstText(design.titleTranslated, design.title),
    summary: plainText(firstText(design.summaryTranslated, design.summary)),
    author: firstText(creator.name),
    authorId: firstText(creator.uid),
    authorUrl,
    imageUrl: pictures[0] || "",
    galleryImages: pictures.slice(1, 10),
    licenseRaw: firstText(licenseInfo.description, licenseInfo.name, licenseInfo.title, design.license),
    licenseCode: firstText(design.license),
    metrics: {
      downloads: Number(design.downloadCount || 0),
      likes: Number(design.likeCount || 0),
      boosts: Number(design.boostInfo?.boostCount || 0),
      makes: Number(design.printCount || 0)
    }
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
  parseMakerWorldApiDesign,
  parseMakerWorldHtml,
  prepareBatchInput
}
