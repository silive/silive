const { request } = require("../../utils/api")
const { applyTheme } = require("../../utils/theme")
const { copyText } = require("../../utils/privacy")
const defaultData = require("../index/default-data")

const BADGE_TEXT = {
  new: "新品推荐",
  hot: "人气热卖",
  best: "爆品推荐",
  none: ""
}
const CATEGORY_VERSION_KEY = "categoryCatalogVersion"

function normalizeProductTag(product = {}) {
  const tag = String(product.tag || product.badge || product.label || "").trim()
  if (!tag || ["none", "无", "无标签", "null", "undefined"].includes(tag)) return ""
  return BADGE_TEXT[tag] || tag
}

function isNormalProduct(product = {}) {
  const categories = Array.isArray(product.categories) ? product.categories : []
  const type = String(product.productType || product.product_type || product.orderType || "").toLowerCase()
  const needCustom = String(product.needCustom || "").toLowerCase()
  return type === "normal" ||
    needCustom === "false" ||
    categories.some(item => ["日用好货", "潮玩手办", "食品饮料", "日用百货"].some(keyword => String(item).includes(keyword)))
}

function normalize(product) {
  return {
    ...product,
    displayImage: product.listImage || product.thumbUrl || product.optimizedUrl || product.imageUrl,
    cartImage: product.cartThumbUrl || product.thumbUrl || product.imageUrl,
    categories: Array.isArray(product.categories) ? product.categories : [],
    badgeText: normalizeProductTag(product),
    displayTag: normalizeProductTag(product),
    isNormalProduct: isNormalProduct(product)
  }
}

function cartItemFromProduct(product) {
  return {
    id: product.id,
    name: product.name,
    price: product.price,
    imageUrl: product.cartImage || product.displayImage || product.imageUrl || product.mainImage || "",
    quantity: 1,
    productType: "normal"
  }
}

function matchesCategory(product, category) {
  if (Array.isArray(product.categories) && product.categories.includes(category)) return true
  const text = `${product.name || ""} ${product.intro || ""}`
  const rules = {
    "激光定制": ["激光", "雕刻", "刻字", "吊牌", "首饰", "文具", "手机配件", "LOGO", "叶雕"],
    "3D打印": ["3D", "模型", "建模", "打印", "配件"],
    "潮玩手办": ["手办", "摆件", "解压", "钥匙", "书签", "车载", "生日"],
    "日用好货": ["零食", "饮料", "纸品", "日化", "清洁", "个护", "厨房", "宿舍", "特价"]
  }
  return (rules[category] || []).some(keyword => text.includes(keyword))
}

const FALLBACK_SECONDARY = {
  "激光定制": ["照片雕刻", "刻字礼品", "首饰吊牌", "文具刻字", "手机配件", "自带物品加工", "企业LOGO"],
  "3D打印": ["模型定制", "来图定制", "尺寸定制", "颜色定制", "批量打印", "企业定制", "配件打印"],
  "潮玩手办": ["现货手办", "桌面摆件", "解压玩具", "钥匙挂件", "书签文创", "车载摆件", "生日礼物", "新品上架"],
  "日用好货": ["零食饮料", "家庭纸品", "日化清洁", "个护用品", "厨房用品", "宿舍好物", "特价专区"]
}

function normalizeCategoryCatalog(value) {
  return (Array.isArray(value) ? value : [])
    .map((item, index) => ({
      name: item.name || "",
      sort: Number(item.sort || index + 1),
      enabled: String(item.enabled == null && item.visible == null ? "true" : item.enabled || item.visible),
      children: (Array.isArray(item.children) ? item.children : [])
        .map((child, childIndex) => ({
          name: typeof child === "string" ? child : child.name || "",
          sort: Number((typeof child === "string" ? childIndex + 1 : child.sort) || childIndex + 1),
          enabled: typeof child === "string" ? "true" : String(child.enabled == null ? "true" : child.enabled),
          comingSoon: typeof child === "string" ? "false" : String(child.comingSoon == null ? "false" : child.comingSoon)
        }))
        .filter(child => child.name)
        .filter(child => String(child.enabled) !== "false")
        .sort((a, b) => a.sort - b.sort)
    }))
    .filter(item => item.name)
    .filter(item => String(item.enabled) !== "false")
    .sort((a, b) => a.sort - b.sort)
}

function catalogVersion(catalog) {
  return JSON.stringify(catalog.map(item => ({
    name: item.name,
    sort: item.sort,
    enabled: item.enabled,
    children: item.children.map(child => `${child.name}:${child.sort}:${child.enabled}:${child.comingSoon}`)
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
  return ["全部", ...Array.from(new Set([...fromCatalog, ...(fromCatalog.length ? [] : (FALLBACK_SECONDARY[primary] || []))]))]
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
    loading: true,
    loaded: false,
    showCartEntry: false,
    cartCount: 0
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
    this.loadCartCount()
  },

  loadCartCount() {
    const cart = wx.getStorageSync("cartItems") || []
    const cartCount = (Array.isArray(cart) ? cart : []).reduce((sum, item) => sum + Number(item.quantity || 1), 0)
    this.setData({ cartCount })
  },

  shouldShowCartEntry(products, primary) {
    const normalCategory = ["日用好货", "潮玩手办", "食品饮料", "日用百货"].some(keyword => String(primary || "").includes(keyword))
    return normalCategory || (products || []).some(product => product.isNormalProduct && matchZone(product, primary, "全部"))
  },

  loadProducts(primary, secondary = "全部", ids = "") {
    this.setData({ loading: true, loaded: false })
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
        showCartEntry: this.shouldShowCartEntry(allProducts, primary),
        loading: false,
        loaded: true
      })
      this.loadCartCount()
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
          showCartEntry: this.shouldShowCartEntry(allProducts, primary),
          loading: false,
          loaded: true
        })
        this.loadCartCount()
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
          showCartEntry: this.shouldShowCartEntry(allProducts, primary),
          loading: false,
          loaded: true
        })
        this.loadCartCount()
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
    if (!product) return
    this.addProductToCart(product)
    wx.navigateTo({ url: "/pages/cart/cart" })
  },

  addProductToCart(product) {
    if (!product) return
    const cart = wx.getStorageSync("cartItems") || []
    const index = cart.findIndex(item => item.id === product.id)
    if (index >= 0) {
      cart[index].quantity = Number(cart[index].quantity || 1) + 1
    } else {
      cart.push(cartItemFromProduct(product))
    }
    wx.setStorageSync("cartItems", cart)
    this.loadCartCount()
  },

  addToCart(event) {
    const product = this.data.products[event.currentTarget.dataset.index]
    if (!product) return
    this.addProductToCart(product)
    wx.showToast({ title: "已加入购物车", icon: "success" })
  },

  goCart() {
    wx.navigateTo({ url: "/pages/cart/cart" })
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
          if (wechat) copyText(wechat)
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
