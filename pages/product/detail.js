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
const SHARE_TITLES = ["朋友推荐给你", "值得送TA的礼物", "朋友觉得你会喜欢", "高颜值定制礼物"]

function pickOne(list) {
  return list[Math.floor(Math.random() * list.length)]
}

function normalizeProduct(product) {
  const categories = Array.isArray(product.categories) ? product.categories : []
  const galleryImages = Array.isArray(product.galleryImages) ? product.galleryImages.filter(Boolean) : []
  const detailImages = Array.isArray(product.detailImages) ? product.detailImages.filter(Boolean) : []
  const mediaImages = galleryImages.length ? galleryImages : (product.imageUrl ? [product.imageUrl] : [])
  return {
    ...product,
    categories,
    galleryImages,
    detailImages,
    mediaImages,
    recommendTip: pickOne(RECOMMEND_TIPS),
    categoryText: categories.join(" / "),
    badgeText: BADGE_TEXT[product.badge] || product.badge || ""
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
    loading: true
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
    this.ensureShareIdentity()
    this.loadNewcomerBenefits()
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
    if (!getLoginState().loggedIn) {
      this.setData({ loginVisible: true })
      return
    }
    this.openCheckout()
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
        title: error.visibleDebugMessage ? "登录调试信息" : "登录接口异常",
        content: error.visibleDebugMessage || error.message || "登录失败，请检查API域名和网络",
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

  buildSharePath() {
    const product = this.data.product || {}
    const id = product.id || ""
    const invite = this.getShareInvite()
    return `/pages/product/detail?id=${encodeURIComponent(id)}&invite=${encodeURIComponent(invite)}`
  },

  onShareAppMessage() {
    const product = this.data.product || {}
    const titleSuffix = pickOne(SHARE_TITLES)
    return {
      title: `${product.name || "非常智造"} · ${titleSuffix}`,
      path: this.buildSharePath(),
      imageUrl: product.imageUrl || product.mediaImages?.[0] || ""
    }
  }
})
