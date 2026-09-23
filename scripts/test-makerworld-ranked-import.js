"use strict"

const assert = require("assert")
const fs = require("fs")
const path = require("path")
const {
  FALLBACK_CATEGORIES,
  RANKING_SORTS,
  prepareRankingRequest,
  rankingCategories,
  rankingDesignUrls
} = require("../cms/makerworld-ranked-import")

const categories = rankingCategories({
  navs: [
    { name: "Following", key: "Following", type: 3 },
    { name: "Trending", key: "Trending", type: 2 },
    { name: "Tools", key: "category_700", type: 2 },
    { name: "Bad", key: "../../bad", type: 2 }
  ]
}, {
  children: [
    { id: 700, name: "工具", children: [{ id: 701, name: "收纳工具" }, { id: 705, name: "小工具" }] }
  ]
})
assert.deepStrictEqual(categories, [
  { key: "Trending", label: "热门", children: [] },
  {
    key: "category_700",
    label: "工具",
    children: [
      { key: "category_701", label: "收纳工具" },
      { key: "category_705", label: "小工具" }
    ]
  }
])
assert.strictEqual(FALLBACK_CATEGORIES.length, 13)
assert.ok(rankingCategories({ navs: [{ name: "Tools", key: "category_700", type: 2 }] })[0].children.length > 0)
assert.deepStrictEqual(RANKING_SORTS.map(item => item.key), ["hotScore", "boosts", "newUploads", "downloadCount", "likeCount"])
assert.deepStrictEqual(prepareRankingRequest({ categoryKey: "category_700", subcategoryKey: "category_701", orderBy: "downloadCount", limit: 30 }, categories), {
  categoryKey: "category_700",
  subcategoryKey: "category_701",
  orderBy: "downloadCount",
  limit: 30
})
assert.throws(() => prepareRankingRequest({ categoryKey: "category_700", subcategoryKey: "category_503", limit: 20 }, categories), /二级类目无效/)
assert.throws(() => prepareRankingRequest({ categoryKey: "../../bad", limit: 20 }, categories), /类目无效/)
assert.throws(() => prepareRankingRequest({ categoryKey: "Trending", orderBy: "score", limit: 20 }, categories), /排名方式无效/)
assert.throws(() => prepareRankingRequest({ categoryKey: "Trending", limit: 101 }, categories), /1 到 100/)

assert.deepStrictEqual(rankingDesignUrls({ hits: [{ id: 123 }, { id: 123 }, { id: "456" }, { id: "bad" }] }, 10), [
  "https://makerworld.com.cn/zh/models/123",
  "https://makerworld.com.cn/zh/models/456"
])

const server = fs.readFileSync(path.join(__dirname, "../cms/server.js"), "utf8")
const admin = fs.readFileSync(path.join(__dirname, "../cms/admin.html"), "utf8")
assert.match(server, /\/api\/admin\/makerworld\/ranking-options/)
assert.match(server, /\/api\/admin\/makerworld\/import-ranked/)
assert.match(server, /search-service\/select\/design2/)
assert.match(server, /design-service\/design\/category/)
assert.match(server, /query\.categories = numericCategory\[1\]/)
assert.match(admin, /按类目导入榜单/)
assert.match(admin, /makerworldRankingLimit/)
assert.match(admin, /makerworldRankingSubcategory/)
assert.match(admin, /data-makerworld-import-tab="batch"/)
assert.match(admin, /makerworld-history-table/)
assert.doesNotMatch(admin, /id="runMakerworldSyncBtn"/)
assert.doesNotMatch(admin, /id="productImportExcel"/)
assert.doesNotMatch(admin, /id="previewProductImportBtn"/)
assert.match(admin, /data-action="bulk-delete"/)
assert.match(admin, /data-action="bulk-hot-on"/)
assert.match(admin, /modelAuthorizationStatus === "approved"/)

console.log("makerworld ranked import tests passed")
