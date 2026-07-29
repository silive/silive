"use strict"

const assert = require("assert")
const fs = require("fs")
const path = require("path")

const root = path.resolve(__dirname, "..")
const server = fs.readFileSync(path.join(root, "cms/server.js"), "utf8")
const auth = fs.readFileSync(path.join(root, "utils/auth.js"), "utf8")

assert.match(server, /url\.pathname === "\/api\/auth\/logout"/)
assert.match(server, /DELETE FROM user_sessions WHERE token_hash=:tokenHash/)
assert.match(auth, /await request\("\/api\/auth\/logout"/)
assert.match(server, /UNIQUE KEY uniq_order_idempotency_scope \(user_id, operation, request_key\)/)
assert.match(server, /request_hash CHAR\(64\) NOT NULL/)
assert.doesNotMatch(
  server.slice(server.indexOf("async function savePromotionRelations"), server.indexOf("async function getPromotionVisits")),
  /DELETE FROM promotion_relations/
)
assert.match(server, /CREATE TABLE IF NOT EXISTS promotion_relation_claims/)
assert.match(server, /SELECT \* FROM promotion_relations WHERE invitee_phone=:inviteePhone LIMIT 1 FOR UPDATE/)
assert.match(server, /if \(order\.userId\) return false/)
assert.match(server, /user_id=:userId/)
assert.doesNotMatch(
  server.slice(server.indexOf("async function backfillOrderIdentity"), server.indexOf("async function markOrderPaid")),
  /user_token\s*=/
)

console.log("session and promotion security tests passed")
