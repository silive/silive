"use strict"

function classifyMakerworldSourceResponse(statusCode, payload, modelId) {
  const code = Number(statusCode || 0)
  if ([404, 410].includes(code)) return { status: "unavailable", reason: `MakerWorld 返回 HTTP ${code}` }
  const body = payload?.data && typeof payload.data === "object" ? payload.data : payload
  if (code >= 200 && code < 300 && String(body?.id || "") === String(modelId || "")) return { status: "available" }
  return { status: "uncertain", reason: `MakerWorld 返回 HTTP ${code}，未确认模型状态` }
}

module.exports = { classifyMakerworldSourceResponse }
