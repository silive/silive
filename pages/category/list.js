const { request } = require("../../utils/api")
const { applyTheme } = require("../../utils/theme")
const defaultData = require("../index/default-data")

const BADGE_TEXT = {
  new: "新品推荐",
  hot: "人气热卖",
  best: "爆品推荐",
  none: ""
}
const CATEGORY_VERSION_KEY = "categoryCatalogVersion"

function isNormalProduct(product = {}) {
  const categories = Array.isArray(product.categories) ? product.categories : []
  const type = String(product.productType || product.product_type || product.orderType || "").toLowerCase()
  const needCustom = String(product.needCustom || "").toLowerCase()
  return type === "normal" ||
    needCustom === "false" ||
    categories.some(item => ["日用好货", "食品饮料", "日用百货"].some(keyword => String(item).includes(keyword)))
}

function normalize(product) {
  return {
    ...product,
    categories: Array.isArray(product.categories) ? product.categories : [],
    badgeText: BADGE_TEXT[product.badge] || product.badge || "",
    isNormalProduct: isNormalProduct(product)
  }
}

function matchesCategory(product, category) {
  if (Array.isArray(product.categories) && product.categories.includes(category)) return true
  const text = `${product.name || ""} ${product.intro || ""}`
  const rules = {
    "3D打印": ["3D", "摆件", "建模", "宠物"],
    "激光雕刻": ["激光", "雕刻", "木", "金属"],
    "叶雕定制": ["叶雕", "真叶", "天然"],
    "名字礼物": ["名字", "钥匙扣", "刻字"]
  }
  return (rules[category] || []).some(keyword => text.includes(keyword))
}

const FALLBACK_SECONDARY = {
  "激光定制": ["亚克力夜灯", "木牌雕刻", "叶雕纪念"],
  "3D打印": ["零件加工", "工业打样", "手办打印"],
  "潮玩手办": ["解压玩具", "热门手办", "创意摆件"],
  "日用好货": ["食品饮料", "日用百货", "本地好物"]
}

function normalizeCategoryCatalog(value) {
  return (Array.isArray(value) ? value : [])
    .map((item, index) => ({
      name: item.name || "",
      sort: Number(item.sort || index + 1),
      children: (Array.isArray(item.children) ? item.children : [])
        .map((child, childIndex) => ({
          name: typeof child === "string" ? child : child.name || "",
          sort: Number((typeof child === "string" ? childIndex + 1 : child.sort) || childIndex + 1),
          comingSoon: typeof child === "string" ? "false" : String(child.comingSoon == null ? "false" : child.comingSoon)
        }))
        .filter(child => child.name)
        .sort((a, b) => a.sort - b.sort)
    }))
    .filter(item => item.name)
    .sort((a, b) => a.sort - b.sort)
}

function catalogVersion(catalog) {
  return JSON.stringify(catalog.map(item => ({
    name: item.name,
    sort: item.sort,
    children: item.children.map(child => `${child.name}:${child.sort}:${child.comingSoon}`)
  })))
}

function matchZone(product, primary, secondary) {
  const categories = Array.isArray(product.categories) ? product.categories : []
  const primaryOk = categories.includes(primary) || categories.some(category => category.indexOf(`${primary}/`) === 0) || matchesCategory(product, primary)
  if (!primaryOk) return false
  if (!secondary || secondary === "全部") return true
  return categories.includes(`${primary}/${secondary}`) || categories.includes(secondary) || `${product.name || ""} ${product.intro || ""}`.includes(secondary.replace(/加工|打印|雕刻|纪念|玩具|手办|摆件|夜灯/g, ""))
}

function normalizeKeyword(value) {
  return String(value || "").trim().toLowerCase()
}

function productMatchesKeyword(product, keyword) {
  if (!keyword) return true
  const fields = [
    product.name,
    product.intro,
    product.desc,
    product.badge,
    product.badgeText,
    ...(Array.isArray(product.categories) ? product.categories : [])
  ]
  return fields.join(" ").toLowerCase().includes(keyword)
}

function filterProducts(products, primary, secondary, ids, keyword) {
  const idList = String(ids || "").split(/[,，]/).map(item => item.trim()).filter(Boolean)
  const base = idList.length
    ? products.filter(product => idList.includes(product.id))
    : products.filter(product => matchZone(product, primary, secondary))
  return base.filter(product => productMatchesKeyword(product, keyword))
}

function buildSecondaryNav(products, primary, categoryCatalog) {
  const current = (categoryCatalog || []).find(item => item.name === primary)
  const fromCatalog = current ? current.children.map(child => child.name) : []
  const fromProducts = []
  products.forEach(product => {
    const categories = Array.isArray(product.categories) ? product.categories : []
    categories.forEach(category => {
      if (category.indexOf(`${primary}/`) === 0) fromProducts.push(category.split("/")[1])
    })
  })
  return ["全部", ...Array.from(new Set([...fromCatalog, ...(fromCatalog.length ? [] : (FALLBACK_SECONDARY[primary] || [])), ...fromProducts]))]
}

function fallbackCatalog() {
  const names = Object.keys(FALLBACK_SECONDARY)
  return names.map((name, index) => ({
    name,
    sort: index + 1,
    children: FALLBACK_SECONDARY[name].map((child, childIndex) => ({
      name: child,
      sort: childIndex + 1,
      comingSoon: "false"
    }))
  }))
}

function fallbackProducts() {
  return (defaultData.products || []).map(normalize)
}

function productCountForSecondary(products, primary, secondary) {
  if (secondary === "全部") return products.filter(product => matchZone(product, primary, "全部")).length
  return products.filter(product => matchZone(product, primary, secondary)).length
}

function secondaryMeta(primary, name, categoryCatalog) {
  const current = (categoryCatalog || []).find(item => item.name === primary)
  const child = current && current.children.find(item => item.name === name)
  return child || {}
}

function buildSecondaryItems(products, primary, secondaryNav, categoryCatalog) {
  return secondaryNav.map(name => {
    const count = productCountForSecondary(products, primary, name)
    const meta = secondaryMeta(primary, name, categoryCatalog)
    return {
      name,
      count,
      disabled: name !== "全部" && count === 0,
      comingSoon: String(meta.comingSoon) === "true"
    }
  })
}

Page({
  data: {
    category: "",
    primary: "",
    secondary: "全部",
    secondaryNav: ["全部"],
    secondaryItems: [{ name: "全部", count: 0, disabled: false }],
    categoryCatalog: [],
    contact: {},
    allProducts: [],
    products: [],
    ids: "",
    searchKeyword: "",
    themeStyle: "",
    themeClass: "theme-skin01",
    loading: true
  },

  onLoad(options) {
    applyTheme(this)
    const primary = decodeURIComponent(options.primary || options.category || "")
    const secondary = decodeURIComponent(options.secondary || "全部")
    const ids = decodeURIComponent(options.ids || "")
    wx.setNavigationBarTitle({ title: primary || "商品列表" })
    this.setData({ category: primary, primary, secondary, ids })
    this.loadProducts(primary, secondary, ids)
  },

  onShow() {
    applyTheme(this)
  },

  loadProducts(primary, secondary = "全部", ids = "") {
    Promise.all([
      request(`/api/home?t=${Date.now()}`, { timeout: 8000 }),
      request(`/api/products?t=${Date.now()}`, { timeout: 8000 })
    ]).then(([home, products]) => {
      const categoryCatalog = normalizeCategoryCatalog(home.categoryCatalog).length ? normalizeCategoryCatalog(home.categoryCatalog) : fallbackCatalog()
      const version = catalogVersion(categoryCatalog)
      if (version !== wx.getStorageSync(CATEGORY_VERSION_KEY)) {
        wx.setStorageSync(CATEGORY_VERSION_KEY, version)
      }
      const sourceProducts = Array.isArray(products) && products.length ? products : (home.products || defaultData.products || [])
      const allProducts = sourceProducts.filter(product => product.status !== "off").map(normalize)
      const secondaryNav = buildSecondaryNav(allProducts, primary, categoryCatalog)
      const nextSecondary = secondaryNav.includes(secondary) ? secondary : "全部"
      this.setData({
        allProducts,
        categoryCatalog,
        contact: home.contact || {},
        secondaryNav,
        secondaryItems: buildSecondaryItems(allProducts, primary, secondaryNav, categoryCatalog),
        secondary: nextSecondary,
        products: filterProducts(allProducts, primary, nextSecondary, ids, normalizeKeyword(this.data.searchKeyword)),
        loading: false
      })
    }).catch(() => {
      request(`/api/products?t=${Date.now()}`, { timeout: 8000 }).then(products => {
        const allProducts = (Array.isArray(products) && products.length ? products : defaultData.products).filter(product => product.status !== "off").map(normalize)
        const categoryCatalog = fallbackCatalog()
        const secondaryNav = buildSecondaryNav(allProducts, primary, categoryCatalog)
        this.setData({
          allProducts,
          categoryCatalog,
          secondaryNav,
          secondaryItems: buildSecondaryItems(allProducts, primary, secondaryNav, categoryCatalog),
          products: filterProducts(allProducts, primary, secondaryNav.includes(secondary) ? secondary : "全部", ids, normalizeKeyword(this.data.searchKeyword)),
          loading: false
        })
      }).catch(() => {
        const allProducts = fallbackProducts()
        const categoryCatalog = fallbackCatalog()
        const secondaryNav = buildSecondaryNav(allProducts, primary, categoryCatalog)
        this.setData({
          allProducts,
          categoryCatalog,
          secondaryNav,
          secondaryItems: buildSecondaryItems(allProducts, primary, secondaryNav, categoryCatalog),
          products: filterProducts(allProducts, primary, secondaryNav.includes(secondary) ? secondary : "全部", ids, normalizeKeyword(this.data.searchKeyword)),
          loading: false
        })
      })
    })
  },

  switchSecondary(event) {
    const secondary = event.currentTarget.dataset.name
    if (event.currentTarget.dataset.disabled === "true") {
      this.setData({ secondary })
      this.applyFilters({ secondary })
      return
    }
    this.setData({ secondary })
    this.applyFilters({ secondary })
  },

  onSearchInput(event) {
    const searchKeyword = event.detail.value || ""
    this.setData({ searchKeyword })
    this.applyFilters({ searchKeyword })
  },

  clearSearch() {
    this.setData({ searchKeyword: "" })
    this.applyFilters()
  },

  applyFilters(overrides = {}) {
    const products = filterProducts(
      this.data.allProducts,
      this.data.primary,
      overrides.secondary === undefined ? this.data.secondary : overrides.secondary,
      this.data.ids,
      normalizeKeyword(overrides.searchKeyword === undefined ? this.data.searchKeyword : overrides.searchKeyword)
    )
    this.setData({ products })
  },

  openProduct(event) {
    const product = this.data.products[event.currentTarget.dataset.index]
    wx.navigateTo({
      url: `/pages/product/detail?product=${encodeURIComponent(JSON.stringify(product))}`
    })
  },

  buyProduct(event) {
    const product = this.data.products[event.currentTarget.dataset.index]
    wx.navigateTo({
      url: `/pages/checkout/checkout?product=${encodeURIComponent(JSON.stringify(product))}`
    })
  },

  addToCart(event) {
    const product = this.data.products[event.currentTarget.dataset.index]
    if (!product) return
    const cart = wx.getStorageSync("cartItems") || []
    const index = cart.findIndex(item => item.id === product.id)
    if (index >= 0) {
      cart[index].quantity = Number(cart[index].quantity || 1) + 1
    } else {
      cart.push({
        id: product.id,
        name: product.name,
        price: product.price,
        imageUrl: product.imageUrl || product.mainImage || "",
        quantity: 1,
        productType: "normal"
      })
    }
    wx.setStorageSync("cartItems", cart)
    wx.showToast({ title: "已加入购物车", icon: "success" })
  },

  showContact() {
    const { phone, wechat, workWechatUrl } = this.data.contact || {}
    wx.showActionSheet({
      itemList: ["在线客服", "电话联系", "复制微信号"],
      success: res => {
        if (res.tapIndex === 0) {
          if (workWechatUrl && workWechatUrl.indexOf("/") === 0) wx.navigateTo({ url: workWechatUrl })
          else wx.showModal({ title: "在线客服", content: workWechatUrl || "暂未配置在线客服", showCancel: false })
        }
        if (res.tapIndex === 1) {
          if (phone) wx.makePhoneCall({ phoneNumber: phone })
          else wx.showToast({ title: "暂未设置电话", icon: "none" })
        }
        if (res.tapIndex === 2) {
          if (wechat) wx.setClipboardData({ data: wechat })
          else wx.showToast({ title: "暂未设置微信号", icon: "none" })
        }
      }
    })
  },

  backAll() {
    this.setData({ secondary: "全部" })
    this.applyFilters({ secondary: "全部" })
  },

  chooseImage() {
    const category = this.data.secondary === "全部" ? this.data.primary : this.data.secondary
    wx.navigateTo({
      url: `/pages/checkout/checkout?mode=custom&category=${encodeURIComponent(category || this.data.primary || "图片定制")}`
    })
  }
})
