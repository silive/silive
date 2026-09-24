"use strict"

const assert = require("assert")
const fs = require("fs")
const path = require("path")
const {
  manifestCsv,
  matchReplacementFilename,
  productMainImageSizeMessage,
  replacementFilename,
  replacementStem
} = require("../cms/makerworld-main-image-package")

const products = [
  { id: "MW123", modelCandidateId: "123", name: "模型 A" },
  { id: "MW456", modelCandidateId: "456", name: "模型 B" }
]

assert.strictEqual(replacementStem(products[0]), "MW-123__PID-MW123")
assert.strictEqual(replacementFilename(products[0], "png"), "MW-123__PID-MW123.png")
assert.strictEqual(matchReplacementFilename("MW-123__PID-MW123_gpt.png", products).product.id, "MW123")
assert.strictEqual(matchReplacementFilename("PID-MW456-final.webp", products).product.id, "MW456")
assert.strictEqual(matchReplacementFilename("MW-456_ecommerce.jpg", products).product.id, "MW456")
assert.strictEqual(matchReplacementFilename("random.png", products).product, null)
assert.match(productMainImageSizeMessage(1200, 1024), /符合 1200×1024px/)
assert.match(productMainImageSizeMessage(1024, 1024), /建议使用 1200×1024px/)
assert.match(manifestCsv([{
  productId: "MW123",
  modelId: "123",
  title: "模型, A",
  originalImageUrl: "https://example.com/a.jpg",
  originalFilename: "MW-123__PID-MW123.jpg",
  suggestedFilename: "MW-123__PID-MW123_gpt.png"
}]), /"模型, A"/)

const server = fs.readFileSync(path.join(__dirname, "../cms/server.js"), "utf8")
const admin = fs.readFileSync(path.join(__dirname, "../cms/admin.html"), "utf8")
assert.match(server, /\/api\/admin\/makerworld\/main-image-package/)
assert.match(server, /main-image-replacements\/preview/)
assert.match(server, /main-image-replacements\/direct-preview/)
assert.match(server, /main-image-replacements\/confirm/)
assert.match(server, /main-image-replacements\/rollback/)
assert.match(server, /product\.imageUrl \|\| product\.mainImage/)
assert.match(admin, /打包下载导入主图/)
assert.match(admin, /上传已命名 ZIP/)
assert.match(admin, /确认批量替换/)
assert.match(admin, /1200×1024/)
assert.match(admin, /正在上传\.\.\./)
assert.match(admin, /直接上传 GPT 成图/)
assert.match(admin, /主图上传失败/)
assert.match(admin, /data-direct-image-index/)
assert.match(admin, /makerworld-direct-item img/)
assert.match(admin, /登录已过期，请重新登录后台/)
assert.match(admin, /scrollIntoView/)
assert.doesNotMatch(server, /制作 1:1 电商主图/)
assert.match(server, /1200×1024px/)

console.log("makerworld main image package tests passed")
