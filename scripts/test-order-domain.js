"use strict"

const assert = require("assert")
const {
  canonicalRequestHash,
  normalizeInventoryMode,
  orderItemSnapshot,
  strictPositiveInteger,
  validateOrderItems,
  validateRefundItems,
  yuanToCents
} = require("../cms/order-domain")

assert.strictEqual(strictPositiveInteger("3"), 3)
for (const invalid of [0, -1, 1.5, "1.5", "1e2", "Infinity", NaN, Infinity, 100]) {
  assert.throws(() => strictPositiveInteger(invalid))
}

assert.strictEqual(yuanToCents("39.80"), 3980)
assert.throws(() => yuanToCents("1.005"))
assert.throws(() => yuanToCents("-1"))

assert.strictEqual(normalizeInventoryMode({ stockMode: "FINITE" }), "FINITE")
assert.strictEqual(normalizeInventoryMode({ productType: "normal", stock: 0 }), "UNLIMITED")
assert.strictEqual(normalizeInventoryMode({ productType: "custom", stock: 100 }), "MADE_TO_ORDER")

const first = orderItemSnapshot({ id: "P1", name: "A", price: "10.00", productType: "normal", stock: 5 }, 3, {
  id: "OI1",
  skuId: "RED"
})
const second = orderItemSnapshot({ id: "P2", name: "B", price: "20.00", productType: "custom" }, 1, {
  id: "OI2",
  skuId: "L"
})
assert.strictEqual(first.paidAmountCents, 3000)
assert.strictEqual(second.inventoryMode, "MADE_TO_ORDER")
assert.strictEqual(validateOrderItems([first, second]).length, 2)

const refund = validateRefundItems([first, second], [], [
  { orderItemId: "OI1", quantity: 1 },
  { orderItemId: "OI2", quantity: 1, refundAmountCents: 1500 }
])
assert.deepStrictEqual(refund.map(item => item.productRefundCents), [1000, 1500])
assert.throws(() => validateRefundItems([first], [
  { orderItemId: "OI1", refundQuantity: 2, status: "SUCCESS" }
], [{ orderItemId: "OI1", quantity: 2 }]))
assert.throws(() => validateRefundItems([first], [], [
  { orderItemId: "OI1", quantity: 1 },
  { orderItemId: "OI1", quantity: 1 }
]))

const hashA = canonicalRequestHash({ productId: "P1", quantity: 1, userToken: "secret", b: 2 })
const hashB = canonicalRequestHash({ b: 2, quantity: 1, productId: "P1", userToken: "other" })
const hashC = canonicalRequestHash({ productId: "P1", quantity: 2, b: 2 })
assert.strictEqual(hashA, hashB)
assert.notStrictEqual(hashA, hashC)

console.log("order domain tests passed")
