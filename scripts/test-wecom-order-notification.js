const fs = require("fs")
const path = require("path")

const {
  buildTestMarkdown,
  safeError,
  sendWecomMarkdown
} = require("../cms/wecom-order-notifier")

function loadEnv(file) {
  if (!fs.existsSync(file)) return
  for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith("#")) continue
    const index = line.indexOf("=")
    if (index < 1) continue
    const key = line.slice(0, index).trim()
    let value = line.slice(index + 1).trim()
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) value = value.slice(1, -1)
    if (process.env[key] == null) process.env[key] = value
  }
}

async function main() {
  if (process.env.WECOM_TEST_SKIP_DOTENV !== "true") loadEnv(path.join(__dirname, "..", ".env"))
  const webhookUrl = String(process.env.WECOM_ORDER_WEBHOOK_URL || "").trim()
  if (!webhookUrl) throw new Error("未配置 WECOM_ORDER_WEBHOOK_URL")
  await sendWecomMarkdown({
    webhookUrl,
    content: buildTestMarkdown({
      environment: process.env.NODE_ENV || "unknown",
      serviceName: process.env.PM2_NAME || "very-simple-cms",
      testTime: new Date()
    })
  })
  console.log(JSON.stringify({ ok: true, message: "企业微信订单提醒测试消息已发送" }))
}

main().catch(error => {
  console.error(safeError(error))
  process.exit(1)
})
