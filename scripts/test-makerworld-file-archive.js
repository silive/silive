"use strict"

const assert = require("assert")
const { findDownloadUrl, safeArchiveFilename } = require("../cms/makerworld-file-archive")

assert.strictEqual(safeArchiveFilename(' 公路/之王:*? "测试". '), "公路_之王___ _测试_.3mf")
assert.strictEqual(safeArchiveFilename(""), "MakerWorld模型.3mf")
assert.strictEqual(findDownloadUrl({ data: { coverUrl: "https://cdn.example/a.jpg", file: { downloadUrl: "https://cdn.example/model.3mf?x=1" } } }), "https://cdn.example/model.3mf?x=1")
assert.strictEqual(findDownloadUrl({ data: { message: "none" } }), "")

console.log("makerworld file archive tests passed")
