const { apiUrl, request } = require("../../utils/api")
const { loginWithPhoneDetail } = require("../../utils/auth")
const { applyTheme } = require("../../utils/theme")
const { isPromotionEnabled, isReviewMode } = require("../../utils/review")
const { saveImage } = require("../../utils/privacy")
const SHARE_TITLES = [
  "非常智造 · 朋友推荐给你",
  "高颜值定制礼物店 · 邀你来逛逛",
  "精选礼物小店 · 朋友觉得你会喜欢"
]
const DEFAULT_SHARE_IMAGE = "/assets/share-promotion.png"
const ONLINE_SHARE_IMAGE = "https://api.feichangjiandan.xyz/uploads/share-promotion.png"

function pickOne(list) {
  return list[Math.floor(Math.random() * list.length)]
}

function productListImage(product = {}) {
  return product.cartThumbUrl || product.cart_thumb_url || product.thumbUrl || product.thumb_url || product.listImage || product.list_image || product.optimizedUrl || product.optimized_url || product.imageUrl || product.image_url || ""
}

Page({
  data: {
    phone: "",
    profile: {
      inviteCode: "",
      shoppingMoney: "0.00",
      pendingReward: "0.00",
      inviteCount: 0,
      inviteOrderCount: 0,
      inviteQrUrl: "",
      inviteQrText: ""
    },
    invited: [],
    rewards: [],
    inviteLink: "",
    storeShareImage: "",
    hotProducts: [],
    themeStyle: "",
    themeClass: "theme-skin01",
    loading: false,
    loginVisible: false,
    loginLoading: false,
    reviewMode: isReviewMode(),
    promotionEnabled: isPromotionEnabled(),
    showInviteTools: isPromotionEnabled()
  },

  onShow() {
    applyTheme(this)
    const phone = wx.getStorageSync("memberPhone") || ""
    this.setData({ phone })
    this.loadStoreShareImage()
    if (!this.data.promotionEnabled) {
      wx.showToast({ title: "该功能暂未开放", icon: "none" })
      wx.navigateBack({ fail: () => wx.switchTab({ url: "/pages/profile/profile" }) })
      return
    }
    if (phone) {
      this.loadSummary(phone)
    } else {
      const localCode = wx.getStorageSync("profileInviteCode") || wx.getStorageSync("localUserId") || "U0000"
      this.setData({
        profile: {
          ...this.data.profile,
          inviteCode: localCode,
          inviteQrUrl: "",
          inviteQrText: `非常智造 邀请码：${localCode}`
        }
      })
      this.refreshInviteLink()
      this.setData({ loginVisible: true })
    }
  },

  closeLoginSheet() {
    this.setData({ loginVisible: false })
  },

  onLoginPhone(event) {
    this.setData({ loginLoading: true })
    loginWithPhoneDetail(event.detail || {}).then(() => {
      this.setData({ loginVisible: false })
      wx.showToast({ title: "登录成功", icon: "success" })
      const phone = wx.getStorageSync("memberPhone") || ""
      this.setData({ phone })
      if (phone) this.loadSummary(phone)
    }).catch(error => {
      if (error.isAuthDenied) {
        wx.showToast({ title: "未授权手机号", icon: "none" })
        return
      }
      wx.showModal({ title: "登录失败", content: error.message || "登录失败，请稍后重试", showCancel: false })
    }).finally(() => this.setData({ loginLoading: false }))
  },

  loadSummary(phone) {
    this.setData({ loading: true })
    request("/api/promotion/summary")
      .then(data => {
        this.setData({
          profile: data.profile || this.data.profile,
          invited: data.invited || [],
          rewards: (data.rewards || []).map(item => ({
            ...item,
            amountText: `${Number(item.amount || 0) < 0 ? "-" : "+"}¥${Math.abs(Number(item.amount || 0)).toFixed(2)}`
          }))
        })
        if (data.profile?.inviteCode) wx.setStorageSync("profileInviteCode", data.profile.inviteCode)
        this.refreshInviteLink(data.profile)
        this.loadPosterCode(data.profile?.inviteCode)
      })
      .catch(() => wx.showToast({ title: "推广数据加载失败", icon: "none" }))
      .finally(() => this.setData({ loading: false }))
  },

  buildInviteCode(profile = this.data.profile) {
    return profile.inviteCode || wx.getStorageSync("profileInviteCode") || wx.getStorageSync("localUserId") || "U0000"
  },

  buildInviteLink(profile = this.data.profile) {
    const code = this.buildInviteCode(profile)
    return `/pages/index/index?invite=${encodeURIComponent(code)}`
  },

  refreshInviteLink(profile = this.data.profile) {
    this.setData({ inviteLink: this.buildInviteLink(profile) })
  },

  createPoster() {
    const code = this.buildInviteCode()
    this.ensurePosterCode(code).then(image => {
      const title = "非常智造邀请海报"
      const shareImage = this.data.storeShareImage || DEFAULT_SHARE_IMAGE || ONLINE_SHARE_IMAGE
      wx.navigateTo({
        url: `/pages/poster/poster?title=${encodeURIComponent(title)}&image=${encodeURIComponent(image)}&code=${encodeURIComponent(code)}&path=${encodeURIComponent(this.buildInviteLink())}&shareImage=${encodeURIComponent(shareImage)}`
      })
    }).catch(error => {
      wx.showModal({ title: "小程序码生成失败", content: error.message || "请稍后重试", showCancel: false })
    })
  },

  saveInviteQr() {
    const url = this.data.profile.inviteQrUrl
    if (!url) {
      wx.showToast({ title: "二维码生成中，请稍后", icon: "none" })
      return
    }
    wx.downloadFile({
      url,
      success: res => {
        if (res.statusCode !== 200 || !res.tempFilePath) {
          wx.showToast({ title: "二维码下载失败", icon: "none" })
          return
        }
        saveImage(res.tempFilePath, {
          filePath: res.tempFilePath,
          success: () => wx.showToast({ title: "已保存到相册", icon: "success" }),
          fail: error => {
            const msg = String(error.errMsg || "")
            wx.showModal({
              title: "保存失败",
              content: msg.includes("auth") || msg.includes("deny") ? "可手动截图保存，或在设置中开启相册权限" : "保存到相册失败，请稍后重试",
              showCancel: false
            })
          }
        })
      },
      fail: () => wx.showToast({ title: "二维码下载失败", icon: "none" })
    })
  },

  loadStoreShareImage() {
    request("/api/home")
      .then(data => {
        const shareAd = data.ads?.promotion_share_ad
        const adImage = shareAd && String(shareAd.enabled) !== "false" ? shareAd.imageUrl : ""
        const banner = (data.banners || []).find(item => item.imageUrl)
        const product = (data.products || []).find(item => item.imageUrl)
        this.setData({ storeShareImage: adImage || DEFAULT_SHARE_IMAGE || banner?.imageUrl || product?.imageUrl || ONLINE_SHARE_IMAGE || "" })
      })
      .catch(() => {})
    request("/api/products")
      .then(products => {
        const onlineProducts = (products || []).filter(item => item.status !== "off")
        const selected = onlineProducts.filter(item => String(item.promotionHot) === "true")
        const fallback = onlineProducts.filter(item => ["hot", "best"].includes(item.badge))
        const source = selected.length ? selected : (fallback.length ? fallback : onlineProducts)
        this.setData({ hotProducts: source.slice(0, 3).map(item => ({ ...item, displayImage: productListImage(item) })) })
        console.log("[promotion-hot-image]", {
          firstProduct: source[0]?.name || "",
          field: source[0] ? (source[0].cartThumbUrl ? "cartThumbUrl" : source[0].thumbUrl ? "thumbUrl" : source[0].listImage ? "listImage" : source[0].optimizedUrl ? "optimizedUrl" : "imageUrl") : "",
          hasImage: !!productListImage(source[0] || {})
        })
      })
      .catch(() => {})
  },

  loadPosterCode(code = this.buildInviteCode()) {
    if (!code) return Promise.resolve("")
    return request(`/api/promotion/poster-code?invite=${encodeURIComponent(code)}`)
      .then(data => {
        const url = data.url || data.data?.url || ""
        if (url) {
          this.setData({ profile: { ...this.data.profile, inviteQrUrl: url } })
        }
        return url
      })
      .catch(error => {
        console.warn("[promotion] poster code failed", { message: error.message })
        return ""
      })
  },

  ensurePosterCode(code = this.buildInviteCode()) {
    if (this.data.profile.inviteQrUrl) return Promise.resolve(this.data.profile.inviteQrUrl)
    return this.loadPosterCode(code).then(url => {
      if (!url) throw new Error("暂时无法生成真实小程序码")
      return url
    })
  },

  openProduct(event) {
    const id = event.currentTarget.dataset.id
    if (!id) return
    wx.navigateTo({ url: `/pages/product/detail?id=${id}` })
  },

  onShareAppMessage() {
    return {
      title: "非常智造 · 好物推荐",
      path: this.buildInviteLink(),
      imageUrl: this.data.storeShareImage || DEFAULT_SHARE_IMAGE || ONLINE_SHARE_IMAGE
    }
  }
})
