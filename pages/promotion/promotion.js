const { apiUrl, request } = require("../../utils/api")
const { applyTheme } = require("../../utils/theme")
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
    loading: false
  },

  onShow() {
    applyTheme(this)
    const phone = wx.getStorageSync("memberPhone") || ""
    this.setData({ phone })
    this.loadStoreShareImage()
    if (phone) {
      request("/api/store/me")
        .then(data => {
          if (data.bound) {
            wx.showToast({ title: "门店负责人请使用门店中心", icon: "none" })
            wx.redirectTo({ url: "/pages/store/center/center" })
            return
          }
          this.loadSummary(phone)
        })
        .catch(() => this.loadSummary(phone))
    }
    else {
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
      this.loadPosterCode(localCode)
    }
  },

  loadSummary(phone) {
    this.setData({ loading: true })
    request(`/api/promotion/summary?phone=${encodeURIComponent(phone)}`)
      .then(data => {
        this.setData({
          profile: data.profile || this.data.profile,
          invited: data.invited || [],
          rewards: data.rewards || []
        })
        if (data.profile?.inviteCode) wx.setStorageSync("profileInviteCode", data.profile.inviteCode)
        this.refreshInviteLink(data.profile)
        this.loadPosterCode(data.profile?.inviteCode)
      })
      .catch(() => wx.showToast({ title: "推广数据加载失败", icon: "none" }))
      .finally(() => this.setData({ loading: false }))
  },

  copyInviteCode() {
    const link = this.buildInviteLink()
    wx.setClipboardData({
      data: link,
      success: () => wx.showToast({ title: "邀请链接已复制", icon: "success" })
    })
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

  loadStoreShareImage() {
    request("/api/home")
      .then(data => {
        const shareAd = data.ads?.promotion_share_ad
        const adImage = shareAd && String(shareAd.enabled) !== "false" ? shareAd.imageUrl : ""
        const banner = (data.banners || []).find(item => item.imageUrl)
        const product = (data.products || []).find(item => item.imageUrl)
        this.setData({ storeShareImage: adImage || DEFAULT_SHARE_IMAGE || ONLINE_SHARE_IMAGE || banner?.imageUrl || product?.imageUrl || "" })
      })
      .catch(() => {})
    request("/api/products")
      .then(products => {
        const onlineProducts = (products || []).filter(item => item.status !== "off")
        const selected = onlineProducts.filter(item => String(item.promotionHot) === "true")
        const fallback = onlineProducts.filter(item => ["hot", "best"].includes(item.badge))
        const source = selected.length ? selected : (fallback.length ? fallback : onlineProducts)
        this.setData({ hotProducts: source.slice(0, 3) })
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
      title: pickOne(SHARE_TITLES),
      path: this.buildInviteLink(),
      imageUrl: this.data.storeShareImage || DEFAULT_SHARE_IMAGE || ONLINE_SHARE_IMAGE
    }
  }
})
