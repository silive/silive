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

const FALLBACK_CATEGORY_TREE = [
  ["category_900", "3D打印机", [[901, "3D打印机配件"], [902, "3D打印机零件"], [903, "测试模型"]]],
  ["category_100", "艺术", [[101, "2D艺术"], [103, "硬币和徽章"], [102, "标志和标识"], [104, "雕塑"], [105, "其他艺术模型"]]],
  ["category_500", "教育", [[503, "生物学"], [505, "化学"], [501, "工程学"], [506, "地理"], [502, "数学"], [504, "物理和天文学"], [507, "其他教育模型"]]],
  ["category_200", "时尚", [[201, "包"], [202, "衣服"], [206, "耳环"], [204, "鞋类"], [203, "眼镜"], [208, "珠宝"], [205, "戒指"], [207, "其他时尚模型"]]],
  ["category_300", "爱好和 DIY", [[301, "电子"], [303, "音乐"], [304, "遥控"], [305, "机器人"], [306, "运动和户外"], [302, "车辆"], [307, "其他爱好和DIY模型"]]],
  ["category_400", "家用", [[401, "装饰品"], [403, "节日"], [402, "花园"], [404, "办公室"], [405, "宠物"], [406, "其他家用模型"]]],
  ["category_600", "微缩模型", [[601, "动物"], [602, "建筑"], [603, "生物"], [604, "人物"], [605, "其他微缩模型"]]],
  ["category_1000", "道具和角色扮演", [[1003, "服装"], [1001, "面具和头盔"], [1002, "道具武器"], [1004, "其他道具和角色扮演"]]],
  ["category_700", "工具", [[705, "小工具"], [703, "手工工具"], [704, "机械工具"], [702, "测量工具"], [707, "医疗工具"], [701, "收纳工具"], [706, "其他工具"]]],
  ["category_800", "玩具和游戏", [[802, "桌游"], [801, "角色"], [803, "户外玩具"], [804, "拼图"], [806, "拼装玩具"], [805, "其他玩具和游戏"]]],
  ["category_2000", "生成器模型", [[2001, "Hueforge & 浮雕"], [2002, "标牌定制器"], [2003, "花瓶生成器"], [2004, "像素生成器"], [2005, "浮雕生成器"], [2006, "AI 扫描仪"], [2007, "图像钥匙扣生成器"], [2008, "桌面收纳盒生成器"], [2009, "精灵生成器"], [2010, "雕像生成器"], [2011, "圣诞挂饰定制器"], [2012, "镂空灯罩生成器"]]]
]

const FALLBACK_CATEGORIES = [
  { key: "Trending", label: "热门", children: [] },
  ...FALLBACK_CATEGORY_TREE.map(([key, label, children]) => ({
    key,
    label,
    children: children.map(([id, childLabel]) => ({ key: `category_${id}`, label: childLabel }))
  })),
  { key: "LaserCut", label: "激光与刀切", children: [] }
]

const RANKING_SORTS = [
  { key: "hotScore", label: "热门" },
  { key: "boosts", label: "助力数" },
  { key: "newUploads", label: "最新" },
  { key: "downloadCount", label: "下载量" },
  { key: "likeCount", label: "点赞量" }
]

function rankingCategories(payload, categoryTree) {
  const navs = Array.isArray(payload?.navs) ? payload.navs : []
  const treeItems = Array.isArray(categoryTree?.children) ? categoryTree.children : []
  const treeByKey = new Map(treeItems.map(item => [`category_${item.id}`, item]))
  const fallbackByKey = new Map(FALLBACK_CATEGORIES.map(item => [item.key, item]))
  const categories = navs
    .filter(item => item && item.type === 2 && /^(?:Trending|LaserCut|category_\d+)$/.test(String(item.key || "")))
    .map(item => {
      const key = String(item.key)
      const treeItem = treeByKey.get(key)
      const children = Array.isArray(treeItem?.children)
        ? treeItem.children
            .filter(child => Number.isInteger(Number(child?.id)) && Number(child.id) > 0)
            .map(child => ({ key: `category_${Number(child.id)}`, label: String(child.name || child.id) }))
        : (fallbackByKey.get(key)?.children || [])
      return {
        key,
        label: String(treeItem?.name || CATEGORY_LABELS[key] || item.name || item.nameTracking || key),
        children
      }
    })
  return categories.length ? categories : FALLBACK_CATEGORIES
}

function prepareRankingRequest(input = {}, categories = FALLBACK_CATEGORIES) {
  const allowedCategories = new Set(categories.map(item => item.key))
  const allowedSorts = new Set(RANKING_SORTS.map(item => item.key))
  const categoryKey = String(input.categoryKey || "Trending").trim()
  const subcategoryKey = String(input.subcategoryKey || "").trim()
  const orderBy = String(input.orderBy || "hotScore").trim()
  const limit = Number(input.limit == null ? 20 : input.limit)
  if (!allowedCategories.has(categoryKey)) throw new Error("MakerWorld 类目无效")
  const category = categories.find(item => item.key === categoryKey)
  const allowedSubcategories = new Set((category?.children || []).map(item => item.key))
  if (subcategoryKey && !allowedSubcategories.has(subcategoryKey)) throw new Error("MakerWorld 二级类目无效")
  if (!allowedSorts.has(orderBy)) throw new Error("MakerWorld 排名方式无效")
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("导入数量必须是 1 到 100 的整数")
  return { categoryKey, subcategoryKey, orderBy, limit }
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
