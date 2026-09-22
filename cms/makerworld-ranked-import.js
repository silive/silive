"use strict"

const CATEGORY_LABELS = {
  Trending: "热门",
  category_400: "家用",
  category_800: "玩具和游戏",
  category_700: "工具",
  category_300: "爱好和 DIY",
  category_900: "3D打印机",
  category_100: "艺术",
  category_600: "微缩模型",
  category_1000: "道具和角色扮演",
  category_200: "时尚",
  category_2000: "生成器模型",
  category_500: "教育",
  LaserCut: "激光与刀切"
}

const FALLBACK_CATEGORIES = Object.entries(CATEGORY_LABELS).map(([key, label]) => ({ key, label }))

const RANKING_SORTS = [
  { key: "hotScore", label: "热门" },
  { key: "boosts", label: "助力数" },
  { key: "newUploads", label: "最新" },
  { key: "downloadCount", label: "下载量" },
  { key: "likeCount", label: "点赞量" }
]

function rankingCategories(payload) {
  const navs = Array.isArray(payload?.navs) ? payload.navs : []
  const categories = navs
    .filter(item => item && item.type === 2 && /^(?:Trending|LaserCut|category_\d+)$/.test(String(item.key || "")))
    .map(item => ({
      key: String(item.key),
      label: CATEGORY_LABELS[item.key] || String(item.name || item.nameTracking || item.key)
    }))
  return categories.length ? categories : FALLBACK_CATEGORIES
}

function prepareRankingRequest(input = {}, categories = FALLBACK_CATEGORIES) {
  const allowedCategories = new Set(categories.map(item => item.key))
  const allowedSorts = new Set(RANKING_SORTS.map(item => item.key))
  const categoryKey = String(input.categoryKey || "Trending").trim()
  const orderBy = String(input.orderBy || "hotScore").trim()
  const limit = Number(input.limit == null ? 20 : input.limit)
  if (!allowedCategories.has(categoryKey)) throw new Error("MakerWorld 类目无效")
  if (!allowedSorts.has(orderBy)) throw new Error("MakerWorld 排名方式无效")
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("导入数量必须是 1 到 100 的整数")
  return { categoryKey, orderBy, limit }
}

function rankingDesignUrls(payload, limit) {
  const hits = Array.isArray(payload?.hits) ? payload.hits : []
  const seen = new Set()
  const urls = []
  for (const item of hits) {
    const id = String(item?.id || "").trim()
    if (!/^\d+$/.test(id) || seen.has(id)) continue
    seen.add(id)
    urls.push(`https://makerworld.com.cn/zh/models/${id}`)
    if (urls.length >= limit) break
  }
  return urls
}

module.exports = {
  FALLBACK_CATEGORIES,
  RANKING_SORTS,
  prepareRankingRequest,
  rankingCategories,
  rankingDesignUrls
}
