"use strict"

const assert = require("assert")
const { calculatePrice, extractPrintMetadata, normalizePricingSettings, profileIdFromUrl } = require("../cms/makerworld-pricing")
const { buildProduct } = require("../cms/makerworld-catalog-sync")

assert.strictEqual(profileIdFromUrl("https://makerworld.com.cn/zh/models/1-demo#profileId-3463478"), "3463478")

const design = {
  defaultInstanceId: 10,
  instances: [
    { id: 10, prediction: 600, weight: 5, materialColorCnt: 1, needAms: false, extention: { modelInfo: { plates: [{}] } } },
    { id: 20, prediction: 3024, weight: 12, materialColorCnt: 4, needAms: true, title: "测试配置", extention: { modelInfo: { plates: [{}], compatibility: { devProductName: "A1" } } } }
  ]
}
const metadata = extractPrintMetadata(design, "https://makerworld.com.cn/zh/models/1-demo#profileId-20")
assert.deepStrictEqual({ profileId: metadata.profileId, plateCount: metadata.plateCount, printTimeSeconds: metadata.printTimeSeconds, weightGrams: metadata.weightGrams, colorCount: metadata.colorCount, needAms: metadata.needAms }, { profileId: "20", plateCount: 1, printTimeSeconds: 3024, weightGrams: 12, colorCount: 4, needAms: true })

const sum = calculatePrice(metadata, { enabled: true, mode: "sum", basePrice: 2, perGram: 0.5, perMinute: 0.1, perColor: 1, amsFee: 2, perPlate: 1, minimumPrice: 0, rounding: 0.1 })
assert.strictEqual(sum.price, "20.10")
assert.strictEqual(sum.parts.weight, 6)
assert.strictEqual(sum.parts.colors, 4)

const single = calculatePrice(metadata, { enabled: true, mode: "single", singleMetric: "weight", basePrice: 2, perGram: 0.5, perMinute: 10, rounding: 1 })
assert.strictEqual(single.price, "8.00")
assert.strictEqual(calculatePrice(metadata, { enabled: false }), null)
assert.strictEqual(normalizePricingSettings({ defaultStock: 100.9 }).defaultStock, 100)

const product = buildProduct({ modelId: "2951404", sourceUrl: "https://makerworld.com.cn/zh/models/2951404-demo", title: "测试模型", modelPrintMetadata: metadata }, { defaultStock: 100, pricing: { enabled: true, mode: "single", singleMetric: "weight", perGram: 0.5, rounding: 0.1 } })
assert.strictEqual(product.price, "6.00")
assert.strictEqual(product.stock, "100")
assert.strictEqual(product.stockMode, "FINITE")
assert.strictEqual(product.modelPrintMetadata.profileId, "20")
assert.strictEqual(product.modelPrintMetadata.autoPriced, true)

console.log("makerworld pricing tests passed")
