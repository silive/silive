"use strict"

const assert = require("assert")
const { importDecision, normalizeLicense, planSync } = require("../cms/makerworld-catalog-sync")

assert.strictEqual(normalizeLicense("CC BY 4.0"), "CC_BY_4_0")
assert.strictEqual(normalizeLicense("Standard Digital File License"), "STANDARD_DIGITAL_FILE")

const model = {
  id: "849446",
  sourceUrl: "https://makerworld.com.cn/zh/models/849446-mi-ta",
  title: "米塔",
  author: "南波万",
  license: "Standard Digital File License",
  imageUrl: "https://example.com/mita.jpg",
  rights: { commercialUseAllowed: false, listingMediaReuseAllowed: false, sourceVerified: false },
  metrics: { downloads: 1000, likes: 200, boosts: 40, makes: 80, rating: 4.9 }
}
assert.strictEqual(importDecision(model).importable, true)
assert.strictEqual(importDecision({ ...model, license: "Non-Commercial / 非商用" }).importable, true)
assert.strictEqual(importDecision({ ...model, license: "", rights: {} }).importable, true)
assert.strictEqual(importDecision({ ...model, author: "", imageUrl: "", license: "未知" }).importable, true)
assert.strictEqual(importDecision({ ...model, title: "" }).importable, false)

const result = planSync({ items: [model, { ...model, id: "999", sourceUrl: "https://makerworld.com.cn/zh/models/999-test", license: "CC BY-NC-SA 4.0" }] }, [], { defaultPrice: "39.9" })
assert.strictEqual(result.report.created, 2)
assert.strictEqual(result.report.pendingReview, 2)
assert.strictEqual(result.products.every(item => item.status === "off"), true)
assert.strictEqual(result.products.every(item => item.modelAuthorizationStatus === "pending_review"), true)
assert.strictEqual(result.products[0].modelLicenseRaw, "Standard Digital File License")

const approvedExisting = planSync({ items: [{ ...model, license: "Non-Commercial / 非商用" }] }, [{
  id: "MW849446",
  name: "Existing",
  status: "on",
  modelCandidateId: "849446",
  modelAuthorizationStatus: "approved"
}], {})
assert.strictEqual(approvedExisting.products[0].status, "on")
assert.strictEqual(approvedExisting.products[0].modelAuthorizationStatus, "approved")
assert.strictEqual(approvedExisting.products[0].modelLicenseRaw, "Non-Commercial / 非商用")

console.log("makerworld manual review sync tests passed")
