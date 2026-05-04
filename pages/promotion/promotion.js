const { apiUrl, request } = require("../../utils/api")
const { applyTheme } = require("../../utils/theme")
const SHARE_TITLES = [
  "非常智造 · 朋友推荐给你",
  "高颜值定制礼物店 · 邀你来逛逛",
  "精选礼物小店 · 朋友觉得你会喜欢"
]

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
    if (phone) this.loadSummary(phone)
    else {
      const localCode = wx.getStorageSync("profileInviteCode") || wx.getStorageSync("localUserId") || "U0000"
      this.setData({
        profile: {
          ...this.data.profile,
          inviteCode: localCode,
          inviteQrUrl: apiUrl(`/api/promotion/qr?code=${encodeURIComponent(localCode)}`),
          inviteQrText: `非常智造 邀请码：${localCode}`
        }
      })
      this.refreshInviteLink()
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
    const title = "非常智造邀请海报"
    const image = this.data.profile.inviteQrUrl || apiUrl(`/api/promotion/qr?code=${encodeURIComponent(code)}`)
    wx.navigateTo({
      url: `/pages/poster/poster?title=${encodeURIComponent(title)}&image=${encodeURIComponent(image)}`
    })
  },

  loadStoreShareImage() {
    request("/api/home")
      .then(data => {
        const banner = (data.banners || []).find(item => item.imageUrl)
        const product = (data.products || []).find(item => item.imageUrl)
        this.setData({ storeShareImage: banner?.imageUrl || product?.imageUrl || "" })
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

  openProduct(event) {
    const id = event.currentTarget.dataset.id
    if (!id) return
    wx.navigateTo({ url: `/pages/product/detail?id=${id}` })
  },

  onShareAppMessage() {
    return {
      title: pickOne(SHARE_TITLES),
      path: this.buildInviteLink(),
      imageUrl: this.data.storeShareImage || ""
    }
  }
})
