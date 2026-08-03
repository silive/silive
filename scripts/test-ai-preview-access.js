"use strict"

const assert = require("assert")
const fs = require("fs")
const path = require("path")
const {
  aiPreviewRouteDecision,
  isAiPreviewEnabled
} = require("../cms/ai-preview-access")

assert.strictEqual(isAiPreviewEnabled(undefined), false, "AI preview must be disabled when the flag is absent")
assert.strictEqual(isAiPreviewEnabled("false"), false, "AI preview must require an explicit true flag")
assert.strictEqual(isAiPreviewEnabled("true"), true, "AI preview can be explicitly enabled for a future controlled rollout")

const disabledAnonymous = aiPreviewRouteDecision({ enabled: false, isAdmin: false, method: "POST" })
const disabledSignedInUser = aiPreviewRouteDecision({ enabled: false, isAdmin: true, method: "POST" })
const enabledAnonymous = aiPreviewRouteDecision({ enabled: true, isAdmin: false, method: "POST" })
const enabledAdminGet = aiPreviewRouteDecision({ enabled: true, isAdmin: true, method: "GET" })
const enabledAdminPost = aiPreviewRouteDecision({ enabled: true, isAdmin: true, method: "POST" })

assert.strictEqual(disabledAnonymous.status, 404, "anonymous callers must receive 404 while the feature is disabled")
assert.strictEqual(disabledSignedInUser.status, 404, "signed-in callers must receive 404 while the feature is disabled")
assert.strictEqual(enabledAnonymous.status, 404, "the feature must never be anonymously accessible")
assert.strictEqual(enabledAdminGet.status, 404, "only the explicit admin POST route may execute")
assert.strictEqual(enabledAdminPost.status, 200, "an explicitly enabled admin POST may execute")

const serverSource = fs.readFileSync(path.join(__dirname, "..", "cms", "server.js"), "utf8")
assert.match(serverSource, /aiPreviewRouteDecision\(\{[\s\S]{0,240}enabled: AI_PREVIEW_ENABLED[\s\S]{0,240}isAdmin: isAuthed\(req\)/, "the server route must use the default-off access guard")

console.log("AI preview access tests passed")
