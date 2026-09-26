"use strict"

const assert = require("assert")
const { oauthAuthorizeUrl } = require("../cms/baidu-netdisk")

const url = new URL(oauthAuthorizeUrl({ appKey: "test-key", redirectUri: "https://example.com/callback", state: "abc" }))
assert.strictEqual(url.hostname, "openapi.baidu.com")
assert.strictEqual(url.searchParams.get("client_id"), "test-key")
assert.strictEqual(url.searchParams.get("redirect_uri"), "https://example.com/callback")
assert.strictEqual(url.searchParams.get("scope"), "basic,netdisk")
assert.strictEqual(url.searchParams.get("state"), "abc")

console.log("baidu netdisk tests passed")
