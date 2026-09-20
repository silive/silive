"use strict"

const assert = require("assert")
const fs = require("fs")
const path = require("path")
const {
  canonicalizeMakerWorldUrl,
  extractMakerWorldUrls
} = require("../cms/makerworld-catalog-sync")
const {
  parseMakerWorldHtml,
  prepareBatchInput
} = require("../cms/makerworld-batch-import")

const normal = "https://makerworld.com.cn/zh/models/849446-mi-ta"
assert.deepStrictEqual(canonicalizeMakerWorldUrl(`${normal}/?from=share&utm_source=wechat`), {
  modelId: "849446",
  submittedUrl: `${normal}/?from=share&utm_source=wechat`,
  canonicalUrl: normal
})

const tenLinks = Array.from({ length: 10 }, (_, index) => `https://makerworld.com.cn/en/models/${1000 + index}-model-${index}?from=share`)
const preparedTen = prepareBatchInput(`来自 Excel：\n${tenLinks.join(" \n")}`)
assert.strictEqual(preparedTen.length, 10)
assert.strictEqual(preparedTen.every(item => item.normalized?.modelId), true)

const duplicated = prepareBatchInput(`${normal}\n${normal}?from=wechat`)
assert.strictEqual(duplicated.length, 2)
assert.strictEqual(duplicated[0].normalized.modelId, duplicated[1].normalized.modelId)
assert.strictEqual(duplicated[0].normalized.canonicalUrl, duplicated[1].normalized.canonicalUrl)

assert.strictEqual(canonicalizeMakerWorldUrl("https://makerworld.com.cn/models/849446-mi-ta?track=1#comments").canonicalUrl, normal)
const mixed = extractMakerWorldUrls(`普通文字 https://example.com/a ${normal} 无效 https://makerworld.com.cn/zh/designs/not-a-model`)
assert.strictEqual(mixed.length, 2)
assert.strictEqual(prepareBatchInput(mixed.join(" "))[1].normalized, null)

const parsed = parseMakerWorldHtml(`<!doctype html><html><head>
  <meta property="og:title" content="米塔 - MakerWorld">
  <meta property="og:image" content="https://images.example/main.jpg">
  <meta name="description" content="模型描述">
  <script type="application/ld+json">{"@type":"Product","name":"米塔","author":{"name":"南波万","url":"https://makerworld.com.cn/zh/u/author-1"},"image":["https://images.example/main.jpg","https://images.example/second.jpg"],"license":"Standard Digital File License"}</script>
</head></html>`, normal)
assert.strictEqual(parsed.title, "米塔")
assert.strictEqual(parsed.author, "南波万")
assert.strictEqual(parsed.imageUrl, "https://images.example/main.jpg")
assert.strictEqual(parsed.galleryImages[0], "https://images.example/second.jpg")
assert.strictEqual(parsed.licenseRaw, "Standard Digital File License")

const incomplete = parseMakerWorldHtml("<html><head></head><body></body></html>", normal)
assert.strictEqual(incomplete.title, "")
assert.strictEqual(incomplete.imageUrl, "")
assert.strictEqual(parseMakerWorldHtml("<title>请稍候…</title><script src='https://challenges.cloudflare-cn.com/a.js'></script>", normal).cloudflareBlocked, true)

assert.throws(() => prepareBatchInput(Array.from({ length: 101 }, (_, index) => `https://makerworld.com.cn/zh/models/${2000 + index}-x`).join("\n")), /最多导入 100/)

const server = fs.readFileSync(path.join(__dirname, "../cms/server.js"), "utf8")
assert.match(server, /makerworldImportWorkerRunning/)
assert.match(server, /byModelId\.get\(input\.normalized\.modelId\)/)
assert.match(server, /modelAuthorizationStatus = "pending_review"/)
assert.match(server, /product\.status = "off"/)
assert.match(server, /mapWithConcurrency\(fetchJobs, 10/)
assert.match(server, /makerworld_import_batches/)
assert.doesNotMatch(server.slice(server.indexOf("async function runMakerworldBatchImport"), server.indexOf("async function importMakerworldPayload")), /license.*(?:reject|block|deny)/i)

console.log("makerworld batch import tests passed")
