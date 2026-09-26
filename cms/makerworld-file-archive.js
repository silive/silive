"use strict"

const dns = require("dns").promises
const https = require("https")
const net = require("net")

const MAX_METADATA_BYTES = 2 * 1024 * 1024
const DEFAULT_MAX_FILE_BYTES = 250 * 1024 * 1024

function safeArchiveFilename(title, fallback = "MakerWorld模型") {
  const clean = String(title || fallback)
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, "_")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim()
    .slice(0, 120) || fallback
  return `${clean}.3mf`
}

function findDownloadUrl(value) {
  const candidates = []
  const visit = (item, key = "", depth = 0) => {
    if (depth > 8 || item == null) return
    if (typeof item === "string") {
      if (/^https:\/\//i.test(item)) candidates.push({ url: item, key: String(key).toLowerCase() })
      return
    }
    if (Array.isArray(item)) return item.forEach(child => visit(child, key, depth + 1))
    if (typeof item === "object") Object.entries(item).forEach(([childKey, child]) => visit(child, childKey, depth + 1))
  }
  visit(value)
  candidates.sort((a, b) => {
    const score = item => (/\.3mf(?:[?#]|$)/i.test(item.url) ? 100 : 0) + (/download|file|url/.test(item.key) ? 20 : 0)
    return score(b) - score(a)
  })
  return candidates[0]?.url || ""
}

function privateIp(address) {
  if (!net.isIP(address)) return true
  if (address === "::1" || address === "0.0.0.0") return true
  if (address.startsWith("fc") || address.startsWith("fd") || address.startsWith("fe80:")) return true
  if (address.startsWith("::ffff:")) return privateIp(address.slice(7))
  if (net.isIPv4(address)) {
    const [a, b] = address.split(".").map(Number)
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
  }
  return false
}

async function assertPublicHttpsUrl(value) {
  const url = new URL(value)
  if (url.protocol !== "https:" || !url.hostname) throw new Error("模型下载地址必须使用 HTTPS")
  const records = await dns.lookup(url.hostname, { all: true })
  if (!records.length || records.some(record => privateIp(record.address))) throw new Error("模型下载地址不安全")
  return url
}

function requestBuffer(url, options = {}, redirects = 0) {
  return new Promise((resolve, reject) => {
    const target = new URL(url)
    const req = https.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || 443,
      path: `${target.pathname}${target.search}`,
      method: "GET",
      headers: options.headers || {},
      timeout: options.timeout || 120000
    }, response => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
        response.resume()
        if (redirects >= 4) return reject(new Error("模型文件下载重定向过多"))
        return resolve(downloadPublicBuffer(new URL(response.headers.location, target).toString(), options, redirects + 1))
      }
      if (response.statusCode < 200 || response.statusCode >= 300) {
        response.resume()
        return reject(new Error(`模型文件下载失败：HTTP ${response.statusCode}`))
      }
      const declared = Number(response.headers["content-length"] || 0)
      const maximum = Number(options.maxBytes || DEFAULT_MAX_FILE_BYTES)
      if (declared > maximum) {
        response.destroy()
        return reject(new Error(`模型文件超过 ${Math.floor(maximum / 1024 / 1024)}MB 限制`))
      }
      const chunks = []
      let size = 0
      response.on("data", chunk => {
        size += chunk.length
        if (size > maximum) return response.destroy(new Error(`模型文件超过 ${Math.floor(maximum / 1024 / 1024)}MB 限制`))
        chunks.push(chunk)
      })
      response.on("end", () => resolve(Buffer.concat(chunks)))
      response.on("error", reject)
    })
    req.on("timeout", () => req.destroy(new Error("模型文件下载超时")))
    req.on("error", reject)
    req.end()
  })
}

async function downloadPublicBuffer(url, options = {}, redirects = 0) {
  await assertPublicHttpsUrl(url)
  return requestBuffer(url, options, redirects)
}

async function resolveMakerworldDownload({ sourceUrl, modelInternalId, profileDataId, accessToken }) {
  if (!modelInternalId || !profileDataId) throw new Error("模型内部 ID 或打印配置数据 ID 缺失，请先补全模型信息")
  if (!accessToken) throw new Error("MakerWorld 文件下载授权尚未配置")
  const host = new URL(sourceUrl).hostname.endsWith(".com.cn") ? "api.bambulab.cn" : "api.bambulab.com"
  const endpoint = `https://${host}/v1/iot-service/api/user/profile/${encodeURIComponent(profileDataId)}?model_id=${encodeURIComponent(modelInternalId)}`
  const token = String(accessToken).replace(/^Bearer\s+/i, "").trim()
  const response = await requestBuffer(endpoint, {
    maxBytes: MAX_METADATA_BYTES,
    timeout: 30000,
    headers: { Accept: "application/json", Authorization: `Bearer ${token}`, "User-Agent": "BambuNetworkAgent/01.09.05.01" }
  })
  let payload
  try { payload = JSON.parse(response.toString("utf8")) } catch (error) { throw new Error("MakerWorld 下载接口返回格式异常") }
  const downloadUrl = findDownloadUrl(payload)
  if (!downloadUrl) throw new Error("MakerWorld 下载接口未返回模型文件地址；请确认账号有权下载该配置")
  return downloadUrl
}

async function downloadMakerworldFile(options) {
  const downloadUrl = await resolveMakerworldDownload(options)
  return downloadPublicBuffer(downloadUrl, { maxBytes: options.maxBytes || DEFAULT_MAX_FILE_BYTES, timeout: options.timeout || 180000 })
}

module.exports = { DEFAULT_MAX_FILE_BYTES, assertPublicHttpsUrl, downloadMakerworldFile, findDownloadUrl, safeArchiveFilename }
