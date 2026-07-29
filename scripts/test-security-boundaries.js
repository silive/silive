"use strict"

const assert = require("assert")
const fs = require("fs")
const path = require("path")

const root = path.resolve(__dirname, "..")
const server = fs.readFileSync(path.join(root, "cms/server.js"), "utf8")

const publicProductStart = server.indexOf("function publicProductView")
const publicProductEnd = server.indexOf("function homepageRecommendedProducts", publicProductStart)
const publicProduct = server.slice(publicProductStart, publicProductEnd)
for (const field of [
  "costPrice",
  "rewardEnabled",
  "firstReward",
  "secondReward",
  "modelCandidateId",
  "modelSourceUrl",
  "modelAuthorName",
  "modelAuthorizationStatus",
  "modelAuthorizationNote",
  "inventoryVersion"
]) {
  assert.match(publicProduct, new RegExp(`\\b${field}\\b`))
}
assert.match(server, /filter\(isPublicProduct\)\.map\(publicProductView\)/)
assert.match(server, /!product \|\| !isPublicProduct\(product\)/)

const pickupSecurity = fs.readFileSync(path.join(root, "cms/pickup-security.js"), "utf8")
assert.match(pickupSecurity, /crypto\.randomInt/)
assert.doesNotMatch(pickupSecurity, /Math\.random/)
assert.match(server, /CREATE TABLE IF NOT EXISTS pickup_code_claims/)
assert.match(server, /LIMIT 1 FOR UPDATE/)
assert.match(server, /checkPickupVerificationRateLimit/)
assert.match(server, /取货码无效或当前不可核销/)

assert.match(server, /MAX_UPLOAD_CONCURRENT/)
assert.match(server, /MAX_UPLOAD_MEMORY_BYTES/)
assert.match(server, /function reserveUploadRequest/)
assert.match(server, /content-length/)
assert.match(server, /res\.once\("finish", releaseUpload\)/)

assert.match(server, /CREATE TABLE IF NOT EXISTS order_inventory_releases/)
assert.match(server, /releaseOrderInventory/)

assert.match(server, /STORAGE_MODE !== "mysql"/)
assert.match(server, /生产环境缺少必要依赖 mysql2，服务拒绝启动/)
assert.match(server, /X-Content-Type-Options/)
assert.match(server, /Content-Security-Policy/)
assert.match(server, /if \(IS_PRODUCTION\)[\s\S]{0,120}Not found/)

const saveProductsStart = server.indexOf("async function saveProducts")
const saveProductsEnd = server.indexOf("async function migrateProductCategoriesToCanonical", saveProductsStart)
const saveProducts = server.slice(saveProductsStart, saveProductsEnd)
assert.match(saveProducts, /beginTransaction/)
assert.match(saveProducts, /ON DUPLICATE KEY UPDATE/)
assert.match(saveProducts, /inventory_version/)
assert.match(saveProducts, /库存已发生变化/)
assert.doesNotMatch(saveProducts, /await query\("DELETE FROM products"\)/)

const salesCreateStart = server.indexOf("async function createSalesAgentCommissionForOrder")
const salesCreateEnd = server.indexOf("async function getSalesAgentSummary", salesCreateStart)
const salesFinance = server.slice(salesCreateStart, salesCreateEnd)
assert.match(salesFinance, /INSERT IGNORE INTO sales_agent_commissions/)
assert.match(salesFinance, /FOR UPDATE/)
assert.match(salesFinance, /status='cancelled'/)

console.log("security boundary tests passed")
