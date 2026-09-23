"use strict"

const assert = require("assert")
const fs = require("fs")
const path = require("path")
const { classifyMakerworldSourceResponse } = require("../cms/makerworld-source-availability")

assert.deepStrictEqual(classifyMakerworldSourceResponse(200, { id: 123 }, "123"), { status: "available" })
assert.deepStrictEqual(classifyMakerworldSourceResponse(200, { data: { id: 123 } }, "123"), { status: "available" })
assert.deepStrictEqual(classifyMakerworldSourceResponse(404, {}, "123"), { status: "unavailable", reason: "MakerWorld 返回 HTTP 404" })
assert.deepStrictEqual(classifyMakerworldSourceResponse(410, {}, "123"), { status: "unavailable", reason: "MakerWorld 返回 HTTP 410" })
assert.strictEqual(classifyMakerworldSourceResponse(500, {}, "123").status, "uncertain")
assert.strictEqual(classifyMakerworldSourceResponse(200, { id: 456 }, "123").status, "uncertain")

const server = fs.readFileSync(path.join(__dirname, "../cms/server.js"), "utf8")
const admin = fs.readFileSync(path.join(__dirname, "../cms/admin.html"), "utf8")
assert.match(server, /product\.status = "off"/)
assert.match(server, /product\.modelInfoStatus = "source_unavailable"/)
assert.match(server, /来源已恢复；商品保持下架/)
assert.match(server, /sourceStatus === "source_unavailable"/)
assert.match(server, /startMakerworldAvailabilityWorker\(\)/)
assert.match(server, /\/api\/admin\/makerworld\/check-availability/)
assert.match(admin, /来源已失效/)
assert.match(admin, /makerworldInfoStatusText/)

console.log("makerworld source availability tests passed")
