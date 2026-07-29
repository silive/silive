"use strict"

const crypto = require("crypto")

const ATTRIBUTION_TTL_MS = 30 * 24 * 60 * 60 * 1000

function hashAttributionToken(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("hex")
}

function issueAttributionToken() {
  return crypto.randomBytes(32).toString("base64url")
}

function hashAnonymousVisitor(visitorId) {
  const value = String(visitorId || "").trim()
  return value ? crypto.createHash("sha256").update(value).digest("hex") : ""
}

function safeAttributionSource(value) {
  return String(value || "")
    .replace(/[^\w:/.-]/g, "")
    .slice(0, 80)
}

module.exports = {
  ATTRIBUTION_TTL_MS,
  hashAnonymousVisitor,
  hashAttributionToken,
  issueAttributionToken,
  safeAttributionSource
}
