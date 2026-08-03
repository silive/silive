"use strict"

function isAiPreviewEnabled(value = process.env.AI_PREVIEW_ENABLED) {
  return String(value || "").trim().toLowerCase() === "true"
}

function aiPreviewRouteDecision({ enabled, isAdmin, method }) {
  if (!enabled || method !== "POST" || !isAdmin) {
    return { status: 404, message: "Not found" }
  }
  return { status: 200 }
}

module.exports = {
  aiPreviewRouteDecision,
  isAiPreviewEnabled
}
