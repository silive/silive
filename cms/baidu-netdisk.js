"use strict"

const crypto = require("crypto")
const https = require("https")

const BLOCK_SIZE = 4 * 1024 * 1024

function request(url, options = {}, body = null) {
  return new Promise((resolve, reject) => {
    const target = new URL(url)
    const req = https.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || 443,
      path: `${target.pathname}${target.search}`,
      method: options.method || "GET",
      headers: options.headers || {},
      timeout: options.timeout || 30000
    }, response => {
      const chunks = []
      response.on("data", chunk => chunks.push(chunk))
      response.on("end", () => resolve({ statusCode: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }))
    })
    req.on("timeout", () => req.destroy(new Error("百度网盘请求超时")))
    req.on("error", reject)
    if (body) req.write(body)
    req.end()
  })
}

function jsonResponse(response, action) {
  let data
  try { data = JSON.parse(response.body.toString("utf8") || "{}") } catch (error) { throw new Error(`${action}返回格式异常`) }
  if (response.statusCode < 200 || response.statusCode >= 300 || Number(data.errno || data.error_code || 0) !== 0) {
    throw new Error(`${action}失败：${data.error_description || data.error_msg || data.errmsg || `HTTP ${response.statusCode}`}`)
  }
  return data
}

function oauthAuthorizeUrl({ appKey, redirectUri, state }) {
  const url = new URL("https://openapi.baidu.com/oauth/2.0/authorize")
  url.searchParams.set("response_type", "code")
  url.searchParams.set("client_id", appKey)
  url.searchParams.set("redirect_uri", redirectUri)
  url.searchParams.set("scope", "basic,netdisk")
  url.searchParams.set("display", "page")
  url.searchParams.set("state", state)
  return url.toString()
}

async function exchangeCode({ appKey, secretKey, redirectUri, code }) {
  const url = new URL("https://openapi.baidu.com/oauth/2.0/token")
  url.searchParams.set("grant_type", "authorization_code")
  url.searchParams.set("code", code)
  url.searchParams.set("client_id", appKey)
  url.searchParams.set("client_secret", secretKey)
  url.searchParams.set("redirect_uri", redirectUri)
  return jsonResponse(await request(url), "百度网盘授权")
}

async function refreshToken({ appKey, secretKey, refreshToken: token }) {
  const url = new URL("https://openapi.baidu.com/oauth/2.0/token")
  url.searchParams.set("grant_type", "refresh_token")
  url.searchParams.set("refresh_token", token)
  url.searchParams.set("client_id", appKey)
  url.searchParams.set("client_secret", secretKey)
  return jsonResponse(await request(url), "刷新百度网盘授权")
}

function formBody(value) {
  return Buffer.from(new URLSearchParams(Object.entries(value).map(([key, item]) => [key, String(item)])).toString())
}

async function postForm(url, fields, action) {
  const body = formBody(fields)
  return jsonResponse(await request(url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": body.length } }, body), action)
}

async function uploadPart({ accessToken, path, uploadId, partseq, buffer }) {
  const boundary = `----vsc${crypto.randomBytes(12).toString("hex")}`
  const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="part"\r\nContent-Type: application/octet-stream\r\n\r\n`)
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`)
  const body = Buffer.concat([head, buffer, tail])
  const url = new URL("https://d.pcs.baidu.com/rest/2.0/pcs/superfile2")
  url.searchParams.set("method", "upload")
  url.searchParams.set("access_token", accessToken)
  url.searchParams.set("type", "tmpfile")
  url.searchParams.set("path", path)
  url.searchParams.set("uploadid", uploadId)
  url.searchParams.set("partseq", String(partseq))
  return jsonResponse(await request(url, { method: "POST", timeout: 120000, headers: { "Content-Type": `multipart/form-data; boundary=${boundary}`, "Content-Length": body.length } }, body), `上传第 ${partseq + 1} 个分片`)
}

async function uploadBuffer({ accessToken, appFolder, filename, buffer }) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error("待上传文件为空")
  const safeFolder = String(appFolder || "非常智造模型").replace(/[\\:*?"<>|]/g, "_").slice(0, 80)
  const path = `/apps/${safeFolder}/${filename}`
  const blocks = []
  for (let offset = 0; offset < buffer.length; offset += BLOCK_SIZE) blocks.push(buffer.subarray(offset, Math.min(buffer.length, offset + BLOCK_SIZE)))
  const blockList = blocks.map(block => crypto.createHash("md5").update(block).digest("hex"))
  const precreateUrl = new URL("https://pan.baidu.com/rest/2.0/xpan/file")
  precreateUrl.searchParams.set("method", "precreate")
  precreateUrl.searchParams.set("access_token", accessToken)
  const precreate = await postForm(precreateUrl, { path, size: buffer.length, isdir: 0, autoinit: 1, rtype: 3, block_list: JSON.stringify(blockList) }, "百度网盘预上传")
  const required = Array.isArray(precreate.block_list) ? precreate.block_list.map(Number) : blocks.map((_, index) => index)
  for (const index of required) await uploadPart({ accessToken, path, uploadId: precreate.uploadid, partseq: index, buffer: blocks[index] })
  const createUrl = new URL("https://pan.baidu.com/rest/2.0/xpan/file")
  createUrl.searchParams.set("method", "create")
  createUrl.searchParams.set("access_token", accessToken)
  const created = await postForm(createUrl, { path, size: buffer.length, isdir: 0, rtype: 3, uploadid: precreate.uploadid, block_list: JSON.stringify(blockList) }, "百度网盘创建文件")
  return { path, fsId: String(created.fs_id || ""), size: buffer.length, md5: crypto.createHash("md5").update(buffer).digest("hex") }
}

module.exports = { exchangeCode, oauthAuthorizeUrl, refreshToken, uploadBuffer }
