"use strict"

const assert = require("assert")
const {
  autoPublishDecision,
  normalizeLicense,
  planSync
} = require("../cms/makerworld-catalog-sync")

assert.strictEqual(normalizeLicense("CC BY 4.0"), "CC_BY_4_0")
assert.strictEqual(normalizeLicense("Standard Digital File License"), "STANDARD_DIGITAL_FILE")

const allowed = {
  id: "493632",
  sourceUrl: "https://makerworld.com.cn/zh/models/493632-dummy",
  title: "Dummy 13",
  author: "Lucky 13 Toys",
  license: "CC BY 4.0",
  imageUrl: "https://cdn.example.com/dummy.jpg",
  rights: { commercialUseAllowed: true, listingMediaReuseAllowed: true, sourceVerified: true },
  metrics: { downloads: 1000, likes: 200, boosts: 40, makes: 80, rating: 4.9 }
}
assert.strictEqual(autoPublishDecision(allowed).eligible, true)
assert.strictEqual(autoPublishDecision({ ...allowed, license: "CC BY-NC 4.0" }).eligible, false)
assert.strictEqual(autoPublishDecision({ ...allowed, license: "Standard Digital File License" }).eligible, false)
assert.strictEqual(autoPublishDecision({ ...allowed, rights: { commercialUseAllowed: true } }).eligible, false)

const result = planSync({ items: [allowed, { ...allowed, id: "999", sourceUrl: "https://makerworld.com.cn/zh/models/999-test", license: "CC BY-NC-SA 4.0" }] }, [], { autoPublish: true, defaultPrice: "39.9" })
assert.strictEqual(result.report.created, 2)
assert.strictEqual(result.report.autoPublished, 1)
assert.strictEqual(result.report.drafts, 1)
assert.strictEqual(result.products.find(item => item.modelCandidateId === "999").status, "off")

const revoked = planSync({ items: [{ ...allowed, license: "Standard Digital File License" }] }, [{
  id: "MW493632",
  name: "Existing",
  status: "on",
  modelCandidateId: "493632"
}], { autoPublish: true })
assert.strictEqual(revoked.products[0].status, "off")
assert.strictEqual(revoked.report.updated, 1)

console.log("makerworld catalog sync tests passed")
