const { request } = require("../../utils/api")
const { ensureOpenid, getLoginState, loginWithPhoneDetail } = require("../../utils/auth")
const { applyTheme } = require("../../utils/theme")
const defaultData = require("../index/default-data")
const BADGE_TEXT = {
  new: "新品推荐",
  hot: "人气热卖",
  best: "爆品推荐",
  none: ""
}
const RECOMMEND_TIPS = ["朋友可能刚好需要", "分享好物给朋友", "送礼灵感推荐", "值得收藏的定制礼物"]

function normalizeProductTag(product = {}) {
  const tag = String(product.tag || product.badge || product.label || "").trim()
  if (!tag || ["none", "无", "无标签", "null", "undefined"].includes(tag)) return ""
  return BADGE_TEXT[tag] || tag
}

function pickOne(list) {
  return list[Math.floor(Math.random() * list.length)]
}

function hashNumber(seed) {
  return String(seed || "").split("").reduce((sum, char) => sum + char.charCodeAt(0), 0)
}

function normalizeProduct(product) {
  const categories = Array.isArray(product.categories) ? product.categories : []
  const galleryImages = Array.isArray(product.galleryImages) ? product.galleryImages.filter(Boolean) : []
  const detailImages = Array.isArray(product.detailImages) ? product.detailImages.filter(Boolean) : []
  const heroImage = product.optimizedUrl || product.webpUrl || product.imageUrl
  const mediaImages = galleryImages.length ? galleryImages : (heroImage ? [heroImage] : [])
  const seed = hashNumber(product.id || product.name)
  const soldCount = Number(product.soldCount || product.sales || product.saleCount || 0) || 120 + (seed % 420)
  const viewCount = Number(product.viewCount || product.views || 0) || soldCount * 4 + 360 + (seed % 680)
  return {
    ...product,
    categories,
    galleryImages,
    detailImages,
    mediaImages,
    displayImage: heroImage,
    cartImage: product.cartThumbUrl || product.thumbUrl || product.imageUrl,
    recommendTip: pickOne(RECOMMEND_TIPS),
    categoryText: categories.join(" / "),
    badgeText: normalizeProductTag(product),
    displayTag: normalizeProductTag(product),
    soldCount,
    viewCount,
    originalPrice: product.originalPrice || product.marketPrice || product.originPrice || "",
    isNormalProduct: String(product.productType || product.orderType || "").toLowerCase() === "normal" ||
      String(product.needCustom || "").toLowerCase() === "false" ||
      categories.some(item => ["日用好货", "潮玩手办", "食品饮料", "日用百货"].some(keyword => String(item).includes(keyword)))
  }
}

function cartItemFromProduct(product) {
  return {
    id: product.id,
    name: product.name,
    price: product.price,
    imageUrl: product.cartImage || product.displayImage || product.imageUrl || product.mainImage || product.mediaImages?.[0] || "",
    quantity: 1,
    productType: "normal"
  }
}

Page({
  data: {
    product: null,
    newcomerBenefits: [],
    source: "",
    loginVisible: false,
    loginLoading: false,
    themeStyle: "",
    themeClass: "theme-skin01",
    loading: true,
    cartCount: 0,
    shareStoreId: ""
  },

  onLoad(options) {
    applyTheme(this)
    const app = getApp()
    if (app.captureInvite) app.captureInvite({ query: options })
    this.setData({ source: options.source || "" })
    if (options.product) {
      const product = normalizeProduct(JSON.parse(decodeURIComponent(options.product)))
      this.setData({
        product,
        loading: false
      })
      this.rememberShareProduct(product)
      return
    }
    if (options.id) {
      this.loadProduct(options.id)
      return
    }
    this.setData({ loading: false })
  },

  onShow() {
    applyTheme(this)
    this.loadCartCount()
    this.ensureShareIdentity()
    this.loadShareStoreInfo()
    this.loadNewcomerBenefits()
  },

  loadCartCount() {
    const cart = wx.getStorageSync("cartItems") || []
    const cartCount = (Array.isArray(cart) ? cart : []).reduce((sum, item) => sum + Number(item.quantity || 1), 0)
    this.setData({ cartCount })
  },

  loadProduct(id) {
    request(`/api/products/${encodeURIComponent(id)}`)
      .then(product => {
        const normalized = normalizeProduct(product)
        this.setData({ product: normalized, loading: false })
        this.rememberShareProduct(normalized)
      })
      .catch(() => {
        request(`/api/product/detail?id=${encodeURIComponent(id)}`, { timeout: 8000 }).then(product => {
          if (!product || product.ok === false) throw new Error("商品不存在")
          const normalized = normalizeProduct(product)
          this.setData({ product: normalized, loading: false })
          this.rememberShareProduct(normalized)
        }).catch(() => {
          request("/api/products", { timeout: 8000 }).then(products => {
            const product = (Array.isArray(products) ? products : []).find(item => item.id === id)
            if (!product) throw new Error("商品不存在")
            const normalized = normalizeProduct(product)
            this.setData({ product: normalized, loading: false })
            this.rememberShareProduct(normalized)
          }).catch(() => {
            const product = (defaultData.products || []).find(item => item.id === id)
            if (product) {
              const normalized = normalizeProduct(product)
              this.setData({ product: normalized, loading: false })
              this.rememberShareProduct(normalized)
              return
            }
            wx.showToast({ title: "商品加载失败", icon: "none" })
            this.setData({ loading: false })
          })
        })
      })
  },

  goCheckout() {
    if (this.data.product && this.data.product.isNormalProduct) {
      this.buyNow()
      return
    }
    if (!getLoginState().loggedIn) {
      this.setData({ loginVisible: true })
      return
    }
    this.openCheckout()
  },

  addProductToCart(product) {
    if (!product) return 0
    const cart = wx.getStorageSync("cartItems") || []
    const index = cart.findIndex(item => item.id === product.id)
    if (index >= 0) {
      cart[index].quantity = Number(cart[index].quantity || 1) + 1
    } else {
      cart.push(cartItemFromProduct(product))
    }
    wx.setStorageSync("cartItems", cart)
    const cartCount = cart.reduce((sum, item) => sum + Number(item.quantity || 1), 0)
    this.setData({ cartCount })
    return cartCount
  },

  addToCart() {
    const product = this.data.product
    if (!product) return
    this.addProductToCart(product)
    wx.showToast({ title: "已加入购物车", icon: "success" })
  },

  buyNow() {
    const product = this.data.product
    if (!product) return
    if (!product.isNormalProduct) {
      this.goCheckout()
      return
    }
    this.addProductToCart(product)
    wx.navigateTo({ url: "/pages/cart/cart" })
  },

  openCart() {
    wx.navigateTo({ url: "/pages/cart/cart" })
  },

  openCheckout() {
    wx.navigateTo({
      url: `/pages/checkout/checkout?product=${encodeURIComponent(JSON.stringify(this.data.product))}&source=${encodeURIComponent(this.data.source || "")}&autoAddress=1`
    })
  },

  onCheckoutPhone(event) {
    this.setData({ loginLoading: true })
    loginWithPhoneDetail(event.detail || {}).then(() => {
      this.setData({ loginVisible: false })
      this.openCheckout()
    }).catch(error => {
      if (error.isAuthDenied) {
        wx.showToast({ title: "未授权手机号", icon: "none" })
        return
      }
      wx.showModal({
        title: "登录失败",
        content: error.message || "登录失败，请稍后重试",
        showCancel: false
      })
    }).finally(() => {
      this.setData({ loginLoading: false })
    })
  },

  closeLoginPrompt() {
    this.setData({ loginVisible: false })
  },

  rememberShareProduct(product) {
    if (!product || !product.id) return
    wx.setStorageSync("lastShareProduct", {
      id: product.id,
      name: product.name,
      imageUrl: product.imageUrl || product.mediaImages?.[0] || "",
      firstReward: product.firstReward || "0"
    })
  },

  ensureShareIdentity() {
    const phone = wx.getStorageSync("memberPhone")
    if (!phone || wx.getStorageSync("profileInviteCode")) return
    request(`/api/promotion/summary?phone=${encodeURIComponent(phone)}`)
      .then(data => {
        const code = data.profile && data.profile.inviteCode
        if (code) wx.setStorageSync("profileInviteCode", code)
      })
      .catch(() => {})
  },

  loadShareStoreInfo() {
    if (!getLoginState().loggedIn) {
      this.setData({ shareStoreId: "" })
      return
    }
    request("/api/store/me", { timeout: 5000 })
      .then(data => {
        const storeInfo = data && data.bound && data.storeInfo ? data.storeInfo : null
        const storeId = storeInfo && (storeInfo.id || storeInfo.storeId)
        if (storeId) {
          wx.setStorageSync("storeInfo", storeInfo)
          this.setData({ shareStoreId: storeId })
          return
        }
        this.setData({ shareStoreId: "" })
      })
      .catch(() => {
        this.setData({ shareStoreId: "" })
      })
  },

  loadNewcomerBenefits() {
    ensureOpenid().then(openid => {
      const phone = wx.getStorageSync("memberPhone") || ""
      return request(`/api/newcomer/benefits?phone=${encodeURIComponent(phone)}&openid=${encodeURIComponent(openid || "")}`)
    }).then(data => {
      const benefits = data.eligible ? (data.benefits || []).slice(0, 3) : []
      wx.setStorageSync("newcomerBenefitText", benefits.map(item => item.text).join("、"))
      this.setData({ newcomerBenefits: benefits })
    }).catch(() => {
      this.setData({ newcomerBenefits: [] })
    })
  },

  getShareInvite() {
    return wx.getStorageSync("profileInviteCode") || wx.getStorageSync("localUserId") || "U0000"
  },

  getShareStoreId() {
    if (this.data.shareStoreId) return this.data.shareStoreId
    const storeInfo = wx.getStorageSync("storeInfo") || {}
    return storeInfo.id || storeInfo.storeId || wx.getStorageSync("managerStoreId") || ""
  },

  buildSharePath() {
    const product = this.data.product || {}
    const id = product.id || ""
    const storeId = this.getShareStoreId()
    if (storeId) return `/pages/product/detail?id=${encodeURIComponent(id)}&store_id=${encodeURIComponent(storeId)}`
    const invite = this.getShareInvite()
    return `/pages/product/detail?id=${encodeURIComponent(id)}&invite=${encodeURIComponent(invite)}`
  },

  onShareAppMessage() {
    const product = this.data.product || {}
    return {
      title: "非常智造｜发现一个不错的定制礼物",
      path: this.buildSharePath(),
      imageUrl: product.displayImage || product.imageUrl || product.mediaImages?.[0] || ""
    }
  }
})
