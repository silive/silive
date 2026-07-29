const assert = require("assert")

const {
  buildOrderPaidMarkdown,
  buildTestMarkdown,
  deliveryArea,
  orderItems,
  phoneTail,
  redactWebhook,
  retryDelayMinutes,
  sendWecomMarkdown
} = require("../cms/wecom-order-notifier")

async function main() {
  const order = {
    id: "FC202607290001",
    phone: "13812345678",
    address: "陕西省汉中市汉台区某街道88号2单元",
    amount: "39.80",
    deliveryType: "delivery",
    paidAt: "2026-07-29 14:15:00",
    remark: "购物车：商品一x1，商品二x2，商品三x1，商品四x1，商品五x1，商品六x1\n8月1日前需要",
    openid: "sensitive-openid"
  }
  const content = buildOrderPaidMarkdown(order)
  assert(content.includes("另有1项商品"))
  assert(content.includes("¥39.80"))
  assert(content.includes("尾号5678"))
  assert(content.includes("陕西省汉中市汉台区"))
  assert(!content.includes("13812345678"))
  assert(!content.includes("某街道"))
  assert(!content.includes("sensitive-openid"))
  assert(!content.includes("undefined"))
  assert(!content.includes("null"))
  assert.strictEqual(orderItems(order).length, 6)
  assert.strictEqual(phoneTail(order.phone), "5678")
  assert.strictEqual(deliveryArea(order.address), "陕西省汉中市汉台区")

  const payloads = []
  await sendWecomMarkdown({
    webhookUrl: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test-secret",
    content,
    requester: async (url, payload) => {
      payloads.push({ url, payload })
      return { statusCode: 200, data: { errcode: 0, errmsg: "ok" } }
    }
  })
  assert.strictEqual(payloads.length, 1)

  await assert.rejects(() => sendWecomMarkdown({
    webhookUrl: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test-secret",
    content,
    requester: async () => ({ statusCode: 200, data: { errcode: 93000, errmsg: "invalid webhook" } })
  }), /93000/)
  await assert.rejects(() => sendWecomMarkdown({
    webhookUrl: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test-secret",
    content,
    requester: async () => ({ statusCode: 500, data: {} })
  }), /HTTP失败/)

  assert.deepStrictEqual([1, 2, 3, 4].map(retryDelayMinutes), [1, 5, 15, 0])
  assert(!redactWebhook("failed https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=secret-value").includes("secret-value"))
  assert(buildTestMarkdown({ environment: "test", serviceName: "very-simple-cms" }).includes("订单提醒测试成功"))

  console.log(JSON.stringify({
    ok: true,
    privacyMasked: true,
    multiItemFormatting: true,
    http200ErrcodeChecked: true,
    retrySchedule: [1, 5, 15],
    webhookRedacted: true
  }, null, 2))
}

main().catch(error => {
  console.error(error.message)
  process.exit(1)
})
